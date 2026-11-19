import { getEnv } from '../config/env.ts';
import type { Db } from '../db/connection.ts';
import { ValidationError } from '../lib/errors.ts';
import { runPool } from '../lib/pool.ts';
import { logHooks, type ProgressHooks } from '../lib/progress.ts';
import { CompanyModel } from '../models/companyModel.ts';
import { EvidenceModel } from '../models/evidenceModel.ts';
import type { Company, CompanyStatus } from '../models/types.ts';
import { BrowserFetcher } from '../services/crawler/browserFetcher.ts';
import { classifyEmail, emailOnDomain, looksJsRendered, parsePage, type OptOutFinding } from '../services/crawler/extract.ts';
import { PoliteFetcher, type FetchResult, type PageSource } from '../services/crawler/fetcher.ts';
import { SnapshotStore } from '../services/crawler/snapshotStore.ts';

export interface CrawlInput {
  limit: number;
  retryFailed: boolean;
  retryNoContacts?: boolean;
  /** Only crawl these companies (still must be in a crawlable status). */
  onlyIds?: readonly number[];
}

export interface CrawlSummary {
  companies: number;
  byStatus: Partial<Record<CompanyStatus, number>>;
  contactsAdded: number;
  browserRetries: number;
}

interface CompanyCrawlResult {
  status: CompanyStatus;
  reason: string | null;
  added: number;
  /** Homepage URL that worked, and whether its HTML was an empty JavaScript shell. */
  home?: { url: string; jsRendered: boolean };
}

/** Paths tried when the homepage links to no contact-like page. */
const FALLBACK_PATHS = ['/contact', '/contact-us', '/about', '/about-us'];
const BROWSER_NOTE = 'rendered by headless browser';

export async function crawl(db: Db, input: CrawlInput, hooks: ProgressHooks = logHooks): Promise<CrawlSummary> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
    throw new ValidationError('--limit must be an integer 1-1000');
  }
  const env = getEnv();
  const companies = new CompanyModel(db);
  const evidence = new EvidenceModel(db);
  const snapshots = new SnapshotStore(env.DATA_DIR);
  const fetcher = new PoliteFetcher({
    userAgent: env.CRAWL_USER_AGENT,
    delayMs: env.CRAWL_DELAY_MS,
    timeoutMs: env.CRAWL_TIMEOUT_MS,
    maxBytes: env.CRAWL_MAX_BYTES,
  });

  // Launched lazily (once, even with parallel crawls) on the first JavaScript-rendered site.
  let browserPromise: Promise<BrowserFetcher | { error: string }> | undefined;
  const getBrowser = (): Promise<BrowserFetcher | { error: string }> => {
    browserPromise ??= BrowserFetcher.launch(fetcher, {
      userAgent: env.CRAWL_USER_AGENT,
      timeoutMs: env.CRAWL_TIMEOUT_MS * 2,
      maxBytes: env.CRAWL_MAX_BYTES,
    }).then((b) => {
      if ('error' in b) hooks.warn(`Browser fallback unavailable: ${b.error}`);
      return b;
    });
    return browserPromise;
  };

  let queue = companies.listForCrawl(input.limit, input.retryFailed, input.retryNoContacts ?? false);
  if (input.onlyIds) {
    const only = new Set(input.onlyIds);
    queue = queue.filter((c) => only.has(c.id));
  }
  const summary: CrawlSummary = { companies: queue.length, byStatus: {}, contactsAdded: 0, browserRetries: 0 };
  if (queue.length === 0) {
    hooks.step('Nothing to crawl.');
    return summary;
  }
  hooks.step(`Checking ${queue.length} website(s), ${Math.min(env.CRAWL_CONCURRENCY, queue.length)} at a time...`);

  let done = 0;
  try {
    await runPool(queue, env.CRAWL_CONCURRENCY, async (company) => {
      let result: CompanyCrawlResult;
      try {
        result = await crawlCompany(company, fetcher, evidence, snapshots, env.CRAWL_MAX_PAGES_PER_SITE, hooks);
        if (result.status === 'no_contacts' && result.home?.jsRendered && env.CRAWL_BROWSER_FALLBACK) {
          const b = await getBrowser();
          if ('error' in b) {
            result.reason = 'site needs JavaScript; browser fallback unavailable';
          } else {
            hooks.detail(`${company.domain}: site renders with JavaScript; retrying in headless browser`);
            summary.browserRetries++;
            const second = await crawlCompany(company, b, evidence, snapshots, env.CRAWL_MAX_PAGES_PER_SITE, hooks, {
              startUrl: result.home.url,
              note: BROWSER_NOTE,
            });
            result = { ...second, reason: second.reason ?? BROWSER_NOTE };
          }
        }
      } catch (err) {
        result = { status: 'crawl_failed', reason: `unexpected error: ${(err as Error).message}`, added: 0 };
      }
      companies.setCrawlResult(company.id, result.status, result.reason);
      summary.byStatus[result.status] = (summary.byStatus[result.status] ?? 0) + 1;
      summary.contactsAdded += result.added;
      done++;
      hooks.crawled({
        done,
        total: queue.length,
        domain: company.domain,
        name: company.name,
        status: result.status,
        reason: result.reason,
        added: result.added,
      });
    });
  } finally {
    if (browserPromise) {
      const b = await browserPromise;
      if (!('error' in b)) await b.close();
    }
  }
  return summary;
}

