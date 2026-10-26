import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { validateLeadIntakeMonitorForm, validatePublicFormConfig, validatePublicFormSubmission, validatePublishedLeadForm, validateStaffLeadForm, type LeadIntakeMonitorForm, type PublicFormContext, type StaffLeadForm, type PublishedLeadForm, type PublicFormResult } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { campaignUuid } from './campaign.dto.js';
@Injectable()
export class PublicFormService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async staff<T>(c: PublicFormContext, sql: string, args: unknown[]): Promise<T> {
    if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'FORM_FORBIDDEN' });
    for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) campaignUuid(id);
    try {
      return await this.database.withTenantTransaction(c, async client => {
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
        return (await client.query<{ data: T }>(sql, args)).rows[0]!.data;
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '42501') throw new ForbiddenException({ code: 'FORM_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'FORM_NOT_FOUND' });
      if (['40001','23505','55P03','40P01'].includes(code ?? '')) throw new ConflictException({ code: 'FORM_CONFLICT' });
      if (['22023','22P02','23514','23503'].includes(code ?? '')) throw new BadRequestException({ code: 'FORM_INVALID' });
      throw new ServiceUnavailableException({ code: 'FORM_UNAVAILABLE' });
    }
  }
  list(c: PublicFormContext): Promise<StaffLeadForm[]> {
    return this.staff(c, 'SELECT hon.read_public_forms($1) data', [c.externalSubject]);
  }
  async intakeMonitor(c: PublicFormContext): Promise<LeadIntakeMonitorForm[]> {
    const forms = await this.list(c);
    try {
      return forms.map(form => {
        // Validate the internal fixed-function response before deliberately
        // dropping all identifiers and private configuration from this route.
        validateStaffLeadForm(form);
        const projected: LeadIntakeMonitorForm = {
          title: form.title,
          status: form.status,
          acceptedCount: form.acceptedCount,
          hasCampaignAssociation: form.campaignId !== null,
        };
        validateLeadIntakeMonitorForm(projected);
        return projected;
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'FORM_UNAVAILABLE' });
    }
  }
  mutate(c: PublicFormContext, operation: 'configure'|'publish'|'disable', id: string|null, input: unknown): Promise<{ form: StaffLeadForm; replayed: boolean }> {
    if (id !== null) campaignUuid(id);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(c.idempotencyKey)) throw new BadRequestException({ code: 'FORM_INVALID' });
    if (operation === 'configure') { try { validatePublicFormConfig(input); } catch { throw new BadRequestException({ code: 'FORM_INVALID' }); } }
    else if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Number.isInteger((input as {expectedVersion:number}).expectedVersion) || (input as {expectedVersion:number}).expectedVersion < 1 || (input as {expectedVersion:number}).expectedVersion > 999999998) throw new BadRequestException({ code: 'FORM_INVALID' });
    return this.staff(c, 'SELECT hon.mutate_public_form($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) data', [c.externalSubject, operation, id, JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId]);
  }
  async published(publicId: string): Promise<PublishedLeadForm | null> {
    if (typeof publicId !== 'string' || publicId.length !== 48 || !/^[a-f0-9]{48}$/.test(publicId)) return null;
    try {
      const data = await this.database.readPublishedLeadForm(publicId);
      if (data !== null) { validatePublishedLeadForm(data); if (data.publicId !== publicId) throw new Error('INVALID'); }
      return data;
    }
    catch { throw new ServiceUnavailableException({ result: 'unavailable' }); }
  }
  async submit(publicId: string, input: unknown, key: unknown): Promise<PublicFormResult> {
    if (typeof publicId !== 'string' || publicId.length !== 48 || !/^[a-f0-9]{48}$/.test(publicId) || typeof key !== 'string' || key.trim() !== key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) return 'invalid';
    try { validatePublicFormSubmission(input); if (Buffer.byteLength(JSON.stringify(input)) > 8192) return 'invalid'; }
    catch { return 'invalid'; }
    try {
      const result = await this.database.submitPublishedLeadForm(publicId, input, key);
      return result === 'ACCEPTED' ? 'accepted' : result === 'RATE_LIMITED' ? 'rate-limited' : result === 'INVALID' ? 'invalid' : 'unavailable';
    } catch { return 'unavailable'; } // Never propagate PostgreSQL DETAIL, body, contact, hash or lead state.
  }
}
