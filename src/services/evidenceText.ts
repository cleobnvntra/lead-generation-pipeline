import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { EvidenceModel } from '../models/evidenceModel.ts';
import { htmlToText } from './crawler/extract.ts';

/**
 * Visible text of every saved page for a company (plus notes on manual sources without a snapshot),
 * de-duplicated. This is the evidence the AI reads and that guardrails check claims against.
 */
export function loadPageTexts(evidence: EvidenceModel, companyId: number, dataDir: string): { url: string; text: string }[] {
  const allPages = evidence.pagesFor(companyId);
  const pages = allPages
    .map((p) => ({ url: p.final_url, text: readSnapshotText(dataDir, p.snapshot_path) }))
    .filter((p) => p.text.length > 0);
  for (const p of allPages) {
    if (p.capture === 'manual' && !p.snapshot_path && p.note) pages.push({ url: p.url, text: `(noted by a person) ${p.note}` });
  }
  return dedupeText(pages);
}

/** Reads a snapshot, refusing paths that escape DATA_DIR. */
export function readSnapshotText(dataDir: string, relativePath: string | null): string {
  if (!relativePath) return '';
  const root = resolve(dataDir);
  const file = resolve(root, relativePath);
  if (!file.startsWith(root + sep)) throw new Error(`snapshot path escapes data dir: ${relativePath}`);
  if (!existsSync(file)) return '';
  return htmlToText(readFileSync(file, 'utf8'));
}

/** Drops pages whose text duplicates an earlier one (e.g. http/https or trailing-slash variants). */
function dedupeText<T extends { text: string }>(pages: T[]): T[] {
  const seen = new Set<string>();
  return pages.filter((p) => {
    const key = p.text.slice(0, 2000);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
