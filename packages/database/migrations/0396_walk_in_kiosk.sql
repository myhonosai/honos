BEGIN;

-- Walk-in kiosk WK1 (0396, assigned by the coordinator 2026-11-16). Owner request (David, 2026-11-16): the Classes
-- "ClassPass & walk-in" page "meant to be kiosk style quick intake form and waiver and day pass or trial purchase".
-- Spec: docs/architecture/WALK_IN_KIOSK.md. Rules:
--   W1  One kiosk settings row per school (walkin_kiosk.manage, OWNER): on/off, the waiver (English required, Korean and
--       Spanish optional), whether an emergency contact is required, the pipeline and stage new leads go to, up to 6
--       offers (Day pass or Trial, a name and short description per language, a price in minor units, USD, 0 = free) and
--       an optional thank-you line. Every waiver change adds an append-only waiver text version.
--   W2  A signed-in OWNER or ADMIN (walkin_kiosk.run) starts a tablet for 1-12 hours. The API makes the 32-byte device
--       token; only its SHA-256 digest reaches the database. Staff can end any tablet early. A tablet stops working when
--       it ends, when the school, organization or entitlement is not live, when the kiosk is turned off, or when the staff
--       member who started it no longer holds walkin_kiosk.run.
--   W3  The tablet (no account) reads only the school's name/branding, the offers, the waiver and the field rules, and
--       submits one visit: the contact adult (and/or up to 3 children; at most 4 people), emergency contact, how they heard,
--       an unticked marketing opt-in, the offer, and the signed waiver (typed name, finger signature as bounded strokes,
--       "I agree"). Anyone under 18 is signed for by the contact adult as parent or legal guardian; an adult only signs for
--       themselves. In one transaction this creates the people, one CRM lead (source WALK_IN_KIOSK), the optional SMS and
--       email opt-in (source RECIPIENT), the append-only waiver signature, and the visit (FREE, or PAY_AT_DESK for a
--       paid offer; paying on the tablet or by QR comes in 0397). An exact retry returns the same answer.
--   W4  Staff with walkin_kiosk.run see recent walk-ins, open one with its signed waiver, and mark a PAY_AT_DESK visit
--       paid at the desk (cash, card outside HON, other). Nothing here charges a card, sends a message or runs AI.
-- The tablet can never read people, leads, students, bookings or payments. The runtime gains no table privilege: staff
-- writes are direct-human SECURITY DEFINER commands, and tablet writes run as a code-owned SYSTEM_SERVICE principal with
-- no roles (the 0075/0286 shape).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Walk-in kiosk requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Walk-in kiosk requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL OR to_regprocedure('hon.school_event_text_ok(text,integer,integer)') IS NULL
    OR to_regprocedure('hon.school_booking_text_ok(text,integer)') IS NULL OR to_regprocedure('hon.read_public_school_branding(uuid)') IS NULL
    OR to_regclass('hon.communication_consents') IS NULL THEN
    RAISE EXCEPTION 'Walk-in kiosk requires 0046, 0224, 0261, 0285 and 0286';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('walkin_kiosk.manage','Change the walk-in kiosk settings: waiver, offers and prices, where new leads go',true,true),
  ('walkin_kiosk.run','Start and end kiosk tablets, see walk-ins with their signed waivers, mark a walk-in paid at the desk',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('walkin_kiosk.manage','walkin_kiosk.run') AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'walk-in kiosk permissions already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'walkin_kiosk.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' ON CONFLICT DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'walkin_kiosk.run' FROM hon.roles r WHERE r.is_system_role AND r.code IN ('OWNER','ADMIN') ON CONFLICT DO NOTHING;

-- Code-owned tablet intake. No user, role, HQ, family or delegated authority belongs to it.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000396','SYSTEM_SERVICE','Code-owned walk-in kiosk intake');

-- A {en, ko?, es?} text: English required (min..max), Korean and Spanish optional (0..max); multiline allows line breaks.
CREATE FUNCTION hon.walkin_text_ok(v jsonb,min_length integer,max_length integer,multiline boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(v)='object' AND v ? 'en' AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('en','ko','es'))
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(v) e WHERE jsonb_typeof(e.value)<>'string'
      OR NOT CASE WHEN multiline THEN hon.school_booking_text_ok(e.value#>>'{}',max_length) AND length(e.value#>>'{}')>=CASE WHEN e.key='en' THEN min_length ELSE 0 END
        ELSE hon.school_event_text_ok(e.value#>>'{}',CASE WHEN e.key='en' THEN min_length ELSE 0 END,max_length) END)
$$;

-- W1: settings, one row per school. Offers are a closed array checked by hon.walkin_settings_input.
CREATE TABLE hon.walkin_kiosk_settings (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  enabled boolean NOT NULL,
  waiver jsonb NOT NULL CHECK (hon.walkin_text_ok(waiver,1,8000,true)),
  waiver_version integer NOT NULL CHECK (waiver_version>=1),
  emergency_required boolean NOT NULL,
  pipeline_id uuid NOT NULL,
  pipeline_stage_id uuid NOT NULL,
  offers jsonb NOT NULL CHECK (jsonb_typeof(offers)='array' AND jsonb_array_length(offers) BETWEEN 1 AND 6),
  thank_you jsonb NOT NULL CHECK (hon.walkin_text_ok(thank_you,0,300,false)),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,school_id),
  UNIQUE (school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_id,organization_id,school_id) REFERENCES hon.crm_pipelines(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_stage_id,organization_id,school_id) REFERENCES hon.crm_pipeline_stages(id,organization_id,school_id) ON DELETE RESTRICT
);

-- W1: every waiver text a school has had. A signature points at the exact version it was signed on.
CREATE TABLE hon.walkin_waiver_texts (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  waiver_version integer NOT NULL CHECK (waiver_version>=1),
  texts jsonb NOT NULL CHECK (hon.walkin_text_ok(texts,1,8000,true)),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (school_id,waiver_version),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);

-- W2: one started tablet.
CREATE TABLE hon.walkin_kiosk_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  label text NOT NULL CHECK (hon.school_event_text_ok(label,1,40)),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  started_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ends_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  CHECK (ends_at>started_at AND ends_at<=started_at+interval '12 hours'),
  CHECK ((ended_at IS NULL)=(ended_by IS NULL)),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX walkin_kiosk_devices_school_idx ON hon.walkin_kiosk_devices(organization_id,school_id,started_at DESC);

-- W3/W4: one walk-in visit. The offer is frozen as chosen.
CREATE TABLE hon.walkin_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  device_id uuid NOT NULL,
  lead_id uuid NOT NULL UNIQUE REFERENCES hon.crm_leads(id) ON DELETE RESTRICT,
  contact_person_id uuid NOT NULL REFERENCES hon.people(id) ON DELETE RESTRICT,
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  settings_version integer NOT NULL CHECK (settings_version>=1),
  offer_key text NOT NULL CHECK (offer_key ~ '^[a-z0-9][a-z0-9-]{0,23}$'),
  offer_kind text NOT NULL CHECK (offer_kind IN ('DAY_PASS','TRIAL')),
  offer_name text NOT NULL CHECK (hon.school_event_text_ok(offer_name,1,60)),
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 0 AND 1000000),
  currency text NOT NULL CHECK (currency='USD'),
  emergency_name text NOT NULL CHECK (hon.school_event_text_ok(emergency_name,0,120)),
  emergency_phone text NOT NULL CHECK (emergency_phone='' OR emergency_phone ~ '^\+[1-9][0-9]{6,14}$'),
  heard_from text NOT NULL CHECK (heard_from IN ('','FRIEND','SEARCH','SOCIAL','WALKED_BY','EVENT','OTHER')),
  marketing_opt_in boolean NOT NULL,
  local_date date NOT NULL,
  payment_state text NOT NULL CHECK (payment_state IN ('FREE','PAY_AT_DESK','PAID_AT_DESK')),
  desk_method text CHECK (desk_method IS NULL OR desk_method IN ('CASH','CARD_OUTSIDE_HON','OTHER')),
  desk_paid_at timestamptz,
  desk_paid_by uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((payment_state='FREE')=(price_minor=0)),
  CHECK ((payment_state='PAID_AT_DESK')=(desk_paid_at IS NOT NULL) AND (desk_paid_at IS NULL)=(desk_paid_by IS NULL) AND (desk_paid_at IS NULL)=(desk_method IS NULL)),
  UNIQUE (device_id,key_hash),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (device_id,organization_id,school_id) REFERENCES hon.walkin_kiosk_devices(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX walkin_visits_school_idx ON hon.walkin_visits(organization_id,school_id,created_at DESC,id);

-- W3: the people on one visit (1-4). Ordinal 1 is the contact adult when they are training too.
CREATE TABLE hon.walkin_visit_participants (
  visit_id uuid NOT NULL REFERENCES hon.walkin_visits(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
  person_id uuid NOT NULL UNIQUE REFERENCES hon.people(id) ON DELETE RESTRICT,
  is_contact boolean NOT NULL,
  given_name text NOT NULL CHECK (hon.school_event_text_ok(given_name,1,60)),
  family_name text NOT NULL CHECK (hon.school_event_text_ok(family_name,1,60)),
  birth_date date NOT NULL CHECK (birth_date>=date '1900-01-01'),
  is_minor boolean NOT NULL,
  CHECK (NOT (is_contact AND is_minor)),
  PRIMARY KEY (visit_id,ordinal)
);

-- W3: the signed waiver. Append-only: never updated or deleted.
CREATE TABLE hon.walkin_waiver_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL UNIQUE,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  waiver_version integer NOT NULL,
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  text_hash text NOT NULL CHECK (text_hash ~ '^[a-f0-9]{64}$'),
  signer_person_id uuid NOT NULL REFERENCES hon.people(id) ON DELETE RESTRICT,
  signer_name text NOT NULL CHECK (hon.school_event_text_ok(signer_name,1,120)),
  signer_relationship text NOT NULL CHECK (signer_relationship IN ('SELF','PARENT','LEGAL_GUARDIAN','SELF_AND_PARENT','SELF_AND_LEGAL_GUARDIAN')),
  strokes jsonb NOT NULL CHECK (jsonb_typeof(strokes)='array' AND octet_length(strokes::text)<=16384),
  device_id uuid NOT NULL REFERENCES hon.walkin_kiosk_devices(id) ON DELETE RESTRICT,
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (visit_id,organization_id,school_id) REFERENCES hon.walkin_visits(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,waiver_version) REFERENCES hon.walkin_waiver_texts(school_id,waiver_version) ON DELETE RESTRICT
);

-- W3: hourly tablet counters (fixed word per device, or a keyed contact hash).
CREATE TABLE hon.walkin_kiosk_rates (
  device_id uuid NOT NULL REFERENCES hon.walkin_kiosk_devices(id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (bucket IN ('VISITS','READS') OR bucket ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 10001),
  PRIMARY KEY (device_id,bucket)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['walkin_kiosk_settings','walkin_waiver_texts','walkin_kiosk_devices','walkin_visits','walkin_visit_participants',
      'walkin_waiver_signatures','walkin_kiosk_rates'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    IF t<>'walkin_kiosk_rates' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence()',t||'_no_truncate',t);
    END IF;
  END LOOP;
END $$;

-- Settings-free guards. Settings: scope fixed, version +1, waiver version moves only by one. Waiver texts, participants and
-- signatures: insert only. Devices: only end once. Visits: only PAY_AT_DESK -> PAID_AT_DESK.
CREATE FUNCTION hon.guard_walkin_kiosk() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='walkin_kiosk_settings' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version<>1 OR NEW.waiver_version<>1 THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.organization_id,NEW.school_id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.created_at)
      OR NEW.version<>OLD.version+1 OR NEW.waiver_version NOT IN (OLD.waiver_version,OLD.waiver_version+1)
      OR ((NEW.waiver_version=OLD.waiver_version)<>(NEW.waiver IS NOT DISTINCT FROM OLD.waiver)) THEN
      RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='walkin_kiosk_devices' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version<>1 OR NEW.ended_at IS NOT NULL THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.label,NEW.token_digest,NEW.started_by,NEW.started_at,NEW.ends_at)
        IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.label,OLD.token_digest,OLD.started_by,OLD.started_at,OLD.ends_at)
      OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='walkin_visits' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.version<>1 OR NEW.payment_state='PAID_AT_DESK' THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.device_id,NEW.lead_id,NEW.contact_person_id,NEW.language,NEW.settings_version,NEW.offer_key,
        NEW.offer_kind,NEW.offer_name,NEW.price_minor,NEW.currency,NEW.emergency_name,NEW.emergency_phone,NEW.heard_from,NEW.marketing_opt_in,
        NEW.local_date,NEW.key_hash,NEW.payload_hash,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.device_id,OLD.lead_id,OLD.contact_person_id,OLD.language,OLD.settings_version,OLD.offer_key,
        OLD.offer_kind,OLD.offer_name,OLD.price_minor,OLD.currency,OLD.emergency_name,OLD.emergency_phone,OLD.heard_from,OLD.marketing_opt_in,
        OLD.local_date,OLD.key_hash,OLD.payload_hash,OLD.created_at)
      OR NEW.version<>OLD.version+1 OR NOT (OLD.payment_state='PAY_AT_DESK' AND NEW.payment_state='PAID_AT_DESK') THEN
      RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  -- walkin_waiver_texts, walkin_visit_participants, walkin_waiver_signatures: insert only.
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['walkin_kiosk_settings','walkin_waiver_texts','walkin_kiosk_devices','walkin_visits','walkin_visit_participants','walkin_waiver_signatures'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_walkin_kiosk()',t||'_guard',t);
  END LOOP;
END $$;

CREATE FUNCTION hon.walkin_utc(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE WHEN t IS NULL THEN NULL ELSE to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END $$;

-- Whether a principal holds a live, eligible staff grant with the permission at the school (the 0258 identity rules).
CREATE FUNCTION hon.walkin_principal_holds(principal uuid,org uuid,school uuid,permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
    WHERE p.id=principal AND p.principal_type='HUMAN_USER' AND p.is_active
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
        JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
        WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
          AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
          AND (r.management_school_id IS NULL OR r.management_school_id=school)
          AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
          AND rp.permission_code=permission)
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
        AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())))
