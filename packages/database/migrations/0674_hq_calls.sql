BEGIN;
-- 0674 HQ calling, piece CL5 (allocated by the coordinator 2026-11-19; docs/architecture/SCHOOL_CALLING.md §10).
-- HON HQ calls and takes calls on the HQ texting number (the ACTIVE 0281 SMS sender's reply number, on HON's parent
-- Twilio account): the HQ call log, voicemail, HQ calling settings, which HQ people ring for incoming calls, the HQ
-- do-not-call list and the HQ browser phone's voice app. This migration places no call and talks to no provider: the API
-- reaches Twilio only behind HON_VOICE_CALLS_APPROVED, and minutes are paid by HON like HQ texting.
--   H1 HQ people with an HQ messaging purpose (0281 hq_communication_purposes: HQ owner, or HQ operator/support with
--      hq.support.manage, hq.billing.manage or hq.onboarding.manage) read the HQ call log and voicemail, set their own
--      "Ring me", start an outgoing call (+1 numbers only, same toll-fraud list as schools, not the HQ number, not on the HQ
--      do-not-call list, 60 an hour each), record an outcome and note, mark a voicemail heard, set do-not-call and play a
--      voicemail (each play is kept as evidence).
--   H2 Only the HQ owner switches HQ calling on or off and sets the voicemail greeting. HQ calls are not recorded in v1:
--      only voicemail is kept, for 90 days.
--   H3 The communication worker login connects an outgoing HQ browser call only for the HQ person who started it, within
--      two minutes, once; routes an incoming call to the HQ number to HQ people with Ring me; records progress and
--      voicemail. Status never moves backwards. Every provider entry point accepts only HON's parent account.
--   H4 Calls are never deleted. HQ rows carry no school, so they live outside tenant RLS: forced RLS with no policy, no
--      table privilege for any login, SECURITY DEFINER entry points only; evidence rows carry ids and states only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker')) THEN
    RAISE EXCEPTION 'HQ calls require a trusted migration owner';
  END IF;
  IF to_regclass('hon.hq_communication_senders') IS NULL OR to_regclass('hon.hq_contact_phones') IS NULL
    OR to_regprocedure('hon.require_hq_communication_actor(text,text)') IS NULL OR to_regprocedure('hon.school_call_number_ok(text)') IS NULL
    OR to_regclass('hon.school_voice_apps') IS NULL THEN
    RAISE EXCEPTION 'HQ calls require 0281, 0282, 0556 and 0673';
  END IF;
END $$;

