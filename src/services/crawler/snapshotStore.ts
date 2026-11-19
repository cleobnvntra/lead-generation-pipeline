import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Stores raw page HTML content-addressed under DATA_DIR/snapshots/<companyId>/. */
export class SnapshotStore {
  constructor(private readonly dataDir: string) {}

  save(companyId: number, html: string): { relativePath: string; sha256: string } {
    if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error(`Invalid companyId ${companyId}`);
    const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
    const dir = join(this.dataDir, 'snapshots', String(companyId));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sha256}.html`);
    if (!existsSync(file)) writeFileSync(file, html, 'utf8');
    return { relativePath: relative(this.dataDir, file).replaceAll('\\', '/'), sha256 };
  }
}
