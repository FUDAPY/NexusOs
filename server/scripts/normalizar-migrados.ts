
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';

import '../src/models/index.js';


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
      
      if (ruta.includes('.')) continue;
      camposRevisados += 1;

      
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

      
      await db
        .collection(coleccion)
        .updateMany(filtro, [{ $set: { [ruta]: true } }]);
    }
  }

  
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

  
  if (!aplicar && documentosAfectados > 0) {
    console.log(
      '\n[normalizar] Revisar antes de aplicar: las fechas con objeto se toman como segundos y los booleanos con objeto como "si".',
    );
  }

  if (conectar) await disconnectDatabase();

  return { camposRevisados, documentosAfectados, aplicar };
};


const esCli = String(process.argv[1] ?? '').includes('normalizar-migrados');

if (esCli) {
  void normalizarMigrados({ aplicar: process.argv.includes('--aplicar') }).catch((error: unknown) => {
    console.error('[normalizar] fallo', error);
    process.exit(1);
  });
}
