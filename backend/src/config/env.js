import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  QUEUE_API_KEY: z.string().min(8, 'QUEUE_API_KEY must be at least 8 characters'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TIMEZONE: z.string().default('Asia/Dubai'),
  WAIT_TARGET_MIN: z.coerce.number().positive().default(5),
  DEMO_PASSWORD: z.string().default('Demo@2026'),
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DB_SSL: z.enum(['auto', 'on', 'off']).default('auto'),
  // Demo sites only: rebuild the demo organisations on start-up when their
  // data is out of date, so the dashboards always run up to today.
  DEMO_AUTO_REFRESH: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n\nSee .env.example\n`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
};
