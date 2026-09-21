/**
 * Normaliza valores con forma de Firestore en los documentos migrados.
 *
 * POR QUE EXISTE
 * Al importar de Firestore, campos que el modelo declara BOOLEANOS quedaron con objetos
 * adentro (Timestamp y centinelas de Firestore). Leerlos no rompe, pero CUALQUIER validacion
 * que los reciba los rechaza:
 *
 *   Valor invalido para el campo "arqueado": [object Object]
 *   Valor invalido para el campo "noAfectaCaja": [object Object]
 *
 * Ese 400 es el que impide el cierre forzado y la reconciliacion de los turnos importados
 * (falla solo en esos turnos: los nuevos ya se guardan bien), y puede aparecer en cualquier
 * otro endpoint que valide documentos.
 *
 * QUE HACE
 * Recorre TODOS los modelos y, dentro de cada uno, TODOS los campos booleanos. Donde el
 * valor guardado no sea booleano, lo reemplaza por su equivalente logico: un Timestamp viejo
 * significa "si" (el ticket estaba arqueado), y null/undefined significa "no".
 *
 * Por que derivado del modelo y no una lista a mano: una lista cubre los campos que hoy
 * conocemos y deja el resto esperando a romper. Los paths con `instance === 'Boolean'` son
 * exactamente los que van a fallar, hoy y manana.
 *
 * Nada se borra. Corre en simulacion por defecto.
 *
 * COMO SE CORRE
 *   npx tsx server/scripts/normalizar-migrados.ts             (simulacion: no escribe)
 *   npx tsx server/scripts/normalizar-migrados.ts --aplicar   (escribe)
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
/* ESTE IMPORT NO ES DECORATIVO: `mongoose.modelNames()` solo devuelve los modelos que ya
   estan REGISTRADOS, y registrarlos es lo que hace el indice de modelos. Sin esta linea el
   bucle no recorre NADA: el script informa "campos revisados: 0" y parece que la base esta
   limpia, cuando en realidad no miro ni un campo. Es peor que un error, porque tranquiliza. */
import '../src/models/index.js';

/**
 * Normaliza valores con forma de Firestore en los documentos migrados.
 *
 * Se puede usar de DOS formas:
 *   1. Como script (CLI):   npx tsx scripts/normalizar-migrados.ts [--aplicar]
 *   2. Importada desde la API (POST /admin/normalizar-migrados), que es como se corre en
 *      produccion cuando no hay acceso a una terminal del servidor.
 *
 * Por eso `conectar`: cuando la llama la API, la conexion a Mongo YA existe y no hay que
 * abrir ni cerrar nada.
 */
export interface NormalizarResultado {
  camposRevisados: number;
  documentosAfectados: number;
  aplicar: boolean;
}

