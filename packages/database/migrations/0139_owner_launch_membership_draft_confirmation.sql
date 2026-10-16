BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Owner launch confirmation requires trusted migration owner'; END IF;
END $$;

-- No browser selectors, new model, writes or new authority. The append-only
-- canonical creation audit is the ONLY membership locator. Multiple creation
-- relations are unavailable, never a newest/general membership search fallback.
CREATE FUNCTION hon.read_owner_launch_membership_draft(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
 creation hon.audit_events%ROWTYPE; relation record; current_draft record;
 relation_count integer; registration uuid; result jsonb;
 unavailable constant jsonb:='{"state":"DRAFT_UNAVAILABLE","receipt":null}'::jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 IF NOT hon.principal_has_school_permission(actor,org,school,'billing.membership.create')
 OR NOT hon.principal_has_school_permission(actor,org,school,'billing.account.create') THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 -- Match the canonical draft writer's lock order, then prevent relation/evidence
 -- phantoms and concurrent drift for the duration of this bounded read.
 LOCK TABLE hon.billing_accounts,hon.memberships IN SHARE MODE;
 LOCK TABLE hon.audit_events,hon.student_registration_receipts,hon.guardian_child_registration_receipts,
 hon.student_profiles,hon.people,hon.student_curriculum_enrollments,hon.families,hon.family_members,
 hon.membership_payment_schedules,hon.invoices IN SHARE MODE;
 PERFORM hon.require_owner_launch_actor(p_subject);
 SELECT count(*)::integer INTO relation_count FROM hon.audit_events
 WHERE organization_id=org AND school_id=school AND actor_principal_id=actor
 AND next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT' AND entity_type='MEMBERSHIP';
 IF relation_count=0 THEN RETURN jsonb_build_object('state','NO_RECORDED_DRAFT','receipt',NULL); END IF;
 IF relation_count<>1 THEN RETURN unavailable; END IF;
 SELECT * INTO creation FROM hon.audit_events
 WHERE organization_id=org AND school_id=school AND actor_principal_id=actor
 AND next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT' AND entity_type='MEMBERSHIP';
 IF creation.action_code<>'billing.membership.create' OR creation.source<>'HUMAN_UI' OR creation.result<>'SUCCEEDED'
 OR creation.prior_state IS NOT NULL OR jsonb_typeof(creation.next_state) IS DISTINCT FROM 'object'
 OR creation.next_state->>'state' IS DISTINCT FROM 'DRAFT'
 OR creation.next_state->>'membershipId' IS DISTINCT FROM creation.entity_id::text
 OR jsonb_typeof(creation.next_state->'registrationId') IS DISTINCT FROM 'string'
 OR creation.next_state->>'registrationId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 THEN RETURN unavailable; END IF;
 registration:=(creation.next_state->>'registrationId')::uuid;
 -- Re-derive adult or explicit guardian/child payer and participant solely from
 -- this actor's immutable receipt and its current same-school composite links.
 WITH receipt_relations AS (
  SELECT r.id registration_id,sp.person_id payer,sp.person_id participant,false child
  FROM hon.student_registration_receipts r
  JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
  JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=r.organization_id AND p.school_id=r.school_id
  JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
  UNION ALL
  SELECT r.id,r.guardian_person_id,r.child_person_id,true
  FROM hon.guardian_child_registration_receipts r
  JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.person_id=r.child_person_id AND sp.primary_family_id=r.family_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
  JOIN hon.people c ON c.id=r.child_person_id AND c.organization_id=r.organization_id AND c.school_id=r.school_id
  JOIN hon.people g ON g.id=r.guardian_person_id AND g.organization_id=r.organization_id AND g.school_id=r.school_id
  JOIN hon.families f ON f.id=r.family_id AND f.organization_id=r.organization_id AND f.school_id=r.school_id
  JOIN hon.family_members gm ON gm.id=r.guardian_member_id AND gm.family_id=r.family_id AND gm.person_id=r.guardian_person_id AND gm.member_role='GUARDIAN' AND gm.organization_id=r.organization_id AND gm.school_id=r.school_id
  JOIN hon.family_members cm ON cm.id=r.child_member_id AND cm.family_id=r.family_id AND cm.person_id=r.child_person_id AND cm.member_role='STUDENT' AND cm.organization_id=r.organization_id AND cm.school_id=r.school_id
  JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
 ), exact_relation AS (
  SELECT * FROM receipt_relations WHERE (SELECT count(*) FROM receipt_relations)=1
 ) SELECT * INTO relation FROM exact_relation;
 IF relation.registration_id IS NULL THEN RETURN unavailable; END IF;
 IF relation.child THEN PERFORM hon.require_owner_launch_family_actor(p_subject); END IF;
 -- Only the audit-bound canonical ID is examined. No account, person, plan,
 -- latest DRAFT or generic membership fallback can supply another record.
 SELECT m.id,m.version,m.plan_code,m.term_started_at,m.term_ends_at,m.created_at,a.currency::text currency
 INTO current_draft FROM hon.memberships m
 JOIN hon.billing_accounts a ON a.id=m.billing_account_id AND a.organization_id=org AND a.school_id=school AND a.responsible_person_id=relation.payer
 WHERE m.id=creation.entity_id AND m.organization_id=org AND m.school_id=school AND m.state='DRAFT'
 AND m.participant_person_id=relation.participant
 AND (SELECT count(*) FROM hon.billing_accounts x WHERE x.organization_id=org AND x.school_id=school AND x.responsible_person_id=relation.payer)=1
 AND to_jsonb(m.version)=creation.next_state->'membershipVersion'
 AND m.plan_code=creation.next_state->>'planCode' AND a.currency::text=creation.next_state->>'currency'
 AND to_char(m.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=creation.next_state->>'termStartedAt'
 AND to_char(m.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=creation.next_state->>'termEndsAt'
 AND to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=creation.next_state->>'recordedAt'
 AND NOT EXISTS(SELECT 1 FROM hon.membership_payment_schedules s WHERE s.membership_id=m.id)
 AND NOT EXISTS(SELECT 1 FROM hon.invoices i WHERE i.membership_id=m.id);
 IF current_draft.id IS NULL THEN RETURN unavailable; END IF;
 result:=jsonb_build_object('state','RECORDED_DRAFT','receipt',jsonb_build_object(
  'registrationId',registration,'membershipId',current_draft.id,'state','DRAFT','membershipVersion',current_draft.version,
  'planCode',current_draft.plan_code,'termStartedAt',to_char(current_draft.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'termEndsAt',to_char(current_draft.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'currency',current_draft.currency,
  'recordedAt',to_char(current_draft.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 PERFORM hon.require_owner_launch_actor(p_subject);
 IF relation.child THEN PERFORM hon.require_owner_launch_family_actor(p_subject); END IF;
 IF NOT hon.principal_has_school_permission(actor,org,school,'billing.membership.create')
 OR NOT hon.principal_has_school_permission(actor,org,school,'billing.account.create') THEN RAISE EXCEPTION 'MEMBERSHIP_DRAFT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;
DO $$ DECLARE r text; BEGIN
 REVOKE ALL ON FUNCTION hon.read_owner_launch_membership_draft(text) FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_owner_launch_membership_draft(text) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.read_owner_launch_membership_draft(text) TO hon_runtime; END IF;
END $$;
COMMIT;
