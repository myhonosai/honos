BEGIN;

-- Walk-in kiosk WK4 (0537, assigned by the coordinator 2026-11-19). Owner request (David, 2026-11-16): the kiosk is a quick
-- intake, waiver and "day pass or trial purchase". A trial is only useful with a class to come to, so a trial offer can now
-- name programs and the visitor picks one of their next classes on the tablet. Spec: docs/architecture/WALK_IN_KIOSK.md 3.4.
--   T1  A TRIAL offer may carry programIds: 1-10 distinct, non-cancelled programs of the school saving the settings. The staff
--       settings read lists the school's programs. The tablet's offers carry `classes` for such an offer: up to 20 scheduled
--       sessions of those programs in the next 14 days that have not started, each with the spots still open.
--   T2  A visit for such an offer must name one of those classes (trialSessionId). The submit locks that class FOR UPDATE and
--       answers CLASS_FULL (nothing written) when it is gone, started, outside the offer's programs or lacks room for every
--       participant on the visit. Otherwise it books the CRM trial as the CRM trial command does (0043: advisory lock per
--       lead, one SCHEDULED TRIAL appointment, audit crm.trial.schedule, outbox crm.trial.scheduled) by the kiosk service
--       principal, and the visit keeps the class and the appointment.
--   T3  Seats taken in a class = its BOOKED and CHECKED_IN bookings plus the participants of kiosk visits whose trial for it is
--       SCHEDULED or COMPLETED. (Staff and parent bookings still count bookings only: a known gap, see the spec.)
--   T4  The visit read (staff) and the RECORDED answer (tablet) carry trialClass {sessionId,name,startsAt,endsAt,status}.
--   T5  (#492 review P3) the desk path's card-paid audit row keeps the staff request's own correlation id.
-- No money, message, AI or class booking row. Nothing here deploys or turns anything on.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Walk-in kiosk trial class requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Walk-in kiosk trial class requires a restricted runtime';
  END IF;
  IF to_regclass('hon.walkin_visits') IS NULL OR to_regclass('hon.crm_appointments') IS NULL OR to_regclass('hon.class_sessions') IS NULL
    OR to_regclass('hon.class_bookings') IS NULL OR to_regclass('hon.programs') IS NULL
    OR to_regprocedure('hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)') IS NULL
    OR to_regprocedure('hon.set_walkin_visit_desk_paid(text,uuid,jsonb,text,uuid,uuid)') IS NULL
    OR position('hon.demo_data_removal_allows(TG_TABLE_NAME,to_jsonb(OLD))' IN (SELECT prosrc FROM pg_proc WHERE oid='hon.guard_walkin_kiosk()'::regprocedure))=0
    OR position('PAID_CARD' IN (SELECT prosrc FROM pg_proc WHERE oid='hon.guard_walkin_kiosk()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'Walk-in kiosk trial class requires 0043, 0414, 0459 and 0533';
  END IF;
  IF EXISTS(SELECT 1 FROM hon.walkin_kiosk_settings s, jsonb_array_elements(s.offers) o WHERE o ? 'programIds') THEN
    RAISE EXCEPTION 'Walk-in kiosk settings already name programs';
  END IF;
END $$;

-- T2: the class and the trial a visit booked. Both or neither, and only on a trial offer.
ALTER TABLE hon.walkin_visits
  ADD COLUMN trial_session_id uuid,
  ADD COLUMN trial_appointment_id uuid UNIQUE,
  ADD CONSTRAINT walkin_visits_trial_session_fk FOREIGN KEY (trial_session_id,organization_id,school_id)
    REFERENCES hon.class_sessions(id,organization_id,school_id) ON DELETE RESTRICT,
  ADD CONSTRAINT walkin_visits_trial_appointment_fk FOREIGN KEY (trial_appointment_id,organization_id,school_id)
    REFERENCES hon.crm_appointments(id,organization_id,school_id) ON DELETE RESTRICT,
  ADD CONSTRAINT walkin_visits_trial_check CHECK ((trial_session_id IS NULL)=(trial_appointment_id IS NULL)
    AND (trial_session_id IS NULL OR offer_kind='TRIAL'));
CREATE INDEX walkin_visits_trial_session_idx ON hon.walkin_visits(trial_session_id) WHERE trial_session_id IS NOT NULL;

-- T3: seats taken in one class (bookings that hold a seat, plus kiosk trial visitors still coming or come).
CREATE FUNCTION hon.walkin_session_taken(session uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT ((SELECT count(*) FROM hon.class_bookings b WHERE b.class_session_id=session AND b.status IN ('BOOKED','CHECKED_IN'))
    +(SELECT count(*) FROM hon.walkin_visits v JOIN hon.crm_appointments a ON a.id=v.trial_appointment_id
        JOIN hon.walkin_visit_participants x ON x.visit_id=v.id
      WHERE v.trial_session_id=session AND a.status IN ('SCHEDULED','COMPLETED')))::integer
$$;

-- T1/T2: whether class `s` can take `seats` more trial visitors for an offer naming `program_ids`.
CREATE FUNCTION hon.walkin_trial_session_open(s hon.class_sessions,program_ids jsonb,seats integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT s.id IS NOT NULL AND s.status='SCHEDULED' AND s.starts_at>clock_timestamp() AND s.starts_at<=clock_timestamp()+interval '14 days'
    AND seats>=1 AND jsonb_typeof(program_ids)='array' AND program_ids ? s.program_id::text
    AND EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=s.program_id AND g.organization_id=s.organization_id AND g.school_id=s.school_id AND g.status<>'CANCELLED')
    AND s.capacity-hon.walkin_session_taken(s.id)>=seats
$$;

-- T1: the next classes a trial offer naming `program_ids` can book, for the tablet.
CREATE FUNCTION hon.walkin_trial_classes(org uuid,school uuid,program_ids jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',c.id,'name',c.name,'startsAt',hon.walkin_utc(c.starts_at),'endsAt',hon.walkin_utc(c.ends_at),
      'spotsOpen',greatest(c.capacity-hon.walkin_session_taken(c.id),0)) ORDER BY c.starts_at,c.id),'[]'::jsonb)
  FROM (SELECT s.* FROM hon.class_sessions s JOIN hon.programs g ON g.id=s.program_id AND g.organization_id=s.organization_id AND g.school_id=s.school_id
    WHERE s.organization_id=org AND s.school_id=school AND s.status='SCHEDULED' AND g.status<>'CANCELLED'
      AND s.starts_at>clock_timestamp() AND s.starts_at<=clock_timestamp()+interval '14 days'
      AND jsonb_typeof(program_ids)='array' AND program_ids ? s.program_id::text
    ORDER BY s.starts_at,s.id LIMIT 20) c
$$;

-- T4: the class a visit booked, or null.
CREATE FUNCTION hon.walkin_trial_class_json(v hon.walkin_visits) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN v.trial_session_id IS NULL THEN NULL ELSE
    (SELECT jsonb_build_object('sessionId',s.id,'name',s.name,'startsAt',hon.walkin_utc(s.starts_at),'endsAt',hon.walkin_utc(s.ends_at),
      'status',(SELECT a.status::text FROM hon.crm_appointments a WHERE a.id=v.trial_appointment_id))
     FROM hon.class_sessions s WHERE s.id=v.trial_session_id AND s.organization_id=v.organization_id AND s.school_id=v.school_id) END
$$;

-- T5: the card-paid step with the caller's correlation id; the five-argument form (tablet paths) keeps request for both.
CREATE FUNCTION hon.walkin_card_paid(v hon.walkin_visits,s jsonb,actor uuid,source text,request uuid,correlation uuid) RETURNS hon.walkin_visits
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF v.payment_state<>'PAY_AT_DESK' OR s->>'state' IS DISTINCT FROM 'SUCCEEDED' OR s->>'source' IS DISTINCT FROM 'WALKIN_VISIT'
    OR (s->>'sourceId')::uuid IS DISTINCT FROM v.id OR (s->>'organizationId')::uuid IS DISTINCT FROM v.organization_id
    OR (s->>'schoolId')::uuid IS DISTINCT FROM v.school_id OR (s->>'amountMinor')::bigint IS DISTINCT FROM v.price_minor::bigint
    OR s->>'currency' IS DISTINCT FROM v.currency OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'WALKIN_CARD_PAYMENT_MISMATCH' USING ERRCODE='22023'; END IF;
  UPDATE hon.walkin_visits SET payment_state='PAID_CARD',card_payment_id=(s->>'paymentId')::uuid,card_paid_at=clock_timestamp(),
    version=version+1,updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(v.organization_id,v.school_id,actor,source,'walkin_kiosk.visit.card_paid','WALKIN_VISIT',v.id,
      jsonb_build_object('visitId',v.id,'paymentState','PAY_AT_DESK','version',v.version-1),
      jsonb_build_object('visitId',v.id,'paymentState',v.payment_state,'paymentId',v.card_payment_id,'version',v.version),'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(v.organization_id,v.school_id,'walkin_kiosk.visit_card_paid',1,'WALKIN_VISIT',v.id,v.version,correlation,request,
      jsonb_build_object('visitId',v.id,'paymentId',v.card_payment_id,'internalOnly',true));
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION hon.walkin_card_paid(v hon.walkin_visits,s jsonb,actor uuid,source text,request uuid) RETURNS hon.walkin_visits
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN hon.walkin_card_paid(v,s,actor,source,request,request);
END $$;

-- T2: the guard (0533, with the 0459 demo data removal line kept as is) also keeps a visit's class and trial fixed.
CREATE OR REPLACE FUNCTION hon.guard_walkin_kiosk() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' AND hon.demo_data_removal_allows(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF; -- 0459 demo data removal

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
      IF NEW.version<>1 OR NEW.payment_state NOT IN ('FREE','PAY_AT_DESK') OR NEW.card_payment_id IS NOT NULL OR NEW.card_paid_at IS NOT NULL THEN
        RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.device_id,NEW.lead_id,NEW.contact_person_id,NEW.language,NEW.settings_version,NEW.offer_key,
        NEW.offer_kind,NEW.offer_name,NEW.price_minor,NEW.currency,NEW.emergency_name,NEW.emergency_phone,NEW.heard_from,NEW.marketing_opt_in,
        NEW.local_date,NEW.key_hash,NEW.payload_hash,NEW.created_at,NEW.trial_session_id,NEW.trial_appointment_id)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.device_id,OLD.lead_id,OLD.contact_person_id,OLD.language,OLD.settings_version,OLD.offer_key,
        OLD.offer_kind,OLD.offer_name,OLD.price_minor,OLD.currency,OLD.emergency_name,OLD.emergency_phone,OLD.heard_from,OLD.marketing_opt_in,
        OLD.local_date,OLD.key_hash,OLD.payload_hash,OLD.created_at,OLD.trial_session_id,OLD.trial_appointment_id)
      OR NEW.version<>OLD.version+1 OR OLD.payment_state<>'PAY_AT_DESK' OR NEW.payment_state NOT IN ('PAID_AT_DESK','PAID_CARD') THEN
      RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  -- walkin_waiver_texts, walkin_visit_participants, walkin_waiver_signatures: insert only.
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WALKIN_KIOSK_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- T1: settings input, with programIds on a TRIAL offer.
CREATE OR REPLACE FUNCTION hon.walkin_settings_input(p jsonb) RETURNS jsonb
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
    IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR NOT o ?& okeys OR EXISTS(SELECT 1 FROM jsonb_object_keys(o) k WHERE k<>ALL(okeys||'programIds'::text))
      -- T1: a trial offer may name 1-10 of this school's programs; the visitor then picks one of their next classes.
      OR (o ? 'programIds' AND (o->>'kind' IS DISTINCT FROM 'TRIAL' OR jsonb_typeof(o->'programIds') IS DISTINCT FROM 'array'
        OR jsonb_array_length(o->'programIds') NOT BETWEEN 1 AND 10
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(o->'programIds') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string'
          OR (x#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        OR (SELECT count(DISTINCT x#>>'{}') FROM jsonb_array_elements(o->'programIds') x)<>jsonb_array_length(o->'programIds')
        OR (SELECT count(*) FROM hon.programs g WHERE g.id IN (SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(o->'programIds') x)
          AND g.organization_id=hon.current_organization_id() AND g.school_id=hon.current_school_id() AND g.status<>'CANCELLED')<>jsonb_array_length(o->'programIds')))
      OR jsonb_typeof(o->'key') IS DISTINCT FROM 'string' OR (o->>'key') !~ '^[a-z0-9][a-z0-9-]{0,23}$'
      OR jsonb_typeof(o->'kind') IS DISTINCT FROM 'string' OR (o->>'kind') NOT IN ('DAY_PASS','TRIAL')
      OR NOT hon.walkin_text_ok(o->'name',1,60,false) OR NOT hon.walkin_text_ok(o->'description',0,200,false)
      OR jsonb_typeof(o->'priceMinor') IS DISTINCT FROM 'number' OR (o->>'priceMinor') !~ '^(0|[1-9][0-9]{0,6})$' OR (o->>'priceMinor')::integer>1000000 THEN
      RETURN NULL; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT e->>'key') FROM jsonb_array_elements(p->'offers') e)<>jsonb_array_length(p->'offers') THEN RETURN NULL; END IF;
  RETURN p;
