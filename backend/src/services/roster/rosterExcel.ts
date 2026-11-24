/**
 * The roster Excel download, formatted for sending outside the team.
 *
 * Two layouts, one look:
 *   - presentable (default): Name, Department, Application, Phone, Email, Current System Used
 *   - full: every export column
 * Every sheet gets a navy title band, a live summary line (formulas, with cached results so previews
 * show them), a colour key, a bordered and banded table with filter buttons, a frozen header, Arial
 * throughout, clickable emails and landscape fit-to-width printing.
 *
 * Clean-ups (presentable): department spellings normalised ("Department of", "Engg", "&"); a value that
 * is not an institute department falls back to the research domain, shown grey italic; phone numbers
 * in one style; an email outside the institute's own domain is grey italic ("verify before use");
 * Current System Used is colour-coded — green Class One, amber competitor, grey not identified.
 */
import ExcelJS from 'exceljs';
import type { FacultyMember } from '../../types/domain.js';
import { confirmedInstruments } from '../discovery/instrumentDetector.js';
import { DOMAIN_LABELS } from './domains.js';
import { evidenceOf, tagApplicationAreas } from './applicationAreas.js';
import { ROSTER_COLUMNS } from './rosterExport.js';

export type ExportLayout = 'presentable' | 'full';

const FONT = 'Arial';
const NAVY = 'FF1F3864';
const INK = 'FF1F2937';
const GREY = 'FF6B7280';
const SUMMARY_FILL = 'FFDCE3F0';
const BAND = 'FFF7F9FC';
const GREEN = { fill: 'FFE2F0D9', text: 'FF375623' };
const AMBER = { fill: 'FFFFF2CC', text: 'FF7F6000' };
const NONE_FILL = 'FFF3F4F6';
const LINK = 'FF1F4E9E';
const thin = { style: 'thin' as const, color: { argb: 'FFD1D5DB' } };
const BORDER: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

// ---------------------------------------------------------------------------
// Clean-ups
// ---------------------------------------------------------------------------

const NOT_A_DEPARTMENT = /universit|amity|college|\binstitute of\b(?!.*technology)/i;
const ALIASES: Record<string, string> = { ee: 'Electrical Engineering', ece: 'Electronics and Communication Engineering', cse: 'Computer Science and Engineering' };
const SMALL = new Set(['and', 'of', 'for', 'in', 'the']);

export function cleanDepartment(name?: string): string | undefined {
  if (!name || NOT_A_DEPARTMENT.test(name)) return undefined;
  let n = name
    .replace(/\(.*?\)/g, ' ')
    .replace(/^\s*(department|dept\.?)\s+(of|for)\s+/i, '')
    .replace(/\bEngg\.?(?=\s|$)/gi, 'Engineering')
    .replace(/\bSci\.?(?=\s|$)/gi, 'Science')
    .replace(/\bTech\.?(?=\s|$)/gi, 'Technology')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.-]+|[\s,.-]+$/g, '');
  if (!n) return undefined;
  if (ALIASES[n.toLowerCase()]) return ALIASES[n.toLowerCase()];
  n = n
    .split(' ')
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (i > 0 && SMALL.has(lw)) return lw;
      if (w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    })
    .join(' ');
  return n;
}

