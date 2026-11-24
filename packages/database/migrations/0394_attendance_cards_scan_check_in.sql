BEGIN;

-- Attendance cards and scan check-in (0394, coordinator-allocated 2026-11-16).
--
-- * The school owner chooses how cards are printed (BARCODE = Code 128, or QR) and what they show (school logo from the
--   0285 branding, the 0390 contact photo). Both kinds carry the same 26 digits, so a scanner reads either without being
--   told which.
-- * A card code is 24 random digits + 2 check digits made by the API, shown once for printing and never stored: only its
--   SHA-256 digest and last four digits are kept. It is not a student id and carries no school or person data. Printing a
--   card replaces the student's active card; a card can be cancelled. One active card per student.
-- * Scan check-in is a signed-in staff screen, not a public kiosk (0122 stays staff-assistance only). A code resolves only
--   after the live attendance.record decision for that staff member at that school (hon.lock_attendance_actor), and
--   attendance is written only by the existing hon.record_attendance (0115): no parallel attendance model. Each scan that
--   records attendance adds one provenance row (method, card) to hon.attendance_check_ins.
-- * Photo consent (owner decision 2026-11-16): no parent consent unless the school's place requires it. The place comes
--   from the 0392 school location and its jurisdiction profile; hon.student_photo_consent_rules says which profiles need
--   consent (TEST_ONLY_DRAFT, lawyer review before real use). A school with no location needs none (owner choice); an
--   unreviewed place needs it (fail closed). Where consent is needed, a card prints the photo only when staff recorded the
--   parent's (or adult student's) consent; otherwise it prints initials. An ordinary photo is not a biometric template, so
--   the 0392 face rules do not carry over.
-- * hon.attendance_check_in_student is the shared internal path (not granted to the app); a later check-in method calls it
--   with its own method value after widening attendance_check_ins_method_check.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.record_attendance(text,uuid,jsonb,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.lock_attendance_actor(text,text)') IS NULL
    OR to_regclass('hon.school_page_branding') IS NULL OR to_regclass('hon.person_photos') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL
    OR to_regclass('hon.school_locations') IS NULL OR to_regprocedure('hon.biometric_profile_for(text,text,text)') IS NULL THEN
    RAISE EXCEPTION '0394 requires 0115, 0285, 0390, 0392 and the saas timestamp helper'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('attendance.cards.manage','Choose how attendance cards look (barcode or QR, logo, photo), print new cards and cancel cards',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='attendance.cards.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'attendance.cards.manage already exists with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'attendance.cards.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE hon.attendance_card_settings (
  school_id uuid PRIMARY KEY, organization_id uuid NOT NULL,
  code_type text NOT NULL CHECK (code_type IN ('BARCODE','QR')),
  show_photo boolean NOT NULL, show_logo boolean NOT NULL,
  design text NOT NULL CHECK (design IN ('CLASSIC','BOLD','MINIMAL')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);

CREATE TABLE hon.attendance_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL, student_profile_id uuid NOT NULL,
  code_digest bytea NOT NULL UNIQUE CHECK (octet_length(code_digest)=32),
  code_last4 text NOT NULL CHECK (code_last4 ~ '^[0-9]{4}$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REPLACED','REVOKED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  issued_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_by_principal_id uuid REFERENCES hon.principals(id),
  ended_at timestamptz,
  FOREIGN KEY (student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  UNIQUE (id,organization_id,school_id),
  CHECK ((status='ACTIVE')=(ended_at IS NULL) AND (ended_at IS NULL)=(ended_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX attendance_cards_one_active ON hon.attendance_cards(student_profile_id) WHERE status='ACTIVE';
CREATE INDEX attendance_cards_scope_idx ON hon.attendance_cards(organization_id,school_id,student_profile_id);

CREATE TABLE hon.attendance_check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  class_session_id uuid NOT NULL, student_profile_id uuid NOT NULL,
  method text NOT NULL CONSTRAINT attendance_check_ins_method_check CHECK (method IN ('CARD')),
  method_ref uuid NOT NULL,
  attendance_record_id uuid NOT NULL REFERENCES hon.attendance_records(id),
  attendance_status text NOT NULL CHECK (attendance_status IN ('PRESENT','LATE')),
  recorded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE INDEX attendance_check_ins_scope_idx ON hon.attendance_check_ins(organization_id,school_id,class_session_id,created_at);

CREATE TABLE hon.attendance_card_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('settings','issue','revoke','consent')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

-- Which jurisdiction profiles need consent before a student's photo is printed on a card. Immutable draft rows: a change
-- is a new migration. Every 0392 profile has a row (checked below).
CREATE TABLE hon.student_photo_consent_rules (
  profile_code text PRIMARY KEY REFERENCES hon.biometric_jurisdiction_profiles(code),
  consent_required boolean NOT NULL,
  review_status text NOT NULL CHECK (review_status='TEST_ONLY_DRAFT')
);
INSERT INTO hon.student_photo_consent_rules(profile_code,consent_required,review_status)
SELECT code,code IN ('EU_GDPR','UK_GDPR','KR_PIPA','NOT_REVIEWED'),'TEST_ONLY_DRAFT' FROM hon.biometric_jurisdiction_profiles;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM hon.biometric_jurisdiction_profiles p WHERE NOT EXISTS(SELECT 1 FROM hon.student_photo_consent_rules r WHERE r.profile_code=p.code))
    OR (SELECT count(*) FROM hon.student_photo_consent_rules WHERE consent_required)<>4 THEN
    RAISE EXCEPTION '0394 photo consent rules do not cover the 0392 profiles'; END IF;
END $$;

-- The consent staff recorded for one student (GIVEN or WITHDRAWN), versioned; history is the audit trail.
CREATE TABLE hon.student_photo_consents (
  student_profile_id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('GIVEN','WITHDRAWN')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  recorded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id)
);

ALTER TABLE hon.student_photo_consent_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_photo_consent_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.student_photo_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_photo_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_card_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_card_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_cards FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_check_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_check_ins FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_card_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_card_requests FORCE ROW LEVEL SECURITY;

-- Evidence guard (settings-free). Settings keep their school and advance one version per change. A card keeps its
-- identity, student, digest and issue facts; it only ends once (ACTIVE -> REPLACED or REVOKED). Check-ins and requests
-- are append-only (a request records its response once). Nothing is deleted or truncated.
CREATE FUNCTION hon.guard_attendance_card() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'ATTENDANCE_CARD_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME IN ('attendance_check_ins','student_photo_consent_rules') THEN RAISE EXCEPTION 'ATTENDANCE_CARD_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='student_photo_consents' THEN
    IF NEW.version<>OLD.version+1 OR (NEW.student_profile_id,NEW.organization_id,NEW.school_id) IS DISTINCT FROM (OLD.student_profile_id,OLD.organization_id,OLD.school_id) THEN
      RAISE EXCEPTION 'ATTENDANCE_CARD_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='attendance_card_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL
      OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'ATTENDANCE_CARD_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='attendance_card_settings' THEN
    IF NEW.version<>OLD.version+1 OR (NEW.school_id,NEW.organization_id) IS DISTINCT FROM (OLD.school_id,OLD.organization_id) THEN
      RAISE EXCEPTION 'ATTENDANCE_CARD_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status<>'ACTIVE' OR NEW.status NOT IN ('REPLACED','REVOKED') OR NEW.version<>OLD.version+1
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.student_profile_id,NEW.code_digest,NEW.code_last4,NEW.issued_by_principal_id,NEW.issued_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.student_profile_id,OLD.code_digest,OLD.code_last4,OLD.issued_by_principal_id,OLD.issued_at) THEN
    RAISE EXCEPTION 'ATTENDANCE_CARD_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_card_settings_guard BEFORE UPDATE OR DELETE ON hon.attendance_card_settings FOR EACH ROW EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER attendance_cards_guard BEFORE UPDATE OR DELETE ON hon.attendance_cards FOR EACH ROW EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER attendance_check_ins_guard BEFORE UPDATE OR DELETE ON hon.attendance_check_ins FOR EACH ROW EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER attendance_card_requests_guard BEFORE UPDATE OR DELETE ON hon.attendance_card_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER attendance_card_settings_no_truncate BEFORE TRUNCATE ON hon.attendance_card_settings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER attendance_cards_no_truncate BEFORE TRUNCATE ON hon.attendance_cards FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER attendance_check_ins_no_truncate BEFORE TRUNCATE ON hon.attendance_check_ins FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER student_photo_consent_rules_guard BEFORE UPDATE OR DELETE ON hon.student_photo_consent_rules FOR EACH ROW EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER student_photo_consents_guard BEFORE UPDATE OR DELETE ON hon.student_photo_consents FOR EACH ROW EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER student_photo_consent_rules_no_truncate BEFORE TRUNCATE ON hon.student_photo_consent_rules FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER student_photo_consents_no_truncate BEFORE TRUNCATE ON hon.student_photo_consents FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_attendance_card();
CREATE TRIGGER attendance_card_requests_no_truncate BEFORE TRUNCATE ON hon.attendance_card_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_attendance_card();

-- Card authority: the direct human of this request (principal id bound by the API's tenant context), one active human
-- principal, active organization and school, paid access, attendance.cards.manage at this exact school through a staff
-- role, and no family access at the school. Read-only: it takes no lock.
CREATE FUNCTION hon.attendance_cards_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR p_subject IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
  WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1;
  IF actor IS NULL
    OR NOT EXISTS(SELECT 1 FROM hon.organizations WHERE id=org AND status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code='attendance.cards.manage'
        AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school))
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND organization_id=org AND school_id=school
      AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'ATTENDANCE_CARDS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Whether this school's place needs photo consent: no location row = not required (owner choice); a located school uses
-- its 0392 profile, and a profile without a rule fails closed.
CREATE FUNCTION hon.attendance_photo_consent_rule(p_org uuid,p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN l.school_id IS NULL THEN jsonb_build_object('required',false,'profile',NULL,'reason','NO_LOCATION')
    ELSE (SELECT jsonb_build_object('required',coalesce(r.consent_required,true),'profile',x.code,'reason','PROFILE')
      FROM (SELECT hon.biometric_profile_for(l.country_code,l.region_code,l.city) code) x
      LEFT JOIN hon.student_photo_consent_rules r ON r.profile_code=x.code) END
  FROM (SELECT p_school sid) q LEFT JOIN hon.school_locations l ON l.school_id=q.sid AND l.organization_id=p_org
$$;

-- One student's photo consent state for cards: NOT_REQUIRED, GIVEN or MISSING (never recorded or withdrawn).
CREATE FUNCTION hon.attendance_photo_consent_state(p_required boolean,c hon.student_photo_consents) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN NOT p_required THEN 'NOT_REQUIRED' WHEN c.status='GIVEN' THEN 'GIVEN' ELSE 'MISSING' END
$$;

-- The school's card look. A school that never chose gets QR with photo and logo (version 0, not saved).
CREATE FUNCTION hon.attendance_card_settings_json(p_org uuid,p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('codeType',coalesce(s.code_type,'QR'),'showPhoto',coalesce(s.show_photo,true),'showLogo',coalesce(s.show_logo,true),
    'design',coalesce(s.design,'CLASSIC'),'version',coalesce(s.version,0),'updatedAt',hon.saas_ts(s.updated_at),
    'schoolName',sc.name,'logoUrl',b.logo_url,'accentColor',b.accent_color,'photoConsent',hon.attendance_photo_consent_rule(p_org,p_school))
  FROM hon.schools sc LEFT JOIN hon.attendance_card_settings s ON s.school_id=sc.id AND s.organization_id=sc.organization_id
    LEFT JOIN hon.school_page_branding b ON b.school_id=sc.id AND b.organization_id=sc.organization_id
  WHERE sc.id=p_school AND sc.organization_id=p_org
$$;

CREATE FUNCTION hon.attendance_card_json(c hon.attendance_cards) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('cardId',c.id,'studentProfileId',c.student_profile_id,'last4',c.code_last4,'status',c.status,'version',c.version,
    'issuedAt',hon.saas_ts(c.issued_at),'endedAt',hon.saas_ts(c.ended_at))
$$;

-- Command prologue: validated ids, live card authority, own receipt (exact replay only while authority is current).
CREATE FUNCTION hon.attendance_card_begin(p_subject text,p_operation text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid,OUT actor uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prior hon.attendance_card_requests%ROWTYPE;
BEGIN
  IF p_operation NOT IN ('settings','issue','revoke','consent') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'ATTENDANCE_CARDS_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.attendance_cards_actor(p_subject);
  -- A print is the same request when it names the same students: the API draws fresh random codes on every attempt, so a
  -- retry of an unknown outcome replays the saved print (without codes) instead of being refused as a reused key.
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',CASE WHEN p_operation='issue' AND jsonb_typeof(p_input->'cards')='array'
    THEN (SELECT coalesce(jsonb_agg(x->'studentProfileId' ORDER BY x->>'studentProfileId'),'[]'::jsonb) FROM jsonb_array_elements(p_input->'cards') x) ELSE p_input END)::text,'UTF8')),'hex');
  INSERT INTO hon.attendance_card_requests(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,actor,p_key,p_operation,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.attendance_card_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'ATTENDANCE_CARDS_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.attendance_cards_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'ATTENDANCE_CARDS_FORBIDDEN' USING ERRCODE='42501'; END IF;
    replay:=prior.response;
  END IF;
END $$;

-- Command epilogue: identifier-only audit and inert outbox, receipt completion, authority decided again after the last write.
CREATE FUNCTION hon.attendance_card_finish(p_subject text,p_actor uuid,p_operation text,p_entity_type text,p_entity uuid,p_payload jsonb,p_key text,
  p_request uuid,p_correlation uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); payload jsonb:=p_payload||jsonb_build_object('internalOnly',true);
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','attendance.cards.'||p_operation,p_entity_type,p_entity,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'attendance.cards.'||p_operation,1,p_entity_type,p_entity,coalesce((payload->>'version')::integer,1),p_correlation,p_request,payload);
  UPDATE hon.attendance_card_requests SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=p_actor AND idempotency_key=p_key;
  IF hon.attendance_cards_actor(p_subject) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'ATTENDANCE_CARDS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',p_result,'replayed',false);
END $$;

-- Read: the card look plus the school's students (at most 500, by name) and each one's active card (no code).
CREATE FUNCTION hon.read_attendance_cards(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb; required boolean;
BEGIN
  PERFORM hon.attendance_cards_actor(p_subject);
  required:=(hon.attendance_photo_consent_rule(org,school)->>'required')::boolean;
  SELECT jsonb_build_object('settings',hon.attendance_card_settings_json(org,school),'maxPerPrint',40,
    'students',coalesce(jsonb_agg(jsonb_build_object('studentProfileId',x.id,'personId',x.person_id,'givenName',x.given_name,'familyName',x.family_name,
      'studentStatus',x.status,'hasPhoto',x.has_photo,'card',x.card,
      'photoConsent',hon.attendance_photo_consent_state(required,x.consent),'photoConsentVersion',coalesce((x.consent).version,0)) ORDER BY x.family_name,x.given_name,x.id),'[]'::jsonb)) INTO result
  FROM (SELECT sp.id,sp.person_id,p.given_name,p.family_name,sp.status::text status,
      EXISTS(SELECT 1 FROM hon.person_photos ph WHERE ph.person_id=sp.person_id AND ph.organization_id=org AND ph.school_id=school) has_photo,
      (SELECT hon.attendance_card_json(c) FROM hon.attendance_cards c WHERE c.student_profile_id=sp.id AND c.organization_id=org AND c.school_id=school AND c.status='ACTIVE') card,
      (SELECT pc FROM hon.student_photo_consents pc WHERE pc.student_profile_id=sp.id AND pc.organization_id=org AND pc.school_id=school) consent
    FROM hon.student_profiles sp JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id
    WHERE sp.organization_id=org AND sp.school_id=school ORDER BY p.family_name,p.given_name,sp.id LIMIT 500) x;
  RETURN result;
END $$;

-- Input: exactly {expectedVersion (0 when never saved), codeType, showPhoto, showLogo, design}.
CREATE FUNCTION hon.configure_attendance_cards(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); cur hon.attendance_card_settings%ROWTYPE; nxt hon.attendance_card_settings%ROWTYPE;
BEGIN
  SELECT * INTO s FROM hon.attendance_card_begin(p_subject,'settings',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['codeType','design','expectedVersion','showLogo','showPhoto']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p_input->'codeType') IS DISTINCT FROM 'string' OR p_input->>'codeType' NOT IN ('BARCODE','QR')
    OR jsonb_typeof(p_input->'design') IS DISTINCT FROM 'string' OR p_input->>'design' NOT IN ('CLASSIC','BOLD','MINIMAL')
    OR jsonb_typeof(p_input->'showPhoto') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'showLogo') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'ATTENDANCE_CARDS_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('attendance-card-settings:'||school::text,0));
  SELECT * INTO cur FROM hon.attendance_card_settings WHERE school_id=school AND organization_id=org FOR UPDATE;
  IF coalesce(cur.version,0)<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF cur.school_id IS NULL THEN
    INSERT INTO hon.attendance_card_settings(school_id,organization_id,code_type,show_photo,show_logo,design,updated_by_principal_id)
      VALUES(school,org,p_input->>'codeType',(p_input->>'showPhoto')::boolean,(p_input->>'showLogo')::boolean,p_input->>'design',s.actor) RETURNING * INTO nxt;
  ELSE
    UPDATE hon.attendance_card_settings SET code_type=p_input->>'codeType',show_photo=(p_input->>'showPhoto')::boolean,show_logo=(p_input->>'showLogo')::boolean,
      design=p_input->>'design',version=version+1,updated_by_principal_id=s.actor,updated_at=clock_timestamp() WHERE school_id=school RETURNING * INTO nxt;
  END IF;
  RETURN hon.attendance_card_finish(p_subject,s.actor,'settings','ATTENDANCE_CARD_SETTINGS',school,
    jsonb_build_object('codeType',nxt.code_type,'showPhoto',nxt.show_photo,'showLogo',nxt.show_logo,'design',nxt.design,'version',nxt.version),
    p_key,p_request,p_correlation,hon.attendance_card_settings_json(org,school));
END $$;

-- Input: exactly {cards: [{studentProfileId, codeDigest (64 hex), last4}]} with 1..40 distinct students and digests.
-- Each student's active card (if any) becomes REPLACED and the new card is ACTIVE. Returns the new cards (no code).
CREATE FUNCTION hon.issue_attendance_cards(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); item jsonb; student uuid; c hon.attendance_cards%ROWTYPE;
  issued jsonb:='[]'::jsonb; replaced integer:=0; n integer; batch uuid:=gen_random_uuid(); show_photo boolean; required boolean; consent text;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  SELECT * INTO s FROM hon.attendance_card_begin(p_subject,'issue',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['cards'] OR jsonb_typeof(p_input->'cards') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ATTENDANCE_CARDS_INVALID' USING ERRCODE='22023'; END IF;
  n:=jsonb_array_length(p_input->'cards');
  IF n NOT BETWEEN 1 AND 40 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'cards') x WHERE jsonb_typeof(x)<>'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k) IS DISTINCT FROM ARRAY['codeDigest','last4','studentProfileId']
      OR jsonb_typeof(x->'studentProfileId')<>'string' OR x->>'studentProfileId' !~ uuid_re
      OR jsonb_typeof(x->'codeDigest')<>'string' OR x->>'codeDigest' !~ '^[0-9a-f]{64}$' OR jsonb_typeof(x->'last4')<>'string' OR x->>'last4' !~ '^[0-9]{4}$')
    OR (SELECT count(DISTINCT x->>'studentProfileId') FROM jsonb_array_elements(p_input->'cards') x)<>n
    OR (SELECT count(DISTINCT x->>'codeDigest') FROM jsonb_array_elements(p_input->'cards') x)<>n THEN
    RAISE EXCEPTION 'ATTENDANCE_CARDS_INVALID' USING ERRCODE='22023'; END IF;
  -- Whether each card may carry the photo is decided here, from the saved look and the school's consent rule.
  show_photo:=coalesce((SELECT st.show_photo FROM hon.attendance_card_settings st WHERE st.school_id=school AND st.organization_id=org),true);
  required:=(hon.attendance_photo_consent_rule(org,school)->>'required')::boolean;
  -- Students in a fixed order so two prints of overlapping students cannot deadlock.
  FOR item IN SELECT x FROM jsonb_array_elements(p_input->'cards') x ORDER BY x->>'studentProfileId' LOOP
    student:=(item->>'studentProfileId')::uuid;
    PERFORM 1 FROM hon.student_profiles WHERE id=student AND organization_id=org AND school_id=school FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ATTENDANCE_CARD_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('attendance-card:'||student::text,0));
    UPDATE hon.attendance_cards SET status='REPLACED',version=version+1,ended_at=clock_timestamp(),ended_by_principal_id=s.actor
      WHERE student_profile_id=student AND organization_id=org AND school_id=school AND status='ACTIVE';
    IF FOUND THEN replaced:=replaced+1; END IF;
    BEGIN
      INSERT INTO hon.attendance_cards(organization_id,school_id,student_profile_id,code_digest,code_last4,issued_by_principal_id)
        VALUES(org,school,student,decode(item->>'codeDigest','hex'),item->>'last4',s.actor) RETURNING * INTO c;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'ATTENDANCE_CARD_CODE_TAKEN' USING ERRCODE='23505';
    END;
    SELECT hon.attendance_photo_consent_state(required,pc) INTO consent FROM (SELECT 1) one
      LEFT JOIN hon.student_photo_consents pc ON pc.student_profile_id=student AND pc.organization_id=org AND pc.school_id=school;
    issued:=issued||(hon.attendance_card_json(c)||jsonb_build_object('printPhoto',show_photo AND consent<>'MISSING'
      AND EXISTS(SELECT 1 FROM hon.person_photos ph JOIN hon.student_profiles sp ON sp.person_id=ph.person_id AND sp.organization_id=ph.organization_id AND sp.school_id=ph.school_id
        WHERE sp.id=student AND ph.organization_id=org AND ph.school_id=school)));
  END LOOP;
  RETURN hon.attendance_card_finish(p_subject,s.actor,'issue','ATTENDANCE_CARD_PRINT',batch,
    jsonb_build_object('cardIds',(SELECT jsonb_agg(x->'cardId') FROM jsonb_array_elements(issued) x),'replaced',replaced,'version',1),
    p_key,p_request,p_correlation,jsonb_build_object('printId',batch,'cards',issued,'replaced',replaced));
