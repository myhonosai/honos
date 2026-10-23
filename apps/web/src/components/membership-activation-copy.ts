import type { MembershipActivationWarning, MembershipActivationBlockCode } from '@hon/contracts';

export const warningText: Record<MembershipActivationWarning['code'], string> = {
  BIRTH_DATE_MISSING: 'Birth date is missing. A staff follow-up reminder will be created; this warning does not by itself block activation.',
  CRM_IDENTITY_REVIEW_PENDING: 'An identity review is unresolved. A documented, separately authorized override does not resolve or merge these identities.',
  END_DATE_PASSED: 'The proposed membership end date has already passed.',
  EXISTING_INVOICE_NOT_EVALUATED: 'An existing invoice has not been evaluated. No payment or settlement is confirmed.',
  EXISTING_PAYMENT_SCHEDULE_NOT_EVALUATED: 'An existing payment schedule has not been evaluated or authorized.',
  FIXED_TERM_DIFFERS_FROM_PLAN: 'The proposed term differs from the published plan suggestion.',
  LEGACY_FREE_TEXT_PLAN: 'This membership uses a legacy free-text plan; no published catalog terms are implied.',
  OPEN_ENDED_PLAN_HAS_END_DATE: 'An end date has been entered for an open-ended plan.',
  START_DATE_BACKDATED: 'The proposed start date is in the past. A documented activation reason is required.',
  START_DATE_IN_FUTURE: 'The membership is scheduled to start in the future; confirmation does not make it currently in effect.',
};
export const blockText: Record<MembershipActivationBlockCode, string> = {
  CRM_DRAFT_CHANGED: 'The registered membership DRAFT changed. Recheck its current state through Resume setup.',
  END_DATE_BEFORE_START: 'The last valid membership day must not be before its start.',
  END_DATE_OUT_OF_RANGE: 'The end date is outside the backend-supported date window.',
  FIXED_TERM_END_DATE_REQUIRED: 'This fixed-term plan requires an end date.',
  MEMBERSHIP_NOT_DRAFT: 'This membership is no longer a DRAFT and cannot be activated again.',
  MINOR_GUARDIAN_OF_RECORD_REQUIRED: 'A known minor requires a verified guardian of record. Authorized staff must review the registration; this screen cannot repair or relink identities.',
  PLAN_BINDING_INVALID: 'The membership’s original published plan binding could not be verified.',
  PLAN_CURRENCY_MISMATCH: 'The bound plan and canonical billing-account currencies do not match.',
  START_DATE_OUT_OF_RANGE: 'The start date is outside the backend-supported date window.',
};
export const requirementText = {
  AGREEMENT: 'Agreement and signature', PAYMENT: 'Tuition or other payment', RECURRING_PAYMENT_AUTHORIZATION: 'Recurring-payment authorization',
  FINANCIAL_RESPONSIBILITY: 'Financial responsibility', SCHOOL_ACTIVATION_POLICY: 'School activation policy',
};
export const sourceText = {
  GENERIC_LEGACY: 'Legacy membership', OWNER_LAUNCH: 'Owner Launch', CRM_ADULT_FREE_TEXT: 'Adult CRM · free-text plan',
  CRM_ADULT_PLAN: 'Adult CRM · published plan', CRM_GUARDIAN_CHILD_PLAN: 'Guardian/child CRM · published plan',
};
export const reasonText = {
  ROUTINE_ENROLLMENT: 'Routine enrollment', DOCUMENTS_PENDING: 'Documents pending', PAPER_RECORDS_HELD_BY_SCHOOL: 'Paper records held by school',
  PAYMENT_HANDLED_OUTSIDE_HON: 'Payment handled outside HON (not verified here)', LEGACY_MEMBERSHIP: 'Legacy membership',
  SCHOLARSHIP_OR_COMP: 'Scholarship or complimentary membership', STAFF_FAMILY: 'Staff or family membership', OTHER: 'Other documented reason',
};
