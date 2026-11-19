import type Database from 'better-sqlite3';

/** Append-only. Never edit a migration that has shipped; add a new one. */
const MIGRATIONS: readonly string[] = [
  /* 1: initial schema */ `
  CREATE TABLE companies (
    id              INTEGER PRIMARY KEY,
    name            TEXT,
    domain          TEXT NOT NULL UNIQUE,          -- registrable domain, dedupe key
    website_url     TEXT NOT NULL,
    address         TEXT,
    phone           TEXT,
    source          TEXT NOT NULL CHECK (source IN ('google_places', 'manual')),
    google_place_id TEXT UNIQUE,
    discovery_query TEXT,
    status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'crawled', 'no_contacts', 'opted_out', 'crawl_failed')),
    status_reason   TEXT,
    crawl_attempts  INTEGER NOT NULL DEFAULT 0,
    crawled_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_companies_status ON companies(status);

  -- Every fetched page is kept as evidence of where a contact was published.
  CREATE TABLE pages (
    id            INTEGER PRIMARY KEY,
    company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    url           TEXT NOT NULL,
    final_url     TEXT NOT NULL,
    http_status   INTEGER NOT NULL,
    snapshot_path TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    fetched_at    TEXT NOT NULL,
    UNIQUE (company_id, url)
  );

  CREATE TABLE contacts (
    id                INTEGER PRIMARY KEY,
    company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email             TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('role', 'personal')),
    on_company_domain INTEGER NOT NULL CHECK (on_company_domain IN (0, 1)),
    method            TEXT NOT NULL CHECK (method IN ('mailto', 'text', 'cfemail')),
    context           TEXT,                        -- text surrounding the address on the page
    source_page_id    INTEGER NOT NULL REFERENCES pages(id),
    first_seen_at     TEXT NOT NULL,
    UNIQUE (company_id, email)
  );

  -- CASL s.10(9)(b): a published address does not imply consent if the page says it refuses unsolicited messages.
  CREATE TABLE optout_findings (
    id         INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    page_id    INTEGER NOT NULL REFERENCES pages(id),
    phrase     TEXT NOT NULL,
    context    TEXT NOT NULL,
    UNIQUE (page_id, phrase)
  );

  -- Every billable Places request, for quota enforcement and query caching.
  CREATE TABLE places_requests (
    id           INTEGER PRIMARY KEY,
    query        TEXT NOT NULL,
    page_number  INTEGER NOT NULL,
    http_status  INTEGER,
    result_count INTEGER,
    requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_places_requests_time ON places_requests(requested_at);
  CREATE INDEX idx_places_requests_query ON places_requests(query);
  `,
  /* 2: qualification (stage 4) */ `
  ALTER TABLE companies ADD COLUMN qualification TEXT
    CHECK (qualification IN ('qualified', 'disqualified', 'needs_review'));
  ALTER TABLE companies ADD COLUMN qualification_source TEXT CHECK (qualification_source IN ('llm', 'manual'));
  ALTER TABLE companies ADD COLUMN qualification_reason TEXT;
  CREATE INDEX idx_companies_qualification ON companies(qualification);

  -- Full history of model verdicts; the latest row per company is current.
  CREATE TABLE qualifications (
    id                  INTEGER PRIMARY KEY,
    company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    decision            TEXT NOT NULL CHECK (decision IN ('qualified', 'disqualified', 'needs_review')),
    decision_reason     TEXT NOT NULL,
    is_property_manager TEXT NOT NULL CHECK (is_property_manager IN ('yes', 'no', 'unsure')),
    serves_ontario      TEXT NOT NULL CHECK (serves_ontario IN ('yes', 'no', 'unsure')),
    segments            TEXT NOT NULL,             -- JSON array
    services_fit        TEXT NOT NULL,             -- JSON array
    best_contact_id     INTEGER REFERENCES contacts(id),
    contact_name        TEXT,
    contact_title       TEXT,
    summary             TEXT NOT NULL,
    model_reason        TEXT NOT NULL,
    notes               TEXT,                      -- guardrail corrections applied to model output
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    prompt_version      INTEGER NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_qualifications_company ON qualifications(company_id, id);
  `,
  /* 3: manually entered contacts. SQLite can't alter CHECKs, so pages/contacts are rebuilt. */ `
  CREATE TABLE pages_new (
    id            INTEGER PRIMARY KEY,
    company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    url           TEXT NOT NULL,
    final_url     TEXT NOT NULL,
    http_status   INTEGER,                        -- NULL for manual sources
    snapshot_path TEXT,                           -- NULL when no snapshot was saved
    sha256        TEXT,
    fetched_at    TEXT NOT NULL,                  -- for manual sources: when it was recorded
    capture       TEXT NOT NULL DEFAULT 'crawler' CHECK (capture IN ('crawler', 'manual')),
    note          TEXT,
    UNIQUE (company_id, url)
  );
  INSERT INTO pages_new (id, company_id, url, final_url, http_status, snapshot_path, sha256, fetched_at)
    SELECT id, company_id, url, final_url, http_status, snapshot_path, sha256, fetched_at FROM pages;
  DROP TABLE pages;
  ALTER TABLE pages_new RENAME TO pages;

  CREATE TABLE contacts_new (
    id                INTEGER PRIMARY KEY,
    company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email             TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('role', 'personal')),
    on_company_domain INTEGER NOT NULL CHECK (on_company_domain IN (0, 1)),
    method            TEXT NOT NULL CHECK (method IN ('mailto', 'text', 'cfemail', 'manual')),
    context           TEXT,
    source_page_id    INTEGER NOT NULL REFERENCES pages(id),
    first_seen_at     TEXT NOT NULL,
    UNIQUE (company_id, email)
  );
  INSERT INTO contacts_new SELECT * FROM contacts;
  DROP TABLE contacts;
  ALTER TABLE contacts_new RENAME TO contacts;
  `,
  /* 4: email drafts (stage 5). One current draft per company. */ `
  CREATE TABLE drafts (
    id             INTEGER PRIMARY KEY,
    company_id     INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
    contact_id     INTEGER NOT NULL REFERENCES contacts(id),
    to_email       TEXT NOT NULL,                 -- the real contact; test mode redirects at send time
    subject        TEXT NOT NULL,
    body           TEXT NOT NULL,                 -- plain text
    services       TEXT NOT NULL,                 -- JSON array of offered services mentioned
    opener_source  TEXT NOT NULL CHECK (opener_source IN ('llm', 'fallback')),
    status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
    notes          TEXT,                          -- guardrail corrections
    model          TEXT,
    prompt_version INTEGER NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_drafts_status ON drafts(status);
  `,
  /* 5: draft approval (stage 6) */ `
  ALTER TABLE drafts ADD COLUMN edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)); -- 1 = changed by a person
  ALTER TABLE drafts ADD COLUMN approved_at TEXT;
  ALTER TABLE drafts ADD COLUMN rejected_reason TEXT;
  `,
  /* 6: send log (stage 7). Only 'test' mode exists: sent_to is always the owner's test inbox. */ `
  CREATE TABLE sends (
    id               INTEGER PRIMARY KEY,
    draft_id         INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    mode             TEXT NOT NULL CHECK (mode IN ('test')),
    sent_to          TEXT NOT NULL,              -- where it actually went
    intended_to      TEXT NOT NULL,              -- the company contact it was written for (NOT emailed)
    subject          TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'blocked')),
    gmail_message_id TEXT,
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_sends_created ON sends(created_at);
  CREATE INDEX idx_sends_draft ON sends(draft_id);
  `,
];

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this app (v${MIGRATIONS.length}). Update the app.`);
  }
  if (current === MIGRATIONS.length) return;

  // Table rebuilds require FK enforcement off; it can't be toggled inside a transaction.
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]!);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) throw new Error(`Migration ${v + 1} left ${broken.length} broken foreign key(s)`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
