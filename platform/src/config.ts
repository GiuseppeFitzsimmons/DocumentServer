import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(16),
  DS_URL: z.string().url(),
  DS_JWT_SECRET: z.string().min(8),
  TRUST_PROXY: z.string().default('false'),
  FILE_STORAGE_PATH: z.string().default('/data/files'),
  PLATFORM_BASE_URL: z.string().url(),
});

export const config = envSchema.parse(process.env);
