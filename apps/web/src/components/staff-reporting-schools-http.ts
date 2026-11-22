import { verifyStaffReportingSchools, type StaffReportingSchools } from '@hon/contracts';
import { StaffDashboardAccessError } from './staff-dashboard-http';

export { MAX_STAFF_REPORTING_SCHOOLS, verifyStaffReportingSchools, type StaffReportingSchoolChoice, type StaffReportingSchools } from '@hon/contracts';

function invalid(): never { throw new Error('The reporting school choices could not be verified. No school was selected.'); }
const PATH = '/api/v1/staff/reporting-schools';
/** No selector inputs or persistence. Choices never authorize a report. */
export async function loadStaffReportingSchools(): Promise<StaffReportingSchools> {
  const response = await fetch(PATH, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session to view reporting school choices.'
      : response.status === 403 ? 'Staff reporting schools are not authorized. No school was selected.'
        : 'Staff reporting schools are unavailable. No school was selected.';
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
  return verifyStaffReportingSchools(envelope);
}
