BEGIN;

-- D-M1 CRM lead membership discovery (owner direction 2026-11-02 23:34Z: a minimal, authorized ACTIVE membership
-- discovery contract for the connected CRM). Proposed migration number 0200 (after C1 0199); the owner allocates the
-- final number.
--
-- Registration recovery (0174/0176) is deliberately DRAFT-specific: once a DRAFT is activated it reports staff review
-- and the browser has no way back to the membership in a new session. This read closes that gap and nothing more.
-- One selector (a lead id at the verified current school) returns the memberships recorded by that lead's own CRM
-- workflow: the adult DRAFT source (0162) and the guardian/child per-child DRAFT sources (0176, both CRM_REGISTRATION
-- and ADDITIONAL_CHILD children attributed to the lead). Each item carries only the membership id, origin, student
-- profile id, current lifecycle state, version and creation instant. No name, plan, price, date, payer, payment,
-- agreement, invoice or creator is returned; the existing activation-context, preview and date reads stay the only
-- detail surfaces and re-prove their own authority.
--
-- Authority: the 0177/0178 direct-human lifecycle actor for billing.membership.activate (current staff grant, active
-- school, ACTIVE entitlement window, no HQ/family/system role, no delegation or action request) AND crm.lead.read at
-- the same school. A billing.membership.activate holder can already read and activate any membership of the school by
-- id, so disclosing ids of another staff member's DRAFT adds no authority. There is no search, no person matching and
-- no school-wide list: memberships the lead's workflow did not create are never returned. Read-only: no DML, audit,
-- outbox, idempotency, billing, payment, provider, AI or automation effect.

CREATE FUNCTION hon.read_crm_lead_memberships(subject text, selected_lead uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
  org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; items jsonb; total integer;
BEGIN
  IF selected_lead IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.activate');
  IF NOT hon.crm_lead_registration_has_permission(actor,org,school,'crm.lead.read') THEN
    RAISE EXCEPTION 'CRM_LEAD_MEMBERSHIPS_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.id=selected_lead AND l.organization_id=org AND l.school_id=school) THEN
    RAISE EXCEPTION 'CRM_LEAD_MEMBERSHIPS_UNAVAILABLE' USING ERRCODE='P0002';
  END IF;
  WITH sourced AS (
    SELECT 'ADULT_REGISTRATION'::text AS origin, c.resulting_student_profile_id AS student_profile_id, x.membership_id
    FROM hon.crm_lead_registration_conversions c
    JOIN hon.crm_adult_membership_draft_sources x ON x.conversion_id=c.id AND x.organization_id=org AND x.school_id=school
    WHERE c.source_lead_id=selected_lead AND c.organization_id=org AND c.school_id=school
    UNION ALL
    SELECT 'GUARDIAN_CHILD_REGISTRATION', e.student_profile_id, x.membership_id
    FROM hon.crm_guardian_child_enrolled_children e
    JOIN hon.crm_guardian_child_membership_draft_sources x ON x.student_profile_id=e.student_profile_id AND x.organization_id=org AND x.school_id=school
    WHERE e.source_lead_id=selected_lead AND e.organization_id=org AND e.school_id=school
  ), rows AS (
    SELECT s.origin, s.student_profile_id, m.id, m.state::text AS state, m.version, m.created_at
    FROM sourced s JOIN hon.memberships m ON m.id=s.membership_id AND m.organization_id=org AND m.school_id=school
  )
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('membershipId',r.id,'origin',r.origin,'studentProfileId',r.student_profile_id,
      'state',r.state,'version',r.version,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY r.created_at, r.id) FILTER (WHERE r.n<=20),'[]'::jsonb)
  INTO total, items
  FROM (SELECT rows.*, row_number() OVER (ORDER BY rows.created_at, rows.id) AS n FROM rows) r;
  RETURN jsonb_build_object('leadId',selected_lead,'memberships',items,'truncated',total>20);
END $$;

COMMENT ON FUNCTION hon.read_crm_lead_memberships(text,uuid) IS
'Direct HUMAN_UI read of the memberships created by one current-school CRM lead''s own registration workflow (adult and guardian/child DRAFT sources): id, origin, student profile id, lifecycle state, version, created instant; at most 20, oldest first. Requires billing.membership.activate (0177 lifecycle actor) and crm.lead.read. No search or school-wide list; no DML or other effect.';

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_crm_lead_memberships(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_crm_lead_memberships(text,uuid) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_crm_lead_memberships(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
