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
 * Host que la app (dentro de la red del compose) usara para llegar al nodo.
 *
 * TIENE QUE SER UN NOMBRE ESTABLE. Esto ya rompio produccion una vez: el config
 * del replica set se guarda en los volumenes mongo-data/mongo-config y SOBREVIVE
 * a los redeploys, pero el hostname que Dokploy le da al contenedor
 * (`pos-erppos-3yohnd`) es ALEATORIO y cambia en cada deploy. Si se guarda ese
 * nombre, en el proximo redeploy mongod busca un host que ya no existe, el
 * conjunto se queda SIN PRIMARY, y como el driver exige primary escribible el
 * API no puede conectarse: `connectDatabase` lanza, `index.ts` hace
 * process.exit(1) ANTES de abrir el puerto, y nginx devuelve 502 en TODAS las
 * rutas, incluido /health — que es justo lo que impide diagnosticarlo rapido.
 *
 * Por eso el default es el nombre del SERVICIO en docker-compose.yml, que se
 * mantiene estable mientras no cambie el nombre del proyecto de Dokploy.
 */
const HOST_ESTABLE_POR_DEFECTO = 'mongo:27017';

const replicaHost = process.env['REPLICA_HOST'] ?? HOST_ESTABLE_POR_DEFECTO;

/**
 * Aviso temprano: un host que no sea el nombre del servicio es sospechoso.
 * No se bloquea (puede haber despliegues legitimos con otro nombre), pero se
 * dice en voz alta para que no vuelva a pasar en silencio.
 */
if (process.env['REPLICA_HOST'] !== undefined && replicaHost !== HOST_ESTABLE_POR_DEFECTO) {
  logger.warn(
    { replicaHost, estable: HOST_ESTABLE_POR_DEFECTO },
    'REPLICA_HOST distinto del nombre del servicio. Si es un nombre que genera Dokploy ' +
      '(ej. pos-erppos-3yohnd) va a dejar el conjunto SIN PRIMARY en el proximo redeploy: ' +
      'el hostname queda guardado en el volumen y cambia en cada deploy.',
  );
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

/** Config actual del conjunto, tal como quedo guardada en el volumen. */
interface ReplConf {
  _id: string;
  version?: number;
  members: { _id: number; host: string; priority?: number }[];
}

/**
 * Lee el config del conjunto. Funciona aunque el nodo NO sea primary: es una
 * lectura de la config local, no una operacion de escritura del conjunto.
 */
const readReplConf = async (): Promise<ReplConf | null> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin handle de base de datos');
  try {
    const res = (await db.admin().command({ replSetGetConfig: 1 })) as { config?: ReplConf };
    return res.config ?? null;
  } catch {
    return null;
  }
};

/**
 * Si el host guardado NO es el estable, lo reescribe.
 *
 * Este es el caso que rompia produccion: el nodo figura como miembro de `rs0`
 * (asi que parecia sano) pero apuntando a un hostname que Dokploy ya reciclo.
 * Sin esto el script decia "nada que hacer" y el conjunto se quedaba sin primary
 * para siempre.
 *
 * Se usa `force: true` a proposito: un conjunto de un solo nodo cuyo unico
 * miembro es inalcanzable NO puede elegir primary, y `replSetReconfig` normal
 * exige ser primary. El force es la unica forma de salir de ese estado.
 */
const repararHostSiHaceFalta = async (): Promise<boolean> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin handle de base de datos');

  const conf = await readReplConf();
  if (!conf || !Array.isArray(conf.members) || conf.members.length === 0) {
    logger.warn('No se pudo leer el config del conjunto: no se repara el host');
    return false;
  }

  const guardado = conf.members[0]?.host ?? '';
  if (guardado === replicaHost) return false;

  logger.warn(
    { guardado, estable: replicaHost },
    'El host guardado no es el estable y deja el conjunto SIN PRIMARY. Reconfigurando',
  );

  const nuevo: ReplConf = {
    ...conf,
    members: conf.members.map((miembro, indice) =>
      indice === 0 ? { ...miembro, host: replicaHost } : miembro,
    ),
  };

  await db.admin().command({ replSetReconfig: nuevo, force: true });
  logger.info({ host: replicaHost }, 'Host del conjunto corregido');
  return true;
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

  // Inventario del contenido: es INFORMATIVO y no debe abortar la inicializacion.
  // En un nodo con --replSet pero sin rs.initiate(), listCollections falla con
  // "node is not in primary or recovering state".
  try {
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
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message.split('\n')[0] : String(error) },
      'Inventario no disponible (esperado si el replica set aun no esta inicializado)',
    );
  }

  if (before.setName === REPLICA_SET_NAME) {
    logger.info({ replicaSetName: REPLICA_SET_NAME }, 'Ya es miembro del replica set');

    /* Caso critico: ser miembro NO alcanza. Si el host guardado es un nombre que
       Dokploy reciclo, el conjunto se ve "inicializado" pero no tiene primary. */
    const conf = await readReplConf();
    const hostGuardado = conf?.members[0]?.host ?? null;

    if (hostGuardado === replicaHost) {
      logger.info({ host: replicaHost }, 'El host del conjunto es el estable: nada que hacer');
    } else if (STATUS_ONLY) {
      logger.warn(
        { hostGuardado, hostEstable: replicaHost },
        'El host del conjunto NO coincide con el estable: sin primary no hay transacciones. ' +
          'Correr sin --status-only para repararlo.',
      );
    } else {
      await repararHostSiHaceFalta();
    }
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
  } else {
    // Unico camino posible: mongod debe haber arrancado con --replSet.
    const config = {
      _id: REPLICA_SET_NAME,
      members: [{ _id: 0, host: replicaHost, priority: 1 }],
    };

    logger.info({ config, replicaHost }, 'Enviando replSetInitiate');
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
