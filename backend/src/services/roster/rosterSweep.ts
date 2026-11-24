/**
 * Institute-wide instrument sweep — who at the institute has written up which
 * potentiostat.
 *
 * One full-text query per brand across the whole institute (10 credits a
 * page, a few pages at most), then one per known model for brands that had
 * hits. Every author at the institute on a matching paper is taken, because
 * the instrument belongs to the lab and the PI who bought it is usually
 * listed last. The hits are matched to roster members by OpenAlex author id
 * (then by name), merged into their instruments, and those members are
 * re-scored — owning a potentiostat is the strongest relevance signal there is.
 *
 * This is the same evidence the per-lead scan finds, at a fraction of the
 * cost: the scan asks the same questions once per person (120+ credits each);
 * the sweep asks them once per institute (a few hundred credits in all) and
 * covers everyone on the roster, including those below the promotion bar.
 */
import { repositories, where } from '../../repositories/index.js';
import { INDIAN_INSTITUTIONS } from '../../data/indianInstitutions.js';
import type { FacultyMember } from '../../types/domain.js';
import { confirmedInstruments, mergeInstruments } from '../discovery/instrumentDetector.js';
import { countModelQueries, fetchFromOpenAlex } from '../discovery/sources.js';
import type { DiscoveredCandidate } from '../discovery/types.js';
import type { JobContext } from '../jobs/jobRunner.js';
import { getSettings } from '../settings/settingsService.js';
import { NameIndex } from './names.js';
import { admitInstrumentOwner } from './rosterBuilder.js';
import { scoreRoster } from './rosterRelevance.js';

export interface SweepOptions {
  institutionIds: string[];
  /** Limit the sweep to these brand keys — cuts credits when only Class One and a couple of competitors matter. Default: every enabled brand. */
  brands?: string[];
  /** Re-score members whose instruments changed. Default true. */
  rescore?: boolean;
}

export interface SweepDeps {
  fetchBrands?: typeof fetchFromOpenAlex;
  admit?: typeof admitInstrumentOwner;
}

export interface SweepSummary {
  institutions: Array<{
    id: string;
    name: string;
    authorsSeen: number;
    membersTagged: number;
    notOnRoster: number;
    /** People the sources missed, admitted on the strength of a sighting. */
    admitted: number;
    /** Sighted authors declined (students, postdocs, movers) — name and why. */
    declined: Array<{ name: string; reason: string; brands: string[] }>;
    byBrand: Record<string, number>;
    errors: string[];
    budgetExhausted: boolean;
  }>;
  membersTagged: number;
  classOneOwners: string[];
  rescored: number;
}

/** Cost before running, for the confirmation dialog. */
export async function estimateSweepCredits(institutions: number, brandKeys?: string[]): Promise<{ min: number; max: number; brands: number }> {
  const settings = await getSettings();
  const brands = settings.discovery.instrumentBrands.filter((b) => b.enabled && b.searchEnabled && (!brandKeys?.length || brandKeys.includes(b.key)));
  const models = settings.discovery.identifyModels ? countModelQueries(brands) : 0;
  return { brands: brands.length, min: institutions * brands.length * 10, max: institutions * (brands.length * 5 + models * 2) * 10 };
}

const authorIdOf = (c: DiscoveredCandidate): string | undefined => c.sourceRecordId?.match(/A\d{6,}/)?.[0];

