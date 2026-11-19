import { isIP } from 'node:net';
import { getDomain } from 'tldts';
import { ValidationError } from './errors.ts';

/**
 * Parses a user/API-supplied website into a normalized http(s) URL.
 * Accepts bare hosts ("acme.ca"), rejects non-web schemes, credentials, IPs and local hosts.
 */
export function normalizeWebsiteUrl(input: unknown): URL {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ValidationError('Website must be a non-empty string.');
  }
  const raw = input.trim();
  if (raw.length > 2048) throw new ValidationError('Website URL is too long.');

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ValidationError(`Not a valid URL: "${raw}"`);
  }
  assertPublicWebUrl(url);
  url.hash = '';
  return url;
}

/** Throws unless the URL is http(s), has no credentials, and points at a public hostname. */
export function assertPublicWebUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`Only http(s) URLs are allowed, got "${url.protocol}"`);
  }
  if (url.username || url.password) throw new ValidationError('URLs with credentials are not allowed.');

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) throw new ValidationError(`IP-address URLs are not allowed: ${host}`);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ValidationError(`Local hostnames are not allowed: ${host}`);
  }
  if (!registrableDomain(host)) throw new ValidationError(`Hostname has no public registrable domain: ${host}`);
}

/** "www.toronto.acme.co.uk" -> "acme.co.uk". Returns null for hosts without a public suffix. */
export function registrableDomain(hostOrUrl: string): string | null {
  const d = getDomain(hostOrUrl, { allowPrivateDomains: false });
  return d ? d.toLowerCase() : null;
}

/** True when both hosts share the same registrable domain. */
export function sameSite(a: string, b: string): boolean {
  const da = registrableDomain(a);
  return da !== null && da === registrableDomain(b);
}
