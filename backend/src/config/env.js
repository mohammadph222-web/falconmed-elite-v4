import 'dotenv/config';
import { z } from 'zod';

const optional = z.string().trim().optional().transform((v) => v || undefined);

const schema = z
  .object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
    JWT_EXPIRES_IN: z.string().default('12h'),
    // Legacy shared kiosk key. Organisations now create their own keys in
    // Settings; this one only reaches demo organisations.
    QUEUE_API_KEY: optional,
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    // Optional regex for preview deployments, e.g. ^https://falconmed-[a-z0-9-]+-myteam\.vercel\.app$
    CORS_PREVIEW_PATTERN: optional,
    // Public URL of the dashboard, used in emails and Stripe redirects.
    APP_URL: z.string().url().default('http://localhost:5173'),
    TIMEZONE: z.string().default('Asia/Dubai'),
    WAIT_TARGET_MIN: z.coerce.number().positive().default(5),
    DEMO_PASSWORD: z.string().default('Demo@2026'),
    PORT: z.coerce.number().int().positive().default(5000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DB_SSL: z.enum(['auto', 'on', 'off']).default('auto'),
    // Demo sites only: rebuild the demo organisations on start-up when their
    // data is out of date, so the dashboards always run up to today.
    DEMO_AUTO_REFRESH: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    // Show the demo accounts on the login screen.
    DEMO_LOGIN: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

    // Email (Resend). Without a key, emails are written to the log instead.
    RESEND_API_KEY: optional,
    EMAIL_FROM: z.string().default('FalconMed Elite <no-reply@falconmed.app>'),

    // Stripe billing. Without a key, billing endpoints answer 503.
    STRIPE_SECRET_KEY: optional,
    STRIPE_WEBHOOK_SECRET: optional,
    STRIPE_PRICE_STARTER: optional,
    STRIPE_PRICE_PRO: optional,
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== 'production') return;
    const weak = (v) => /change-me|secret|password|test/i.test(v);
    if (e.JWT_SECRET.length < 32 || weak(e.JWT_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'use at least 32 random characters in production' });
    }
    if (e.QUEUE_API_KEY && (e.QUEUE_API_KEY.length < 24 || weak(e.QUEUE_API_KEY))) {
      ctx.addIssue({ code: 'custom', path: ['QUEUE_API_KEY'], message: 'use at least 24 random characters in production, or remove it' });
    }
    if (e.STRIPE_SECRET_KEY && !e.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['STRIPE_WEBHOOK_SECRET'], message: 'is required when STRIPE_SECRET_KEY is set' });
    }
    if (!e.RESEND_API_KEY) {
      console.warn('⚠️  RESEND_API_KEY is not set: password reset, invitation and confirmation emails will not be sent.');
    }
    if (!e.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must be an https:// URL in production' });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n\nSee .env.example\n`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  APP_URL: parsed.data.APP_URL.replace(/\/+$/, ''),
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  // Anchored, so a pattern can never match part of a longer, attacker-owned origin.
  corsPreview: parsed.data.CORS_PREVIEW_PATTERN ? new RegExp(`^(?:${parsed.data.CORS_PREVIEW_PATTERN.replace(/^\^|\$$/g, '')})$`) : null,
  isProd: parsed.data.NODE_ENV === 'production',
};
