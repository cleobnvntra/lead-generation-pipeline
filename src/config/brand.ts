import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../lib/errors.ts';
import { SERVICES, type Service } from '../models/types.ts';

/** Shown in emails until the real value is set in brand.json. Live sending must refuse text containing it. */
export const PLACEHOLDER_ADDRESS = '[MAILING ADDRESS]';

const brandSchema = z.object({
  businessName: z.string().trim().min(2).max(100),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+()\-. ]{7,25}$/, 'phone may only contain digits, spaces and + ( ) - .'),
  website: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'website must start with http:// or https://'),
  signature: z.string().trim().min(2).max(100),
  /** null until decided; emails then show PLACEHOLDER_ADDRESS (CASL requires a real one before live sending). */
  mailingAddress: z.string().trim().min(10).max(200).nullable(),
  offeredServices: z
    .array(z.enum(SERVICES))
    .min(1, 'offer at least one service')
    .refine((a) => new Set(a).size === a.length, 'offeredServices has duplicates'),
});

export type Brand = z.infer<typeof brandSchema> & { offeredServices: Service[] };

let cached: Brand | undefined;

/**
 * Loads and validates brand.json (your business details) from the project root.
 * brand.json is local and git-ignored; copy brand.example.json to start.
 */
export function getBrand(path = resolve('brand.json')): Brand {
  if (cached && path === resolve('brand.json')) return cached;
  if (!existsSync(path)) {
    throw new ConfigError(`brand.json not found at ${path}. Copy brand.example.json to brand.json and fill in your business details.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError('brand.json is not valid JSON.');
  }
  const parsed = brandSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid brand.json:\n${details}`);
  }
  const brand = Object.freeze(parsed.data) as Brand;
  if (path === resolve('brand.json')) cached = brand;
  return brand;
}
