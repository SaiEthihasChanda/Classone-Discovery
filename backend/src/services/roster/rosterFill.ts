/**
 * Step 5 — fill what is missing on promoted leads: email, title, department,
 * phone, lab website, ORCID.
 *
 * Cheapest source first. ORCID's public record (free, one call) gives a
 * visible email for a minority, a website for many and the current role for
 * most. Then the scraper: institute profile page, lab site and the author
 * block of open-access papers (`enrichLeadFromWeb`) — page fetches, so it
 * runs only for leads still missing something after ORCID, and only when the
 * service is up. The roster member is kept in step with the lead.
 */
import { getOrcidEmployments, getOrcidPerson } from '../../integrations/orcidClient.js';
import { isScraperAvailable } from '../../integrations/scraperServiceClient.js';
import { repositories, where, type Filter } from '../../repositories/index.js';
import type { FacultyMember, Lead } from '../../types/domain.js';
import { keyContains } from '../../utils/normalize.js';
import type { JobContext } from '../jobs/jobRunner.js';
import { instKey } from '../leads/affiliationService.js';
import { enrichLeadFromWeb, type WebEnrichmentDeps } from '../leads/webEnrichment.js';
import { backfillLeadFromGemini, type GeminiBackfillDeps } from '../ai/geminiBackfillProvider.js';
import { classifyRole } from './roles.js';

export interface RosterFillOptions {
  ids?: string[];
  /** Restrict to members discovered at these institutes — bounds the pass when the pipeline runs one institute at a time. */
  institutionIds?: string[];
  /** Also read institute/lab pages and OA papers via the scraper. Default true. */
  useScraper?: boolean;
  /**
   * Also ask Gemini to web-search anything still missing after ORCID and the
   * scraper. Default false — unlike the above, this costs real money once past
   * Google's free monthly search allowance, so per the standing rule ("ask
   * before any run that costs credits"), it is opt-in only.
   */
  useGeminiBackfill?: boolean;
  limit?: number;
}

export interface RosterFillDeps extends WebEnrichmentDeps, GeminiBackfillDeps {
  orcidPerson?: typeof getOrcidPerson;
  orcidEmployments?: typeof getOrcidEmployments;
  scraperUp?: typeof isScraperAvailable;
}

export interface RosterFillSummary {
  considered: number;
  complete: number;
  filledFromOrcid: number;
  filledFromWeb: number;
  filledFromGemini: number;
  stillMissingEmail: number;
  scraperUsed: boolean;
}

export const FILLABLE = ['email', 'title', 'department', 'phone', 'websiteUrl'] as const;
export type Fillable = (typeof FILLABLE)[number];

/** Which of the fillable fields a lead lacks. */
export function missingFields(lead: Lead): Fillable[] {
  const out: Fillable[] = [];
  if (!lead.person.email) out.push('email');
  if (!lead.person.title) out.push('title');
  if (!lead.institution.department) out.push('department');
  if (!lead.person.phone) out.push('phone');
  if (!lead.person.websiteUrl) out.push('websiteUrl');
  return out;
}

function isPersonalSite(url: string): boolean {
  return !/orcid\.org|openalex\.org|scholar\.google|researchgate|linkedin|twitter|x\.com|facebook|publons|scopus|semanticscholar/i.test(url);
}

/** ORCID's person + employment sections applied to a lead's gaps. Free. */
export async function fillFromOrcid(
  lead: Lead,
  deps: Pick<RosterFillDeps, 'orcidPerson' | 'orcidEmployments'> = {},
): Promise<{ lead: Lead; filled: Fillable[] }> {
  if (!lead.person.orcid) return { lead, filled: [] };
  const person = await (deps.orcidPerson ?? getOrcidPerson)(lead.person.orcid).catch(() => null);
  const record = await (deps.orcidEmployments ?? getOrcidEmployments)(lead.person.orcid).catch(() => null);

  const patch: Record<string, Record<string, unknown>> = { person: {}, institution: {} };
  const filled: Fillable[] = [];

  if (!lead.person.email && person?.emails[0]) {
    patch.person!.email = person.emails[0];
    filled.push('email');
  }
  const site = person?.urls.find((u) => isPersonalSite(u.url))?.url;
  if (!lead.person.websiteUrl && site) {
    patch.person!.websiteUrl = site;
    filled.push('websiteUrl');
  }

  // The employment at the lead's current institute, for title and department.
  const key = instKey(lead.institution.name);
  const here = record?.employments.find((e) => {
    if (!e.current) return false;
    const k = instKey(e.organization);
    return Boolean(key && k && (k === key || keyContains(k, key) || keyContains(key, k)));
  });
  if (here) {
    if (!lead.person.title && here.role && classifyRole(here.role).category !== 'excluded') {
      patch.person!.title = here.role;
      filled.push('title');
    }
    if (!lead.institution.department && here.department) {
      patch.institution!.department = here.department;
      filled.push('department');
    }
  }

  if (filled.length === 0) return { lead, filled };
  const updated = await repositories.leads.updateById(lead.id, patch as Partial<Lead>);
  return { lead: updated ?? lead, filled };
}

/**
 * Roster fields a promoted lead does not have yet (only blanks are filled — a value a person entered
 * on the lead is never overwritten). Pure, so the one-off sync and the fill stage share it.
 */