END $$;

-- T1: the staff settings read, with the school's programs.
CREATE OR REPLACE FUNCTION hon.read_walkin_kiosk_settings(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; x hon.walkin_kiosk_settings%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.manage');
  SELECT * INTO x FROM hon.walkin_kiosk_settings s WHERE s.organization_id=org AND s.school_id=school;
  result:=jsonb_build_object('settings',CASE WHEN FOUND THEN hon.walkin_settings_json(x) ELSE NULL END,
    'pipelines',coalesce((SELECT jsonb_agg(jsonb_build_object('pipelineId',pl.id,'name',pl.name,
      'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('stageId',st.id,'name',st.name) ORDER BY st.position,st.id) FROM hon.crm_pipeline_stages st
        WHERE st.pipeline_id=pl.id AND st.organization_id=org AND st.school_id=school),'[]'::jsonb)) ORDER BY pl.created_at,pl.id)
      FROM (SELECT * FROM hon.crm_pipelines y WHERE y.organization_id=org AND y.school_id=school ORDER BY y.created_at,y.id LIMIT 20) pl),'[]'::jsonb),
    -- T1: the programs a trial offer can name.
    'programs',coalesce((SELECT jsonb_agg(jsonb_build_object('programId',g.id,'name',g.name) ORDER BY g.name,g.id)
      FROM (SELECT * FROM hon.programs y WHERE y.organization_id=org AND y.school_id=school AND y.status<>'CANCELLED' ORDER BY y.name,y.id LIMIT 50) g),'[]'::jsonb));
  IF hon.require_walkin_actor(subject,'walkin_kiosk.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- T1: the tablet read, with each programs-naming trial offer's next classes.
CREATE OR REPLACE FUNCTION hon.read_walkin_kiosk_terminal(digest text) RETURNS jsonb
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
    'offers',(SELECT jsonb_agg(jsonb_build_object('key',o->>'key','kind',o->>'kind','name',o->'name','description',o->'description','priceMinor',(o->>'priceMinor')::integer,'currency','USD',
      'classes',CASE WHEN o ? 'programIds' THEN hon.walkin_trial_classes(d.organization_id,d.school_id,o->'programIds') END))
      FROM jsonb_array_elements(k.offers) o),'thankYou',k.thank_you);
