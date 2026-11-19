import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db/connection.ts';
import { runPool } from '../src/lib/pool.ts';
import { CompanyModel } from '../src/models/companyModel.ts';
import { PoliteFetcher } from '../src/services/crawler/fetcher.ts';
import { describeCrawlReason } from '../src/views/labels.ts';
import { table, visibleLength, wrap } from '../src/views/ui.ts';

test('runPool keeps order and never exceeds the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const out = await runPool([5, 1, 4, 2, 3], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, n * 3));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
  assert.deepEqual(await runPool([], 4, async () => 1), []);
  await assert.rejects(runPool([1], 0, async () => 1));
});

test('per-site delay holds when several crawls hit the same site at once', async () => {
  // 200ms delay, asserting >= 150ms: Windows timers can fire ~15ms early/late, so keep a wide margin.
  const f = new PoliteFetcher({ userAgent: 'TestBot/1', delayMs: 200, timeoutMs: 1000, maxBytes: 1000 });
  const times: number[] = [];
  await Promise.all([1, 2, 3].map(async () => {
    await f.waitTurn('https://acmepm.ca');
    times.push(Date.now());
  }));
  times.sort((a, b) => a - b);
  assert.ok(times[1]! - times[0]! >= 150, `gap ${times[1]! - times[0]!}ms`);
  assert.ok(times[2]! - times[1]! >= 150, `gap ${times[2]! - times[1]!}ms`);
});

test('company search matches name or domain and treats wildcards literally', () => {
  const db = openDb(':memory:');
  const m = new CompanyModel(db);
  m.addIfNew({ website: 'hanlyn.ca', name: 'Hanlyn Property Management', source: 'manual' });
  m.addIfNew({ website: 'brownstonepm.ca', name: 'Brownstone PM', source: 'manual' });
  m.addIfNew({ website: 'odd-name.ca', name: '100% Rentals_Co', source: 'manual' });
  assert.deepEqual(m.search('hanl', 10).map((c) => c.domain), ['hanlyn.ca']);
  assert.deepEqual(m.search('BROWNSTONEPM', 10).map((c) => c.domain), ['brownstonepm.ca']);
  assert.deepEqual(m.search('%', 10).map((c) => c.domain), ['odd-name.ca'], '% is literal');
  assert.deepEqual(m.search('_', 10).map((c) => c.domain), ['odd-name.ca'], '_ is literal');
  assert.equal(m.search('', 10).length, 3, 'empty search lists recent companies');
  assert.throws(() => m.search('x'.repeat(101), 10));
  db.close();
});

test('crawl failure reasons become plain language', () => {
  assert.equal(describeCrawlReason('homepage: HTTP 403'), 'website blocks automated visits');
  assert.match(describeCrawlReason('homepage: robots.txt unreachable (UND_ERR_CONNECT_TIMEOUT); ...')!, /didn't respond/);
  assert.equal(describeCrawlReason('homepage: disallowed by robots.txt: https://x.ca/'), 'website asks bots not to visit');
  assert.equal(describeCrawlReason(null), null);
  assert.equal(describeCrawlReason('something new'), 'something new');
});

test('table fits the terminal width and wrap respects the limit', () => {
  const rows = [{ a: '1', b: 'A very long company name that will not fit in a narrow column at all' }];
  const out = table(rows, [
    { header: '#', get: (r) => r.a, min: 4 },
    { header: 'Company', get: (r) => r.b, flex: 1, min: 10 },
  ]);
  for (const line of out.split('\n')) assert.ok(visibleLength(line) <= 122, `line too wide: ${visibleLength(line)}`);
  assert.ok(wrap('one two three four five six', 9).every((l) => l.length <= 9));
});