export function rosterFieldsForLead(member: FacultyMember, lead: Lead): { patch: Record<string, unknown>; fields: string[] } {
  const person: Record<string, string> = {};
  for (const k of ['email', 'title', 'phone', 'websiteUrl', 'profileUrl'] as const) {
    const v = member.person[k];
    if (v && !lead.person[k]) person[k] = v;
  }
  const patch: Record<string, unknown> = {};
  const fields = Object.keys(person);
  if (fields.length) patch.person = person;
  const dept = member.department.name ?? member.institution.department;
  if (dept && !lead.institution.department) {
    patch.institution = { department: dept };
    fields.push('department');
  }
  return { patch, fields };
}

export async function fillRoster(options: RosterFillOptions, ctx: JobContext, deps: RosterFillDeps = {}): Promise<RosterFillSummary> {
  const useScraper = options.useScraper ?? true;
  const scraperUp = useScraper ? await (deps.scraperUp ?? isScraperAvailable)() : false;
  if (useScraper && !scraperUp) ctx.log('Scraper service is not running — only ORCID will be consulted', 'warn');

  const filter: Filter = [where.eq('status', 'promoted')];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  if (options.institutionIds?.length) filter.push(where.in('institution.discoveredOpenAlexId', options.institutionIds));
  const members = await repositories.faculty.find({ filter, options: { limit: options.limit ?? 100_000, sort: { 'relevance.score': -1 } } });

  const summary: RosterFillSummary = {
    considered: 0,
    complete: 0,
    filledFromOrcid: 0,
    filledFromWeb: 0,
    filledFromGemini: 0,
    stillMissingEmail: 0,
    scraperUsed: scraperUp,
  };

  for (const [i, member] of members.entries()) {
    ctx.checkpoint();
    if (i % 5 === 0) ctx.setStage(`filling ${i + 1}/${members.length}`, i / Math.max(1, members.length));
    if (!member.leadId) continue;
    let lead = await repositories.leads.findById(member.leadId);
    if (!lead) continue;
    summary.considered += 1;

    // The roster may have learned contact details after promotion (a later build read a faculty
    // page, Vidwan or ORCID): copy anything the lead is still missing before looking further afield.
    const fromRoster = rosterFieldsForLead(member, lead);
    if (fromRoster.fields.length > 0) {
      lead = (await repositories.leads.updateById(lead.id, fromRoster.patch as Partial<Lead>)) ?? lead;
      ctx.log(`${lead.person.name}: copied ${fromRoster.fields.join(', ')} from the roster`);
    }

    if (missingFields(lead).length === 0) {
      summary.complete += 1;
      ctx.log(`${lead.person.name}: already complete — skipped`);
      continue;
    }
    ctx.log(`${lead.person.name}: missing ${missingFields(lead).join(', ')}${lead.person.orcid ? ' — checking ORCID' : ' — no ORCID to check'}`);

    const fromOrcid = await fillFromOrcid(lead, deps);
    lead = fromOrcid.lead;
    if (fromOrcid.filled.length > 0) {
      summary.filledFromOrcid += 1;
      ctx.log(`${lead.person.name}: ORCID filled ${fromOrcid.filled.join(', ')}`);
    } else if (lead.person.orcid) {
      ctx.log(`${lead.person.name}: ORCID had nothing new to add`);
    }

    if (scraperUp && missingFields(lead).length > 0) {
      ctx.log(`${lead.person.name}: still missing ${missingFields(lead).join(', ')} — trying the scraper (institute page, lab site, OA papers)`);
      try {
        const result = await enrichLeadFromWeb(lead.id, deps);
        lead = result.lead;
        if (result.filled.length > 0) {
          summary.filledFromWeb += 1;
          ctx.log(`${lead.person.name}: web filled ${result.filled.join(', ')}`);
        } else {
          ctx.log(`${lead.person.name}: the scraper found nothing new`);
        }
      } catch (error) {
        ctx.log(`${lead.person.name}: web enrichment failed — ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
    }

    if (options.useGeminiBackfill && missingFields(lead).length > 0) {
      ctx.log(`${lead.person.name}: still missing ${missingFields(lead).join(', ')} — asking Gemini to web-search it`);
      try {
        const result = await backfillLeadFromGemini(lead.id, deps);
        lead = result.lead;
        if (result.filled.length > 0) {
          summary.filledFromGemini += 1;
          ctx.log(`${lead.person.name}: Gemini backfill filled ${result.filled.join(', ')}`);
        } else {
          ctx.log(`${lead.person.name}: Gemini backfill found nothing new`);
        }
      } catch (error) {
        ctx.log(`${lead.person.name}: Gemini backfill failed — ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
    }

    // Mirror onto the roster member.
    await repositories.faculty.updateById(member.id, {
      person: {
        ...(member.person.email ? {} : { email: lead.person.email }),
        ...(member.person.title ? {} : { title: lead.person.title }),
        ...(member.person.phone ? {} : { phone: lead.person.phone }),
        ...(member.person.websiteUrl ? {} : { websiteUrl: lead.person.websiteUrl }),
        ...(member.person.profileUrl ? {} : { profileUrl: lead.person.profileUrl }),
      },
      department: member.department.name ? {} : { name: lead.institution.department },
      research: { instruments: lead.research.instruments },
    });

    if (!lead.person.email) summary.stillMissingEmail += 1;
    const stillMissing = missingFields(lead);
    if (stillMissing.length === 0) {
      summary.complete += 1;
      ctx.log(`${lead.person.name}: complete after fill`);
    } else {
      ctx.log(`${lead.person.name}: still missing ${stillMissing.join(', ')} after ORCID${scraperUp ? ' and the scraper' : ''}`);
    }
    ctx.set('considered', summary.considered);
    ctx.set('complete', summary.complete);
    ctx.set('stillMissingEmail', summary.stillMissingEmail);
  }
  return summary;
}
