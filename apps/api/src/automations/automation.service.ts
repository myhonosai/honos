import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateAutomationArchiveInput, validateAutomationCreateInput, validateAutomationRestoreInput, validateAutomationSaveInput,
  validateContactTagInput, validateContactTagLookupInput, verifyAutomationVersion, verifyAutomationWorkflowDetail, verifyAutomationWorkflowList,
  verifyContactTagChange, verifyContactTagLookup, verifyPersonContactTags, verifySchoolContactTags,
  type AutomationVersion, type AutomationWorkflowDetail, type AutomationWorkflowList, type ContactTagChange, type ContactTagLookup,
  type PersonContactTags, type SchoolContactTags,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

export type AutomationContext = MembershipLifecycleContext;

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, [string[], (code: string) => HttpException]> = {
  AUTOMATION_INVALID: [['22023'], code => new BadRequestException({ code, detail: 'The workflow or tag does not match what HON accepts. Check each step and try again.' })],
  AUTOMATION_FORBIDDEN: [['42501'], code => new ForbiddenException({ code, detail: 'Automation or contact-tag permission at this school, with HON OS access, is required.' })],
  AUTOMATION_BUSY: [['55P03'], code => new ConflictException({ code, detail: 'The same request is still being processed. Try again shortly with the same key.' })],
  IDEMPOTENCY_KEY_REUSED: [['23505'], code => new ConflictException({ code, detail: 'The idempotency key was already used for a different request.' })],
  AUTOMATION_LIMIT_REACHED: [['54000'], code => new HttpException({ code, detail: 'This school reached the workflow or version limit.' }, HttpStatus.UNPROCESSABLE_ENTITY)],
  CONTACT_TAG_LIMIT_REACHED: [['54000'], code => new HttpException({ code, detail: 'A contact can have 20 tags and a school 200 different tags.' }, HttpStatus.UNPROCESSABLE_ENTITY)],
  AUTOMATION_STALE: [['40001'], code => new ConflictException({ code, detail: 'Someone changed this workflow. Reload it and try again.' })],
  AUTOMATION_ARCHIVED: [['23514'], code => new ConflictException({ code, detail: 'This workflow is archived and can no longer change.' })],
  AUTOMATION_NOT_DRAFT: [['23514'], code => new ConflictException({ code, detail: 'Only a draft can be archived. Turn the workflow off first.' })],
  AUTOMATION_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  AUTOMATION_VERSION_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  CONTACT_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '', message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known[0].includes(sqlState)) throw known[1](message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'AUTOMATION_FORBIDDEN' });
  if (['22023', '22P02', '22003'].includes(sqlState)) throw new BadRequestException({ code: 'AUTOMATION_INVALID' });
  throw new ServiceUnavailableException({ code: 'AUTOMATION_UNAVAILABLE', detail: 'Nothing is assumed saved. Reload, or retry the unchanged request with the same key.' });
}
function receipt<T>(data: Record<string, unknown> | undefined, rows: number, verify: (v: unknown) => T): { record: T; replayed: boolean } {
  if (rows !== 1 || !data || Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified automation receipt.');
  return { record: verify(data.record), replayed: data.replayed };
}
function invalid(): never { throw new BadRequestException({ code: 'AUTOMATION_INVALID' }); }

/**
 * Automation workflow definitions and contact tags (0367). Each call runs one protected definer function that re-proves
 * the direct human subject, the exact permission at the session school and active HON OS (COMPLETE) access. Saving a
 * workflow runs nothing; the engine (0368) turns workflows on.
 */
@Injectable()
export class AutomationService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  listWorkflows(context: AutomationContext): Promise<AutomationWorkflowList> {
    return this.read(context, 'SELECT hon.read_automation_workflows($1) AS data', [], verifyAutomationWorkflowList);
  }
  async getWorkflow(context: AutomationContext, workflowId: string): Promise<AutomationWorkflowDetail> {
    const detail = await this.read(context, 'SELECT hon.read_automation_workflow($1,$2::uuid) AS data', [workflowId], verifyAutomationWorkflowDetail);
    if (detail.workflow.workflowId.toLowerCase() !== workflowId.toLowerCase()) throw new Error('Unverified automation receipt.');
    return detail;
  }
  async getVersion(context: AutomationContext, workflowId: string, version: number): Promise<AutomationVersion> {
    const v = await this.read(context, 'SELECT hon.read_automation_workflow_version($1,$2::uuid,$3::integer) AS data', [workflowId, version], verifyAutomationVersion);
    if (v.workflowId.toLowerCase() !== workflowId.toLowerCase() || v.version !== version) throw new Error('Unverified automation receipt.');
    return v;
  }
  async create(context: AutomationContext, value: unknown) {
    let input; try { input = validateAutomationCreateInput(value); } catch { invalid(); }
    return this.command(context, 'SELECT hon.create_automation_workflow($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', [], input, verifyAutomationWorkflowDetail);
  }
  async save(context: AutomationContext, workflowId: string, value: unknown) {
    let input; try { input = validateAutomationSaveInput(value); } catch { invalid(); }
    return this.workflowCommand(context, 'save_automation_workflow_version', workflowId, input);
  }
  async restore(context: AutomationContext, workflowId: string, value: unknown) {
    let input; try { input = validateAutomationRestoreInput(value); } catch { invalid(); }
    return this.workflowCommand(context, 'restore_automation_workflow_version', workflowId, input);
  }
  async archive(context: AutomationContext, workflowId: string, value: unknown) {
    let input; try { input = validateAutomationArchiveInput(value); } catch { invalid(); }
    return this.workflowCommand(context, 'archive_automation_workflow', workflowId, input);
  }

  schoolTags(context: AutomationContext): Promise<SchoolContactTags> {
    return this.read(context, 'SELECT hon.read_school_contact_tags($1) AS data', [], verifySchoolContactTags);
  }
  async personTags(context: AutomationContext, personId: string): Promise<PersonContactTags> {
    const tags = await this.read(context, 'SELECT hon.read_person_contact_tags($1,$2::uuid) AS data', [personId], verifyPersonContactTags);
    if (tags.personId.toLowerCase() !== personId.toLowerCase()) throw new Error('Unverified automation receipt.');
    return tags;
  }
  async lookupTags(context: AutomationContext, value: unknown): Promise<ContactTagLookup> {
    let input; try { input = validateContactTagLookupInput(value); } catch { invalid(); }
    // A read sent as POST so 200 ids fit; it writes nothing and takes no idempotency key.
    const result = await this.read(context, 'SELECT hon.lookup_contact_tags($1,$2::jsonb) AS data', [JSON.stringify(input)], verifyContactTagLookup);
    const asked = new Set(input.personIds);
    if (result.people.some(p => !asked.has(p.personId))) throw new Error('Unverified automation receipt.');
    return result;
  }
  addTag(context: AutomationContext, personId: string, value: unknown) { return this.tagCommand(context, 'add_contact_tag', personId, value); }
  removeTag(context: AutomationContext, personId: string, value: unknown) { return this.tagCommand(context, 'remove_contact_tag', personId, value); }

  private async tagCommand(context: AutomationContext, fn: 'add_contact_tag' | 'remove_contact_tag', personId: string, value: unknown): Promise<{ record: ContactTagChange; replayed: boolean }> {
    let input; try { input = validateContactTagInput(value); } catch { invalid(); }
    const result = await this.command(context, `SELECT hon.${fn}($1,$6::uuid,$2::jsonb,$3,$4::uuid,$5::uuid) AS data`, [personId], input, verifyContactTagChange);
    if (result.record.personId.toLowerCase() !== personId.toLowerCase()) throw new Error('Unverified automation receipt.');
    return result;
  }
  private async workflowCommand(context: AutomationContext, fn: string, workflowId: string, input: unknown): Promise<{ record: AutomationWorkflowDetail; replayed: boolean }> {
    const result = await this.command(context, `SELECT hon.${fn}($1,$6::uuid,$2::jsonb,$3,$4::uuid,$5::uuid) AS data`, [workflowId], input, verifyAutomationWorkflowDetail);
    if (result.record.workflow.workflowId.toLowerCase() !== workflowId.toLowerCase()) throw new Error('Unverified automation receipt.');
    return result;
  }
  private async command<T>(context: AutomationContext, sql: string, extra: unknown[], input: unknown, verify: (v: unknown) => T): Promise<{ record: T; replayed: boolean }> {
    this.assertHuman(context, true);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const r = await client.query<{ data: Record<string, unknown> }>(sql,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId, ...extra]);
        return receipt(r.rows[0]?.data, r.rows.length, verify);
      });
    } catch (error) { return translate(error); }
  }
  private async read<T>(context: AutomationContext, sql: string, extra: unknown[], verify: (v: unknown) => T): Promise<T> {
    this.assertHuman(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const r = await client.query<{ data: unknown }>(sql, [context.externalSubject, ...extra]);
        if (r.rows.length !== 1) throw new Error('Unverified automation receipt.');
        return verify(r.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }
  private assertHuman(context: AutomationContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 200 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'AUTOMATION_FORBIDDEN' });
  }
}
