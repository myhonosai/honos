BEGIN;
-- 0547 school calling, piece CL1 (allocated by the coordinator 2026-11-19; docs/architecture/SCHOOL_CALLING.md §5).
-- Calls on the school's own texting number (0248): the call log, voicemail, the school's calling settings, who rings for
-- incoming calls and the school's do-not-call list. This migration places no call and talks to no provider: the API
-- reaches Twilio only behind HON_VOICE_CALLS_APPROVED, and call minutes are included like texting (owner card 05:19Z).
--   K1 Staff with communication.call.use read the call log and voicemail, set their own "Ring me", start an outgoing call
--      (+1 numbers only, no 900 or 976, not the school's own number, not on the do-not-call list, 60 an hour each),
--      record an outcome and note, mark a voicemail heard, set do-not-call, and open a recording (audited).
--   K2 Staff with communication.call.manage (system OWNER roles) switch calling on or off, set the voicemail greeting and
--      switch recording on, which needs the consent statement accepted (who and when are kept).
--   K3 The communication worker login connects an outgoing browser call only for the staff member who started it, on the
--      school's own subaccount, within two minutes, once; routes an incoming call to the staff who have Ring me on; and
--      records call progress, answers, voicemails and recordings. Status never moves backwards; recordings are deleted
--      after 90 days.
--   K4 Calls are never deleted and keep their school, direction and numbers. The runtime and the worker gain no table
--      privilege: entry points are SECURITY DEFINER, audit rows and outbox events carry ids only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker')) THEN
    RAISE EXCEPTION 'School calls require a trusted migration owner';
  END IF;
  IF to_regclass('hon.school_text_senders') IS NULL OR to_regclass('hon.school_twilio_accounts') IS NULL
    OR to_regprocedure('hon.conversation_staff_has(uuid,uuid,uuid,text)') IS NULL OR to_regprocedure('hon.conversation_time(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'School calls require 0248, 0351 and 0364';
  END IF;
END $$;

-- The fixed actor for provider evidence. No grants, roles or human user ever belong to it.
INSERT INTO hon.principals (id, principal_type, user_id, display_name, is_active)
VALUES ('00000000-0000-4000-8000-00000000c547', 'INTEGRATION', NULL, 'HON calling', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('communication.call.use','Make and take calls on the school number, see the call log and play voicemail',true,true),
  ('communication.call.manage','Switch school calling on or off, set the voicemail greeting and call recording',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('communication.call.use','communication.call.manage') AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'calling permissions already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN (VALUES ('communication.call.use'),('communication.call.manage')) p(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE hon.school_calling_settings (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  calling_on boolean NOT NULL DEFAULT false,
  voicemail_greeting text CHECK (length(voicemail_greeting) BETWEEN 1 AND 300 AND voicemail_greeting !~ '[[:cntrl:]<>]'),
  recording_on boolean NOT NULL DEFAULT false,
  recording_consent_by uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recording_consent_at timestamptz,
  updated_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT school_calling_settings_consent CHECK (NOT recording_on OR (recording_consent_by IS NOT NULL AND recording_consent_at IS NOT NULL))
);

CREATE TABLE hon.school_call_staff (
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  ring_me boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, principal_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.school_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('IN','OUT')),
  status text NOT NULL CHECK (status IN ('INITIATED','RINGING','IN_PROGRESS','COMPLETED','NO_ANSWER','BUSY','FAILED','CANCELED',
    'MISSED','VOICEMAIL','EXPIRED')),
  school_number_e164 text NOT NULL CHECK (school_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- A withheld caller ID is NULL (incoming only).
  remote_e164 text CHECK (remote_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  person_id uuid REFERENCES hon.people(id) ON DELETE RESTRICT,
  staff_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  provider_call_sid text UNIQUE CHECK (provider_call_sid ~ '^CA[0-9a-f]{32}$'),
  idempotency_key text CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  connect_by timestamptz,
  recorded boolean NOT NULL DEFAULT false,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds BETWEEN 0 AND 86400),
  voicemail boolean NOT NULL DEFAULT false,
  recording_sid text UNIQUE CHECK (recording_sid ~ '^RE[0-9a-f]{32}$'),
  recording_seconds integer CHECK (recording_seconds BETWEEN 0 AND 86400),
  recording_status text NOT NULL DEFAULT 'NONE' CHECK (recording_status IN ('NONE','AVAILABLE','DELETED')),
  heard_at timestamptz,
  outcome text CHECK (outcome IN ('TRIAL_BOOKED','CALL_BACK','INTERESTED','NOT_INTERESTED','LEFT_VOICEMAIL','WRONG_NUMBER','OTHER')),
  note text CHECK (length(note) BETWEEN 1 AND 1000 AND note !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (school_id, staff_principal_id, idempotency_key),
  CONSTRAINT school_calls_out_shape CHECK (direction='IN' OR (staff_principal_id IS NOT NULL AND idempotency_key IS NOT NULL
    AND remote_e164 IS NOT NULL AND connect_by IS NOT NULL)),
  CONSTRAINT school_calls_in_shape CHECK (direction='OUT' OR (provider_call_sid IS NOT NULL AND idempotency_key IS NULL AND connect_by IS NULL)),
  CONSTRAINT school_calls_sid_after_start CHECK (status IN ('INITIATED','EXPIRED') OR provider_call_sid IS NOT NULL),
  CONSTRAINT school_calls_recording CHECK ((recording_status='NONE') = (recording_sid IS NULL)),
  CONSTRAINT school_calls_voicemail CHECK (NOT voicemail OR (direction='IN' AND status='VOICEMAIL'))
);
CREATE INDEX school_calls_log_idx ON hon.school_calls (organization_id, school_id, created_at DESC, id DESC);
CREATE INDEX school_calls_person_idx ON hon.school_calls (school_id, person_id, created_at DESC) WHERE person_id IS NOT NULL;
CREATE INDEX school_calls_staff_hour_idx ON hon.school_calls (school_id, staff_principal_id, created_at DESC) WHERE direction='OUT';
CREATE INDEX school_calls_recording_due_idx ON hon.school_calls (created_at) WHERE recording_status='AVAILABLE';

CREATE TABLE hon.school_do_not_call (
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  set_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, phone_e164),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

-- Status order: a call moves forward only. Ended calls keep their status; a missed call may still get its voicemail.
CREATE FUNCTION hon.school_call_rank(p_status text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_status WHEN 'INITIATED' THEN 0 WHEN 'RINGING' THEN 1 WHEN 'IN_PROGRESS' THEN 2 ELSE 3 END
$$;

-- A call keeps its school, direction, numbers, starter, key and creation time; its provider SID is set once; its status
-- only moves forward (MISSED -> VOICEMAIL is the one move between ended states); a recording only goes AVAILABLE ->
-- DELETED; every change bumps the version. Calls, settings history and do-not-call rows are never truncated.
CREATE FUNCTION hon.guard_school_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE'
    AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.direction,NEW.school_number_e164,NEW.remote_e164,NEW.idempotency_key,NEW.connect_by,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.direction,OLD.school_number_e164,OLD.remote_e164,OLD.idempotency_key,OLD.connect_by,OLD.created_at)
    AND (OLD.direction='IN' OR NEW.staff_principal_id IS NOT DISTINCT FROM OLD.staff_principal_id)
    AND (OLD.staff_principal_id IS NULL OR NEW.staff_principal_id IS NOT DISTINCT FROM OLD.staff_principal_id)
    AND (OLD.provider_call_sid IS NULL OR NEW.provider_call_sid IS NOT DISTINCT FROM OLD.provider_call_sid)
    AND NEW.version > OLD.version
    AND (NEW.status=OLD.status OR (hon.school_call_rank(OLD.status)<3 AND hon.school_call_rank(NEW.status)>hon.school_call_rank(OLD.status))
      OR (OLD.status='MISSED' AND NEW.status='VOICEMAIL'))
    AND (NEW.recording_status=OLD.recording_status OR ROW(OLD.recording_status,NEW.recording_status) IN (ROW('NONE','AVAILABLE'),ROW('AVAILABLE','DELETED')))
    AND (OLD.recording_sid IS NULL OR NEW.recording_sid IS NOT DISTINCT FROM OLD.recording_sid)
    AND (NEW.recorded=OLD.recorded OR OLD.status IN ('INITIATED','RINGING')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SCHOOL_CALL_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_calls FOR EACH ROW EXECUTE FUNCTION hon.guard_school_call();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_calls FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_call();
CREATE FUNCTION hon.guard_school_calling_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.school_id,NEW.organization_id,NEW.created_at) IS NOT DISTINCT FROM (OLD.school_id,OLD.organization_id,OLD.created_at)
    AND NEW.version > OLD.version THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SCHOOL_CALLING_SETTINGS_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_calling_settings FOR EACH ROW EXECUTE FUNCTION hon.guard_school_calling_settings();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_calling_settings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_calling_settings();
CREATE FUNCTION hon.guard_school_call_staff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.school_id,NEW.organization_id,NEW.principal_id) IS NOT DISTINCT FROM (OLD.school_id,OLD.organization_id,OLD.principal_id)
    AND NEW.version > OLD.version THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SCHOOL_CALL_STAFF_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_call_staff FOR EACH ROW EXECUTE FUNCTION hon.guard_school_call_staff();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_call_staff FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_call_staff();
-- Do-not-call rows are added and removed one at a time by set_school_do_not_call; never changed in place or truncated.
CREATE FUNCTION hon.guard_school_do_not_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'SCHOOL_DO_NOT_CALL_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_do_not_call FOR EACH ROW EXECUTE FUNCTION hon.guard_school_do_not_call();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_do_not_call FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_do_not_call();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_calling_settings','school_call_staff','school_calls','school_do_not_call'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON hon.%I USING (organization_id=hon.current_organization_id() AND school_id=hon.current_school_id())'
      ' WITH CHECK (organization_id=hon.current_organization_id() AND school_id=hon.current_school_id())',t||'_tenant_isolation',t);
  END LOOP;
END $$;

-- The signed-in direct human at the session school with communication.call.use (p_manage false) or .manage (true).
CREATE FUNCTION hon.require_school_call_actor(subject text, p_manage boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL OR p_manage IS NULL THEN RAISE EXCEPTION 'CALLING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
  IF NOT hon.conversation_staff_has(actor,org,school,CASE WHEN p_manage THEN 'communication.call.manage' ELSE 'communication.call.use' END) THEN
    RAISE EXCEPTION 'CALLING_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- The browser phone identity of a staff member (Twilio client identity): 'u' and the principal id without dashes.
CREATE FUNCTION hon.school_call_identity(p_principal uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 'u'||replace(p_principal::text,'-','') $$;

-- A dialable number: North American (+1, area code and exchange 2-9), not 900 numbers or 976 exchanges, not N11.
CREATE FUNCTION hon.school_call_number_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p IS NOT NULL AND p ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' AND substr(p,6,3)<>'976'
    AND substr(p,4,2)<>'11' AND substr(p,7,2)<>'11' AND substr(p,4,1)<>'9'
    AND substr(p,3,3)<>ALL(ARRAY[
      -- premium, personal, carrier and government NANP codes
      '900','456','500','521','522','523','524','525','526','527','528','529','530','531','532','533','544','566','577','588',
      '600','622','700','710',
      -- NANP countries and territories outside the US states and Canada, billed as international or high-cost destinations
      '242','246','264','268','284','340','345','441','473','649','658','664','670','671','684','721','758','767','784',
      '787','809','829','849','868','869','876','939'])
$$;

-- The one person of the school with this phone, or NULL when none or several.
CREATE FUNCTION hon.school_call_person(p_org uuid, p_school uuid, p_phone text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN count(*)=1 THEN min(p.id::text)::uuid END FROM hon.people p
  WHERE p_phone IS NOT NULL AND p.organization_id=p_org AND p.school_id=p_school AND p.phone_e164=p_phone
$$;

-- A verified provider event for a call of this school came from that school's own Twilio account: its ACTIVE or SUSPENDED
-- subaccount, or (p_account_sid NULL) HON's parent account only when the school's sender is on the parent account.
CREATE FUNCTION hon.school_call_account_ok(p_school uuid, p_account_sid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN p_account_sid IS NULL THEN EXISTS(SELECT 1 FROM hon.school_text_senders s WHERE s.school_id=p_school AND s.twilio_account_sid IS NULL)
    ELSE EXISTS(SELECT 1 FROM hon.school_twilio_accounts a WHERE a.school_id=p_school AND a.account_sid=p_account_sid AND a.status IN ('ACTIVE','SUSPENDED')) END
$$;

-- Outgoing calls that never connected become EXPIRED (on the next start; reads show them EXPIRED already).
CREATE FUNCTION hon.expire_school_calls(p_school uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  UPDATE hon.school_calls SET status='EXPIRED', version=version+1, updated_at=clock_timestamp()
  WHERE school_id=p_school AND status='INITIATED' AND connect_by<=clock_timestamp()
$$;

CREATE FUNCTION hon.school_call_json(c hon.school_calls) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('callId',c.id,'direction',c.direction,
    'status',CASE WHEN c.status='INITIATED' AND c.connect_by<=clock_timestamp() THEN 'EXPIRED' ELSE c.status END,'remoteE164',c.remote_e164,'personId',c.person_id,
    'contactName',(SELECT nullif(btrim(coalesce(p.given_name,'')||' '||coalesce(p.family_name,'')),'') FROM hon.people p WHERE p.id=c.person_id),
    'staffName',(SELECT p.display_name FROM hon.principals p WHERE p.id=c.staff_principal_id),
    'startedAt',hon.conversation_time(c.created_at),'answeredAt',hon.conversation_time(c.answered_at),'endedAt',hon.conversation_time(c.ended_at),
    'durationSeconds',c.duration_seconds,'recorded',c.recorded,'voicemail',c.voicemail,'recordingAvailable',c.recording_status='AVAILABLE',
    'recordingSeconds',CASE WHEN c.recording_status='AVAILABLE' THEN c.recording_seconds END,
    'heard',c.heard_at IS NOT NULL,'outcome',c.outcome,'note',c.note,
    'doNotCall',EXISTS(SELECT 1 FROM hon.school_do_not_call d WHERE d.school_id=c.school_id AND d.phone_e164=c.remote_e164),'version',c.version)
$$;

CREATE FUNCTION hon.school_call_audit(c hon.school_calls, actor uuid, src text, action text, prior jsonb, event text, request uuid, correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r uuid:=coalesce(request,gen_random_uuid());
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(c.organization_id,c.school_id,actor,src,action,'SCHOOL_CALL',c.id,prior,
      jsonb_build_object('direction',c.direction,'status',c.status,'voicemail',c.voicemail,'recording',c.recording_status,'outcome',c.outcome,'version',c.version),
      'SUCCEEDED',r,coalesce(correlation,r));
  IF event IS NOT NULL THEN
    INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(c.organization_id,c.school_id,event,1,'SCHOOL_CALL',c.id,c.version,coalesce(correlation,r),r,
        jsonb_build_object('callId',c.id,'direction',c.direction,'status',c.status,'personId',c.person_id,'voicemail',c.voicemail));
  END IF;
END $$;

-- K1/K2 the Calls page header: settings, the caller's own Ring me, whether calling can work now, counts; for managers
-- the staff who can take calls and whether each rings.
CREATE FUNCTION hon.read_school_calling(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s hon.school_calling_settings;
  manage boolean; sender hon.school_text_senders; result jsonb;
BEGIN
  actor:=hon.require_school_call_actor(subject,false);
  manage:=hon.conversation_staff_has(actor,org,school,'communication.call.manage');
  SELECT * INTO s FROM hon.school_calling_settings x WHERE x.school_id=school;
  SELECT * INTO sender FROM hon.school_text_senders x WHERE x.school_id=school;
  result:=jsonb_build_object(
    'callingOn',coalesce(s.calling_on,false),'voicemailGreeting',s.voicemail_greeting,'recordingOn',coalesce(s.recording_on,false),
    'recordingConsentAt',hon.conversation_time(s.recording_consent_at),'version',coalesce(s.version,0),
    'schoolNumber',CASE WHEN sender.status='ACTIVE' THEN sender.phone_e164 END,'numberReady',coalesce(sender.status='ACTIVE',false),
    'forwardingPhoneSet',sender.forward_phone_e164 IS NOT NULL,'missedCallTextBack',coalesce(sender.missed_call_text_back,false),
    'ringMe',coalesce((SELECT k.ring_me FROM hon.school_call_staff k WHERE k.school_id=school AND k.principal_id=actor),false),
    'canManage',manage,
    'unheardVoicemails',(SELECT count(*) FROM hon.school_calls c WHERE c.organization_id=org AND c.school_id=school AND c.voicemail
      AND c.heard_at IS NULL AND c.recording_status='AVAILABLE'),
    'missedToday',(SELECT count(*) FROM hon.school_calls c JOIN hon.schools sc ON sc.id=c.school_id WHERE c.organization_id=org AND c.school_id=school
      AND c.direction='IN' AND c.status IN ('MISSED','VOICEMAIL','NO_ANSWER','BUSY','CANCELED')
      AND (c.created_at AT TIME ZONE sc.timezone)::date=(clock_timestamp() AT TIME ZONE sc.timezone)::date),
    'staff',CASE WHEN manage THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('principalId',x.pid,'name',p.display_name,
        'ringMe',coalesce((SELECT k.ring_me FROM hon.school_call_staff k WHERE k.school_id=school AND k.principal_id=x.pid),false)) ORDER BY p.display_name, x.pid),'[]')
      FROM (SELECT DISTINCT g.principal_id pid FROM hon.principal_role_grants g WHERE g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL) x
      JOIN hon.principals p ON p.id=x.pid WHERE hon.conversation_staff_has(x.pid,org,school,'communication.call.use')) END);
  IF hon.require_school_call_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CALLING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- K2 calling settings. p: {callingOn, voicemailGreeting (string or null), recordingOn, recordingConsentAccepted, expectedVersion}.
-- expectedVersion 0 creates the row. Switching recording on needs recordingConsentAccepted true.
CREATE FUNCTION hon.set_school_calling_settings(subject text, p jsonb, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s hon.school_calling_settings; n hon.school_calling_settings;
  v_greeting text; v_rec boolean; v_on boolean; prior jsonb;
BEGIN
  IF jsonb_typeof(p)<>'object' OR NOT p ?& ARRAY['callingOn','voicemailGreeting','recordingOn','recordingConsentAccepted','expectedVersion']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(ARRAY['callingOn','voicemailGreeting','recordingOn','recordingConsentAccepted','expectedVersion']))
    OR jsonb_typeof(p->'callingOn')<>'boolean' OR jsonb_typeof(p->'recordingOn')<>'boolean' OR jsonb_typeof(p->'recordingConsentAccepted')<>'boolean'
    OR jsonb_typeof(p->'voicemailGreeting') NOT IN ('string','null')
    OR (jsonb_typeof(p->'voicemailGreeting')='string' AND (length(p->>'voicemailGreeting') NOT BETWEEN 1 AND 300 OR btrim(p->>'voicemailGreeting')<>p->>'voicemailGreeting'
      OR p->>'voicemailGreeting' ~ '[[:cntrl:]<>]'))
    OR jsonb_typeof(p->'expectedVersion')<>'number' OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_school_call_actor(subject,true);
  v_on:=(p->>'callingOn')::boolean; v_rec:=(p->>'recordingOn')::boolean; v_greeting:=p->>'voicemailGreeting';
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_calling_settings:'||school::text,0));
  SELECT * INTO s FROM hon.school_calling_settings x WHERE x.school_id=school FOR UPDATE;
  IF coalesce(s.version,0)<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'CALLING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF v_rec AND NOT coalesce(s.recording_on,false) AND NOT (p->>'recordingConsentAccepted')::boolean THEN
    RAISE EXCEPTION 'RECORDING_CONSENT_REQUIRED' USING ERRCODE='22023';
  END IF;
  prior:=CASE WHEN s.school_id IS NULL THEN NULL ELSE jsonb_build_object('callingOn',s.calling_on,'recordingOn',s.recording_on,'greetingSet',s.voicemail_greeting IS NOT NULL,'version',s.version) END;
  IF s.school_id IS NULL THEN
    INSERT INTO hon.school_calling_settings(school_id,organization_id,calling_on,voicemail_greeting,recording_on,recording_consent_by,recording_consent_at,updated_by)
      VALUES(school,org,v_on,v_greeting,v_rec,CASE WHEN v_rec THEN actor END,CASE WHEN v_rec THEN clock_timestamp() END,actor) RETURNING * INTO n;
  ELSE
    UPDATE hon.school_calling_settings x SET calling_on=v_on,voicemail_greeting=v_greeting,recording_on=v_rec,
      recording_consent_by=CASE WHEN v_rec AND NOT x.recording_on THEN actor WHEN v_rec THEN x.recording_consent_by END,
      recording_consent_at=CASE WHEN v_rec AND NOT x.recording_on THEN clock_timestamp() WHEN v_rec THEN x.recording_consent_at END,
      updated_by=actor,version=x.version+1,updated_at=clock_timestamp() WHERE x.school_id=school RETURNING * INTO n;
  END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','communication.calling_settings.set','SCHOOL_CALLING_SETTINGS',school,prior,
      jsonb_build_object('callingOn',n.calling_on,'recordingOn',n.recording_on,'greetingSet',n.voicemail_greeting IS NOT NULL,
        'recordingConsentNew',v_rec AND NOT coalesce(s.recording_on,false),'version',n.version),'SUCCEEDED',coalesce(request,gen_random_uuid()),coalesce(correlation,request,gen_random_uuid()));
  IF hon.require_school_call_actor(subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CALLING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('callingOn',n.calling_on,'voicemailGreeting',n.voicemail_greeting,'recordingOn',n.recording_on,
    'recordingConsentAt',hon.conversation_time(n.recording_consent_at),'version',n.version);
END $$;

-- K1 the caller's own Ring me. p: {ringMe}.
CREATE FUNCTION hon.set_my_school_call_ringing(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); k hon.school_call_staff;
BEGIN
  IF jsonb_typeof(p)<>'object' OR (SELECT array_agg(x) FROM jsonb_object_keys(p) x) IS DISTINCT FROM ARRAY['ringMe'] OR jsonb_typeof(p->'ringMe')<>'boolean' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_school_call_actor(subject,false);
  INSERT INTO hon.school_call_staff(school_id,organization_id,principal_id,ring_me) VALUES(school,org,actor,(p->>'ringMe')::boolean)
    ON CONFLICT (school_id,principal_id) DO UPDATE SET ring_me=excluded.ring_me,version=hon.school_call_staff.version+1,updated_at=clock_timestamp()
    RETURNING * INTO k;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','communication.call_ringing.set','SCHOOL_CALL_STAFF',actor,NULL,jsonb_build_object('ringMe',k.ring_me,'version',k.version),
      'SUCCEEDED',gen_random_uuid(),gen_random_uuid());
  RETURN jsonb_build_object('ringMe',k.ring_me,'version',k.version);
END $$;

-- K1 start an outgoing call. p: {toE164, personId?}. The same key returns the same call; a key reused for another number
-- is refused. Returns the call; the browser connects with only its id, within two minutes.
CREATE FUNCTION hon.start_school_call(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); c hon.school_calls; sender hon.school_text_senders;
  v_to text; v_person uuid; v_person_phone text;
BEGIN
  IF jsonb_typeof(p)<>'object' OR NOT p ? 'toE164' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('toE164','personId'))
    OR jsonb_typeof(p->'toE164')<>'string' OR (p ? 'personId' AND NOT hon.conversation_uuid_ok(p->'personId'))
    OR key IS NULL OR key !~ '^[A-Za-z0-9._:-]{8,128}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  v_to:=p->>'toE164';
  IF NOT hon.school_call_number_ok(v_to) THEN RAISE EXCEPTION 'CALL_NUMBER_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_call_actor(subject,false);
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_calls.out:'||school::text||':'||actor::text,0));
  SELECT * INTO c FROM hon.school_calls x WHERE x.school_id=school AND x.staff_principal_id=actor AND x.idempotency_key=key;
  IF FOUND THEN
    IF c.remote_e164<>v_to OR c.person_id IS DISTINCT FROM coalesce((p->>'personId')::uuid,c.person_id) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN hon.school_call_json(c)||jsonb_build_object('connectBy',hon.conversation_time(c.connect_by),'replayed',true);
  END IF;
  PERFORM hon.expire_school_calls(school);
  IF NOT EXISTS(SELECT 1 FROM hon.school_calling_settings s WHERE s.school_id=school AND s.calling_on) THEN
    RAISE EXCEPTION 'CALLING_OFF' USING ERRCODE='55000'; END IF;
  SELECT * INTO sender FROM hon.school_text_senders x WHERE x.school_id=school AND x.status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'CALL_NUMBER_NOT_READY' USING ERRCODE='55000'; END IF;
  IF v_to=sender.phone_e164 OR v_to=sender.forward_phone_e164 THEN RAISE EXCEPTION 'CALL_NUMBER_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM hon.school_do_not_call d WHERE d.school_id=school AND d.phone_e164=v_to) THEN
    RAISE EXCEPTION 'CALL_DO_NOT_CALL' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM hon.school_calls x WHERE x.school_id=school AND x.staff_principal_id=actor AND x.direction='OUT'
      AND x.created_at>clock_timestamp()-interval '1 hour')>=60 THEN RAISE EXCEPTION 'CALL_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  IF p ? 'personId' THEN
    SELECT pe.id, pe.phone_e164 INTO v_person, v_person_phone FROM hon.people pe
      WHERE pe.id=(p->>'personId')::uuid AND pe.organization_id=org AND pe.school_id=school;
    IF v_person IS NULL THEN RAISE EXCEPTION 'CALL_PERSON_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF v_person_phone IS DISTINCT FROM v_to THEN RAISE EXCEPTION 'CALL_PERSON_PHONE_MISMATCH' USING ERRCODE='22023'; END IF;
  ELSE v_person:=hon.school_call_person(org,school,v_to); END IF;
  INSERT INTO hon.school_calls(organization_id,school_id,direction,status,school_number_e164,remote_e164,person_id,staff_principal_id,idempotency_key,connect_by)
    VALUES(org,school,'OUT','INITIATED',sender.phone_e164,v_to,v_person,actor,key,clock_timestamp()+interval '2 minutes') RETURNING * INTO c;
  PERFORM hon.school_call_audit(c,actor,'HUMAN_UI','communication.call.start',NULL,NULL,request,correlation);
  IF hon.require_school_call_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CALLING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.school_call_json(c)||jsonb_build_object('connectBy',hon.conversation_time(c.connect_by),'replayed',false);
END $$;

-- K1 call log (read only). p: optional filter ALL|MISSED|VOICEMAIL|OUTGOING (default ALL), personId, before {at, id}. 50 rows, newest first.
CREATE FUNCTION hon.read_school_calls(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); v_filter text; v_person uuid; v_at timestamptz; v_id uuid;
  rows jsonb; n integer; result jsonb;
BEGIN
  IF jsonb_typeof(p)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('filter','personId','before'))
    OR (p ? 'filter' AND (jsonb_typeof(p->'filter')<>'string' OR p->>'filter' NOT IN ('ALL','MISSED','VOICEMAIL','OUTGOING')))
    OR (p ? 'personId' AND NOT hon.conversation_uuid_ok(p->'personId'))
    OR (p ? 'before' AND (jsonb_typeof(p->'before')<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p->'before') k) IS DISTINCT FROM ARRAY['at','id']
      OR NOT hon.conversation_uuid_ok(p->'before'->'id') OR jsonb_typeof(p->'before'->'at')<>'string'
      OR p->'before'->>'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_school_call_actor(subject,false);
  v_filter:=coalesce(p->>'filter','ALL'); v_person:=(p->>'personId')::uuid; v_at:=(p->'before'->>'at')::timestamptz; v_id:=(p->'before'->>'id')::uuid;
  SELECT coalesce(jsonb_agg(hon.school_call_json(x) ORDER BY x.created_at DESC, x.id DESC),'[]'), count(*) INTO rows, n FROM (
    SELECT c.* FROM hon.school_calls c WHERE c.organization_id=org AND c.school_id=school
      AND (v_filter='ALL' OR (v_filter='OUTGOING' AND c.direction='OUT') OR (v_filter='VOICEMAIL' AND c.voicemail)
        OR (v_filter='MISSED' AND c.direction='IN' AND c.status IN ('MISSED','VOICEMAIL','NO_ANSWER','BUSY','CANCELED')))
      AND (v_person IS NULL OR c.person_id=v_person)
      AND (v_at IS NULL OR (date_trunc('milliseconds',c.created_at),c.id)<(v_at,v_id))
    ORDER BY c.created_at DESC, c.id DESC LIMIT 50) x;
  result:=jsonb_build_object('calls',rows,'nextCursor',CASE WHEN n=50 THEN jsonb_build_object('at',rows->49->>'startedAt','id',rows->49->>'callId') END);
  IF hon.require_school_call_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CALLING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- K1 after-call card and voicemail: p {callId, expectedVersion, outcome?, note?, heard?}; outcome/note null clears them.
CREATE FUNCTION hon.update_school_call(subject text, p jsonb, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.school_calls; prior jsonb;
BEGIN
  IF jsonb_typeof(p)<>'object' OR NOT p ?& ARRAY['callId','expectedVersion'] OR NOT (p ? 'outcome' OR p ? 'note' OR p ? 'heard')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('callId','expectedVersion','outcome','note','heard'))
    OR NOT hon.conversation_uuid_ok(p->'callId') OR jsonb_typeof(p->'expectedVersion')<>'number' OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR (p ? 'outcome' AND jsonb_typeof(p->'outcome')<>'null' AND (jsonb_typeof(p->'outcome')<>'string'
      OR p->>'outcome' NOT IN ('TRIAL_BOOKED','CALL_BACK','INTERESTED','NOT_INTERESTED','LEFT_VOICEMAIL','WRONG_NUMBER','OTHER')))
    OR (p ? 'note' AND jsonb_typeof(p->'note')<>'null' AND (jsonb_typeof(p->'note')<>'string' OR length(p->>'note') NOT BETWEEN 1 AND 1000
      OR btrim(p->>'note')='' OR p->>'note' ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'))
    OR (p ? 'heard' AND p->'heard'<>'true'::jsonb) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_school_call_actor(subject,false);
  SELECT * INTO c FROM hon.school_calls x WHERE x.id=(p->>'callId')::uuid AND x.organization_id=hon.current_organization_id()
    AND x.school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CALL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'CALL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p ? 'heard' AND NOT c.voicemail THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  prior:=jsonb_build_object('outcome',c.outcome,'noteSet',c.note IS NOT NULL,'heard',c.heard_at IS NOT NULL,'version',c.version);
  UPDATE hon.school_calls x SET outcome=CASE WHEN p ? 'outcome' THEN p->>'outcome' ELSE x.outcome END,
    note=CASE WHEN p ? 'note' THEN p->>'note' ELSE x.note END,
    heard_at=CASE WHEN p ? 'heard' THEN coalesce(x.heard_at,clock_timestamp()) ELSE x.heard_at END,
    version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
  PERFORM hon.school_call_audit(c,actor,'HUMAN_UI','communication.call.update',prior,NULL,request,correlation);
  IF hon.require_school_call_actor(subject,false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CALLING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.school_call_json(c);
END $$;

-- K1 do-not-call. p {phoneE164, doNotCall}.
CREATE FUNCTION hon.set_school_do_not_call(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); v_phone text; v_on boolean; changed integer;
BEGIN
  IF jsonb_typeof(p)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['doNotCall','phoneE164']
    OR jsonb_typeof(p->'phoneE164')<>'string' OR p->>'phoneE164' !~ '^\+[1-9][0-9]{7,14}$' OR jsonb_typeof(p->'doNotCall')<>'boolean' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_school_call_actor(subject,false);
  v_phone:=p->>'phoneE164'; v_on:=(p->>'doNotCall')::boolean;
  IF v_on THEN
    INSERT INTO hon.school_do_not_call(school_id,organization_id,phone_e164,set_by) VALUES(school,org,v_phone,actor) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM hon.school_do_not_call d WHERE d.school_id=school AND d.phone_e164=v_phone;
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed>0 THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(org,school,actor,'HUMAN_UI','communication.do_not_call.set','SCHOOL_DO_NOT_CALL',school,NULL,jsonb_build_object('doNotCall',v_on),
        'SUCCEEDED',gen_random_uuid(),gen_random_uuid());
  END IF;
  RETURN jsonb_build_object('phoneE164',v_phone,'doNotCall',v_on);
END $$;

-- K1 open a recording or voicemail: the recording SID and the school subaccount (NULL = HON's parent account) for the
-- API to stream; every open is audited.
CREATE FUNCTION hon.open_school_call_recording(subject text, p_call uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.school_calls; v_account text;
BEGIN
  IF p_call IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_call_actor(subject,false);
  SELECT * INTO c FROM hon.school_calls x WHERE x.id=p_call AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND OR c.recording_status<>'AVAILABLE' THEN RAISE EXCEPTION 'CALL_RECORDING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT a.account_sid INTO v_account FROM hon.school_text_senders s JOIN hon.school_twilio_accounts a ON a.account_sid=s.twilio_account_sid AND a.school_id=s.school_id
    WHERE s.school_id=c.school_id AND a.status IN ('ACTIVE','SUSPENDED');
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(c.organization_id,c.school_id,actor,'HUMAN_UI','communication.call_recording.open','SCHOOL_CALL',c.id,NULL,
      jsonb_build_object('voicemail',c.voicemail),'SUCCEEDED',gen_random_uuid(),gen_random_uuid());
  RETURN jsonb_build_object('recordingSid',c.recording_sid,'accountSid',v_account,'seconds',c.recording_seconds);
END $$;

-- K3 worker: the browser's outgoing call reached HON's client-voice webhook (signature already checked against p_account_sid,
-- NULL for HON's parent account). Connects only the staff member who started it, on its school's subaccount, within two
-- minutes, once, while calling is on, the number ACTIVE and the starter still allowed to call.
CREATE FUNCTION hon.connect_school_client_call(p_call uuid, p_identity text, p_account_sid text, p_call_sid text)
RETURNS TABLE (outcome text, to_e164 text, caller_id_e164 text, recorded boolean, language text, school_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE c hon.school_calls; sender hon.school_text_senders; s hon.school_calling_settings; v_ok boolean;
BEGIN
  IF p_call IS NULL OR p_identity IS NULL OR p_identity !~ '^u[0-9a-f]{32}$' OR p_call_sid IS NULL OR p_call_sid !~ '^CA[0-9a-f]{32}$'
    OR (p_account_sid IS NOT NULL AND p_account_sid !~ '^AC[0-9a-f]{32}$') THEN
    RAISE EXCEPTION 'HON client call is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM hon.school_calls x WHERE x.id=p_call FOR UPDATE;
  IF NOT FOUND OR c.direction<>'OUT' THEN outcome:='REFUSED'; RETURN NEXT; RETURN; END IF;
  IF c.provider_call_sid=p_call_sid THEN
    IF p_identity<>hon.school_call_identity(c.staff_principal_id) OR NOT hon.school_call_account_ok(c.school_id,p_account_sid) THEN
      outcome:='REFUSED'; RETURN NEXT; RETURN; END IF;
    outcome:='REPLAYED'; to_e164:=c.remote_e164; caller_id_e164:=c.school_number_e164; recorded:=c.recorded;
    SELECT coalesce(l.language,'en'), sc.name INTO language, school_name FROM hon.schools sc LEFT JOIN hon.school_language_defaults l ON l.school_id=sc.id WHERE sc.id=c.school_id;
    RETURN NEXT; RETURN; END IF;
  SELECT * INTO sender FROM hon.school_text_senders x WHERE x.school_id=c.school_id AND x.status='ACTIVE' AND x.phone_e164=c.school_number_e164;
  SELECT * INTO s FROM hon.school_calling_settings x WHERE x.school_id=c.school_id;
  v_ok:=c.status='INITIATED' AND c.provider_call_sid IS NULL AND c.connect_by>clock_timestamp()
    AND hon.school_call_identity(c.staff_principal_id)=p_identity
    AND sender.id IS NOT NULL AND sender.twilio_account_sid IS NOT DISTINCT FROM p_account_sid
    AND (p_account_sid IS NULL OR EXISTS(SELECT 1 FROM hon.school_twilio_accounts a WHERE a.account_sid=p_account_sid AND a.school_id=c.school_id AND a.status='ACTIVE'))
    AND coalesce(s.calling_on,false)
    AND NOT EXISTS(SELECT 1 FROM hon.school_do_not_call d WHERE d.school_id=c.school_id AND d.phone_e164=c.remote_e164)
    AND hon.conversation_staff_has(c.staff_principal_id,c.organization_id,c.school_id,'communication.call.use');
  IF NOT v_ok THEN outcome:='REFUSED'; RETURN NEXT; RETURN; END IF;
  UPDATE hon.school_calls x SET status='RINGING',provider_call_sid=p_call_sid,recorded=coalesce(s.recording_on,false),version=x.version+1,updated_at=clock_timestamp()
    WHERE x.id=c.id RETURNING * INTO c;
  PERFORM hon.school_call_audit(c,'00000000-0000-4000-8000-00000000c547','INTEGRATION','communication.call.connect',NULL,NULL,NULL,NULL);
  outcome:='CONNECT'; to_e164:=c.remote_e164; caller_id_e164:=c.school_number_e164; recorded:=c.recorded;
  SELECT coalesce(l.language,'en'), sc.name INTO language, school_name FROM hon.schools sc LEFT JOIN hon.school_language_defaults l ON l.school_id=sc.id WHERE sc.id=c.school_id;
  RETURN NEXT;
END $$;

-- K3 worker: an incoming call to a school number (signature and subaccount already checked). With calling on at a live
-- school, records the call RINGING and returns who to ring (at most 10 staff with Ring me who may still take calls),
-- whether to record, the greeting and language. Otherwise OFF, and the 0249 forward / missed-call path applies.
CREATE FUNCTION hon.route_school_incoming_call(p_to_e164 text, p_from_e164 text, p_call_sid text)
RETURNS TABLE (outcome text, call_id uuid, identities text[], forward_phone_e164 text, recorded boolean, voicemail_greeting text,
  language text, school_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE sender hon.school_text_senders; s hon.school_calling_settings; c hon.school_calls;
BEGIN
  IF p_to_e164 IS NULL OR p_to_e164 !~ '^\+[1-9][0-9]{7,14}$' OR (p_from_e164 IS NOT NULL AND p_from_e164 !~ '^\+[1-9][0-9]{7,14}$')
    OR p_call_sid IS NULL OR p_call_sid !~ '^CA[0-9a-f]{32}$' THEN RAISE EXCEPTION 'HON incoming call is invalid.' USING ERRCODE='22023'; END IF;
  SELECT * INTO sender FROM hon.school_text_senders x WHERE x.phone_e164=p_to_e164 AND x.status='ACTIVE';
  IF NOT FOUND THEN outcome:='UNROUTED'; RETURN NEXT; RETURN; END IF;
  SELECT * INTO s FROM hon.school_calling_settings x WHERE x.school_id=sender.school_id;
  IF NOT coalesce(s.calling_on,false)
    OR NOT EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=sender.organization_id AND o.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools sc WHERE sc.id=sender.school_id AND sc.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=sender.organization_id AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    outcome:='OFF'; RETURN NEXT; RETURN;
  END IF;
  INSERT INTO hon.school_calls(organization_id,school_id,direction,status,school_number_e164,remote_e164,person_id,provider_call_sid,recorded)
    VALUES(sender.organization_id,sender.school_id,'IN','RINGING',p_to_e164,p_from_e164,hon.school_call_person(sender.organization_id,sender.school_id,p_from_e164),
      p_call_sid,s.recording_on)
    ON CONFLICT (provider_call_sid) DO NOTHING RETURNING * INTO c;
  IF c.id IS NULL THEN
    SELECT * INTO c FROM hon.school_calls x WHERE x.provider_call_sid=p_call_sid;
    IF c.school_id<>sender.school_id THEN outcome:='UNROUTED'; RETURN NEXT; RETURN; END IF;
    outcome:='REPLAYED';
  ELSE
    PERFORM hon.school_call_audit(c,'00000000-0000-4000-8000-00000000c547','INTEGRATION','communication.call.receive',NULL,NULL,NULL,NULL);
    outcome:='RING';
  END IF;
  call_id:=c.id; forward_phone_e164:=sender.forward_phone_e164; recorded:=c.recorded; voicemail_greeting:=s.voicemail_greeting;
  SELECT coalesce(array_agg(hon.school_call_identity(k.principal_id) ORDER BY k.updated_at, k.principal_id),ARRAY[]::text[]) INTO identities FROM (
    SELECT k.* FROM hon.school_call_staff k WHERE k.school_id=sender.school_id AND k.ring_me
      AND hon.conversation_staff_has(k.principal_id,sender.organization_id,sender.school_id,'communication.call.use')
    ORDER BY k.updated_at, k.principal_id LIMIT 10) k;
  SELECT coalesce(l.language,'en'), sc.name INTO language, school_name FROM hon.schools sc LEFT JOIN hon.school_language_defaults l ON l.school_id=sc.id WHERE sc.id=sender.school_id;
  RETURN NEXT;
END $$;

-- K3 worker: call progress for the call (parent call SID). p_status one of RINGING, IN_PROGRESS, COMPLETED, NO_ANSWER, BUSY,
-- FAILED, CANCELED, MISSED. p_answered_identity names the staff browser that answered an incoming call (it must be a staff
-- member of that school who may take calls). Older statuses are ignored, never written over a newer one.
CREATE FUNCTION hon.record_school_call_status(p_account_sid text, p_call_sid text, p_status text, p_answered_identity text, p_duration_seconds integer, p_occurred_at timestamptz)
RETURNS TABLE (outcome text, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE c hon.school_calls; v_staff uuid; v_event text;
BEGIN
  IF p_call_sid IS NULL OR p_call_sid !~ '^CA[0-9a-f]{32}$' OR (p_account_sid IS NOT NULL AND p_account_sid !~ '^AC[0-9a-f]{32}$')
    OR p_status IS NULL OR p_status NOT IN ('RINGING','IN_PROGRESS','COMPLETED','NO_ANSWER','BUSY','FAILED','CANCELED','MISSED')
    OR (p_answered_identity IS NOT NULL AND p_answered_identity !~ '^u[0-9a-f]{32}$')
    OR (p_duration_seconds IS NOT NULL AND p_duration_seconds NOT BETWEEN 0 AND 86400)
    OR p_occurred_at IS NULL OR p_occurred_at > now()+interval '10 minutes' OR p_occurred_at < now()-interval '7 days' THEN
    RAISE EXCEPTION 'HON call status is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM hon.school_calls x WHERE x.provider_call_sid=p_call_sid FOR UPDATE;
  IF NOT FOUND OR NOT hon.school_call_account_ok(c.school_id,p_account_sid) THEN outcome:='UNKNOWN_CALL'; RETURN NEXT; RETURN; END IF;
  IF p_answered_identity IS NOT NULL AND c.direction='IN' AND c.staff_principal_id IS NULL THEN
    SELECT k.principal_id INTO v_staff FROM hon.school_call_staff k WHERE k.school_id=c.school_id AND hon.school_call_identity(k.principal_id)=p_answered_identity
      AND hon.conversation_staff_has(k.principal_id,c.organization_id,c.school_id,'communication.call.use');
  END IF;
  IF hon.school_call_rank(p_status)<=hon.school_call_rank(c.status) AND NOT (v_staff IS NOT NULL AND p_status=c.status) THEN
    outcome:='IGNORED'; status:=c.status; RETURN NEXT; RETURN; END IF;
  IF c.direction='OUT' AND p_status='MISSED' THEN outcome:='IGNORED'; status:=c.status; RETURN NEXT; RETURN; END IF;
  UPDATE hon.school_calls x SET status=CASE WHEN hon.school_call_rank(p_status)>hon.school_call_rank(x.status) THEN p_status ELSE x.status END,
    staff_principal_id=coalesce(x.staff_principal_id,v_staff),
    answered_at=CASE WHEN p_status='IN_PROGRESS' THEN coalesce(x.answered_at,p_occurred_at) ELSE x.answered_at END,
    ended_at=CASE WHEN hon.school_call_rank(p_status)=3 THEN coalesce(x.ended_at,p_occurred_at) ELSE x.ended_at END,
    duration_seconds=coalesce(p_duration_seconds,x.duration_seconds),version=x.version+1,updated_at=clock_timestamp()
    WHERE x.id=c.id RETURNING * INTO c;
  v_event:=CASE WHEN c.status='COMPLETED' THEN 'communication.call.completed'
    WHEN c.direction='IN' AND c.status IN ('MISSED','NO_ANSWER','BUSY','CANCELED') THEN 'communication.call.missed' END;
  PERFORM hon.school_call_audit(c,'00000000-0000-4000-8000-00000000c547','INTEGRATION','communication.call.status',NULL,v_event,NULL,NULL);
  outcome:='RECORDED'; status:=c.status; RETURN NEXT;
END $$;

-- K3 worker: a finished recording for the call. A voicemail turns a missed incoming call into VOICEMAIL; otherwise it is the
-- call's own recording, only when the call was set to be recorded.
CREATE FUNCTION hon.record_school_call_recording(p_account_sid text, p_call_sid text, p_recording_sid text, p_seconds integer, p_voicemail boolean)
RETURNS TABLE (outcome text, call_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE c hon.school_calls;
BEGIN
  IF p_call_sid IS NULL OR p_call_sid !~ '^CA[0-9a-f]{32}$' OR p_recording_sid IS NULL OR p_recording_sid !~ '^RE[0-9a-f]{32}$'
    OR p_seconds IS NULL OR p_seconds NOT BETWEEN 0 AND 86400 OR p_voicemail IS NULL
    OR (p_account_sid IS NOT NULL AND p_account_sid !~ '^AC[0-9a-f]{32}$') THEN
    RAISE EXCEPTION 'HON call recording is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM hon.school_calls x WHERE x.provider_call_sid=p_call_sid FOR UPDATE;
  IF NOT FOUND OR NOT hon.school_call_account_ok(c.school_id,p_account_sid) THEN outcome:='UNKNOWN_CALL'; RETURN NEXT; RETURN; END IF;
  call_id:=c.id;
  IF c.recording_sid=p_recording_sid THEN outcome:='REPLAYED'; RETURN NEXT; RETURN; END IF;
  IF c.recording_sid IS NOT NULL OR (p_voicemail AND (c.direction<>'IN' OR c.status NOT IN ('RINGING','MISSED')))
    OR (NOT p_voicemail AND NOT c.recorded) THEN outcome:='REFUSED'; RETURN NEXT; RETURN; END IF;
  IF p_voicemail THEN
    -- A missed call's voicemail: the call ends as VOICEMAIL (from RINGING it first passes MISSED for the event).
    IF c.status='RINGING' THEN
      UPDATE hon.school_calls x SET status='MISSED',ended_at=coalesce(x.ended_at,clock_timestamp()),version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
      PERFORM hon.school_call_audit(c,'00000000-0000-4000-8000-00000000c547','INTEGRATION','communication.call.status',NULL,'communication.call.missed',NULL,NULL);
    END IF;
    UPDATE hon.school_calls x SET status='VOICEMAIL',voicemail=true,recording_sid=p_recording_sid,recording_seconds=p_seconds,recording_status='AVAILABLE',
      version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
    PERFORM hon.school_call_audit(c,'00000000-0000-4000-8000-00000000c547','INTEGRATION','communication.voicemail.receive',NULL,'communication.voicemail.received',NULL,NULL);
  ELSE
    UPDATE hon.school_calls x SET recording_sid=p_recording_sid,recording_seconds=p_seconds,recording_status='AVAILABLE',
      version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
    PERFORM hon.school_call_audit(c,'00000000-0000-4000-8000-00000000c547','INTEGRATION','communication.call_recording.receive',NULL,NULL,NULL,NULL);
  END IF;
  outcome:='RECORDED'; RETURN NEXT;
END $$;

-- K3 worker: recordings older than 90 days, with their school subaccount (NULL = parent), for deletion at Twilio.
CREATE FUNCTION hon.read_school_call_recordings_due(p_limit integer)
RETURNS TABLE (call_id uuid, recording_sid text, account_sid text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'HON recording limit is invalid.' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT c.id, c.recording_sid, (SELECT a.account_sid FROM hon.school_text_senders s JOIN hon.school_twilio_accounts a
      ON a.account_sid=s.twilio_account_sid AND a.school_id=s.school_id WHERE s.school_id=c.school_id)
    FROM hon.school_calls c WHERE c.recording_status='AVAILABLE' AND c.created_at<clock_timestamp()-interval '90 days'
    ORDER BY c.created_at, c.id LIMIT p_limit;
END $$;

-- K3 worker: Twilio confirmed the recording is gone (or never existed).
CREATE FUNCTION hon.mark_school_call_recording_deleted(p_call uuid, p_recording_sid text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.school_calls;
BEGIN
  UPDATE hon.school_calls x SET recording_status='DELETED',version=x.version+1,updated_at=clock_timestamp()
    WHERE x.id=p_call AND x.recording_sid=p_recording_sid AND x.recording_status='AVAILABLE' AND x.created_at<clock_timestamp()-interval '90 days'
    RETURNING * INTO c;
  IF c.id IS NULL THEN RETURN false; END IF;
  PERFORM hon.school_call_audit(c,'00000000-0000-4000-8000-00000000c547','INTEGRATION','communication.call_recording.delete',NULL,NULL,NULL,NULL);
  RETURN true;
END $$;

-- Grants: staff entry points to the runtime, provider entry points to the communication worker, everything else owner-only.
DO $$ DECLARE r text; f text; t text;
  staff text[]:=ARRAY['hon.read_school_calling(text)','hon.set_school_calling_settings(text,jsonb,uuid,uuid)','hon.set_my_school_call_ringing(text,jsonb)',
    'hon.start_school_call(text,jsonb,text,uuid,uuid)','hon.read_school_calls(text,jsonb)','hon.update_school_call(text,jsonb,uuid,uuid)',
    'hon.set_school_do_not_call(text,jsonb)','hon.open_school_call_recording(text,uuid)'];
  worker text[]:=ARRAY['hon.connect_school_client_call(uuid,text,text,text)','hon.route_school_incoming_call(text,text,text)',
    'hon.record_school_call_status(text,text,text,text,integer,timestamptz)','hon.record_school_call_recording(text,text,text,integer,boolean)',
    'hon.read_school_call_recordings_due(integer)','hon.mark_school_call_recording_deleted(uuid,text)'];
  private text[]:=ARRAY['hon.school_call_rank(text)','hon.guard_school_call()','hon.guard_school_calling_settings()','hon.guard_school_call_staff()','hon.guard_school_do_not_call()','hon.require_school_call_actor(text,boolean)',
    'hon.school_call_identity(uuid)','hon.school_call_number_ok(text)','hon.school_call_person(uuid,uuid,text)','hon.school_call_account_ok(uuid,text)','hon.expire_school_calls(uuid)',
    'hon.school_call_json(hon.school_calls)','hon.school_call_audit(hon.school_calls,uuid,text,text,jsonb,text,uuid,uuid)'];
BEGIN
  FOREACH f IN ARRAY staff||worker||private LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['school_calling_settings','school_call_staff','school_calls','school_do_not_call'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY staff LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    FOREACH f IN ARRAY worker LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_communication_worker',f); END LOOP;
  END IF;
END $$;
COMMIT;
