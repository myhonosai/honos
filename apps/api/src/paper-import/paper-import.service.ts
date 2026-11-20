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
  PAPER_READING_AI_LIMITS,
  paperImportColumns,
  parsePaperReadingAnswer,
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
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { ImageRefused, stripImageMetadata } from './image-metadata.js';
import { PAPER_IMPORT_SAMPLES, PAPER_READER_RUNTIME, type PaperReaderRuntime } from './paper-reader.js';
import { AiInvocationPlanService } from '../ai/ai-invocation-plan.service.js';
import { PAPER_VISION_RUNTIME, PaperVisionRuntimeError, type PaperVisionInvocation, type PaperVisionPage, type PaperVisionResult, type PaperVisionRuntime } from '../ai/paper-vision-runtime.js';

export type PaperImportContext = MembershipLifecycleContext;

const validUsage = (r: PaperVisionResult) => [r.inputTokens, r.outputTokens].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000)
  && Number.isSafeInteger(r.providerCostMicrounits) && r.providerCostMicrounits >= 0 && r.providerCostMicrounits <= 1_000_000_000;
const OPEN_READING = ['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED'];
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
  PAPER_IMPORT_READING_OWNED: code => new ConflictException({ code, detail: 'Someone else started HON\'s reading of these photos. You can type the rows yourself.' }),
  PAPER_IMPORT_READING_BUSY: code => new ConflictException({ code, detail: 'HON is reading these photos right now. Wait a minute, then reload.' }),
  PAPER_IMPORT_AI_FORBIDDEN: code => new ForbiddenException({ code, detail: 'HON reading needs the AI team (the Complete plan) and AI permission at this school. You can type the rows yourself.' }),
  INVALID_AI_TEXT_RESULT: () => new ServiceUnavailableException({ code: 'PAPER_IMPORT_UNAVAILABLE' }),
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
  // PAPER_IMPORT_AI_BLOCKED (0388 start check) or an S4 spend decision raised as AI_<reason> (an HQ pause, ended access,
  // the school's cost ceiling): nothing was read or sent.
  if (sqlState === '42501' && (message === 'PAPER_IMPORT_AI_BLOCKED' || (/^AI_[A-Z_]{1,60}$/.test(message) && !/^AI_(TEXT|EVIDENCE)_/.test(message)))) {
    const reason = message === 'PAPER_IMPORT_AI_BLOCKED' ? (error as { detail?: string })?.detail ?? '' : message;
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
 * the database. Reading (0594) uses HON on the AI team's text route (S4 spend controls, the HQ pause, the school's AI limit)
 * for real photos, and the stand-in reader for the built-in sample pages; staff can always type the rows instead. Sending
 * stages the saved table through the existing import in the database, where every row is still decided by staff.
 */
@Injectable()
export class PaperImportService {
  constructor(private readonly database: RuntimeDatabaseService, @Inject(PAPER_READER_RUNTIME) private readonly reader: PaperReaderRuntime,
    private readonly plans: AiInvocationPlanService, @Inject(PAPER_VISION_RUNTIME) private readonly vision: PaperVisionRuntime) {}

