import { communityUuid, verifyRetentionAttentionAlerts, verifyRetentionAttentionEvidence, verifyRetentionAttentionRecordInput, verifyRetentionAttentionResolutionInput, verifyRetentionAttentionRecord, verifyRetentionAttentionResolution, type RetentionAttentionRecordInput, type RetentionAttentionResolutionInput } from '@hon/contracts';
import { retentionReviewPath, RetentionReviewUiError } from './retention-review-signals-http';
function path(schoolId: string, membershipId: string, route: string) { return retentionReviewPath(schoolId,membershipId).replace('?',`/${route}?`); }
async function envelope(response: Response, key: string): Promise<unknown> {
  if (!response.ok) throw new RetentionReviewUiError(response.status === 409 ? 'Evidence, alert version or retry changed. Reload verified evidence and alert state.' : response.status === 403 ? 'Current exact attention permission or active school authority is unavailable.' : response.status === 401 ? 'Sign in with a verified human staff session.' : 'No verified attention alert state is shown; the result may be unknown. Reload verified context.',response.status);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'data,meta') throw new Error('Unverified attention envelope.');
  const { data, meta } = value as { data: Record<string,unknown>; meta: Record<string,unknown> };
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).join(',') !== key || !meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).sort().join(',') !== 'correlationId,requestId') throw new Error('Unverified attention envelope.');
  communityUuid(meta.requestId); communityUuid(meta.correlationId);
  return data[key];
}
const readOptions = { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } } as const;
function commandOptions(marker: string, input: unknown): RequestInit { return { method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': marker }, body: JSON.stringify(input) }; }
export async function loadRetentionAttentionAlerts(schoolId: string, membershipId: string) {
  return verifyRetentionAttentionAlerts(await envelope(await fetch(path(schoolId,membershipId,'attention-alerts'),readOptions),'retentionAttentionAlerts'),membershipId);
}
export async function loadRetentionAttentionEvidence(schoolId: string, membershipId: string) {
  return verifyRetentionAttentionEvidence(await envelope(await fetch(path(schoolId,membershipId,'attention-evidence'),readOptions),'retentionAttentionEvidence'),membershipId);
}
export async function recordRetentionAttentionAlert(schoolId: string, membershipId: string, value: RetentionAttentionRecordInput) {
  const input = verifyRetentionAttentionRecordInput(value);
  return verifyRetentionAttentionRecord(await envelope(await fetch(path(schoolId,membershipId,'attention-alerts/record'),commandOptions('retention-attention-record',input)),'retentionAttentionRecord'),membershipId,input);
}
export async function resolveRetentionAttentionAlert(schoolId: string, membershipId: string, value: RetentionAttentionResolutionInput) {
  const input = verifyRetentionAttentionResolutionInput(value);
  return verifyRetentionAttentionResolution(await envelope(await fetch(path(schoolId,membershipId,'attention-alerts/resolve'),commandOptions('retention-attention-resolve',input)),'retentionAttentionResolution'),membershipId,input);
}
