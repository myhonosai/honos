import { ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { familyReferralShareUrl, verifyParentReferralLink, verifyParentReferrals, verifyParentReferralsRecord, type ParentReferralLink, type ParentReferrals } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

export function translateParentReferralsError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '22023' && message === 'REFERRALS_NOT_AVAILABLE') throw new UnprocessableEntityException({ code: 'PARENT_REFERRALS_NOT_AVAILABLE', detail: 'Your school is not running a referral program right now.' });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'PARENT_REFERRALS_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'PARENT_REFERRALS_CONFLICT', detail: 'Please try again.' });
  throw new ServiceUnavailableException({ code: 'PARENT_REFERRALS_UNAVAILABLE', detail: 'No verified referral answer is available.' });
}

/**
 * 0604 family referrals, family side. The one current family of the verified session decides the school; no selector is
 * trusted. The database answers with the family code; the API turns it into the share link on the HON site and never
 * returns the bare code. Nothing here sends a message or moves money.
 */
@Injectable()
export class ParentReferralsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /** The HON site origin the link points at; missing or malformed configuration means no link, never a guessed one. */
  origin(): string | null {
    const origin = process.env.HON_PUBLIC_ORIGIN;
    if (!origin || (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) return null;
    return origin;
  }

  async read(subject: string): Promise<ParentReferrals> {
    const raw = await this.call(subject, false, 'SELECT hon.read_parent_referrals($1) AS data');
    try {
      const record = verifyParentReferralsRecord(raw);
      const origin = this.origin();
      const { code, ...rest } = record;
      return verifyParentReferrals({ ...rest, shareUrl: code && origin ? familyReferralShareUrl(origin, code) : null });
    } catch { throw new ServiceUnavailableException({ code: 'PARENT_REFERRALS_UNAVAILABLE', detail: 'No verified referral answer is available.' }); }
  }

  async link(subject: string): Promise<ParentReferralLink> {
    const origin = this.origin();
    if (!origin) throw new ServiceUnavailableException({ code: 'PARENT_REFERRALS_NOT_CONFIGURED', detail: 'Referral links are not set up here.' });
    const raw = await this.call(subject, true, 'SELECT hon.issue_parent_referral_link($1) AS data') as { code?: unknown } | null;
    try {
      if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 1 || typeof raw.code !== 'string') throw new Error('Unverified referral link.');
      return verifyParentReferralLink({ shareUrl: familyReferralShareUrl(origin, raw.code) });
    } catch { throw new ServiceUnavailableException({ code: 'PARENT_REFERRALS_UNAVAILABLE', detail: 'No verified referral answer is available.' }); }
  }

  private async call(subject: string, write: boolean, statement: string): Promise<unknown> {
    if (typeof subject !== 'string' || !subject || subject.length > 200 || subject.trim() !== subject) throw new ForbiddenException({ code: 'PARENT_REFERRALS_FORBIDDEN' });
    try {
      const scopes: ResolvedParentFamilyScope[] = await this.database.resolveParentJourneyScopes(subject);
      if (scopes.length !== 1) throw new ForbiddenException({ code: 'PARENT_REFERRALS_FORBIDDEN' });
      const scope = scopes[0]!;
      const context = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId: randomUUID() };
      const work = async (client: PoolClient) => {
        await client.query(LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>(statement, [subject]);
        if (result.rows.length !== 1) throw new Error('Unverified referral answer.');
        return result.rows[0]!.data;
      };
      return write ? await this.database.withTenantTransaction(context, work) : await this.database.withTenantReadOnlyTransaction(context, work);
    } catch (error) { return translateParentReferralsError(error); }
  }
}
