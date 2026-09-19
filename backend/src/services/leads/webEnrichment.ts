/**
 * Enriches one lead from the open web: profile page, ORCID, lab site, papers.
 *
 * Discovery produces a scored name at an institute. This turns it into a
 * contactable, correctly-pitched lead:
 *
 *   - the institute profile page → email, designation, department, phone
 *   - ORCID's public record → the lab website, current role
 *   - the lab website's facilities/instruments pages → what the group owns
 *   - open-access copies of their recent papers → the Methods section, for
 *     instruments OpenAlex has no full text of
 *
 * The scraper service does the fetching and returns sentences that mention
 * any of the brand/model terms we asked about; this module decides what those
 * sentences mean, with the SAME detector the discovery run uses, so a device
 * found on a lab page and one found in a paper are recorded identically.
 *
 * Fills only gaps: an email or title a human has entered is never overwritten.
 * Every dependency is injectable so the whole flow is testable with no
 * network, no scraper and no OpenAlex.
 */
import { repositories } from '../../repositories/index.js';
import { ApiError } from '../../middleware/errorHandler.js';
import {
  enrichLeadViaScraper,
  extractPaperSnippets,
  isScraperAvailable,
  type EnrichLeadResponse,
  type PaperTextResponse,
} from '../../integrations/scraperServiceClient.js';
import { getOpenAccessLocation, type OpenAccessLocation } from '../../integrations/openAlexClient.js';
import type { Lead, LeadInstrument } from '../../types/domain.js';
import { normalizeInstitutionKey } from '../../utils/normalize.js';
import { logActivity } from '../activity/activityService.js';
import { detectInstrumentsInText, mergeInstruments } from '../discovery/instrumentDetector.js';
import { brandSearchTerms, modelsToIdentify } from '../discovery/keywords.js';
import { getSettings, type AppSettings } from '../settings/settingsService.js';

export interface WebEnrichmentDeps {
  scrapeLead?: typeof enrichLeadViaScraper;
  readPapers?: typeof extractPaperSnippets;
  resolveOpenAccess?: typeof getOpenAccessLocation;
  scraperUp?: typeof isScraperAvailable;
}

export interface WebEnrichmentResult {
  lead: Lead;
  /** Fields this pass filled in (not ones that were already set). */
  filled: Array<'email' | 'title' | 'department' | 'phone' | 'websiteUrl'>;
  /** Set when the institute directory was actually read. */
  affiliation?: { directoryListed: boolean };
  profileUrl?: string;
  websites: string[];
  /** Instruments this pass found, before merging with what was already known. */
  instrumentsFound: LeadInstrument[];
  papers: { considered: number; openAccess: number; read: number };
  pagesVisited: number;
  errors: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An institute profile URL is one we scraped; an OpenAlex author URL is not a page about them. */
function institutePageUrl(lead: Lead): string | undefined {
  const url = lead.person.profileUrl;
  if (!url || /openalex\.org|orcid\.org/i.test(url)) return undefined;
  return url;
}

/** Faculty directory pages configured for this lead's institute. */
function directoryUrlsFor(lead: Lead, settings: AppSettings): string[] {
  const key = normalizeInstitutionKey(lead.institution.name);
  if (!key) return [];
  return settings.facultyTargets
    .filter((t) => t.enabled)
    .filter((t) => {
      const tk = normalizeInstitutionKey(t.universityName);
      return Boolean(tk && (tk === key || tk.includes(key) || key.includes(tk)));
    })
    .map((t) => t.url);
}

/** Every brand alias and model name, so the scraper returns any sentence naming one. */
function instrumentTerms(settings: AppSettings): string[] {
  const terms = new Set<string>();
  for (const brand of settings.discovery.instrumentBrands) {
    if (!brand.enabled) continue;
    for (const t of brandSearchTerms(brand)) terms.add(t.replace(/\s*\([^)]*\)\s*/g, ' ').trim());
    for (const m of modelsToIdentify(brand)) terms.add(m.model);
  }
  return [...terms].filter((t) => t.length >= 3);
}