END $$;

-- T2: visit input, with trialSessionId (required for a programs-naming trial offer, absent or null otherwise).
CREATE OR REPLACE FUNCTION hon.walkin_visit_input(k hon.walkin_kiosk_settings,p jsonb,today date) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE c jsonb; ch jsonb; e jsonb; w jsonb; email text; mobile text; cbirth date; b date; kids jsonb:='[]'::jsonb; offer jsonb; s jsonb; pt jsonb;
  points integer:=0; minors integer:=0;
  keys text[]:=ARRAY['settingsVersion','language','contact','children','relationship','emergency','heardFrom','marketingOptIn','offerKey','waiver','website'];
  ckeys text[]:=ARRAY['givenName','familyName','email','mobile','birthDate','isParticipant','adultConfirmed'];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>24576 OR NOT p ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x<>ALL(keys||'trialSessionId'::text))
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
    OR NOT hon.school_event_text_ok(e->>'name',0,120) OR (e->>'name') ~ '[<>]' OR (e->>'phone'<>'' AND (e->>'phone') !~ '^\+[1-9][0-9]{6,14}$')
    OR ((e->>'name'='')<>(e->>'phone'='')) OR (k.emergency_required AND e->>'name'='') THEN RETURN NULL; END IF;
  -- Offer.
  SELECT o INTO offer FROM jsonb_array_elements(k.offers) o WHERE o->>'key'=p->>'offerKey';
  IF offer IS NULL THEN RETURN NULL; END IF;
  -- T2: a trial offer that names programs needs one picked class; any other offer takes none.
  IF offer ? 'programIds' THEN
    IF jsonb_typeof(p->'trialSessionId') IS DISTINCT FROM 'string'
      OR (p->>'trialSessionId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  ELSIF p ? 'trialSessionId' AND p->'trialSessionId' IS DISTINCT FROM 'null'::jsonb THEN RETURN NULL;
  END IF;
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
    'trialSessionId',CASE WHEN offer ? 'programIds' THEN p->'trialSessionId' ELSE 'null'::jsonb END,
    'waiver',jsonb_build_object('signerName',w->>'signerName','strokes',w->'strokes'));
