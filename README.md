# Class One Systems — AI Sales Automation Platform

Discovers research-sector leads from public sources, scores and qualifies them with AI, keeps
them in one CRM, drafts personalised outreach referencing each researcher's own published work,
and never lets a follow-up get forgotten.

**Status: Phase 2 complete** — CRM foundation plus live lead discovery from four sources, AI
scoring, and a human review queue. Email outreach and follow-ups arrive in Phases 3-4 (see
[Roadmap](#roadmap)).

---

## Architecture

```
frontend/          React + Vite SPA                      :5173
backend/           Node + Express + TypeScript            :4000   ← API, data layer, AI, email, scheduling
scraper-service/   Python + FastAPI                       :8000   ← stateless fetch + extract only
docs/              architecture notes, scrape-targets.yaml
```

Three services, no Docker. The split is deliberate:

- **Node owns everything stateful** — the database, OpenAI calls, email, cron. It shares a
  language with the frontend and with Firebase Cloud Functions, the eventual deployment target.
- **Python does only what it is better at** — scraping faculty pages and university news with
  BeautifulSoup and Playwright. It holds no database connection and makes no AI calls, which
  keeps it stateless and replaceable.
- **MongoDB now, Firestore later.** Every database call goes through
  [`backend/src/repositories/`](backend/src/repositories/), whose query surface is restricted to
  what Mongo and Firestore can *both* do — no joins, no transactions, no aggregation pipelines.
  Migrating means writing `repositories/firestore/` and flipping one env var.

---

## Quick start

### 1. Prerequisites

Node 18+, Python 3.10+. This machine has Node 24 and Python 3.12 — both fine.

### 2. Get a database (MongoDB Atlas, free)

1. Sign up at [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register).
2. **Create a cluster** → choose the **M0 free tier** → pick a region near you → Create.
3. **Create a database user**: Security → Database Access → Add New Database User. Choose
   password auth, pick a username and a strong password, **write the password down** — it goes
   into the connection string.
4. **Allow your IP**: Security → Network Access → Add IP Address → "Add My Current IP Address".
   *(An unreachable-database error on first run is almost always this step.)*
5. **Copy the connection string**: Cluster → Connect → Drivers → Node.js. It looks like
   `mongodb+srv://user:<db_password>@cluster0.xxxxx.mongodb.net/...`. Replace `<db_password>`
   with the real password from step 3.

### 3. Configure

```bash
cp .env.example .env
```

Open `.env` and set `MONGO_URI` to the string from step 2. Everything else has a working default;
`OPENAI_API_KEY` is not needed until Phase 2.

All three services read this one file at the repo root.

### 4. Install

```bash
npm install                # root (concurrently)
npm run install:all        # backend + frontend

cd scraper-service
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # macOS/Linux
```

### 5. Seed the product catalog

```bash
npm run seed:catalog
```

Loads Class One's product line (potentiostats, biosensor kits, spectroelectrochemistry systems,
SDKs). This is what grounds the AI — without it, "which product suits this researcher" has
nothing real to point at. Re-runnable; it upserts rather than duplicating.

### 6. Run

Two terminals:

```bash
# Terminal 1 — local MongoDB + backend + frontend together
npm run dev

# Terminal 2 — scraper service (separate runtime, so its own terminal)
cd scraper-service
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Then open **http://localhost:5173**.

| What | Where |
|---|---|
| App | http://localhost:5173 |
| API health | http://localhost:4000/api/health |
| Scraper health | http://localhost:8000/health |
| Scraper API docs | http://localhost:8000/docs |

`npm run dev` starts the local MongoDB (`.mongo-data/`), waits for it, then the API and the Vite
dev server. To wipe the local database and re-seed the catalog: `npm run db:reset` (refuses to
run against anything that is not `localhost`; restart the backend afterwards so settings re-seed).

---

## Verifying it works

```bash
npm run smoke              # backend: 35 checks, offline and deterministic
npm run typecheck          # backend + frontend
```

`npm run smoke` spins up an in-memory MongoDB, boots the real Express app, and drives the real
HTTP API — no mocks below the network boundary. It covers CRUD, dedupe, validation, the review
gate, nested-patch merging, catalog upsert, dashboard counts, and the whole discovery pipeline
(with stubbed sources so it stays deterministic and free). Needs no Atlas account and no `.env`.

```bash
cd scraper-service
.venv\Scripts\python.exe scripts/smoke_test.py     # scraper: 7 checks
```

Checks the robots.txt gate and rate limiter — the safety mechanisms every scraper sits behind.
The three live-network checks report SKIP rather than FAIL if the network is unavailable, so a
connectivity blip does not look like a logic bug.

### Live checks (hit real external services)

```bash
cd backend
npm run probe:sources      # is each data source healthy, and what does it return?
npm run smoke:live         # full discovery run against real APIs, into a throwaway DB
```

`probe:sources` is the first thing to run when discovery returns fewer leads than expected — it
separates "the API changed or is down" from "our filters are too narrow". `smoke:live` runs the
real pipeline end to end and prints what landed. Neither touches your Atlas data, and both are
free unless `OPENAI_API_KEY` is set.

---

## Discovery (Phase 2)

**Discovery is targeted at Indian institutions of national importance — the IITs, NITs and
IIITs.** Targeting is enforced through OpenAlex institution ids, not name matching, so results
are exact.

> **OpenAlex is no longer unlimited-free.** Measured from its live response
> headers: **1,000 credits / $0.10 per day**, with a filtered query costing
> **10 credits** — roughly 100 queries a day, resetting at midnight UTC. Exceeding
> it returns HTTP 429. The app tracks the remaining balance from every response,
> shows it on the Discovery page, and stops early with a clear message rather
> than silently leaving leads unscored. Paid plans: <https://openalex.org/pricing>.

| Source | How | Notes |
|---|---|---|
| **OpenAlex** | Public API, no key | Primary source. Recent papers in Class One's domain, filtered server-side to the target institutions. Subject to the daily credit allowance above. |
| **Faculty pages** | Scraped via the Python service | Only pages verified reachable by an honest crawler. Follows profile links to recover email addresses. |
| **University news / RSS** | Scraped, feed-first | An engagement signal, not a lead source — names in articles get matched to existing leads. |
| **NIH RePORTER** | Public API, no key | US-funded PIs. Excluded from India-targeted runs. |
| **NSF Award Search** | Public API, no key | US-funded PIs, returns emails directly. Excluded from India-targeted runs. |

Plus **"feed a name"**: type a researcher's name and the engine finds, scores and adds them.

### Institution targeting

`backend/src/data/indianInstitutions.ts` holds **72 institutions** with verified OpenAlex ids:

- **23 IITs** — all of them
- **28 NITs** — of 31; Mizoram, Puducherry and Uttarakhand have no separate OpenAlex entry
- **21 IIITs** — of roughly 25; the rest have little or no indexed research output

Ids rather than names, because `"IIT Bombay"` and `"Indian Institute of Technology Bombay"` are
the same place and name matching would both miss records and over-match unrelated institutes.
Filtering happens server-side at OpenAlex, so irrelevant records are never downloaded.

The Discovery page has a single **institute multi-select**: leave it empty to search all 72, or
pick any number to restrict both the OpenAlex filter and the faculty/news scrape targets to
those places. (The API still accepts `region: 'india' | 'global'` for a wider search; the UI
does not offer it, since Class One sells into Indian institutes.) NIH and NSF fund US institutions almost
exclusively, so they are dropped automatically from any India-targeted run — India's own funders
(SERB, DST, CSIR) publish no comparable public API.

**A caveat worth knowing about scraping.** Of 22 Indian faculty pages probed, only **3** were
both reachable and parseable — Indian institute sites frequently return HTTP errors to
non-browser clients, sit behind WAFs (403), or render directories with JavaScript. We do not
spoof a browser User-Agent to get around any of that, so blocked targets are dropped rather than
worked around. Every target in `docs/scrape-targets.yaml` was probed before being enabled, and
failures are left in the file (disabled, with reasons) so nobody re-tries them blindly.

This is precisely why OpenAlex carries the weight: it indexes every one of these institutions
properly and will not block or break.

**Email recovery.** Indian faculty index pages almost never publish addresses, which would leave
leads uncontactable. The scraper therefore follows each profile link (bounded, rate-limited) and
picks the researcher's own address, rejecting role accounts like `registrar@` and
`hodchemistry@` — emailing a front desk is worse than having no address, because it looks like a
real contact in the CRM. On NIT Rourkela and NIT Karnataka this recovers 9 of 10 addresses.

### OpenAlex credits — what a run costs and how to get more

OpenAlex bills by call type (Sept 2026 pricing): **a search call costs 10 credits, a
filter-only call 1, a single-record lookup 0**, and page size makes no difference. Discovery
is built around that:

| Search | How | Cost |
|---|---|---|
| Research topics (always on) | `primary_topic.id` filter on curated OpenAlex topic groups (`backend/src/data/openAlexTopics.ts`) | **1 credit per group**, 6 groups |
| Keyword phrases | five quoted phrases OR-ed per `title_and_abstract.search` call | 10 credits per five phrases |
| Instrument brands | one full-text `search` per brand | 10 credits per brand |
| Name lookups | `/authors?search=` | ~10 credits per name |

A default run is about **346 credits** (6 + 270 + 70) plus up to 570 for model identification; the Discovery page shows the exact figure
next to the Run button and the balance left today. Every call asks for OpenAlex's maximum page
of 200 works, which costs exactly the same as asking for one, and **no cap is applied to how
many candidates a run produces** — the cost driver is the number of calls, not results.
Identical requests are served from a 24-hour cache in MongoDB (`openalex_cache`) at no cost, so
re-runs and tests are free.

When the allowance runs out the run **fails loudly**: a run that gets nothing from OpenAlex
returns HTTP 429 with a clear message; a run that gets part-way returns its partial results
flagged `openAlexExhausted`, and the page shows a red banner and a single collapsed warning
instead of one line per skipped query.

To get more credits: the free tier without a key is 1,000 credits ($0.10) a day. A **free
OpenAlex API key** (sign up at openalex.org, no payment method) raises that to **$1.00 a day —
10,000 credits**; set `OPENALEX_API_KEY` in `.env`. Beyond that, prepaid usage can be added in
$1 increments on [openalex.org/pricing](https://openalex.org/pricing) and is only drawn down
after the daily free budget is spent.

### Search keywords — derived, not hand-typed

Nobody maintains a keyword list any more. `backend/src/services/discovery/keywords.ts` computes
it from five sources, so adding a product on classonesystems.in (then `npm run catalog:export`)
widens discovery on its own:

| Source | From | Searched as |
|---|---|---|
| Subject terms | `data/websiteKeywords.ts` — the techniques and topics the site is about | title + abstract |
| Application areas | each catalog product's `applicationAreas` | title + abstract |
| Product keywords | each product's `tags`, as stored in the website's Firestore | title + abstract |
| Our product names | model identifiers parsed out of catalog product names | **full text** |
| Brand names | ours and competitors', from `data/instrumentBrands.ts` | **full text** |

Roughly 134 distinct phrases reach the title/abstract search; model and brand names are carried
by the full-text brand search instead, so they are never paid for twice. Settings shows every
group with its phrases and lets a group be switched off, plus an "additional keywords" box for a
one-off term.

**Competitors are searched by company name only.** We do not sell their range and should not be
guessing model numbers to find them. Which instrument a researcher actually uses is established
by a second, model-level pass: for every brand that turned up users, one full-text query per
known model (`"EmStat Pico"`, `Gamry "Interface 1010"`, `CHI660E OR "CHI 660E"` — both
spellings, since papers use both). Our models come from the catalog; competitors' from a
reference list in `data/instrumentBrands.ts`. This is what turns "PalmSens" into "Sensit Smart"
on a lead and in the CSV. It costs 10 credits per model queried (up to ~570 per run, but brands
nobody uses skip theirs) and can be switched off under Settings → Instruments & brands.

**Why a device can still be missed, and what covers it.** A run is institute-scoped and works
outward from queries, so it sees the paper or two of a person's that ranked. Three things widen
that: brand and model queries page through up to 1,000 works (not just the first 200); the
model lists include legacy instruments (PalmSens3, PGSTAT30, CHI 660C) that are still on
benches; and the lead page has **Scan all papers for instruments**, which asks OpenAlex about
that one researcher's whole recent output, brand by brand then model by model
(`POST /api/leads/:id/scan-instruments`, typically 130–400 credits). The look-back window for
all of this is a setting (default 7 years).

### Per-lead web enrichment (scraper service)

Discovery gives a scored name at an institute; this turns it into a contactable, correctly
pitched lead. **Enrich from web** on a lead (or *Enrich this page from web* on the CRM list)
asks the scraper service to read, in order:

1. the institute's faculty directory (from the configured scrape targets) → the person's own
   profile page → **email, designation, department, phone**, links to a lab site;
2. ORCID's public record → the **lab / personal website** and current role;
3. that lab site's home page and its *facilities / instruments / equipment* pages → **what the
   group owns**, by brand and model;
4. open-access copies of the lead's recent papers (located with OpenAlex's free single-record
   lookups, fetched as PDF or HTML) → the **Methods section**, for instruments OpenAlex has no
   full text of.

The scraper returns sentences mentioning any brand or model term; Node runs the same instrument
detector the discovery run uses over them, so a device found on a lab page and one found in a
paper are recorded identically, each with its source URL. Fields are filled only where blank —
a title or email a human entered is never overwritten. No OpenAlex credits are spent; the cost
is page fetches, paced by the per-domain delay (roughly 20–40 s per lead). Needs the scraper
service running:

```bash
cd scraper-service
.venvScriptspython.exe -m uvicorn app.main:app --reload --port 8000
```

Endpoints: `POST /scrape/enrich-lead` and `POST /scrape/paper-text` on the scraper;
`POST /api/leads/:id/enrich-web` and `POST /api/leads/enrich-web-bulk` on the API. Budgets
(pages per lead, papers per lead) are under *Settings → Scraping behaviour*. An offline test
that exercises both scraper endpoints against a local fixture site:
`scraper-service/scripts/enrich_fixture_test.py`.

### Product catalog — synced from the website

The CRM's product catalog is the website's live catalogue: 86 products across Sensing,
Energy (CorrTest, TOB), Nano Technology and Accessories, exported from the website repo's
Firestore into `backend/src/data/websiteCatalog.json` plus the four SDKs. `catalogData.ts`
adds what the website does not record — CRM category, research application areas, SDK
support and cleaned search tags — and the seed retires anything no longer in the list.

To refresh after the website catalogue changes (needs the website repo checked out with its
`serviceAccountKey.json`):

```bash
npm run catalog:export            # reads Firestore, rewrites websiteCatalog.json
npm run seed:catalog              # loads it into MongoDB
```

### Instruments in use (PalmSens, CorrTest and competitors)

Discovery also finds out **what potentiostat a researcher already runs**. Two mechanisms,
configured under *Settings → Search keywords → Instrument & brand keywords*
(seeded from `backend/src/data/instrumentBrands.ts`):

- **Full-text brand search.** Instrument names live in methods sections, which abstracts almost
  never repeat, so each enabled brand gets one OpenAlex `search` query (which covers full text
  where OpenAlex has it). One query per brand keeps every hit attributable. Default set: PalmSens
  and CorrTest (Class One's lines), plus Autolab/Metrohm, Gamry, BioLogic, CH Instruments and
  Admiral Instruments — 7 queries, 70 credits per run. Ivium, PAR/AMETEK, Zahner, Pine and
  Solartron are detection-only by default. Toggle per run on the Discovery page.
- **Model detection in text.** Free regexes over titles and abstracts pull the exact model when
  named — "CHI 660E", "PGSTAT302N", "EmStat4S", "Squidstat Plus".

Sightings are stored on the lead (`research.instruments`) with the evidence and paper link, and
shown on the lead page and review queue **only when something was found**. Scoring treats a
competitor unit as a proven buyer of the category and a PalmSens/CorrTest as an existing user.

Search-term rules learned the hard way: quote multi-word names (`"CH Instruments"`), never use a
bare hyphen (`Bio-Logic` is parsed as an operator), and avoid brand names that stem to English
words (`BioLogic` → "biological", 228k hits — use phrases like `"Bio Logic"`, `"EC Lab"`).

### Fetch escalation (static → browser → proxy)

Pages are fetched cheaply first and escalate only when the result is unusable — judged by
**outcome**, not status code, because a JavaScript-rendered directory returns HTTP 200 with no
people in it, indistinguishable from an empty page.

1. **Static HTTP** — fast, low memory, handles most sites
2. **Real browser (Playwright)** — renders client-side directories; also carries a real TLS
   fingerprint
3. **Browser via proxy** — for IP-reputation blocks; needs credentials in `.env`
   (`SCRAPER_PROXY_URL`, `..._USERNAME`, `..._PASSWORD`)

Measured, so expectations stay calibrated: a browser User-Agent alone unlocked **1 of 12**
blocked sites, and a real browser unlocked **2** (IIT Indore MEMS went 0 → 13 people; MIT News
403 → 200). The remaining 403s returned byte-identical responses to every agent, which means
they key on IP reputation — tier 3 is the only thing that would change them. robots.txt stays a
hard gate at every tier.

Each result reports which tier produced it, so a target quietly costing a browser launch on
every run is visible on the Settings page rather than hidden.

### Scoring works without an OpenAI key

Enrichment goes through a provider interface with two implementations:

- **OpenAI** (`gpt-4o-mini` by default) — used when `OPENAI_API_KEY` is set. Structured JSON
  output, so a malformed response cannot cost a retry.
- **Rule-based scoring** — used automatically when no key is set. **This is not a model**; it is
  a hand-written function that counts weighted keyword hits and matches against your catalog's
  tags. Not a stub either: discovery is fully functional and free before billing is configured.

### Faculty leads get their research record from OpenAlex

Scraping a faculty page yields a name, a title and often an email — but no research evidence, so
the scorer rated those leads near zero. The result was perverse: the only leads you could
actually contact ranked worst.

Each scraped name is now looked up in OpenAlex (disambiguated by institution id, which matters
for common names) and its topics attached. Measured on real scraped people, this discriminates
rather than just inflating:

| Researcher | Before | After | Why |
|---|---|---|---|
| Saikat Dutta | 19 | **82** | supercapacitors, catalysis — a real prospect |
| Shaikh M. Mobin | 19 | **62** | materials/crystallography with electrochemistry |
| Darshak R. Trivedi | 19 | 26 | crystallography — correctly stays low |
| Abanti Sahoo | 19 | 29 | granular flow — correctly stays low |
| Suman Mukhopadhyay | 19 | 23 | drug discovery — correctly stays low |

One OpenAlex call per person, not two: fetching each author's works as well would double the
credit cost and exhaust the daily allowance on a single faculty list.

### Settings page

Everything that governs discovery is editable in the UI at **/settings**, stored in MongoDB:
search keywords, region, per-institution include/exclude across all 72 institutes, scrape
targets (add/edit/enable/remove), and scraping behaviour (browser tier, proxy tier, profile
following).

The YAML and TypeScript files are only **seed defaults** — copied in on first run, after which
the database wins. That ordering is what makes a UI change also govern the scheduled cron run,
which passes no options of its own. "Reset to defaults" restores from the files.

### Cost controls, all enforced in one place

- **Dedupe before enrichment.** Candidates are merged in-batch *and* checked against the
  database before any AI call. The same professor legitimately surfaces from OpenAlex, a grant
  award and a news item in one run — each duplicate removed is an AI call not paid for.
- **Content-hash caching.** Enrichment is keyed on the source publication and grant ids. A
  researcher who resurfaces every week is not re-scored every week; a new paper invalidates it
  immediately, and results expire after 30 days regardless.
- **A per-run budget ceiling** (`OPENAI_RUN_BUDGET_USD`) checked *before* each call, so it
  cannot be overshot by a large final request. Breaching it halts the run and raises a critical
  alert rather than quietly draining the account.

## How the pieces fit

**Lead lifecycle.** A lead enters as `pending_review` — from discovery, manual entry, or a name
lookup — gets AI-scored, and a human approves or rejects it in the **Review Queue**. Nothing
reaches outreach unapproved. That gate is what keeps AI false positives out of real
researchers' inboxes.

**Dedupe** runs on every create, because the same professor legitimately surfaces from OpenAlex,
their faculty page and a news article in a single run. Email is the strong signal; normalised
name + institution is the fallback. Names normalise well ("Dr. Lily Chen", "Chen, Lily" and
"lily chen" all key to `chen lily`). Institution matching is exact-after-noise-removal, so "MIT"
and "Massachusetts Institute of Technology" do *not* match — a known limit, asserted explicitly
in the smoke test, worth revisiting when automated discovery starts.

**Activity log** is append-only with the display string pre-rendered at write time, so the
dashboard feed renders with zero lookups. Bulk discovery logs one run-level entry rather than one
per lead, or the feed would drown.

**Threads and follow-ups** live in one document, since a thread has exactly one follow-up
lifecycle and the scheduler's core query (`status="open" AND nextCheckAt <= now`) then needs no
join.

---

## OpenAI API setup

Not needed until Phase 2, but it can be done now. These are account and billing steps that have
to be done by a human.

1. **Create an account** at [platform.openai.com](https://platform.openai.com). This is separate
   from ChatGPT — a ChatGPT Plus subscription does **not** grant API credit.
2. **Add billing**: Settings → Billing → add a payment method, then add a small starting amount
   ($10-20 is plenty for development).
3. **Set a hard budget limit**: Settings → Billing → Limits. Set a monthly cap and an alert
   threshold (e.g. alert at $20, cap at $50). Do this before generating a key — it is the main
   guard against the proposal's worst-case cost scenario.
4. **Create a project**: Settings → Projects → New Project, e.g. `classone-sales-automation`.
   Scopes usage and keys to this app alone.
5. **Generate a key**: inside that project → API Keys → Create new secret key. **Copy it
   immediately** — it is shown once.
6. **Put it in `.env`** (gitignored, never committed):
   ```
   OPENAI_API_KEY=sk-...
   OPENAI_MODEL_CHEAP=gpt-4o-mini
   OPENAI_MODEL_STRONG=gpt-4o
   ```
7. **Watch spend** at [platform.openai.com/usage](https://platform.openai.com/usage), especially
   the first week after discovery goes live.

New accounts start on a low rate-limit tier that rises automatically with successful payment
history. It will not constrain development.

### Cost control (built into the design)

OpenAI is the dominant cost line — roughly $80-250 of the proposal's $102-345/month at
worst-case volume. Four levers, all planned into Phase 2:

- **Model tiering** — cheap model for classification, scoring, summarisation and reply detection;
  strong model only for first-touch outreach drafts, the one artifact where quality really shows.
- **Batch API** for the weekly enrichment run. It is not latency-sensitive (a human reviews the
  output next day), and batching is ~50% cheaper — halving the dominant line.
- **Summary caching** keyed on `research.contentHash`, so a professor who resurfaces every week
  is not re-summarised every week.
- **A per-run budget ceiling** (`OPENAI_RUN_BUDGET_USD`) that aborts the run and raises a critical
  alert rather than quietly draining the account.

---

## Email testing

Phase 3 sends through **Ethereal** — disposable sandbox inboxes, no signup, and every "sent"
message gets a preview URL. Phase 6 swaps in the real Gmail API behind the same
`EmailProvider` interface, which needs 1-2 throwaway Gmail accounts created by hand (Google
requires phone/CAPTCHA verification that cannot be automated) plus an OAuth2 walkthrough.

---

## Scraping conduct

Enforced in [`scraper-service/app/core/robots.py`](scraper-service/app/core/robots.py), not left
to good intentions:

- robots.txt is a **hard gate** — a disallowed path is never fetched.
- Honest, contactable User-Agent.
- Minimum delay between requests to the same domain, one concurrent request per domain.
- Official APIs and RSS preferred over HTML scraping wherever they exist — which is why grant data
  comes from the NIH RePORTER and NSF Award Search APIs (both verified live, both free, no key)
  instead of scraping government portals.
- Login walls and CAPTCHAs are skipped and logged, never worked around.

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation, data layer, CRM, dashboard, catalog | **Done** |
| 2 | Lead discovery — OpenAlex, NIH/NSF, faculty + news scraping, AI enrichment, review queue | **Done** |
| 3 | Email infrastructure + follow-up automation (Ethereal sandbox) | Next |
| 4 | AI outreach — product/research matching, personalised drafts | |
| 5 | Analytics dashboard build-out | |
| 6 | Real Gmail send/receive | Any time after Phase 3 |

Full plan: `~/.claude/plans/kind-inventing-zebra.md`

---

## Project layout

```
backend/src/
  config/env.ts            all env vars validated once at startup, fails fast
  repositories/            THE Mongo→Firestore seam; base.repository.ts defines the portable query DSL
  models/                  Mongoose schemas (Mongoose appears nowhere else)
  types/domain.ts          plain domain types the app actually speaks
  integrations/            outbound API clients — OpenAlex, NIH/NSF grants, scraper service
  services/ai/             provider interface + OpenAI and heuristic implementations, caching, budget
  services/discovery/      source adapters and the fetch→dedupe→enrich→store orchestrator
  services/leads/          dedupe, normalisation, review transitions
  jobs/scheduler.ts        cron (off by default — set CRON_ENABLED=true)
  routes/                  thin HTTP layer
  scripts/                 seedCatalog, smokeTest, liveSmokeTest, probeSources

scraper-service/app/
  core/robots.py           robots.txt gate (RFC 9309) + per-domain rate limiter
  core/schemas.py          the pydantic contract Node depends on
  scrapers/                static fetcher, faculty extractor, news/RSS extractor
  api/                     health + /scrape/faculty + /scrape/news

frontend/src/
  api/client.ts            single REST client
  features/                dashboard, discovery, review, leads, catalog
  components/common.tsx    badges, states, relative time
```
