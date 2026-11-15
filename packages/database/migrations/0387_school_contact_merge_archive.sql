BEGIN;

-- C3 (0387, allocated by the coordinator 2026-11-15): merge and delete on the contact card. Owner (David), 2026-11-15
-- 18:04Z: "Merge and delete is needed." Read as (stated in the thread): Delete archives the contact (kept, restorable,
-- history intact; never erased), Merge keeps one person and moves the other's live links onto them, then archives the
-- other as merged. Nothing is sent or charged.
--   people.archive (new, sensitive, staff-assignable; system OWNER roles): archive and restore. Refused while the person
--     has a current membership (DRAFT, ACTIVE, FROZEN, CANCELLATION_PENDING), an OPEN lead, or an open invoice balance on
--     an account they are responsible for. A merged contact cannot be restored.
--   people.merge (new, sensitive, staff-assignable; system OWNER roles): merge B into A at the session school. Moves B's
--     leads, family links, billing accounts, consents on channels A has none for, and conversations to A, then archives B
--     as MERGED into A. Refused when B has a student record, any membership, registration or import history (immutable
--     evidence that names B), when A and B are in the same family, when both have a canonical billing account, or when
--     either is archived. What stays on B (its message log and consents A already has) stays readable as history.
-- Two steps: a preview returns the plan, blockers and a plan hash; the command needs the exact person versions and that
-- hash, re-checks everything under row locks, and has exact-request idempotency. Audit and outbox carry ids only.
-- The contacts list gains an ARCHIVED segment (not counted in ALL); the contact card shows segment ARCHIVED.
-- The runtime gains no table privilege: the five entry points are SECURITY DEFINER.

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('people.archive','Archive (delete) and restore contacts of the school; history is kept',true,true),
  ('people.merge','Merge a duplicate contact into another contact of the school',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('people.archive','people.merge') AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'people.archive / people.merge already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,x.code FROM hon.roles r CROSS JOIN (VALUES ('people.archive'),('people.merge')) x(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- One row per archive. The current archive of a person is the row with restored_at NULL. Rows are never deleted.
CREATE TABLE hon.school_contact_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  person_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ARCHIVED','MERGED')),
  merged_into_person_id uuid,
  archived_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  restored_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  restored_at timestamptz,
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (merged_into_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  CHECK ((kind='MERGED')=(merged_into_person_id IS NOT NULL) AND merged_into_person_id IS DISTINCT FROM person_id),
  CHECK ((restored_at IS NULL)=(restored_by_principal_id IS NULL) AND (kind='ARCHIVED' OR restored_at IS NULL))
);
CREATE UNIQUE INDEX school_contact_archives_current ON hon.school_contact_archives(person_id) WHERE restored_at IS NULL;
CREATE INDEX school_contact_archives_school ON hon.school_contact_archives(organization_id,school_id) WHERE restored_at IS NULL;
ALTER TABLE hon.school_contact_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_contact_archives FORCE ROW LEVEL SECURITY;

-- Never deleted or truncated; an update may only record the restore of a plain archive, once.
CREATE FUNCTION hon.guard_school_contact_archive() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'School contact archives are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.restored_at IS NOT NULL THEN RAISE EXCEPTION 'A new archive is current' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.restored_at IS NOT NULL OR NEW.restored_at IS NULL
    OR (to_jsonb(NEW)-ARRAY['restored_at','restored_by_principal_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['restored_at','restored_by_principal_id']) THEN
    RAISE EXCEPTION 'A school contact archive only records its restore, once' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_contact_archives_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_contact_archives
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_contact_archive();
CREATE TRIGGER school_contact_archives_no_truncate BEFORE TRUNCATE ON hon.school_contact_archives
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_contact_archive();

-- Live direct-human staff authority with one of the two new permissions at the session school (the 0330 rules).
CREATE FUNCTION hon.require_school_contact_admin(subject text, permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission NOT IN ('people.archive','people.merge')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Exact-request idempotency for one actor: NULL when reserved now, else the earlier exact result (the 0330 rules).
CREATE FUNCTION hon.school_contact_admin_begin(actor uuid, key text, fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  RETURN prior.response_body;
END $$;

-- What archiving one person would need and what blocks it (private; callers proved authority).
CREATE FUNCTION hon.school_contact_archive_plan(org uuid, school uuid, pid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'archived', a.id IS NOT NULL, 'mergedIntoPersonId', a.merged_into_person_id,
    'archiveBlockers', to_jsonb(array_remove(ARRAY[
      CASE WHEN a.id IS NOT NULL THEN 'ALREADY_ARCHIVED' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.participant_person_id=pid
        AND x.state IN ('DRAFT','ACTIVE','FROZEN','CANCELLATION_PENDING')) THEN 'HAS_CURRENT_MEMBERSHIP' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.primary_person_id=pid AND l.status='OPEN')
        THEN 'HAS_OPEN_LEAD' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.invoices i JOIN hon.billing_accounts b ON b.id=i.billing_account_id AND b.organization_id=org AND b.school_id=school
        WHERE i.organization_id=org AND i.school_id=school AND b.responsible_person_id=pid AND i.status='ISSUED'
          AND i.total_minor > coalesce((SELECT sum(r.amount_minor) FROM hon.invoice_payment_records r WHERE r.invoice_id=i.id
            AND r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL),0)) THEN 'HAS_OPEN_BALANCE' END], NULL)),
    'restoreBlockers', to_jsonb(array_remove(ARRAY[
      CASE WHEN a.id IS NULL THEN 'NOT_ARCHIVED' END,
      CASE WHEN a.kind='MERGED' THEN 'WAS_MERGED' END], NULL)))
  FROM (SELECT 1) one LEFT JOIN hon.school_contact_archives a ON a.person_id=pid AND a.organization_id=org AND a.school_id=school AND a.restored_at IS NULL
$$;

-- What merging B (mrg) into A (keep) would move and what blocks it (private; callers proved authority).
CREATE FUNCTION hon.school_contact_merge_plan(org uuid, school uuid, keep uuid, mrg uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'blockers', to_jsonb(array_remove(ARRAY[
      CASE WHEN keep=mrg THEN 'SAME_PERSON' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.school_contact_archives a WHERE a.person_id IN (keep,mrg) AND a.organization_id=org AND a.school_id=school AND a.restored_at IS NULL)
        THEN 'CONTACT_ARCHIVED' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.student_profiles s WHERE s.organization_id=org AND s.school_id=school AND s.person_id=mrg) THEN 'MERGED_HAS_STUDENT_RECORD' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.participant_person_id=mrg) THEN 'MERGED_HAS_MEMBERSHIPS' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.crm_lead_registration_conversions c WHERE c.organization_id=org AND c.school_id=school AND c.original_contact_person_id=mrg)
        OR EXISTS(SELECT 1 FROM hon.guardian_child_registration_receipts g WHERE g.organization_id=org AND g.school_id=school AND mrg IN (g.guardian_person_id,g.child_person_id))
        OR EXISTS(SELECT 1 FROM hon.crm_guardian_child_enrolled_children e WHERE e.organization_id=org AND e.school_id=school AND mrg IN (e.guardian_person_id,e.child_person_id))
        OR EXISTS(SELECT 1 FROM hon.crm_guardian_child_payer_designations d WHERE d.organization_id=org AND d.school_id=school AND d.guardian_person_id=mrg)
        OR EXISTS(SELECT 1 FROM hon.student_import_rows s WHERE s.organization_id=org AND s.school_id=school AND mrg IN (s.guardian_person_id,s.student_person_id))
        OR EXISTS(SELECT 1 FROM hon.billing_import_rows b WHERE b.organization_id=org AND b.school_id=school AND b.payer_person_id=mrg)
        THEN 'MERGED_HAS_REGISTRATION_HISTORY' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.family_members m JOIN hon.family_members k ON k.family_id=m.family_id AND k.person_id=keep
        WHERE m.organization_id=org AND m.school_id=school AND m.person_id=mrg) THEN 'BOTH_IN_SAME_FAMILY' END,
      CASE WHEN EXISTS(SELECT 1 FROM hon.billing_accounts b WHERE b.organization_id=org AND b.school_id=school AND b.responsible_person_id=mrg AND b.account_classification='CANONICAL')
        AND EXISTS(SELECT 1 FROM hon.billing_accounts b WHERE b.organization_id=org AND b.school_id=school AND b.responsible_person_id=keep AND b.account_classification='CANONICAL')
        THEN 'BOTH_HAVE_BILLING_ACCOUNTS' END,
      -- Both answered differently on one channel (say B replied STOP, A opted in): staff settle it on A first, so a merge never
      -- drops an opt-out behind the archived record while the conversation moves to A.
      CASE WHEN EXISTS(SELECT 1 FROM hon.communication_consents c JOIN hon.communication_consents k ON k.organization_id=c.organization_id
          AND k.school_id=c.school_id AND k.person_id=keep AND k.channel=c.channel AND k.status<>c.status
        WHERE c.organization_id=org AND c.school_id=school AND c.person_id=mrg) THEN 'CONSENT_CONFLICT' END], NULL)),
    'moves', jsonb_build_object(
      'leads', (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.primary_person_id=mrg),
      'familyLinks', (SELECT count(*) FROM hon.family_members m WHERE m.organization_id=org AND m.school_id=school AND m.person_id=mrg),
      'billingAccounts', (SELECT count(*) FROM hon.billing_accounts b WHERE b.organization_id=org AND b.school_id=school AND b.responsible_person_id=mrg),
      'consents', (SELECT count(*) FROM hon.communication_consents c WHERE c.organization_id=org AND c.school_id=school AND c.person_id=mrg
        AND NOT EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.person_id=keep AND k.channel=c.channel)),
      'conversations', (SELECT count(*) FROM hon.school_conversations v WHERE v.organization_id=org AND v.school_id=school AND v.person_id=mrg)),
    'stays', jsonb_build_object(
      'consents', (SELECT count(*) FROM hon.communication_consents c WHERE c.organization_id=org AND c.school_id=school AND c.person_id=mrg
        AND EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.person_id=keep AND k.channel=c.channel)),
      'messages', (SELECT count(*) FROM hon.communication_messages m WHERE m.organization_id=org AND m.school_id=school AND m.recipient_person_id=mrg)))
