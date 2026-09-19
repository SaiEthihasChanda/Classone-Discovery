/**
 * Environment configuration.
 *
 * Every env var the backend depends on is declared and validated here, once, at
 * startup. A missing or malformed var crashes the process immediately with a
 * readable message rather than surfacing as a confusing `undefined` deep inside
 * a request three days later.
 *
 * All services share the single `.env` at the repo root.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

dotenv.config({ path: path.join(repoRoot, '.env') });

/** Coerces the string "true"/"false" that env vars always arrive as into a real boolean. */
const boolFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(String(defaultValue) as 'true' | 'false')
    .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required — see .env.example for how to get one from Atlas'),
  MONGO_DB_NAME: z.string().default('classone_automation'),
  DB_PROVIDER: z.enum(['mongo', 'firestore']).default('mongo'),

  SCRAPER_SERVICE_URL: z.string().url().default('http://localhost:8000'),

  // Optional until Phase 2 — the app boots and serves CRUD without an OpenAI key.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_CHEAP: z.string().default('gpt-4o-mini'),
  OPENAI_MODEL_STRONG: z.string().default('gpt-4o'),
  OPENAI_RUN_BUDGET_USD: z.coerce.number().positive().default(5),

  EMAIL_PROVIDER: z.enum(['ethereal', 'gmail']).default('ethereal'),
  EMAIL_FROM_NAME: z.string().default('Class One Systems'),
  EMAIL_FROM_ADDRESS: z.string().default('sales@classone-systems.example'),

  OPENALEX_MAILTO: z.string().optional(),
  // Free key from openalex.org/settings/api. Raises the daily allowance from
  // $0.10 to $1.00 — a 10x increase for no cost. Optional, but the app is
  // heavily rate-limited without it.
  OPENALEX_API_KEY: z.string().optional(),

  CRON_ENABLED: boolFromString(false),
  CRON_DISCOVERY_SCHEDULE: z.string().default('0 2 * * 1'),
  CRON_FOLLOWUP_CHECK_SCHEDULE: z.string().default('0 9 * * *'),

  FOLLOWUP_WAIT_DAYS: z.coerce.number().int().positive().default(6),
  FOLLOWUP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(
    `\nInvalid environment configuration:\n${issues}\n\n` +
      `Copy .env.example to .env at the repo root and fill in the missing values.\n`,
  );
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  isProduction: parsed.data.NODE_ENV === 'production',
  repoRoot,
};

export type Env = typeof env;