  async list(context: PaperImportContext): Promise<PaperImportList> {
    this.assertHuman(context, false);
    // A write transaction: opening the list erases this school's expired photo sets (see 0388 read_paper_imports).
    return this.transaction(context, async client => verifyPaperImportList(
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
   * One reading per set: step 1 commits the reading start (after the AI spend decision) and fixes the pages. A set made
   * only of built-in sample pages is read by the stand-in; any other set is read by HON on the AI route (one proposal per
   * set, so a repeat never sends again). An already read set returns its current table without reading again.
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
    if (!(checksums as string[]).every(c => PAPER_IMPORT_SAMPLES[c]?.kind === validKind)) return this.readWithAi(context, setId, readingId, validKind);
    const result = await this.reader.read({ kind: validKind, checksums: checksums as string[] });
    if (result.reader !== 'SYNTHETIC') throw new ServiceUnavailableException({ code: 'PAPER_IMPORT_UNAVAILABLE' });
    const table = validatePaperImportTable(validKind, result.rows, result.unsure);
    return this.transaction(context, async client => this.verifiedDetail((await client.query<{ data: unknown }>(
      'SELECT hon.record_paper_reading($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, setId, JSON.stringify({ readingId, reader: 'SYNTHETIC', outcome: result.outcome, ...table }), context.requestId, context.correlationId])).rows[0]?.data, setId));
  }

  /**
   * HON's reading on the AI route (0594). Order: the set's proposal, its plan (only a DOCUMENT_READING profile on an image
   * model can plan it), the page bytes checked against the fixed checksums, the final claim (budget lock, S4 decision,
   * hold), the provider call, then the usage evidence in its own transaction. Every refusal before the claim leaves the
   * set open with nothing spent; the screen offers typing the rows instead.
   */
  private async readWithAi(context: PaperImportContext, setId: string, readingId: string, kind: ReturnType<typeof validatePaperImportCreateInput>['kind']): Promise<PaperImportDetail> {
    const begun = await this.transaction(context, async client => (await client.query<{ data: Record<string, unknown> }>(
      'SELECT hon.begin_paper_ai_reading($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, setId, JSON.stringify({ readingId }), context.requestId, context.correlationId])).rows[0]?.data);
    if (!begun || typeof begun.done !== 'boolean') throw new ServiceUnavailableException({ code: 'PAPER_IMPORT_UNAVAILABLE' });
    if (begun.done || !OPEN_READING.includes(begun.status as string) || typeof begun.proposalId !== 'string' || !UUID.test(begun.proposalId)) return this.currentDetail(context, setId);
    const proposalId = begun.proposalId;
    const ref = await this.transaction(context, async client => (await client.query<{ data: { planId: string | null; workItemId: string; workVersion: number } | null }>(
      'SELECT hon.paper_ai_reading_planning_reference($1,$2::uuid) AS data', [context.externalSubject, setId])).rows[0]?.data ?? null);
    if (!ref) return this.currentDetail(context, setId);
    let planId = ref.planId;
    if (!planId) {
      try {
        const planned = await this.plans.plan({ ...context, idempotencyKey: proposalId }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY',
          agentKey: 'hon', modality: 'TEXT', taskClass: 'READ_DOCUMENT', inputBudget: PAPER_READING_AI_LIMITS.inputTokens,
          outputBudget: PAPER_READING_AI_LIMITS.outputTokens, maxProviderCostMicrounits: PAPER_READING_AI_LIMITS.maxProviderCostMicrounits });
        planId = planned.status === 'PLANNED' ? planned.plan.id : null;
      } catch (error) {
        // No DOCUMENT_READING profile on an image model: nothing was planned; prepare records NO_ELIGIBLE_ROUTE.
        if ((error as { message?: string })?.message !== 'AI_DOCUMENT_ROUTE_REQUIRED') return translate(error);
        planId = null;
      }
    }
    // The page bytes are read before the claim, so a deleted set or a changed page never holds money.
    const pages = await this.loadPages(context, setId);
    const ready = this.vision.readiness('OPENROUTER') === 'READY';
    const invocation = await this.transaction(context, async client => (await client.query<{ data: Record<string, unknown> | null }>(
      'SELECT hon.prepare_paper_ai_reading($1,$2::uuid,$3::uuid,$4) AS data', [context.externalSubject, setId, planId, ready])).rows[0]?.data ?? null);
    if (!invocation) return this.currentDetail(context, setId);
    const fail = async (failure: PaperVisionRuntimeError) => {
      await this.transaction(context, async client => { await client.query('SELECT hon.fail_paper_ai_reading($1,$2::uuid,$3,$4)', [context.externalSubject, setId, failure.outcome, failure.reason]); });
      return this.currentDetail(context, setId);
    };
    const checksums = invocation.checksums, columns = invocation.columns;
    if (invocation.kind !== kind || !Array.isArray(checksums) || checksums.length !== pages.length || !checksums.every((c, i) => c === pages[i]!.checksum)
      || !Array.isArray(columns) || columns.join(',') !== paperImportColumns(kind).join(',')) return fail(new PaperVisionRuntimeError('PRE_SEND', 'INVALID_REQUEST'));
    const call: PaperVisionInvocation = { providerId: String(invocation.providerId), modelId: String(invocation.modelId), providerRequestId: String(invocation.providerRequestId),
      inputBudget: Number(invocation.inputBudget), outputBudget: Number(invocation.outputBudget), maxCostMicrounits: Number(invocation.maxCostMicrounits),
      kind, columns: paperImportColumns(kind), pages: pages.map(p => ({ mediaType: p.mediaType, data: p.data })) };
    let result: PaperVisionResult;
    try {
      result = await this.vision.read(call);
      if (!validUsage(result)) throw new PaperVisionRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    } catch (error) {
      return fail(error instanceof PaperVisionRuntimeError ? error : new PaperVisionRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN'));
    }
    // The answer is paid for: record it either way. A table outside the import columns is kept as nothing.
    const table = parsePaperReadingAnswer(kind, result.answer);
    const evidence = { usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerCostMicrounits: result.providerCostMicrounits },
      rows: table?.rows ?? null, unsure: table?.unsure ?? null };
    try {
      return await this.transaction(context, async client => {
        const data = (await client.query<{ data: Record<string, unknown> }>('SELECT hon.record_paper_ai_reading($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, setId, JSON.stringify(evidence), context.requestId, context.correlationId])).rows[0]?.data;
        if (!data || typeof data.recorded !== 'string') throw new Error('Unverified paper reading record.');
        return this.verifiedDetail(data.detail, setId);
      });
    } catch {
      try { await this.transaction(context, async client => { await client.query('SELECT hon.fail_paper_ai_reading($1,$2::uuid,$3,$4)', [context.externalSubject, setId, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); }
      catch { /* The SENDING hold stays; it reads as UNKNOWN and the HQ owner resolves it. */ }
      throw new ServiceUnavailableException({ code: 'PAPER_IMPORT_READING_UNKNOWN', detail: 'HON\'s answer could not be saved. It is held for review and the photos are never sent again. You can type the rows yourself.' });
    }
  }

  /** The set's pages, each checked against its stored checksum. */
  private async loadPages(context: PaperImportContext, setId: string): Promise<(PaperVisionPage & { checksum: string })[]> {
    return this.read(context, async client => {
      const detail = this.verifiedDetail((await client.query<{ data: unknown }>('SELECT hon.read_paper_import($1,$2::uuid) AS data', [context.externalSubject, setId])).rows[0]?.data, setId);
      const pages: (PaperVisionPage & { checksum: string })[] = [];
      for (const info of detail.pages) {
        const page = verifyPaperImportPage((await client.query<{ data: unknown }>('SELECT hon.read_paper_import_page($1,$2::uuid,$3::integer) AS data',
          [context.externalSubject, setId, info.pageNo])).rows[0]?.data);
        const checksum = createHash('sha256').update(Buffer.from(page.data, 'base64')).digest('hex');
        if (page.pageNo !== info.pageNo || page.mediaType !== info.mediaType || checksum !== info.checksum) throw new Error('Unverified paper import page.');
        pages.push({ mediaType: page.mediaType, data: page.data, checksum });
      }
      return pages;
    });
  }

  /** The set as it stands, read inside the keyless reading command. */
  private currentDetail(context: PaperImportContext, setId: string): Promise<PaperImportDetail> {
    return this.read({ ...context, idempotencyKey: '' }, async client => this.verifiedDetail(
      (await client.query<{ data: unknown }>('SELECT hon.read_paper_import($1,$2::uuid) AS data', [context.externalSubject, setId])).rows[0]?.data, setId));
  }

  /** "Type the rows myself": no AI, nothing spent. Keyless like the reading: a repeat returns the set unchanged. */
  async typeRows(context: PaperImportContext, setId: string, value: unknown): Promise<PaperImportDetail> {
    this.assertHuman(context, false, true); setId = this.id(setId);
    const input = this.validated(() => validatePaperImportVersionInput(value));
    return this.transaction(context, async client => this.verifiedDetail((await client.query<{ data: unknown }>(
      'SELECT hon.type_paper_import_rows($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, setId, JSON.stringify(input), context.requestId, context.correlationId])).rows[0]?.data, setId));
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
