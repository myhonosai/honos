import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateLoadSchoolDemoDataInput, validateRemoveSchoolDemoDataInput, verifySchoolDemoDataInUseTables, verifySchoolDemoDataView,
  type SchoolDemoDataView,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
// A load writes about 1,500 rows and a removal finds and deletes them again; each is still one transaction or nothing.
const WRITE_LIMITS = "SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0446 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  DEMO_DATA_FORBIDDEN: code => new ForbiddenException({ code, detail: 'The demo data permission at this school and an active subscription or trial are required.' }),
  DEMO_DATA_ALREADY_LOADED: code => new ConflictException({ code, detail: 'Demo data is already loaded. Remove it before loading it again.' }),
  DEMO_DATA_NOT_LOADED: code => new NotFoundException({ code, detail: 'This demo data is no longer loaded. Reload the page.' }),
  DEMO_DATA_REMOVE_FAILED: code => new ConflictException({ code, detail: 'The demo data could not be removed. Nothing was changed.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The demo data changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function inUse(detail: unknown): never {
  let tables: string[];
  try { tables = verifySchoolDemoDataInUseTables((JSON.parse(String(detail)) as { tables?: unknown }).tables); }
  catch { throw new ConflictException({ code: 'DEMO_DATA_IN_USE', tables: [] }); }
  throw new ConflictException({ code: 'DEMO_DATA_IN_USE', tables,
    detail: 'Some of your own records point at demo records. Move or remove them, then remove the demo data. Nothing was changed.' });
}
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (message === 'DEMO_DATA_IN_USE' && sqlState === '40001') inUse((error as { detail?: unknown }).detail);
  const known = ERRORS[message];
  if (known && ['22023', '42501', '40001', '23505', 'P0002', '55000'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'DEMO_DATA_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'DEMO_DATA_CONFLICT' });
  if (['22023', '22P02', '22003', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'DEMO_DATA_UNAVAILABLE', detail: 'No success is assumed. Reload, or retry the unchanged request with the same key.' });
}

/**
 * 0446: school demo data. Each read, load and remove is one protected definer call that re-proves the direct human subject,
 * the live school.demo_data.manage permission and the school's access, before and after its writes. The runtime role has
 * no table privilege on the demo registry or on any table the demo rows live in.
 */
@Injectable()
export class SchoolDemoDataService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext): Promise<SchoolDemoDataView> {
    this.assertHumanContext(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_demo_data($1) AS data', [context.externalSubject]);
        if (result.rows.length !== 1) throw new Error('Unverified school demo data.');
        return verifySchoolDemoDataView(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  async load(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: SchoolDemoDataView; replayed: boolean }> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateLoadSchoolDemoDataInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(context, 'SELECT hon.load_school_demo_data($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input, 'LOADED');
  }

  async remove(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: SchoolDemoDataView; replayed: boolean }> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateRemoveSchoolDemoDataInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(context, 'SELECT hon.remove_school_demo_data($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input, 'NONE');
  }

  private async write(context: MembershipLifecycleContext, statement: string, input: object, expect: 'LOADED' | 'NONE'): Promise<{ receipt: SchoolDemoDataView; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified school demo data receipt.');
        }
        return { receipt: verifySchoolDemoDataView(data.record, expect), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private assertHumanContext(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Demo data accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 2048) throw new ForbiddenException({ code: 'DEMO_DATA_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
