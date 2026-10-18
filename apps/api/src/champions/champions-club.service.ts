import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  championsUuid, validateChampionsAttributionCaptureInput, validateChampionsAttributionList, validateChampionsAttributionReceipt,
  validateChampionsAttributionStateFilter, validateChampionsDecisionInput, validateChampionsPolicyDraftInput,
  validateChampionsPolicyDraftReceipt, validateChampionsPolicyPublishReceipt, validateChampionsProgram,
  validateChampionsReferralCodeReceipt, validateChampionsSchoolView,
  validateChampionsRewardDecisionInput, validateChampionsRewardDecisionReceipt, validateChampionsRewardLedger,
  validateChampionsRewardPolicyDraftInput, validateChampionsRewardPolicyDraftReceipt, validateChampionsRewardPolicyPublishReceipt,
  validateChampionsRewardProgram, validateChampionsRewardReconcileReceipt, validateChampionsRewardStatusFilter, validateChampionsSchoolRewards,
} from '@hon/contracts';
import { RuntimeDatabaseService, type ChampionsClubOperation } from '../foundation/runtime-database.service.js';

// Business-rule refusals the UI may show verbatim. Any other database message stays private.
const RULE_REFUSALS = new Set(['CHAMPIONS_SELF_REFERRAL','CHAMPIONS_ATTRIBUTION_NOT_ELIGIBLE','CHAMPIONS_POLICY_UNDECIDED',
  'CHAMPIONS_PAYMENT_SOURCE_UNAVAILABLE','CHAMPIONS_QUALIFICATION_NOT_MET','CHAMPIONS_ATTRIBUTION_EXPIRED',
  'CHAMPIONS_REWARD_RULE_UNDECIDED','CHAMPIONS_REWARD_SUBSTITUTE_MISMATCH','CHAMPIONS_PRIZE_OVER_BUDGET','CHAMPIONS_CLAWBACK_NOT_PERMITTED']);
const STATE_CONFLICTS = new Set(['CHAMPIONS_VERSION_CONFLICT','CHAMPIONS_TRANSITION_NOT_ALLOWED','CHAMPIONS_POLICY_NOT_DRAFT']);

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_CHAMPIONS_INPUT' }); }
}

@Injectable()
export class ChampionsClubService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async readSchoolView(subject: string, schoolId: unknown) {
    const school = parse(() => championsUuid(schoolId));
    return this.run('readSchoolView', [subject, school], validateChampionsSchoolView);
  }
  async issueReferralCode(subject: string, schoolId: unknown, key: unknown) {
    const [school, idempotencyKey] = parse(() => [championsUuid(schoolId), championsUuid(key)]);
    return this.run('issueReferralCode', [subject, school, idempotencyKey, randomUUID(), randomUUID()], validateChampionsReferralCodeReceipt);
  }
  async readProgram(subject: string) {
    return this.run('readProgram', [subject], validateChampionsProgram);
  }
  async createPolicyDraft(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateChampionsPolicyDraftInput(body), championsUuid(key)] as const);
    return this.run('createPolicyDraft', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateChampionsPolicyDraftReceipt);
  }
  async publishPolicy(subject: string, policyId: unknown, key: unknown) {
    const [policy, idempotencyKey] = parse(() => [championsUuid(policyId), championsUuid(key)]);
    return this.run('publishPolicy', [subject, policy, idempotencyKey, randomUUID(), randomUUID()], validateChampionsPolicyPublishReceipt);
  }
  async readAttributions(subject: string, state: unknown) {
    const filter = parse(() => validateChampionsAttributionStateFilter(state));
    return this.run('readAttributions', [subject, filter], validateChampionsAttributionList);
  }
  async captureAttribution(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateChampionsAttributionCaptureInput(body), championsUuid(key)] as const);
    return this.run('captureAttribution', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateChampionsAttributionReceipt);
  }
  async decideAttribution(subject: string, attributionId: unknown, body: unknown, key: unknown) {
    const [attribution, input, idempotencyKey] = parse(() => [championsUuid(attributionId), validateChampionsDecisionInput(body), championsUuid(key)] as const);
    return this.run('decideAttribution', [subject, attribution, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateChampionsAttributionReceipt);
  }

  // ---------- reward accounting (Milestone 2; liabilities only) ----------
  async readRewardProgram(subject: string) {
    return this.run('readRewardProgram', [subject], validateChampionsRewardProgram);
  }
  async createRewardPolicyDraft(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateChampionsRewardPolicyDraftInput(body), championsUuid(key)] as const);
    return this.run('createRewardPolicyDraft', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateChampionsRewardPolicyDraftReceipt);
  }
  async publishRewardPolicy(subject: string, policyId: unknown, key: unknown) {
    const [policy, idempotencyKey] = parse(() => [championsUuid(policyId), championsUuid(key)]);
    return this.run('publishRewardPolicy', [subject, policy, idempotencyKey, randomUUID(), randomUUID()], validateChampionsRewardPolicyPublishReceipt);
  }
  async reconcileRewards(subject: string, schoolId: unknown, key: unknown) {
    const [school, idempotencyKey] = parse(() => [championsUuid(schoolId), championsUuid(key)]);
    return this.run('reconcileRewards', [subject, school, idempotencyKey, randomUUID(), randomUUID()], validateChampionsRewardReconcileReceipt);
  }
  async decideReward(subject: string, entryId: unknown, body: unknown, key: unknown) {
    const [entry, input, idempotencyKey] = parse(() => [championsUuid(entryId), validateChampionsRewardDecisionInput(body), championsUuid(key)] as const);
    return this.run('decideReward', [subject, entry, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateChampionsRewardDecisionReceipt);
  }
  async readRewardLedger(subject: string, status: unknown) {
    const filter = parse(() => validateChampionsRewardStatusFilter(status));
    return this.run('readRewardLedger', [subject, filter], validateChampionsRewardLedger);
  }
  async readSchoolRewards(subject: string, schoolId: unknown) {
    const school = parse(() => championsUuid(schoolId));
    return this.run('readSchoolRewards', [subject, school], validateChampionsSchoolRewards);
  }

  private async run<T>(operation: ChampionsClubOperation, params: (string | null)[], validate: (value: unknown) => T): Promise<T> {
    let data: unknown;
    try { data = await this.database.callChampionsClub(operation, params); }
    catch (error) {
      const { code, message } = (error ?? {}) as { code?: string; message?: string };
      if (code === '42501') throw new ForbiddenException({ code: 'CHAMPIONS_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'CHAMPIONS_UNAVAILABLE' });
      if (code === '40001') throw new ConflictException({ code: STATE_CONFLICTS.has(message ?? '') ? message : 'CHAMPIONS_VERSION_CONFLICT' });
      if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      if (code === '23P01') throw new ConflictException({ code: 'CHAMPIONS_DUPLICATE_ATTRIBUTION' });
      if (code === '55P03' || code === '57014') throw new ConflictException({ code: 'CHAMPIONS_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key; do not assume the command took effect.' });
      if (code === '23514' && RULE_REFUSALS.has(message ?? '')) throw new UnprocessableEntityException({ code: message });
      if (['22023','22P02','22003','23514'].includes(code ?? '')) throw new BadRequestException({ code: 'INVALID_CHAMPIONS_INPUT' });
      throw new ServiceUnavailableException({ code: 'CHAMPIONS_UNAVAILABLE' });
    }
    try { return validate(data); } catch { throw new ServiceUnavailableException({ code: 'CHAMPIONS_UNAVAILABLE' }); }
  }
}
