import pc from 'picocolors';
import type { CompanyStatus, Qualification } from '../models/types.ts';
import { QUALIFICATION_LABEL, STATUS_LABEL } from './labels.ts';

/** Small formatting toolkit for the interactive menu. Plain text with colour; no box borders to misalign. */

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Starts a fresh "page": clears the screen AND the scrollback (ESC[3J), so earlier screens can't be
 * scrolled back to. Content longer than the window can still be scrolled. No-op when not a terminal.
 */
export function newPage(flash?: string | null): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  if (flash) console.log(`${flash}\n`);
}

export function visibleLength(s: string): number {
  return s.replace(ANSI, '').length;
}

export function width(): number {
  const cols = process.stdout.columns ?? 100;
  return Math.max(60, Math.min(cols, 120));
}

export function truncate(s: string, max: number): string {
  if (max <= 1) return '…';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function padEnd(s: string, len: number): string {
  return s + ' '.repeat(Math.max(0, len - visibleLength(s)));
}

/** Word-wraps plain text to `max` columns. */
export function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > max) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export function title(text: string): string {
  const line = '─'.repeat(Math.max(0, width() - visibleLength(text) - 4));
  return `\n${pc.bold(pc.cyan(`── ${text} `))}${pc.dim(line)}`;
}

export function sectionHeading(text: string): string {
  return `\n${pc.bold(text)}`;
}

/** Aligned "Label   value" rows; long values wrap under the value column. */
export function keyValues(rows: [string, string | null | undefined][], indent = 2): string {
  const labelWidth = Math.max(...rows.map(([k]) => k.length)) + 2;
  const valueWidth = width() - indent - labelWidth - 1;
  const out: string[] = [];
  for (const [k, v] of rows) {
    const value = v === null || v === undefined || v === '' ? pc.dim('—') : v;
    const plain = visibleLength(value) === value.length; // only wrap uncoloured text
    const lines = plain ? wrap(value, valueWidth) : [value];
    out.push(`${' '.repeat(indent)}${pc.dim(padEnd(k, labelWidth))}${lines[0]}`);
    for (const extra of lines.slice(1)) out.push(`${' '.repeat(indent + labelWidth)}${extra}`);
  }
  return out.join('\n');
}

export interface Column<T> {
  header: string;
  get: (row: T) => string;
  /** Share of remaining width for flexible columns; fixed columns use `min`. */
  flex?: number;
  min: number;
}

/** Simple aligned table that fits the terminal width (flex columns are truncated). */
export function table<T>(rows: T[], columns: Column<T>[]): string {
  const gap = 2;
  const fixed = columns.filter((c) => !c.flex).reduce((n, c) => n + c.min + gap, 0);
  const flexTotal = columns.reduce((n, c) => n + (c.flex ?? 0), 0);
  const room = Math.max(0, width() - 2 - fixed - columns.filter((c) => c.flex).length * gap);
  const widths = columns.map((c) => (c.flex ? Math.max(c.min, Math.floor((room * c.flex) / flexTotal)) : c.min));

  const renderRow = (cells: string[]) =>
    '  ' +
    cells
      .map((cell, i) => {
        const w = widths[i]!;
        const fitted = visibleLength(cell) > w ? truncate(cell.replace(ANSI, ''), w) : cell;
        return padEnd(fitted, w);
      })
      .join(' '.repeat(gap));

  const header = pc.dim(renderRow(columns.map((c) => c.header)));
  const rule = pc.dim(`  ${'─'.repeat(widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1))}`);
  return [header, rule, ...rows.map((r) => renderRow(columns.map((c) => c.get(r))))].join('\n');
}

export function statusBadge(status: CompanyStatus): string {
  const label = STATUS_LABEL[status];
  switch (status) {
    case 'crawled':
      return pc.green(`✔ ${label}`);
    case 'new':
      return pc.dim(`○ ${label}`);
    case 'no_contacts':
      return pc.yellow(`! ${label}`);
    case 'opted_out':
      return pc.magenta(`⊘ ${label}`);
    case 'crawl_failed':
      return pc.red(`✖ ${label}`);
  }
}

export function qualificationBadge(q: Qualification | null): string {
  switch (q) {
    case 'qualified':
      return pc.green(`● ${QUALIFICATION_LABEL.qualified}`);
    case 'needs_review':
      return pc.yellow(`? ${QUALIFICATION_LABEL.needs_review}`);
    case 'disqualified':
      return pc.dim(`✖ ${QUALIFICATION_LABEL.disqualified}`);
    default:
      return pc.dim(`○ ${QUALIFICATION_LABEL.none}`);
  }
}

export const ok = (s: string) => `${pc.green('✔')} ${s}`;
export const warn = (s: string) => `${pc.yellow('!')} ${s}`;
export const bad = (s: string) => `${pc.red('✖')} ${s}`;
export const info = (s: string) => `${pc.cyan('›')} ${s}`;
export const dim = pc.dim;
export const bold = pc.bold;
