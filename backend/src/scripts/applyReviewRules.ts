/**
 * One-off pass that applies the Oct 2026 review rules to records verified before they existed.
 * Works from the evidence already stored on each record: no network, no credits.
 *
 *   - Affiliation: a `current` verdict decided by OpenAlex while ORCID shows an open employment only
 *     elsewhere could only have come from the old "ORCID must be stale" branch → `conflict`. Likewise
 *     a `current` verdict from a latest work listing more than MERGED_IDENTITY_INSTITUTIONS
 *     institutions (merged namesakes) → `conflict`. The institute and department are kept.
 *   - Instruments: every sighting gets a fresh `needsReview` flag (via `mergeInstruments`).
 *
 *   npm --prefix backend run review:apply            # dry run: counts and a sample, writes nothing
 *   npm --prefix backend run review:apply -- --apply # writes
 *
 * Re-running is harmless: records already in `conflict` are left alone, and the instrument flags are
 * recomputed from the same rule. A later affiliation check (Verify) re-decides from live sources.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { repositories } from '../repositories/index.js';
import { MERGED_IDENTITY_INSTITUTIONS, sameInstitution, textNamesInstitution } from '../services/leads/affiliationService.js';
import { mergeInstruments } from '../services/discovery/instrumentDetector.js';
import type { LeadAffiliation, LeadInstitution, LeadInstrument } from '../types/domain.js';

const APPLY = process.argv.includes('--apply');

/** The conflict a stored `current` verdict should have been under the new rules, if any. */
function conflictFor(inst: LeadInstitution): LeadAffiliation | null {
  const a = inst.affiliation;
  if (!a || a.status !== 'current' || a.source !== 'openalex') return null;
  const target = { name: inst.discoveredName ?? inst.name, openAlexId: inst.discoveredOpenAlexId ?? inst.openAlexId };
  const ev = a.evidence ?? [];
  const orcidOpen = ev.filter((e) => e.source === 'orcid' && e.current && e.institution);
  const here = (e: (typeof ev)[number]) => sameInstitution(target, { name: e.institution }) || textNamesInstitution(e.detail, target);
  if (orcidOpen.length > 0 && !orcidOpen.some(here)) {
    const first = orcidOpen[0]!;
    return {
      ...a,
      status: 'conflict',
      source: 'orcid',
      note:
        `ORCID lists a current employment only at ${first.institution}${first.detail ? ` (${first.detail})` : ''}, ` +
        `but the latest paper still names ${target.name ?? 'the institute'}. Either ORCID is out of date or this is a ` +
        'different person with the same name — check before relying on it.',
    };
  }
  const named = ev.filter((e) => e.source === 'openalex' && e.institution).length;
  if (named > MERGED_IDENTITY_INSTITUTIONS) {
    return {
      ...a,
      status: 'conflict',
      note:
        `The latest indexed work lists ${named} institutions for this author — the OpenAlex record probably merges ` +
        'several people with the same name. Check the person before relying on it.',
    };
  }
  return null;
}

/** Instruments with fresh review flags, or null when nothing changes. */
function reflagged(list: LeadInstrument[]): LeadInstrument[] | null {
  if (list.length === 0) return null;
  const next = mergeInstruments(list);
  const key = (l: LeadInstrument[]) => l.map((i) => `${i.brandKey}|${i.model ?? ''}|${i.needsReview ? 1 : 0}`).join(',');
  return key(next) === key(list) ? null : next;
}

await connectDatabase();
const summary = { faculty: { conflicts: 0, instrumentLists: 0, flagged: 0 }, leads: { conflicts: 0, instrumentLists: 0, flagged: 0 } };
const samples: string[] = [];
/** Every changed record as it was before, written to logs/ on --apply so the pass can be undone. */
const backup: Array<{ kind: string; id: string; name: string; institution: unknown; instruments: unknown }> = [];

for (const kind of ['faculty', 'leads'] as const) {
  const repo = kind === 'faculty' ? repositories.faculty : repositories.leads;
  const docs = await repo.find({ filter: [], options: { limit: 1_000_000 } });
  for (const d of docs) {
    const set: Record<string, unknown> = {};
    const conflict = conflictFor(d.institution);
    if (conflict) {
      summary[kind].conflicts += 1;
      set.institution = { ...d.institution, affiliation: conflict };
      if (samples.length < 8 && kind === 'faculty') samples.push(`${d.person.name}: ${conflict.note}`);
    }
    const instruments = reflagged(d.research.instruments ?? []);
    if (instruments) {
      summary[kind].instrumentLists += 1;
      summary[kind].flagged += instruments.filter((i) => i.needsReview).length;
      set.research = { ...d.research, instruments };
    }
    if (Object.keys(set).length > 0) {
      backup.push({ kind, id: d.id, name: d.person.name, institution: d.institution, instruments: d.research.instruments });
      if (APPLY) await repo.updateById(d.id, set as never);
    }
  }
}

console.log(JSON.stringify(summary, null, 1));
console.log('\nsample conflicts:\n  ' + samples.join('\n  '));
if (APPLY && backup.length > 0) {
  const file = path.resolve(import.meta.dirname, '../../../logs', `review_rules_backup_${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(backup, null, 1));
  console.log(`\napplied to ${backup.length} records; previous values saved to ${file}`);
} else {
  console.log(APPLY ? '\nnothing to change.' : `\ndry run — ${backup.length} records would change; nothing written. Re-run with --apply to write.`);
}
await disconnectDatabase();
