/**
 * Convierte el MongoDB standalone en replica set de 1 nodo (habilita transacciones ACID).
 *
 * Requisito previo: el contenedor debe haberse reiniciado con el flag --replSet.
 * En Dokploy: Databases -> <mongo> -> Advanced -> Run Command
 *   mongod --replSet rs0 --auth --bind_ip_all
 * y luego Redeploy. Este script NO puede agregar el flag: solo inicializa el conjunto.
 *
 * Uso:
 *   npm run mongo:replica:status     # solo diagnostico
 *   npm run mongo:replica:init       # envia replSetInitiate si hace falta
 *
 * Variables opcionales:
 *   REPLICA_SET_NAME (rs0)   REPLICA_HOST (host interno que usara la app)
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

const REPLICA_SET_NAME = process.env['REPLICA_SET_NAME'] ?? 'rs0';
const STATUS_ONLY = process.argv.includes('--status-only');

/** Permite apuntar a otro nodo (ej. el servicio nuevo) sin editar el .env. */
const targetUri = process.env['MONGO_TARGET'] ?? env.MONGO_URI;

/**
 * Host que la app (dentro de la red de Dokploy) usara para llegar al nodo.
 * Es OBLIGATORIO: correr este script desde fuera derivaria la IP externa,
 * que los contenedores no pueden usar para descubrir el replica set.
 */
const replicaHost = process.env['REPLICA_HOST'] ?? deriveReplicaHost();

function deriveReplicaHost(): string {
  const match = /@([^/?]+)/.exec(targetUri);
  return match?.[1] ?? 'localhost:27017';
}

interface CmdLineOpts {
  argv?: string[];
  parsed?: Record<string, unknown>;
}

interface HelloInfo {
  setName?: string;
  isWritablePrimary?: boolean;
  secondary?: boolean;
  hosts?: string[];
  me?: string;
}

const readHello = async (): Promise<HelloInfo> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin handle de base de datos');
  return (await db.admin().command({ hello: 1 })) as HelloInfo;
};

/** Argumentos reales con los que arranco mongod: delata si falta --replSet. */
const readCmdLine = async (): Promise<CmdLineOpts> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin handle de base de datos');
  return (await db.admin().command({ getCmdLineOpts: 1 })) as CmdLineOpts;
};

const readReplStatus = async (): Promise<string> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin handle de base de datos');
  try {
    const status = (await db.admin().command({ replSetGetStatus: 1 })) as {
      myState?: number;
      members?: { name: string; stateStr: string }[];
    };
    const members = (status.members ?? []).map((m) => `${m.name}=${m.stateStr}`).join(', ');
    return `ok myState=${String(status.myState)} members=[${members}]`;
  } catch (error) {
    return `ERROR: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  }
};

const main = async (): Promise<void> => {
  await mongoose.connect(targetUri, { serverSelectionTimeoutMS: 20_000 });

  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin handle de base de datos');

  const build = (await db.admin().command({ buildInfo: 1 })) as { version: string };
  const before = await readHello();
  const cmdLine = await readCmdLine();
  const replStatus = await readReplStatus();

  logger.info(
    {
      mongoVersion: build.version,
      mongodArgv: cmdLine.argv ?? null,
      replicaSetName: before.setName ?? null,
      writablePrimary: before.isWritablePrimary ?? null,
      hosts: before.hosts ?? null,
      replSetStatus: replStatus,
      replicaHost,
    },
    'Estado actual del nodo',
  );

  // Inventario del contenido: util para saber si el volumen ya tiene la migracion.
  const handle = mongoose.connection.getClient().db(env.MONGO_DB_NAME);
  const collections = await handle.listCollections().toArray();
  let documentos = 0;
  for (const collection of collections) {
    documentos += await handle.collection(collection.name).countDocuments();
  }
  logger.info(
    {
      db: env.MONGO_DB_NAME,
      colecciones: collections.length,
      documentos,
      orders: await handle.collection('orders').countDocuments(),
    },
    'Inventario de la base destino',
  );

  if (before.setName === REPLICA_SET_NAME) {
    logger.info({ replicaSetName: REPLICA_SET_NAME }, 'Ya es miembro del replica set: nada que hacer');
  } else if (before.setName !== undefined) {
    logger.warn(
      { actual: before.setName, esperado: REPLICA_SET_NAME },
      'El nodo pertenece a otro replica set: revisar configuracion',
    );
  } else if (STATUS_ONLY) {
    const tieneFlag = (cmdLine.argv ?? []).some((arg) => arg.startsWith('--replSet'));
    logger.warn(
      {
        mongodArgv: cmdLine.argv ?? null,
        flagReplSetPresente: tieneFlag,
      },
      tieneFlag
        ? `El flag --replSet ya esta en el arranque pero el conjunto no esta inicializado: corre este script sin --status-only.`
        : `Falta --replSet en el arranque de mongod. Revisa el command del contenedor en Dokploy y volve a correr el diagnostico.`,
    );
  } else if (process.env['REPLICA_HOST'] === undefined) {
    // Evita guardar la IP externa como host del nodo: rompe el descubrimiento interno.
    throw new Error(
      'Falta REPLICA_HOST. Definí el nombre INTERNO del servicio Mongo (ej. pos-erppos-3yohnd:27017), ' +
        `no la IP externa. Valor derivado actual: "${replicaHost}".`,
    );
  } else {
    // Unico camino posible: mongod debe haber arrancado con --replSet.
    const config = {
      _id: REPLICA_SET_NAME,
      members: [{ _id: 0, host: replicaHost, priority: 1 }],
    };

    logger.info({ config }, 'Enviando replSetInitiate');
    const result = (await db.admin().command({ replSetInitiate: config })) as { ok?: number };

    if (result.ok !== 1) {
      throw new Error('replSetInitiate no devolvio ok:1');
    }
  }

  // Espera a que el nodo se promueva a PRIMARY (single-node: inmediato).
  if (!STATUS_ONLY) {
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      const hello = await readHello();
      if (hello.isWritablePrimary === true) {
        logger.info(
          { replicaSetName: hello.setName, me: hello.me, hosts: hello.hosts },
          'Nodo PRIMARY: transacciones ACID habilitadas',
        );
        await mongoose.disconnect();
        process.exit(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      logger.info({ attempt, setName: hello.setName ?? null }, 'Esperando promocion a PRIMARY');
    }
    throw new Error('El nodo no se promovio a PRIMARY en 30s');
  }

  await mongoose.disconnect();
  process.exit(0);
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Inicializacion de replica set fallida');
  process.exit(1);
});