/** Tries the stored URL, then the www./bare-host twin if the first was unreachable (common TLS/DNS misconfig). */
async function fetchHomepage(websiteUrl: string, source: PageSource, hooks: ProgressHooks): Promise<FetchResult> {
  const primary = new URL(websiteUrl);
  const first = await source.fetchHtml(primary);
  if (first.ok || !first.unreachable) return first;

  const twin = new URL(primary.href);
  twin.hostname = primary.hostname.startsWith('www.') ? primary.hostname.slice(4) : `www.${primary.hostname}`;
  hooks.detail(`${primary.host} unreachable, trying ${twin.host}`);
  const second = await source.fetchHtml(twin);
  return second.ok ? second : { ...first, reason: `${first.reason}; ${twin.host}: ${second.reason}` };
}

async function crawlCompany(
  company: Company,
  source: PageSource,
  evidence: EvidenceModel,
  snapshots: SnapshotStore,
  maxPages: number,
  hooks: ProgressHooks,
  opts: { startUrl?: string; note?: string } = {},
): Promise<CompanyCrawlResult> {
  const homeResult = opts.startUrl
    ? await source.fetchHtml(new URL(opts.startUrl))
    : await fetchHomepage(company.website_url, source, hooks);
  if (!homeResult.ok) return { status: 'crawl_failed', reason: `homepage: ${homeResult.reason}`, added: 0 };
  const home = homeResult;

  const homeUrl = new URL(home.finalUrl);
  const visited = new Set<string>();
  const optOuts: OptOutFinding[] = [];
  let added = 0;

  const handlePage = (requestedUrl: string, finalUrl: string, status: number, html: string): URL[] => {
    const snap = snapshots.save(company.id, html);
    const pageId = evidence.savePage({
      companyId: company.id,
      url: requestedUrl,
      finalUrl,
      httpStatus: status,
      snapshotPath: snap.relativePath,
      sha256: snap.sha256,
      fetchedAt: new Date().toISOString(),
      note: opts.note ?? null,
    });
    const parsed = parsePage(html, new URL(finalUrl));
    for (const e of parsed.emails) {
      const isNew = evidence.addContact({
        companyId: company.id,
        email: e.email,
        kind: classifyEmail(e.email),
        onCompanyDomain: emailOnDomain(e.email, company.domain) || emailOnDomain(e.email, new URL(finalUrl).hostname),
        method: e.method,
        context: e.context,
        sourcePageId: pageId,
        firstSeenAt: new Date().toISOString(),
      });
      if (isNew) added++;
    }
    for (const o of parsed.optOuts) {
      evidence.addOptOut(company.id, pageId, o.phrase, o.context);
      optOuts.push(o);
    }
    return parsed.links;
  };

  visited.add(home.requestedUrl).add(home.finalUrl);
  const links = handlePage(home.requestedUrl, home.finalUrl, home.status, home.html);
  const queue = links.length > 0 ? links : FALLBACK_PATHS.map((p) => new URL(p, homeUrl));

  let fetched = 1; // homepage
  for (const url of queue) {
    if (fetched >= maxPages) break;
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    fetched++;
    const page = await source.fetchHtml(url);
    if (!page.ok) {
      hooks.detail(`skip ${url.href}: ${page.reason}`);
      continue;
    }
    if (page.finalUrl !== url.href && visited.has(page.finalUrl)) continue; // redirected to a page we already have
    visited.add(page.finalUrl);
    handlePage(page.requestedUrl, page.finalUrl, page.status, page.html);
  }

  const homeInfo = { url: home.finalUrl, jsRendered: looksJsRendered(home.html) };
  if (optOuts.length > 0) {
    return { status: 'opted_out', reason: `site states: "${optOuts[0]!.phrase}"`, added, home: homeInfo };
  }
  const total = evidence.contactsFor(company.id).length;
  return total > 0
    ? { status: 'crawled', reason: null, added, home: homeInfo }
    : { status: 'no_contacts', reason: null, added, home: homeInfo };
}
