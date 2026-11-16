import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  MEMBERSHIP_AGREEMENT_BLOCKERS, MEMBERSHIP_AGREEMENT_TOKEN, validateSaveMembershipAgreementInput, validateSendMembershipAgreementInput,
  validateSignMembershipAgreementInput, verifyMembershipAgreementCard, verifyMembershipAgreementLink, verifyMembershipAgreementTemplate,
  verifySentMembershipAgreement, type MembershipAgreementCard, type MembershipAgreementLink, type MembershipAgreementTemplate, type SentMembershipAgreement,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_BLOCKERS = new Set<string>(MEMBERSHIP_AGREEMENT_BLOCKERS);

function blockers(hint: unknown): string[] {
  try {
    const parsed: unknown = typeof hint === 'string' ? JSON.parse(hint) : null;
    return Array.isArray(parsed) && parsed.length <= KNOWN_BLOCKERS.size && parsed.every(x => typeof x === 'string' && KNOWN_BLOCKERS.has(x)) ? parsed as string[] : [];
  } catch { return []; }
}
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'MEMBERSHIP_AGREEMENT_FORBIDDEN' });
  if (sqlState === 'P0002') throw new NotFoundException({ code: 'MEMBERSHIP_AGREEMENT_NOT_FOUND' });
  if (sqlState === '55000' && message === 'MEMBERSHIP_AGREEMENT_BLOCKED') throw new ConflictException({ code: 'MEMBERSHIP_AGREEMENT_BLOCKED', blockers: blockers((error as { hint?: unknown }).hint) });
  if (sqlState === '40001' && message === 'MEMBERSHIP_AGREEMENT_STALE') throw new ConflictException({ code: 'MEMBERSHIP_AGREEMENT_STALE' });
  if (sqlState === '23505' && message === 'IDEMPOTENCY_KEY_REUSED') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'MEMBERSHIP_AGREEMENT_CONFLICT' });
  if (['22023', '22P02', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'MEMBERSHIP_AGREEMENT_UNAVAILABLE' });
}
function pair<T>(data: unknown, key: string): { value: unknown; replayed: boolean } {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join() !== [key, 'replayed'].sort().join()
    || typeof (data as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified membership agreement.');
  return { value: (data as Record<string, unknown>)[key], replayed: (data as { replayed: boolean }).replayed };
}

/**
 * M-E (0410): the school's membership agreement, the card's agreement panel, sending a signing link, and the family's
 * public signing link. Each staff call re-proves the direct human subject and the live permission in the database.
 */
@Injectable()
export class MembershipAgreementService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async template(context: MembershipLifecycleContext): Promise<MembershipAgreementTemplate> {
    const subject = this.subject(context);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS); await client.query(HUMAN_SETTINGS, [subject]);
        return verifyMembershipAgreementTemplate(await this.one(client, 'SELECT hon.read_membership_agreement_template($1) AS data', [subject]));
      });
    } catch (error) { return translate(error); }
  }

  async save(context: MembershipLifecycleContext, body: unknown): Promise<{ agreement: MembershipAgreementTemplate; replayed: boolean }> {
    const subject = this.subject(context);
    let input;
    try { input = validateSaveMembershipAgreementInput(body); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS); await client.query(HUMAN_SETTINGS, [subject]);
        const d = pair(await this.one(client, 'SELECT hon.save_membership_agreement_template($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [subject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]), 'agreement');
        const agreement = verifyMembershipAgreementTemplate(d.value);
        const texts = (agreement.texts ?? {}) as Record<string, { title: string; body: string }>;
        if (agreement.signatureRequired !== input.signatureRequired || Object.keys(texts).length !== Object.keys(input.texts).length
          || Object.entries(input.texts).some(([k, v]) => texts[k]?.title !== v.title || texts[k]?.body !== v.body)) throw new Error('Unverified membership agreement.');
        return { agreement, replayed: d.replayed };
      });
    } catch (error) { return translate(error); }
  }

  async card(context: MembershipLifecycleContext, membershipId: string): Promise<MembershipAgreementCard> {
    const subject = this.subject(context);
    if (!UUID.test(membershipId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS); await client.query(HUMAN_SETTINGS, [subject]);
        return verifyMembershipAgreementCard(await this.one(client, 'SELECT hon.read_membership_agreement($1,$2::jsonb) AS data', [subject, JSON.stringify({ membershipId })]), membershipId);
      });
    } catch (error) { return translate(error); }
  }

  async send(context: MembershipLifecycleContext, membershipId: string, body: unknown): Promise<{ request: SentMembershipAgreement; replayed: boolean }> {
    const subject = this.subject(context);
    let input;
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'membershipId')) throw new Error('shape');
      input = validateSendMembershipAgreementInput({ ...(body as Record<string, unknown>), membershipId });
    } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS); await client.query(HUMAN_SETTINGS, [subject]);
        const d = pair(await this.one(client, 'SELECT hon.send_membership_agreement($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [subject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]), 'request');
        return { request: verifySentMembershipAgreement(d.value, input), replayed: d.replayed };
      });
    } catch (error) { return translate(error); }
  }

  /** Public: null for an unknown or malformed token. Never propagates database text. */
  async link(token: string): Promise<MembershipAgreementLink | null> {
    if (typeof token !== 'string' || !MEMBERSHIP_AGREEMENT_TOKEN.test(token)) return null;
    let data: unknown;
    try { data = await this.database.readMembershipAgreementLink(token); } catch { throw new ServiceUnavailableException({ result: 'unavailable' }); }
    if (data === null) return null;
    try { return verifyMembershipAgreementLink(data); } catch { throw new ServiceUnavailableException({ result: 'unavailable' }); }
  }

  /** Public: signed, invalid (does not match what the link shows), gone (unknown, expired, replaced or already signed), or unavailable. */
  async sign(token: string, body: unknown): Promise<'signed' | 'invalid' | 'gone' | 'unavailable'> {
    if (typeof token !== 'string' || !MEMBERSHIP_AGREEMENT_TOKEN.test(token)) return 'gone';
    let input;
    try { input = validateSignMembershipAgreementInput(body); } catch { return 'invalid'; }
    try {
      const result = await this.database.signMembershipAgreement(token, input, randomUUID());
      return result === 'SIGNED' ? 'signed' : result === 'INVALID' ? 'invalid' : result === 'GONE' ? 'gone' : 'unavailable';
    } catch { return 'unavailable'; }
  }

  private subject(context: MembershipLifecycleContext): string {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.delegatedByPrincipalId || context.actionRequestId || !context.externalSubject) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED' });
    }
    return context.externalSubject;
  }
  private async one(client: PoolClient, text: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(text, values);
    if (result.rows.length !== 1) throw new Error('Unverified membership agreement.');
    return result.rows[0]!.data;
  }
}
