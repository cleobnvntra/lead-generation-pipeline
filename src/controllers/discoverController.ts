import { NON_COMPANY_DOMAINS, PLACES_MAX_PAGES, PLACES_QUERY_CACHE_DAYS } from '../config/constants.ts';
import { getEnv, requireSecret } from '../config/env.ts';
import type { Db } from '../db/connection.ts';
import { normalizeWebsiteUrl, registrableDomain } from '../lib/domain.ts';
import { LimitError, ValidationError } from '../lib/errors.ts';
import { logHooks, type ProgressHooks } from '../lib/progress.ts';
import { CompanyModel } from '../models/companyModel.ts';
import { PlacesUsageModel } from '../models/placesUsageModel.ts';
import { searchText, type Place } from '../services/places/placesClient.ts';

export interface DiscoverInput {
  city: string;
  query?: string;
  pages: number;
  force: boolean;
}

export interface DiscoverSummary {
  query: string;
  requests: number;
  placesSeen: number;
  added: number;
  duplicates: number;
  skipped: Record<string, number>;
  skippedByCache: boolean;
  /** Companies created by this run (for chaining into crawl/qualify). */
  addedIds: number[];
}

const CITY_RE = /^[\p{L}][\p{L} .'-]{1,79}$/u;

export function buildQuery(city: string, custom?: string): string {
  if (typeof city !== 'string' || !CITY_RE.test(city.trim())) {
    throw new ValidationError(`Invalid city "${city}". Use letters, spaces, . ' - (2-80 chars), e.g. "Toronto".`);
  }
  const c = city.trim().replace(/\s+/g, ' ');
  if (custom === undefined) return `property management companies in ${c}, Ontario`;
  const q = custom.trim().replace(/\s+/g, ' ');
  if (q.length < 3 || q.length > 200) throw new ValidationError('--query must be 3-200 characters');
  return q.includes('{city}') ? q.replaceAll('{city}', c) : `${q} in ${c}, Ontario`;
}

export async function discover(db: Db, input: DiscoverInput, hooks: ProgressHooks = logHooks): Promise<DiscoverSummary> {
  if (!Number.isInteger(input.pages) || input.pages < 1 || input.pages > PLACES_MAX_PAGES) {
    throw new ValidationError(`--pages must be an integer 1-${PLACES_MAX_PAGES}`);
  }
  const query = buildQuery(input.city, input.query);
  const env = getEnv();
  const apiKey = requireSecret('GOOGLE_PLACES_API_KEY');
  const usage = new PlacesUsageModel(db);
  const companies = new CompanyModel(db);

  const summary: DiscoverSummary = {
    query,
    requests: 0,
    placesSeen: 0,
    added: 0,
    duplicates: 0,
    skipped: {},
    skippedByCache: false,
    addedIds: [],
  };

  const last = usage.lastSuccessfulRun(query);
  if (last && !input.force && Date.now() - Date.parse(last) < PLACES_QUERY_CACHE_DAYS * 86_400_000) {
    hooks.step(`This search was already run on ${last.slice(0, 10)}; skipped to save quota (use --force to re-run).`);
    summary.skippedByCache = true;
    return summary;
  }

  hooks.step(`Searching Google for "${query}"...`);
  let pageToken: string | undefined;
  for (let pageNo = 1; pageNo <= input.pages; pageNo++) {
    assertWithinLimits(usage, summary.requests, env);

    const ledgerId = usage.reserve(query, pageNo);
    summary.requests++;
    let result;
    try {
      result = await searchText({ apiKey, textQuery: query, ...(pageToken ? { pageToken } : {}) });
    } catch (err) {
      usage.complete(ledgerId, (err as { status?: number }).status ?? 0, null);
      throw err;
    }
    usage.complete(ledgerId, result.status, result.page.places.length);
    hooks.detail(`Page ${pageNo}: ${result.page.places.length} places`);

    for (const place of result.page.places) {
      summary.placesSeen++;
      const outcome = ingestPlace(companies, place, query);
      if (typeof outcome === 'number') {
        summary.added++;
        summary.addedIds.push(outcome);
      }
      else if (outcome === 'duplicate') summary.duplicates++;
      else summary.skipped[outcome] = (summary.skipped[outcome] ?? 0) + 1;
    }

    pageToken = result.page.nextPageToken;
    if (!pageToken) break;
  }
  return summary;
}

function assertWithinLimits(usage: PlacesUsageModel, thisRun: number, env: ReturnType<typeof getEnv>): void {
  if (thisRun >= env.PLACES_MAX_REQUESTS_PER_RUN) {
    throw new LimitError(`Reached PLACES_MAX_REQUESTS_PER_RUN (${env.PLACES_MAX_REQUESTS_PER_RUN}).`);
  }
  const day = usage.countLast24h();
  if (day >= env.PLACES_MAX_REQUESTS_PER_DAY) {
    throw new LimitError(`Reached PLACES_MAX_REQUESTS_PER_DAY (${day}/${env.PLACES_MAX_REQUESTS_PER_DAY} in last 24h).`);
  }
  const month = usage.countThisMonth();
  if (month >= env.PLACES_MAX_REQUESTS_PER_MONTH) {
    throw new LimitError(`Reached PLACES_MAX_REQUESTS_PER_MONTH (${month}/${env.PLACES_MAX_REQUESTS_PER_MONTH}).`);
  }
}

/** A number is the id of a newly added company. */
type IngestOutcome = number | 'duplicate' | 'no website' | 'not operational' | 'non-company website' | 'invalid website';

function ingestPlace(companies: CompanyModel, place: Place, query: string): IngestOutcome {
  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return 'not operational';
  if (!place.websiteUri) return 'no website';

  let domain: string | null;
  try {
    domain = registrableDomain(normalizeWebsiteUrl(place.websiteUri).hostname);
  } catch {
    return 'invalid website';
  }
  if (!domain) return 'invalid website';
  if (NON_COMPANY_DOMAINS.has(domain)) return 'non-company website';

  // Places often appends tracking params (utm_*); crawl the site root instead.
  const root = new URL(normalizeWebsiteUrl(place.websiteUri).origin);
  const res = companies.addIfNew({
    name: place.displayName?.text ?? null,
    website: root.href,
    address: place.formattedAddress ?? null,
    phone: place.nationalPhoneNumber ?? null,
    source: 'google_places',
    googlePlaceId: place.id,
    discoveryQuery: query,
  });
  return res.created ? res.id : 'duplicate';
}
