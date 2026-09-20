/**
 * Roster exports — one column list, two formats.
 *
 * CSV is the current filtered view as a flat file. Excel adds "split by": the
 * same rows distributed over one worksheet per distinct value of a chosen
 * column (institute, department, brand…), so a salesperson gets the tabs
 * they would otherwise make by hand. A member with several brands or several
 * sources appears on each matching sheet; a blank value goes to "(none)".
 */
import ExcelJS from 'exceljs';
import type { FacultyMember } from '../../types/domain.js';
import { DOMAIN_LABELS } from './domains.js';

export type Cell = string | number | undefined | null;

export interface ExportColumn {
  header: string;
  value: (m: FacultyMember) => Cell;
}

const brands = (m: FacultyMember) => [...new Set(m.research.instruments.map((i) => i.brand))];
const models = (m: FacultyMember) => [...new Set(m.research.instruments.filter((i) => i.model).map((i) => `${i.brand} ${i.model}`))];
const sources = (m: FacultyMember) => [...new Set(m.sources.map((s) => s.type))];

export const ROSTER_COLUMNS: ExportColumn[] = [
  { header: 'Name', value: (m) => m.person.name },
  { header: 'Title', value: (m) => m.person.title },
  { header: 'Role', value: (m) => m.role.category },
  { header: 'Department', value: (m) => m.department.name },
  { header: 'Domain', value: (m) => DOMAIN_LABELS[m.department.domain] },
  { header: 'Institute', value: (m) => m.institution.name },
  { header: 'Discovered at', value: (m) => m.institution.discoveredName },
  { header: 'Affiliation status', value: (m) => m.institution.affiliation?.status ?? 'unverified' },
  { header: 'Affiliation source', value: (m) => m.institution.affiliation?.source },
  { header: 'Affiliation checked', value: (m) => (m.institution.affiliation?.verifiedAt ? new Date(m.institution.affiliation.verifiedAt).toISOString().slice(0, 10) : undefined) },
  { header: 'Previous institution', value: (m) => m.institution.affiliation?.previousInstitution },
  { header: 'Outside target list', value: (m) => (m.institution.outsideTarget ? 'yes' : '') },
  { header: 'Email', value: (m) => m.person.email },
  { header: 'Phone', value: (m) => m.person.phone },
  { header: 'Website', value: (m) => m.person.websiteUrl },
  { header: 'Profile', value: (m) => m.person.profileUrl },
  { header: 'ORCID', value: (m) => m.person.orcid },
  { header: 'OpenAlex', value: (m) => m.person.openAlexAuthorId },
  { header: 'Relevance', value: (m) => m.relevance.score },
  { header: 'Instrument brands', value: (m) => brands(m).join('; ') },
  { header: 'Instrument models', value: (m) => models(m).join('; ') },
  { header: 'Class One customer', value: (m) => (m.research.instruments.some((i) => i.vendor === 'classone') ? 'yes' : '') },
  { header: 'Topics', value: (m) => m.research.topics.slice(0, 8).join('; ') },
  { header: 'Works', value: (m) => m.research.worksCount },
  { header: 'h-index', value: (m) => m.research.hIndex },
  { header: 'Sources', value: (m) => sources(m).join('; ') },
  { header: 'Status', value: (m) => m.status },
  { header: 'Tags', value: (m) => m.tags.join('; ') },
  { header: 'Score reasoning', value: (m) => m.relevance.reasoning },
];

/**
 * One spelling per department for the split: "Department of Chemistry",
 * "Dept. of Chemistry" and "Chemistry" are one sheet; "&" reads as "and";
 * a trailing "(IIT Bombay)" or similar is dropped.
 */
export function canonicalDepartment(name?: string): string {
  if (!name) return '(none)';
  const cleaned = name
    .replace(/\(.*?\)/g, ' ')
    .replace(/^\s*(department|dept\.?|school|centre|center|division)\s+(of|for)\s+/i, '')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '(none)';
  const small = new Set(['and', 'of', 'for', 'in', 'the']);
  return cleaned.replace(/\w\S*/g, (w, i) => {
    if (w.length <= 4 && w === w.toUpperCase()) return w; // an acronym: BSBE, MEMS, IEOR
    const lower = w.toLowerCase();
    return i > 0 && small.has(lower) ? lower : w[0]!.toUpperCase() + lower.slice(1);
  });
}

