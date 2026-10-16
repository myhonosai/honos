import type { OwnerLaunchContext } from '@hon/contracts';
/** Identity/scope is still independently rechecked and locked by PostgreSQL. */
export function assertOwnerLaunchHuman(context: OwnerLaunchContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId || !context.externalSubject) throw new Error('REGISTRATION_FORBIDDEN');
}

/** Normalize only for conservative denial; this is never an identity merge. */
export function ownerLaunchPotentialName(value: string): string { return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu,''); }
export function assertGuardianChildDistinct(input: import('@hon/contracts').RegisterGuardianChildInput): void {
  if (ownerLaunchPotentialName(input.guardianGivenName)===ownerLaunchPotentialName(input.childGivenName) && ownerLaunchPotentialName(input.guardianFamilyName)===ownerLaunchPotentialName(input.childFamilyName)) throw new Error('REGISTRATION_NEEDS_STAFF');
}
/** SQL independently checks these rules against its locked exact UTC class date. */
export function assertGuardianChildClassAges(input: import('@hon/contracts').RegisterGuardianChildInput, classDate: string, today: string): void {
  assertGuardianChildDistinct(input);
  const cutoff = new Date(`${classDate}T00:00:00.000Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear()-18);
  // Clamp leap-day subtraction to PostgreSQL interval semantics.
  if(cutoff.getUTCMonth()!==new Date(`${classDate}T00:00:00.000Z`).getUTCMonth()) cutoff.setUTCDate(0);
  const adultBefore=cutoff.toISOString().slice(0,10);
  if (input.guardianBirthDate<'1900-01-01' || input.childBirthDate<'1900-01-01' || input.guardianBirthDate>today || input.childBirthDate>today || input.guardianBirthDate>adultBefore || input.childBirthDate<=adultBefore) throw new Error('REGISTRATION_NEEDS_STAFF');
}
