/**
 * Faculty roster — the five-stage pipeline behind the Faculty page.
 *
 *   1. build     ORCID + OpenAlex + faculty pages → roster members
 *   2. verify    still at the institute? (moved / unknown handled)
 *   3. score     relevance from recent output
 *   4. promote   members above the threshold → CRM leads (+ instrument scan)
 *   5. fill      missing email / title / phone / website on promoted leads
 *
 * Every stage that touches an external service runs as a background job and
 * returns its id; the page polls `/jobs/:id`. Estimates are separate GETs so
 * the confirmation dialog can show the cost before anything is spent.
 */
import { Router } from 'express';
import { z } from 'zod';
import { INDIAN_INSTITUTIONS } from '../data/indianInstitutions.js';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { repositories, where, type Filter, type Query } from '../repositories/index.js';
import { cancelJob, getJob, listJobs, startJob, type JobKind } from '../services/jobs/jobRunner.js';
import { DOMAIN_LABELS } from '../services/roster/domains.js';
import { verifyRoster } from '../services/roster/rosterAffiliation.js';
import { buildRoster, importRoster, type ImportRow } from '../services/roster/rosterBuilder.js';
import { fillRoster } from '../services/roster/rosterFill.js';
import { estimateSweepCredits, sweepInstruments } from '../services/roster/rosterSweep.js';
import {
  DEFAULT_PROMOTE_THRESHOLD,
  estimatePromotion,
  estimateScoreCost,
  promoteRoster,
  scoreRoster,
} from '../services/roster/rosterRelevance.js';
import type { FacultyMember } from '../types/domain.js';

export const rosterRouter = Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const listSchema = z.object({
  status: z.enum(['eligible', 'excluded', 'promoted']).optional(),
  domain: z.string().optional(),
  role: z.string().optional(),
  institutionId: z.string().optional(),
  affiliation: z.enum(['current', 'moved', 'unknown', 'unverified']).optional(),
  tag: z.string().optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  scored: z.enum(['yes', 'no']).optional(),
  missing: z.enum(['email', 'title', 'phone', 'websiteUrl']).optional(),
  q: z.string().trim().optional(),
  sort: z.enum(['score', 'name', 'newest']).default('score'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

function buildQuery(params: z.infer<typeof listSchema>): Query {
  const filter: Filter = [];
  if (params.status) filter.push(where.eq('status', params.status));
  if (params.domain) filter.push(where.eq('department.domain', params.domain));
  if (params.role) filter.push(where.eq('role.category', params.role));
  if (params.institutionId) filter.push(where.eq('institution.discoveredOpenAlexId', params.institutionId));
  if (params.affiliation) {
    if (params.affiliation === 'unverified') filter.push(where.in('institution.affiliation.status', ['unverified', null as unknown as string]));
    else filter.push(where.eq('institution.affiliation.status', params.affiliation));
  }
  if (params.tag) filter.push(where.contains('tags', params.tag));
  if (params.minScore !== undefined) filter.push(where.gte('relevance.score', params.minScore));
  if (params.scored === 'yes') filter.push(where.ne('relevance.score', null));
  if (params.scored === 'no') filter.push(where.eq('relevance.score', null));
  if (params.missing) filter.push(where.eq(`person.${params.missing}`, null));

  const sort: Record<string, 1 | -1> =
    params.sort === 'name'
      ? { 'person.name': 1 }
      : params.sort === 'newest'
        ? { createdAt: -1 }
        : { 'relevance.score': -1, 'person.name': 1 };

  return {
    filter,
    ...(params.q ? { search: { term: params.q, fields: ['person.name', 'person.email', 'department.name', 'institution.name'] } } : {}),
    options: { limit: params.limit, skip: (params.page - 1) * params.limit, sort },
  };
}

// GET /api/roster/config — institutes and labels the page needs.
rosterRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({
      institutions: INDIAN_INSTITUTIONS.map((i) => ({ id: i.openAlexId, name: i.name, kind: i.kind })),
      domains: DOMAIN_LABELS,
      defaultThreshold: DEFAULT_PROMOTE_THRESHOLD,
    });
  }),
);

