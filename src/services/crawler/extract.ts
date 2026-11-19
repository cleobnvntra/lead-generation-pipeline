import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { EXCLUDED_LOCAL_PARTS, JUNK_EMAIL_DOMAINS, ROLE_LOCAL_PARTS } from '../../config/constants.ts';
import { sameSite } from '../../lib/domain.ts';
import type { ContactKind, ExtractionMethod } from '../../models/types.ts';

export interface FoundEmail {
  email: string;
  method: ExtractionMethod;
  context: string;
}

export interface OptOutFinding {
  phrase: string;
  context: string;
}

export interface ParsedPage {
  emails: FoundEmail[];
  links: URL[];
  optOuts: OptOutFinding[];
}

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const FILE_LIKE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'ico', 'bmp', 'avif', 'mp4', 'pdf']);
const NON_HTML_LINK = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3)$/i;

/** Pages most likely to list contacts, scored by keyword in path or link text. */
const LINK_KEYWORDS: readonly [RegExp, number][] = [
  [/contact/i, 30],
  [/\b(team|staff|people|leadership|management-team|our-team|meet)\b/i, 20],
  [/\b(about|who-we-are|company)\b/i, 10],
];

/**
 * Wording that withdraws the CASL s.10(9)(b) "conspicuous publication" exemption.
 * Deliberately broad: a false positive costs one lead; a false negative risks a violation.
 */
const OPT_OUT_PATTERNS: readonly [string, RegExp][] = [
  ['no unsolicited', /\b(?:no|not\s+accept(?:ing)?|do\s+not\s+(?:send|accept|want)|does\s+not\s+(?:accept|consent))\s+(?:to\s+receiv\w*\s+)?unsolicited\b/i],
  ['unsolicited ... not accepted', /\bunsolicited\s+(?:commercial\s+)?(?:e-?mails?|messages?|electronic\s+messages?|solicitations?|offers?|advertis\w*|sales\s+\w+)\s+(?:are|is|will)\s+(?:not|be\s+(?:ignored|deleted|reported|discarded))/i],
  ['does not consent to receive', /\b(?:do|does)\s+not\s+consent\s+to\s+(?:the\s+)?receiv\w*\s+(?:of\s+)?(?:commercial|unsolicited|marketing)/i],
  ['no solicitation', /\bno\s+(?:solicitations?|soliciting|solicitors)\b/i],
  ['do not solicit', /\bplease\s+do\s+not\s+(?:solicit|send\s+(?:us\s+)?(?:marketing|sales|promotional|commercial))/i],
  ['not for solicitation', /\bnot\s+(?:to\s+)?be\s+used\s+for\s+(?:commercial|marketing|solicitation|sales)\b/i],
];

export function parsePage(html: string, pageUrl: URL): ParsedPage {
  const $ = cheerio.load(html);
  const emails = new Map<string, FoundEmail>();
  const add = (raw: string, method: ExtractionMethod, context: string) => {
    const email = cleanEmail(raw);
    if (email && !emails.has(email)) emails.set(email, { email, method, context: squash(context).slice(0, 300) });
  };

  // 1. mailto: links
  $('a[href^="mailto:" i]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    for (const addr of parseMailto(href)) add(addr, 'mailto', blockText($, el));
  });

  // 2. Cloudflare email obfuscation (address is visible to humans, encoded in markup)
  $('[data-cfemail]').each((_, el) => {
    const decoded = decodeCfEmail($(el).attr('data-cfemail') ?? '');
    if (decoded) add(decoded, 'cfemail', blockText($, el));
  });
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const hex = ($(el).attr('href') ?? '').split('#')[1] ?? '';
    const decoded = decodeCfEmail(hex);
    if (decoded) add(decoded, 'cfemail', blockText($, el));
  });

  // 3. Plain visible text (scripts/styles/hidden templates excluded)
  const text = visibleText($);
  for (const m of text.matchAll(EMAIL_IN_TEXT)) {
    const i = m.index ?? 0;
    add(m[0], 'text', text.slice(Math.max(0, i - 120), i + m[0].length + 120));
  }

  return { emails: dropGluedPrefixes([...emails.values()]), links: candidateLinks($, pageUrl), optOuts: findOptOuts(text) };
}

/** Drops text-scraped addresses that are another found address with a label glued on ("emailinfo@x" vs "info@x"). */
function dropGluedPrefixes(found: FoundEmail[]): FoundEmail[] {
  return found.filter(
    (e) => e.method !== 'text' || !found.some((o) => o !== e && o.email.length < e.email.length && e.email.endsWith(o.email)),
  );
}