END $$;

-- T2: submit, with the class check and the CRM trial. Lock order: organization -> school -> settings -> device -> class session.
CREATE OR REPLACE FUNCTION hon.submit_walkin_visit(digest text,p jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.walkin_kiosk_devices%ROWTYPE; k hon.walkin_kiosk_settings%ROWTYPE; v jsonb; kh text; ph text; tz text; today date;
  x hon.walkin_visits%ROWTYPE; contact uuid; lead uuid:=gen_random_uuid(); visit uuid:=gen_random_uuid(); child jsonb; person uuid; n integer:=1;
  ch text; request uuid:=gen_random_uuid(); waiver_text text; first_name text; secret text;
  svc constant uuid:='00000000-0000-4000-8000-000000000414'; sess hon.class_sessions%ROWTYPE; appt uuid; trial jsonb;
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
  -- The starter's authority, held still for this transaction: row locks (not table locks, on this public path) on the starter's
  -- principal, live grants at this school, their matching role permissions and the entitlement rows, then decided again. A
  -- revocation or an entitlement end waits for this visit, or this visit waits for it and then sees it.
  PERFORM 1 FROM hon.principals WHERE id=d.started_by FOR SHARE;
  PERFORM 1 FROM hon.principal_role_grants g WHERE g.principal_id=d.started_by AND g.organization_id=d.organization_id AND g.revoked_at IS NULL ORDER BY g.id FOR SHARE;
  PERFORM 1 FROM hon.role_permissions rp WHERE rp.organization_id=d.organization_id AND rp.permission_code='walkin_kiosk.run'
    AND rp.role_id IN (SELECT g.role_id FROM hon.principal_role_grants g WHERE g.principal_id=d.started_by AND g.organization_id=d.organization_id)
    ORDER BY rp.role_id FOR SHARE;
  PERFORM 1 FROM hon.organization_entitlements e WHERE e.organization_id=d.organization_id FOR SHARE;
  IF NOT hon.walkin_principal_holds(d.started_by,d.organization_id,d.school_id,'walkin_kiosk.run') THEN RETURN jsonb_build_object('result','CLOSED'); END IF;
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
      'thankYou',k.thank_you->>x.language,'trialClass',hon.walkin_trial_class_json(x));
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
  -- T2: the picked class, locked so two tablets cannot both take its last spot. Gone, started, outside the offer's programs
  -- or without room for everyone on this visit: CLASS_FULL (the tablet reloads the classes), nothing written.
  IF v->>'trialSessionId' IS NOT NULL THEN
    SELECT * INTO sess FROM hon.class_sessions s WHERE s.id=(v->>'trialSessionId')::uuid AND s.organization_id=d.organization_id AND s.school_id=d.school_id FOR UPDATE;
    IF NOT FOUND OR NOT hon.walkin_trial_session_open(sess,v->'offer'->'programIds',
        (CASE WHEN (v->'contact'->>'isParticipant')::boolean THEN 1 ELSE 0 END)+jsonb_array_length(v->'children')) THEN
      RETURN jsonb_build_object('result','CLASS_FULL'); END IF;
  END IF;
  ph:=encode(sha256(convert_to(secret||':payload:'||p::text,'UTF8')),'hex');
  waiver_text:=coalesce(nullif(k.waiver->>(v->>'language'),''),k.waiver->>'en');
  -- People, lead, consent, visit, participants, signature.
  INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164)
    VALUES(d.organization_id,d.school_id,v->'contact'->>'givenName',v->'contact'->>'familyName',nullif(v->'contact'->>'email','')::public.citext,nullif(v->'contact'->>'mobile',''))
    RETURNING id INTO contact;
  INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,source_code,attribution)
    VALUES(lead,d.organization_id,d.school_id,contact,k.pipeline_id,k.pipeline_stage_id,'WALK_IN_KIOSK',
      jsonb_build_object('walkInKiosk',jsonb_build_object('visitId',visit,'deviceId',d.id,'offerKey',v->'offer'->>'key')));
  -- T2: the trial, as the CRM trial command writes it (0043 shape, one active trial per lead), by the kiosk service principal.
  IF sess.id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hon.crm.trial:'||lead::text,0));
    INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,location,created_by_principal_id)
      VALUES(d.organization_id,d.school_id,lead,'TRIAL','SCHEDULED',sess.starts_at,sess.ends_at,nullif(left(btrim(sess.name),160),''),svc) RETURNING id INTO appt;
  END IF;
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
      price_minor,currency,emergency_name,emergency_phone,heard_from,marketing_opt_in,local_date,payment_state,key_hash,payload_hash,trial_session_id,trial_appointment_id)
    VALUES(visit,d.organization_id,d.school_id,d.id,lead,contact,v->>'language',k.version,v->'offer'->>'key',v->'offer'->>'kind',
      coalesce(nullif(v->'offer'->'name'->>(v->>'language'),''),v->'offer'->'name'->>'en'),(v->'offer'->>'priceMinor')::integer,'USD',
      v->'emergency'->>'name',v->'emergency'->>'phone',v->>'heardFrom',(v->>'marketingOptIn')::boolean,today,
      CASE WHEN (v->'offer'->>'priceMinor')::integer=0 THEN 'FREE' ELSE 'PAY_AT_DESK' END,kh,ph,sess.id,appt) RETURNING * INTO x;
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
  IF appt IS NOT NULL THEN
    trial:=jsonb_build_object('appointmentId',appt,'crmLeadId',lead,'appointmentType','TRIAL','status','SCHEDULED','startsAt',hon.walkin_utc(sess.starts_at),
      'endsAt',hon.walkin_utc(sess.ends_at),'location',nullif(left(btrim(sess.name),160),''),'notes',NULL,'createdByPrincipalId',svc,'version',1,
      'classSessionId',sess.id,'walkInVisitId',visit);
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
      VALUES(d.organization_id,d.school_id,svc,'PUBLIC_API','crm.trial.schedule','CRM_APPOINTMENT',appt,trial,'SUCCEEDED',request,request);
    INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(d.organization_id,d.school_id,'crm.trial.scheduled',1,'CRM_APPOINTMENT',appt,1,request,request,trial);
  END IF;
  -- Decided again after the last write: if the tablet is no longer live, nothing above commits.
  IF (hon.walkin_live_device(digest)).id IS DISTINCT FROM d.id THEN RAISE EXCEPTION 'WALKIN_KIOSK_CLOSED' USING ERRCODE='42501'; END IF;
  first_name:=CASE WHEN (v->'contact'->>'isParticipant')::boolean THEN v->'contact'->>'givenName' ELSE v->'children'->0->>'givenName' END;
  RETURN jsonb_build_object('result','RECORDED','firstName',first_name,'paymentState',x.payment_state,'priceMinor',x.price_minor,
    'thankYou',k.thank_you->>x.language,'trialClass',hon.walkin_trial_class_json(x));
