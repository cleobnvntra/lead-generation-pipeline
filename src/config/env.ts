import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../lib/errors.ts';

const PLACEHOLDER = /^(|REPLACE_ME|TBD|changeme|your[-_ ]?key.*)$/i;

/** Treats empty strings and obvious placeholders as "not set". */
const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || PLACEHOLDER.test(v) ? undefined : v));

/** Optional email address; placeholders count as unset, anything else must be a plausible address. */
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .optional()
  .transform((v) => (v === undefined || PLACEHOLDER.test(v) || /@example\.com$|@yourdomain\.com$/.test(v) ? undefined : v))
  .refine((v) => v === undefined || /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(v), 'must be a valid email address');

const intInRange =(min: number, max: number, fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return fallback;
      if (!/^\d+$/.test(v)) {
        ctx.addIssue({ code: 'custom', message: `must be an integer, got "${v}"` });
        return z.NEVER;
      }
      const n = Number(v);
      if (n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be between ${min} and ${max}, got ${n}` });
        return z.NEVER;
      }
      return n;
    });

const envSchema = z.object({
  GOOGLE_PLACES_API_KEY: optionalSecret,
  PLACES_MAX_REQUESTS_PER_RUN: intInRange(1, 100, 10),
  PLACES_MAX_REQUESTS_PER_DAY: intInRange(1, 1000, 30),
  // Google's free cap for Text Search Enterprise is 1,000/month; default leaves a margin.
  PLACES_MAX_REQUESTS_PER_MONTH: intInRange(1, 100_000, 900),

  CRAWL_USER_AGENT: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : 'LeadPipelineBot/0.1'))
    .refine((v) => /^[\x20-\x7E]{3,200}$/.test(v), 'must be 3-200 printable ASCII characters'),
  CRAWL_DELAY_MS: intInRange(500, 60_000, 2000),
  CRAWL_TIMEOUT_MS: intInRange(1000, 120_000, 15_000),
  CRAWL_MAX_PAGES_PER_SITE: intInRange(1, 30, 8),
  CRAWL_MAX_BYTES: intInRange(10_000, 20_000_000, 2_000_000),
  // Different websites crawled at the same time. The per-site delay still applies to each site.
  CRAWL_CONCURRENCY: intInRange(1, 8, 4),
  // Headless-browser retry for JavaScript-rendered sites that yielded no contacts.
  CRAWL_BROWSER_FALLBACK: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'true' : v))
    .pipe(z.enum(['true', 'false'], { message: 'must be "true" or "false"' }))
    .transform((v) => v === 'true'),

  DATA_DIR: z
    .string()
    .trim()
    .optional()
    .transform((v) => resolve(v ? v : './data')),

  // Email. Only "test" exists: every message is redirected to TEST_RECIPIENT. Adding "live" must come with
  // a dedicated sending domain and an explicit opt-in (see CLAUDE.md).
  SEND_MODE: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((v) => (v ? v : 'test'))
    .pipe(z.enum(['test'], { message: 'only "test" is supported; live sending is not enabled' })),
  EMAIL_FROM: optionalEmail,
  TEST_RECIPIENT: optionalEmail,
  // Test emails per rolling 24h (protects the main domain's Gmail account from looking like bulk mail).
  TEST_SEND_MAX_PER_DAY: intInRange(1, 100, 20),

  LLM_PROVIDER: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.toLowerCase() : 'ollama'))
    .pipe(z.enum(['ollama'], { message: 'must be "ollama" (other providers not implemented yet)' })),
  OLLAMA_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : 'http://127.0.0.1:11434'))
    .refine((v) => {
      try {
        const u = new URL(v);
        return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
      } catch {
        return false;
      }
    }, 'must be an http(s) URL without credentials')
    .transform((v) => v.replace(/\/+$/, '')),
  OLLAMA_MODEL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : 'qwen3:8b'))
    .refine((v) => /^[\w.\-/]+(?::[\w.\-]+)?$/.test(v) && v.length <= 200, 'must look like "name" or "name:tag"'),
  LLM_TIMEOUT_MS: intInRange(5_000, 900_000, 180_000),
  // Context window in tokens. qwen3:8b at 8192 uses ~6-7 GB VRAM.
  LLM_NUM_CTX: intInRange(2048, 131_072, 8192),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Loads `.env` (if present) once, validates it, and returns a frozen config. */
export function getEnv(): Env {
  if (cached) return cached;
  const envFile = resolve('.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration in .env:\n${details}`);
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

/** Returns a required secret or throws a clear error naming the variable. */
export function requireSecret(name: 'GOOGLE_PLACES_API_KEY'): string {
  const value = getEnv()[name];
  if (!value) {
    throw new ConfigError(`${name} is not set. Add it to .env (see .env.example) before running this command.`);
  }
  return value;
}
