import {
  SAAS_COMMANDS, saasUuid, validateTrialCampaignDraftInput, validateTrialCampaignPublishInput, validateTrialCampaignWithdrawInput,
  validateTrialDecisionReceipt, validateTrialDraftReceipt, validateTrialGovernanceView, validateTrialPolicyDecisionInput, validateTrialPolicyProposalInput,
  validateTrialPolicyReceipt, validateTrialPublicationPreview, validateTrialPublicationReceipt,
  type TrialCampaignDraftInput, type TrialCampaignPublishInput, type TrialCampaignWithdrawInput, type TrialGovernanceView,
  type TrialPolicyDecisionInput, type TrialPolicyProposalInput, type TrialPublicationPreview,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ free-trial governance (D11-A). Reads send only Accept; each command sends its own X-HON-Human-Command and an
 * Idempotency-Key, and the database decides every authority again (HQ billing readers read, only the HQ owner records).
 * Commands record governance definitions only: the trial program itself stays off (no sign-up, no enrollment, no
 * promotional credits), whatever is proposed, approved or published here.
 */
export type TrialsErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed (not an HQ billing reader, or not the HQ owner for a command). Nothing changed. */ | 'DENIED'
  /** The rules or campaign changed since they were read. Nothing changed. */ | 'CHANGED'
  /** A trial rule refused it (no approved rules, an invalid window, or blockers). Nothing changed. */ | 'REFUSED'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class TrialsError extends Error { constructor(readonly kind: TrialsErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 4_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json' } });
  } catch (error) { if (signal.aborted) throw error; throw new TrialsError('UNKNOWN'); }
  // A retired read never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new TrialsError('SESSION'); }
  if (r.status === 403) throw new TrialsError('DENIED');
  if (r.status !== 200 || r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) throw new TrialsError('UNKNOWN');
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new TrialsError('UNKNOWN');
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
    return verify((value as { data: unknown }).data);
  } catch { throw new TrialsError('UNKNOWN'); }
}
/** Definite answers raised before any write. Anything else (busy, 5xx, an unknown code, drift) is UNKNOWN. */
const CHANGED = new Set(['SAAS_VERSION_CONFLICT', 'SAAS_TRIAL_POLICY_STALE', 'SAAS_TRIAL_PREVIEW_STALE']);
const REFUSED = new Set(['SAAS_TRIAL_POLICY_REQUIRED', 'SAAS_TRIAL_POLICY_WINDOW_INVALID', 'SAAS_TRIAL_PUBLICATION_BLOCKED', 'SAAS_TRIAL_EVIDENCE_REQUIRED']);
export function trialsErrorFor(status: number, code: string | null): TrialsError {
  if (status === 403) return new TrialsError('DENIED', code);
  if (status === 400) return new TrialsError('INVALID', code);
  if (status === 429) return new TrialsError('RATE', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new TrialsError('CHANGED', code);
  if (status === 409 && code !== null && CHANGED.has(code)) return new TrialsError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new TrialsError('INVALID', code);
  if (status === 422 && code !== null && REFUSED.has(code)) return new TrialsError('REFUSED', code);
  return new TrialsError('UNKNOWN', code);
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
async function command<T>(path: string, marker: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': marker, 'Idempotency-Key': key }, body: JSON.stringify(body) });
  } catch { throw new TrialsError('UNKNOWN'); }
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new TrialsError('SESSION'); }
  let value: unknown = null;
  if (!r.redirected && JSON_TYPE.test(r.headers.get('content-type') ?? '')) {
    try { const text = await r.text(); if (text.length <= RESPONSE_MAX) value = JSON.parse(text) as unknown; } catch { value = null; }
  }
  if (r.status !== 200) throw trialsErrorFor(r.status, codeOf(value));
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
    return verify((value as { data: unknown }).data);
  } catch { throw new TrialsError('UNKNOWN'); }
}
function checked<T>(work: () => T): T { try { return work(); } catch { throw new TrialsError('INVALID'); } }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const id = (value: string) => { try { return saasUuid(value).toLowerCase(); } catch { throw new TrialsError('UNKNOWN'); } };