END $$;

-- T4: the staff visit read, with trialClass.
CREATE OR REPLACE FUNCTION hon.walkin_visit_json(v hon.walkin_visits) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('visitId',v.id,'leadId',v.lead_id,'createdAt',hon.walkin_utc(v.created_at),'localDate',to_char(v.local_date,'YYYY-MM-DD'),
    'language',v.language,'offer',jsonb_build_object('key',v.offer_key,'kind',v.offer_kind,'name',v.offer_name,'priceMinor',v.price_minor,'currency',v.currency),
    'paymentState',v.payment_state,'deskMethod',v.desk_method,'deskPaidAt',hon.walkin_utc(v.desk_paid_at),'cardPaidAt',hon.walkin_utc(v.card_paid_at),
    'contact',(SELECT jsonb_build_object('givenName',p.given_name,'familyName',p.family_name,'email',p.email::text,'mobile',p.phone_e164) FROM hon.people p WHERE p.id=v.contact_person_id),
    'participants',coalesce((SELECT jsonb_agg(jsonb_build_object('givenName',x.given_name,'familyName',x.family_name,'birthDate',to_char(x.birth_date,'YYYY-MM-DD'),
      'isContact',x.is_contact,'isMinor',x.is_minor) ORDER BY x.ordinal) FROM hon.walkin_visit_participants x WHERE x.visit_id=v.id),'[]'::jsonb),
    'emergencyName',v.emergency_name,'emergencyPhone',v.emergency_phone,'heardFrom',v.heard_from,'marketingOptIn',v.marketing_opt_in,
    'waiverSignedAt',(SELECT hon.walkin_utc(s.signed_at) FROM hon.walkin_waiver_signatures s WHERE s.visit_id=v.id),
    'trialClass',hon.walkin_trial_class_json(v),'version',v.version)
