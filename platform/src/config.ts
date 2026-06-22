import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(16),
  DS_URL: z.string().url(),
  DS_INTERNAL_URL: z.string().default(''),
  DS_JWT_SECRET: z.string().min(8),
  TRUST_PROXY: z.string().default('false'),
  FILE_STORAGE_PATH: z.string().default('/data/files'),
  PLATFORM_BASE_URL: z.string().url(),
  MAIL_DOMAIN: z.string().default('eurobureau.eu'),
  RESEND_API_KEY: z.string().default(''),
  DKIM_PRIVATE_KEY: z.string().default(''),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  OVH_S3_ENDPOINT: z.string().default(''),
  OVH_S3_BUCKET: z.string().default(''),
  OVH_S3_ACCESS_KEY: z.string().default(''),
  OVH_S3_SECRET_KEY: z.string().default(''),
  OVH_S3_REGION: z.string().default('par'),
});

export const config = envSchema.parse(process.env);
