/**
 * Tags every eligible and promoted roster member (and their CRM lead) with the default focus
 * application areas, from the topics and titles already stored. Local only: no network, no credits.
 * The score stage does the same for its institutes on every run; this covers everyone at once.
 *
 *   npm --prefix backend run roster:tag-areas
 */
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { DEFAULT_APPLICATION_AREAS } from '../services/roster/applicationAreas.js';
import { tagRosterAreas } from '../services/roster/rosterRelevance.js';

await connectDatabase();
const r = await tagRosterAreas({ areas: DEFAULT_APPLICATION_AREAS });
console.log(`${r.tagged} members fall in at least one focus area; ${r.changed} records updated.`);
await disconnectDatabase();
