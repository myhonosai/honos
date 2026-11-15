import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateCustomToolChangeInput, validateCustomToolDashboardQuery, validateCustomToolDraftInput, validateCustomToolLinkQuery, validateCustomToolRecordInput,
  validateCustomToolRecordsQuery, verifyCustomToolDashboard, verifyCustomToolDesign, verifyCustomToolLinkOptions, verifyCustomToolList, verifyCustomToolRecord,
  verifyCustomToolRecordList, type CustomToolDashboard, type CustomToolDesign, type CustomToolLinkOptions, type CustomToolList, type CustomToolRecord, type CustomToolRecordList,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

export type CustomToolContext = MembershipLifecycleContext;
type Client = { query<T = unknown>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> };

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, [string[], (code: string, hint?: string) => HttpException]> = {
  CUSTOM_TOOL_INVALID: [['22023'], code => new BadRequestException({ code })],
  CUSTOM_TOOL_DEFINITION_INVALID: [['22023'], (code, hint) => new BadRequestException({ code, path: hint ?? null, detail: 'The tool design breaks a rule. Fix the named part and save again.' })],
  CUSTOM_TOOL_RECORD_INVALID: [['22023'], (code, hint) => new BadRequestException({ code, field: hint ?? null, detail: 'A value does not fit its field.' })],
  CUSTOM_TOOL_FORBIDDEN: [['42501'], code => new ForbiddenException({ code })],
  CUSTOM_TOOL_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  CUSTOM_TOOL_VERSION_CONFLICT: [['40001'], code => new ConflictException({ code, detail: 'Someone changed this first. Reload and try again.' })],
  CUSTOM_TOOL_STATE: [['23514'], code => new ConflictException({ code })],
  CUSTOM_TOOL_DRAFT_OPEN: [['23514'], code => new ConflictException({ code, detail: 'Publish or discard the open draft before restoring an earlier version.' })],
  CUSTOM_TOOL_KEY_TAKEN: [['23505'], code => new ConflictException({ code })],
  CUSTOM_TOOL_BUSY: [['55P03'], code => new ConflictException({ code, detail: 'The same request is still being processed. Try again shortly with the same key.' })],
  IDEMPOTENCY_KEY_REUSED: [['23505'], code => new ConflictException({ code })],
  CUSTOM_TOOL_LIMIT: [['54000'], code => new HttpException({ code }, HttpStatus.TOO_MANY_REQUESTS)],
  CUSTOM_TOOL_IMMUTABLE: [['42501'], code => new ForbiddenException({ code })],
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const e = error as { code?: string; message?: string; hint?: string };
  const known = ERRORS[e?.message ?? ''];
  if (known && known[0].includes(e?.code ?? '')) throw known[1](e.message!, e.hint);
  if (e?.code === '42501') throw new ForbiddenException({ code: 'CUSTOM_TOOL_FORBIDDEN' });
  if (['22023', '22P02', '22003'].includes(e?.code ?? '')) throw new BadRequestException({ code: 'CUSTOM_TOOL_INVALID' });
  if (e?.code === '40001' || e?.code === '40P01') throw new ConflictException({ code: 'CUSTOM_TOOL_VERSION_CONFLICT' });
  throw new ServiceUnavailableException({ code: 'CUSTOM_TOOL_UNAVAILABLE', detail: 'Nothing is assumed saved. Reload, or retry the unchanged request with the same key.' });
}
function receipt<T>(data: Record<string, unknown> | undefined, rows: number, verify: (v: unknown) => T): { result: T; replayed: boolean } {
  if (rows !== 1 || !data || Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified custom tool receipt.');
  return { result: verify(data.record), replayed: data.replayed };
}
function invalid(): never { throw new BadRequestException({ code: 'CUSTOM_TOOL_INVALID' }); }

/**
 * AI Customizer CM-1 (0362): a school's own custom tools. Every call runs one protected definer function that re-proves
 * the direct human, live custom_tool.use / custom_tool.design at the session school, and live entitlement, and validates
 * every definition and record itself. This service never builds SQL from a definition.
 */
@Injectable()
export class CustomToolService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  list(context: CustomToolContext): Promise<CustomToolList> {
    return this.read(context, 'SELECT hon.read_custom_tools($1) AS data', [], verifyCustomToolList);
  }
  tool(context: CustomToolContext, toolId: string, version: number | null): Promise<CustomToolDesign> {
    return this.read(context, 'SELECT hon.read_custom_tool($1,$2::uuid,$3::integer) AS data', [toolId, version], verifyCustomToolDesign);
  }
  records(context: CustomToolContext, toolId: string, value: unknown): Promise<CustomToolRecordList> {
    let input; try { input = validateCustomToolRecordsQuery(value); } catch { invalid(); }
    return this.read(context, 'SELECT hon.read_custom_tool_records($1,$2::uuid,$3::jsonb) AS data', [toolId, JSON.stringify(input)], verifyCustomToolRecordList);
  }
  dashboard(context: CustomToolContext, toolId: string, value: unknown): Promise<CustomToolDashboard> {
    let input; try { input = validateCustomToolDashboardQuery(value); } catch { invalid(); }
    return this.read(context, 'SELECT hon.read_custom_tool_dashboard($1,$2::uuid,$3::jsonb) AS data', [toolId, JSON.stringify(input)], verifyCustomToolDashboard);
  }
  linkOptions(context: CustomToolContext, toolId: string, value: unknown): Promise<CustomToolLinkOptions> {
    let input; try { input = validateCustomToolLinkQuery(value); } catch { invalid(); }
    return this.read(context, 'SELECT hon.read_custom_tool_link_options($1,$2::uuid,$3::jsonb) AS data', [toolId, JSON.stringify(input)], verifyCustomToolLinkOptions);
  }
  async saveDraft(context: CustomToolContext, value: unknown): Promise<{ result: CustomToolDesign; replayed: boolean }> {
    let input; try { input = validateCustomToolDraftInput(value); } catch { throw new BadRequestException({ code: 'CUSTOM_TOOL_DEFINITION_INVALID', path: null }); }
    const out = await this.command(context, 'SELECT hon.save_custom_tool_draft($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', [JSON.stringify(input)], verifyCustomToolDesign);
    if (input.toolId && out.result.tool.toolId !== input.toolId) throw new ServiceUnavailableException({ code: 'CUSTOM_TOOL_UNAVAILABLE' });
    return out;
  }
  async change(context: CustomToolContext, toolId: string, value: unknown): Promise<{ result: CustomToolDesign; replayed: boolean }> {
    let input; try { input = validateCustomToolChangeInput(value); } catch { invalid(); }
    const out = await this.command(context, 'SELECT hon.change_custom_tool($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', [toolId, JSON.stringify(input)], verifyCustomToolDesign);
    if (out.result.tool.toolId !== toolId) throw new ServiceUnavailableException({ code: 'CUSTOM_TOOL_UNAVAILABLE' });
    return out;
  }
  async writeRecord(context: CustomToolContext, toolId: string, value: unknown): Promise<{ result: CustomToolRecord; replayed: boolean }> {
    let input; try { input = validateCustomToolRecordInput(value); } catch { invalid(); }
    const out = await this.command(context, 'SELECT hon.write_custom_tool_record($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', [toolId, JSON.stringify(input)], verifyCustomToolRecord);
    if (input.recordId && out.result.recordId !== input.recordId) throw new ServiceUnavailableException({ code: 'CUSTOM_TOOL_UNAVAILABLE' });
    return out;
  }

  private async read<T>(context: CustomToolContext, sql: string, args: unknown[], verify: (v: unknown) => T): Promise<T> {
    this.assertHuman(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: Client) => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const r = await client.query<{ data: unknown }>(sql, [context.externalSubject, ...args]);
        if (r.rows.length !== 1) throw new Error('Unverified custom tool read.');
        return verify(r.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }
  private async command<T>(context: CustomToolContext, sql: string, args: unknown[], verify: (v: unknown) => T): Promise<{ result: T; replayed: boolean }> {
    this.assertHuman(context, true);
    try {
      return await this.database.withTenantTransaction(context, async (client: Client) => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const r = await client.query<{ data: Record<string, unknown> }>(sql, [context.externalSubject, ...args, context.idempotencyKey, context.requestId, context.correlationId]);
        return receipt(r.rows[0]?.data, r.rows.length, verify);
      });
    } catch (error) { return translate(error); }
  }
  private assertHuman(context: CustomToolContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 200 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'CUSTOM_TOOL_FORBIDDEN' });
  }
}
