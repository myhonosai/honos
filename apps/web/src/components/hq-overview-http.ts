import {
  HQ_OVERVIEW_UNAVAILABLE_REASONS,
  type HqOverviewCallerRole,
  type HqOverviewOnboardingCounts,
  type HqOverviewProviderStateCounts,
  type HqOverviewUnavailable,
  type HqPlatformOverview,
} from '@hon/contracts';

type ClosedRecord = Record<string, unknown>;

const PATH = '/api/v1/hq/overview';
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;

export class HqOverviewAccessError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
  }
}

function invalid(): never {
  throw new Error('HQ overview data was not a verified, aggregate-only projection.');
}

function isRecord(value: unknown): value is ClosedRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function closed(value: unknown, keys: readonly string[]): ClosedRecord {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
  return value;
}

function time(value: unknown): string {
  if (typeof value !== 'string' || !UTC_MILLIS.test(value) || UNSAFE_TEXT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) invalid();
  return value;
}

function callerRole(value: unknown): HqOverviewCallerRole {
  if (value === 'OWNER' || value === 'OPERATOR') return value;
  return invalid();
}

function unavailable(value: unknown, reason: string): HqOverviewUnavailable {
  const item = closed(value, ['availability', 'reason']);
  if (item.availability !== 'UNAVAILABLE' || item.reason !== reason) invalid();
  return { availability: 'UNAVAILABLE', reason };
}

function onboarding(value: unknown): HqOverviewOnboardingCounts {
  const item = closed(value, ['availability', 'requestCount', 'inProgressRequestCount', 'completedRequestCount']);
  const requestCount = count(item.requestCount);
  const inProgressRequestCount = count(item.inProgressRequestCount);
  const completedRequestCount = count(item.completedRequestCount);
  if (item.availability !== 'AVAILABLE' || requestCount !== inProgressRequestCount + completedRequestCount) invalid();
  return { availability: 'AVAILABLE', requestCount, inProgressRequestCount, completedRequestCount };
}

function providerStates(value: unknown): HqOverviewProviderStateCounts {
  const item = closed(value, ['disabled', 'configured', 'healthy', 'degraded', 'unavailable']);
  return {
    disabled: count(item.disabled),
    configured: count(item.configured),
    healthy: count(item.healthy),
    degraded: count(item.degraded),
    unavailable: count(item.unavailable),
  };
}

/** Strictly reconstruct the one closed HQ-1 response; do not accept projections with identifiers, values, evidence, or authority fields. */
export function verifyHqOverviewSnapshot(value: unknown): HqPlatformOverview {
  const root = closed(value, [
    'asOf', 'callerHqRole', 'organizationCount', 'schoolCount', 'onboarding',
    'configuredProviderStates', 'taskProfileCount', 'financialMetrics', 'aiUsage', 'durableHqWork',
  ]);
  const durable = closed(root.durableHqWork, ['availability', 'state', 'reason']);
  if (durable.availability !== 'UNAVAILABLE' || durable.state !== 'NO_RECORDED_WORK' || durable.reason !== HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork) invalid();
  return {
    asOf: time(root.asOf),
    callerHqRole: callerRole(root.callerHqRole),
    organizationCount: count(root.organizationCount),
    schoolCount: count(root.schoolCount),
    onboarding: onboarding(root.onboarding),
    configuredProviderStates: providerStates(root.configuredProviderStates),
    taskProfileCount: count(root.taskProfileCount),
    financialMetrics: unavailable(root.financialMetrics, HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics),
    aiUsage: unavailable(root.aiUsage, HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage),
    durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork },
  };
}

/** The HQ route is intentionally fixed: no target, role, tenant, or time selector can enter the request. */
export async function loadHqOverview(): Promise<HqPlatformOverview> {
  const response = await fetch(PATH, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    if (response.status === 401) throw new HqOverviewAccessError('Sign in with a verified platform HQ session to view the overview.', 401);
    if (response.status === 403) throw new HqOverviewAccessError('This account does not have current platform HQ overview authority.', 403);
    throw new Error('The HQ overview is unavailable. No result is shown.');
  }
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    invalid();
  }
  const root = closed(envelope, ['data']);
  const data = closed(root.data, ['overview']);
  return verifyHqOverviewSnapshot(data.overview);
}