$$;

-- A person of the session school as the preview shows it (private).
CREATE FUNCTION hon.school_contact_admin_person(org uuid, school uuid, pid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('personId', p.id, 'version', p.version, 'givenName', p.given_name, 'familyName', p.family_name,
    'email', p.email::text, 'phoneE164', p.phone_e164)
  FROM hon.people p WHERE p.id=pid AND p.organization_id=org AND p.school_id=school
$$;

-- The contacts list and the card: an archived or merged person is segment ARCHIVED (it wins over every other segment).
-- Unchanged from 0373 otherwise.
CREATE OR REPLACE FUNCTION hon.school_contact_facts(org uuid, school uuid, as_of timestamptz)
RETURNS TABLE(person_id uuid, segment text, membership_id uuid, plan_id uuid, plan_name text, program_id uuid, program_name text, plan_code text, ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH counted AS (
    SELECT x.participant_person_id AS person_id, x.id AS membership_id, x.plan_code, x.term_started_at, x.term_ends_at,
      CASE WHEN c.at IS NULL THEN x.term_ends_at WHEN x.term_ends_at IS NULL THEN c.at ELSE least(c.at, x.term_ends_at) END AS ended
    FROM hon.memberships x
    LEFT JOIN LATERAL (SELECT min(a.occurred_at) AS at FROM hon.audit_events a
      WHERE a.organization_id=org AND a.school_id=school AND a.entity_id=x.id AND a.action_code='billing.membership.cancel'
        AND a.result='SUCCEEDED' AND a.entity_type='MEMBERSHIP') c ON true
    WHERE x.organization_id=org AND x.school_id=school AND x.state<>'DRAFT' AND x.term_started_at IS NOT NULL
      AND NOT (x.state='CANCELLED' AND c.at IS NULL)
  ),
  cur AS (
    SELECT DISTINCT ON (m.person_id) m.person_id, m.membership_id, m.plan_code, m.term_ends_at
    FROM counted m WHERE m.term_started_at <= as_of AND (m.ended IS NULL OR m.ended > as_of)
    ORDER BY m.person_id, m.term_started_at DESC, m.membership_id
  ),
  former AS (SELECT DISTINCT x.participant_person_id AS person_id FROM hon.memberships x
    WHERE x.organization_id=org AND x.school_id=school AND x.state<>'DRAFT' AND x.term_started_at IS NOT NULL),
  open_leads AS (SELECT l.primary_person_id AS person_id,
      bool_or(EXISTS(SELECT 1 FROM hon.crm_appointments a WHERE a.organization_id=org AND a.school_id=school AND a.crm_lead_id=l.id
        AND a.appointment_type='TRIAL' AND a.status<>'CANCELLED')) AS trial
    FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.status='OPEN' GROUP BY l.primary_person_id)
  SELECT p.id,
    CASE WHEN ar.person_id IS NOT NULL THEN 'ARCHIVED' WHEN c.person_id IS NOT NULL THEN 'STUDENT' WHEN o.trial THEN 'TRIAL' WHEN o.person_id IS NOT NULL THEN 'PROSPECT'
      WHEN f.person_id IS NOT NULL THEN 'INACTIVE' ELSE 'OTHER' END,
    c.membership_id, v.plan_id, btrim(v.display_name), v.program_id, btrim(g.name), c.plan_code, c.term_ends_at
  FROM hon.people p
  LEFT JOIN cur c ON c.person_id=p.id
  LEFT JOIN open_leads o ON o.person_id=p.id
  LEFT JOIN former f ON f.person_id=p.id
  LEFT JOIN hon.school_contact_archives ar ON ar.person_id=p.id AND ar.organization_id=org AND ar.school_id=school AND ar.restored_at IS NULL
  LEFT JOIN hon.membership_plan_selections s ON s.membership_id=c.membership_id AND s.organization_id=org AND s.school_id=school
  LEFT JOIN hon.membership_plan_versions v ON v.plan_id=s.plan_id AND v.version=s.plan_version AND v.organization_id=org AND v.school_id=school
  LEFT JOIN hon.programs g ON g.id=v.program_id AND g.organization_id=org AND g.school_id=school
  WHERE p.organization_id=org AND p.school_id=school
$$;

-- The contacts list: segment ARCHIVED can be chosen and has its own count; ALL leaves archived contacts out. Unchanged from
-- 0373 otherwise.
CREATE OR REPLACE FUNCTION hon.read_school_contact_list(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); as_of timestamptz:=statement_timestamp();
  seg text:='ALL'; needle text; rank_f uuid; program_f uuid; plan_f uuid; days integer; after_id uuid; with_options boolean:=false;
  a_family text; a_given text; a_created timestamptz; rows_json jsonb; more boolean; counts jsonb; options jsonb:=NULL;
  lim constant integer:=50; uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  PERFORM hon.require_school_contacts_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('segment','query','rankId','programId','planId','endsWithinDays','afterId','options'))
    OR (p_input ? 'segment' AND (jsonb_typeof(p_input->'segment')<>'string' OR p_input->>'segment' NOT IN ('ALL','STUDENT','TRIAL','PROSPECT','INACTIVE','ARCHIVED')))
    OR (p_input ? 'query' AND (jsonb_typeof(p_input->'query')<>'string' OR length(p_input->>'query') NOT BETWEEN 1 AND 100 OR p_input->>'query' ~ '[[:cntrl:]]'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['rankId','programId','planId','afterId']) k WHERE p_input ? k AND (jsonb_typeof(p_input->k)<>'string' OR lower(p_input->>k) !~ uuid_re))
    OR (p_input ? 'endsWithinDays' AND (jsonb_typeof(p_input->'endsWithinDays')<>'number' OR p_input->>'endsWithinDays' NOT IN ('7','30','60','90')))
    OR (p_input ? 'options' AND jsonb_typeof(p_input->'options')<>'boolean') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  seg:=coalesce(p_input->>'segment','ALL'); needle:=nullif(btrim(p_input->>'query'),'');
  rank_f:=(p_input->>'rankId')::uuid; program_f:=(p_input->>'programId')::uuid; plan_f:=(p_input->>'planId')::uuid;
  days:=(p_input->>'endsWithinDays')::integer; after_id:=(p_input->>'afterId')::uuid; with_options:=coalesce((p_input->>'options')::boolean,false);
  IF after_id IS NOT NULL THEN
    SELECT family_name, given_name, created_at INTO a_family, a_given, a_created FROM hon.people WHERE id=after_id AND organization_id=org AND school_id=school;
    IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_CONTACTS_STALE_CURSOR' USING ERRCODE='22023'; END IF;
  END IF;

  WITH hits AS MATERIALIZED (
    SELECT f.*, p.given_name, p.family_name, p.email::text AS email, p.phone_e164, p.version, p.created_at
    FROM hon.school_contact_facts(org, school, as_of) f JOIN hon.people p ON p.id=f.person_id AND p.organization_id=org AND p.school_id=school
    WHERE (needle IS NULL OR concat_ws(' ', p.given_name, p.family_name, p.email::text, p.phone_e164) ILIKE '%' || needle || '%')
      AND (program_f IS NULL OR f.program_id=program_f) AND (plan_f IS NULL OR f.plan_id=plan_f)
      AND (days IS NULL OR (f.membership_id IS NOT NULL AND f.ends_at IS NOT NULL AND f.ends_at <= as_of + make_interval(days => days)))
      AND (rank_f IS NULL OR EXISTS(SELECT 1 FROM hon.student_profiles sp JOIN hon.student_curriculum_enrollments e
        ON e.student_profile_id=sp.id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE' AND e.current_rank_id=rank_f
        WHERE sp.person_id=f.person_id AND sp.organization_id=org AND sp.school_id=school))
  ), page AS (
    SELECT h.* FROM hits h
    WHERE ((seg='ALL' AND h.segment<>'ARCHIVED') OR h.segment=seg)
      AND (after_id IS NULL OR (h.family_name, h.given_name, h.created_at, h.person_id) > (a_family, a_given, a_created, after_id))
    ORDER BY h.family_name, h.given_name, h.created_at, h.person_id LIMIT lim + 1
  ), shown AS (SELECT * FROM page ORDER BY family_name, given_name, created_at, person_id LIMIT lim)
  SELECT (SELECT jsonb_build_object('ALL', count(*) FILTER (WHERE segment<>'ARCHIVED'), 'STUDENT', count(*) FILTER (WHERE segment='STUDENT'), 'TRIAL', count(*) FILTER (WHERE segment='TRIAL'),
      'PROSPECT', count(*) FILTER (WHERE segment='PROSPECT'), 'INACTIVE', count(*) FILTER (WHERE segment='INACTIVE'),
      'ARCHIVED', count(*) FILTER (WHERE segment='ARCHIVED')) FROM hits),
    (SELECT coalesce(jsonb_agg(jsonb_build_object('personId', s.person_id, 'version', s.version, 'givenName', s.given_name, 'familyName', s.family_name,
      'email', s.email, 'phoneE164', s.phone_e164, 'segment', s.segment, 'planName', s.plan_name, 'planCode', s.plan_code, 'programName', s.program_name,
      'membershipEndsAt', CASE WHEN s.ends_at IS NULL THEN NULL ELSE to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'ranks', coalesce((SELECT jsonb_agg(jsonb_build_object('rank', btrim(r.name), 'color', CASE WHEN r.display_color ~* '^#[0-9a-f]{3,8}$' THEN r.display_color END)
          ORDER BY btrim(c.name), r.progression_order)
        FROM hon.student_profiles sp JOIN hon.student_curriculum_enrollments e ON e.student_profile_id=sp.id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE'
        JOIN hon.curriculum_ranks r ON r.id=e.current_rank_id AND r.organization_id=org AND r.school_id=school
        JOIN hon.curricula c ON c.id=e.curriculum_id AND c.organization_id=org AND c.school_id=school
        WHERE sp.person_id=s.person_id AND sp.organization_id=org AND sp.school_id=school), '[]'::jsonb))
      ORDER BY s.family_name, s.given_name, s.created_at, s.person_id), '[]'::jsonb) FROM shown s),
    (SELECT count(*) > lim FROM page)
    INTO counts, rows_json, more;

  IF with_options THEN
    options:=jsonb_build_object(
      'ranks', coalesce((SELECT jsonb_agg(jsonb_build_object('rankId', r.id, 'curriculum', btrim(c.name), 'rank', btrim(r.name)) ORDER BY btrim(c.name), c.id, r.progression_order)
        FROM (SELECT r.* FROM hon.curriculum_ranks r WHERE r.organization_id=org AND r.school_id=school ORDER BY r.curriculum_id, r.progression_order LIMIT 200) r
        JOIN hon.curricula c ON c.id=r.curriculum_id AND c.organization_id=org AND c.school_id=school), '[]'::jsonb),
      'programs', coalesce((SELECT jsonb_agg(jsonb_build_object('programId', g.id, 'name', btrim(g.name)) ORDER BY btrim(g.name), g.id)
        FROM (SELECT * FROM hon.programs g WHERE g.organization_id=org AND g.school_id=school ORDER BY btrim(g.name), g.id LIMIT 100) g), '[]'::jsonb),
      'plans', coalesce((SELECT jsonb_agg(jsonb_build_object('planId', v.plan_id, 'name', btrim(v.display_name)) ORDER BY btrim(v.display_name), v.plan_id)
        FROM (SELECT DISTINCT ON (v.plan_id) v.plan_id, v.display_name FROM hon.membership_plan_versions v
          WHERE v.organization_id=org AND v.school_id=school ORDER BY v.plan_id, v.version DESC LIMIT 100) v), '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object('generatedAt', to_char(as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'segment', seg,
    'counts', counts, 'rows', rows_json, 'hasMore', more, 'options', options);
END $$;

-- Archive state and what blocks archive / restore for one person (people.archive).
CREATE FUNCTION hon.read_school_contact_archive(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); pid uuid; person jsonb;
BEGIN
  PERFORM hon.require_school_contact_admin(p_subject,'people.archive');
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['personId']
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR p_input->>'personId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  pid:=(p_input->>'personId')::uuid;
  person:=hon.school_contact_admin_person(org,school,pid);
  IF person IS NULL THEN RAISE EXCEPTION 'SCHOOL_CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('person', person)||hon.school_contact_archive_plan(org,school,pid);
END $$;

-- Archive (restore=false) or restore (restore=true) one person at an exact version (people.archive).
CREATE FUNCTION hon.school_contact_archive_command(p_subject text, p_input jsonb, key text, request uuid, correlation uuid, restore boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; pid uuid; ver integer;
  p hon.people; plan jsonb; blockers jsonb; a hon.school_contact_archives; result jsonb; ids jsonb; verb text:=CASE WHEN restore THEN 'restore' ELSE 'archive' END;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['personId','version']
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR p_input->>'personId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'version') IS DISTINCT FROM 'number' OR p_input->>'version' !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_command_args_ok(p_subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  pid:=(p_input->>'personId')::uuid; ver:=(p_input->>'version')::integer;
  actor:=hon.require_school_contact_admin(p_subject,'people.archive');
  prior:=hon.school_contact_admin_begin(actor,key,encode(sha256(convert_to('school_contact.'||verb||':'||pid||':'||ver,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_school_contact_admin(p_subject,'people.archive') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  SELECT * INTO p FROM hon.people x WHERE x.id=pid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p.version<>ver THEN RAISE EXCEPTION 'SCHOOL_CONTACT_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  plan:=hon.school_contact_archive_plan(org,school,pid);
  blockers:=plan->CASE WHEN restore THEN 'restoreBlockers' ELSE 'archiveBlockers' END;
  IF jsonb_array_length(blockers)>0 THEN RAISE EXCEPTION 'SCHOOL_CONTACT_BLOCKED' USING ERRCODE='55000', HINT=blockers::text; END IF;
  IF restore THEN
    UPDATE hon.school_contact_archives SET restored_at=clock_timestamp(),restored_by_principal_id=actor
      WHERE person_id=pid AND organization_id=org AND school_id=school AND restored_at IS NULL RETURNING * INTO a;
  ELSE
    INSERT INTO hon.school_contact_archives(organization_id,school_id,person_id,kind,archived_by_principal_id)
      VALUES(org,school,pid,'ARCHIVED',actor) RETURNING * INTO a;
  END IF;
  UPDATE hon.people SET version=version+1,updated_at=clock_timestamp() WHERE id=pid RETURNING * INTO p;
  result:=jsonb_build_object('personId',pid,'version',p.version,'archived',NOT restore);
  ids:=jsonb_build_object('personId',pid,'archiveId',a.id,'version',p.version);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','people.'||verb,'PERSON',pid,jsonb_build_object('version',ver,'archived',restore),ids,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,CASE WHEN restore THEN 'people.restored' ELSE 'people.archived' END,1,'PERSON',pid,p.version,correlation,request,ids);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_contact_admin(p_subject,'people.archive') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

CREATE FUNCTION hon.archive_school_contact(p_subject text, p_input jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT hon.school_contact_archive_command(p_subject,p_input,key,request,correlation,false)
$$;
CREATE FUNCTION hon.restore_school_contact(p_subject text, p_input jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT hon.school_contact_archive_command(p_subject,p_input,key,request,correlation,true)
$$;

-- Step 1 of a merge: both people, the plan, its blockers and the plan hash the command must repeat (people.merge).
CREATE FUNCTION hon.read_school_contact_merge(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); keep uuid; mrg uuid; k jsonb; m jsonb; plan jsonb;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  PERFORM hon.require_school_contact_admin(p_subject,'people.merge');
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['keepPersonId','mergePersonId']
    OR jsonb_typeof(p_input->'keepPersonId') IS DISTINCT FROM 'string' OR p_input->>'keepPersonId' !~ uuid_re
    OR jsonb_typeof(p_input->'mergePersonId') IS DISTINCT FROM 'string' OR p_input->>'mergePersonId' !~ uuid_re THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  keep:=(p_input->>'keepPersonId')::uuid; mrg:=(p_input->>'mergePersonId')::uuid;
  k:=hon.school_contact_admin_person(org,school,keep); m:=hon.school_contact_admin_person(org,school,mrg);
  IF k IS NULL OR m IS NULL THEN RAISE EXCEPTION 'SCHOOL_CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  plan:=hon.school_contact_merge_plan(org,school,keep,mrg);
  RETURN jsonb_build_object('keep',k,'merge',m)||plan||jsonb_build_object('planHash',encode(sha256(convert_to(plan::text,'UTF8')),'hex'));
END $$;

-- Step 2: merge B into A at the exact versions and plan hash of the preview (people.merge).
CREATE FUNCTION hon.merge_school_contacts(p_subject text, p_input jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; keep uuid; mrg uuid;
  kv integer; mv integer; k hon.people; m hon.people; plan jsonb; a hon.school_contact_archives; result jsonb; ids jsonb; now_at timestamptz:=clock_timestamp();
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['keepPersonId','keepVersion','mergePersonId','mergeVersion','planHash']
    OR jsonb_typeof(p_input->'keepPersonId') IS DISTINCT FROM 'string' OR p_input->>'keepPersonId' !~ uuid_re
    OR jsonb_typeof(p_input->'mergePersonId') IS DISTINCT FROM 'string' OR p_input->>'mergePersonId' !~ uuid_re
    OR jsonb_typeof(p_input->'keepVersion') IS DISTINCT FROM 'number' OR p_input->>'keepVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'mergeVersion') IS DISTINCT FROM 'number' OR p_input->>'mergeVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'planHash') IS DISTINCT FROM 'string' OR p_input->>'planHash' !~ '^[0-9a-f]{64}$'
    OR NOT hon.membership_command_args_ok(p_subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  keep:=(p_input->>'keepPersonId')::uuid; mrg:=(p_input->>'mergePersonId')::uuid;
  kv:=(p_input->>'keepVersion')::integer; mv:=(p_input->>'mergeVersion')::integer;
  actor:=hon.require_school_contact_admin(p_subject,'people.merge');
  prior:=hon.school_contact_admin_begin(actor,key,encode(sha256(convert_to('school_contact.merge:'||keep||':'||kv||':'||mrg||':'||mv||':'||(p_input->>'planHash'),'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_school_contact_admin(p_subject,'people.merge') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  -- Both people locked in id order, then a per-school lock so two merges never interleave their moves.
  PERFORM 1 FROM hon.people x WHERE x.id IN (keep,mrg) AND x.organization_id=org AND x.school_id=school ORDER BY x.id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_contact_merge:'||school::text,0));
  SELECT * INTO k FROM hon.people x WHERE x.id=keep AND x.organization_id=org AND x.school_id=school;
  SELECT * INTO m FROM hon.people x WHERE x.id=mrg AND x.organization_id=org AND x.school_id=school;
  IF k.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION 'SCHOOL_CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF k.version<>kv OR m.version<>mv THEN RAISE EXCEPTION 'SCHOOL_CONTACT_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  plan:=hon.school_contact_merge_plan(org,school,keep,mrg);
  IF jsonb_array_length(plan->'blockers')>0 THEN RAISE EXCEPTION 'SCHOOL_CONTACT_BLOCKED' USING ERRCODE='55000', HINT=(plan->'blockers')::text; END IF;
  IF encode(sha256(convert_to(plan::text,'UTF8')),'hex')<>p_input->>'planHash' THEN RAISE EXCEPTION 'SCHOOL_CONTACT_PREVIEW_STALE' USING ERRCODE='40001'; END IF;

  UPDATE hon.crm_leads SET primary_person_id=keep,version=version+1,updated_at=now_at WHERE organization_id=org AND school_id=school AND primary_person_id=mrg;
  UPDATE hon.family_members SET person_id=keep WHERE organization_id=org AND school_id=school AND person_id=mrg;
  UPDATE hon.billing_accounts SET responsible_person_id=keep,version=version+1 WHERE organization_id=org AND school_id=school AND responsible_person_id=mrg;
  UPDATE hon.communication_consents c SET person_id=keep,version=c.version+1,updated_at=now_at,updated_by_principal_id=actor
    WHERE c.organization_id=org AND c.school_id=school AND c.person_id=mrg
      AND NOT EXISTS(SELECT 1 FROM hon.communication_consents x WHERE x.person_id=keep AND x.channel=c.channel);
  UPDATE hon.school_conversations SET person_id=keep,version=version+1,updated_at=now_at WHERE organization_id=org AND school_id=school AND person_id=mrg;
  INSERT INTO hon.school_contact_archives(organization_id,school_id,person_id,kind,merged_into_person_id,archived_by_principal_id)
    VALUES(org,school,mrg,'MERGED',keep,actor) RETURNING * INTO a;
  UPDATE hon.people SET version=version+1,updated_at=now_at WHERE id=keep RETURNING * INTO k;
  UPDATE hon.people SET version=version+1,updated_at=now_at WHERE id=mrg RETURNING * INTO m;

  result:=jsonb_build_object('keepPersonId',keep,'keepVersion',k.version,'mergedPersonId',mrg,'mergedVersion',m.version,'moved',plan->'moves');
  ids:=jsonb_build_object('keepPersonId',keep,'mergedPersonId',mrg,'archiveId',a.id,'moved',plan->'moves');
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','people.merge','PERSON',mrg,jsonb_build_object('keepVersion',kv,'mergeVersion',mv),ids,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'people.merged',1,'PERSON',mrg,m.version,correlation,request,ids);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_contact_admin(p_subject,'people.merge') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_school_contact_archive(text,jsonb)','hon.archive_school_contact(text,jsonb,text,uuid,uuid)',
    'hon.restore_school_contact(text,jsonb,text,uuid,uuid)','hon.read_school_contact_merge(text,jsonb)','hon.merge_school_contacts(text,jsonb,text,uuid,uuid)'];
  fns text[]:=ARRAY['hon.guard_school_contact_archive()','hon.require_school_contact_admin(text,text)','hon.school_contact_admin_begin(uuid,text,text)',
    'hon.school_contact_archive_plan(uuid,uuid,uuid)','hon.school_contact_merge_plan(uuid,uuid,uuid,uuid)','hon.school_contact_admin_person(uuid,uuid,uuid)',
    'hon.school_contact_archive_command(text,jsonb,text,uuid,uuid,boolean)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  EXECUTE 'REVOKE ALL ON TABLE hon.school_contact_archives FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_contact_archives FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
