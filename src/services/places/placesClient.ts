import { z } from 'zod';
import { PLACES_FIELD_MASK } from '../../config/constants.ts';
import { ExternalApiError, ValidationError } from '../../lib/errors.ts';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

const placeSchema = z.object({
  id: z.string().min(1),
  displayName: z.object({ text: z.string() }).partial().optional(),
  formattedAddress: z.string().optional(),
  websiteUri: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  businessStatus: z.string().optional(),
});

const responseSchema = z.object({
  places: z.array(placeSchema).optional().default([]),
  nextPageToken: z.string().optional(),
});

export type Place = z.infer<typeof placeSchema>;
export interface SearchPage {
  places: Place[];
  nextPageToken: string | undefined;
}

export interface SearchParams {
  apiKey: string;
  textQuery: string;
  pageToken?: string;
  timeoutMs?: number;
}

/** One billable call to Places Text Search (New). Pagination calls must repeat the same textQuery. */
export async function searchText(params: SearchParams): Promise<{ status: number; page: SearchPage }> {
  if (!params.apiKey) throw new ValidationError('apiKey is required');
  if (!params.textQuery.trim() || params.textQuery.length > 300) {
    throw new ValidationError('textQuery must be 1-300 characters');
  }

  const body: Record<string, unknown> = {
    textQuery: params.textQuery,
    regionCode: 'CA',
    languageCode: 'en',
    pageSize: 20,
  };
  if (params.pageToken) body.pageToken = params.pageToken;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': params.apiKey,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(params.timeoutMs ?? 20_000),
    });
  } catch (err) {
    throw new ExternalApiError(`Places request failed: ${(err as Error).message}`, 0);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ExternalApiError(`Places API HTTP ${res.status}: ${detail}`, res.status);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ExternalApiError('Places API returned non-JSON response', res.status);
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ExternalApiError(`Unexpected Places response shape: ${parsed.error.message.slice(0, 300)}`, res.status);
  }
  return { status: res.status, page: { places: parsed.data.places, nextPageToken: parsed.data.nextPageToken } };
}
