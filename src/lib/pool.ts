/**
 * Runs `worker` over `items` with at most `concurrency` in flight. Results keep input order.
 * A worker that throws rejects the whole run; workers should catch their own per-item errors.
 */
export async function runPool<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(lanes);
  return results;
}
