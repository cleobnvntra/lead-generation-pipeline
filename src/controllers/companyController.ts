import type { Db } from '../db/connection.ts';
import { NON_COMPANY_DOMAINS } from '../config/constants.ts';
import { normalizeWebsiteUrl, registrableDomain } from '../lib/domain.ts';
import { ValidationError } from '../lib/errors.ts';
import { CompanyModel, type UpsertResult } from '../models/companyModel.ts';
import { EvidenceModel } from '../models/evidenceModel.ts';
import { QualificationModel, type QualificationRow } from '../models/qualificationModel.ts';
import type { Company, CompanyStatus, Contact, Page, Qualification } from '../models/types.ts';

/** Manually seed a company by website (no API needed). */
export function addCompany(db: Db, website: string, name?: string): UpsertResult {
  const url = normalizeWebsiteUrl(website);
  const domain = registrableDomain(url.hostname);
  if (domain && NON_COMPANY_DOMAINS.has(domain)) {
    throw new ValidationError(`${domain} is a social/directory site, not a company website.`);
  }
  return new CompanyModel(db).addIfNew({ website: url.origin, name: name ?? null, source: 'manual' });
}

export interface LeadRow {
  company: Company;
  contacts: (Contact & { source_url: string })[];
  qualification: QualificationRow | undefined;
}

export function listLeads(
  db: Db,
  filter: { status?: CompanyStatus; qualification?: Qualification },
  limit: number,
): LeadRow[] {
  const companies = new CompanyModel(db).list(filter, limit);
  const evidence = new EvidenceModel(db);
  const quals = new QualificationModel(db);
  return companies.map((company) => ({
    company,
    contacts: evidence.contactsFor(company.id),
    qualification: quals.latestFor(company.id),
  }));
}

export interface CompanyDetails {
  company: Company;
  contacts: (Contact & { source_url: string })[];
  pages: Page[];
  optOuts: { phrase: string; context: string; url: string }[];
  history: QualificationRow[];
}

export function getCompanyDetails(db: Db, companyId: number): CompanyDetails {
  const company = new CompanyModel(db).getById(companyId);
  if (!company) throw new ValidationError(`Company #${companyId} not found`);
  const evidence = new EvidenceModel(db);
  return {
    company,
    contacts: evidence.contactsFor(companyId),
    pages: evidence.pagesFor(companyId),
    optOuts: evidence.optOutsFor(companyId),
    history: new QualificationModel(db).historyFor(companyId),
  };
}

export function searchCompanies(db: Db, term: string, limit = 20): Company[] {
  return new CompanyModel(db).search(term, limit);
}

export function statusCounts(db: Db): { status: Record<string, number>; qualification: Record<string, number> } {
  return { status: new CompanyModel(db).countByStatus(), qualification: new QualificationModel(db).counts() };
}
