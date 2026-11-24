/**
 * Copies contact details the roster learned after promotion onto the CRM leads that lack them
 * (email, title, phone, website, profile, department). Local only: no network, no credits.
 * The fill stage does the same per member from now on; this catches up existing leads.
 *
 *   npm --prefix backend run roster:sync-leads            # dry run
 *   npm --prefix backend run roster:sync-leads -- --apply # writes (backup to logs/)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { repositories, where } from '../repositories/index.js';
import { rosterFieldsForLead } from '../services/roster/rosterFill.js';

const APPLY = process.argv.includes('--apply');
await connectDatabase();
const members = await repositories.faculty.find({ filter: [where.eq('status', 'promoted'), where.ne('leadId', null)], options: { limit: 1_000_000 } });
const counts: Record<string, number> = {};
const backup: unknown[] = [];
let changed = 0;
for (const m of members) {
  const lead = await repositories.leads.findById(m.leadId!);
  if (!lead) continue;
  const { patch, fields } = rosterFieldsForLead(m, lead);
  if (!fields.length) continue;
  changed += 1;
  for (const f of fields) counts[f] = (counts[f] ?? 0) + 1;
  backup.push({ id: lead.id, name: lead.person.name, person: lead.person, department: lead.institution.department });
  if (APPLY) await repositories.leads.updateById(lead.id, patch as never);
}
console.log(`${changed} leads ${APPLY ? 'updated' : 'would be updated'}; fields: ${JSON.stringify(counts)}`);
if (APPLY && backup.length) {
  const file = path.resolve(import.meta.dirname, '../../../logs', `roster_sync_backup_${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(backup, null, 1));
  console.log(`previous values saved to ${file}`);
}
await disconnectDatabase();
