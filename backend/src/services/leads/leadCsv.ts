/**
 * Lead -> CSV, for the CRM export.
 *
 * Hand-rolled rather than a dependency: the format is one flat table, and the
 * only rule that matters (RFC 4180 quoting) is four lines long. Nested data —
 * instruments, publications, products — is flattened to a readable "a; b; c"
 * string, since a salesperson opens this in Excel, not a parser.
 */
import type { Lead } from '../../types/domain.js';

/** Column header -> how to read it off a lead. Order here is the column order. */
const COLUMNS: Array<[string, (lead: Lead) => unknown]> = [
  ['Name', (l) => l.person.name],
  ['Title', (l) => l.person.title],
  ['Email', (l) => l.person.email],
  ['Phone', (l) => l.person.phone],
  ['Lab website', (l) => l.person.websiteUrl],
  ['Institution', (l) => l.institution.name],
  ['Department', (l) => l.institution.department],
  ['Country', (l) => l.institution.country],
  ['Status', (l) => l.status],
  // Brand and model as two aligned columns: entry N of one line corresponds to
  // entry N of the other, and a model that could not be identified is left
  // blank rather than filled with the brand again.
  ['Instrument brand', (l) => instrumentsByBrand(l).map((b) => b.brand).join('; ')],
  ['Instrument model', (l) => instrumentsByBrand(l).map((b) => b.models.join(' / ')).join('; ')],
  [
    'Class One brand user',
    (l) => (l.research.instruments.some((i) => i.vendor === 'classone') ? 'yes' : 'no'),
  ],
  [
    'Competitor user',
    (l) => (l.research.instruments.some((i) => i.vendor === 'competitor') ? 'yes' : 'no'),
  ],
  ['Recommended products', (l) => l.aiScoring.recommendedProductIds.join('; ')],
  ['Research topics', (l) => l.research.topics.join('; ')],
  ['Research summary', (l) => l.research.summary],
  [
    'Recent publications',
    // Older leads may still hold duplicates from before the merge fix.
    (l) => [...new Set(l.research.recentPublications.map((p) => p.title))].join('; '),
  ],
  ['Profile URL', (l) => l.person.profileUrl],
  ['ORCID', (l) => l.person.orcid],
  ['Source', (l) => l.source.type],
  ['Source URL', (l) => l.source.sourceUrl],
  ['Discovered', (l) => l.source.discoveredAt],
  ['Added', (l) => l.createdAt],
  ['Reviewed by', (l) => l.review.reviewedBy],
  ['Reviewed at', (l) => l.review.reviewedAt],
  ['Tags', (l) => l.tags.join('; ')],
];

/** One entry per brand, in first-seen order, with every model identified for it. */
function instrumentsByBrand(lead: Lead): Array<{ brand: string; models: string[] }> {
  const out: Array<{ brand: string; models: string[] }> = [];
  for (const inst of lead.research.instruments) {
    let entry = out.find((e) => e.brand === inst.brand);
    if (!entry) {
      entry = { brand: inst.brand, models: [] };
      out.push(entry);
    }
    if (inst.model && !entry.models.includes(inst.model)) entry.models.push(inst.model);
  }
  return out;
}

/** RFC 4180: quote when needed, double any embedded quotes. Dates become ISO strings. */
function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const raw = value instanceof Date ? value.toISOString() : String(value);
  // One lead, one line. Embedded line breaks are legal inside a quoted field,
  // but Excel numbers them as extra rows and a text viewer counts them as
  // extra records — which reads as "the export is missing leads".
  const text = raw.replace(/\s*\r?\n\s*/g, ' ').trim();
  // A leading =, +, -, @ would be executed as a formula by Excel — neutralise it.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function leadsToCsv(leads: Lead[]): string {
  const header = COLUMNS.map(([name]) => cell(name)).join(',');
  const lines = leads.map((lead) =>
    COLUMNS.map(([, read]) => cell(read(lead))).join(','),
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}