export const trialsApi = {
  /** Trial rules (proposed versions and decisions), campaign versions and publications: the latest 100 of each. */
  governance(signal: AbortSignal, owned: Owned): Promise<TrialGovernanceView> {
    return read('/api/v1/hq/saas/trials/governance', validateTrialGovernanceView, signal, owned);
  },
  /** What publishing one campaign version would need: blockers, planned exposure. Reading it changes nothing. */
  preview(versionId: string, signal: AbortSignal, owned: Owned): Promise<TrialPublicationPreview> {
    return Promise.resolve().then(() => {
      const v = id(versionId);
      return read(`/api/v1/hq/saas/trials/campaign-versions/${v}/publication-preview`, (value) => {
        const preview = validateTrialPublicationPreview(value);
        if (preview.versionId.toLowerCase() !== v) throw new Error('version');
        return preview;
      }, signal, owned);
    });
  },
  /** Propose a new rules version after the latest one (expectedVersion). Approving it is a separate decision. */
  async propose(input: TrialPolicyProposalInput, key: string, signal: AbortSignal, owned: Owned) {
    const [body, k] = checked(() => [validateTrialPolicyProposalInput(input), saasUuid(key)] as const);
    return command('/api/v1/hq/saas/trials/policy-versions', SAAS_COMMANDS.proposeTrialPolicy, body, k, (v) => {
      const r = validateTrialPolicyReceipt(v);
      if (r.policyVersion.version !== body.expectedVersion + 1 || r.policyVersion.reason !== body.reason) throw new Error('mismatch');
      return r;
    }, signal, owned);
  },
  /** Approve the latest rules for a window, or withdraw or revoke the current approval. */
  async decide(input: TrialPolicyDecisionInput, key: string, signal: AbortSignal, owned: Owned) {
    const [body, k] = checked(() => [validateTrialPolicyDecisionInput(input), saasUuid(key)] as const);
    return command('/api/v1/hq/saas/trials/policy-decisions', SAAS_COMMANDS.decideTrialPolicy, body, k, (v) => {
      const r = validateTrialDecisionReceipt(v);
      if (r.decision.decision !== body.decision || r.decision.revision !== body.expectedRevision + 1
        || (body.decision === 'APPROVED' && (!same(r.decision.policyId, body.policyId) || Date.parse(r.decision.validFrom) !== Date.parse(body.validFrom)
          || Date.parse(r.decision.validUntil) !== Date.parse(body.validUntil)))) throw new Error('mismatch');
      return r;
    }, signal, owned);
  },
  /** Draft a new campaign (campaignId null) or its next version. A draft is never live. */
  async draft(input: TrialCampaignDraftInput, key: string, signal: AbortSignal, owned: Owned) {
    const [body, k] = checked(() => [validateTrialCampaignDraftInput(input), saasUuid(key)] as const);
    return command('/api/v1/hq/saas/trials/campaign-versions', SAAS_COMMANDS.draftTrialCampaign, body, k, (v) => {
      const r = validateTrialDraftReceipt(v);
      if (r.campaignVersion.version !== body.expectedVersion + 1 || (body.campaignId !== null && !same(r.campaignVersion.campaignId, body.campaignId))
        || r.campaignVersion.definition.name !== body.definition.name) throw new Error('mismatch');
      return r;
    }, signal, owned);
  },
  /** Record a campaign definition as published, bound to the readiness preview read (its digest). Nothing goes live. */
  async publish(campaignId: string, input: TrialCampaignPublishInput, key: string, signal: AbortSignal, owned: Owned) {
    const [c, body, k] = checked(() => [saasUuid(campaignId), validateTrialCampaignPublishInput(input), saasUuid(key)] as const);
    return command(`/api/v1/hq/saas/trials/campaigns/${c}/publish`, SAAS_COMMANDS.publishTrialCampaign, body, k, (v) => {
      const r = validateTrialPublicationReceipt(v);
      if (r.publication.kind !== 'PUBLISHED' || !same(r.publication.campaignId, c) || !same(r.publication.versionId, body.versionId)
        || r.publication.revision !== body.expectedRevision + 1) throw new Error('mismatch');
      return r;
    }, signal, owned);
  },
  /** Withdraw a published campaign definition. */
  async withdraw(campaignId: string, input: TrialCampaignWithdrawInput, key: string, signal: AbortSignal, owned: Owned) {
    const [c, body, k] = checked(() => [saasUuid(campaignId), validateTrialCampaignWithdrawInput(input), saasUuid(key)] as const);
    return command(`/api/v1/hq/saas/trials/campaigns/${c}/withdraw`, SAAS_COMMANDS.withdrawTrialCampaign, body, k, (v) => {
      const r = validateTrialPublicationReceipt(v);
      if (r.publication.kind !== 'WITHDRAWN' || !same(r.publication.campaignId, c) || r.publication.revision !== body.expectedRevision + 1) throw new Error('mismatch');
      return r;
    }, signal, owned);
  },
};
export type TrialsApi = typeof trialsApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof TrialsError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
/** Dollar text ("250" or "250.50") to cents; null when it is not a positive amount with at most two decimals. */
export function toMinor(text: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
/** A date input ("2026-11-15") as the start of that UTC day. */
export function utcDay(text: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) return null;
  const at = Date.parse(`${text.trim()}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().startsWith(text.trim()) ? new Date(at).toISOString() : null;
}

/** Whole US dollars from minor units (cents). */
export const dollars = (language: string, minor: number) => new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }).format(minor / 100);
