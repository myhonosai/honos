/** Synthetic base records only; registration, payer, DRAFT and ACTIVE lineage use existing domain services.
 * Caller must first validate the exact private descriptor and observed marked database owner. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { confirmationFor } from '../../../packages/database/scripts/membership-activation-test-support.mjs';

export async function seedOwnerWorkflowFixture({ q, database, services, contracts }) {
  const s = Object.fromEntries(['organizationId', 'schoolId', 'pipeline', 'stage', 'role', 'user', 'principal', 'program'].map(key => [key, randomUUID()]));
  s.subject = `native-workflow-${randomUUID()}`;
  await q("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic native workflow organization','Synthetic native workflow organization')", [s.organizationId]);
  await q("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'Synthetic native workflow school',$3,'UTC')", [s.schoolId, s.organizationId, `native-${s.schoolId}`]);
  await q("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [s.organizationId]);
  await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic workflow staff')", [s.user, s.subject, `${s.user}@example.test`]);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Synthetic workflow staff')", [s.principal, s.user]);
  await q("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'NATIVE_WORKFLOW_STAFF','Synthetic workflow staff')", [s.role, s.organizationId]);
  for (const permission of ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage', 'billing.account.create', 'billing.membership.create', 'billing.membership_plan.manage', 'billing.membership.activate', 'billing.membership.read', 'billing.membership.dates.revise', 'schedule.session.read', 'schedule.booking.manage', 'attendance.record']) {
    await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [s.role, s.organizationId, permission]);
  }
  await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)', [s.organizationId, s.schoolId, s.principal, s.role]);
  await q("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic native workflow pipeline')", [s.pipeline, s.organizationId, s.schoolId]);
  await q("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [s.stage, s.organizationId, s.schoolId, s.pipeline]);
  await q("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Synthetic native workflow program','SCHEDULED')", [s.program, s.organizationId, s.schoolId]);

  async function context(permission, read = false, registration = false) {
    const scope = registration ? await database.resolveCrmLeadRegistrationScope(s.subject, s.schoolId)
      : await database.resolveAuthorizedScope(s.subject, s.schoolId, permission);
    assert(scope && scope.organizationId === s.organizationId && scope.schoolId === s.schoolId && scope.principalId === s.principal, 'Canonical fixture IAM resolution failed.');
    const requestId = randomUUID();
    return { ...scope, externalSubject: s.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: read ? '' : randomUUID() };
  }
  const published = await services.plans.create(await context('billing.membership_plan.manage'), {
    planCode: `NATIVE-${randomUUID().slice(0, 8).toUpperCase()}`, displayName: 'Synthetic native workflow plan', description: null,
    programId: null, availability: 'AVAILABLE', currency: 'USD', priceMinor: 9900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', termMonths: null,
    confirmation: contracts.MEMBERSHIP_PLAN_CHANGE_CONFIRMATION,
  });
  const cases = [];
  for (const width of [1440, 390]) for (const kind of ['adult', 'child']) {
    const personId = randomUUID(), leadId = randomUUID(), sessionId = randomUUID(), label = `Synthetic ${kind} ${width}`;
    await q('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [personId, s.organizationId, s.schoolId, 'Synthetic', `Native-${kind}-${randomUUID()}`]);
    await q("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [leadId, s.organizationId, s.schoolId, personId, s.pipeline, s.stage]);
    const registration = await services.registrations.register(await context(null, false, true), leadId, {
      registrationPath: kind === 'adult' ? 'ADULT' : 'GUARDIAN_CHILD',
      ...(kind === 'adult' ? { birthDate: '1990-01-02' } : { childGivenName: 'SyntheticChild', childFamilyName: `Native-${randomUUID()}`, childBirthDate: '2016-02-03' }),
      confirmation: contracts.CRM_LEAD_REGISTRATION_CONFIRMATION,
    });
    assert.equal(registration.result.outcome, 'REGISTERED', 'Canonical registration must produce one verified student.');
    const studentProfileId = registration.result.studentProfileId;
    await services.accounts.create(await context('billing.account.create'), { responsiblePersonId: personId, currency: 'USD' });
    if (kind === 'child') await services.family.designatePayer(await context(null, false, true), leadId, { confirmation: contracts.CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION });
    const input = { studentProfileId, membershipPlanId: published.plan.planId, membershipPlanVersion: 1,
      confirmation: kind === 'adult' ? contracts.CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION : contracts.CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
    const draft = kind === 'adult' ? await services.plans.draftAdultMembershipFromPlan(await context('billing.membership.create'), input)
      : await services.family.draftMembershipFromPlan(await context(null, false, true), input);
    const membershipId = draft.receipt.membershipId;
    const preview = await services.memberships.previewActivation(await context('billing.membership.activate', true), membershipId, {});
    assert.deepEqual(preview.blocks, []); assert.equal(preview.canConfirm, true); assert.deepEqual(preview.overridableWarnings, []);
    const activated = await services.memberships.activate(await context('billing.membership.activate'), membershipId, confirmationFor(preview));
    assert.equal(activated.membership.state, 'ACTIVE');
    // Same existing base fixture shape as connected-student-operations-api-verification.mjs; no roster/benefit inference.
    await q("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,$5,date_trunc('second',clock_timestamp())-interval '1 hour',date_trunc('second',clock_timestamp())+interval '1 hour',20,'OPTIONAL_BOOKING','SCHEDULED')", [sessionId, s.organizationId, s.schoolId, s.program, label]);
    cases.push({ width, kind, label, leadId, studentProfileId, membershipId, sessionId });
  }
  return { ...s, cases };
}
