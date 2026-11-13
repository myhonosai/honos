import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import {
  HISTORY_IMPORT_MAX_BYTES,
  HISTORY_IMPORT_MAX_COLUMNS,
  HISTORY_IMPORT_MAX_ROWS,
  isHistoryImportKind,
  validateHistoryImportDecisionInput,
  validateHistoryImportFinalizeInput,
  validateHistoryImportMapping,
  verifyHistoryImportBatch,
  verifyHistoryImportDetail,
  verifyHistoryImportList,
  verifyImportedAttendance,
  type HistoryImportBatch,
  type HistoryImportDetail,
  type HistoryImportKind,
  type HistoryImportList,
  type ImportedAttendance,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

export type HistoryImportContext = MembershipLifecycleContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
// A finalize of up to 1,000 rows writes several records per row; it still runs as one transaction or not at all.
const WRITE_LIMITS = "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  HISTORY_IMPORT_INVALID: code => new BadRequestException({ code, detail: 'Use a UTF-8 CSV and map every column once, including the required fields for this kind of import.' }),
  HISTORY_IMPORT_FORBIDDEN: code => new ForbiddenException({ code, detail: 'Live import permission at this school (and schedule permission for classes) and an active subscription are required.' }),
  HISTORY_IMPORT_STALE: code => new ConflictException({ code, detail: 'A class or visit in this import was added since it was staged. Stage the file again.' }),
  HISTORY_IMPORT_NOT_FOUND: code => new NotFoundException({ code }),
  HISTORY_IMPORT_ROW_NOT_IMPORTABLE: code => new BadRequestException({ code, detail: 'A row with problems can only be skipped, and an imported row cannot change.' }),
  HISTORY_IMPORT_SELECTION_REQUIRED: code => new ConflictException({ code, detail: 'Decide every row, then confirm exactly the rows marked to import.' }),
  HISTORY_IMPORT_BUSY: code => new ConflictException({ code, detail: 'The same request is still being processed. Try again shortly with the same key.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The import has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different request.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'HISTORY_IMPORT_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'HISTORY_IMPORT_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008', '22021', '22P05'].includes(sqlState)) throw new BadRequestException({ code: 'HISTORY_IMPORT_INVALID' });
  throw new ServiceUnavailableException({ code: 'HISTORY_IMPORT_UNAVAILABLE', detail: 'No success is assumed. Reload, or retry the unchanged request with the same key.' });
}
function invalid(detail: string): never { throw new BadRequestException({ code: 'HISTORY_IMPORT_INVALID', detail }); }

/** Strict CSV: UTF-8 text, no NUL or lone surrogates, consistent columns, unique safe headers, 1–1,000 data rows, at most 24 columns. */
export function parseHistoryCsv(input: unknown): { kind: HistoryImportKind; csv: string; headers: string[]; mapping: Record<string, string>; rows: string[][] } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'csv,kind,mapping') invalid('Send exactly kind, csv and mapping.');
  const { kind, csv, mapping } = input as { kind: unknown; csv: unknown; mapping: unknown };
  if (!isHistoryImportKind(kind)) invalid('The kind is CLASSES or ATTENDANCE.');
  if (typeof csv !== 'string' || !csv || Buffer.byteLength(csv, 'utf8') > HISTORY_IMPORT_MAX_BYTES
    || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|�/.test(csv)) invalid('The CSV must be valid UTF-8 text of at most 256 KiB.');
  let records: string[][];
  try {
    records = parse(csv, { bom: true, columns: false, skip_empty_lines: false, relax_quotes: false, relax_column_count: false,
      max_record_size: 16384, record_delimiter: ['\r\n', '\n'], cast: false }) as string[][];
  } catch { invalid('The CSV has broken quoting, uneven columns or an over-long line.'); }
  const headers = records.shift();
  if (!headers || !records.length || records.length > HISTORY_IMPORT_MAX_ROWS || headers.length > HISTORY_IMPORT_MAX_COLUMNS
    || new Set(headers).size !== headers.length
    || headers.some(h => !h.trim() || h.length > 80 || /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/.test(h) || /^\s*[=+\-@]/.test(h))) {
    invalid('The CSV needs unique, plain column headers, 1 to 1,000 data rows and at most 24 columns.');
  }
  let checked: Record<string, string>;
  try { checked = validateHistoryImportMapping(kind, headers, mapping); }
  catch { invalid('Map every column once to a field of this import, including its required fields.'); }
  return { kind, csv, headers, mapping: checked, rows: records };
}

