export const COMPANY_STATUSES = ['new', 'crawled', 'no_contacts', 'opted_out', 'crawl_failed'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export type CompanySource = 'google_places' | 'manual';

export interface Company {
  id: number;
  name: string | null;
  domain: string;
  website_url: string;
  address: string | null;
  phone: string | null;
  source: CompanySource;
  google_place_id: string | null;
  discovery_query: string | null;
  status: CompanyStatus;
  status_reason: string | null;
  crawl_attempts: number;
  crawled_at: string | null;
  created_at: string;
  updated_at: string;
  qualification: Qualification | null;
  qualification_source: 'llm' | 'manual' | null;
  qualification_reason: string | null;
}

export const QUALIFICATIONS = ['qualified', 'disqualified', 'needs_review'] as const;
export type Qualification = (typeof QUALIFICATIONS)[number];

export const SEGMENTS = [
  'residential_rental',
  'condo',
  'commercial',
  'short_term_rental',
  'hoa_coop',
  'student_housing',
  'other',
] as const;
export type Segment = (typeof SEGMENTS)[number];

export const SERVICES = [
  'junk_removal',
  'moving_help',
  'moving_with_truck',
  'residential_cleaning',
  'commercial_cleaning',
  'airbnb_turnover_cleaning',
] as const;
export type Service = (typeof SERVICES)[number];

export type TriState = 'yes' | 'no' | 'unsure';

export type ContactKind = 'role' | 'personal';
export type ExtractionMethod = 'mailto' | 'text' | 'cfemail' | 'manual';

export interface Contact {
  id: number;
  company_id: number;
  email: string;
  kind: ContactKind;
  on_company_domain: 0 | 1;
  method: ExtractionMethod;
  context: string | null;
  source_page_id: number;
  first_seen_at: string;
}

export interface Page {
  id: number;
  company_id: number;
  url: string;
  final_url: string;
  http_status: number | null;
  snapshot_path: string | null;
  sha256: string | null;
  fetched_at: string;
  capture: 'crawler' | 'manual';
  note: string | null;
}