/** Columns a workbook can be split on, and how each member maps to sheet names. */
export const SPLIT_OPTIONS: Record<string, { label: string; keys: (m: FacultyMember) => string[] }> = {
  institute: { label: 'Institute', keys: (m) => [m.institution.name ?? '(none)'] },
  domain: { label: 'Domain', keys: (m) => [DOMAIN_LABELS[m.department.domain]] },
  department: { label: 'Department', keys: (m) => [canonicalDepartment(m.department.name)] },
  role: { label: 'Role', keys: (m) => [m.role.category] },
  status: { label: 'Roster status', keys: (m) => [m.status] },
  affiliation: { label: 'Affiliation status', keys: (m) => [m.institution.affiliation?.status ?? 'unverified'] },
  brand: { label: 'Instrument brand', keys: (m) => (brands(m).length ? brands(m) : ['(no instrument)']) },
  vendor: {
    label: 'Class One customer / competitor / none',
    keys: (m) =>
      m.research.instruments.some((i) => i.vendor === 'classone')
        ? ['Class One customer']
        : m.research.instruments.length
          ? ['Competitor owner']
          : ['No instrument found'],
  },
  score: {
    label: 'Score band',
    keys: (m) => {
      const s = m.relevance.score;
      if (s === undefined) return ['Unscored'];
      if (s >= 70) return ['70-100'];
      if (s >= 50) return ['50-69'];
      if (s >= 40) return ['40-49'];
      return ['0-39'];
    },
  },
  source: { label: 'Source', keys: (m) => (sources(m).length ? sources(m) : ['(none)']) },
  email: { label: 'Has email', keys: (m) => [m.person.email ? 'With email' : 'No email'] },
};

function csvCell(v: Cell): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rosterToCsv(members: FacultyMember[]): string {
  const lines = [ROSTER_COLUMNS.map((c) => csvCell(c.header)).join(',')];
  for (const m of members) lines.push(ROSTER_COLUMNS.map((c) => csvCell(c.value(m))).join(','));
  return '\uFEFF' + lines.join('\r\n');
}

/** Excel forbids []:*?/\ in sheet names and caps them at 31 characters; names must be unique. */
function sheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || '(none)';
  if (base.length > 31) base = base.slice(0, 31).trim();
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function addSheet(wb: ExcelJS.Workbook, name: string, members: FacultyMember[]): void {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = ROSTER_COLUMNS.map((c) => ({ header: c.header, key: c.header, width: Math.min(60, Math.max(12, c.header.length + 2)) }));
  for (const m of members) {
    const row: Record<string, Cell> = {};
    for (const c of ROSTER_COLUMNS) row[c.header] = c.value(m) ?? '';
    ws.addRow(row);
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ROSTER_COLUMNS.length } };
  // Widen text-heavy columns from their content, within reason.
  for (const col of ws.columns) {
    let width = Number(col.width ?? 12);
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      width = Math.max(width, Math.min(60, String(cell.value ?? '').length + 2));
    });
    col.width = width;
  }
}

/**
 * The workbook: one "All" sheet always, then — when `splitBy` names a
 * `SPLIT_OPTIONS` key — one sheet per distinct value, largest first.
 */
export async function rosterToXlsx(members: FacultyMember[], splitBy?: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Class One Systems';
  wb.created = new Date();
  const used = new Set<string>();
  addSheet(wb, sheetName('All', used), members);

  const split = splitBy ? SPLIT_OPTIONS[splitBy] : undefined;
  if (split) {
    const groups = new Map<string, FacultyMember[]>();
    for (const m of members) {
      for (const key of split.keys(m)) {
        const list = groups.get(key) ?? [];
        list.push(m);
        groups.set(key, list);
      }
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [key, list] of ordered) addSheet(wb, sheetName(key, used), list);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** A safe download filename: the user's text, or a dated default. */
export function exportFilename(requested: string | undefined, ext: 'csv' | 'xlsx'): string {
  const base = (requested ?? '').replace(/\.(csv|xlsx)$/i, '').replace(/[^\w\- .()]+/g, '_').trim().slice(0, 80);
  return `${base || `faculty-${new Date().toISOString().slice(0, 10)}`}.${ext}`;
}
