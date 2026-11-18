BEGIN;

-- School email and text blasts BL1 (0524, allocated by the coordinator 2026-11-18). Owner request (David, 2026-11-18):
-- blasts with merge tags, a checkout link and pictures or video; this is piece 1 (compose, audience, merge tags, send).
-- Spec: docs/architecture/SCHOOL_BLASTS.md. Contract: @hon/contracts school-blasts.ts (validateSaveSchoolBlast mirrors
-- the checks here).
-- Rules:
--   B1  marketing.blast.read (OWNER by default, staff-assignable) lists blasts, reads one with its results and counts its
--       audience; marketing.blast.send (sensitive, OWNER by default, staff-assignable) saves drafts, sends or schedules
--       them and cancels a scheduled one. Direct human only (HUMAN_USER, HUMAN_UI, no action request or delegation), active
--       school and organization, live ESSENTIAL/CORE/COMPLETE access; the actor is proved again after the locks.
--   B2  A blast is one channel (EMAIL with a subject, or SMS), one plain-text body with the closed merge tags
--       {{first_name}} {{last_name}} {{school_name}} {{staff_name}}, and an audience of 1-5 groups optionally narrowed to
--       people carrying any of up to 10 contact tags. DRAFT is edited by exact version; QUEUED and CANCELLED are final.
--   B3  The audience is resolved in the database: a matched person without an address for the channel is replaced by the
--       guardians of their families who have one; recipients are deduplicated by address (one per household); people
--       without OPTED_IN consent for the channel are skipped; demo-data people are never included.
--   B4  Sending writes one QUEUED communication_messages row per reachable recipient (origin CAMPAIGN, origin_id the blast,
--       rendered subject and body, scheduled_at the chosen time). The 0243 worker delivers them with its own consent, STOP,
--       quiet-hours and sender checks; nothing here talks to a provider. At most 2,000 reachable recipients per blast and
--       10 blasts handed over per school in 24 hours (per-school lock). A scheduled blast can be cancelled before its time:
--       its messages without a delivery become CANCELLED.
--   B5  Every command has exact-request idempotency, an audit row and an inert outbox event with ids and counts only (no
--       address or text). Recipient rows are append-only. The runtime gains no table privilege, only EXECUTE on six entry
--       points.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'School blasts require a restricted runtime'; END IF;
  IF to_regclass('hon.contact_tags') IS NULL OR to_regclass('hon.communication_deliveries') IS NULL OR to_regclass('hon.school_contact_archives') IS NULL
    OR to_regprocedure('hon.demo_data_is_demo(text,uuid)') IS NULL OR to_regprocedure('hon.staff_shift_display_name(uuid)') IS NULL
    OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='communication_messages_origin_shape') THEN
    RAISE EXCEPTION '0524 requires 0416, 0423, 0243, 0459, 0467, 0224 and 0523'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('marketing.blast.read','See the school''s email and text blasts, their results and audience counts',false,true),
  ('marketing.blast.send','Write, send, schedule and cancel email and text blasts to the school''s contacts',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE (code='marketing.blast.read' AND NOT is_sensitive AND is_staff_assignable)
      OR (code='marketing.blast.send' AND is_sensitive AND is_staff_assignable))<>2 THEN
    RAISE EXCEPTION 'blast permissions already exist with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN ('marketing.blast.read','marketing.blast.send') ON CONFLICT DO NOTHING;