-- The fixed actor for HQ calling provider evidence. No grants, roles or human user ever belong to it.
INSERT INTO hon.principals (id, principal_type, user_id, display_name, is_active)
VALUES ('00000000-0000-4000-8000-00000000c562', 'INTEGRATION', NULL, 'HON HQ calling', true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE hon.hq_calling_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  calling_on boolean NOT NULL DEFAULT false,
  voicemail_greeting text CHECK (length(voicemail_greeting) BETWEEN 1 AND 300 AND voicemail_greeting !~ '[[:cntrl:]<>]'),
  updated_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hon.hq_call_staff (
  principal_id uuid PRIMARY KEY REFERENCES hon.principals(id) ON DELETE RESTRICT,
  ring_me boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hon.hq_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL CHECK (direction IN ('IN','OUT')),
  status text NOT NULL CHECK (status IN ('INITIATED','RINGING','IN_PROGRESS','COMPLETED','NO_ANSWER','BUSY','FAILED','CANCELED',
    'MISSED','VOICEMAIL','EXPIRED')),
  hq_number_e164 text NOT NULL CHECK (hq_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- A withheld caller ID is NULL (incoming only).
  remote_e164 text CHECK (remote_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- The person whose confirmed HQ contact phone (0282) is this number, when exactly one.
  contact_user_id uuid REFERENCES hon.users(id) ON DELETE RESTRICT,
  staff_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  provider_call_sid text UNIQUE CHECK (provider_call_sid ~ '^CA[0-9a-f]{32}$'),
  idempotency_key text CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  connect_by timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds BETWEEN 0 AND 86400),
  voicemail boolean NOT NULL DEFAULT false,
  recording_sid text UNIQUE CHECK (recording_sid ~ '^RE[0-9a-f]{32}$'),
  recording_seconds integer CHECK (recording_seconds BETWEEN 0 AND 86400),
  recording_status text NOT NULL DEFAULT 'NONE' CHECK (recording_status IN ('NONE','AVAILABLE','DELETED')),
  heard_at timestamptz,
  outcome text CHECK (outcome IN ('RESOLVED','CALL_BACK','FOLLOW_UP','LEFT_VOICEMAIL','WRONG_NUMBER','OTHER')),
  note text CHECK (length(note) BETWEEN 1 AND 1000 AND note !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_principal_id, idempotency_key),
  CONSTRAINT hq_calls_out_shape CHECK (direction='IN' OR (staff_principal_id IS NOT NULL AND idempotency_key IS NOT NULL
    AND remote_e164 IS NOT NULL AND connect_by IS NOT NULL)),
  CONSTRAINT hq_calls_in_shape CHECK (direction='OUT' OR (provider_call_sid IS NOT NULL AND idempotency_key IS NULL AND connect_by IS NULL)),
  CONSTRAINT hq_calls_sid_after_start CHECK (status IN ('INITIATED','EXPIRED') OR provider_call_sid IS NOT NULL),
  CONSTRAINT hq_calls_recording CHECK ((recording_status='NONE') = (recording_sid IS NULL)),
  -- Only voicemail is ever kept for HQ (H2).
  CONSTRAINT hq_calls_voicemail CHECK ((NOT voicemail OR (direction='IN' AND status='VOICEMAIL')) AND (recording_sid IS NULL OR voicemail))
);
CREATE INDEX hq_calls_log_idx ON hon.hq_calls (created_at DESC, id DESC);
CREATE INDEX hq_calls_contact_idx ON hon.hq_calls (contact_user_id, created_at DESC) WHERE contact_user_id IS NOT NULL;
CREATE INDEX hq_calls_staff_hour_idx ON hon.hq_calls (staff_principal_id, created_at DESC) WHERE direction='OUT';
CREATE INDEX hq_calls_recording_due_idx ON hon.hq_calls (created_at) WHERE recording_status='AVAILABLE';

CREATE TABLE hon.hq_do_not_call (
  phone_e164 text PRIMARY KEY CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  set_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The HQ browser phone's TwiML App and API key on HON's parent account (same shape and sealing as 0673).
CREATE TABLE hon.hq_voice_app (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  status text NOT NULL CHECK (status IN ('PENDING','ACTIVE','CLOSED')),
  twiml_app_sid text UNIQUE CHECK (twiml_app_sid ~ '^AP[0-9a-f]{32}$'),
  api_key_sid text UNIQUE CHECK (api_key_sid ~ '^SK[0-9a-f]{32}$'),
  sealed_api_secret text CHECK (sealed_api_secret ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$' AND length(sealed_api_secret) <= 1024),
  vault_key_id text CHECK (vault_key_id ~ '^[a-z0-9-]{1,40}$'),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_voice_app_shape CHECK (
    (status='PENDING' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND api_key_sid IS NULL AND sealed_api_secret IS NULL AND vault_key_id IS NULL)
    OR (status='ACTIVE' AND claim_token IS NULL AND claim_expires_at IS NULL AND twiml_app_sid IS NOT NULL AND api_key_sid IS NOT NULL
      AND sealed_api_secret IS NOT NULL AND vault_key_id IS NOT NULL)
    OR (status='CLOSED' AND claim_token IS NULL AND claim_expires_at IS NULL))
);

-- Append-only evidence for HQ calling (HQ actions carry no school, so they cannot use hon.audit_events).
CREATE TABLE hon.hq_call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES hon.hq_calls(id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('HUMAN_UI','INTEGRATION')),
  action_code text NOT NULL CHECK (action_code ~ '^hq\.call[a-z_.]*$'),
  state jsonb NOT NULL CHECK (jsonb_typeof(state)='object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hq_call_events_call_idx ON hon.hq_call_events (call_id, occurred_at) WHERE call_id IS NOT NULL;

-- Same rules as school calls: identity, direction, numbers, starter, key and creation time never change; the provider
-- SID is set once; status only moves forward (MISSED -> VOICEMAIL is the one move between ended states); a recording
-- only goes AVAILABLE -> DELETED; every change bumps the version.
CREATE FUNCTION hon.guard_hq_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE'
    AND (NEW.id,NEW.direction,NEW.hq_number_e164,NEW.remote_e164,NEW.idempotency_key,NEW.connect_by,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.direction,OLD.hq_number_e164,OLD.remote_e164,OLD.idempotency_key,OLD.connect_by,OLD.created_at)
    AND (OLD.staff_principal_id IS NULL OR NEW.staff_principal_id IS NOT DISTINCT FROM OLD.staff_principal_id)
    AND (OLD.direction='IN' OR NEW.contact_user_id IS NOT DISTINCT FROM OLD.contact_user_id)
    AND (OLD.provider_call_sid IS NULL OR NEW.provider_call_sid IS NOT DISTINCT FROM OLD.provider_call_sid)
    AND NEW.version > OLD.version
    AND (NEW.status=OLD.status OR (hon.school_call_rank(OLD.status)<3 AND hon.school_call_rank(NEW.status)>hon.school_call_rank(OLD.status))
      OR (OLD.status='MISSED' AND NEW.status='VOICEMAIL'))
    AND (NEW.recording_status=OLD.recording_status OR ROW(OLD.recording_status,NEW.recording_status) IN (ROW('NONE','AVAILABLE'),ROW('AVAILABLE','DELETED')))
    AND (OLD.recording_sid IS NULL OR NEW.recording_sid IS NOT DISTINCT FROM OLD.recording_sid) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_CALL_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_calls FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_call();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_calls FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_call();
-- Settings and Ring me change only by a version bump (Ring me keeps its person); an ACTIVE voice app's key changes only
-- by CLOSED first, and a recorded TwiML App never changes.
CREATE FUNCTION hon.guard_hq_calling_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.version > OLD.version AND to_jsonb(NEW)->'principal_id' IS NOT DISTINCT FROM to_jsonb(OLD)->'principal_id' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'HQ_CALLING_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE FUNCTION hon.guard_hq_voice_app() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.version > OLD.version AND NEW.created_at=OLD.created_at
    AND (OLD.status<>'ACTIVE' OR NEW.status='CLOSED' OR (NEW.twiml_app_sid,NEW.api_key_sid,NEW.sealed_api_secret,NEW.vault_key_id)
      IS NOT DISTINCT FROM (OLD.twiml_app_sid,OLD.api_key_sid,OLD.sealed_api_secret,OLD.vault_key_id))
    AND (OLD.twiml_app_sid IS NULL OR NEW.twiml_app_sid IS NOT DISTINCT FROM OLD.twiml_app_sid) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_CALLING_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE FUNCTION hon.guard_hq_call_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  -- Do-not-call rows may be removed one at a time (by set_hq_do_not_call); nothing else here is ever changed or removed.
  IF TG_OP='DELETE' AND TG_TABLE_NAME='hq_do_not_call' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'HQ_CALLING_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_calling_settings','hq_call_staff','hq_voice_app'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.%I()',t,
      CASE WHEN t='hq_voice_app' THEN 'guard_hq_voice_app' ELSE 'guard_hq_calling_row' END);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_call_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_do_not_call','hq_call_events'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_call_evidence()',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_call_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_calling_settings','hq_call_staff','hq_calls','hq_do_not_call','hq_voice_app','hq_call_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- ---------- helpers ----------
-- The HQ browser phone identity: 'h' and the principal id without dashes (school phones use 'u').
CREATE FUNCTION hon.hq_call_identity(p_principal uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 'h'||replace(p_principal::text,'-','') $$;

-- May this HQ principal use HQ calling now (any HQ messaging purpose)?
CREATE FUNCTION hon.hq_call_staff_ok(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT p_principal IS NOT NULL AND EXISTS(SELECT 1 FROM hon.principals p WHERE p.id=p_principal AND p.is_active AND p.principal_type='HUMAN_USER')
    AND cardinality(hon.hq_communication_purposes(p_principal))>0
$$;

-- The HQ number: the ACTIVE HQ SMS sender's public reply number, or NULL.
CREATE FUNCTION hon.hq_call_number() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT s.sms_reply_number FROM hon.hq_communication_senders s WHERE s.channel='SMS' AND s.status='ACTIVE'
$$;

-- The one person whose confirmed HQ contact phone is this number, or NULL.
CREATE FUNCTION hon.hq_call_contact(p_phone text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT ph.user_id FROM hon.hq_contact_phones ph WHERE p_phone IS NOT NULL AND ph.phone_e164=p_phone AND ph.status='CONFIRMED'
$$;

CREATE FUNCTION hon.expire_hq_calls() RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  UPDATE hon.hq_calls SET status='EXPIRED', version=version+1, updated_at=clock_timestamp()
  WHERE status='INITIATED' AND connect_by<=clock_timestamp()
$$;

CREATE FUNCTION hon.hq_call_json(c hon.hq_calls) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('callId',c.id,'direction',c.direction,
    'status',CASE WHEN c.status='INITIATED' AND c.connect_by<=clock_timestamp() THEN 'EXPIRED' ELSE c.status END,'remoteE164',c.remote_e164,
    'contactUserId',c.contact_user_id,
    'contactName',(SELECT left(nullif(btrim(u.display_name),''),120) FROM hon.users u WHERE u.id=c.contact_user_id),
    -- The schools this person currently owns (names only), so HQ knows who is calling.
    'contactSchools',CASE WHEN c.contact_user_id IS NULL THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(DISTINCT sc.name),'[]') FROM hon.principals p
      JOIN hon.principal_role_grants g ON g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
      JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id AND r.code='OWNER' AND r.is_system_role
      JOIN hon.schools sc ON sc.id=g.school_id
      WHERE p.user_id=c.contact_user_id AND p.is_active) END,
    'staffName',(SELECT p.display_name FROM hon.principals p WHERE p.id=c.staff_principal_id),
    'startedAt',hon.saas_ts(c.created_at),'answeredAt',hon.saas_ts(c.answered_at),'endedAt',hon.saas_ts(c.ended_at),
    'durationSeconds',c.duration_seconds,'voicemail',c.voicemail,'recordingAvailable',c.recording_status='AVAILABLE',
    'recordingSeconds',CASE WHEN c.recording_status='AVAILABLE' THEN c.recording_seconds END,
    'heard',c.heard_at IS NOT NULL,'outcome',c.outcome,'note',c.note,
    'doNotCall',EXISTS(SELECT 1 FROM hon.hq_do_not_call d WHERE d.phone_e164=c.remote_e164),'version',c.version)
$$;

CREATE FUNCTION hon.hq_call_evidence(p_call uuid, actor uuid, src text, action text, state jsonb) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  INSERT INTO hon.hq_call_events(call_id,actor_principal_id,source,action_code,state) VALUES(p_call,actor,src,action,state)
$$;
CREATE FUNCTION hon.hq_call_state(c hon.hq_calls) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('direction',c.direction,'status',c.status,'voicemail',c.voicemail,'recording',c.recording_status,'outcome',c.outcome,
    'noteSet',c.note IS NOT NULL,'heard',c.heard_at IS NOT NULL,'version',c.version)
$$;

-- ---------- HQ people (runtime) ----------
-- H1/H2 the HQ Calls page header.
CREATE FUNCTION hon.read_hq_calling(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; s hon.hq_calling_settings; owner boolean; v_number text; result jsonb;
BEGIN
  actor:=hon.require_hq_communication_actor(subject,NULL);
  owner:=hon.hq_communication_is_owner(actor);
  SELECT * INTO s FROM hon.hq_calling_settings;
  v_number:=hon.hq_call_number();
  result:=jsonb_build_object('callingOn',coalesce(s.calling_on,false),'voicemailGreeting',s.voicemail_greeting,'version',coalesce(s.version,0),
    'hqNumber',v_number,'numberReady',v_number IS NOT NULL,
    'ringMe',coalesce((SELECT k.ring_me FROM hon.hq_call_staff k WHERE k.principal_id=actor),false),'canManage',owner,
    'unheardVoicemails',(SELECT count(*) FROM hon.hq_calls c WHERE c.voicemail AND c.heard_at IS NULL AND c.recording_status='AVAILABLE'),
    'missedToday',(SELECT count(*) FROM hon.hq_calls c WHERE c.direction='IN' AND c.status IN ('MISSED','VOICEMAIL','NO_ANSWER','BUSY','CANCELED')
      AND c.created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'),
    'staff',CASE WHEN owner THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('principalId',x.pid,'name',p.display_name,
        'ringMe',coalesce((SELECT k.ring_me FROM hon.hq_call_staff k WHERE k.principal_id=x.pid),false)) ORDER BY p.display_name, x.pid),'[]')
      FROM (SELECT DISTINCT g.principal_id pid FROM hon.hq_operator_grants g WHERE g.effective_from<=clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) x
      JOIN hon.principals p ON p.id=x.pid WHERE hon.hq_call_staff_ok(x.pid)) END);
  IF hon.require_hq_communication_actor(subject,NULL) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- H2 HQ owner: p {callingOn, voicemailGreeting (string or null), expectedVersion}; expectedVersion 0 creates the row.
CREATE FUNCTION hon.set_hq_calling_settings(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; s hon.hq_calling_settings; n hon.hq_calling_settings;
BEGIN
  IF jsonb_typeof(p)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['callingOn','expectedVersion','voicemailGreeting']
    OR jsonb_typeof(p->'callingOn')<>'boolean' OR jsonb_typeof(p->'voicemailGreeting') NOT IN ('string','null')
    OR (jsonb_typeof(p->'voicemailGreeting')='string' AND (length(p->>'voicemailGreeting') NOT BETWEEN 1 AND 300 OR btrim(p->>'voicemailGreeting')<>p->>'voicemailGreeting'
      OR p->>'voicemailGreeting' ~ '[[:cntrl:]<>]'))
    OR jsonb_typeof(p->'expectedVersion')<>'number' OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_hq_communication_actor(subject,'OWNER');
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.hq_calling_settings',0));
  SELECT * INTO s FROM hon.hq_calling_settings FOR UPDATE;
  IF coalesce(s.version,0)<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'CALLING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF s.singleton IS NULL THEN
    INSERT INTO hon.hq_calling_settings(calling_on,voicemail_greeting,updated_by) VALUES((p->>'callingOn')::boolean,p->>'voicemailGreeting',actor) RETURNING * INTO n;
  ELSE
    UPDATE hon.hq_calling_settings x SET calling_on=(p->>'callingOn')::boolean,voicemail_greeting=p->>'voicemailGreeting',updated_by=actor,
      version=x.version+1,updated_at=clock_timestamp() RETURNING * INTO n;
  END IF;
  PERFORM hon.hq_call_evidence(NULL,actor,'HUMAN_UI','hq.call.settings.set',jsonb_build_object('callingOn',n.calling_on,'greetingSet',n.voicemail_greeting IS NOT NULL,
    'priorCallingOn',s.calling_on,'version',n.version));
  IF hon.require_hq_communication_actor(subject,'OWNER') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('callingOn',n.calling_on,'voicemailGreeting',n.voicemail_greeting,'version',n.version);
END $$;

-- H1 the caller's own Ring me. p {ringMe}.
CREATE FUNCTION hon.set_my_hq_call_ringing(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; k hon.hq_call_staff;
BEGIN
  IF jsonb_typeof(p)<>'object' OR (SELECT array_agg(x) FROM jsonb_object_keys(p) x) IS DISTINCT FROM ARRAY['ringMe'] OR jsonb_typeof(p->'ringMe')<>'boolean' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_hq_communication_actor(subject,NULL);
  INSERT INTO hon.hq_call_staff(principal_id,ring_me) VALUES(actor,(p->>'ringMe')::boolean)
    ON CONFLICT (principal_id) DO UPDATE SET ring_me=excluded.ring_me,version=hon.hq_call_staff.version+1,updated_at=clock_timestamp()
    RETURNING * INTO k;
  PERFORM hon.hq_call_evidence(NULL,actor,'HUMAN_UI','hq.call.ringing.set',jsonb_build_object('ringMe',k.ring_me,'version',k.version));
  RETURN jsonb_build_object('ringMe',k.ring_me,'version',k.version);
END $$;

-- H1 start an outgoing call. p {toE164, contactUserId?}. Same key, same call; a key reused for another number is refused.
CREATE FUNCTION hon.start_hq_call(subject text, p jsonb, key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.hq_calls; v_to text; v_contact uuid; v_number text;
BEGIN
  IF jsonb_typeof(p)<>'object' OR NOT p ? 'toE164' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('toE164','contactUserId'))
    OR jsonb_typeof(p->'toE164')<>'string' OR (p ? 'contactUserId' AND NOT hon.conversation_uuid_ok(p->'contactUserId'))
    OR key IS NULL OR key !~ '^[A-Za-z0-9._:-]{8,128}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  v_to:=p->>'toE164';
  IF NOT hon.school_call_number_ok(v_to) THEN RAISE EXCEPTION 'CALL_NUMBER_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_hq_communication_actor(subject,NULL);
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.hq_calls.out:'||actor::text,0));
  SELECT * INTO c FROM hon.hq_calls x WHERE x.staff_principal_id=actor AND x.idempotency_key=key;
  IF FOUND THEN
    IF c.remote_e164<>v_to OR c.contact_user_id IS DISTINCT FROM coalesce((p->>'contactUserId')::uuid,c.contact_user_id) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN hon.hq_call_json(c)||jsonb_build_object('connectBy',hon.saas_ts(c.connect_by),'replayed',true);
  END IF;
  PERFORM hon.expire_hq_calls();
  IF NOT coalesce((SELECT s.calling_on FROM hon.hq_calling_settings s),false) THEN RAISE EXCEPTION 'CALLING_OFF' USING ERRCODE='55000'; END IF;
  v_number:=hon.hq_call_number();
  IF v_number IS NULL THEN RAISE EXCEPTION 'CALL_NUMBER_NOT_READY' USING ERRCODE='55000'; END IF;
  IF v_to=v_number THEN RAISE EXCEPTION 'CALL_NUMBER_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM hon.hq_do_not_call d WHERE d.phone_e164=v_to) THEN RAISE EXCEPTION 'CALL_DO_NOT_CALL' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM hon.hq_calls x WHERE x.staff_principal_id=actor AND x.direction='OUT' AND x.created_at>clock_timestamp()-interval '1 hour')>=60 THEN
    RAISE EXCEPTION 'CALL_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  v_contact:=hon.hq_call_contact(v_to);
  IF p ? 'contactUserId' THEN
    IF NOT EXISTS(SELECT 1 FROM hon.users u WHERE u.id=(p->>'contactUserId')::uuid) THEN RAISE EXCEPTION 'CALL_PERSON_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF v_contact IS DISTINCT FROM (p->>'contactUserId')::uuid THEN RAISE EXCEPTION 'CALL_PERSON_PHONE_MISMATCH' USING ERRCODE='22023'; END IF;
  END IF;
  INSERT INTO hon.hq_calls(direction,status,hq_number_e164,remote_e164,contact_user_id,staff_principal_id,idempotency_key,connect_by)
    VALUES('OUT','INITIATED',v_number,v_to,v_contact,actor,key,clock_timestamp()+interval '2 minutes') RETURNING * INTO c;
  PERFORM hon.hq_call_evidence(c.id,actor,'HUMAN_UI','hq.call.start',hon.hq_call_state(c));
  IF hon.require_hq_communication_actor(subject,NULL) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.hq_call_json(c)||jsonb_build_object('connectBy',hon.saas_ts(c.connect_by),'replayed',false);
END $$;

-- H1 call log. p: optional filter ALL|MISSED|VOICEMAIL|OUTGOING, contactUserId, before {at, id}. 50 rows, newest first.
CREATE FUNCTION hon.read_hq_calls(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_filter text; v_contact uuid; v_at timestamptz; v_id uuid; rows jsonb; n integer; result jsonb;
BEGIN
  IF jsonb_typeof(p)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('filter','contactUserId','before'))
    OR (p ? 'filter' AND (jsonb_typeof(p->'filter')<>'string' OR p->>'filter' NOT IN ('ALL','MISSED','VOICEMAIL','OUTGOING')))
    OR (p ? 'contactUserId' AND NOT hon.conversation_uuid_ok(p->'contactUserId'))
    OR (p ? 'before' AND (jsonb_typeof(p->'before')<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p->'before') k) IS DISTINCT FROM ARRAY['at','id']
      OR NOT hon.conversation_uuid_ok(p->'before'->'id') OR jsonb_typeof(p->'before'->'at')<>'string'
      OR p->'before'->>'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_hq_communication_actor(subject,NULL);
  v_filter:=coalesce(p->>'filter','ALL'); v_contact:=(p->>'contactUserId')::uuid; v_at:=(p->'before'->>'at')::timestamptz; v_id:=(p->'before'->>'id')::uuid;
  SELECT coalesce(jsonb_agg(hon.hq_call_json(x) ORDER BY x.created_at DESC, x.id DESC),'[]'), count(*) INTO rows, n FROM (
    SELECT c.* FROM hon.hq_calls c WHERE
      (v_filter='ALL' OR (v_filter='OUTGOING' AND c.direction='OUT') OR (v_filter='VOICEMAIL' AND c.voicemail)
        OR (v_filter='MISSED' AND c.direction='IN' AND c.status IN ('MISSED','VOICEMAIL','NO_ANSWER','BUSY','CANCELED')))
      AND (v_contact IS NULL OR c.contact_user_id=v_contact)
      AND (v_at IS NULL OR (date_trunc('milliseconds',c.created_at),c.id)<(v_at,v_id))
    ORDER BY c.created_at DESC, c.id DESC LIMIT 50) x;
  result:=jsonb_build_object('calls',rows,'nextCursor',CASE WHEN n=50 THEN jsonb_build_object('at',rows->49->>'startedAt','id',rows->49->>'callId') END);
  IF hon.require_hq_communication_actor(subject,NULL) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- H1 after-call card and voicemail: p {callId, expectedVersion, outcome?, note?, heard?}; outcome/note null clears them.
CREATE FUNCTION hon.update_hq_call(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.hq_calls;
BEGIN
  IF jsonb_typeof(p)<>'object' OR NOT p ?& ARRAY['callId','expectedVersion'] OR NOT (p ? 'outcome' OR p ? 'note' OR p ? 'heard')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('callId','expectedVersion','outcome','note','heard'))
    OR NOT hon.conversation_uuid_ok(p->'callId') OR jsonb_typeof(p->'expectedVersion')<>'number' OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR (p ? 'outcome' AND jsonb_typeof(p->'outcome')<>'null' AND (jsonb_typeof(p->'outcome')<>'string'
      OR p->>'outcome' NOT IN ('RESOLVED','CALL_BACK','FOLLOW_UP','LEFT_VOICEMAIL','WRONG_NUMBER','OTHER')))
    OR (p ? 'note' AND jsonb_typeof(p->'note')<>'null' AND (jsonb_typeof(p->'note')<>'string' OR length(p->>'note') NOT BETWEEN 1 AND 1000
      OR btrim(p->>'note')='' OR p->>'note' ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'))
    OR (p ? 'heard' AND p->'heard'<>'true'::jsonb) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_hq_communication_actor(subject,NULL);
  SELECT * INTO c FROM hon.hq_calls x WHERE x.id=(p->>'callId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CALL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'CALL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p ? 'heard' AND NOT c.voicemail THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  UPDATE hon.hq_calls x SET outcome=CASE WHEN p ? 'outcome' THEN p->>'outcome' ELSE x.outcome END,
    note=CASE WHEN p ? 'note' THEN p->>'note' ELSE x.note END,
    heard_at=CASE WHEN p ? 'heard' THEN coalesce(x.heard_at,clock_timestamp()) ELSE x.heard_at END,
    version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
  PERFORM hon.hq_call_evidence(c.id,actor,'HUMAN_UI','hq.call.update',hon.hq_call_state(c));
  IF hon.require_hq_communication_actor(subject,NULL) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.hq_call_json(c);
END $$;

-- H1 HQ do-not-call. p {phoneE164, doNotCall}.
CREATE FUNCTION hon.set_hq_do_not_call(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_phone text; v_on boolean; changed integer;
BEGIN
  IF jsonb_typeof(p)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['doNotCall','phoneE164']
    OR jsonb_typeof(p->'phoneE164')<>'string' OR p->>'phoneE164' !~ '^\+[1-9][0-9]{7,14}$' OR jsonb_typeof(p->'doNotCall')<>'boolean' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  actor:=hon.require_hq_communication_actor(subject,NULL);
  v_phone:=p->>'phoneE164'; v_on:=(p->>'doNotCall')::boolean;
  IF v_on THEN INSERT INTO hon.hq_do_not_call(phone_e164,set_by) VALUES(v_phone,actor) ON CONFLICT DO NOTHING;
  ELSE DELETE FROM hon.hq_do_not_call d WHERE d.phone_e164=v_phone; END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed>0 THEN PERFORM hon.hq_call_evidence(NULL,actor,'HUMAN_UI','hq.call.do_not_call.set',jsonb_build_object('doNotCall',v_on)); END IF;
  RETURN jsonb_build_object('phoneE164',v_phone,'doNotCall',v_on);
END $$;

-- H1 play a voicemail: the recording SID for the API to stream from HON's parent account; every open is evidence.
CREATE FUNCTION hon.open_hq_call_recording(subject text, p_call uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.hq_calls;
BEGIN
  IF p_call IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_hq_communication_actor(subject,NULL);
  SELECT * INTO c FROM hon.hq_calls x WHERE x.id=p_call;
  IF NOT FOUND OR c.recording_status<>'AVAILABLE' THEN RAISE EXCEPTION 'CALL_RECORDING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.hq_call_evidence(c.id,actor,'HUMAN_UI','hq.call.recording.open',jsonb_build_object('voicemail',c.voicemail));
  RETURN jsonb_build_object('recordingSid',c.recording_sid,'accountSid',NULL,'seconds',c.recording_seconds);
END $$;

-- H1 may this HQ person have a browser phone now? Identity, whether incoming may ring it, and whether the HQ voice app is
-- ready. Never returns a key or secret.
CREATE FUNCTION hon.authorize_hq_phone_token(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_on boolean; v_ready boolean; v_ring boolean;
BEGIN
  actor:=hon.require_hq_communication_actor(subject,NULL);
  v_on:=coalesce((SELECT s.calling_on FROM hon.hq_calling_settings s),false);
  v_ready:=v_on AND hon.hq_call_number() IS NOT NULL AND EXISTS(SELECT 1 FROM hon.hq_voice_app v WHERE v.status='ACTIVE');
  v_ring:=coalesce((SELECT k.ring_me FROM hon.hq_call_staff k WHERE k.principal_id=actor),false);
  PERFORM hon.hq_call_evidence(NULL,actor,'HUMAN_UI','hq.call.phone_token.issue',jsonb_build_object('ready',v_ready,'incoming',v_ring AND v_ready));
  RETURN jsonb_build_object('identity',hon.hq_call_identity(actor),'ready',v_ready,'callingOn',v_on,'incoming',v_ring AND v_ready);
END $$;

-- ---------- communication worker ----------
-- Voice app: does HQ need one now (calling on, HQ number ready, no ACTIVE app and no live claim)?
CREATE FUNCTION hon.hq_needs_voice_app() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT s.calling_on FROM hon.hq_calling_settings s),false) AND hon.hq_call_number() IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM hon.hq_voice_app v WHERE v.status='ACTIVE' OR (v.status='PENDING' AND v.claim_expires_at>clock_timestamp()))
$$;

CREATE FUNCTION hon.begin_hq_voice_app(p_lease_seconds integer)
RETURNS TABLE (state text, twiml_app_sid text, claim_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE v hon.hq_voice_app; token uuid:=gen_random_uuid();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN RAISE EXCEPTION 'HON voice app claim is invalid.' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.hq_voice_app',0));
  IF NOT coalesce((SELECT s.calling_on FROM hon.hq_calling_settings s),false) OR hon.hq_call_number() IS NULL THEN state:='INELIGIBLE'; RETURN NEXT; RETURN; END IF;
  SELECT * INTO v FROM hon.hq_voice_app FOR UPDATE;
  IF v.status='ACTIVE' THEN state:='ACTIVE'; twiml_app_sid:=v.twiml_app_sid; RETURN NEXT; RETURN; END IF;
  IF v.status='PENDING' AND v.claim_expires_at>clock_timestamp() THEN state:='BUSY'; RETURN NEXT; RETURN; END IF;
  IF v.singleton IS NULL THEN
    INSERT INTO hon.hq_voice_app(status,claim_token,claim_expires_at,attempts) VALUES('PENDING',token,clock_timestamp()+make_interval(secs=>p_lease_seconds),1) RETURNING * INTO v;
  ELSE
    UPDATE hon.hq_voice_app x SET status='PENDING',claim_token=token,claim_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      api_key_sid=NULL,sealed_api_secret=NULL,vault_key_id=NULL,attempts=least(x.attempts+1,1000),version=x.version+1,updated_at=clock_timestamp() RETURNING * INTO v;
  END IF;
  state:='CLAIMED'; twiml_app_sid:=v.twiml_app_sid; claim_token:=token; RETURN NEXT;
END $$;

CREATE FUNCTION hon.record_hq_voice_app_twiml(p_claim_token uuid, p_twiml_app_sid text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v hon.hq_voice_app;
BEGIN
  IF p_claim_token IS NULL OR p_twiml_app_sid IS NULL OR p_twiml_app_sid !~ '^AP[0-9a-f]{32}$' THEN RAISE EXCEPTION 'HON voice app input is invalid.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM hon.hq_voice_app FOR UPDATE;
  IF v.status IS DISTINCT FROM 'PENDING' OR v.claim_token IS DISTINCT FROM p_claim_token OR v.claim_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'VOICE_APP_CLAIM_LOST' USING ERRCODE='40001'; END IF;
  IF v.twiml_app_sid IS NOT NULL THEN RETURN v.twiml_app_sid=p_twiml_app_sid; END IF;
  UPDATE hon.hq_voice_app x SET twiml_app_sid=p_twiml_app_sid,version=x.version+1,updated_at=clock_timestamp();
  RETURN true;
END $$;

CREATE FUNCTION hon.complete_hq_voice_app(p_claim_token uuid, p_api_key_sid text, p_sealed_api_secret text, p_vault_key_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v hon.hq_voice_app;
BEGIN
  IF p_claim_token IS NULL OR p_api_key_sid IS NULL OR p_api_key_sid !~ '^SK[0-9a-f]{32}$' OR p_sealed_api_secret IS NULL OR p_vault_key_id IS NULL THEN
    RAISE EXCEPTION 'HON voice app input is invalid.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM hon.hq_voice_app FOR UPDATE;
  IF v.status IS DISTINCT FROM 'PENDING' OR v.claim_token IS DISTINCT FROM p_claim_token OR v.claim_expires_at<=clock_timestamp() OR v.twiml_app_sid IS NULL THEN
    RAISE EXCEPTION 'VOICE_APP_CLAIM_LOST' USING ERRCODE='40001'; END IF;
  UPDATE hon.hq_voice_app x SET status='ACTIVE',api_key_sid=p_api_key_sid,sealed_api_secret=p_sealed_api_secret,vault_key_id=p_vault_key_id,
    claim_token=NULL,claim_expires_at=NULL,version=x.version+1,updated_at=clock_timestamp() RETURNING * INTO v;
  PERFORM hon.hq_call_evidence(NULL,'00000000-0000-4000-8000-00000000c562','INTEGRATION','hq.call.voice_app.created',
    jsonb_build_object('twimlAppSid',v.twiml_app_sid,'apiKeySid',v.api_key_sid,'version',v.version));
  RETURN true;
END $$;

-- The sealed key of the ACTIVE HQ voice app, read only to sign an HQ phone token the runtime authorized.
CREATE FUNCTION hon.read_hq_voice_app()
RETURNS TABLE (twiml_app_sid text, api_key_sid text, sealed_api_secret text, vault_key_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT v.twiml_app_sid, v.api_key_sid, v.sealed_api_secret, v.vault_key_id FROM hon.hq_voice_app v WHERE v.status='ACTIVE'
$$;

-- H3 the HQ browser's outgoing call reached the HQ client-voice webhook (parent-account signature already checked).
-- Connects only the HQ person who started it, within two minutes, once, while HQ calling is on and they may still call.
CREATE FUNCTION hon.connect_hq_client_call(p_call uuid, p_identity text, p_call_sid text)
RETURNS TABLE (outcome text, to_e164 text, caller_id_e164 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE c hon.hq_calls; v_ok boolean;
BEGIN
  IF p_call IS NULL OR p_identity IS NULL OR p_identity !~ '^h[0-9a-f]{32}$' OR p_call_sid IS NULL OR p_call_sid !~ '^CA[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'HON client call is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM hon.hq_calls x WHERE x.id=p_call FOR UPDATE;
  IF NOT FOUND OR c.direction<>'OUT' THEN outcome:='REFUSED'; RETURN NEXT; RETURN; END IF;
  IF c.provider_call_sid=p_call_sid THEN
    IF p_identity<>hon.hq_call_identity(c.staff_principal_id) THEN outcome:='REFUSED'; RETURN NEXT; RETURN; END IF;
    outcome:='REPLAYED'; to_e164:=c.remote_e164; caller_id_e164:=c.hq_number_e164; RETURN NEXT; RETURN;
  END IF;
  v_ok:=c.status='INITIATED' AND c.provider_call_sid IS NULL AND c.connect_by>clock_timestamp()
    AND hon.hq_call_identity(c.staff_principal_id)=p_identity AND hon.hq_call_number() IS NOT DISTINCT FROM c.hq_number_e164
    AND coalesce((SELECT s.calling_on FROM hon.hq_calling_settings s),false)
    AND NOT EXISTS(SELECT 1 FROM hon.hq_do_not_call d WHERE d.phone_e164=c.remote_e164)
    AND hon.hq_call_staff_ok(c.staff_principal_id);
  IF NOT v_ok THEN outcome:='REFUSED'; RETURN NEXT; RETURN; END IF;
  UPDATE hon.hq_calls x SET status='RINGING',provider_call_sid=p_call_sid,version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
  PERFORM hon.hq_call_evidence(c.id,'00000000-0000-4000-8000-00000000c562','INTEGRATION','hq.call.connect',hon.hq_call_state(c));
  outcome:='CONNECT'; to_e164:=c.remote_e164; caller_id_e164:=c.hq_number_e164; RETURN NEXT;
END $$;

-- H3 an incoming call to the HQ number. With HQ calling on, records the call RINGING and returns who to ring (at most 10
-- HQ people with Ring me who may still take calls) and the greeting. Otherwise OFF (Twilio plays the HQ voicemail-off message).
CREATE FUNCTION hon.route_hq_incoming_call(p_to_e164 text, p_from_e164 text, p_call_sid text)
RETURNS TABLE (outcome text, call_id uuid, identities text[], voicemail_greeting text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE s hon.hq_calling_settings; c hon.hq_calls; v_number text;
BEGIN
  IF p_to_e164 IS NULL OR p_to_e164 !~ '^\+[1-9][0-9]{7,14}$' OR (p_from_e164 IS NOT NULL AND p_from_e164 !~ '^\+[1-9][0-9]{7,14}$')
    OR p_call_sid IS NULL OR p_call_sid !~ '^CA[0-9a-f]{32}$' THEN RAISE EXCEPTION 'HON incoming call is invalid.' USING ERRCODE='22023'; END IF;
  v_number:=hon.hq_call_number();
  IF v_number IS DISTINCT FROM p_to_e164 THEN outcome:='UNROUTED'; RETURN NEXT; RETURN; END IF;
  SELECT * INTO s FROM hon.hq_calling_settings;
  IF NOT coalesce(s.calling_on,false) THEN outcome:='OFF'; RETURN NEXT; RETURN; END IF;
  INSERT INTO hon.hq_calls(direction,status,hq_number_e164,remote_e164,contact_user_id,provider_call_sid)
    VALUES('IN','RINGING',p_to_e164,p_from_e164,hon.hq_call_contact(p_from_e164),p_call_sid)
    ON CONFLICT (provider_call_sid) DO NOTHING RETURNING * INTO c;
  IF c.id IS NULL THEN
    SELECT * INTO c FROM hon.hq_calls x WHERE x.provider_call_sid=p_call_sid;
    IF c.direction<>'IN' THEN outcome:='UNROUTED'; RETURN NEXT; RETURN; END IF;
    outcome:='REPLAYED';
  ELSE
    PERFORM hon.hq_call_evidence(c.id,'00000000-0000-4000-8000-00000000c562','INTEGRATION','hq.call.receive',hon.hq_call_state(c));
    outcome:='RING';
  END IF;
  call_id:=c.id; voicemail_greeting:=s.voicemail_greeting;
  SELECT coalesce(array_agg(hon.hq_call_identity(k.principal_id) ORDER BY k.updated_at, k.principal_id),ARRAY[]::text[]) INTO identities FROM (
    SELECT k.* FROM hon.hq_call_staff k WHERE k.ring_me AND hon.hq_call_staff_ok(k.principal_id) ORDER BY k.updated_at, k.principal_id LIMIT 10) k;
  RETURN NEXT;
END $$;

-- H3 call progress (parent call SID). Same statuses and ordering as schools; p_answered_identity names the HQ browser that
-- answered an incoming call.
CREATE FUNCTION hon.record_hq_call_status(p_call_sid text, p_status text, p_answered_identity text, p_duration_seconds integer, p_occurred_at timestamptz)
RETURNS TABLE (outcome text, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE c hon.hq_calls; v_staff uuid;
BEGIN
  IF p_call_sid IS NULL OR p_call_sid !~ '^CA[0-9a-f]{32}$'
    OR p_status IS NULL OR p_status NOT IN ('RINGING','IN_PROGRESS','COMPLETED','NO_ANSWER','BUSY','FAILED','CANCELED','MISSED')
    OR (p_answered_identity IS NOT NULL AND p_answered_identity !~ '^h[0-9a-f]{32}$')
    OR (p_duration_seconds IS NOT NULL AND p_duration_seconds NOT BETWEEN 0 AND 86400)
    OR p_occurred_at IS NULL OR p_occurred_at > now()+interval '10 minutes' OR p_occurred_at < now()-interval '7 days' THEN
    RAISE EXCEPTION 'HON call status is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM hon.hq_calls x WHERE x.provider_call_sid=p_call_sid FOR UPDATE;
  IF NOT FOUND THEN outcome:='UNKNOWN_CALL'; RETURN NEXT; RETURN; END IF;
  IF p_answered_identity IS NOT NULL AND c.direction='IN' AND c.staff_principal_id IS NULL THEN
    SELECT k.principal_id INTO v_staff FROM hon.hq_call_staff k WHERE hon.hq_call_identity(k.principal_id)=p_answered_identity AND hon.hq_call_staff_ok(k.principal_id);
  END IF;
  IF hon.school_call_rank(p_status)<=hon.school_call_rank(c.status) AND NOT (v_staff IS NOT NULL AND p_status=c.status) THEN
    outcome:='IGNORED'; status:=c.status; RETURN NEXT; RETURN; END IF;
  IF c.direction='OUT' AND p_status='MISSED' THEN outcome:='IGNORED'; status:=c.status; RETURN NEXT; RETURN; END IF;
  UPDATE hon.hq_calls x SET status=CASE WHEN hon.school_call_rank(p_status)>hon.school_call_rank(x.status) THEN p_status ELSE x.status END,
    staff_principal_id=coalesce(x.staff_principal_id,v_staff),
    answered_at=CASE WHEN p_status='IN_PROGRESS' THEN coalesce(x.answered_at,p_occurred_at) ELSE x.answered_at END,
    ended_at=CASE WHEN hon.school_call_rank(p_status)=3 THEN coalesce(x.ended_at,p_occurred_at) ELSE x.ended_at END,
    duration_seconds=coalesce(p_duration_seconds,x.duration_seconds),version=x.version+1,updated_at=clock_timestamp()
    WHERE x.id=c.id RETURNING * INTO c;
  PERFORM hon.hq_call_evidence(c.id,'00000000-0000-4000-8000-00000000c562','INTEGRATION','hq.call.status',hon.hq_call_state(c));
  outcome:='RECORDED'; status:=c.status; RETURN NEXT;
END $$;

-- H3 a voicemail for a missed incoming HQ call (the only HQ recording).
CREATE FUNCTION hon.record_hq_call_voicemail(p_call_sid text, p_recording_sid text, p_seconds integer)
RETURNS TABLE (outcome text, call_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE c hon.hq_calls;
BEGIN
  IF p_call_sid IS NULL OR p_call_sid !~ '^CA[0-9a-f]{32}$' OR p_recording_sid IS NULL OR p_recording_sid !~ '^RE[0-9a-f]{32}$'
    OR p_seconds IS NULL OR p_seconds NOT BETWEEN 0 AND 86400 THEN RAISE EXCEPTION 'HON call recording is invalid.' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM hon.hq_calls x WHERE x.provider_call_sid=p_call_sid FOR UPDATE;
  IF NOT FOUND THEN outcome:='UNKNOWN_CALL'; RETURN NEXT; RETURN; END IF;
  call_id:=c.id;
  IF c.recording_sid=p_recording_sid THEN outcome:='REPLAYED'; RETURN NEXT; RETURN; END IF;
  IF c.recording_sid IS NOT NULL OR c.direction<>'IN' OR c.status NOT IN ('RINGING','MISSED') THEN outcome:='REFUSED'; RETURN NEXT; RETURN; END IF;
  IF c.status='RINGING' THEN
    UPDATE hon.hq_calls x SET status='MISSED',ended_at=coalesce(x.ended_at,clock_timestamp()),version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
  END IF;
  UPDATE hon.hq_calls x SET status='VOICEMAIL',voicemail=true,recording_sid=p_recording_sid,recording_seconds=p_seconds,recording_status='AVAILABLE',
    version=x.version+1,updated_at=clock_timestamp() WHERE x.id=c.id RETURNING * INTO c;
  PERFORM hon.hq_call_evidence(c.id,'00000000-0000-4000-8000-00000000c562','INTEGRATION','hq.call.voicemail.receive',hon.hq_call_state(c));
  outcome:='RECORDED'; RETURN NEXT;
END $$;

CREATE FUNCTION hon.read_hq_call_recordings_due(p_limit integer)
RETURNS TABLE (call_id uuid, recording_sid text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'HON recording limit is invalid.' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT c.id, c.recording_sid FROM hon.hq_calls c WHERE c.recording_status='AVAILABLE' AND c.created_at<clock_timestamp()-interval '90 days'
    ORDER BY c.created_at, c.id LIMIT p_limit;
END $$;

CREATE FUNCTION hon.mark_hq_call_recording_deleted(p_call uuid, p_recording_sid text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.hq_calls;
BEGIN
  UPDATE hon.hq_calls x SET recording_status='DELETED',version=x.version+1,updated_at=clock_timestamp()
    WHERE x.id=p_call AND x.recording_sid=p_recording_sid AND x.recording_status='AVAILABLE' AND x.created_at<clock_timestamp()-interval '90 days'
    RETURNING * INTO c;
  IF c.id IS NULL THEN RETURN false; END IF;
  PERFORM hon.hq_call_evidence(c.id,'00000000-0000-4000-8000-00000000c562','INTEGRATION','hq.call.recording.delete',hon.hq_call_state(c));
  RETURN true;
END $$;

-- Grants: HQ entry points to the runtime, provider entry points to the communication worker, everything else owner-only.
DO $$ DECLARE r text; f text; t text;
  staff text[]:=ARRAY['hon.read_hq_calling(text)','hon.set_hq_calling_settings(text,jsonb)','hon.set_my_hq_call_ringing(text,jsonb)',
    'hon.start_hq_call(text,jsonb,text)','hon.read_hq_calls(text,jsonb)','hon.update_hq_call(text,jsonb)','hon.set_hq_do_not_call(text,jsonb)',
    'hon.open_hq_call_recording(text,uuid)','hon.authorize_hq_phone_token(text)'];
  worker text[]:=ARRAY['hon.hq_needs_voice_app()','hon.begin_hq_voice_app(integer)','hon.record_hq_voice_app_twiml(uuid,text)',
    'hon.complete_hq_voice_app(uuid,text,text,text)','hon.read_hq_voice_app()','hon.connect_hq_client_call(uuid,text,text)',
    'hon.route_hq_incoming_call(text,text,text)','hon.record_hq_call_status(text,text,text,integer,timestamptz)',
    'hon.record_hq_call_voicemail(text,text,integer)','hon.read_hq_call_recordings_due(integer)','hon.mark_hq_call_recording_deleted(uuid,text)'];
  private text[]:=ARRAY['hon.guard_hq_call()','hon.guard_hq_calling_row()','hon.guard_hq_voice_app()','hon.guard_hq_call_evidence()','hon.hq_call_identity(uuid)',
    'hon.hq_call_staff_ok(uuid)','hon.hq_call_number()','hon.hq_call_contact(text)','hon.expire_hq_calls()','hon.hq_call_json(hon.hq_calls)',
    'hon.hq_call_evidence(uuid,uuid,text,text,jsonb)','hon.hq_call_state(hon.hq_calls)'];
BEGIN
  FOREACH f IN ARRAY staff||worker||private LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hq_calling_settings','hq_call_staff','hq_calls','hq_do_not_call','hq_voice_app','hq_call_events'] LOOP
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
