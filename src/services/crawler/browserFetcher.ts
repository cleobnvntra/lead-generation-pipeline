import type { Browser, BrowserContext, Route } from 'playwright';
import { registrableDomain, sameSite } from '../../lib/domain.ts';
import type { FetchResult, PageSource, PoliteFetcher } from './fetcher.ts';

export interface BrowserFetcherOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
}

/** Not needed to render text; blocking them keeps load on the site close to a plain fetch. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet', 'texttrack', 'manifest', 'websocket', 'eventsource']);

/** Analytics/ads: rendering doesn't need them, and loading them would register fake visits. */
const TRACKER_DOMAINS = new Set([
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'facebook.net',
  'facebook.com',
  'hotjar.com',
  'clarity.ms',
  'segment.io',
  'segment.com',
  'tiktok.com',
  'linkedin.com',
  'licdn.com',
  'bing.com',
]);

const NETWORK_IDLE_WAIT_MS = 8000;

/**
 * Headless-Chromium fallback for sites that render their content with JavaScript.
 * Shares robots.txt checks and the per-origin delay with PoliteFetcher, identifies itself
 * with the same bot User-Agent, and never runs for sites that refuse the crawler.
 */
export class BrowserFetcher implements PageSource {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly policy: PoliteFetcher,
    private readonly opts: BrowserFetcherOptions,
  ) {}

  /** Launches Chromium. Returns an error message instead of throwing if Playwright/Chromium is unavailable. */
  static async launch(policy: PoliteFetcher, opts: BrowserFetcherOptions): Promise<BrowserFetcher | { error: string }> {
    let browser: Browser;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0] ?? 'unknown error';
      return { error: `${msg} (install with: npx playwright install chromium)` };
    }
    const context = await browser.newContext({
      userAgent: opts.userAgent, // honest bot identity, same as the HTTP crawler
      locale: 'en-CA',
      serviceWorkers: 'block',
      acceptDownloads: false,
      javaScriptEnabled: true,
    });
    context.setDefaultNavigationTimeout(opts.timeoutMs);
    await context.route('**/*', (route) => handleRoute(route));
    return new BrowserFetcher(browser, context, policy, opts);
  }

  async fetchHtml(url: URL): Promise<FetchResult> {
    const requestedUrl = url.href;
    const denied = await this.policy.accessDenial(url);
    if (denied) return { ok: false, requestedUrl, reason: denied };

    await this.policy.waitTurn(url.origin);
    const page = await this.context.newPage();
    try {
      const res = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      if (!res) return { ok: false, requestedUrl, reason: 'browser: no response' };
      if (res.status() >= 400) return { ok: false, requestedUrl, status: res.status(), reason: `browser: HTTP ${res.status()}` };
      const contentType = res.headers()['content-type'] ?? '';
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        return { ok: false, requestedUrl, status: res.status(), reason: `browser: not HTML (${contentType || 'none'})` };
      }

      await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_WAIT_MS }).catch(() => undefined);

      // Redirects inside the browser skip our per-hop checks, so validate where we ended up.
      const finalUrl = new URL(page.url());
      if (!sameSite(finalUrl.hostname, url.hostname)) {
        return { ok: false, requestedUrl, reason: `browser: left the site (ended at ${finalUrl.hostname})` };
      }
      const finalDenied = await this.policy.accessDenial(finalUrl);
      if (finalDenied) return { ok: false, requestedUrl, reason: finalDenied };

      let html = await page.content();
      let truncated = false;
      if (Buffer.byteLength(html, 'utf8') > this.opts.maxBytes) {
        html = Buffer.from(html, 'utf8').subarray(0, this.opts.maxBytes).toString('utf8');
        truncated = true;
      }
      finalUrl.hash = '';
      return { ok: true, requestedUrl, finalUrl: finalUrl.href, status: res.status(), html, truncated };
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' ? 'timed out' : ((err as Error).message.split('\n')[0] ?? 'error');
      return { ok: false, requestedUrl, reason: `browser: ${msg}`, unreachable: true };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

async function handleRoute(route: Route): Promise<void> {
  const req = route.request();
  if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) return route.abort();
  // Embedded iframes (maps, video, chat widgets) aren't needed for contact details.
  if (req.resourceType() === 'document' && req.frame().parentFrame() !== null) return route.abort();

  let url: URL;
  try {
    url = new URL(req.url());
  } catch {
    return route.abort();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.abort();
  const domain = registrableDomain(url.hostname);
  if (!domain || TRACKER_DOMAINS.has(domain)) return route.abort(); // also rejects IPs/localhost
  return route.continue();
}
