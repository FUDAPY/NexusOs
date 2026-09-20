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

/** Un objeto guardado (Timestamp de Firestore) equivale a "si". */
const aBooleano = (valor: unknown): boolean => Boolean(valor);

const main = async (): Promise<void> => {
  const aplicar = process.argv.includes('--aplicar');

  await connectDatabase();
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

  console.log(
    `\n[normalizar] campos booleanos revisados: ${camposRevisados}` +
      `\n[normalizar] documentos a corregir: ${documentosAfectados}` +
      (aplicar ? ' (corregidos)' : ' (simulacion: no se toco nada)'),
  );

  /* El valor real de cada objeto se informa aparte: si algun dia aparece un objeto que
     significa "no" (un Timestamp en cero, por ejemplo), esto lo deja ver antes de aplicar. */
  if (!aplicar && documentosAfectados > 0) {
    console.log('\n[normalizar] Revisar: los objetos encontrados se interpretan como "si".');
  }

  await disconnectDatabase();
};

void main().catch((error: unknown) => {
  console.error('[normalizar] fallo', error);
  process.exit(1);
});
