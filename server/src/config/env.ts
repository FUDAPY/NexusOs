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

  MONGO_URI: z.string().min(1, 'MONGO_URI requerido'),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).default(20),
  MONGO_DB_NAME: z.string().default('pos_cate'),

  REDIS_URL: z.string().min(1, 'REDIS_URL requerido'),
  REDIS_STOCK_LOCK_TTL_MS: z.coerce.number().int().min(500).default(5000),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),

  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_SALES_PATH: z.string().default('artifacts/erp_lingroup/users/admin_master_001/sales'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Configuracion de entorno invalida -> ${issues.join(' | ')}`);
}

export type Env = z.infer<typeof envSchema>;

export const env: Env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
