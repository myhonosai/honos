import { verifyCurrentStaffReportingSchool, type CurrentStaffReportingSchool } from '@hon/contracts';
import { StaffDashboardAccessError } from './staff-dashboard-http';

export { verifyCurrentStaffReportingSchool, type CurrentStaffReportingSchool } from '@hon/contracts';

function invalid(): never { throw new Error('The current reporting school response could not be verified. No school was selected.'); }
const PATH = '/api/v1/staff/current-reporting-school';
/** No arguments, selectors, storage, or owner/family/HQ scope are accepted. */
export async function loadCurrentStaffReportingSchool(): Promise<CurrentStaffReportingSchool> {
  const response = await fetch(PATH, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session to resolve the current reporting school.'
      : response.status === 403 ? 'Current staff reporting scope is not authorized. No school was selected.'
        : 'Current staff reporting scope is unavailable. No school was selected.';
    throw new StaffDashboardAccessError(message, response.status);
  }
  if (response.redirected || response.status !== 200
    || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '')
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) invalid();
  if (response.url) {
    if (typeof location === 'undefined' || response.url !== new URL(PATH, location.origin).href) invalid();
  }
  let envelope: unknown;
  try { envelope = await response.json(); } catch { invalid(); }
  return verifyCurrentStaffReportingSchool(envelope);
}