export async function enrichLeadFromWeb(
  leadId: string,
  deps: WebEnrichmentDeps = {},
): Promise<WebEnrichmentResult> {
  const scrapeLead = deps.scrapeLead ?? enrichLeadViaScraper;
  const readPapers = deps.readPapers ?? extractPaperSnippets;
  const resolveOpenAccess = deps.resolveOpenAccess ?? getOpenAccessLocation;
  const scraperUp = deps.scraperUp ?? isScraperAvailable;

  const lead = await repositories.leads.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead');

  if (!(await scraperUp())) {
    throw new ApiError(
      503,
      'The scraper service is not running. Start it (scraper-service, port 8000) and try again — ' +
        'web enrichment reads institute and lab pages, which only that service is allowed to fetch.',
    );
  }

  const settings = await getSettings();
  const scraping = settings.scraping;
  const brands = settings.discovery.instrumentBrands.filter((b) => b.enabled);
  const terms = instrumentTerms(settings);
  const errors: string[] = [];
  const filled: WebEnrichmentResult['filled'] = [];
  const found: LeadInstrument[] = [];

  // --- 1 + 2. Profile page, ORCID, lab website ----------------------------
  let profile: EnrichLeadResponse | null = null;
  try {
    profile = await scrapeLead({
      name: lead.person.name,
      institutionName: lead.institution.name,
      orcid: lead.person.orcid,
      profileUrl: institutePageUrl(lead),
      directoryUrls: directoryUrlsFor(lead, settings),
      instrumentTerms: terms,
      options: {
        maxPages: scraping.maxEnrichmentPagesPerLead,
        followLabSites: scraping.enrichFromLabSites,
        useOrcid: true,
        allowBrowser: scraping.allowBrowser,
      },
    });
    for (const e of profile.errors) errors.push(`${e.target}: ${e.reason}${e.detail ? ` (${e.detail})` : ''}`);
  } catch (error) {
    errors.push(`Profile/lab lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (profile) {
    for (const snippet of profile.snippets) {
      const hits = detectInstrumentsInText(snippet.text, brands, snippet.url).map((i) => ({
        ...i,
        evidence: `${/facilit|instrument|equipment/i.test(snippet.url) ? 'Lab facilities page' : 'Web page'}: “${snippet.text.slice(0, 220)}”`,
      }));
      found.push(...hits);
    }
  }

  // --- 3. Open-access papers → Methods section ----------------------------
  const papers = { considered: 0, openAccess: 0, read: 0 };
  if (scraping.readOpenAccessPapers) {
    const candidates = lead.research.recentPublications
      .filter((p) => p.sourceId)
      .slice(0, scraping.maxPapersPerLead);
    papers.considered = candidates.length;

    const locations: Array<OpenAccessLocation & { fallbackTitle: string }> = [];
    for (const p of candidates) {
      const loc = await resolveOpenAccess(p.sourceId!);
      if (loc?.isOpenAccess && (loc.pdfUrl || loc.landingPageUrl)) {
        locations.push({ ...loc, fallbackTitle: p.title });
      }
    }
    papers.openAccess = locations.length;

    if (locations.length > 0) {
      let response: PaperTextResponse | null = null;
      try {
        response = await readPapers({
          papers: locations.map((l) => ({
            id: l.workId,
            // A PDF is the whole paper; a landing page is often abstract-only.
            url: (l.pdfUrl ?? l.landingPageUrl)!,
            title: l.title ?? l.fallbackTitle,
          })),
          instrumentTerms: terms,
        });
      } catch (error) {
        errors.push(`Paper reading failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (response) {
        for (const e of response.errors) errors.push(`${e.target}: ${e.reason}${e.detail ? ` (${e.detail})` : ''}`);
        papers.read = response.results.length;
        for (const r of response.results) {
          const title = locations.find((l) => l.workId === r.id)?.title ?? r.id;
          for (const text of r.snippets) {
            const hits = detectInstrumentsInText(text, brands, r.url).map((i) => ({
              ...i,
              evidence: `Methods of “${title}”: “${text.slice(0, 220)}”`,
            }));
            found.push(...hits);
          }
        }
      }
    }
  }

  // --- Write back: fill gaps only ------------------------------------------
  const person: Record<string, unknown> = {};
  const institution: Record<string, unknown> = {};

  const email = profile?.email?.toLowerCase();
  if (!lead.person.email && email && EMAIL_RE.test(email)) {
    person.email = email;
    filled.push('email');
  }
  if (!lead.person.title && profile?.designation) {
    person.title = profile.designation;
    filled.push('title');
  }
  if (!lead.person.phone && profile?.phone) {
    person.phone = profile.phone;
    filled.push('phone');
  }
  if (!lead.institution.department && profile?.department) {
    institution.department = profile.department;
    filled.push('department');
  }
  const website = profile?.websites[0];
  if (!lead.person.websiteUrl && website) {
    person.websiteUrl = website;
    filled.push('websiteUrl');
  }
  // Prefer the institute's own page as the profile link over an OpenAlex URL,
  // which is where the sales team actually wants to land.
  if (profile?.profile_url && !institutePageUrl(lead)) {
    person.profileUrl = profile.profile_url;
  }

  const instruments = mergeInstruments(found, lead.research.instruments);

  // The directory is the most current affiliation signal there is: an
  // institute lists its people today, not as of their last paper. Listed →
  // confirmed current. Dropped → recorded on the lead; the OpenAlex status is
  // not overridden on that alone (directories fail to parse often), but a
  // reviewer sees it and the CSV carries it.
  const affiliationNote: WebEnrichmentResult['affiliation'] = profile?.directory_checked
    ? { directoryListed: Boolean(profile.directory_listed) }
    : undefined;
  if (profile?.directory_checked) {
    const prior = lead.institution.affiliation;
    institution.affiliation = profile.directory_listed
      ? {
          status: 'current',
          verifiedAt: new Date(),
          source: 'directory',
          lastSeenYear: prior?.lastSeenYear,
          directoryListed: true,
          note: 'Listed in the institute faculty directory.',
        }
      : {
          ...(prior ?? { status: 'unverified', verifiedAt: new Date(), source: 'openalex' }),
          directoryListed: false,
          note: `Not found in the institute faculty directory${prior?.note ? `. ${prior.note}` : '.'}`,
        };
  }

  const updated =
    (await repositories.leads.updateById(lead.id, {
      ...(Object.keys(person).length > 0 ? { person } : {}),
      ...(Object.keys(institution).length > 0 ? { institution } : {}),
      research: { instruments, webEnrichedAt: new Date() },
    })) ?? lead;

  const summary = [
    filled.length > 0 ? `filled ${filled.join(', ')}` : null,
    found.length > 0 ? `instruments: ${[...new Set(found.map((i) => i.model ?? i.brand))].join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  await logActivity({
    type: 'lead_discovered',
    message: `Web enrichment — ${lead.person.name}: ${summary || 'nothing new found'}`,
    relatedLeadId: lead.id,
    metadata: { webEnrichment: true, pagesVisited: profile?.pages_visited.length ?? 0, papersRead: papers.read },
  });

  return {
    lead: updated,
    filled,
    affiliation: affiliationNote,
    profileUrl: profile?.profile_url ?? undefined,
    websites: profile?.websites ?? [],
    instrumentsFound: found,
    papers,
    pagesVisited: profile?.pages_visited.length ?? 0,
    errors,
  };
}

/**
 * Enriches several leads, one after another — the scraper's per-domain delay
 * means parallelism would buy nothing against a single institute anyway.
 */
export async function enrichLeadsFromWeb(
  leadIds: string[],
  deps: WebEnrichmentDeps = {},
): Promise<Array<{ leadId: string; name?: string; result?: WebEnrichmentResult; error?: string }>> {
  const out: Array<{ leadId: string; name?: string; result?: WebEnrichmentResult; error?: string }> = [];
  for (const id of leadIds) {
    try {
      const result = await enrichLeadFromWeb(id, deps);
      out.push({ leadId: id, name: result.lead.person.name, result });
    } catch (error) {
      out.push({ leadId: id, error: error instanceof Error ? error.message : String(error) });
      // A missing scraper fails every lead the same way; stop after the first.
      if (error instanceof ApiError && error.status === 503) break;
    }
  }
  return out;
}
