# Lead Generation Pipeline

A local command-line tool that finds property-management companies in Ontario, collects contact emails **only from
their own public websites**, qualifies each company with a **local LLM**, writes short personalised email drafts,
and lets a person approve every draft before anything is sent.

Sending is **test-only**: approved drafts are delivered to your own inbox, clearly labelled, so you can see exactly
what a company would receive. Real outreach is intentionally not implemented.

## How it works

1. **Discover**: searches the Google Places API (Text Search) for property managers in a city and de-duplicates
   them by website domain.
2. **Crawl**: visits each company's own website politely (robots.txt, honest bot User-Agent, per-site rate limit)
   and saves an HTML snapshot of every page it reads.
3. **Extract**: collects published emails (mailto links, visible text, Cloudflare-protected links), drops
   placeholder and irrelevant mailboxes (careers@, privacy@, noreply@ ...), and excludes companies whose site says
   they don't accept unsolicited email.
4. **Qualify**: a local LLM (Ollama) reads the saved pages and returns structured JSON; deterministic rules decide
   the outcome (ready to email / needs review / not a fit).
5. **Draft**: a fixed, compliant email template; the LLM writes only a one-sentence personalised opening line,
   which is automatically checked and replaced by a standard sentence if it fails.
6. **Approve**: a person approves, edits or rejects each draft. Approval is blocked if the email would break the
   rules.
7. **Test-send**: approved drafts are sent through the Gmail API to your own test inbox only.

## Design principles

- **Evidence for every contact.** Each email is stored with the page it was found on and a saved copy of that page.
- **The AI proposes, rules decide.** The model can never be the source of an email address; names and titles must
  appear word for word on the page; property types are kept only if the company's own pages mention them.
- **Polite, honest crawling.** robots.txt (RFC 9309) is honoured, the crawler identifies itself, and sites that
  block bots are never retried with a disguised identity.
- **Anti-spam rules built in.** Written with Canada's Anti-Spam Legislation (CASL) in mind: sender identification,
  mailing address and an unsubscribe line are required before a draft can be approved.
- **Safe by default.** Only test mode exists; the recipient is forced to your own address and checked again
  immediately before every send.
- **Runs locally.** Data stays in a local SQLite database; the LLM runs on your own machine.

## Tech stack

TypeScript (Node.js 22+), SQLite (better-sqlite3), cheerio, robots-parser, Playwright (headless-browser fallback),
Ollama (local LLM), zod, Google Places API (New), Gmail API with OAuth 2.0 + PKCE, @inquirer/prompts, node:test.

## Requirements

