BEGIN;

-- C2 (0374, allocated by the coordinator 2026-11-15): the contact card. Owner (David), 2026-11-15 08:23Z, on the Manus CRM
-- ideas: "Apply all." Idea #1: one card per contact with an overview and tabs for family, appointments, tasks, membership,
-- billing, messages and a timeline. Each tab shows only what the viewer's role may read; otherwise it says so.
-- One read-only entry point, hon.read_school_contact_card(subject, {personId}), for the session school only. Authority: the
-- 0373 contacts actor (a direct human at the session school with live people.read, active school, organization and HON
-- entitlement; HQ, family, delegated and automated callers refused). Each section then re-checks its own live permission:
--   family        family.read
--   appointments  crm.lead.read
--   tasks         crm.lead.read (open follow-ups on the person's leads: subject, priority, due date; never the note)
--   membership    billing.membership.read
--   billing       billing.membership.read
--   messages      communication.message.read (counts only, never message text)
--   timeline      past events only, of the kinds the viewer may read (leads and appointments, memberships and payments, attendance)
-- Lists are the newest 20 (timeline 30). Notes, staff-only comments and message text are never returned. Nothing is written,
-- sent or charged. Merging or deleting a contact is not part of this card.

-- One live permission at the session school for an already-proved staff actor (private).
CREATE FUNCTION hon.school_contact_card_can(actor uuid, org uuid, school uuid, permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT permission IN ('family.read','crm.lead.read','billing.membership.read','communication.message.read','attendance.record')
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission
        AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;

-- A UTC instant as the API prints it, or null (private).
CREATE FUNCTION hon.school_contact_card_time(t timestamptz) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN t IS NULL THEN NULL ELSE to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;

CREATE FUNCTION hon.read_school_contact_card(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); as_of timestamptz:=statement_timestamp();
  actor uuid; pid uuid; person hon.people; fact record;
  can_family boolean; can_leads boolean; can_billing boolean; can_messages boolean; can_attendance boolean;
  lead_ids uuid[]; profile_ids uuid[]; account_ids uuid[]; membership_ids uuid[];
  overview jsonb; family jsonb; appointments jsonb; tasks jsonb; membership jsonb; billing jsonb; messages jsonb; timeline jsonb;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  denied constant jsonb:='{"allowed":false}'::jsonb;
BEGIN
  actor:=hon.require_school_contacts_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>'personId')
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR lower(p_input->>'personId') !~ uuid_re THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  pid:=(p_input->>'personId')::uuid;
  SELECT * INTO person FROM hon.people WHERE id=pid AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  can_family:=hon.school_contact_card_can(actor,org,school,'family.read');
  can_leads:=hon.school_contact_card_can(actor,org,school,'crm.lead.read');
  can_billing:=hon.school_contact_card_can(actor,org,school,'billing.membership.read');
  can_messages:=hon.school_contact_card_can(actor,org,school,'communication.message.read');
  can_attendance:=hon.school_contact_card_can(actor,org,school,'attendance.record');

  SELECT f.segment, f.plan_name, f.program_name, f.ends_at INTO fact FROM hon.school_contact_facts(org,school,as_of) f WHERE f.person_id=pid;
  lead_ids:=ARRAY(SELECT l.id FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.primary_person_id=pid);
  profile_ids:=ARRAY(SELECT sp.id FROM hon.student_profiles sp WHERE sp.organization_id=org AND sp.school_id=school AND sp.person_id=pid);
  membership_ids:=ARRAY(SELECT x.id FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.participant_person_id=pid AND x.state<>'DRAFT');
  account_ids:=ARRAY(SELECT a.id FROM hon.billing_accounts a WHERE a.organization_id=org AND a.school_id=school
    AND (a.responsible_person_id=pid OR a.id IN (SELECT x.billing_account_id FROM hon.memberships x WHERE x.id=ANY(membership_ids))));

  overview:=jsonb_build_object('segment', fact.segment, 'planName', fact.plan_name, 'programName', fact.program_name,
    'membershipEndsAt', hon.school_contact_card_time(fact.ends_at),
    'ranks', coalesce((SELECT jsonb_agg(jsonb_build_object('curriculum', btrim(c.name), 'rank', btrim(r.name),
        'color', CASE WHEN r.display_color ~* '^#[0-9a-f]{3,8}$' THEN r.display_color END) ORDER BY btrim(c.name), r.progression_order)
      FROM hon.student_curriculum_enrollments e JOIN hon.curriculum_ranks r ON r.id=e.current_rank_id AND r.organization_id=org AND r.school_id=school
      JOIN hon.curricula c ON c.id=e.curriculum_id AND c.organization_id=org AND c.school_id=school
      WHERE e.organization_id=org AND e.school_id=school AND e.student_profile_id=ANY(profile_ids) AND e.status='ACTIVE'), '[]'::jsonb),
    'openLead', EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.id=ANY(lead_ids) AND l.status='OPEN'));

  family:=CASE WHEN NOT can_family THEN denied ELSE jsonb_build_object('allowed', true, 'families', coalesce((
    SELECT jsonb_agg(jsonb_build_object('familyId', f.id, 'name', btrim(f.display_name), 'members', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('personId', p.id, 'givenName', p.given_name, 'familyName', p.family_name,
          'role', m.member_role::text, 'billingContact', m.is_billing_contact) ORDER BY m.member_role, p.family_name, p.given_name, p.id), '[]'::jsonb)
        FROM (SELECT * FROM hon.family_members m WHERE m.family_id=f.id AND m.organization_id=org AND m.school_id=school ORDER BY m.created_at LIMIT 20) m
        JOIN hon.people p ON p.id=m.person_id AND p.organization_id=org AND p.school_id=school)) ORDER BY f.created_at, f.id)
    FROM (SELECT f.* FROM hon.families f WHERE f.organization_id=org AND f.school_id=school
      AND EXISTS(SELECT 1 FROM hon.family_members m WHERE m.family_id=f.id AND m.person_id=pid AND m.organization_id=org AND m.school_id=school)
      ORDER BY f.created_at, f.id LIMIT 5) f), '[]'::jsonb)) END;

  appointments:=CASE WHEN NOT can_leads THEN denied ELSE jsonb_build_object('allowed', true, 'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object('type', a.appointment_type::text, 'status', a.status::text, 'startsAt', hon.school_contact_card_time(a.starts_at),
      'endsAt', hon.school_contact_card_time(a.ends_at)) ORDER BY a.starts_at DESC, a.id)
    FROM (SELECT * FROM hon.crm_appointments a WHERE a.organization_id=org AND a.school_id=school AND a.crm_lead_id=ANY(lead_ids)
      ORDER BY a.starts_at DESC, a.id LIMIT 20) a), '[]'::jsonb)) END;

  tasks:=CASE WHEN NOT can_leads THEN denied ELSE jsonb_build_object('allowed', true, 'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object('title', v.subject, 'status', v.status, 'priority', v.priority, 'dueAt', hon.school_contact_card_time(v.due_at))
      ORDER BY v.due_at NULLS LAST, v.follow_up_id)
    FROM (SELECT * FROM (SELECT DISTINCT ON (fv.follow_up_id) fv.* FROM hon.crm_follow_ups fu
        JOIN hon.crm_follow_up_versions fv ON fv.follow_up_id=fu.id AND fv.organization_id=org AND fv.school_id=school
        WHERE fu.organization_id=org AND fu.school_id=school AND fu.lead_id=ANY(lead_ids) ORDER BY fv.follow_up_id, fv.version DESC) latest
      WHERE latest.status='OPEN' ORDER BY latest.due_at NULLS LAST, latest.follow_up_id LIMIT 20) v), '[]'::jsonb)) END;

  membership:=CASE WHEN NOT can_billing THEN denied ELSE jsonb_build_object('allowed', true, 'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object('membershipId', x.id, 'state', x.state::text, 'planCode', x.plan_code, 'planName', btrim(v.display_name),
      'startedAt', hon.school_contact_card_time(x.term_started_at), 'endsAt', hon.school_contact_card_time(x.term_ends_at)) ORDER BY x.term_started_at DESC NULLS LAST, x.id)
    FROM (SELECT * FROM hon.memberships x WHERE x.id=ANY(membership_ids) ORDER BY x.term_started_at DESC NULLS LAST, x.id LIMIT 20) x
    LEFT JOIN hon.membership_plan_selections s ON s.membership_id=x.id AND s.organization_id=org AND s.school_id=school
    LEFT JOIN hon.membership_plan_versions v ON v.plan_id=s.plan_id AND v.version=s.plan_version AND v.organization_id=org AND v.school_id=school), '[]'::jsonb)) END;

  billing:=CASE WHEN NOT can_billing THEN denied ELSE jsonb_build_object('allowed', true,
    'open', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', o.currency, 'dueMinor', o.due) ORDER BY o.currency) FROM (
      SELECT i.currency::text AS currency, sum(greatest(i.total_minor - coalesce(pd.paid,0), 0)) AS due FROM hon.invoices i
      LEFT JOIN LATERAL (SELECT sum(r.amount_minor) AS paid FROM hon.invoice_payment_records r WHERE r.invoice_id=i.id AND r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL) pd ON true
      WHERE i.organization_id=org AND i.school_id=school AND i.billing_account_id=ANY(account_ids) AND i.status='ISSUED'
      GROUP BY i.currency HAVING sum(greatest(i.total_minor - coalesce(pd.paid,0), 0))>0) o), '[]'::jsonb),
    'invoices', coalesce((SELECT jsonb_agg(jsonb_build_object('status', i.status::text, 'currency', i.currency::text, 'totalMinor', i.total_minor,
        'paidMinor', coalesce(pd.paid,0), 'dueAt', hon.school_contact_card_time(i.due_at), 'createdAt', hon.school_contact_card_time(i.created_at)) ORDER BY i.created_at DESC, i.id)
      FROM (SELECT * FROM hon.invoices i WHERE i.organization_id=org AND i.school_id=school AND i.billing_account_id=ANY(account_ids) AND i.status<>'DRAFT'
        ORDER BY i.created_at DESC, i.id LIMIT 20) i
      LEFT JOIN LATERAL (SELECT sum(r.amount_minor) AS paid FROM hon.invoice_payment_records r WHERE r.invoice_id=i.id AND r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL) pd ON true), '[]'::jsonb)) END;

  messages:=CASE WHEN NOT can_messages THEN denied ELSE jsonb_build_object('allowed', true,
    'direct', (SELECT count(*) FROM hon.communication_messages c WHERE c.organization_id=org AND c.school_id=school AND c.recipient_person_id=pid),
    'family', coalesce((SELECT sum(t.message_count) FROM hon.family_message_threads t WHERE t.organization_id=org AND t.school_id=school
      AND t.family_id IN (SELECT m.family_id FROM hon.family_members m WHERE m.person_id=pid AND m.organization_id=org AND m.school_id=school)), 0)) END;

  timeline:=coalesce((SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'at', hon.school_contact_card_time(e.at), 'detail', e.detail) ORDER BY e.at DESC, e.kind, e.detail)
    FROM (SELECT * FROM (
      SELECT 'PERSON_ADDED' AS kind, person.created_at AS at, NULL::text AS detail
      UNION ALL SELECT 'LEAD_OPENED', l.created_at, NULL FROM hon.crm_leads l WHERE can_leads AND l.id=ANY(lead_ids)
      UNION ALL SELECT 'LEAD_WON', l.won_at, NULL FROM hon.crm_leads l WHERE can_leads AND l.id=ANY(lead_ids) AND l.won_at IS NOT NULL
      UNION ALL SELECT 'LEAD_LOST', l.lost_at, NULL FROM hon.crm_leads l WHERE can_leads AND l.id=ANY(lead_ids) AND l.lost_at IS NOT NULL
      UNION ALL SELECT 'APPOINTMENT', a.starts_at, a.appointment_type::text||' '||a.status::text FROM hon.crm_appointments a
        WHERE can_leads AND a.organization_id=org AND a.school_id=school AND a.crm_lead_id=ANY(lead_ids)
      UNION ALL SELECT 'MEMBERSHIP_STARTED', x.term_started_at, x.plan_code FROM hon.memberships x WHERE can_billing AND x.id=ANY(membership_ids) AND x.term_started_at IS NOT NULL
      UNION ALL SELECT 'MEMBERSHIP_ENDED', x.term_ends_at, x.plan_code FROM hon.memberships x WHERE can_billing AND x.id=ANY(membership_ids) AND x.term_ends_at IS NOT NULL
      UNION ALL SELECT 'PAYMENT', (r.received_on::timestamp AT TIME ZONE 'UTC'), r.currency::text||' '||r.amount_minor FROM hon.invoice_payment_records r
        JOIN hon.invoices i ON i.id=r.invoice_id AND i.organization_id=org AND i.school_id=school
        WHERE can_billing AND r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL AND i.billing_account_id=ANY(account_ids)
      UNION ALL SELECT 'ATTENDANCE', ar.recorded_at, ar.status::text FROM hon.attendance_records ar
        WHERE can_attendance AND ar.organization_id=org AND ar.school_id=school AND ar.student_profile_id=ANY(profile_ids)
    ) z WHERE z.at <= as_of ORDER BY z.at DESC, z.kind, z.detail LIMIT 30) e), '[]'::jsonb);

  RETURN jsonb_build_object('generatedAt', hon.school_contact_card_time(as_of),
    'person', jsonb_build_object('personId', person.id, 'version', person.version, 'givenName', person.given_name, 'familyName', person.family_name,
      'email', person.email::text, 'phoneE164', person.phone_e164, 'createdAt', hon.school_contact_card_time(person.created_at)),
    'overview', overview, 'family', family, 'appointments', appointments, 'tasks', tasks, 'membership', membership, 'billing', billing,
    'messages', messages, 'timeline', timeline);
END $$;

REVOKE ALL ON FUNCTION hon.school_contact_card_can(uuid,uuid,uuid,text), hon.school_contact_card_time(timestamptz), hon.read_school_contact_card(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_contact_card(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