// GET /api/roster/summary
rosterRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    res.json(await repositories.faculty.summary());
  }),
);

// GET /api/roster
rosterRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) throw ApiError.badRequest('Invalid query', parsed.error.flatten());
    const page = await repositories.faculty.findPaginated(buildQuery(parsed.data));
    res.json({ ...page, page: parsed.data.page });
  }),
);

// GET /api/roster/export.csv — the current filter as CSV.
rosterRouter.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse({ ...req.query, page: 1, limit: 500 });
    if (!parsed.success) throw ApiError.badRequest('Invalid query', parsed.error.flatten());
    const query = buildQuery(parsed.data);
    const all: FacultyMember[] = [];
    for (let skip = 0; ; skip += 500) {
      const batch = await repositories.faculty.find({ ...query, options: { ...query.options, limit: 500, skip } });
      all.push(...batch);
      if (batch.length < 500) break;
    }
    const cols: Array<[string, (m: FacultyMember) => unknown]> = [
      ['Name', (m) => m.person.name],
      ['Title', (m) => m.person.title],
      ['Role', (m) => m.role.category],
      ['Department', (m) => m.department.name],
      ['Domain', (m) => DOMAIN_LABELS[m.department.domain]],
      ['Institute', (m) => m.institution.name],
      ['Discovered at', (m) => m.institution.discoveredName],
      ['Affiliation status', (m) => m.institution.affiliation?.status],
      ['Previous institution', (m) => m.institution.affiliation?.previousInstitution],
      ['Email', (m) => m.person.email],
      ['Phone', (m) => m.person.phone],
      ['Website', (m) => m.person.websiteUrl],
      ['Profile', (m) => m.person.profileUrl],
      ['ORCID', (m) => m.person.orcid],
      ['OpenAlex', (m) => m.person.openAlexAuthorId],
      ['Relevance', (m) => m.relevance.score],
      ['Instrument brands', (m) => m.research.instruments.map((i) => i.brand).join('; ')],
      ['Instrument models', (m) => m.research.instruments.map((i) => i.model ?? '').join('; ')],
      ['Sources', (m) => [...new Set(m.sources.map((s) => s.type))].join('; ')],
      ['Status', (m) => m.status],
      ['Tags', (m) => m.tags.join('; ')],
    ];
    const cell = (v: unknown) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map(([h]) => cell(h)).join(','), ...all.map((m) => cols.map(([, f]) => cell(f(m))).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="faculty-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  }),
);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

rosterRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? (req.query.kind as JobKind) : undefined;
    res.json({ jobs: listJobs(kind).map((j) => ({ ...j, log: j.log.slice(-5) })) });
  }),
);

rosterRouter.get(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.id!);
    if (!job) throw ApiError.notFound('Job');
    res.json(job);
  }),
);

rosterRouter.post(
  '/jobs/:id/cancel',
  asyncHandler(async (req, res) => {
    if (!cancelJob(req.params.id!)) throw ApiError.notFound('Running job');
    res.json({ ok: true });
  }),
);