/** Indian numbers in one style: landlines "011 2659 6132", mobiles "+91 98765 43210". */
export function cleanPhone(p?: string): string | undefined {
  if (!p) return undefined;
  const first = String(p).split(/[,/;]| or /)[0] ?? '';
  let digits = first.replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  if (digits.length === 10 && !digits.startsWith('0')) digits = `0${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) {
    const std = ['011', '022', '033', '040', '044', '080'].includes(digits.slice(0, 3)) ? 3 : 4;
    const rest = digits.slice(std);
    return `${digits.slice(0, std)} ${rest.slice(0, -4)} ${rest.slice(-4)}`;
  }
  return digits.length >= 6 ? first.replace(/\s+/g, ' ').trim() : undefined;
}

/** "che.iitb.ac.in" → "iitb.ac.in"; "gmail.com" stays. */
function baseDomain(email: string): string {
  const host = email.toLowerCase().split('@')[1] ?? '';
  const parts = host.split('.');
  const academic = /\.(ac|edu|res|ernet|gov)\.in$/.test(host);
  return parts.slice(academic ? -3 : -2).join('.');
}

/** The institute's own email domain: the most common academic domain among its members' emails. */
function instituteDomains(members: FacultyMember[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const m of members) {
    const inst = m.institution.discoveredName ?? m.institution.name;
    const email = m.person.email;
    if (!inst || !email) continue;
    const d = baseDomain(email);
    if (!/\.(ac|edu|res)\.in$|\.edu$/.test(d)) continue;
    const c = counts.get(inst) ?? new Map<string, number>();
    c.set(d, (c.get(d) ?? 0) + 1);
    counts.set(inst, c);
  }
  const out = new Map<string, string>();
  for (const [inst, c] of counts) {
    const best = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) out.set(inst, best[0]);
  }
  return out;
}

const SHORT_BRAND: Record<string, string> = {
  'Autolab (Metrohm)': 'Metrohm Autolab',
  'Princeton Applied Research (AMETEK)': 'AMETEK PAR',
  'BioLogic SAS': 'BioLogic',
  'Ivium Technologies': 'Ivium',
};

export function systemOf(m: FacultyMember): { text?: string; vendor?: 'classone' | 'competitor' } {
  const conf = confirmedInstruments(m.research.instruments);
  if (!conf.length) return {};
  const names: string[] = [];
  for (const i of conf) {
    const b = SHORT_BRAND[i.brand] ?? i.brand;
    const n = i.model ? `${b} ${i.model}` : b;
    if (!names.includes(n)) names.push(n);
  }
  return {
    text: names.slice(0, 3).join(', ') + (names.length > 3 ? ` (+${names.length - 3} more)` : ''),
    vendor: conf.some((i) => i.vendor === 'classone') ? 'classone' : 'competitor',
  };
}

export function shortInstitute(name: string): string {
  return name
    .replace(/^Indian Institute of Information Technology\b/i, 'IIIT')
    .replace(/^Indian Institute of Technology\b/i, 'IIT')
    .replace(/^National Institute of Technology\b/i, 'NIT')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Sheet building
// ---------------------------------------------------------------------------

interface Col { header: string; width: number }

function titleOf(sheet: string, members: FacultyMember[], layout: ExportLayout): string {
  const insts = new Set(members.map((m) => m.institution.discoveredName ?? m.institution.name).filter(Boolean));
  const scope = sheet === 'All' ? (insts.size === 1 ? shortInstitute([...insts][0]!) : 'All researchers') : sheet;
  return layout === 'presentable' ? `${scope} — Researchers for Class One Systems` : `${scope} — Faculty roster (full detail)`;
}

function bandRow(ws: ExcelJS.Worksheet, row: number, cols: number, fill: string, height: number) {
  for (let c = 1; c <= cols; c += 1) ws.getCell(row, c).fill = solid(fill);
  ws.getRow(row).height = height;
}

/** Rough wrapped-line count so row heights fit (Excel does not re-measure rows on open). */
function rowHeight(values: Array<string | undefined>, widths: number[]): number {
  const lines = Math.max(1, ...values.map((v, i) => Math.ceil(String(v ?? '').length / Math.max(1, (widths[i] ?? 20) * 0.95)) || 1));
  return Math.max(20, 15 * lines + 5);
}

function header(ws: ExcelJS.Worksheet, row: number, cols: Col[]) {
  cols.forEach((c, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = c.header;
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = solid(NAVY);
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
    cell.border = BORDER;
    ws.getColumn(i + 1).width = c.width;
  });
  ws.getRow(row).height = 24;
}

function finish(ws: ExcelJS.Worksheet, headerRow: number, cols: number, lastRow: number, title: string, pagesWide = 1) {
  const lastCol = ws.getColumn(cols).letter;
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(headerRow, lastRow), column: cols } };
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: headerRow, showGridLines: false }];
  ws.pageSetup = {
    orientation: 'landscape',
    paperSize: 9, // A4
    fitToPage: true,
    fitToWidth: pagesWide,
    fitToHeight: 0,
    horizontalCentered: true,
    printTitlesRow: `${headerRow}:${headerRow}`,
    printArea: `A1:${lastCol}${Math.max(headerRow, lastRow)}`,
  };
  ws.headerFooter = { oddFooter: `&C${title.replace(/&/g, '&&')} — page &P of &N` };
}

function titleBlock(ws: ExcelJS.Worksheet, title: string, cols: number) {
  ws.mergeCells(1, 1, 1, cols);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: FONT, size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  t.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  bandRow(ws, 1, cols, NAVY, 34);
}

function summaryLine(ws: ExcelJS.Worksheet, cols: number, formula: string, result: string) {
  ws.mergeCells(2, 1, 2, cols);
  const s = ws.getCell(2, 1);
  s.value = { formula, result };
  s.font = { name: FONT, size: 10, bold: true, color: { argb: INK } };
  s.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  bandRow(ws, 2, cols, SUMMARY_FILL, 22);
}

function legend(ws: ExcelJS.Worksheet, cols: number, note: string) {
  const l = ws.getCell(3, 1);
  l.value = 'Current System Used:';
  l.font = { name: FONT, size: 9, bold: true, color: { argb: GREY } };
  const keys: Array<[string, string, string]> = [
    ['Class One system', GREEN.fill, GREEN.text],
    ['Competitor system', AMBER.fill, AMBER.text],
    ['Not identified', NONE_FILL, GREY],
  ];
  keys.forEach(([txt, fill, color], i) => {
    const cell = ws.getCell(3, 2 + i);
    cell.value = txt;
    cell.font = { name: FONT, size: 9, bold: true, color: { argb: color } };
    cell.fill = solid(fill);
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = BORDER;
  });
  ws.getRow(3).height = 18;
  ws.mergeCells(4, 1, 4, cols);
  const n = ws.getCell(4, 1);
  n.value = note;
  n.font = { name: FONT, size: 8, italic: true, color: { argb: GREY } };
  n.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(4).height = 26;
}

const HEADER_ROW = 6;

function presentableSheet(wb: ExcelJS.Workbook, name: string, members: FacultyMember[], domains: Map<string, string>) {
  const ws = wb.addWorksheet(name);
  const cols: Col[] = [
    { header: 'Name', width: 30 },
    { header: 'Department', width: 34 },
    { header: 'Application', width: 44 },
    { header: 'Phone', width: 18 },
    { header: 'Email', width: 36 },
    { header: 'Current System Used', width: 38 },
  ];
  const rows = members
    .map((m) => {
      const dept = cleanDepartment(m.department.name ?? m.institution.department);
      const domainLabel = (DOMAIN_LABELS[m.department.domain] ?? '').replace(/\s*\(.*\)\s*$/, '') || 'Not recorded';
      const areas = m.research.applicationAreas ?? tagApplicationAreas(evidenceOf(m));
      const inst = m.institution.discoveredName ?? m.institution.name ?? '';
      const instDomain = domains.get(inst);
      const email = m.person.email?.trim() || undefined;
      return {
        m,
        name: m.person.name.replace(/\s+/g, ' ').trim(),
        dept: dept ?? domainLabel,
        inferred: !dept,
        app: areas.slice(0, 2).join('; ') || undefined,
        phone: cleanPhone(m.person.phone),
        email,
        institutional: Boolean(email && instDomain && baseDomain(email) === instDomain),
        ...systemOf(m),
      };
    })
    .sort((a, b) => Number(a.dept === 'Not recorded') - Number(b.dept === 'Not recorded') || a.dept.localeCompare(b.dept) || (b.m.relevance.score ?? 0) - (a.m.relevance.score ?? 0) || a.name.localeCompare(b.name));

  const first = HEADER_ROW + 1;
  const last = HEADER_ROW + rows.length;
  const title = titleOf(name, members, 'presentable');
  titleBlock(ws, title, cols.length);
  const r = (c: string) => `${c}${first}:${c}${Math.max(first, last)}`;
  const withEmail = rows.filter((x) => x.email?.includes('@')).length;
  const withPhone = rows.filter((x) => x.phone).length;
  const withSystem = rows.filter((x) => x.text).length;
  summaryLine(
    ws,
    cols.length,
    `COUNTA(${r('A')})&" researchers   •   "&COUNTIF(${r('E')},"*@*")&" with email   •   "&COUNTA(${r('D')})&" with phone   •   "&COUNTIF(${r('F')},"<>Not identified")&" with an identified system"`,
    `${rows.length} researchers   •   ${withEmail} with email   •   ${withPhone} with phone   •   ${withSystem} with an identified system`,
  );
  legend(
    ws,
    cols.length,
    "Grey italic department: not listed by the institute, shown from the researcher's research area.   Grey italic email: not on the institute's own domain, so please verify before use.   " +
      'Application: focus application areas from published research (top two shown). Contact details from public profiles.',
  );
  header(ws, HEADER_ROW, cols);

  rows.forEach((x, i) => {
    const rr = first + i;
    const band = i % 2 === 0 ? 'FFFFFFFF' : BAND;
    const values = [x.name, x.dept, x.app ?? '—', x.phone, x.email, x.text ?? 'Not identified'];
    values.forEach((v, c) => {
      const cell = ws.getCell(rr, c + 1);
      cell.value = v ?? null;
      cell.font = { name: FONT, size: 10, color: { argb: INK } };
      cell.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
      cell.border = BORDER;
      cell.fill = solid(band);
    });
    ws.getCell(rr, 1).font = { name: FONT, size: 10, bold: true, color: { argb: INK } };
    if (x.inferred) ws.getCell(rr, 2).font = { name: FONT, size: 10, italic: true, color: { argb: GREY } };
    if (!x.app) ws.getCell(rr, 3).font = { name: FONT, size: 10, italic: true, color: { argb: GREY } };
    if (x.phone) ws.getCell(rr, 4).numFmt = '@';
    if (x.email) {
      ws.getCell(rr, 5).value = { text: x.email, hyperlink: `mailto:${x.email}` };
      ws.getCell(rr, 5).font = x.institutional
        ? { name: FONT, size: 10, color: { argb: LINK }, underline: true }
        : { name: FONT, size: 10, italic: true, color: { argb: GREY }, underline: true };
    }
    const sc = ws.getCell(rr, 6);
    if (x.vendor === 'classone') {
      sc.fill = solid(GREEN.fill);
      sc.font = { name: FONT, size: 10, bold: true, color: { argb: GREEN.text } };
    } else if (x.vendor === 'competitor') {
      sc.fill = solid(AMBER.fill);
      sc.font = { name: FONT, size: 10, color: { argb: AMBER.text } };
    } else {
      sc.fill = solid(NONE_FILL);
      sc.font = { name: FONT, size: 10, italic: true, color: { argb: GREY } };
    }
    ws.getRow(rr).height = rowHeight(values, cols.map((c) => c.width));
  });
  finish(ws, HEADER_ROW, cols.length, last, title);
}

function fullSheet(wb: ExcelJS.Workbook, name: string, members: FacultyMember[]) {
  const ws = wb.addWorksheet(name);
  const cols: Col[] = ROSTER_COLUMNS.map((c) => ({ header: c.header, width: 14 }));
  // Width from content, within reason.
  ROSTER_COLUMNS.forEach((c, i) => {
    let w = Math.max(12, c.header.length + 2);
    for (const m of members) w = Math.max(w, Math.min(40, String(c.value(m) ?? '').length + 2));
    cols[i]!.width = w;
  });
  const first = HEADER_ROW + 1;
  const last = HEADER_ROW + members.length;
  const title = titleOf(name, members, 'full');
  titleBlock(ws, title, cols.length);
  const nameCol = 'A';
  const emailCol = ws.getColumn(ROSTER_COLUMNS.findIndex((c) => c.header === 'Email') + 1).letter;
  const customerCol = ws.getColumn(ROSTER_COLUMNS.findIndex((c) => c.header === 'Class One customer') + 1).letter;
  const withEmail = members.filter((m) => m.person.email?.includes('@')).length;
  const customers = members.filter((m) => confirmedInstruments(m.research.instruments).some((i) => i.vendor === 'classone')).length;
  summaryLine(
    ws,
    Math.min(cols.length, 12),
    `COUNTA(${nameCol}${first}:${nameCol}${Math.max(first, last)})&" researchers   •   "&COUNTIF(${emailCol}${first}:${emailCol}${Math.max(first, last)},"*@*")&" with email   •   "&COUNTIF(${customerCol}${first}:${customerCol}${Math.max(first, last)},"yes")&" Class One customers"`,
    `${members.length} researchers   •   ${withEmail} with email   •   ${customers} Class One customers`,
  );
  legend(ws, Math.min(cols.length, 12), 'Every export column. Instruments to review: brand mentions not yet confirmed as the group’s own system. Grants come from paper acknowledgements.');
  header(ws, HEADER_ROW, cols);
  const customerIdx = ROSTER_COLUMNS.findIndex((c) => c.header === 'Class One customer');
  members.forEach((m, i) => {
    const rr = first + i;
    const band = i % 2 === 0 ? 'FFFFFFFF' : BAND;
    const values = ROSTER_COLUMNS.map((c) => c.value(m));
    values.forEach((v, c) => {
      const cell = ws.getCell(rr, c + 1);
      cell.value = v === undefined || v === null || v === '' ? null : v;
      cell.font = { name: FONT, size: 10, color: { argb: INK } };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = BORDER;
      cell.fill = solid(band);
    });
    ws.getCell(rr, 1).font = { name: FONT, size: 10, bold: true, color: { argb: INK } };
    if (values[customerIdx] === 'yes') {
      const c = ws.getCell(rr, customerIdx + 1);
      c.fill = solid(GREEN.fill);
      c.font = { name: FONT, size: 10, bold: true, color: { argb: GREEN.text } };
    }
    ws.getRow(rr).height = Math.min(90, rowHeight(values.map((v) => (v === undefined || v === null ? '' : String(v))), cols.map((c) => c.width)));
  });
  // Every column on one page width would be unreadable when printed: three pages across.
  finish(ws, HEADER_ROW, cols.length, last, title, 3);
}

export function addRosterSheet(wb: ExcelJS.Workbook, name: string, members: FacultyMember[], layout: ExportLayout, domains: Map<string, string>) {
  if (layout === 'full') fullSheet(wb, name, members);
  else presentableSheet(wb, name, members, domains);
}

export { instituteDomains };