/**
 * Class list and attendance-history CSV import (0333). Every call runs one protected definer function that re-proves the
 * direct human subject and the live import permission (plus schedule permission for classes) at the session school,
 * before and after its writes. The runtime role has no table privilege on the import tables, programs, class series,
 * sessions or attendance. Classes become weekly series with no sessions; attendance becomes imported history only.
 */
@Injectable()
export class HistoryImportService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: HistoryImportContext): Promise<HistoryImportList> {
    this.assertHuman(context, false);
    return this.read(context, async client => verifyHistoryImportList(
      (await client.query<{ data: unknown }>('SELECT hon.read_history_imports($1) AS data', [context.externalSubject])).rows[0]?.data));
  }

  async detail(context: HistoryImportContext, batchId: string): Promise<HistoryImportDetail> {
    this.assertHuman(context, false); this.assertId(batchId); batchId = batchId.toLowerCase();
    return this.read(context, async client => verifyHistoryImportDetail(
      (await client.query<{ data: unknown }>('SELECT hon.read_history_import($1,$2::uuid) AS data', [context.externalSubject, batchId])).rows[0]?.data, batchId));
  }

  async attendance(context: HistoryImportContext, profileId: string): Promise<ImportedAttendance> {
    this.assertHuman(context, false); this.assertId(profileId); profileId = profileId.toLowerCase();
    return this.read(context, async client => verifyImportedAttendance(
      (await client.query<{ data: unknown }>('SELECT hon.read_imported_attendance($1,$2::uuid) AS data', [context.externalSubject, profileId])).rows[0]?.data, profileId));
  }

  async stage(context: HistoryImportContext, value: unknown): Promise<{ batch: HistoryImportBatch; replayed: boolean }> {
    this.assertHuman(context, true);
    const parsed = parseHistoryCsv(value);
    return this.write(context, 'SELECT hon.stage_history_import($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', parsed);
  }

  async decide(context: HistoryImportContext, batchId: string, value: unknown): Promise<{ batch: HistoryImportBatch; replayed: boolean }> {
    this.assertHuman(context, true); this.assertId(batchId); batchId = batchId.toLowerCase();
    const input = this.validated(() => validateHistoryImportDecisionInput(value));
    return this.write(context, 'SELECT hon.decide_history_import($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', { batchId, ...input }, batchId);
  }

  async finalize(context: HistoryImportContext, batchId: string, value: unknown): Promise<{ batch: HistoryImportBatch; replayed: boolean }> {
    this.assertHuman(context, true); this.assertId(batchId); batchId = batchId.toLowerCase();
    const input = this.validated(() => validateHistoryImportFinalizeInput(value));
    return this.write(context, 'SELECT hon.finalize_history_import($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', { batchId, ...input }, batchId);
  }

  private async read<T>(context: HistoryImportContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return run(client);
      });
    } catch (error) { return translate(error); }
  }

  private async write(context: HistoryImportContext, statement: string, input: object, batchId?: string): Promise<{ batch: HistoryImportBatch; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified history import receipt.');
        }
        const batch = verifyHistoryImportBatch(data.record);
        if (batchId !== undefined && batch.id !== batchId) throw new Error('Unverified history import receipt.');
        return { batch, replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'HISTORY_IMPORT_INVALID' }); }
  }

  private assertId(id: string): void {
    if (!UUID.test(id)) throw new BadRequestException({ code: 'HISTORY_IMPORT_INVALID' });
  }

  private assertHuman(context: HistoryImportContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Class and attendance import accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'HISTORY_IMPORT_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