-- Plain text: trimmed of spaces and line breaks, min..max characters, no control characters except tab and line breaks,
-- and every {{...}} one of the closed merge tags.
CREATE FUNCTION hon.school_blast_text_ok(v jsonb,p_min integer,p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND (v#>>'{}') !~ '^[ \t\n\r]' AND (v#>>'{}') !~ '[ \t\n\r]$'
    AND length(v#>>'{}') BETWEEN p_min AND p_max AND (v#>>'{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
    AND regexp_replace(v#>>'{}','\{\{(first_name|last_name|school_name|staff_name)\}\}','','g') !~ '(\{\{|\}\})',false)
$$;
-- One line of text (name, subject).
CREATE FUNCTION hon.school_blast_line_ok(v jsonb,p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.school_blast_text_ok(v,1,p_max) AND (v#>>'{}') !~ '[\t\n\r]'
$$;
-- {groups: 1-5 distinct closed groups, tags: 0-10 distinct contact tags}.
CREATE FUNCTION hon.school_blast_audience_ok(a jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(a)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k)=ARRAY['groups','tags']
    AND jsonb_typeof(a->'groups')='array' AND jsonb_array_length(a->'groups') BETWEEN 1 AND 5
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a->'groups') g WHERE jsonb_typeof(g)<>'string'
      OR (g#>>'{}') NOT IN ('ACTIVE_STUDENTS','PROSPECTS','TRIAL','FORMER_STUDENTS','ALL_CONTACTS'))
    AND (SELECT count(DISTINCT g#>>'{}') FROM jsonb_array_elements(a->'groups') g)=jsonb_array_length(a->'groups')
    AND jsonb_typeof(a->'tags')='array' AND jsonb_array_length(a->'tags')<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a->'tags') t WHERE jsonb_typeof(t)<>'string'
      OR (t#>>'{}') !~ '^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$')
    AND (SELECT count(DISTINCT lower(t#>>'{}')) FROM jsonb_array_elements(a->'tags') t)=jsonb_array_length(a->'tags'),false)
$$;

CREATE TABLE hon.school_blasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  name text NOT NULL CHECK (hon.school_blast_line_ok(to_jsonb(name),100)),
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  subject text CHECK (subject IS NULL OR hon.school_blast_line_ok(to_jsonb(subject),150)),
  body text NOT NULL CHECK (hon.school_blast_text_ok(to_jsonb(body),1,CASE channel WHEN 'EMAIL' THEN 3500 ELSE 1000 END)),
  audience jsonb NOT NULL CHECK (hon.school_blast_audience_ok(audience)),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','QUEUED','CANCELLED')),
  send_at timestamptz,
  queued_at timestamptz,
  queued_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancelled_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recipient_count integer CHECK (recipient_count IS NULL OR recipient_count BETWEEN 1 AND 2000),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id),
  CHECK ((channel='EMAIL')=(subject IS NOT NULL)),
  CHECK ((status='DRAFT')=(queued_at IS NULL AND queued_by_principal_id IS NULL AND recipient_count IS NULL)),
  CHECK (status<>'DRAFT' OR send_at IS NULL),
  CHECK ((status='CANCELLED')=(cancelled_at IS NOT NULL AND cancelled_by_principal_id IS NOT NULL))
);
CREATE INDEX school_blasts_school_idx ON hon.school_blasts(organization_id,school_id,updated_at DESC,id);
CREATE INDEX school_blasts_queued_idx ON hon.school_blasts(organization_id,school_id,queued_at) WHERE queued_at IS NOT NULL;
ALTER TABLE hon.school_blasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_blasts FORCE ROW LEVEL SECURITY;

CREATE TABLE hon.school_blast_recipients (
  blast_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  person_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('QUEUED','NO_CONSENT','NO_ADDRESS','DUPLICATE_ADDRESS')),
  message_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (blast_id,person_id),
  FOREIGN KEY (blast_id,organization_id,school_id) REFERENCES hon.school_blasts(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id,organization_id,school_id) REFERENCES hon.communication_messages(id,organization_id,school_id) ON DELETE RESTRICT,
  CHECK ((outcome='QUEUED')=(message_id IS NOT NULL))
);
CREATE UNIQUE INDEX school_blast_recipients_message ON hon.school_blast_recipients(message_id) WHERE message_id IS NOT NULL;
ALTER TABLE hon.school_blast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_blast_recipients FORCE ROW LEVEL SECURITY;
-- No policies on either table: reachable only through the fixed definer functions below.

CREATE FUNCTION hon.guard_school_blast() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'SCHOOL_BLAST_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='school_blast_recipients' THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'SCHOOL_BLAST_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'DRAFT' THEN RAISE EXCEPTION 'SCHOOL_BLAST_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  -- Identity never changes; a version bump always; only a DRAFT changes its content; QUEUED may only become CANCELLED.
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.created_by_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 OR OLD.status='CANCELLED'
    OR (OLD.status='QUEUED' AND (NEW.status<>'CANCELLED'
      OR (NEW.name,NEW.channel,NEW.subject,NEW.body,NEW.audience,NEW.send_at,NEW.queued_at,NEW.queued_by_principal_id,NEW.recipient_count)
        IS DISTINCT FROM (OLD.name,OLD.channel,OLD.subject,OLD.body,OLD.audience,OLD.send_at,OLD.queued_at,OLD.queued_by_principal_id,OLD.recipient_count)))
    OR (OLD.status='DRAFT' AND NEW.status='CANCELLED') THEN
    RAISE EXCEPTION 'SCHOOL_BLAST_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_blasts FOR EACH ROW EXECUTE FUNCTION hon.guard_school_blast();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_blasts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_blast();
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_blast_recipients FOR EACH ROW EXECUTE FUNCTION hon.guard_school_blast();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_blast_recipients FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_blast();

-- Live direct-human authority at the current school with the given blast permission. Same identity rules as 0478.
CREATE FUNCTION hon.require_school_blast_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission NOT IN ('marketing.blast.read','marketing.blast.send')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 2048 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_BLAST_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_BLAST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The address a person is reached at on the channel, or null.
CREATE FUNCTION hon.school_blast_address(p_phone text,p_email text,chan text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE chan WHEN 'SMS' THEN nullif(btrim(p_phone),'') ELSE lower(nullif(btrim(p_email),'')) END
$$;

-- Everyone the audience reaches on the channel, with what happens to each (rule B3). One row per person.
CREATE FUNCTION hon.school_blast_resolve(org uuid,school uuid,chan text,aud jsonb) RETURNS TABLE(person_id uuid,outcome text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH g AS (SELECT array_agg(x#>>'{}') AS groups FROM jsonb_array_elements(aud->'groups') x),
  t AS (SELECT coalesce(array_agg(lower(x#>>'{}')),'{}') AS tags FROM jsonb_array_elements(aud->'tags') x),
  matched AS (
    SELECT p.* FROM hon.people p, g, t
    WHERE p.organization_id=org AND p.school_id=school AND NOT hon.demo_data_is_demo('people',p.id)
      AND NOT EXISTS(SELECT 1 FROM hon.school_contact_archives ar WHERE ar.person_id=p.id AND ar.organization_id=org AND ar.school_id=school AND ar.restored_at IS NULL)
      AND ('ALL_CONTACTS'=ANY(g.groups)
        OR ('ACTIVE_STUDENTS'=ANY(g.groups) AND EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school
          AND m.participant_person_id=p.id AND m.state='ACTIVE'))
        OR ('FORMER_STUDENTS'=ANY(g.groups) AND EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school
          AND m.participant_person_id=p.id AND m.state IN ('CANCELLED','EXPIRED'))
          AND NOT EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school
          AND m.participant_person_id=p.id AND m.state IN ('ACTIVE','FROZEN','CANCELLATION_PENDING')))
        OR ('PROSPECTS'=ANY(g.groups) AND EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school
          AND l.primary_person_id=p.id AND l.status='OPEN'))
        OR ('TRIAL'=ANY(g.groups) AND EXISTS(SELECT 1 FROM hon.crm_leads l JOIN hon.crm_appointments a ON a.crm_lead_id=l.id
          AND a.organization_id=l.organization_id AND a.school_id=l.school_id
          WHERE l.organization_id=org AND l.school_id=school AND l.primary_person_id=p.id AND l.status='OPEN'
            AND a.appointment_type='TRIAL' AND a.status IN ('SCHEDULED','COMPLETED'))))
      AND (cardinality(t.tags)=0 OR EXISTS(SELECT 1 FROM hon.contact_tags ct WHERE ct.organization_id=org AND ct.school_id=school
        AND ct.person_id=p.id AND ct.tag_key=ANY(t.tags)))
  ),
  -- A child (a STUDENT or DEPENDENT family member with a guardian, unless a birth date shows 18 or over) is always reached
  -- through guardians, and also at their own address when they have one (consent is still checked per person; owner
  -- decision 2026-11-18). Anyone else without an address is reached through guardians if any.
  kids AS (
    SELECT m.id,
      EXISTS(SELECT 1 FROM hon.family_members s JOIN hon.family_members gm ON gm.family_id=s.family_id AND gm.organization_id=org AND gm.school_id=school
          AND gm.member_role='GUARDIAN' AND gm.person_id<>m.id
        WHERE s.person_id=m.id AND s.organization_id=org AND s.school_id=school AND s.member_role IN ('STUDENT','DEPENDENT'))
      AND NOT EXISTS(SELECT 1 FROM hon.student_profiles sp WHERE sp.person_id=m.id AND sp.organization_id=org AND sp.school_id=school
        AND sp.birth_date IS NOT NULL AND sp.birth_date<=current_date-interval '18 years') AS minor
    FROM matched m
  ),
  reach AS (
    SELECT m.id AS matched_id,m.id AS person_id FROM matched m JOIN kids k ON k.id=m.id
    WHERE hon.school_blast_address(m.phone_e164,m.email::text,chan) IS NOT NULL
    UNION
    SELECT m.id,gp.id FROM matched m JOIN kids k ON k.id=m.id
      JOIN hon.family_members s ON s.person_id=m.id AND s.organization_id=org AND s.school_id=school AND s.member_role IN ('STUDENT','DEPENDENT')
      JOIN hon.family_members gm ON gm.family_id=s.family_id AND gm.organization_id=org AND gm.school_id=school AND gm.member_role='GUARDIAN' AND gm.person_id<>m.id
      JOIN hon.people gp ON gp.id=gm.person_id AND gp.organization_id=org AND gp.school_id=school
    WHERE (k.minor OR hon.school_blast_address(m.phone_e164,m.email::text,chan) IS NULL)
      AND hon.school_blast_address(gp.phone_e164,gp.email::text,chan) IS NOT NULL AND NOT hon.demo_data_is_demo('people',gp.id)
      AND NOT EXISTS(SELECT 1 FROM hon.school_contact_archives ar WHERE ar.person_id=gp.id AND ar.organization_id=org AND ar.school_id=school AND ar.restored_at IS NULL)
  ),
  recipients AS (
    SELECT DISTINCT r.person_id,hon.school_blast_address(p.phone_e164,p.email::text,chan) AS address,
      EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=org AND k.school_id=school AND k.person_id=r.person_id
        AND k.channel::text=chan AND k.status='OPTED_IN') AS consent
    FROM reach r JOIN hon.people p ON p.id=r.person_id AND p.organization_id=org AND p.school_id=school
  ),
  ranked AS (SELECT r.*,row_number() OVER (PARTITION BY r.address ORDER BY r.consent DESC,r.person_id) AS n FROM recipients r)
  SELECT r.person_id,CASE WHEN r.n>1 THEN 'DUPLICATE_ADDRESS' WHEN NOT r.consent THEN 'NO_CONSENT' ELSE 'QUEUED' END FROM ranked r
  UNION ALL
  SELECT m.id,'NO_ADDRESS' FROM matched m WHERE NOT EXISTS(SELECT 1 FROM reach r WHERE r.matched_id=m.id)
$$;

-- Fills the merge tags (rule B2): an empty first name is "there", an empty last name is nothing.
CREATE FUNCTION hon.school_blast_render(p_text text,p_first text,p_last text,p_school text,p_staff text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT replace(replace(replace(replace(p_text,'{{first_name}}',coalesce(nullif(btrim(p_first),''),'there')),
    '{{last_name}}',coalesce(btrim(p_last),'')),'{{school_name}}',coalesce(p_school,'')),'{{staff_name}}',coalesce(p_staff,''))
$$;

CREATE FUNCTION hon.school_blast_json(b hon.school_blasts) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('blastId',b.id,'name',b.name,'channel',b.channel,'subject',b.subject,'body',b.body,'audience',b.audience,
    'status',b.status,'version',b.version,'sendAt',hon.saas_ts(b.send_at),'queuedAt',hon.saas_ts(b.queued_at),'cancelledAt',hon.saas_ts(b.cancelled_at),
    'recipientCount',b.recipient_count,
    'outcomes',CASE WHEN b.status='DRAFT' THEN NULL ELSE (SELECT jsonb_build_object(
      'QUEUED',count(*) FILTER (WHERE r.outcome='QUEUED'),'NO_CONSENT',count(*) FILTER (WHERE r.outcome='NO_CONSENT'),
      'NO_ADDRESS',count(*) FILTER (WHERE r.outcome='NO_ADDRESS'),'DUPLICATE_ADDRESS',count(*) FILTER (WHERE r.outcome='DUPLICATE_ADDRESS'))
      FROM hon.school_blast_recipients r WHERE r.blast_id=b.id) END,
    'deliveries',CASE WHEN b.status='DRAFT' THEN NULL ELSE (SELECT jsonb_build_object(
      'WAITING',count(*) FILTER (WHERE x.s='WAITING'),'PENDING',count(*) FILTER (WHERE x.s='PENDING'),'SENDING',count(*) FILTER (WHERE x.s='SENDING'),
      'ACCEPTED',count(*) FILTER (WHERE x.s='ACCEPTED'),'DELIVERED',count(*) FILTER (WHERE x.s='DELIVERED'),'BOUNCED',count(*) FILTER (WHERE x.s='BOUNCED'),
      'FAILED',count(*) FILTER (WHERE x.s='FAILED'),'SUPPRESSED',count(*) FILTER (WHERE x.s='SUPPRESSED'),'UNKNOWN',count(*) FILTER (WHERE x.s='UNKNOWN'),
      'CANCELLED',count(*) FILTER (WHERE x.s='CANCELLED'))
      FROM (SELECT CASE WHEN m.lifecycle='CANCELLED' AND d.id IS NULL THEN 'CANCELLED' WHEN d.id IS NULL THEN 'WAITING' ELSE d.status::text END AS s
        FROM hon.school_blast_recipients r JOIN hon.communication_messages m ON m.id=r.message_id
        LEFT JOIN hon.communication_deliveries d ON d.message_id=m.id
        WHERE r.blast_id=b.id AND r.outcome='QUEUED') x) END,
    'createdAt',hon.saas_ts(b.created_at),'updatedAt',hon.saas_ts(b.updated_at))
$$;
CREATE FUNCTION hon.school_blast_summary_json(b hon.school_blasts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('blastId',b.id,'name',b.name,'channel',b.channel,'status',b.status,'version',b.version,
    'sendAt',hon.saas_ts(b.send_at),'queuedAt',hon.saas_ts(b.queued_at),'recipientCount',b.recipient_count,'updatedAt',hon.saas_ts(b.updated_at))
$$;

-- Reserve the idempotency key, lock the authority tables, prove the actor again. Returns the prior response on replay.
CREATE FUNCTION hon.school_blast_begin(subject text,operation text,p jsonb,key text,actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',operation,'input',p)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_blast_actor(subject,'marketing.blast.send') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BLAST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  RETURN prior.response_body;
END $$;
-- Saves the response, records audit and an inert outbox event (ids and counts only), and proves the actor once more.
CREATE FUNCTION hon.school_blast_finish(subject text,key text,actor uuid,action text,b hon.school_blasts,before jsonb,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb:=hon.school_blast_json(b);
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(b.organization_id,b.school_id,actor,'HUMAN_UI',action,'SCHOOL_BLAST',b.id,before,
      jsonb_build_object('status',b.status,'version',b.version,'channel',b.channel,'recipientCount',b.recipient_count,'sendAt',hon.saas_ts(b.send_at)),
      'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(b.organization_id,b.school_id,action,1,'SCHOOL_BLAST',b.id,b.version,correlation,request,
      jsonb_build_object('blastId',b.id,'version',b.version,'status',b.status,'channel',b.channel,'recipientCount',b.recipient_count));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=b.organization_id AND school_id=b.school_id AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_blast_actor(subject,'marketing.blast.send') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BLAST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Create or edit a DRAFT. Input {blastId|null, expectedVersion (0 for new), name, channel, subject|null, body, audience}.
CREATE FUNCTION hon.save_school_blast(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; b hon.school_blasts%ROWTYPE;
  before jsonb; expected integer; chan text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['audience','blastId','body','channel','expectedVersion','name','subject']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT (jsonb_typeof(p->'blastId')='null' OR (jsonb_typeof(p->'blastId')='string' AND p->>'blastId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    OR (jsonb_typeof(p->'blastId')='null')<>((p->>'expectedVersion')::integer=0)
    OR NOT hon.school_blast_line_ok(p->'name',100)
    OR jsonb_typeof(p->'channel') IS DISTINCT FROM 'string' OR p->>'channel' NOT IN ('EMAIL','SMS')
    OR (p->>'channel'='EMAIL' AND NOT hon.school_blast_line_ok(p->'subject',150))
    OR (p->>'channel'='SMS' AND jsonb_typeof(p->'subject') IS DISTINCT FROM 'null')
    OR NOT hon.school_blast_text_ok(p->'body',1,CASE p->>'channel' WHEN 'EMAIL' THEN 3500 ELSE 1000 END)
    OR NOT hon.school_blast_audience_ok(p->'audience') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer; chan:=p->>'channel';
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.send');
  prior:=hon.school_blast_begin(subject,'school_blast.save',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('blast',prior,'replayed',true); END IF;
  IF jsonb_typeof(p->'blastId')='null' THEN
    INSERT INTO hon.school_blasts(organization_id,school_id,name,channel,subject,body,audience,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,p->>'name',chan,CASE chan WHEN 'EMAIL' THEN p->>'subject' END,p->>'body',p->'audience',actor,actor) RETURNING * INTO b;
  ELSE
    SELECT * INTO b FROM hon.school_blasts x WHERE x.id=(p->>'blastId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BLAST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF b.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF b.status<>'DRAFT' THEN RAISE EXCEPTION 'BLAST_NOT_DRAFT' USING ERRCODE='55000'; END IF;
    before:=jsonb_build_object('status',b.status,'version',b.version,'channel',b.channel);
    UPDATE hon.school_blasts SET name=p->>'name',channel=chan,subject=CASE chan WHEN 'EMAIL' THEN p->>'subject' END,body=p->>'body',audience=p->'audience',
        version=b.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=b.id RETURNING * INTO b;
  END IF;
  RETURN jsonb_build_object('blast',hon.school_blast_finish(subject,key,actor,'school_blast.saved',b,before,request,correlation),'replayed',false);
END $$;

-- Send now (sendAt null) or schedule (a future instant within 60 days). Input {blastId, expectedVersion, sendAt}.
CREATE FUNCTION hon.send_school_blast(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; b hon.school_blasts%ROWTYPE;
  before jsonb; at timestamptz; school_name text; staff_name text; person hon.people%ROWTYPE; body text; subj text; msg uuid; reachable integer;
  ids uuid[]; outcomes text[]; i integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['blastId','expectedVersion','sendAt']
    OR jsonb_typeof(p->'blastId') IS DISTINCT FROM 'string' OR p->>'blastId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT (jsonb_typeof(p->'sendAt')='null' OR (jsonb_typeof(p->'sendAt')='string'
      AND p->>'sendAt' ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  BEGIN at:=(p->>'sendAt')::timestamptz; EXCEPTION WHEN others THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
  IF at IS NOT NULL AND (to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p->>'sendAt'
      OR at<=clock_timestamp()+interval '1 minute' OR at>clock_timestamp()+interval '60 days') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.send');
  prior:=hon.school_blast_begin(subject,'school_blast.send',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('blast',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_blast:'||school::text,0));
  SELECT * INTO b FROM hon.school_blasts x WHERE x.id=(p->>'blastId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLAST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF b.status<>'DRAFT' THEN RAISE EXCEPTION 'BLAST_NOT_DRAFT' USING ERRCODE='55000'; END IF;
  IF (SELECT count(*) FROM hon.school_blasts x WHERE x.organization_id=org AND x.school_id=school AND x.queued_at>clock_timestamp()-interval '24 hours')>=10 THEN
    RAISE EXCEPTION 'BLAST_DAILY_LIMIT' USING ERRCODE='55000'; END IF;
  SELECT coalesce(array_agg(x.person_id ORDER BY x.person_id),'{}'),coalesce(array_agg(x.outcome ORDER BY x.person_id),'{}'),count(*) FILTER (WHERE x.outcome='QUEUED')
    INTO ids,outcomes,reachable FROM hon.school_blast_resolve(org,school,b.channel,b.audience) x;
  IF reachable=0 THEN RAISE EXCEPTION 'BLAST_NO_RECIPIENTS' USING ERRCODE='55000'; END IF;
  IF reachable>2000 THEN RAISE EXCEPTION 'BLAST_AUDIENCE_TOO_LARGE' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('status',b.status,'version',b.version,'channel',b.channel);
  UPDATE hon.school_blasts SET status='QUEUED',send_at=at,queued_at=clock_timestamp(),queued_by_principal_id=actor,recipient_count=reachable,
      version=b.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=b.id RETURNING * INTO b;
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  staff_name:=hon.staff_shift_display_name(actor);
  FOR i IN 1..coalesce(array_length(ids,1),0) LOOP
    msg:=NULL;
    IF outcomes[i]='QUEUED' THEN
      SELECT * INTO person FROM hon.people x WHERE x.id=ids[i] AND x.organization_id=org AND x.school_id=school;
      body:=hon.school_blast_render(b.body,person.given_name,person.family_name,school_name,staff_name);
      subj:=CASE WHEN b.channel='EMAIL' THEN hon.school_blast_render(b.subject,person.given_name,person.family_name,school_name,staff_name) END;
      IF char_length(body)>4000 OR char_length(subj)>150 THEN RAISE EXCEPTION 'BLAST_TEXT_TOO_LONG' USING ERRCODE='22023'; END IF;
      INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,scheduled_at,created_by_principal_id,
          queued_by_principal_id,origin_kind,origin_id,email_subject)
        VALUES(org,school,ids[i],b.channel::hon.communication_message_channel,body,'QUEUED',at,actor,actor,'CAMPAIGN',b.id,
          CASE WHEN b.channel='EMAIL' THEN regexp_replace(btrim(subj),'[[:cntrl:]]',' ','g') END)
        RETURNING id INTO msg;
    END IF;
    INSERT INTO hon.school_blast_recipients(blast_id,organization_id,school_id,person_id,outcome,message_id) VALUES(b.id,org,school,ids[i],outcomes[i],msg);
  END LOOP;
  RETURN jsonb_build_object('blast',hon.school_blast_finish(subject,key,actor,'school_blast.queued',b,before,request,correlation),'replayed',false);
END $$;

-- Cancel a scheduled blast before its time. Its messages without a delivery become CANCELLED. Input {blastId, expectedVersion}.
CREATE FUNCTION hon.cancel_school_blast(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; b hon.school_blasts%ROWTYPE; before jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['blastId','expectedVersion']
    OR jsonb_typeof(p->'blastId') IS DISTINCT FROM 'string' OR p->>'blastId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.send');
  prior:=hon.school_blast_begin(subject,'school_blast.cancel',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('blast',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_blast:'||school::text,0));
  SELECT * INTO b FROM hon.school_blasts x WHERE x.id=(p->>'blastId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLAST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF b.status<>'QUEUED' OR b.send_at IS NULL OR b.send_at<=clock_timestamp() THEN RAISE EXCEPTION 'BLAST_NOT_CANCELLABLE' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('status',b.status,'version',b.version,'channel',b.channel);
  UPDATE hon.communication_messages m SET lifecycle='CANCELLED',version=m.version+1,updated_at=clock_timestamp()
    WHERE m.organization_id=org AND m.school_id=school AND m.origin_kind='CAMPAIGN' AND m.origin_id=b.id AND m.lifecycle='QUEUED'
      AND NOT EXISTS(SELECT 1 FROM hon.communication_deliveries d WHERE d.message_id=m.id);
  UPDATE hon.school_blasts SET status='CANCELLED',cancelled_at=clock_timestamp(),cancelled_by_principal_id=actor,
      version=b.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=b.id RETURNING * INTO b;
  RETURN jsonb_build_object('blast',hon.school_blast_finish(subject,key,actor,'school_blast.cancelled',b,before,request,correlation),'replayed',false);
END $$;

-- The school's newest 100 blasts.
CREATE FUNCTION hon.read_school_blasts(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; result jsonb;
BEGIN
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.read');
  SELECT coalesce(jsonb_agg(hon.school_blast_summary_json(b) ORDER BY b.updated_at DESC,b.id),'[]'::jsonb) INTO result
    FROM (SELECT * FROM hon.school_blasts x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.updated_at DESC,x.id LIMIT 100) b;
  IF hon.require_school_blast_actor(subject,'marketing.blast.read') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BLAST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- One blast with its results.
CREATE FUNCTION hon.read_school_blast(subject text,blast uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; b hon.school_blasts%ROWTYPE; result jsonb;
BEGIN
  IF blast IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.read');
  SELECT * INTO b FROM hon.school_blasts x WHERE x.id=blast AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLAST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=hon.school_blast_json(b);
  IF hon.require_school_blast_actor(subject,'marketing.blast.read') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BLAST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Who the saved blast would reach now: counts by outcome and the first reachable recipient's rendered message (first name
-- only, no address). For a handed-over blast the counts are what it recorded.
CREATE FUNCTION hon.read_school_blast_audience(subject text,blast uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; b hon.school_blasts%ROWTYPE; result jsonb;
  first_person hon.people%ROWTYPE; first_id uuid; school_name text; staff_name text; counts jsonb; matched integer;
BEGIN
  IF blast IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.read');
  SELECT * INTO b FROM hon.school_blasts x WHERE x.id=blast AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLAST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  WITH x AS (SELECT * FROM hon.school_blast_resolve(org,school,b.channel,b.audience) WHERE b.status='DRAFT'
    UNION ALL SELECT r.person_id,r.outcome FROM hon.school_blast_recipients r WHERE r.blast_id=b.id AND b.status<>'DRAFT')
  SELECT jsonb_build_object('QUEUED',count(*) FILTER (WHERE outcome='QUEUED'),'NO_CONSENT',count(*) FILTER (WHERE outcome='NO_CONSENT'),
      'NO_ADDRESS',count(*) FILTER (WHERE outcome='NO_ADDRESS'),'DUPLICATE_ADDRESS',count(*) FILTER (WHERE outcome='DUPLICATE_ADDRESS')),
    count(*),(array_agg(person_id ORDER BY person_id) FILTER (WHERE outcome='QUEUED'))[1]
    INTO counts,matched,first_id FROM x;
  IF first_id IS NOT NULL THEN
    SELECT * INTO first_person FROM hon.people x WHERE x.id=first_id AND x.organization_id=org AND x.school_id=school;
    SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
    staff_name:=hon.staff_shift_display_name(coalesce(b.queued_by_principal_id,actor));
  END IF;
  result:=jsonb_build_object('blastId',b.id,'version',b.version,'channel',b.channel,'matched',matched,'outcomes',counts,
    'sample',CASE WHEN first_id IS NULL THEN NULL ELSE jsonb_build_object('firstName',left(coalesce(first_person.given_name,''),200),
      'subject',CASE WHEN b.channel='EMAIL' THEN left(hon.school_blast_render(b.subject,first_person.given_name,first_person.family_name,school_name,staff_name),150) END,
      'body',left(hon.school_blast_render(b.body,first_person.given_name,first_person.family_name,school_name,staff_name),4000)) END);
  IF hon.require_school_blast_actor(subject,'marketing.blast.read') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BLAST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.save_school_blast(text,jsonb,text,uuid,uuid)','hon.send_school_blast(text,jsonb,text,uuid,uuid)',
    'hon.cancel_school_blast(text,jsonb,text,uuid,uuid)','hon.read_school_blasts(text)','hon.read_school_blast(text,uuid)','hon.read_school_blast_audience(text,uuid)'];
  helpers text[]:=ARRAY['hon.school_blast_text_ok(jsonb,integer,integer)','hon.school_blast_line_ok(jsonb,integer)','hon.school_blast_audience_ok(jsonb)',
    'hon.guard_school_blast()','hon.require_school_blast_actor(text,text)','hon.school_blast_address(text,text,text)',
    'hon.school_blast_resolve(uuid,uuid,text,jsonb)','hon.school_blast_render(text,text,text,text,text)','hon.school_blast_json(hon.school_blasts)',
    'hon.school_blast_summary_json(hon.school_blasts)','hon.school_blast_begin(text,text,jsonb,text,uuid)',
    'hon.school_blast_finish(text,text,uuid,text,hon.school_blasts,jsonb,uuid,uuid)'];
  tables text[]:=ARRAY['hon.school_blasts','hon.school_blast_recipients'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY helpers||entry LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;
COMMIT;
