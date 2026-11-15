import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PAPER_IMPORT_MAX_PAGE_BYTES,
  PAPER_IMPORT_MAX_PAGES,
  validatePaperImportCreateInput,
  validatePaperImportPageInput,
  validatePaperImportSaveInput,
  validatePaperImportTable,
  validatePaperImportVersionInput,
  verifyPaperImportDetail,
  verifyPaperImportList,
  verifyPaperImportPage,
  verifyPaperImportSummary,
  type PaperImportDetail,
  type PaperImportList,
  type PaperImportPage,
  type PaperImportSummary,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { ImageRefused, stripImageMetadata } from './image-metadata.js';
import { PAPER_READER_RUNTIME, type PaperReaderRuntime } from './paper-reader.js';

export type PaperImportContext = MembershipLifecycleContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
// Sending stages up to 200 rows through the existing import in the same transaction.
const WRITE_LIMITS = "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  PAPER_IMPORT_INVALID: code => new BadRequestException({ code }),
  PAPER_IMPORT_FORBIDDEN: code => new ForbiddenException({ code, detail: 'Live student import permission at this school and an active subscription are required.' }),
  PAPER_IMPORT_NOT_FOUND: code => new NotFoundException({ code }),
  PAPER_IMPORT_GONE: code => new NotFoundException({ code, detail: 'These photos were deleted.' }),
  PAPER_IMPORT_IMAGE_REFUSED: code => new BadRequestException({ code, detail: 'Use a JPEG, PNG or WebP photo of up to 1.4 MB.' }),
  PAPER_IMPORT_PAGE_DUPLICATE: code => new ConflictException({ code, detail: 'This photo is already in the set.' }),
  PAPER_IMPORT_TOO_MANY_PAGES: code => new BadRequestException({ code, detail: 'A set holds at most 10 photos.' }),
  PAPER_IMPORT_ALREADY_READ: code => new ConflictException({ code, detail: 'Photos cannot be added after HON has read the set.' }),
  PAPER_IMPORT_NO_PAGES: code => new BadRequestException({ code, detail: 'Add at least one photo first.' }),
  PAPER_IMPORT_NOT_EDITABLE: code => new ConflictException({ code, detail: 'The table can be changed only after reading and before it is sent.' }),
  PAPER_IMPORT_READING_STALE: code => new ConflictException({ code, detail: 'Another reading of this set started. Reload it.' }),
  PAPER_IMPORT_TABLE_EMPTY: code => new BadRequestException({ code, detail: 'Fill in at least one row before sending.' }),
  PAPER_IMPORT_TABLE_TOO_LARGE: code => new BadRequestException({ code, detail: 'The table is too large for one import.' }),
  PAPER_IMPORT_SEND_CONFLICT: code => new ConflictException({ code }),
  PAPER_IMPORT_BUSY: code => new ConflictException({ code, detail: 'The same request is still being processed. Try again shortly with the same key.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The set has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different request.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (message === 'PAPER_IMPORT_AI_BLOCKED' && sqlState === '42501') {
    const reason = (error as { detail?: string })?.detail ?? '';
    throw new ForbiddenException({ code: 'PAPER_IMPORT_AI_BLOCKED', reason: /^AI_[A-Z_]{1,60}$/.test(reason) ? reason : 'AI_NOT_AVAILABLE', detail: 'HON reading is not available for this school right now. You can still type the rows.' });
  }
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  // The existing import's own checks raise their own codes inside a send; surface them as a refused send.
  if (/^(STUDENT|HISTORY)_IMPORT_FORBIDDEN$/.test(message) || sqlState === '42501') throw new ForbiddenException({ code: 'PAPER_IMPORT_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'PAPER_IMPORT_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008', '22021', '22P05'].includes(sqlState)) throw new BadRequestException({ code: 'PAPER_IMPORT_INVALID' });
  throw new ServiceUnavailableException({ code: 'PAPER_IMPORT_UNAVAILABLE', detail: 'No success is assumed. Reload, or retry the unchanged request with the same key.' });
}

/**
 * Paper import (0388). Every call runs protected definer functions that re-prove the direct human subject and the live
 * students.import permission at the session school. Pages are checked and stripped of metadata here and checked again by
 * the database. Reading uses the stand-in reader only (no page leaves the server, nothing is charged); sending stages the
 * saved table through the existing import in the database, where every row is still decided by staff.
 */
@Injectable()
export class PaperImportService {
  constructor(private readonly database: RuntimeDatabaseService, @Inject(PAPER_READER_RUNTIME) private readonly reader: PaperReaderRuntime) {}

  async list(context: PaperImportContext): Promise<PaperImportList> {
    this.assertHuman(context, false);
    return this.read(context, async client => verifyPaperImportList(
      (await client.query<{ data: unknown }>('SELECT hon.read_paper_imports($1) AS data', [context.externalSubject])).rows[0]?.data));
  }

  async detail(context: PaperImportContext, setId: string): Promise<PaperImportDetail> {
    this.assertHuman(context, false); setId = this.id(setId);
    return this.read(context, async client => this.verifiedDetail(
      (await client.query<{ data: unknown }>('SELECT hon.read_paper_import($1,$2::uuid) AS data', [context.externalSubject, setId])).rows[0]?.data, setId));
  }

  async page(context: PaperImportContext, setId: string, pageNo: string): Promise<PaperImportPage> {
    this.assertHuman(context, false); setId = this.id(setId);
    if (!/^(?:[1-9]|10)$/.test(pageNo)) throw new BadRequestException({ code: 'PAPER_IMPORT_INVALID' });
    return this.read(context, async client => {
      const page = verifyPaperImportPage((await client.query<{ data: unknown }>('SELECT hon.read_paper_import_page($1,$2::uuid,$3::integer) AS data',
        [context.externalSubject, setId, Number(pageNo)])).rows[0]?.data);
      if (page.pageNo !== Number(pageNo)) throw new Error('Unverified paper import page.');
      return page;
    });
  }

  async create(context: PaperImportContext, value: unknown): Promise<{ set: PaperImportSummary; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validated(() => validatePaperImportCreateInput(value));
    return this.write(context, 'SELECT hon.create_paper_import($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', null, input);
  }

  async addPage(context: PaperImportContext, setId: string, value: unknown): Promise<{ set: PaperImportSummary; replayed: boolean }> {
    this.assertHuman(context, true); setId = this.id(setId);
    const input = this.validated(() => validatePaperImportPageInput(value));
    const raw = Buffer.from(input.data, 'base64');
    if (raw.length < 1 || raw.length > PAPER_IMPORT_MAX_PAGE_BYTES || raw.toString('base64') !== input.data) throw new BadRequestException({ code: 'PAPER_IMPORT_IMAGE_REFUSED' });
    let clean: Buffer;
    try { clean = stripImageMetadata(input.mediaType, raw); } catch (error) {
      if (error instanceof ImageRefused) throw new BadRequestException({ code: 'PAPER_IMPORT_IMAGE_REFUSED', detail: 'Use a JPEG, PNG or WebP photo of up to 1.4 MB.' });
      throw error;
    }
    return this.write(context, 'SELECT hon.add_paper_import_page($1,$6::uuid,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', setId,
      { expectedVersion: input.expectedVersion, mediaType: input.mediaType, data: clean.toString('base64') });
  }

  /**
   * One reading per set: step 1 commits the reading start (after the AI spend decision), the stand-in reads, step 2
   * records the table for that reading only. An already read set returns its current table without reading again.
   */
  async readPages(context: PaperImportContext, setId: string, value: unknown): Promise<PaperImportDetail> {
    this.assertHuman(context, false, true); setId = this.id(setId);
    const input = this.validated(() => validatePaperImportVersionInput(value));
    const started = await this.transaction(context, async client => {
      const data = (await client.query<{ data: Record<string, unknown> }>('SELECT hon.begin_paper_reading($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid) AS data',
        [context.externalSubject, setId, JSON.stringify(input), context.requestId, context.correlationId])).rows[0]?.data;
      if (!data || typeof data.done !== 'boolean') throw new Error('Unverified paper reading start.');
      return data;
    });
    if (started.done) return this.detail({ ...context, idempotencyKey: '' }, setId);
    const kind = started.kind, checksums = started.checksums, readingId = started.readingId;
    if (typeof readingId !== 'string' || !UUID.test(readingId) || !Array.isArray(checksums) || checksums.length < 1 || checksums.length > PAPER_IMPORT_MAX_PAGES
      || !checksums.every(c => typeof c === 'string' && /^[a-f0-9]{64}$/.test(c))) throw new ServiceUnavailableException({ code: 'PAPER_IMPORT_UNAVAILABLE' });
    let validKind: ReturnType<typeof validatePaperImportCreateInput>['kind'];
    try { validKind = validatePaperImportCreateInput({ kind }).kind; } catch { throw new ServiceUnavailableException({ code: 'PAPER_IMPORT_UNAVAILABLE' }); }
    const result = await this.reader.read({ kind: validKind, checksums: checksums as string[] });
    if (result.reader !== 'SYNTHETIC') throw new ServiceUnavailableException({ code: 'PAPER_IMPORT_UNAVAILABLE' });
    const table = validatePaperImportTable(validKind, result.rows, result.unsure);
    return this.transaction(context, async client => this.verifiedDetail((await client.query<{ data: unknown }>(
      'SELECT hon.record_paper_reading($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, setId, JSON.stringify({ readingId, reader: 'SYNTHETIC', outcome: result.outcome, ...table }), context.requestId, context.correlationId])).rows[0]?.data, setId));
  }

  /** The table width is checked against the set's kind by the database; here every row must be one shape. */
  async save(context: PaperImportContext, setId: string, value: unknown): Promise<{ set: PaperImportSummary; replayed: boolean }> {
    this.assertHuman(context, true); setId = this.id(setId);
    const input = this.validated(() => validatePaperImportSaveInput(null, value));
    return this.write(context, 'SELECT hon.save_paper_import_table($1,$6::uuid,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', setId, input);
  }

  async send(context: PaperImportContext, setId: string, value: unknown): Promise<{ set: PaperImportSummary; replayed: boolean }> {
    this.assertHuman(context, true); setId = this.id(setId);
    const input = this.validated(() => validatePaperImportVersionInput(value));
    return this.write(context, 'SELECT hon.send_paper_import($1,$6::uuid,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', setId, input);
  }

  async remove(context: PaperImportContext, setId: string, value: unknown): Promise<{ set: PaperImportSummary; replayed: boolean }> {
    this.assertHuman(context, true); setId = this.id(setId);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new BadRequestException({ code: 'PAPER_IMPORT_INVALID' });
    return this.write(context, 'SELECT hon.delete_paper_import($1,$6::uuid,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', setId, {});
  }

  private verifiedDetail(value: unknown, setId: string): PaperImportDetail {
    const detail = verifyPaperImportDetail(value);
    if (detail.set.id !== setId) throw new Error('Unverified paper import detail.');
    return detail;
  }

  private async read<T>(context: PaperImportContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return run(client);
      });
    } catch (error) { return translate(error); }
  }

  private async transaction<T>(context: PaperImportContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return run(client);
      });
    } catch (error) { return translate(error); }
  }

  private write(context: PaperImportContext, statement: string, setId: string | null, input: object): Promise<{ set: PaperImportSummary; replayed: boolean }> {
    return this.transaction(context, async client => {
      const args: unknown[] = [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId];
      if (setId !== null) args.push(setId);
      const result = await client.query<{ data: Record<string, unknown> }>(statement, args);
      const data = result.rows[0]?.data;
      if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') {
        throw new Error('Unverified paper import receipt.');
      }
      const set = verifyPaperImportSummary(data.record);
      if (setId !== null && set.id !== setId) throw new Error('Unverified paper import receipt.');
      return { set, replayed: data.replayed };
    });
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'PAPER_IMPORT_INVALID' }); }
  }

  private id(id: string): string {
    if (!UUID.test(id)) throw new BadRequestException({ code: 'PAPER_IMPORT_INVALID' });
    return id.toLowerCase();
  }

  private assertHuman(context: PaperImportContext, command: boolean, keyless = false): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Paper import accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'PAPER_IMPORT_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '' && !keyless) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
