import type { LeadImportField } from '@hon/contracts';

/**
 * Column helpers shared by the lead and student imports, so a file exported from another school system can be brought
 * in without editing it first. Everything here runs in the browser on the file the staff member chose; nothing is sent
 * until they stage it, and the server still validates every row.
 */

/** Every record of a strict RFC 4180 CSV (comma, double-quote, CRLF or LF). Null when quoting is broken or rows differ in width. */
export function parseCsv(text: string): string[][] | null {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closedQuote = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closedQuote = true; }
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      if (cell !== '' || closedQuote) return null;
      quoted = true;
    } else if (ch === ',') { row.push(cell); cell = ''; closedQuote = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r') { if (source[i + 1] !== '\n') return null; i++; }
      row.push(cell); rows.push(row); row = []; cell = ''; closedQuote = false;
    } else {
      if (closedQuote) return null;
      cell += ch;
    }
  }
  if (quoted) return null;
  if (cell !== '' || closedQuote || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return null;
  const width = rows[0]!.length;
  return rows.every((r) => r.length === width) ? rows : null;
}

function quoteCell(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The same CSV with only the named columns, in their original order. Cell text is unchanged. */
export function keepColumns(rows: readonly (readonly string[])[], keep: readonly string[]): string {
  const header = rows[0] ?? [];
  const indexes = header.map((h, i) => (keep.includes(h) ? i : -1)).filter((i) => i >= 0);
  return rows.map((r) => indexes.map((i) => quoteCell(r[i] ?? '')).join(',')).join('\n') + '\n';
}

const norm = (header: string) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Common column names in lead and contact exports from school management software and spreadsheets. These are
 * suggestions only: staff see every column and can change any match before staging.
 */
const LEAD_ALIASES: ReadonlyArray<readonly [LeadImportField, readonly string[]]> = [
  ['givenName', ['first', 'first name', 'firstname', 'given name', 'contact first name', 'lead first name', 'prospect first name', 'student first name']],
  ['familyName', ['last', 'last name', 'lastname', 'surname', 'family name', 'contact last name', 'lead last name', 'prospect last name', 'student last name']],
  ['displayName', ['name', 'full name', 'fullname', 'contact name', 'contact', 'lead name', 'prospect name', 'student name']],
  ['email', ['email', 'e mail', 'email address', 'e mail address', 'contact email', 'primary email', 'parent email']],
  ['mobile', ['mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone', 'cellphone', 'phone', 'phone number', 'primary phone', 'contact phone', 'sms number', 'text number']],
  ['source', ['source', 'lead source', 'referral source', 'how did you hear', 'how did you hear about us', 'origin', 'channel']],
  ['note', ['note', 'notes', 'comments', 'comment', 'lead notes', 'description', 'interest', 'interested in', 'program interest']],
  ['campaign', ['campaign', 'campaign name', 'utm campaign']],
  ['medium', ['medium', 'utm medium']],
  ['sourceDetail', ['source detail', 'utm source', 'referrer', 'referred by', 'referral']],
];

/** A suggested lead mapping: a field per recognised column, null for columns that are not imported. Each field is used once. */
export function guessLeadMapping(headers: readonly string[]): Record<string, LeadImportField | null> {
  const used = new Set<LeadImportField>(), out: Record<string, LeadImportField | null> = {};
  for (const header of headers) {
    const key = norm(header);
    const hit = LEAD_ALIASES.find(([field, names]) => !used.has(field) && names.includes(key));
    out[header] = hit ? hit[0] : null;
    if (hit) used.add(hit[0]);
  }
  // A file with both first/last and a full-name column imports the split names; the full name stays unmatched.
  if (used.has('givenName') && used.has('familyName')) for (const h of headers) if (out[h] === 'displayName') out[h] = null;
  return out;
}

export type LeadMappingProblem = 'NAMES' | 'HALF_NAME' | 'DUPLICATE' | 'NOTHING' | null;
/** The same rules the server applies to a lead mapping, checked before staging. */
export function leadMappingProblem(mapping: Readonly<Record<string, LeadImportField | null>>): LeadMappingProblem {
  const used = Object.values(mapping).filter((v): v is LeadImportField => v !== null);
  if (!used.length) return 'NOTHING';
  if (new Set(used).size !== used.length) return 'DUPLICATE';
  if (used.includes('givenName') !== used.includes('familyName')) return 'HALF_NAME';
  if (!used.includes('givenName') && !used.includes('displayName')) return 'NAMES';
  return null;
}
