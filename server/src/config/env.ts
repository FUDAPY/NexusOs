import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('/api/v1'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),

  MONGO_URI: z.string().optional(),
  MONGO_HOST: z.string().default('mongo:27017'),
  MONGO_USER: z.string().optional(),
  MONGO_PASSWORD: z.string().optional(),
  MONGO_AUTH_SOURCE: z.string().default('admin'),
  MONGO_REPLICA_SET: z.string().default('rs0'),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).default(20),
  MONGO_DB_NAME: z.string().default('pos_cate'),

  REDIS_URL: z.string().min(1, 'REDIS_URL requerido'),
  REDIS_STOCK_LOCK_TTL_MS: z.coerce.number().int().min(500).default(5000),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),

  FIREBASE_PROJECT_ID: z.string().optional(),
  /* El service account se puede pasar de DOS formas, porque en produccion cada una
     resuelve un caso distinto:
       - PATH: el archivo montado en el contenedor (lo que usa el ETL de migracion).
       - JSON: el contenido pegado en una variable de entorno de Dokploy, para no
         tener que montar un volumen solo por esto.
     Si estan las dos, gana el PATH: es la que ya usa `npm run migrate:firestore`. */
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_SALES_PATH: z.string().default('artifacts/erp_lingroup/users/admin_master_001/sales'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Configuracion de entorno invalida -> ${issues.join(' | ')}`);
}

const base = parsed.data;

/**
 * Arma la URI de conexion a MongoDB.
 *
 * Si MONGO_URI viene definida se usa tal cual. Si no, se construye con las
 * partes sueltas (MONGO_USER / MONGO_PASSWORD / MONGO_HOST / MONGO_DB_NAME).
 *
 * Se codifica la contrasena a proposito: un caracter reservado (@ : / ? # [ ] %)
 * sin codificar hace que el driver rechace la URI de plano con
 *   MongoParseError: Protocol and host list are required in "mongodb://..."
 * y el servicio muere en el arranque.
 */
const buildMongoUri = (data: z.infer<typeof envSchema>): string => {
  const explicit = (data.MONGO_URI ?? '').trim();
  if (explicit.length > 0) return explicit;

  const user = (data.MONGO_USER ?? '').trim();
  const password = data.MONGO_PASSWORD ?? '';

  if (user.length === 0 || password.length === 0) {
    throw new Error(
      'Configuracion de MongoDB ausente -> definir MONGO_URI, o bien MONGO_USER y MONGO_PASSWORD',
    );
  }

  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  const params = new URLSearchParams({ authSource: data.MONGO_AUTH_SOURCE });
  if (data.MONGO_REPLICA_SET.trim().length > 0) {
    params.set('replicaSet', data.MONGO_REPLICA_SET.trim());
  }

  return `mongodb://${credentials}@${data.MONGO_HOST}/${data.MONGO_DB_NAME}?${params.toString()}`;
};

export type Env = Omit<z.infer<typeof envSchema>, 'MONGO_URI'> & { MONGO_URI: string };

export const env: Env = { ...base, MONGO_URI: buildMongoUri(base) };
export const isProduction = env.NODE_ENV === 'production';