$$;

-- Live direct-human walkin_kiosk.manage or walkin_kiosk.run at the current school, or a refusal.
CREATE FUNCTION hon.require_walkin_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission NOT IN ('walkin_kiosk.manage','walkin_kiosk.run')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND hon.walkin_principal_holds(p.id,org,school,permission);
  IF actor IS NULL THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Shared idempotency (the 0239 shape): reserve the key, take the IAM SHARE locks, re-check live authority, replay exactly.
CREATE FUNCTION hon.walkin_command_begin(subject text,permission text,key text,fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  actor:=hon.require_walkin_actor(subject,permission);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_walkin_actor(subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  RETURN prior.response_body;
END $$;

CREATE FUNCTION hon.walkin_command_finish(subject text,permission text,key text,actor uuid,result jsonb,action text,entity_type text,entity uuid,
  prior_state jsonb,next_state jsonb,event_type text,entity_version integer,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF entity_type NOT IN ('WALKIN_KIOSK_SETTINGS','WALKIN_KIOSK_DEVICE','WALKIN_VISIT') THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,entity_type,entity,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event_type,1,entity_type,entity,entity_version,correlation,request,next_state||jsonb_build_object('internalOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  -- Authority is re-checked after the last write, so a grant revoked while this command waited never commits it.
  IF hon.require_walkin_actor(subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION hon.walkin_settings_json(x hon.walkin_kiosk_settings) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN x.school_id IS NULL THEN NULL ELSE jsonb_build_object('enabled',x.enabled,'waiver',x.waiver,'waiverVersion',x.waiver_version,
    'emergencyRequired',x.emergency_required,'pipelineId',x.pipeline_id,'pipelineStageId',x.pipeline_stage_id,'offers',x.offers,'thankYou',x.thank_you,
    'version',x.version,'updatedAt',hon.walkin_utc(x.updated_at)) END
$$;

CREATE FUNCTION hon.walkin_device_json(d hon.walkin_kiosk_devices) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('deviceId',d.id,'label',d.label,'startedAt',hon.walkin_utc(d.started_at),'endsAt',hon.walkin_utc(d.ends_at),
    'endedAt',hon.walkin_utc(d.ended_at),'live',d.ended_at IS NULL AND d.ends_at>clock_timestamp(),'version',d.version,
    'startedBy',(SELECT p.display_name FROM hon.principals p WHERE p.id=d.started_by))
$$;

CREATE FUNCTION hon.walkin_visit_json(v hon.walkin_visits) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('visitId',v.id,'leadId',v.lead_id,'createdAt',hon.walkin_utc(v.created_at),'localDate',to_char(v.local_date,'YYYY-MM-DD'),
    'language',v.language,'offer',jsonb_build_object('key',v.offer_key,'kind',v.offer_kind,'name',v.offer_name,'priceMinor',v.price_minor,'currency',v.currency),
    'paymentState',v.payment_state,'deskMethod',v.desk_method,'deskPaidAt',hon.walkin_utc(v.desk_paid_at),
    'contact',(SELECT jsonb_build_object('givenName',p.given_name,'familyName',p.family_name,'email',p.email::text,'mobile',p.phone_e164) FROM hon.people p WHERE p.id=v.contact_person_id),
    'participants',coalesce((SELECT jsonb_agg(jsonb_build_object('givenName',x.given_name,'familyName',x.family_name,'birthDate',to_char(x.birth_date,'YYYY-MM-DD'),
      'isContact',x.is_contact,'isMinor',x.is_minor) ORDER BY x.ordinal) FROM hon.walkin_visit_participants x WHERE x.visit_id=v.id),'[]'::jsonb),
    'emergencyName',v.emergency_name,'emergencyPhone',v.emergency_phone,'heardFrom',v.heard_from,'marketingOptIn',v.marketing_opt_in,
    'waiverSignedAt',(SELECT hon.walkin_utc(s.signed_at) FROM hon.walkin_waiver_signatures s WHERE s.visit_id=v.id),
    'version',v.version)
$$;

-- W1 staff input: {expectedVersion, enabled, waiver, emergencyRequired, pipelineId, pipelineStageId, offers, thankYou}. NULL when not acceptable.
CREATE FUNCTION hon.walkin_settings_input(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE o jsonb; keys text[]:=ARRAY['expectedVersion','enabled','waiver','emergencyRequired','pipelineId','pipelineStageId','offers','thankYou'];
  okeys text[]:=ARRAY['key','kind','name','description','priceMinor'];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>40000 OR NOT p ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(keys))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'emergencyRequired') IS DISTINCT FROM 'boolean'
    OR NOT hon.walkin_text_ok(p->'waiver',1,8000,true) OR NOT hon.walkin_text_ok(p->'thankYou',0,300,false)
    OR jsonb_typeof(p->'pipelineId') IS DISTINCT FROM 'string' OR (p->>'pipelineId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'pipelineStageId') IS DISTINCT FROM 'string' OR (p->>'pipelineStageId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'offers') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'offers') NOT BETWEEN 1 AND 6 THEN RETURN NULL; END IF;
  FOR o IN SELECT e FROM jsonb_array_elements(p->'offers') e LOOP
    IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR NOT o ?& okeys OR EXISTS(SELECT 1 FROM jsonb_object_keys(o) k WHERE k<>ALL(okeys))
      OR jsonb_typeof(o->'key') IS DISTINCT FROM 'string' OR (o->>'key') !~ '^[a-z0-9][a-z0-9-]{0,23}$'
      OR jsonb_typeof(o->'kind') IS DISTINCT FROM 'string' OR (o->>'kind') NOT IN ('DAY_PASS','TRIAL')
      OR NOT hon.walkin_text_ok(o->'name',1,60,false) OR NOT hon.walkin_text_ok(o->'description',0,200,false)
      OR jsonb_typeof(o->'priceMinor') IS DISTINCT FROM 'number' OR (o->>'priceMinor') !~ '^(0|[1-9][0-9]{0,6})$' OR (o->>'priceMinor')::integer>1000000 THEN
      RETURN NULL; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT e->>'key') FROM jsonb_array_elements(p->'offers') e)<>jsonb_array_length(p->'offers') THEN RETURN NULL; END IF;
  RETURN p;
END $$;

-- W1: create (expectedVersion 0) or change the school's kiosk settings.
CREATE FUNCTION hon.save_walkin_kiosk_settings(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; v jsonb;
  x hon.walkin_kiosk_settings%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  v:=hon.walkin_settings_input(p);
  IF v IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','walkin_kiosk.settings.save','input',v)::text,'UTF8')),'hex');
  replay:=hon.walkin_command_begin(subject,'walkin_kiosk.manage',key,fp);
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.crm_pipeline_stages s WHERE s.id=(v->>'pipelineStageId')::uuid AND s.pipeline_id=(v->>'pipelineId')::uuid
      AND s.organization_id=org AND s.school_id=school) THEN RAISE EXCEPTION 'WALKIN_KIOSK_PIPELINE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO x FROM hon.walkin_kiosk_settings s WHERE s.organization_id=org AND s.school_id=school FOR UPDATE;
  IF NOT FOUND THEN
    IF (v->>'expectedVersion')::integer<>0 THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.walkin_waiver_texts(organization_id,school_id,waiver_version,texts,actor_principal_id) VALUES(org,school,1,v->'waiver',actor);
    INSERT INTO hon.walkin_kiosk_settings(organization_id,school_id,enabled,waiver,waiver_version,emergency_required,pipeline_id,pipeline_stage_id,offers,thank_you,actor_principal_id)
      VALUES(org,school,(v->>'enabled')::boolean,v->'waiver',1,(v->>'emergencyRequired')::boolean,(v->>'pipelineId')::uuid,(v->>'pipelineStageId')::uuid,
        v->'offers',v->'thankYou',actor) RETURNING * INTO x;
    prior:=NULL;
  ELSE
    IF x.version<>(v->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    prior:=jsonb_build_object('version',x.version,'waiverVersion',x.waiver_version,'enabled',x.enabled);
    IF x.waiver IS DISTINCT FROM v->'waiver' THEN
      INSERT INTO hon.walkin_waiver_texts(organization_id,school_id,waiver_version,texts,actor_principal_id) VALUES(org,school,x.waiver_version+1,v->'waiver',actor);
    END IF;
    UPDATE hon.walkin_kiosk_settings SET enabled=(v->>'enabled')::boolean,waiver=v->'waiver',
      waiver_version=CASE WHEN waiver IS DISTINCT FROM v->'waiver' THEN waiver_version+1 ELSE waiver_version END,
      emergency_required=(v->>'emergencyRequired')::boolean,pipeline_id=(v->>'pipelineId')::uuid,pipeline_stage_id=(v->>'pipelineStageId')::uuid,
      offers=v->'offers',thank_you=v->'thankYou',actor_principal_id=actor,version=version+1,updated_at=clock_timestamp()
      WHERE organization_id=org AND school_id=school RETURNING * INTO x;
  END IF;
  result:=jsonb_build_object('settings',hon.walkin_settings_json(x));
  PERFORM hon.walkin_command_finish(subject,'walkin_kiosk.manage',key,actor,result,'walkin_kiosk.settings.save','WALKIN_KIOSK_SETTINGS',school,prior,
    jsonb_build_object('version',x.version,'waiverVersion',x.waiver_version,'enabled',x.enabled),'walkin_kiosk.settings_saved',x.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- W2: start a tablet. p = {label, hours 1-12, tokenDigest}. The token itself never reaches the database.
CREATE FUNCTION hon.start_walkin_kiosk_device(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  d hon.walkin_kiosk_devices%ROWTYPE; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['label','hours','tokenDigest']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('label','hours','tokenDigest'))
    OR jsonb_typeof(p->'label') IS DISTINCT FROM 'string' OR NOT hon.school_event_text_ok(p->>'label',1,40)
    OR jsonb_typeof(p->'hours') IS DISTINCT FROM 'number' OR (p->>'hours') !~ '^([1-9]|1[0-2])$'
    OR jsonb_typeof(p->'tokenDigest') IS DISTINCT FROM 'string' OR (p->>'tokenDigest') !~ '^[a-f0-9]{64}$'
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  -- The token is minted fresh per call, so a replay is matched on the label and hours only and never returns a token.
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','walkin_kiosk.device.start','input',p-'tokenDigest')::text,'UTF8')),'hex');
  replay:=hon.walkin_command_begin(subject,'walkin_kiosk.run',key,fp);
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.run');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.walkin_kiosk_settings s WHERE s.organization_id=org AND s.school_id=school AND s.enabled) THEN
    RAISE EXCEPTION 'WALKIN_KIOSK_OFF' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM hon.walkin_kiosk_devices x WHERE x.token_digest=p->>'tokenDigest') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.walkin_kiosk_devices:'||school::text,0));
  IF (SELECT count(*) FROM hon.walkin_kiosk_devices x WHERE x.organization_id=org AND x.school_id=school AND x.ended_at IS NULL AND x.ends_at>clock_timestamp())>=10 THEN
    RAISE EXCEPTION 'WALKIN_KIOSK_DEVICE_LIMIT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.walkin_kiosk_devices(organization_id,school_id,label,token_digest,started_by,ends_at)
    VALUES(org,school,p->>'label',p->>'tokenDigest',actor,clock_timestamp()+make_interval(hours=>(p->>'hours')::integer)) RETURNING * INTO d;
  result:=jsonb_build_object('device',hon.walkin_device_json(d));
  PERFORM hon.walkin_command_finish(subject,'walkin_kiosk.run',key,actor,result,'walkin_kiosk.device.start','WALKIN_KIOSK_DEVICE',d.id,NULL,
    jsonb_build_object('deviceId',d.id,'version',d.version),'walkin_kiosk.device_started',d.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- W2: end a tablet early. p = {expectedVersion}.
CREATE FUNCTION hon.end_walkin_kiosk_device(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  d hon.walkin_kiosk_devices%ROWTYPE; result jsonb;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ? 'expectedVersion' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>'expectedVersion')
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','walkin_kiosk.device.end','deviceId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.walkin_command_begin(subject,'walkin_kiosk.run',key,fp);
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.run');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO d FROM hon.walkin_kiosk_devices x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALKIN_KIOSK_DEVICE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF d.ended_at IS NOT NULL THEN RAISE EXCEPTION 'WALKIN_KIOSK_DEVICE_ENDED' USING ERRCODE='40001'; END IF;
  UPDATE hon.walkin_kiosk_devices SET ended_at=clock_timestamp(),ended_by=actor,version=version+1 WHERE id=d.id RETURNING * INTO d;
  result:=jsonb_build_object('device',hon.walkin_device_json(d));
  PERFORM hon.walkin_command_finish(subject,'walkin_kiosk.run',key,actor,result,'walkin_kiosk.device.end','WALKIN_KIOSK_DEVICE',d.id,
    jsonb_build_object('deviceId',d.id,'version',d.version-1),jsonb_build_object('deviceId',d.id,'version',d.version),'walkin_kiosk.device_ended',d.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- W4: mark a PAY_AT_DESK visit paid at the desk. p = {expectedVersion, method}.
CREATE FUNCTION hon.set_walkin_visit_desk_paid(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  v hon.walkin_visits%ROWTYPE; result jsonb;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['expectedVersion','method']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','method'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'method') IS DISTINCT FROM 'string' OR (p->>'method') NOT IN ('CASH','CARD_OUTSIDE_HON','OTHER')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','walkin_kiosk.visit.desk_paid','visitId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.walkin_command_begin(subject,'walkin_kiosk.run',key,fp);
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.run');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO v FROM hon.walkin_visits x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALKIN_VISIT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF v.payment_state<>'PAY_AT_DESK' THEN RAISE EXCEPTION 'WALKIN_VISIT_NOT_DUE' USING ERRCODE='40001'; END IF;
  UPDATE hon.walkin_visits SET payment_state='PAID_AT_DESK',desk_method=p->>'method',desk_paid_at=clock_timestamp(),desk_paid_by=actor,
    version=version+1,updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
  result:=jsonb_build_object('visit',hon.walkin_visit_json(v));
  PERFORM hon.walkin_command_finish(subject,'walkin_kiosk.run',key,actor,result,'walkin_kiosk.visit.desk_paid','WALKIN_VISIT',v.id,
    jsonb_build_object('visitId',v.id,'paymentState','PAY_AT_DESK','version',v.version-1),
    jsonb_build_object('visitId',v.id,'paymentState',v.payment_state,'version',v.version),'walkin_kiosk.visit_desk_paid',v.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- Staff reads. walkin_kiosk.run: the kiosk overview (settings summary, tablets, last 14 days of walk-ins, at most 100).
CREATE FUNCTION hon.read_walkin_kiosk(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; x hon.walkin_kiosk_settings%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.run');
  SELECT * INTO x FROM hon.walkin_kiosk_settings s WHERE s.organization_id=org AND s.school_id=school;
  result:=jsonb_build_object('canManage',hon.walkin_principal_holds(actor,org,school,'walkin_kiosk.manage'),
    'configured',FOUND,'enabled',coalesce(x.enabled,false),
    'devices',coalesce((SELECT jsonb_agg(hon.walkin_device_json(d) ORDER BY d.started_at DESC,d.id) FROM (SELECT * FROM hon.walkin_kiosk_devices y
      WHERE y.organization_id=org AND y.school_id=school AND y.started_at>clock_timestamp()-interval '24 hours' ORDER BY y.started_at DESC,y.id LIMIT 20) d),'[]'::jsonb),
    'visits',coalesce((SELECT jsonb_agg(hon.walkin_visit_json(v) ORDER BY v.created_at DESC,v.id) FROM (SELECT * FROM hon.walkin_visits y
      WHERE y.organization_id=org AND y.school_id=school AND y.created_at>clock_timestamp()-interval '14 days' ORDER BY y.created_at DESC,y.id LIMIT 100) v),'[]'::jsonb));
  IF hon.require_walkin_actor(subject,'walkin_kiosk.run') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- walkin_kiosk.manage: the full settings plus the school's pipelines and stages to choose from.
CREATE FUNCTION hon.read_walkin_kiosk_settings(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; x hon.walkin_kiosk_settings%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.manage');
  SELECT * INTO x FROM hon.walkin_kiosk_settings s WHERE s.organization_id=org AND s.school_id=school;
  result:=jsonb_build_object('settings',CASE WHEN FOUND THEN hon.walkin_settings_json(x) ELSE NULL END,
    'pipelines',coalesce((SELECT jsonb_agg(jsonb_build_object('pipelineId',pl.id,'name',pl.name,
      'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('stageId',st.id,'name',st.name) ORDER BY st.position,st.id) FROM hon.crm_pipeline_stages st
        WHERE st.pipeline_id=pl.id AND st.organization_id=org AND st.school_id=school),'[]'::jsonb)) ORDER BY pl.created_at,pl.id)
      FROM (SELECT * FROM hon.crm_pipelines y WHERE y.organization_id=org AND y.school_id=school ORDER BY y.created_at,y.id LIMIT 20) pl),'[]'::jsonb));
  IF hon.require_walkin_actor(subject,'walkin_kiosk.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- walkin_kiosk.run: one visit with its signed waiver (the exact text in the signed language, and the strokes).
CREATE FUNCTION hon.read_walkin_visit(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; v hon.walkin_visits%ROWTYPE;
  s hon.walkin_waiver_signatures%ROWTYPE; t hon.walkin_waiver_texts%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.run');
  SELECT * INTO v FROM hon.walkin_visits x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALKIN_VISIT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM hon.walkin_waiver_signatures x WHERE x.visit_id=v.id;
  SELECT * INTO t FROM hon.walkin_waiver_texts x WHERE x.school_id=school AND x.waiver_version=s.waiver_version;
  result:=jsonb_build_object('visit',hon.walkin_visit_json(v),'waiver',jsonb_build_object('version',s.waiver_version,'language',s.language,
    'text',t.texts->>s.language,'textHash',s.text_hash,'signerName',s.signer_name,'relationship',s.signer_relationship,'strokes',s.strokes,
    'signedAt',hon.walkin_utc(s.signed_at)));
  IF hon.require_walkin_actor(subject,'walkin_kiosk.run') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- The live tablet for a token digest: not ended or expired, live school/organization/entitlement, kiosk on, and the starter
-- still holds walkin_kiosk.run.
CREATE FUNCTION hon.walkin_live_device(digest text) RETURNS hon.walkin_kiosk_devices
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT d.* FROM hon.walkin_kiosk_devices d JOIN hon.walkin_kiosk_settings k ON k.organization_id=d.organization_id AND k.school_id=d.school_id
  WHERE digest ~ '^[a-f0-9]{64}$' AND d.token_digest=digest AND d.ended_at IS NULL AND d.ends_at>clock_timestamp() AND k.enabled
    AND hon.walkin_principal_holds(d.started_by,d.organization_id,d.school_id,'walkin_kiosk.run')
$$;

CREATE FUNCTION hon.take_walkin_kiosk_rate(device uuid,bucket_name text,limit_count integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; asof timestamptz:=clock_timestamp();
BEGIN
  INSERT INTO hon.walkin_kiosk_rates(device_id,bucket,window_start,attempts) VALUES(device,bucket_name,asof,1)
  ON CONFLICT(device_id,bucket) DO UPDATE SET
    window_start=CASE WHEN hon.walkin_kiosk_rates.window_start<=asof-interval '1 hour' THEN asof ELSE hon.walkin_kiosk_rates.window_start END,
    attempts=CASE WHEN hon.walkin_kiosk_rates.window_start<=asof-interval '1 hour' THEN 1 ELSE least(hon.walkin_kiosk_rates.attempts+1,10001) END
  RETURNING attempts INTO n;
  RETURN n<=limit_count;
END $$;

-- W3: what the tablet shows. NULL for any token that is not a live tablet (one answer for every reason).
CREATE FUNCTION hon.read_walkin_kiosk_terminal(digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.walkin_kiosk_devices%ROWTYPE; k hon.walkin_kiosk_settings%ROWTYPE; branding jsonb;
BEGIN
  d:=hon.walkin_live_device(digest);
  IF d.id IS NULL THEN RETURN NULL; END IF;
  IF NOT hon.take_walkin_kiosk_rate(d.id,'READS',600) THEN RETURN NULL; END IF;
  SELECT * INTO k FROM hon.walkin_kiosk_settings s WHERE s.organization_id=d.organization_id AND s.school_id=d.school_id;
  branding:=hon.read_public_school_branding(d.school_id);
  RETURN jsonb_build_object('schoolName',coalesce(branding->>'schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=d.school_id)),
    'branding',jsonb_build_object('logoUrl',branding->'logoUrl','accentColor',branding->'accentColor'),
    'endsAt',hon.walkin_utc(d.ends_at),'settingsVersion',k.version,'waiver',k.waiver,'emergencyRequired',k.emergency_required,
    'offers',(SELECT jsonb_agg(jsonb_build_object('key',o->>'key','kind',o->>'kind','name',o->'name','description',o->'description','priceMinor',(o->>'priceMinor')::integer,'currency','USD'))
      FROM jsonb_array_elements(k.offers) o),'thankYou',k.thank_you);
END $$;

-- One name, birth date or contact field from the tablet input.
CREATE FUNCTION hon.walkin_name_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$ SELECT jsonb_typeof(v)='string' AND hon.school_event_text_ok(v#>>'{}',1,60) AND (v#>>'{}') !~ '[<>]' $$;
CREATE FUNCTION hon.walkin_birth_date(v jsonb,today date) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE d date;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR (v#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
  BEGIN d:=(v#>>'{}')::date; EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
  IF to_char(d,'YYYY-MM-DD')<>(v#>>'{}') OR d<date '1900-01-01' OR d>today THEN RETURN NULL; END IF;
  RETURN d;
END $$;

-- W3 tablet input, checked against the live settings. Returns the normalized visit or NULL when anything is not acceptable.
-- {settingsVersion, language, contact{givenName,familyName,email,mobile,birthDate|null,isParticipant,adultConfirmed},
--  children[{givenName,familyName,birthDate}] (0-3), relationship (PARENT|LEGAL_GUARDIAN|null), emergency{name,phone}, heardFrom,
--  marketingOptIn, offerKey, waiver{accepted,signerName,strokes}, website (honeypot, must be '')}
CREATE FUNCTION hon.walkin_visit_input(k hon.walkin_kiosk_settings,p jsonb,today date) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE c jsonb; ch jsonb; e jsonb; w jsonb; email text; mobile text; cbirth date; b date; kids jsonb:='[]'::jsonb; offer jsonb; s jsonb; pt jsonb;
  points integer:=0; minors integer:=0;
  keys text[]:=ARRAY['settingsVersion','language','contact','children','relationship','emergency','heardFrom','marketingOptIn','offerKey','waiver','website'];
  ckeys text[]:=ARRAY['givenName','familyName','email','mobile','birthDate','isParticipant','adultConfirmed'];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>24576 OR NOT p ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x<>ALL(keys))
    OR jsonb_typeof(p->'settingsVersion') IS DISTINCT FROM 'number' OR (p->>'settingsVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'language') IS DISTINCT FROM 'string' OR (p->>'language') NOT IN ('en','ko','es')
    OR jsonb_typeof(p->'website') IS DISTINCT FROM 'string' OR p->>'website'<>''
    OR jsonb_typeof(p->'marketingOptIn') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p->'heardFrom') IS DISTINCT FROM 'string' OR (p->>'heardFrom') NOT IN ('','FRIEND','SEARCH','SOCIAL','WALKED_BY','EVENT','OTHER')
    OR jsonb_typeof(p->'offerKey') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'children') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'children')>3 THEN RETURN NULL; END IF;
  -- Contact adult.
  c:=p->'contact';
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT c ?& ckeys OR EXISTS(SELECT 1 FROM jsonb_object_keys(c) x WHERE x<>ALL(ckeys))
    OR NOT hon.walkin_name_ok(c->'givenName') OR NOT hon.walkin_name_ok(c->'familyName')
    OR jsonb_typeof(c->'email') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'mobile') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'isParticipant') IS DISTINCT FROM 'boolean' OR c->'adultConfirmed' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL; END IF;
  email:=lower(c->>'email'); mobile:=c->>'mobile';
  IF length(email)>254 OR length(mobile)>16 OR (email='' AND mobile='')
    OR (email<>'' AND email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$')
    OR (mobile<>'' AND mobile !~ '^\+[1-9][0-9]{6,14}$') THEN RETURN NULL; END IF;
  IF (c->>'isParticipant')::boolean THEN
    cbirth:=hon.walkin_birth_date(c->'birthDate',today);
    -- A participant under 18 cannot be the contact who signs: a parent or legal guardian signs for them.
    IF cbirth IS NULL OR cbirth>(today-interval '18 years')::date THEN RETURN NULL; END IF;
  ELSIF c->'birthDate' IS DISTINCT FROM 'null'::jsonb THEN RETURN NULL;
  END IF;
  -- Children: each under 18 (an adult signs only for themselves).
  FOR ch IN SELECT x FROM jsonb_array_elements(p->'children') x LOOP
    IF jsonb_typeof(ch) IS DISTINCT FROM 'object' OR NOT ch ?& ARRAY['givenName','familyName','birthDate']
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(ch) x WHERE x NOT IN ('givenName','familyName','birthDate'))
      OR NOT hon.walkin_name_ok(ch->'givenName') OR NOT hon.walkin_name_ok(ch->'familyName') THEN RETURN NULL; END IF;
    b:=hon.walkin_birth_date(ch->'birthDate',today);
    IF b IS NULL OR b<=(today-interval '18 years')::date THEN RETURN NULL; END IF;
    kids:=kids||jsonb_build_array(jsonb_build_object('givenName',ch->>'givenName','familyName',ch->>'familyName','birthDate',to_char(b,'YYYY-MM-DD')));
    minors:=minors+1;
  END LOOP;
  IF NOT (c->>'isParticipant')::boolean AND minors=0 THEN RETURN NULL; END IF;
  IF minors>0 THEN
    IF jsonb_typeof(p->'relationship') IS DISTINCT FROM 'string' OR (p->>'relationship') NOT IN ('PARENT','LEGAL_GUARDIAN') THEN RETURN NULL; END IF;
  ELSIF p->'relationship' IS DISTINCT FROM 'null'::jsonb THEN RETURN NULL;
  END IF;
  -- Emergency contact.
  e:=p->'emergency';
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT e ?& ARRAY['name','phone'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(e) x WHERE x NOT IN ('name','phone'))
    OR jsonb_typeof(e->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'phone') IS DISTINCT FROM 'string'
    OR NOT hon.school_event_text_ok(e->>'name',0,120) OR (e->>'phone'<>'' AND (e->>'phone') !~ '^\+[1-9][0-9]{6,14}$')
    OR ((e->>'name'='')<>(e->>'phone'='')) OR (k.emergency_required AND e->>'name'='') THEN RETURN NULL; END IF;
  -- Offer.
  SELECT o INTO offer FROM jsonb_array_elements(k.offers) o WHERE o->>'key'=p->>'offerKey';
  IF offer IS NULL THEN RETURN NULL; END IF;
  -- Waiver: accepted, typed name, at least one stroke of two points; at most 40 strokes, 2000 points, coordinates 0-1000.
  w:=p->'waiver';
  IF jsonb_typeof(w) IS DISTINCT FROM 'object' OR NOT w ?& ARRAY['accepted','signerName','strokes']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(w) x WHERE x NOT IN ('accepted','signerName','strokes'))
    OR w->'accepted' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(w->'signerName') IS DISTINCT FROM 'string'
    OR NOT hon.school_event_text_ok(w->>'signerName',1,120) OR (w->>'signerName') ~ '[<>]' OR jsonb_typeof(w->'strokes') IS DISTINCT FROM 'array'
    OR jsonb_array_length(w->'strokes') NOT BETWEEN 1 AND 40 OR octet_length((w->'strokes')::text)>16384 THEN RETURN NULL; END IF;
  FOR s IN SELECT x FROM jsonb_array_elements(w->'strokes') x LOOP
    IF jsonb_typeof(s) IS DISTINCT FROM 'array' OR jsonb_array_length(s)<1 THEN RETURN NULL; END IF;
    FOR pt IN SELECT x FROM jsonb_array_elements(s) x LOOP
      IF jsonb_typeof(pt) IS DISTINCT FROM 'array' OR jsonb_array_length(pt)<>2 OR jsonb_typeof(pt->0)<>'number' OR jsonb_typeof(pt->1)<>'number'
        OR (pt->>0) !~ '^(0|[1-9][0-9]{0,3})$' OR (pt->>1) !~ '^(0|[1-9][0-9]{0,3})$' OR (pt->>0)::integer>1000 OR (pt->>1)::integer>1000 THEN RETURN NULL; END IF;
      points:=points+1;
    END LOOP;
  END LOOP;
  IF points<2 OR points>2000 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('settingsVersion',(p->>'settingsVersion')::integer,'language',p->>'language',
    'contact',jsonb_build_object('givenName',c->>'givenName','familyName',c->>'familyName','email',email,'mobile',mobile,
      'birthDate',CASE WHEN cbirth IS NULL THEN NULL ELSE to_char(cbirth,'YYYY-MM-DD') END,'isParticipant',(c->>'isParticipant')::boolean),
    'children',kids,'relationship',p->'relationship','emergency',jsonb_build_object('name',e->>'name','phone',e->>'phone'),
    'heardFrom',p->>'heardFrom','marketingOptIn',(p->>'marketingOptIn')::boolean,'offer',offer,
    'waiver',jsonb_build_object('signerName',w->>'signerName','strokes',w->'strokes'));
END $$;

-- W3: submit one visit from a live tablet. Returns {result}: RECORDED (with firstName, paymentState, priceMinor, thankYou),
-- INVALID, STALE (the settings changed: reload), CLOSED (not a live tablet) or RATE_LIMITED.
CREATE FUNCTION hon.submit_walkin_visit(digest text,p jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.walkin_kiosk_devices%ROWTYPE; k hon.walkin_kiosk_settings%ROWTYPE; v jsonb; kh text; ph text; tz text; today date;
  x hon.walkin_visits%ROWTYPE; contact uuid; lead uuid:=gen_random_uuid(); visit uuid:=gen_random_uuid(); child jsonb; person uuid; n integer:=1;
  ch text; request uuid:=gen_random_uuid(); waiver_text text; first_name text; secret text;
  svc constant uuid:='00000000-0000-4000-8000-000000000396';
BEGIN
  IF digest IS NULL OR digest !~ '^[a-f0-9]{64}$' OR key IS NULL OR key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  d:=hon.walkin_live_device(digest);
  IF d.id IS NULL THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  -- Lock order: organization -> school -> settings -> device -> visit (staff paths lock settings or one device or one visit).
  PERFORM 1 FROM hon.organizations WHERE id=d.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  SELECT timezone INTO tz FROM hon.schools WHERE id=d.school_id AND organization_id=d.organization_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  SELECT * INTO k FROM hon.walkin_kiosk_settings WHERE organization_id=d.organization_id AND school_id=d.school_id FOR SHARE;
  SELECT * INTO d FROM hon.walkin_kiosk_devices WHERE id=d.id FOR SHARE;
  IF NOT k.enabled OR d.ended_at IS NOT NULL OR d.ends_at<=clock_timestamp() THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  PERFORM 1 FROM hon.principals WHERE id=svc AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=svc) OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=svc)
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=svc) THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
  today:=(clock_timestamp() AT TIME ZONE tz)::date;
  secret:=d.token_digest;
  kh:=encode(sha256(convert_to(secret||':key:'||key,'UTF8')),'hex');
  -- An exact retry returns the same answer, whatever has happened since.
  SELECT * INTO x FROM hon.walkin_visits WHERE device_id=d.id AND key_hash=kh;
  IF FOUND THEN
    ph:=encode(sha256(convert_to(secret||':payload:'||coalesce(p::text,''),'UTF8')),'hex');
    IF ph<>x.payload_hash THEN RETURN jsonb_build_object('result','INVALID'); END IF;
    SELECT given_name INTO first_name FROM hon.walkin_visit_participants WHERE visit_id=x.id ORDER BY ordinal LIMIT 1;
    RETURN jsonb_build_object('result','RECORDED','firstName',first_name,'paymentState',x.payment_state,'priceMinor',x.price_minor,
      'thankYou',k.thank_you->>x.language);
  END IF;
  DELETE FROM hon.walkin_kiosk_rates WHERE device_id=d.id AND window_start<=clock_timestamp()-interval '1 hour';
  IF NOT hon.take_walkin_kiosk_rate(d.id,'VISITS',120) THEN RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'settingsVersion') IS DISTINCT FROM 'number' THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  IF (p->>'settingsVersion') IS DISTINCT FROM k.version::text THEN RETURN jsonb_build_object('result','STALE'); END IF;
  BEGIN v:=hon.walkin_visit_input(k,p,today); EXCEPTION WHEN OTHERS THEN v:=NULL; END;
  IF v IS NULL THEN RETURN jsonb_build_object('result','INVALID'); END IF;
  FOREACH ch IN ARRAY ARRAY[nullif(v->'contact'->>'email',''),nullif(v->'contact'->>'mobile','')] LOOP
    IF ch IS NOT NULL AND NOT hon.take_walkin_kiosk_rate(d.id,encode(sha256(convert_to(secret||':contact:'||ch,'UTF8')),'hex'),5) THEN
      RETURN jsonb_build_object('result','RATE_LIMITED'); END IF;
  END LOOP;
  ph:=encode(sha256(convert_to(secret||':payload:'||p::text,'UTF8')),'hex');
  waiver_text:=coalesce(nullif(k.waiver->>(v->>'language'),''),k.waiver->>'en');
  -- People, lead, consent, visit, participants, signature.
  INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164)
    VALUES(d.organization_id,d.school_id,v->'contact'->>'givenName',v->'contact'->>'familyName',nullif(v->'contact'->>'email','')::public.citext,nullif(v->'contact'->>'mobile',''))
    RETURNING id INTO contact;
  INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,source_code,attribution)
    VALUES(lead,d.organization_id,d.school_id,contact,k.pipeline_id,k.pipeline_stage_id,'WALK_IN_KIOSK',
      jsonb_build_object('walkInKiosk',jsonb_build_object('visitId',visit,'deviceId',d.id,'offerKey',v->'offer'->>'key')));
  IF (v->>'marketingOptIn')::boolean THEN
    IF v->'contact'->>'email'<>'' THEN
      INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id)
        VALUES(d.organization_id,d.school_id,contact,'EMAIL','OPTED_IN','RECIPIENT',clock_timestamp(),svc);
    END IF;
    IF v->'contact'->>'mobile'<>'' THEN
      INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id)
        VALUES(d.organization_id,d.school_id,contact,'SMS','OPTED_IN','RECIPIENT',clock_timestamp(),svc);
    END IF;
  END IF;
  INSERT INTO hon.walkin_visits(id,organization_id,school_id,device_id,lead_id,contact_person_id,language,settings_version,offer_key,offer_kind,offer_name,
      price_minor,currency,emergency_name,emergency_phone,heard_from,marketing_opt_in,local_date,payment_state,key_hash,payload_hash)
    VALUES(visit,d.organization_id,d.school_id,d.id,lead,contact,v->>'language',k.version,v->'offer'->>'key',v->'offer'->>'kind',
      coalesce(nullif(v->'offer'->'name'->>(v->>'language'),''),v->'offer'->'name'->>'en'),(v->'offer'->>'priceMinor')::integer,'USD',
      v->'emergency'->>'name',v->'emergency'->>'phone',v->>'heardFrom',(v->>'marketingOptIn')::boolean,today,
      CASE WHEN (v->'offer'->>'priceMinor')::integer=0 THEN 'FREE' ELSE 'PAY_AT_DESK' END,kh,ph) RETURNING * INTO x;
  IF (v->'contact'->>'isParticipant')::boolean THEN
    INSERT INTO hon.walkin_visit_participants(visit_id,ordinal,person_id,is_contact,given_name,family_name,birth_date,is_minor)
      VALUES(visit,1,contact,true,v->'contact'->>'givenName',v->'contact'->>'familyName',(v->'contact'->>'birthDate')::date,false);
    n:=2;
  END IF;
  FOR child IN SELECT y FROM jsonb_array_elements(v->'children') y LOOP
    INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES(d.organization_id,d.school_id,child->>'givenName',child->>'familyName') RETURNING id INTO person;
    INSERT INTO hon.walkin_visit_participants(visit_id,ordinal,person_id,is_contact,given_name,family_name,birth_date,is_minor)
      VALUES(visit,n,person,false,child->>'givenName',child->>'familyName',(child->>'birthDate')::date,true);
    n:=n+1;
  END LOOP;
  INSERT INTO hon.walkin_waiver_signatures(visit_id,organization_id,school_id,waiver_version,language,text_hash,signer_person_id,signer_name,signer_relationship,strokes,device_id)
    VALUES(visit,d.organization_id,d.school_id,k.waiver_version,CASE WHEN nullif(k.waiver->>(v->>'language'),'') IS NULL THEN 'en' ELSE v->>'language' END,
      encode(sha256(convert_to(waiver_text,'UTF8')),'hex'),contact,v->'waiver'->>'signerName',
      CASE WHEN jsonb_array_length(v->'children')=0 THEN 'SELF'
        WHEN (v->'contact'->>'isParticipant')::boolean THEN 'SELF_AND_'||(v->>'relationship') ELSE v->>'relationship' END,
      v->'waiver'->'strokes',d.id);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(d.organization_id,d.school_id,svc,'PUBLIC_API','walkin_kiosk.visit.create','WALKIN_VISIT',visit,
      jsonb_build_object('visitId',visit,'leadId',lead,'deviceId',d.id,'paymentState',x.payment_state,'version',1),'SUCCEEDED',request,request);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(d.organization_id,d.school_id,svc,'PUBLIC_API','crm.lead.create','CRM_LEAD',lead,
      jsonb_build_object('walkInVisitId',visit,'source','WALK_IN_KIOSK','version',1),'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(d.organization_id,d.school_id,'walkin_kiosk.visit_recorded',1,'WALKIN_VISIT',visit,1,request,request,
      jsonb_build_object('visitId',visit,'leadId',lead,'internalOnly',true));
  first_name:=CASE WHEN (v->'contact'->>'isParticipant')::boolean THEN v->'contact'->>'givenName' ELSE v->'children'->0->>'givenName' END;
  RETURN jsonb_build_object('result','RECORDED','firstName',first_name,'paymentState',x.payment_state,'priceMinor',x.price_minor,
    'thankYou',k.thank_you->>x.language);
END $$;

COMMENT ON TABLE hon.walkin_kiosk_settings IS '0396 walk-in kiosk settings per school (W1). Private.';
COMMENT ON TABLE hon.walkin_waiver_texts IS '0396 every waiver text version a school has had (W1). Insert only. Private.';
COMMENT ON TABLE hon.walkin_kiosk_devices IS '0396 started kiosk tablets; token digest only (W2). Private.';
COMMENT ON TABLE hon.walkin_visits IS '0396 walk-in visits with the frozen offer and payment state (W3/W4). Never deleted. Private.';
COMMENT ON TABLE hon.walkin_visit_participants IS '0396 the people on a walk-in visit (W3). Insert only. Private.';
COMMENT ON TABLE hon.walkin_waiver_signatures IS '0396 signed walk-in waivers: version, language, text hash, typed name, strokes (W3). Insert only. Private.';
COMMENT ON TABLE hon.walkin_kiosk_rates IS '0396 hourly tablet counters. Private.';
COMMENT ON FUNCTION hon.submit_walkin_visit(text,jsonb,text) IS
'Tablet walk-in intake (W3): people, one WALK_IN_KIOSK lead, optional opt-in, the visit and the append-only signed waiver in one transaction. No message, charge or AI.';

DO $$ DECLARE r text; t text; f text; fns text[]:=ARRAY['hon.walkin_text_ok(jsonb,integer,integer,boolean)','hon.guard_walkin_kiosk()',
    'hon.walkin_utc(timestamp with time zone)','hon.walkin_principal_holds(uuid,uuid,uuid,text)','hon.require_walkin_actor(text,text)',
    'hon.walkin_command_begin(text,text,text,text)','hon.walkin_command_finish(text,text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',
    'hon.walkin_settings_json(hon.walkin_kiosk_settings)','hon.walkin_device_json(hon.walkin_kiosk_devices)','hon.walkin_visit_json(hon.walkin_visits)',
    'hon.walkin_settings_input(jsonb)','hon.save_walkin_kiosk_settings(text,jsonb,text,uuid,uuid)','hon.start_walkin_kiosk_device(text,jsonb,text,uuid,uuid)',
    'hon.end_walkin_kiosk_device(text,uuid,jsonb,text,uuid,uuid)','hon.set_walkin_visit_desk_paid(text,uuid,jsonb,text,uuid,uuid)',
    'hon.read_walkin_kiosk(text)','hon.read_walkin_kiosk_settings(text)','hon.read_walkin_visit(text,uuid)','hon.walkin_live_device(text)',
    'hon.take_walkin_kiosk_rate(uuid,text,integer)','hon.read_walkin_kiosk_terminal(text)','hon.walkin_name_ok(jsonb)','hon.walkin_birth_date(jsonb,date)',
    'hon.walkin_visit_input(hon.walkin_kiosk_settings,jsonb,date)','hon.submit_walkin_visit(text,jsonb,text)']; BEGIN
  FOREACH t IN ARRAY ARRAY['walkin_kiosk_settings','walkin_waiver_texts','walkin_kiosk_devices','walkin_visits','walkin_visit_participants',
      'walkin_waiver_signatures','walkin_kiosk_rates'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.save_walkin_kiosk_settings(text,jsonb,text,uuid,uuid),hon.start_walkin_kiosk_device(text,jsonb,text,uuid,uuid),
      hon.end_walkin_kiosk_device(text,uuid,jsonb,text,uuid,uuid),hon.set_walkin_visit_desk_paid(text,uuid,jsonb,text,uuid,uuid),
      hon.read_walkin_kiosk(text),hon.read_walkin_kiosk_settings(text),hon.read_walkin_visit(text,uuid),
      hon.read_walkin_kiosk_terminal(text),hon.submit_walkin_visit(text,jsonb,text) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND EXISTS(SELECT 1 FROM unnest(ARRAY['walkin_kiosk_settings','walkin_waiver_texts','walkin_kiosk_devices','walkin_visits','walkin_visit_participants',
      'walkin_waiver_signatures','walkin_kiosk_rates']) t WHERE has_table_privilege('hon_runtime','hon.'||t,'SELECT,INSERT,UPDATE,DELETE')) THEN
    RAISE EXCEPTION 'Walk-in kiosk must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