/** Lowercases and validates an address; returns null for junk, placeholders or excluded mailboxes. */
export function cleanEmail(raw: string): string | null {
  const email = raw.trim().replace(/^mailto:/i, '').replace(/[.,;:]+$/, '').toLowerCase();
  if (email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || email.indexOf('@') !== at) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > 64 || !/^[a-z0-9._%+-]+$/.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  const tld = labels[labels.length - 1]!;
  if (!/^[a-z]{2,24}$/.test(tld) || FILE_LIKE_TLDS.has(tld)) return null;

  if (JUNK_EMAIL_DOMAINS.has(domain) || [...JUNK_EMAIL_DOMAINS].some((d) => domain.endsWith(`.${d}`))) return null;
  if (EXCLUDED_LOCAL_PARTS.has(local)) return null;
  return email;
}

/** Words that mark a shared mailbox even when combined with a region, e.g. "torontoinfo", "info.kw", "kw-leasing". */
const ROLE_AFFIXES = ['info', 'contact', 'office', 'admin', 'leasing', 'rentals', 'sales', 'support', 'inquiries', 'reception', 'maintenance'];

export function classifyEmail(email: string): ContactKind {
  const local = email.slice(0, email.indexOf('@'));
  const base = local.split('+')[0]!;
  if (ROLE_LOCAL_PARTS.has(base)) return 'role';
  if (base.split(/[._-]/).some((part) => ROLE_LOCAL_PARTS.has(part))) return 'role';
  return ROLE_AFFIXES.some((w) => base.startsWith(w) || base.endsWith(w)) ? 'role' : 'personal';
}

export function emailOnDomain(email: string, companyDomain: string): boolean {
  return sameSite(email.slice(email.indexOf('@') + 1), companyDomain);
}

/** Splits "mailto:a@x.com,b@y.com?subject=..." into raw addresses. */
export function parseMailto(href: string): string[] {
  let body = href.replace(/^mailto:/i, '').split('?')[0] ?? '';
  try {
    body = decodeURIComponent(body);
  } catch {
    /* keep raw */
  }
  return body
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Cloudflare scheme: first byte is the XOR key for the remaining bytes. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex) || hex.length > 600) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out.includes('@') ? out : null;
}

export function findOptOuts(text: string): OptOutFinding[] {
  const found: OptOutFinding[] = [];
  for (const [phrase, re] of OPT_OUT_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const i = m.index;
      found.push({ phrase, context: text.slice(Math.max(0, i - 150), i + m[0].length + 150) });
    }
  }
  return found;
}

function candidateLinks($: CheerioAPI, pageUrl: URL): URL[] {
  const scored = new Map<string, { url: URL; score: number }>();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || /^(mailto|tel|javascript|data):/i.test(href) || href.startsWith('#')) return;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !sameSite(url.hostname, pageUrl.hostname)) return;
    if (NON_HTML_LINK.test(url.pathname)) return;
    url.hash = '';
    if (url.href === pageUrl.href) return;

    const haystack = `${decodeSafe(url.pathname)} ${squash($(el).text())}`;
    let score = 0;
    for (const [re, pts] of LINK_KEYWORDS) if (re.test(haystack)) score = Math.max(score, pts);
    if (score === 0) return;
    score -= Math.min(url.pathname.split('/').filter(Boolean).length, 5); // prefer shallow pages
    const prev = scored.get(url.href);
    if (!prev || prev.score < score) scored.set(url.href, { url, score });
  });
  return [...scored.values()].sort((a, b) => b.score - a.score).map((s) => s.url);
}

/** Below this many visible characters a homepage is treated as a JavaScript-rendered shell. */
const JS_SHELL_MAX_TEXT = 200;
const EMPTY_APP_ROOT = /<div[^>]+id=["'](?:root|app|__next|__nuxt|___gatsby)["'][^>]*>\s*<\/div>/i;

/** True when the HTML is an empty app shell whose content only appears after JavaScript runs. */
export function looksJsRendered(html: string): boolean {
  return EMPTY_APP_ROOT.test(html) || htmlToText(html).length < JS_SHELL_MAX_TEXT;
}

/** Visible page text (no scripts/styles/hidden nodes), whitespace-collapsed. */
export function htmlToText(html: string): string {
  return visibleText(cheerio.load(html));
}

function visibleText($: CheerioAPI): string {
  const $body = $('body').clone(); // cheerio.load always synthesizes <body>
  $body.find('script, style, noscript, template, svg, [hidden], [aria-hidden="true"]').remove();
  // Insert separators so adjacent elements don't glue words into fake emails, e.g.
  // <span>Email</span><a>info@x.ca</a> (span styled as block) -> "Emailinfo@x.ca".
  $body
    .find('br, p, div, li, td, th, h1, h2, h3, h4, h5, h6, section, footer, header, address, span, a, label, strong, b, em, small')
    .after(' ');
  return squash($body.text());
}

function blockText($: CheerioAPI, el: AnyNode): string {
  const $el = $(el);
  const block = $el.closest('p, li, td, address, div, section, footer');
  return squash((block.length ? block : $el).first().text());
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
