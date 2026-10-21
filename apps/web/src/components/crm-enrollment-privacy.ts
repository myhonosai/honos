import { PlanAccessError, PlanReadError } from './membership-plans/http';

/** Existing signed-session web read. Identity is a continuity check, never school authority. */
export async function verifyEnrollmentSession(subject: string | undefined, signal: AbortSignal): Promise<void> {
  if (!subject) throw new PlanAccessError('Reload this page to verify your signed session before restoring CRM information.');
  const response = await fetch('/api/identity/me', { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if ([401, 403].includes(response.status)) throw new PlanAccessError('Your session has ended. Sign in and reload the authorized school.');
  if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.headers.get('cache-control')?.split(',').map(s => s.trim()).includes('no-store')) throw new PlanReadError('Your session could not be verified. CRM information remains hidden.');
  const raw = await response.text();
  if (raw.length > 8000) throw new PlanReadError('Your session could not be verified. CRM information remains hidden.');
  const envelope: unknown = JSON.parse(raw);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).join() !== 'data') throw new PlanReadError('Your session could not be verified. CRM information remains hidden.');
  const identity = (envelope as { data?: unknown }).data;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || Object.keys(identity).some(k => !['externalSubject','displayName','email'].includes(k))) throw new PlanReadError('Your session could not be verified. CRM information remains hidden.');
  if ((identity as { externalSubject?: unknown }).externalSubject !== subject) throw new PlanAccessError('The signed-in user changed. Reload the page; previous enrollment memory cannot be shared.');
}
