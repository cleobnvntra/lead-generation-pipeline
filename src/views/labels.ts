import type { CompanyStatus, ContactKind, ExtractionMethod, Qualification } from '../models/types.ts';

/** Plain-language names for internal states, for people who never see the code. */
export const STATUS_LABEL: Record<CompanyStatus, string> = {
  new: 'Website not checked yet',
  crawled: 'Website checked',
  no_contacts: 'No email found on website',
  opted_out: 'Website says no unsolicited email',
  crawl_failed: "Website couldn't be checked",
};

export const QUALIFICATION_LABEL: Record<Qualification | 'none', string> = {
  qualified: 'Ready to email',
  needs_review: 'Needs your decision',
  disqualified: 'Not a fit',
  none: 'Not reviewed yet',
};

export const SEGMENT_LABEL: Record<string, string> = {
  residential_rental: 'rental homes/apartments',
  condo: 'condos',
  commercial: 'commercial buildings',
  short_term_rental: 'short-term rentals (Airbnb)',
  hoa_coop: 'co-ops / associations',
  student_housing: 'student housing',
  other: 'other',
};

export const SERVICE_LABEL: Record<string, string> = {
  junk_removal: 'junk removal',
  moving_help: 'moving help',
  moving_with_truck: 'moving with truck',
  residential_cleaning: 'residential cleaning',
  commercial_cleaning: 'commercial cleaning',
  airbnb_turnover_cleaning: 'Airbnb turnover cleaning',
};

export const CONTACT_KIND_LABEL: Record<ContactKind, string> = {
  role: 'shared inbox',
  personal: 'person',
};

export const METHOD_LABEL: Record<ExtractionMethod, string> = {
  mailto: 'email link',
  text: 'page text',
  cfemail: 'protected email link',
  manual: 'added by you',
};

/** Turns technical crawl failure reasons into something a non-technical person can act on. */
export function describeCrawlReason(reason: string | null): string | null {
  if (!reason) return null;
  if (/rendered by headless browser/i.test(reason)) return 'needed a full browser to read the site';
  if (/contact added manually/i.test(reason)) return 'email added by you';
  if (/HTTP 403|HTTP 401/i.test(reason)) return 'website blocks automated visits';
  if (/disallowed by robots\.txt/i.test(reason)) return 'website asks bots not to visit';
  if (/robots\.txt unreachable|network error|timed out|TIMEOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|unreachable|SSL|TLS|CERT/i.test(reason)) {
    return "website didn't respond or has a security error";
  }
  if (/HTTP 404|HTTP 410/i.test(reason)) return 'website page not found';
  if (/HTTP 5\d\d/i.test(reason)) return 'website had a server error';
  if (/not HTML/i.test(reason)) return "website address isn't a normal web page";
  if (/site states/i.test(reason)) return `site says: ${reason.replace(/^site states:\s*/i, '')}`;
  if (/browser fallback unavailable/i.test(reason)) return 'site needs a full browser, which is not installed';
  return reason;
}

export function labelList(values: string[], labels: Record<string, string>): string {
  return values.map((v) => labels[v] ?? v).join(', ');
}