export const normalizarMigrados = async (
  opciones: { aplicar?: boolean; conectar?: boolean } = {},
): Promise<NormalizarResultado> => {
  const aplicar = opciones.aplicar === true;
  const conectar = opciones.conectar !== false;

  if (conectar) await connectDatabase();
  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin conexion a Mongo');

  console.log(
    aplicar
      ? '[normalizar] APLICANDO cambios'
      : '[normalizar] SIMULACION (agregar --aplicar para escribir)',
  );

  let camposRevisados = 0;
  let documentosAfectados = 0;

  for (const nombreModelo of mongoose.modelNames()) {
    const coleccion = mongoose.model(nombreModelo).collection.name;
    const schema = mongoose.model(nombreModelo).schema;

    for (const [ruta, tipo] of Object.entries(schema.paths)) {
      /* Los paths anidados quedarian como "sub.campo"; Mongo no consulta paths anidados con
         $type de forma confiable, asi que se saltean y se informan aparte. */
      if (ruta.includes('.')) continue;
      camposRevisados += 1;

      /* ---------- Fechas ----------
         Es el caso que rompia el sistema en produccion: los documentos migrados guardan
         `fecha` como string ISO o como objeto de Firestore ({_seconds,_nanoseconds}), y eso
         hace fallar DOS cosas distintas:
           - el filtro de rango del endpoint: Mongoose no puede castear y devuelve 400
             "Valor invalido para el campo fecha: [object Object]"
           - la agregacion del resumen: $dateToString exige un Date y devuelve 500
         Se convierten a Date real, que es lo que el modelo declara. */
      if (tipo.instance === 'Date') {
        const comoObjeto = { [ruta]: { $type: 'object' } };
        const comoTexto = { [ruta]: { $type: 'string' } };
        const objetos = await db.collection(coleccion).countDocuments(comoObjeto);
        const textos = await db.collection(coleccion).countDocuments(comoTexto);
        if (objetos + textos === 0) continue;

        documentosAfectados += objetos + textos;
        console.log(
          `  ${coleccion}.${ruta}: ${objetos} con objeto y ${textos} con texto (fecha, no Date)`,
        );
        if (!aplicar) continue;

        if (textos > 0) {
          /* ANTES DE CONVERTIR: cuantas quedarian en null.
             $convert con onError devuelve null para lo que no puede interpretar, y null en una
             fecha BORRA el dato. Una fecha con formato de pantalla ("11/09/2026, 06:17") cae
             justo en ese caso. Si hay alguna, NO se toca esa ruta: primero hay que ver que
             formato tiene. Es la diferencia entre normalizar y perder datos. */
          const [control] = await db
            .collection(coleccion)
            .aggregate([
              { $match: comoTexto },
              { $project: { ok: { $convert: { input: `$${ruta}`, to: 'date', onError: null, onNull: null } } } },
              { $match: { ok: null } },
              { $count: 'n' },
            ])
            .toArray();
          const ilegibles = Number((control as { n?: number } | undefined)?.n ?? 0);
          if (ilegibles > 0) {
            console.error(
              `  !! ${coleccion}.${ruta}: ${ilegibles} con formato que NO se puede interpretar como fecha. NO se toca: convertirlas las borraria.`,
            );
            continue;
          }
          await db.collection(coleccion).updateMany(comoTexto, [
            { $set: { [ruta]: { $convert: { input: `$${ruta}`, to: 'date', onError: null, onNull: null } } } },
          ]);
        }
        if (objetos > 0) {
          /* Un Timestamp de Firestore guarda SEGUNDOS; $convert a date los toma como
             milisegundos, asi que hay que multiplicar por 1000 o las fechas caen en 1970. */
          await db.collection(coleccion).updateMany(comoObjeto, [
            {
              $set: {
                [ruta]: {
                  $convert: {
                    input: {
                      $multiply: [
                        { $ifNull: [`$${ruta}._seconds`, { $ifNull: [`$${ruta}.seconds`, null] }] },
                        1000,
                      ],
                    },
                    to: 'date',
                    onError: null,
                    onNull: null,
                  },
                },
              },
            },
          ]);
        }
        continue;
      }

      if (tipo.instance !== 'Boolean') continue;

      const filtro = { [ruta]: { $type: 'object' } };
      const afectados = await db.collection(coleccion).countDocuments(filtro);
      if (afectados === 0) continue;

      documentosAfectados += afectados;
      console.log(`  ${coleccion}.${ruta}: ${afectados} documento(s) con un objeto adentro`);

      if (!aplicar) continue;

      /* Pipeline de update: se puede expresar el valor nuevo sin traer cada documento. */
      await db
        .collection(coleccion)
        .updateMany(filtro, [{ $set: { [ruta]: true } }]);
    }
  }

  /* Un cero aca NO es "la base esta limpia": es "no mire nada". Paso exactamente eso cuando
     faltaba el import de los modelos, y el resultado tranquilizaba en vez de avisar. Se corta
     con error para que nadie confunda el silencio con un resultado. */
  if (camposRevisados === 0) {
    throw new Error(
      'No se reviso ningun campo: los modelos no estan registrados (falta importar ../src/models/index.js) o el esquema no tiene paths de tipo Boolean ni Date.',
    );
  }

  console.log(
    `\n[normalizar] campos revisados: ${camposRevisados}` +
      `\n[normalizar] documentos a corregir: ${documentosAfectados}` +
      (aplicar ? ' (corregidos)' : ' (simulacion: no se toco nada)'),
  );

  /* El valor real de cada objeto se informa aparte: si algun dia aparece un objeto que
     significa "no" (un Timestamp en cero, por ejemplo), esto lo deja ver antes de aplicar. */
  if (!aplicar && documentosAfectados > 0) {
    console.log(
      '\n[normalizar] Revisar antes de aplicar: las fechas con objeto se toman como segundos y los booleanos con objeto como "si".',
    );
  }

  if (conectar) await disconnectDatabase();

  return { camposRevisados, documentosAfectados, aplicar };
};

/* CLI: solo cuando el archivo se ejecuta como script. Si lo importa la API, argv[1] apunta al
   arranque del servidor y esto no corre. */
const esCli = String(process.argv[1] ?? '').includes('normalizar-migrados');

if (esCli) {
  void normalizarMigrados({ aplicar: process.argv.includes('--aplicar') }).catch((error: unknown) => {
    console.error('[normalizar] fallo', error);
    process.exit(1);
  });
}
