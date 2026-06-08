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
  MAIL_DOMAIN: z.string().default('eurobureau.eu'),
  DKIM_PRIVATE_KEY: z.string().default(''),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
});

export const config = envSchema.parse(process.env);
