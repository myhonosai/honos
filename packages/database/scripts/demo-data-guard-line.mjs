/**
 * 0446 adds one line after the top-level BEGIN of 42 append-only guards so school demo data can be removed. Proofs that
 * pin a guard body exactly expect the original body with that one line, byte for byte (0446's own proof and the
 * canonical 011 section check the line itself).
 */
export const DEMO_DATA_GUARD_LINE = "\n  IF TG_OP='DELETE' AND hon.demo_data_removal_allows(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF; -- 0446 demo data removal\n";
export const DEMO_DATA_PATCHED_GUARDS = Object.freeze([
   'guard_achievement_history',   'guard_attendance_card',   'guard_automation_run',   'guard_automation_workflow_history',   'guard_billing_import',   'guard_campaign_history',   'guard_chad_follow_up',   'guard_class_series',   'guard_classpass_booking',   'guard_crm_adult_membership_draft_source',   'guard_crm_guardian_child_enrollment_history',   'guard_crm_lead_close_history',   'guard_crm_lead_registration_history',   'guard_curriculum_history',   'guard_document_immutability',   'guard_family_message_thread',   'guard_follow_up_history',   'guard_history_import',   'guard_instructor_qualification_history',   'guard_invoice_payment_record',   'guard_lead_import_evidence',   'guard_membership_activation_evidence',   'guard_membership_pause',   'guard_membership_plan_selection',   'guard_membership_plan_version',   'guard_public_form_record',   'guard_renewal_history',   'guard_school_account_evidence',   'guard_school_conversation',   'guard_school_family_access_invitation',   'guard_school_pay_autopay_plan',   'guard_school_pay_charge_attempt',   'guard_school_pay_method',   'guard_school_pay_method_setup',   'guard_student_import',   'guard_teaching_studio_history',   'guard_testing_certificate_history',   'guard_testing_certificate_promotion_delete',   'guard_testing_registration_interest',   'guard_testing_scorecard_history',   'guard_testing_scorecard_root',   'guard_walkin_kiosk',
]);

/** The installed body of `name` after 0446, given its body as written by its own migration. */
export function bodyAfterDemoData(name, body) {
  const bare = String(name).replace(/^hon\./, '').replace(/\(.*$/, '');
  if (typeof body !== 'string' || !DEMO_DATA_PATCHED_GUARDS.includes(bare)) return body;
  const match = /\bBEGIN\b/i.exec(body);
  if (!match) throw new Error(`0446 guard ${bare} has no BEGIN`);
  const at = match.index + match[0].length;
  return body.slice(0, at) + DEMO_DATA_GUARD_LINE + body.slice(at);
}
