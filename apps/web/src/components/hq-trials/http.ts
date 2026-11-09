import {
  saasUuid, validateTrialCampaignView, validateTrialGovernanceView, validateTrialPublicationPreview,
  type TrialCampaignView, type TrialGovernanceView, type TrialPublicationPreview,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ free-trial governance (D11-A), read only. Each read sends only Accept. The database decides who may read; this page
 * never proposes, approves, publishes or withdraws anything, and the trial program itself stays off (no sign-up, no
 * enrollment, no promotional credits).
 */
export type TrialsErrorKind = /** Session ended. */ 'SESSION' | /** Not an HQ billing reader. */ 'DENIED' | /** Could not be read or checked. */ 'UNKNOWN';
export class TrialsError extends Error { constructor(readonly kind: TrialsErrorKind) { super(kind); } }
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
const id = (value: string) => { try { return saasUuid(value).toLowerCase(); } catch { throw new TrialsError('UNKNOWN'); } };

export const trialsApi = {
  /** Trial rules (proposed versions and decisions), campaign versions and publications: the latest 100 of each. */
  governance(signal: AbortSignal, owned: Owned): Promise<TrialGovernanceView> {
    return read('/api/v1/hq/saas/trials/governance', validateTrialGovernanceView, signal, owned);
  },
  /** One campaign's full history; refused when the answer is for another campaign. */
  campaign(campaignId: string, signal: AbortSignal, owned: Owned): Promise<TrialCampaignView> {
    return Promise.resolve().then(() => {
      const c = id(campaignId);
      return read(`/api/v1/hq/saas/trials/campaigns/${c}`, (v) => {
        const view = validateTrialCampaignView(v);
        if (view.campaignId.toLowerCase() !== c) throw new Error('campaign');
        return view;
      }, signal, owned);
    });
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
};
export type TrialsApi = typeof trialsApi;

/** Whole US dollars from minor units (cents). */
export const dollars = (language: string, minor: number) => new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }).format(minor / 100);
