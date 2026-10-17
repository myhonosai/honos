export type HqEntitlementTier = 'CORE' | 'COMPLETE';
export interface HqEntitlementTransitionInput { targetTier: HqEntitlementTier; expectedVersion: number }
export interface HqEntitlementTransitionReceipt {
  organizationId: string; priorTier: HqEntitlementTier; targetTier: HqEntitlementTier;
  version: number; effectiveFrom: string; replayed: boolean;
}
export const HQ_ENTITLEMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function hqEntitlementUuid(value: unknown): string {
  if (typeof value !== 'string' || !HQ_ENTITLEMENT_UUID.test(value)) throw new Error('INVALID_HQ_ENTITLEMENT_INPUT');
  return value.toLowerCase();
}
export function validateHqEntitlementTransitionInput(value: unknown): HqEntitlementTransitionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_HQ_ENTITLEMENT_INPUT');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'targetTier') || !Object.hasOwn(input, 'expectedVersion')
    || !['CORE', 'COMPLETE'].includes(input.targetTier as string)
    || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1 || (input.expectedVersion as number) > 2147483646) {
    throw new Error('INVALID_HQ_ENTITLEMENT_INPUT');
  }
  return { targetTier: input.targetTier as HqEntitlementTier, expectedVersion: input.expectedVersion as number };
}
export function validateHqEntitlementTransitionReceipt(value: unknown): HqEntitlementTransitionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_HQ_ENTITLEMENT_RECEIPT');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'effectiveFrom,organizationId,priorTier,replayed,targetTier,version'
    || typeof r.organizationId !== 'string' || !HQ_ENTITLEMENT_UUID.test(r.organizationId)
    || !['CORE', 'COMPLETE'].includes(r.priorTier as string) || !['CORE', 'COMPLETE'].includes(r.targetTier as string)
    || r.priorTier === r.targetTier || !Number.isSafeInteger(r.version) || (r.version as number) < 2 || (r.version as number) > 2147483647
    || typeof r.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r.effectiveFrom) || !Number.isFinite(Date.parse(r.effectiveFrom))
    || typeof r.replayed !== 'boolean') throw new Error('INVALID_HQ_ENTITLEMENT_RECEIPT');
  return r as unknown as HqEntitlementTransitionReceipt;
}
