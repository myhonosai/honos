export interface CertificateRecord {
  id: string;
  targetRankId: string;
  targetRankName: string;
  title: string;
  issuedAt: string;
  version: number;
  status: 'ISSUED';
}
export interface TestingCertificateView {
  testingCandidateId: string;
  targetRankId: string;
  candidateVersion: number;
  status: 'ELIGIBLE_TO_ISSUE' | 'ISSUED';
  certificate: CertificateRecord | null;
}
export class TestingCertificateAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join('|') === [...expected].sort().join('|');
function invalid(): never { throw new Error('The certificate response was not a verified redacted record. No certificate is assumed.'); }
function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 120 && value.trim() === value
    && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>\[\]{}=`$]/.test(value)
    && !/https?:|www\.|\b(javascript|eval|function|script|automatic|automated|guaranteed|guarantee|legal|credential|license|certified)\b/i.test(value);
}
function certificate(value: unknown): CertificateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !keys(value, ['id', 'targetRankId', 'targetRankName', 'title', 'issuedAt', 'version', 'status'])) invalid();
  const row = value as Record<string, unknown>;
  if (!uuid(row.id) || !uuid(row.targetRankId) || !safeText(row.targetRankName) || !safeText(row.title) || row.status !== 'ISSUED' || !Number.isSafeInteger(row.version) || (row.version as number) < 1 || typeof row.issuedAt !== 'string' || !Number.isFinite(Date.parse(row.issuedAt))) invalid();
  return { id: row.id, targetRankId: row.targetRankId, targetRankName: row.targetRankName, title: row.title, issuedAt: row.issuedAt, version: row.version as number, status: 'ISSUED' };
}
function view(value: unknown, candidateId: string): TestingCertificateView {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !keys(value, ['testingCandidateId', 'targetRankId', 'candidateVersion', 'status', 'certificate'])) invalid();
  const row = value as Record<string, unknown>;
  if (!uuid(row.testingCandidateId) || row.testingCandidateId !== candidateId || !uuid(row.targetRankId) || !Number.isSafeInteger(row.candidateVersion) || (row.candidateVersion as number) < 1 || !['ELIGIBLE_TO_ISSUE', 'ISSUED'].includes(String(row.status)) || ((row.status === 'ISSUED') !== (row.certificate !== null))) invalid();
  return { testingCandidateId: row.testingCandidateId, targetRankId: row.targetRankId, candidateVersion: row.candidateVersion as number, status: row.status as TestingCertificateView['status'], certificate: row.certificate === null ? null : certificate(row.certificate) };
}
function issueInput(input: { expectedCandidateVersion: number; expectedCertificateVersion: number; title: string }) {
  if (!Number.isSafeInteger(input.expectedCandidateVersion) || input.expectedCandidateVersion < 1 || input.expectedCertificateVersion !== 0 || !safeText(input.title)) invalid();
}
async function request(path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
  const url = new URL(path, 'https://hon.invalid');
  if (!path.startsWith('/api/v1/staff/testing/certificates') || url.origin !== 'https://hon.invalid' || url.hash) invalid();
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'testing-certificate', 'Idempotency-Key': idempotencyKey! } : { Accept: 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again.' : response.status === 403 ? 'Current direct human staff certificate permission is unavailable. The record has been cleared.' : response.status === 404 ? 'That known candidate is not eligible or available in your current school.' : response.status === 409 ? 'The candidate, promotion, certificate, or retry key changed. Reload before taking another deliberate action.' : 'No verified certificate result was returned. Nothing was issued.';
    if ([401, 403].includes(response.status)) throw new TestingCertificateAccessError(message, response.status);
    throw new Error(message);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const envelope: unknown = await response.json();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !Object.hasOwn(envelope, 'data')) invalid();
  return (envelope as { data: unknown }).data;
}
export async function loadTestingCertificate(schoolId: string, testingCandidateId: string): Promise<TestingCertificateView> {
  if (!uuid(schoolId) || !uuid(testingCandidateId)) invalid();
  const data = await request(`/api/v1/staff/testing/certificates?schoolId=${encodeURIComponent(schoolId)}&testingCandidateId=${encodeURIComponent(testingCandidateId)}`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !keys(data, ['certificate'])) invalid();
  return view((data as { certificate: unknown }).certificate, testingCandidateId);
}
export async function issueTestingCertificate(schoolId: string, testingCandidateId: string, input: { expectedCandidateVersion: number; expectedCertificateVersion: number; title: string }, idempotencyKey: string): Promise<CertificateRecord> {
  if (!uuid(schoolId) || !uuid(testingCandidateId) || !idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) invalid();
  issueInput(input);
  const data = await request('/api/v1/staff/testing/certificates', { schoolId, testingCandidateId, ...input }, idempotencyKey);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !keys(data, ['certificate'])) invalid();
  return certificate((data as { certificate: unknown }).certificate);
}
