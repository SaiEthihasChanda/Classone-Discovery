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
import type { Lead } from '../../types/domain.js';
import type { JobContext } from '../jobs/jobRunner.js';
import { instKey } from '../leads/affiliationService.js';
import { enrichLeadFromWeb, type WebEnrichmentDeps } from '../leads/webEnrichment.js';
import { classifyRole } from './roles.js';

export interface RosterFillOptions {
  ids?: string[];
  /** Also read institute/lab pages and OA papers via the scraper. Default true. */
  useScraper?: boolean;
  limit?: number;
}

export interface RosterFillDeps extends WebEnrichmentDeps {
  orcidPerson?: typeof getOrcidPerson;
  orcidEmployments?: typeof getOrcidEmployments;
  scraperUp?: typeof isScraperAvailable;
}

export interface RosterFillSummary {
  considered: number;
  complete: number;
  filledFromOrcid: number;
  filledFromWeb: number;
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
    return Boolean(key && k && (k === key || k.includes(key) || key.includes(k)));
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

export async function fillRoster(options: RosterFillOptions, ctx: JobContext, deps: RosterFillDeps = {}): Promise<RosterFillSummary> {
  const useScraper = options.useScraper ?? true;
  const scraperUp = useScraper ? await (deps.scraperUp ?? isScraperAvailable)() : false;
  if (useScraper && !scraperUp) ctx.log('Scraper service is not running — only ORCID will be consulted', 'warn');

  const filter: Filter = [where.eq('status', 'promoted')];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  const members = await repositories.faculty.find({ filter, options: { limit: options.limit ?? 100_000, sort: { 'relevance.score': -1 } } });

  const summary: RosterFillSummary = { considered: 0, complete: 0, filledFromOrcid: 0, filledFromWeb: 0, stillMissingEmail: 0, scraperUsed: scraperUp };

  for (const [i, member] of members.entries()) {
    ctx.checkpoint();
    if (i % 5 === 0) ctx.setStage(`filling ${i + 1}/${members.length}`, i / Math.max(1, members.length));
    if (!member.leadId) continue;
    let lead = await repositories.leads.findById(member.leadId);
    if (!lead) continue;
    summary.considered += 1;

    if (missingFields(lead).length === 0) {
      summary.complete += 1;
      continue;
    }

    const fromOrcid = await fillFromOrcid(lead, deps);
    lead = fromOrcid.lead;
    if (fromOrcid.filled.length > 0) {
      summary.filledFromOrcid += 1;
      ctx.log(`${lead.person.name}: ORCID filled ${fromOrcid.filled.join(', ')}`);
    }

    if (scraperUp && missingFields(lead).length > 0) {
      try {
        const result = await enrichLeadFromWeb(lead.id, deps);
        lead = result.lead;
        if (result.filled.length > 0) {
          summary.filledFromWeb += 1;
          ctx.log(`${lead.person.name}: web filled ${result.filled.join(', ')}`);
        }
      } catch (error) {
        ctx.log(`${lead.person.name}: web enrichment failed — ${error instanceof Error ? error.message : String(error)}`, 'warn');
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
    if (missingFields(lead).length === 0) summary.complete += 1;
    ctx.set('considered', summary.considered);
    ctx.set('complete', summary.complete);
    ctx.set('stillMissingEmail', summary.stillMissingEmail);
  }
  return summary;
}
