import { setTimeout as sleep } from 'node:timers/promises';
import * as robotsParserNs from 'robots-parser';
import { assertPublicWebUrl } from '../../lib/domain.ts';

// robots-parser is CommonJS with an ESM-style .d.ts; Node exposes module.exports as `default`.
type RobotsParserFn = (
  url: string,
  contents: string,
) => { isAllowed(url: string, ua?: string): boolean | undefined; getCrawlDelay(ua?: string): number | undefined };
const robotsParser: RobotsParserFn =
  (robotsParserNs as unknown as { default?: RobotsParserFn }).default ?? (robotsParserNs as unknown as RobotsParserFn);

export interface FetcherOptions {
  userAgent: string;
  delayMs: number;
  timeoutMs: number;
  maxBytes: number;
}

/** Anything that can fetch a page for the crawler (plain HTTP or headless browser). */
export interface PageSource {
  fetchHtml(url: URL): Promise<FetchResult>;
}

export type FetchResult =
  | { ok: true; requestedUrl: string; finalUrl: string; status: number; html: string; truncated: boolean }
  | { ok: false; requestedUrl: string; reason: string; status?: number; unreachable?: boolean };

type RobotsRule =
  | { isAllowed(url: string, ua?: string): boolean | undefined; crawlDelayMs: number }
  | 'allow-all'
  | { denyAll: string };

const MAX_REDIRECTS = 5;
const MAX_CRAWL_DELAY_MS = 30_000;
const ROBOTS_MAX_BYTES = 500_000;

/**
 * HTML fetcher that honours robots.txt (RFC 9309), keeps a per-origin delay,
 * validates every redirect hop, and caps response size.
 */
export class PoliteFetcher implements PageSource {
  private readonly lastHit = new Map<string, number>();
  private readonly robots = new Map<string, RobotsRule>();
  private readonly robotsPending = new Map<string, Promise<RobotsRule>>();
  private readonly uaToken: string;

  constructor(private readonly opts: FetcherOptions) {
    if (!opts.userAgent.trim()) throw new Error('userAgent is required');
    this.uaToken = opts.userAgent.split('/')[0]!.trim();
  }

  async fetchHtml(input: URL): Promise<FetchResult> {
    const requestedUrl = input.href;
    let current = new URL(input.href);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        assertPublicWebUrl(current);
      } catch (err) {
        return { ok: false, requestedUrl, reason: `blocked URL: ${(err as Error).message}` };
      }
      const denied = await this.robotsDenial(current);
      if (denied) return { ok: false, requestedUrl, reason: denied, unreachable: denied.startsWith('robots.txt unreachable') };