END $$;

-- Input: exactly {cardId, expectedVersion}. An active card of this school becomes REVOKED and stops working at once.
CREATE FUNCTION hon.revoke_attendance_card(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.attendance_cards%ROWTYPE;
BEGIN
  SELECT * INTO s FROM hon.attendance_card_begin(p_subject,'revoke',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['cardId','expectedVersion']
    OR jsonb_typeof(p_input->'cardId') IS DISTINCT FROM 'string' OR p_input->>'cardId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'ATTENDANCE_CARDS_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM hon.attendance_cards WHERE id=(p_input->>'cardId')::uuid AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ATTENDANCE_CARD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.status<>'ACTIVE' OR c.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  UPDATE hon.attendance_cards SET status='REVOKED',version=version+1,ended_at=clock_timestamp(),ended_by_principal_id=s.actor WHERE id=c.id RETURNING * INTO c;
  RETURN hon.attendance_card_finish(p_subject,s.actor,'revoke','ATTENDANCE_CARD',c.id,jsonb_build_object('cardId',c.id,'status',c.status,'version',c.version),
    p_key,p_request,p_correlation,hon.attendance_card_json(c));
END $$;

-- Shared internal check-in path (not granted to the app). The caller has already decided who the student is by its own
-- method. Live attendance.record authority comes first; the session and student must be at this school. A student who
-- already has attendance for the session is left unchanged (ALREADY_RECORDED with the saved status), except an absence,
-- which the arrival corrects; otherwise the
-- existing hon.record_attendance writes PRESENT or LATE (its own idempotency, audit and outbox) and one provenance row
-- records the method. The per session/student advisory lock is the same one hon.record_attendance takes.
CREATE FUNCTION hon.attendance_check_in_student(p_subject text,p_session uuid,p_student uuid,p_method text,p_method_ref uuid,p_status text,
  p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; existing hon.attendance_records%ROWTYPE; recorded jsonb;
BEGIN
  IF p_session IS NULL OR p_student IS NULL OR p_method IS NULL OR p_method_ref IS NULL OR p_status NOT IN ('PRESENT','LATE') THEN
    RAISE EXCEPTION 'CHECK_IN_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.lock_attendance_actor(p_subject,'attendance.record');
  PERFORM 1 FROM hon.class_sessions WHERE id=p_session AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM hon.student_profiles WHERE id=p_student AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_session::text || ':' || p_student::text,0));
  SELECT * INTO existing FROM hon.attendance_records WHERE organization_id=org AND school_id=school AND class_session_id=p_session AND student_profile_id=p_student;
  IF existing.id IS NOT NULL AND existing.status::text NOT IN ('EXCUSED_ABSENCE','UNEXCUSED_ABSENCE') THEN
    RETURN jsonb_build_object('outcome','ALREADY_RECORDED','attendance',jsonb_build_object('id',existing.id,'status',existing.status::text,'version',existing.version,
      'recordedAt',hon.saas_ts(existing.recorded_at)));
  END IF;
  -- A student marked absent who then arrives and checks in is corrected to the scan's status, at the saved version,
  -- keeping the saved category and note.
  recorded:=hon.record_attendance(p_subject,p_session,jsonb_build_object('studentProfileId',p_student::text,'status',p_status)
    ||CASE WHEN existing.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('expectedVersion',existing.version,'category',existing.category::text,'note',existing.note) END,p_key,p_request,p_correlation)->'attendance';
  INSERT INTO hon.attendance_check_ins(organization_id,school_id,class_session_id,student_profile_id,method,method_ref,attendance_record_id,attendance_status,recorded_by_principal_id)
    VALUES(org,school,p_session,p_student,p_method,p_method_ref,(recorded->>'id')::uuid,recorded->>'status',actor);
  RETURN jsonb_build_object('outcome','RECORDED','attendance',jsonb_build_object('id',recorded->>'id','status',recorded->>'status','version',(recorded->>'version')::integer,
    'recordedAt',recorded->>'recordedAt'));
END $$;

-- Scan entry point. Input: exactly {codeDigest (64 hex), status PRESENT|LATE}. Authority is decided before the code is
-- looked at, so a refused caller learns nothing. A code that is not a card of this school is NOT_RECOGNIZED (no student);
-- a replaced or cancelled card of this school is CARD_NOT_ACTIVE with the student named so staff can hand over the new
-- card; neither records anything.
CREATE FUNCTION hon.check_in_with_attendance_card(p_subject text,p_session uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.attendance_cards%ROWTYPE; who jsonb; result jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['codeDigest','status']
    OR jsonb_typeof(p_input->'codeDigest') IS DISTINCT FROM 'string' OR p_input->>'codeDigest' !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR p_input->>'status' NOT IN ('PRESENT','LATE') OR p_session IS NULL THEN
    RAISE EXCEPTION 'CHECK_IN_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.lock_attendance_actor(p_subject,'attendance.record');
  PERFORM 1 FROM hon.class_sessions WHERE id=p_session AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.attendance_cards WHERE code_digest=decode(p_input->>'codeDigest','hex') AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','NOT_RECOGNIZED','student',NULL,'card',NULL,'attendance',NULL); END IF;
  SELECT jsonb_build_object('studentProfileId',sp.id,'personId',sp.person_id,'givenName',p.given_name,'familyName',p.family_name,'studentStatus',sp.status::text)
    INTO who FROM hon.student_profiles sp JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id
    WHERE sp.id=c.student_profile_id AND sp.organization_id=org AND sp.school_id=school;
  IF c.status<>'ACTIVE' THEN
    RETURN jsonb_build_object('outcome','CARD_NOT_ACTIVE','student',who,'card',hon.attendance_card_json(c),'attendance',NULL); END IF;
  result:=hon.attendance_check_in_student(p_subject,p_session,c.student_profile_id,'CARD',c.id,p_input->>'status',p_key,p_request,p_correlation);
  RETURN result||jsonb_build_object('student',who,'card',hon.attendance_card_json(c));
END $$;

-- Input: exactly {studentProfileId, given (boolean), expectedVersion (0 when never recorded)}. Staff record that the
-- parent (or the adult student) agreed to the photo on the card, or that they withdrew. Allowed even where the place does
-- not need it, so a school can keep a record anyway. Identifier-only audit.
CREATE FUNCTION hon.set_student_photo_consent(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); student uuid; cur hon.student_photo_consents%ROWTYPE;
  nxt hon.student_photo_consents%ROWTYPE; required boolean;
BEGIN
  SELECT * INTO s FROM hon.attendance_card_begin(p_subject,'consent',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion','given','studentProfileId']
    OR jsonb_typeof(p_input->'studentProfileId') IS DISTINCT FROM 'string' OR p_input->>'studentProfileId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'given') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$' THEN
    RAISE EXCEPTION 'ATTENDANCE_CARDS_INVALID' USING ERRCODE='22023'; END IF;
  student:=(p_input->>'studentProfileId')::uuid;
  PERFORM 1 FROM hon.student_profiles WHERE id=student AND organization_id=org AND school_id=school FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ATTENDANCE_CARD_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('attendance-card:'||student::text,0));
  SELECT * INTO cur FROM hon.student_photo_consents WHERE student_profile_id=student AND organization_id=org AND school_id=school FOR UPDATE;
  IF cur.student_profile_id IS NULL AND NOT (p_input->>'given')::boolean THEN RAISE EXCEPTION 'ATTENDANCE_CARDS_INVALID' USING ERRCODE='22023'; END IF;
  IF coalesce(cur.version,0)<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF cur.student_profile_id IS NULL THEN
    INSERT INTO hon.student_photo_consents(student_profile_id,organization_id,school_id,status,recorded_by_principal_id)
      VALUES(student,org,school,'GIVEN',s.actor) RETURNING * INTO nxt;
  ELSE
    UPDATE hon.student_photo_consents SET status=CASE WHEN (p_input->>'given')::boolean THEN 'GIVEN' ELSE 'WITHDRAWN' END,version=version+1,
      recorded_by_principal_id=s.actor,recorded_at=clock_timestamp() WHERE student_profile_id=student RETURNING * INTO nxt;
  END IF;
  required:=(hon.attendance_photo_consent_rule(org,school)->>'required')::boolean;
  RETURN hon.attendance_card_finish(p_subject,s.actor,'consent','STUDENT_PHOTO_CONSENT',student,
    jsonb_build_object('studentProfileId',student,'status',nxt.status,'version',nxt.version),p_key,p_request,p_correlation,
    jsonb_build_object('studentProfileId',student,'photoConsent',hon.attendance_photo_consent_state(required,nxt),'photoConsentVersion',nxt.version,
      'recordedAt',hon.saas_ts(nxt.recorded_at)));
END $$;

-- Deny first, then exactly the six entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_card_settings','attendance_cards','attendance_check_ins','attendance_card_requests',
      'student_photo_consent_rules','student_photo_consents'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_attendance_card()','hon.attendance_cards_actor(text)','hon.attendance_card_settings_json(uuid,uuid)',
    'hon.attendance_card_json(hon.attendance_cards)','hon.attendance_card_begin(text,text,jsonb,text,uuid,uuid)',
    'hon.attendance_card_finish(text,uuid,text,text,uuid,jsonb,text,uuid,uuid,jsonb)','hon.read_attendance_cards(text)',
    'hon.configure_attendance_cards(text,jsonb,text,uuid,uuid)','hon.issue_attendance_cards(text,jsonb,text,uuid,uuid)',
    'hon.revoke_attendance_card(text,jsonb,text,uuid,uuid)','hon.attendance_check_in_student(text,uuid,uuid,text,uuid,text,text,uuid,uuid)',
    'hon.check_in_with_attendance_card(text,uuid,jsonb,text,uuid,uuid)','hon.attendance_photo_consent_rule(uuid,uuid)',
    'hon.attendance_photo_consent_state(boolean,hon.student_photo_consents)','hon.set_student_photo_consent(text,jsonb,text,uuid,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_attendance_cards(text),hon.configure_attendance_cards(text,jsonb,text,uuid,uuid),
      hon.issue_attendance_cards(text,jsonb,text,uuid,uuid),hon.revoke_attendance_card(text,jsonb,text,uuid,uuid),
      hon.check_in_with_attendance_card(text,uuid,jsonb,text,uuid,uuid),hon.set_student_photo_consent(text,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
