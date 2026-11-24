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
  // Off switch for every Vidwan request (roster build). Shared with the scraper
  // service, which refuses Vidwan calls when it is false.
  VIDWAN_ENABLED: boolFromString(true),

  // Optional until Phase 2 — the app boots and serves CRUD without an OpenAI key.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_CHEAP: z.string().default('gpt-4o-mini'),
  OPENAI_MODEL_STRONG: z.string().default('gpt-4o'),
  OPENAI_RUN_BUDGET_USD: z.coerce.number().positive().default(5),

  // Jev (TypeSafe AI) — a typed-decision model, used for relevance scoring in
  // place of OpenAI when set. Takes priority over OPENAI_API_KEY when both are
  // present (see services/ai/enrichmentService.ts).
  JEV_API_KEY: z.string().optional(),
  JEV_MODEL: z.string().default('jev-latest'),
  JEV_RUN_BUDGET_USD: z.coerce.number().positive().default(5),

  // Gemini (Google AI Studio) — free-tier experiment. Used when set and neither
  // Jev nor OpenAI is configured. Get a key at https://aistudio.google.com/apikey.
  GEMINI_API_KEY: z.string().optional(),
  // Alias, not a pinned version — Google repoints it as models are retired, so this
  // doesn't go stale the way a hardcoded version (e.g. "gemini-2.5-flash") did.
  GEMINI_MODEL: z.string().default('gemini-flash-lite-latest'),
  // Tried in order when GEMINI_MODEL is busy (5xx), out of quota (429) or gone (404).
  // Google sets quotas per model, so these are separate allowances on the same project.
  // Scores from different models are not perfectly comparable; each record keeps
  // relevance.scoringModel. Empty = no fallback. Use real model ids, not aliases:
  // gemini-flash-lite-latest IS gemini-3.5-flash-lite (same quota), and the 2.5
  // models answer 404 "no longer available to new users" (checked Nov 2026).
  GEMINI_FALLBACK_MODELS: z.string().default('gemini-3.1-flash-lite,gemini-3.5-flash'),
  // Researchers scored per AI call (Gemini only; other providers score one at a time).
  // Free-tier limits count requests, so batching stretches them; 1 = no batching.
  AI_SCORE_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(6),

  // A SECOND, billed Gemini key for web-search backfill — grounding needs billing
  // enabled (confirmed live: a free-tier key gets 429 RESOURCE_EXHAUSTED on the
  // googleSearch tool). Kept separate from GEMINI_API_KEY so scoring stays free.
  GEMINI_BACKFILL_API_KEY: z.string().optional(),
  GEMINI_BACKFILL_MODEL: z.string().default('gemini-flash-lite-latest'),
  // Google's free grounding allowance before $14/1,000 requests kicks in — purely
  // a cost-awareness threshold here (crossing it still works, just isn't free).
  GEMINI_BACKFILL_MONTHLY_FREE_SEARCHES: z.coerce.number().int().positive().default(5000),

  EMAIL_PROVIDER: z.enum(['ethereal', 'gmail']).default('ethereal'),
  EMAIL_FROM_NAME: z.string().default('Class One Systems'),
  EMAIL_FROM_ADDRESS: z.string().default('sales@classone-systems.example'),

  // Gmail send (EMAIL_PROVIDER=gmail only). GMAIL_REFRESH_TOKEN is obtained by
  // running `npm run gmail:auth` once the client id/secret are set — see
  // backend/src/scripts/gmailAuth.ts.
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),

  OPENALEX_MAILTO: z.string().optional(),
  // Free key from openalex.org/settings/api. Raises the daily allowance from
  // $0.10 to $1.00 — a 10x increase for no cost. Optional, but the app is
  // heavily rate-limited without it.
  OPENALEX_API_KEY: z.string().optional(),

  // Firebase Auth (sign-in) + RBAC. Off by default outside production so local
  // dev and the smoke tests keep working without a sign-in; production
  // defaults ON and refuses to start without FIREBASE_PROJECT_ID.
  AUTH_ENABLED: z.enum(['true', 'false']).optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  // Comma-separated: these addresses become admins on first sign-in. Everyone
  // else signs in as "pending" until an admin assigns a role.
  ADMIN_EMAILS: z.string().default(''),
  // Shared secret for server-side callers (the roster orchestrator script),
  // sent as X-Internal-Token. Acts as an admin. Leave blank to disable.
  INTERNAL_API_TOKEN: z.string().optional(),

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

const authEnabled = parsed.data.AUTH_ENABLED
  ? parsed.data.AUTH_ENABLED === 'true'
  : parsed.data.NODE_ENV === 'production';

if (authEnabled && !parsed.data.FIREBASE_PROJECT_ID) {
  console.error('\nAUTH_ENABLED is on but FIREBASE_PROJECT_ID is not set — refusing to start an unverifiable API.\n');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  isProduction: parsed.data.NODE_ENV === 'production',
  authEnabled,
  adminEmails: parsed.data.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  repoRoot,
};

export type Env = typeof env;
