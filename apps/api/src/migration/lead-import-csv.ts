import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { LEAD_IMPORT_FIELDS, type LeadImportUpload } from '@hon/contracts';
export const IMPORT_MAX_BYTES = 256 * 1024;
export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_COLUMNS = 16;
export function invalid(detail = 'Use strict UTF-8 CSV and the closed lead mapping contract.'): never {
  throw new BadRequestException({ code: 'LEAD_IMPORT_INVALID', detail });
}
export function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) invalid();
}
export function parseLeadCsv(input: LeadImportUpload): { headers: string[]; rows: string[][] } {
  closed(input, ['csv','mapping','pipelineStageId']);
  if (typeof input.csv !== 'string' || !input.csv || Buffer.byteLength(input.csv, 'utf8') > IMPORT_MAX_BYTES
    || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/.test(input.csv)) invalid('CSV must be valid UTF-8 without NUL and at most 256 KiB.');
  // TextDecoder(fatal) handles files in the browser; reject replacement and lone surrogate data here too.
  let records: string[][];
  try { records = parse(input.csv, { bom: true, columns: false, skip_empty_lines: false, relax_quotes: false,
    relax_column_count: false, max_record_size: 16384, record_delimiter: ['\r\n','\n'], cast: false }) as string[][]; }
  catch { invalid('Malformed CSV quoting, column count, record size or delimiter.'); }
  const headers = records.shift();
  if (!headers || !records.length || records.length > IMPORT_MAX_ROWS || headers.length > IMPORT_MAX_COLUMNS
    || new Set(headers).size !== headers.length || headers.some(h => !h.trim() || h.length > 80 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\uFEFF]/.test(h) || /^[\s]*[=+\-@]/.test(h))) invalid('CSV needs unique safe headers, 1–1,000 data rows and at most 16 columns.');
  closed(input.mapping, headers);
  const values = Object.values(input.mapping);
  if (Object.keys(input.mapping).length !== headers.length || values.some(v => !LEAD_IMPORT_FIELDS.includes(v))
    || new Set(values).size !== values.length || (!values.includes('givenName') && !values.includes('displayName'))
    || (values.includes('givenName') !== values.includes('familyName'))) invalid('Map every header once to an allowed field; provide first + last name or display name.');
  return { headers, rows: records };
}
