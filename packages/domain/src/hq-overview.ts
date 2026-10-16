import {
  HQ_OVERVIEW_UNAVAILABLE_REASONS,
  type HqOverviewCallerRole,
  type HqOverviewOnboardingCounts,
  type HqOverviewProviderStateCounts,
  type HqOverviewUnavailable,
  type HqPlatformOverview,
} from '@hon/contracts';

type ClosedRecord = Record<string, unknown>;

const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

function invalid(): never {
  throw new Error('HQ_OVERVIEW_INVALID');
}

function isRecord(value: unknown): value is ClosedRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function closed(value: unknown, keys: readonly string[]): ClosedRecord {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !UTC_MILLIS.test(value) || UNSAFE_TEXT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) invalid();
  return value;
}

function callerHqRole(value: unknown): HqOverviewCallerRole {
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
  if (item.availability !== 'AVAILABLE' || inProgressRequestCount + completedRequestCount !== requestCount) invalid();
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

/**
 * Reconstructs the only permitted HQ-1 projection shape. It does not accept a
 * permissive record cast, and fails closed on identifiers, financial values,
 * authority, credentials, models, prompts, work evidence, or any unknown key.
 */
export function verifyHqPlatformOverview(value: unknown): HqPlatformOverview {
  const root = closed(value, [
    'asOf',
    'callerHqRole',
    'organizationCount',
    'schoolCount',
    'onboarding',
    'configuredProviderStates',
    'taskProfileCount',
    'financialMetrics',
    'aiUsage',
    'durableHqWork',
  ]);
  const durable = closed(root.durableHqWork, ['availability', 'state', 'reason']);
  if (durable.availability !== 'UNAVAILABLE' || durable.state !== 'NO_RECORDED_WORK' || durable.reason !== HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork) invalid();
  return {
    asOf: timestamp(root.asOf),
    callerHqRole: callerHqRole(root.callerHqRole),
    organizationCount: count(root.organizationCount),
    schoolCount: count(root.schoolCount),
    onboarding: onboarding(root.onboarding),
    configuredProviderStates: providerStates(root.configuredProviderStates),
    taskProfileCount: count(root.taskProfileCount),
    financialMetrics: unavailable(root.financialMetrics, HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics),
    aiUsage: unavailable(root.aiUsage, HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage),
    durableHqWork: {
      availability: 'UNAVAILABLE',
      state: 'NO_RECORDED_WORK',
      reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork,
    },
  };
}