      let res: Response;
      try {
        await this.waitTurn(current.origin);
        res = await fetch(current, {
          redirect: 'manual',
          headers: {
            'User-Agent': this.opts.userAgent,
            Accept: 'text/html,application/xhtml+xml;q=0.9',
            'Accept-Language': 'en-CA,en;q=0.8',
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        return { ok: false, requestedUrl, reason: `network error: ${describeError(err)}`, unreachable: true };
      }

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (!location) return { ok: false, requestedUrl, status: res.status, reason: 'redirect without Location' };
        try {
          current = new URL(location, current);
        } catch {
          return { ok: false, requestedUrl, status: res.status, reason: `bad redirect Location: ${location.slice(0, 200)}` };
        }
        current.hash = '';
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, requestedUrl, status: res.status, reason: `HTTP ${res.status}` };
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        await res.body?.cancel();
        return { ok: false, requestedUrl, status: res.status, reason: `not HTML (${contentType || 'no content-type'})` };
      }

      try {
        const { text, truncated } = await readCapped(res, this.opts.maxBytes, contentType);
        return { ok: true, requestedUrl, finalUrl: current.href, status: res.status, html: text, truncated };
      } catch (err) {
        return { ok: false, requestedUrl, status: res.status, reason: `read error: ${describeError(err)}` };
      }
    }
    return { ok: false, requestedUrl, reason: `more than ${MAX_REDIRECTS} redirects` };
  }

  /** Public URL + robots.txt check shared with the browser fetcher. Returns a denial reason, or null if allowed. */
  async accessDenial(url: URL): Promise<string | null> {
    try {
      assertPublicWebUrl(url);
    } catch (err) {
      return `blocked URL: ${(err as Error).message}`;
    }
    return this.robotsDenial(url);
  }

  /** Returns a reason string if robots.txt forbids (or could not confirm) access, else null. */
  private async robotsDenial(url: URL): Promise<string | null> {
    const rule = await this.robotsFor(url.origin);
    if (rule === 'allow-all') return null;
    if ('denyAll' in rule) return rule.denyAll;
    return rule.isAllowed(url.href, this.uaToken) === false ? `disallowed by robots.txt: ${url.href}` : null;
  }

  /** One robots.txt fetch per origin, even when several crawls ask at once. */
  private robotsFor(origin: string): Promise<RobotsRule> {
    const cached = this.robots.get(origin);
    if (cached) return Promise.resolve(cached);
    let pending = this.robotsPending.get(origin);
    if (!pending) {
      pending = this.loadRobots(origin).finally(() => this.robotsPending.delete(origin));
      this.robotsPending.set(origin, pending);
    }
    return pending;
  }

  private async loadRobots(origin: string): Promise<RobotsRule> {

    let rule: RobotsRule;
    const robotsUrl = `${origin}/robots.txt`;
    try {
      await this.waitTurn(origin);
      const res = await fetch(robotsUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': this.opts.userAgent },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (res.ok) {
        const { text } = await readCapped(res, ROBOTS_MAX_BYTES, res.headers.get('content-type') ?? '');
        const parsed = robotsParser(robotsUrl, text);
        const delaySec = parsed.getCrawlDelay(this.uaToken);
        rule = {
          isAllowed: (u, ua) => parsed.isAllowed(u, ua),
          crawlDelayMs: typeof delaySec === 'number' && delaySec > 0 ? Math.min(delaySec * 1000, MAX_CRAWL_DELAY_MS) : 0,
        };
      } else if (res.status >= 400 && res.status < 500) {
        await res.body?.cancel();
        rule = 'allow-all'; // RFC 9309 §2.3.1.3: unavailable robots.txt => no restrictions
      } else {
        await res.body?.cancel();
        // RFC 9309 §2.3.1.4: unreachable => assume complete disallow
        rule = { denyAll: `robots.txt unreachable (HTTP ${res.status}); not crawling ${origin}` };
      }
    } catch (err) {
      rule = { denyAll: `robots.txt unreachable (${describeError(err)}); not crawling ${origin}` };
    }
    this.robots.set(origin, rule);
    return rule;
  }

  /** Per-origin politeness delay; shared with the browser fetcher so both count against one clock. */
  async waitTurn(origin: string): Promise<void> {
    const rule = this.robots.get(origin);
    const delay = Math.max(this.opts.delayMs, typeof rule === 'object' && 'crawlDelayMs' in rule ? rule.crawlDelayMs : 0);
    // Reserve the slot synchronously so concurrent callers for one origin queue up instead of racing.
    const last = this.lastHit.get(origin);
    const slot = last === undefined ? Date.now() : Math.max(Date.now(), last + delay);
    this.lastHit.set(origin, slot);
    const wait = slot - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

async function readCapped(res: Response, maxBytes: number, contentType: string): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const buf = Buffer.concat(chunks, total);
  return { text: decoderFor(contentType).decode(buf), truncated };
}

function decoderFor(contentType: string): TextDecoder {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      /* unknown label: fall back to UTF-8 */
    }
  }
  return new TextDecoder('utf-8');
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    if (err.name === 'TimeoutError') return 'timed out';
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
}