export async function sweepInstruments(options: SweepOptions, ctx: JobContext, deps: SweepDeps = {}): Promise<SweepSummary> {
  const fetchBrands = deps.fetchBrands ?? fetchFromOpenAlex;
  const settings = await getSettings();
  const brands = settings.discovery.instrumentBrands.filter((b) => b.enabled && (!options.brands?.length || options.brands.includes(b.key)));
  const sinceYear = new Date().getFullYear() - (settings.discovery.instrumentLookbackYears ?? 7);

  const summary: SweepSummary = { institutions: [], membersTagged: 0, classOneOwners: [], rescored: 0 };
  const changedIds = new Set<string>();

  for (const [i, id] of options.institutionIds.entries()) {
    ctx.checkpoint();
    const institution = INDIAN_INSTITUTIONS.find((x) => x.openAlexId === id);
    if (!institution) continue;
    const r: SweepSummary['institutions'][number] = { id, name: institution.name, authorsSeen: 0, membersTagged: 0, notOnRoster: 0, admitted: 0, declined: [], byBrand: {}, errors: [], budgetExhausted: false };
    summary.institutions.push(r);
    ctx.setStage(`${institution.name}: brand and model queries`, i / options.institutionIds.length);
    ctx.log(`${institution.name}: querying ${brands.length} brand${brands.length === 1 ? '' : 's'} (${brands.map((b) => b.brand).join(', ')})${settings.discovery.identifyModels ? ' plus known models for brands with hits' : ''}`);

    const result = await fetchBrands([], sinceYear, {
      institutionIds: [id],
      instrumentBrands: brands,
      topicGroups: [],
      identifyModels: settings.discovery.identifyModels,
      instrumentLookbackYears: settings.discovery.instrumentLookbackYears,
    });
    r.errors.push(...result.errors);
    r.budgetExhausted = Boolean(result.budgetExhausted);
    for (const e of result.errors) ctx.log(`${institution.name}: ${e}`, 'warn');

    // Roster members of this institute, indexed by author id and by name.
    const members = await repositories.faculty.find({ filter: [where.eq('institution.discoveredOpenAlexId', id)] });
    const byAuthor = new Map<string, FacultyMember>();
    const byName = new NameIndex<FacultyMember>();
    for (const m of members) {
      if (m.person.openAlexAuthorId) byAuthor.set(m.person.openAlexAuthorId, m);
      byName.add(m.person.name, m);
    }

    // Gather every sighting per member first, then write once.
    const sightings = new Map<string, DiscoveredCandidate['instruments']>();
    const seenAuthors = new Set<string>();
    const unknownAuthors = new Map<string, { name: string; instruments: NonNullable<DiscoveredCandidate['instruments']> }>();
    for (const c of result.candidates) {
      const aid = authorIdOf(c);
      if (aid) seenAuthors.add(aid);
      const member = (aid && byAuthor.get(aid)) || byName.find(c.name);
      if (!member) {
        r.notOnRoster += 1;
        if (aid) {
          const u = unknownAuthors.get(aid) ?? { name: c.name, instruments: [] };
          u.instruments.push(...(c.instruments ?? []));
          unknownAuthors.set(aid, u);
        }
        continue;
      }
      const list = sightings.get(member.id) ?? [];
      list.push(...(c.instruments ?? []));
      sightings.set(member.id, list);
    }
    r.authorsSeen = seenAuthors.size;

    // Authors the roster does not have: a paper naming the instrument admits
    // them if they are faculty (see `admitInstrumentOwner`); students on the
    // same paper are listed, not added. Free lookups only.
    const admit = deps.admit ?? admitInstrumentOwner;
    for (const [aid, u] of unknownAuthors) {
      ctx.checkpoint();
      const brandsSeen = [...new Set(u.instruments.map((x) => (x.model ? `${x.brand} ${x.model}` : x.brand)))];
      // A bare brand name in a paper that does not read as electrochemistry is not enough to admit anyone.
      const confirmed = confirmedInstruments(u.instruments);
      if (confirmed.length === 0) {
        r.declined.push({ name: u.name, reason: 'brand mention needs review (no model, not an electrochemistry paper)', brands: brandsSeen });
        ctx.log(`${u.name}: sighted with ${brandsSeen.join(', ')} only in a paper that does not read as electrochemistry — not admitted`);
        continue;
      }
      try {
        const res = await admit({ authorId: aid, institution: { openAlexId: id, name: institution.name }, instruments: confirmed });
        if (res.admitted && res.member) {
          r.admitted += 1;
          changedIds.add(res.member.id);
          if (u.instruments.some((x) => x.vendor === 'classone') && !summary.classOneOwners.includes(res.member.person.name)) summary.classOneOwners.push(res.member.person.name);
          ctx.log(`ADMITTED ${res.member.person.name} (${res.member.role.category}, ${res.member.department.name ?? res.member.department.domain}) — ${brandsSeen.join(', ')}`);
        } else {
          r.declined.push({ name: res.name ?? u.name, reason: res.reason ?? 'declined', brands: brandsSeen });
          ctx.log(`${res.name ?? u.name}: sighted with ${brandsSeen.join(', ')} but not on the roster — declined (${res.reason ?? 'declined'})`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        r.declined.push({ name: u.name, reason, brands: brandsSeen });
        ctx.log(`${u.name}: sighted with ${brandsSeen.join(', ')}, admit check failed — ${reason}`, 'warn');
      }
    }
    if (r.declined.length > 0) {
      const classOne = r.declined.filter((x) => x.brands.some((b) => /palmsens|corrtest|emstat|sensit/i.test(b)));
      if (classOne.length > 0) ctx.log(`Class One brand sightings not admitted (students/postdocs/movers): ${classOne.map((x) => `${x.name} [${x.reason}]`).join('; ')}`, 'warn');
    }

    for (const [memberId, found] of sightings) {
      const member = members.find((m) => m.id === memberId)!;
      const merged = mergeInstruments(member.research.instruments, found);
      const before = member.research.instruments.map((x) => `${x.brandKey}|${x.model ?? ''}`).sort().join(',');
      const after = merged.map((x) => `${x.brandKey}|${x.model ?? ''}`).sort().join(',');
      for (const brand of new Set(merged.map((x) => x.brand))) r.byBrand[brand] = (r.byBrand[brand] ?? 0) + 1;
      if (merged.some((x) => x.vendor === 'classone') && !summary.classOneOwners.includes(member.person.name)) {
        summary.classOneOwners.push(member.person.name);
      }
      if (after === before) {
        ctx.log(`${member.person.name}: seen again with the same instruments already on record — no change`);
        continue;
      }
      await repositories.faculty.updateById(member.id, { research: { instruments: merged }, tags: [...new Set([...member.tags, 'instruments-swept'])] });
      // A promoted member's lead gets the same sightings.
      if (member.leadId) {
        const lead = await repositories.leads.findById(member.leadId);
        if (lead) await repositories.leads.updateById(lead.id, { research: { instruments: mergeInstruments(lead.research.instruments, merged) } });
      }
      changedIds.add(member.id);
      r.membersTagged += 1;
      ctx.log(`${member.person.name}: ${merged.map((x) => (x.model ? `${x.brand} ${x.model}` : x.brand)).join(', ')}`);
    }
    summary.membersTagged += r.membersTagged;
    ctx.count('membersTagged', r.membersTagged);
    ctx.log(`${institution.name}: ${result.candidates.length} sightings across ${r.authorsSeen} authors; ${r.membersTagged} roster members tagged, ${r.admitted} instrument owners admitted to the roster, ${r.declined.length} sighted people declined`);
    if (r.budgetExhausted) {
      ctx.log('OpenAlex allowance exhausted — the sweep is incomplete; rerun tomorrow', 'error');
      break;
    }
  }

  // Re-score the members whose instruments changed: their works are cached,
  // so this costs nothing new, and the score now reflects the instrument.
  if ((options.rescore ?? true) && changedIds.size > 0) {
    ctx.setStage(`re-scoring ${changedIds.size} members`, 0.95);
    const eligible = (await repositories.faculty.find({ filter: [where.in('_id', [...changedIds]), where.eq('status', 'eligible')] })).map((m) => m.id);
    if (eligible.length > 0) {
      const scored = await scoreRoster({ ids: eligible, rescore: true }, ctx);
      summary.rescored = scored.scored;
    }
  }
  if (summary.classOneOwners.length > 0) ctx.log(`Class One brand owners found: ${summary.classOneOwners.join(', ')}`);
  return summary;
}