- Node.js 22 or newer
- [Ollama](https://ollama.com) with a model such as `qwen3:8b` (a GPU is recommended)
- A Google Cloud project with **Places API (New)** enabled and an API key (for discovery)
- Optional, for test sending: a Google account with the **Gmail API** enabled (see below)

## Getting started

```sh
git clone https://github.com/cleobnvntra/lead-generation-pipeline.git
cd lead-generation-pipeline
npm install
npx playwright install chromium        # headless browser for JavaScript-built websites

cp .env.example .env                   # then add your Google Places API key and email settings
cp brand.example.json brand.json       # then add your business details
```

Install Ollama and the model:

```sh
# Windows (PowerShell)
irm https://ollama.com/install.ps1 | iex
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

ollama pull qwen3:8b
```

Then:

```sh
npm test        # all tests run offline
npm start       # opens the interactive menu
```

## Configuration

**`.env`** (see `.env.example` for every option):

| Setting | Purpose |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Google Places API key, used by discovery only |
| `PLACES_MAX_REQUESTS_PER_RUN/DAY/MONTH` | App-side limits on billable Places requests |
| `CRAWL_USER_AGENT`, `CRAWL_DELAY_MS`, `CRAWL_CONCURRENCY` | Crawler identity, per-site delay, parallel sites |
| `CRAWL_BROWSER_FALLBACK` | Retry JavaScript-only sites in headless Chromium |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Local LLM connection and model |
| `SEND_MODE` | Only `test` is accepted |
| `EMAIL_FROM`, `TEST_RECIPIENT` | Sending account, and the inbox that receives all test emails |
| `TEST_SEND_MAX_PER_DAY` | Daily cap on test emails |

**`brand.json`**: business name, phone, website, email signature, mailing address, and the list of services you
offer (`offeredServices`). Drafts only ever mention offered services. Until `mailingAddress` is set, drafts show a
`[MAILING ADDRESS]` placeholder.

## Usage

### Interactive menu

```sh
npm start
```

Use the arrow keys and Enter:

- **Find new leads in a city**: search, check websites and run the AI review in one step
- **Review companies that need a decision**: one at a time, with "open their website" and yes / no
- **Email drafts**: write drafts, approve / edit / reject them, and send approved drafts as test emails
- **Browse leads** / **Look up a company**: lists and full details (emails, where they were found, saved pages)
- **Add a company or email by hand**: for sites you checked yourself
- **Overview** and **More tools**: totals, re-checks, re-running the AI, CSV export, Gmail connection

### Commands

```sh
npm run cli -- help                               # list every command
npm run cli -- run --city "Hamilton" --pages 1    # discover + crawl + qualify
npm run cli -- discover --city "Toronto"          # Google Places search only
npm run cli -- crawl --limit 25                   # check pending websites
npm run cli -- qualify                            # AI review of crawled companies
npm run cli -- decide 12 qualified --reason "Checked manually"
npm run cli -- contact add 7 info@acme.ca --source https://acme.ca/contact
npm run cli -- draft                              # write drafts for ready companies
npm run cli -- drafts approve 12                  # approve after checks
npm run cli -- gmail connect                      # one-time Gmail sign-in
npm run cli -- send-test --limit 1                # send one approved draft to TEST_RECIPIENT
npm run cli -- leads --csv leads.csv              # export
```

## Test sending with Gmail

1. In Google Cloud, enable the **Gmail API** and configure the OAuth consent screen (Internal if you use Google
   Workspace). Request only the `gmail.send` scope.
2. Create an OAuth client of type **Desktop app** and save its JSON as `data/google-oauth-client.json`.
3. Run `npm run cli -- gmail connect` and sign in as `EMAIL_FROM`. Any other account is refused.

Each test email has `[TEST → company address]` in the subject and a note at the top, goes only to
`TEST_RECIPIENT`, and is logged. Test sends never mark a company as contacted.

## Google Places costs

Requests that include a business's website are billed as **Text Search Enterprise** (Google's free monthly
allowance applies, then pay per request). The app records every request before sending it and enforces per-run,
per-day and per-month limits; identical searches within 30 days are skipped. Setting a daily quota in the Google
Cloud console is recommended as well.

## Data

Everything is stored locally in `data/` (git-ignored): the SQLite database, saved page snapshots, CSV exports and
the Gmail sign-in token. Back it up if the saved pages matter to you; they are the record of where each contact
was published.

## Project structure

```
src/
  cli.ts             command router (no command = interactive menu)
  menu/              interactive menu flows
  config/            .env and brand.json validation, constants
  db/                SQLite connection and migrations
  models/            data access (companies, evidence, qualifications, drafts, sends, quota ledger)
  controllers/       discover, crawl, qualify, draft/approve, send, pipeline
  services/places/   Google Places client
  services/crawler/  polite fetcher, browser fallback, HTML extraction, snapshots
  services/llm/      LLM provider interface + Ollama implementation
  services/qualify/  qualification prompt, output schema, guardrails
  services/draft/    email template, opening-line checks, approval rules
  services/gmail/    OAuth sign-in, message building, Gmail API client
  views/             terminal rendering, plain-language labels, CSV export
test/                unit tests (node:test, fakes for the LLM and Gmail)
```

## Limitations

- Real sending is not implemented; only test sends to your own inbox.
- Built for property managers in Ontario, Canada; the prompts, segments and compliance checks reflect that.
- Not legal advice: check the anti-spam rules that apply to you before contacting anyone.