$$;

-- T5: desk paid passes the staff request's correlation id to the card-paid step.
CREATE OR REPLACE FUNCTION hon.set_walkin_visit_desk_paid(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  v hon.walkin_visits%ROWTYPE; result jsonb; pay uuid; s jsonb;
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
  -- K3: lock order visit -> payment (the tablet paths take the same order).
  pay:=hon.walkin_card_payment_of(v);
  IF pay IS NOT NULL THEN
    s:=hon.school_pay_once_state(pay);
    IF s->>'state'='OPEN' THEN
      IF (s->>'providerOpen')::boolean THEN RAISE EXCEPTION 'WALKIN_CARD_PAYMENT_OPEN' USING ERRCODE='40001'; END IF;
      s:=hon.school_pay_once_cancel(pay);
    ELSIF s->>'state'='PROCESSING' THEN RAISE EXCEPTION 'WALKIN_CARD_PAYMENT_IN_PROGRESS' USING ERRCODE='40001';
    ELSIF s->>'state'='SUCCEEDED' THEN
      v:=hon.walkin_card_paid(v,s,actor,'HUMAN_UI',request,correlation);
      result:=jsonb_build_object('visit',hon.walkin_visit_json(v));
      UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
        WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
      IF hon.require_walkin_actor(subject,'walkin_kiosk.run') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
      RETURN jsonb_build_object('receipt',result,'replayed',false);
    END IF;
  END IF;
  UPDATE hon.walkin_visits SET payment_state='PAID_AT_DESK',desk_method=p->>'method',desk_paid_at=clock_timestamp(),desk_paid_by=actor,
    version=version+1,updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
  result:=jsonb_build_object('visit',hon.walkin_visit_json(v));
  PERFORM hon.walkin_command_finish(subject,'walkin_kiosk.run',key,actor,result,'walkin_kiosk.visit.desk_paid','WALKIN_VISIT',v.id,
    jsonb_build_object('visitId',v.id,'paymentState','PAY_AT_DESK','version',v.version-1),
    jsonb_build_object('visitId',v.id,'paymentState',v.payment_state,'version',v.version),'walkin_kiosk.visit_desk_paid',v.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

COMMENT ON COLUMN hon.walkin_visits.trial_session_id IS '0537 the class this trial visit booked (T2).';
COMMENT ON COLUMN hon.walkin_visits.trial_appointment_id IS '0537 the CRM TRIAL appointment the kiosk wrote for this visit (T2).';

DO $$ DECLARE r text; f text; fns text[]:=ARRAY['hon.walkin_session_taken(uuid)','hon.walkin_trial_session_open(hon.class_sessions,jsonb,integer)',
    'hon.walkin_trial_classes(uuid,uuid,jsonb)','hon.walkin_trial_class_json(hon.walkin_visits)',
    'hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid,uuid)','hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)']; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.walkin_visits','SELECT,INSERT,UPDATE,DELETE')
      OR has_function_privilege('hon_runtime','hon.walkin_session_taken(uuid)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_trial_session_open(hon.class_sessions,jsonb,integer)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_trial_classes(uuid,uuid,jsonb)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_trial_class_json(hon.walkin_visits)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid,uuid)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_visit_input(hon.walkin_kiosk_settings,jsonb,date)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_settings_input(jsonb)','EXECUTE')) THEN
    RAISE EXCEPTION 'Walk-in kiosk trial class must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