function startOrConflict<T>(kind: JobKind, body: Parameters<typeof startJob<T>>[1]) {
  try {
    return startJob<T>(kind, body);
  } catch (error) {
    throw new ApiError(409, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — build
// ---------------------------------------------------------------------------

const buildSchema = z.object({
  institutionIds: z.array(z.string()).min(1).max(100),
  sources: z.array(z.enum(['orcid', 'openalex', 'faculty_pages', 'vidwan'])).min(1).optional(),
  includeInferredRoles: z.boolean().optional(),
  minWorks: z.number().int().min(1).max(100).optional(),
  maxProbesPerInstitution: z.number().int().min(1).max(80).optional(),
  parallelInstitutions: z.number().int().min(1).max(6).optional(),
});

rosterRouter.post(
  '/build',
  asyncHandler(async (req, res) => {
    const parsed = buildSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const unknown = parsed.data.institutionIds.filter((id) => !INDIAN_INSTITUTIONS.some((i) => i.openAlexId === id));
    if (unknown.length) throw ApiError.badRequest(`Unknown institute ids: ${unknown.join(', ')}`);
    const job = startOrConflict('roster_build', (ctx) => buildRoster(parsed.data, ctx));
    res.status(202).json({ job });
  }),
);

// ---------------------------------------------------------------------------
// Stage 2 — verify
// ---------------------------------------------------------------------------

rosterRouter.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const schema = z.object({ ids: z.array(objectId).optional(), freshDays: z.number().int().min(0).max(365).optional(), limit: z.number().int().min(1).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const job = startOrConflict('roster_verify', (ctx) => verifyRoster(parsed.data, ctx));
    res.status(202).json({ job });
  }),
);

// ---------------------------------------------------------------------------
// Stage 3 — score
// ---------------------------------------------------------------------------

rosterRouter.get(
  '/score/estimate',
  asyncHandler(async (req, res) => {
    res.json(await estimateScoreCost({ rescore: req.query.rescore === 'true' }));
  }),
);

rosterRouter.post(
  '/score',
  asyncHandler(async (req, res) => {
    const schema = z.object({ ids: z.array(objectId).optional(), rescore: z.boolean().optional(), sinceYears: z.number().int().min(1).max(20).optional(), limit: z.number().int().min(1).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const job = startOrConflict('roster_score', (ctx) => scoreRoster(parsed.data, ctx));
    res.status(202).json({ job });
  }),
);

// ---------------------------------------------------------------------------
// Stage 3b — institute-wide instrument sweep
// ---------------------------------------------------------------------------

rosterRouter.get(
  '/sweep/estimate',
  asyncHandler(async (req, res) => {
    const n = Math.max(1, Number(req.query.institutions ?? 1) || 1);
    res.json(await estimateSweepCredits(n));
  }),
);

rosterRouter.post(
  '/sweep',
  asyncHandler(async (req, res) => {
    const schema = z.object({ institutionIds: z.array(z.string()).min(1).max(100), rescore: z.boolean().optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const job = startOrConflict('roster_sweep', (ctx) => sweepInstruments(parsed.data, ctx));
    res.status(202).json({ job });
  }),
);

// ---------------------------------------------------------------------------
// Stage 4 — promote
// ---------------------------------------------------------------------------

rosterRouter.get(
  '/promote/estimate',
  asyncHandler(async (req, res) => {
    const threshold = Number(req.query.threshold ?? DEFAULT_PROMOTE_THRESHOLD);
    res.json(await estimatePromotion(Number.isFinite(threshold) ? threshold : DEFAULT_PROMOTE_THRESHOLD));
  }),
);

rosterRouter.post(
  '/promote',
  asyncHandler(async (req, res) => {
    const schema = z.object({ threshold: z.number().min(0).max(100).optional(), ids: z.array(objectId).optional(), identifyInstruments: z.boolean().optional(), includeInstrumentOwners: z.boolean().optional(), limit: z.number().int().min(1).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const job = startOrConflict('roster_promote', (ctx) => promoteRoster(parsed.data, ctx));
    res.status(202).json({ job });
  }),
);

// ---------------------------------------------------------------------------
// Stage 5 — fill missing info
// ---------------------------------------------------------------------------

rosterRouter.post(
  '/fill',
  asyncHandler(async (req, res) => {
    const schema = z.object({ ids: z.array(objectId).optional(), useScraper: z.boolean().optional(), limit: z.number().int().min(1).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const job = startOrConflict('roster_fill', (ctx) => fillRoster(parsed.data, ctx));
    res.status(202).json({ job });
  }),
);

// ---------------------------------------------------------------------------
// Import (Vidwan/IRINS export or any CSV), manual overrides, wipe
// ---------------------------------------------------------------------------

/** Minimal RFC-4180 parser: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/**
 * Column names accepted, lower-cased, with `_`/`-` read as spaces. The Vidwan
 * search notebook's export (vidwan_id, name, listing_name, designation,
 * institute, department, email, phone, website, profile_url, profile_text)
 * maps without renaming anything.
 */
const HEADER_ALIASES: Record<keyof ImportRow, string[]> = {
  name: ['name', 'expert name', 'faculty name', 'full name', 'listing name'],
  institutionName: ['institution', 'institute', 'organisation', 'organization', 'affiliation', 'university'],
  department: ['department', 'dept', 'school', 'discipline'],
  title: ['title', 'designation', 'position', 'role'],
  email: ['email', 'e-mail', 'mail'],
  orcid: ['orcid', 'orcid id'],
  profileUrl: ['profile', 'profile url', 'url', 'link', 'vidwan url', 'irins url'],
  keywords: ['keywords', 'expertise', 'research interests', 'areas', 'subject', 'search queries'],
  phone: ['phone', 'mobile', 'contact number', 'telephone'],
  websiteUrl: ['website', 'web site', 'homepage', 'lab website'],
  profileText: ['profile text', 'bio', 'about', 'listing card text'],
  sourceId: ['vidwan id', 'irins id', 'id', 'source id'],
};

/** Maps CSV columns to import fields by header name. */
export function rowsFromCsv(text: string): ImportRow[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  // Aliases are in order of preference per field ("profile text" before
  // "listing card text"), so each field takes its best-matching column
  // wherever that column sits in the file.
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[_-]+/g, ' '));
  const idx: Partial<Record<keyof ImportRow, number>> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<[keyof ImportRow, string[]]>) {
    for (const alias of aliases) {
      const i = keys.indexOf(alias);
      if (i !== -1) {
        idx[field] = i;
        break;
      }
    }
  }
  if (idx.name === undefined || idx.institutionName === undefined) return [];
  return body.map((cells) => {
    const get = (f: keyof ImportRow) => (idx[f] === undefined ? undefined : cells[idx[f]!]?.trim() || undefined);
    // The notebook's "name" is the profile's own; "listing_name" is the
    // fallback when the profile page could not be parsed.
    const name = get('name') ?? '';
    return {
      name,
      institutionName: get('institutionName') ?? '',
      department: get('department'),
      title: get('title'),
      email: get('email'),
      orcid: get('orcid'),
      profileUrl: get('profileUrl'),
      keywords: get('keywords'),
      phone: get('phone'),
      websiteUrl: get('websiteUrl'),
      profileText: get('profileText'),
      sourceId: get('sourceId'),
    };
  });
}

// POST /api/roster/import  { csv: "...", source?: "vidwan_import" | "manual" }
rosterRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const schema = z.object({ csv: z.string().min(1).max(10_000_000), source: z.enum(['vidwan_import', 'manual']).default('vidwan_import') });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const rows = rowsFromCsv(parsed.data.csv);
    if (rows.length === 0) {
      throw ApiError.badRequest('No rows found. The CSV needs at least a "Name" and an "Institution" column (Department, Designation, Email, ORCID, Profile URL, Keywords are optional).');
    }
    res.json(await importRoster(rows, parsed.data.source));
  }),
);

// PATCH /api/roster/:id  { status }
rosterRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const schema = z.object({ status: z.enum(['eligible', 'excluded']), reason: z.string().trim().max(200).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const member = await repositories.faculty.findById(req.params.id!);
    if (!member) throw ApiError.notFound('Faculty member');
    if (member.status === 'promoted') throw ApiError.badRequest('Already promoted — reject the lead in the CRM instead.');
    const updated = await repositories.faculty.updateById(
      member.id,
      { status: parsed.data.status, ...(parsed.data.status === 'excluded' ? { exclusionReason: parsed.data.reason ?? 'manual' } : {}) },
      { unset: parsed.data.status === 'eligible' ? ['exclusionReason'] : [] },
    );
    res.json({ member: updated });
  }),
);

// GET /api/roster/:id
rosterRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const member = await repositories.faculty.findById(req.params.id!);
    if (!member) throw ApiError.notFound('Faculty member');
    res.json({ member });
  }),
);

// DELETE /api/roster  { confirm: "WIPE ROSTER" }
rosterRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ confirm: z.literal('WIPE ROSTER') }).safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Send { "confirm": "WIPE ROSTER" } to delete every roster member.');
    const deleted = await repositories.faculty.deleteAll();
    res.json({ deleted });
  }),
);
