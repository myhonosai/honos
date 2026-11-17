BEGIN;

-- Parent account bookings of event slots and families-only booking types (0457, renumbered from 0360, 0431, 0441 and 0448 by the coordinator 2026-11-17;
-- docs/architecture/PARENT_ACCOUNT_BOOKING_AND_MESSAGES.md A4, which is also booking types part 3's family path).
--   P1  The same parent authority as 0329: a signed-in parent with exactly one live family grant, school, organization and
--       entitlement live, checked again after the locks and writes. VIEWER grants read only.
--   P2  Choices: the school's PUBLISHED 0261 events with slots still to start (open spots only, never other families), the
--       ACTIVE 0286 FAMILIES_ONLY booking types with their open times, and the family's own upcoming bookings of both.
--   P3  Book an event slot or a booking type time with the family's details filled in from the account: the family's display
--       name and the signed-in parent's sign-in email. The same rules as the public paths apply: the event or type is live,
--       the time is offered, a spot is free, and one live booking per email per event (and one future booking per email per
--       type). On top of that, one live booking per family per event and one future booking per family per type. Answers and
--       the waiver of a type are checked by the 0286 input rule.
--   P4  Cancel a booking the family made from the account, before it starts. Staff and public-link bookings are not touched.
-- Lock order: organization -> school -> family -> event -> slot -> booking, and organization -> school -> family -> type ->
-- booking. The public paths take organization -> school -> event/type -> slot -> booking and never lock a family, and the
-- staff paths take event/type -> booking, so no cycle is added. The family lock serializes two guardians of one family.
-- Every write has exact-request idempotency, an audit event and an inert outbox event (ids and version only). The runtime
-- gains no table privilege: four SECURITY DEFINER entry points take only the signed-in subject and a closed body.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Parent school bookings require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Parent school bookings require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.parent_class_booking_scope(text,boolean)') IS NULL OR to_regprocedure('hon.parent_class_booking_begin(text,text,text)') IS NULL
    OR to_regprocedure('hon.school_event_slot_taken(uuid)') IS NULL OR to_regprocedure('hon.school_booking_type_booking_input(hon.school_booking_types,jsonb)') IS NULL
    OR to_regprocedure('hon.school_booking_type_times(hon.school_booking_types,text,integer)') IS NULL
    OR to_regprocedure('hon.school_booking_type_time_ok(hon.school_booking_types,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Parent school bookings require 0261, 0286, 0329 and 0330';
  END IF;
END $$;

-- Which bookings a family made from the account. Insert only; the booking rows themselves stay in the 0261 and 0286 tables.
CREATE TABLE hon.parent_school_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('EVENT','BOOKING_TYPE')),
  event_booking_id uuid UNIQUE REFERENCES hon.school_event_bookings(id) ON DELETE RESTRICT,
  type_booking_id uuid UNIQUE REFERENCES hon.school_booking_type_bookings(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind='EVENT')=(event_booking_id IS NOT NULL) AND (kind='BOOKING_TYPE')=(type_booking_id IS NOT NULL)),
  FOREIGN KEY (family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX parent_school_bookings_family_idx ON hon.parent_school_bookings(organization_id,school_id,family_id,kind);
ALTER TABLE hon.parent_school_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.parent_school_bookings FORCE ROW LEVEL SECURITY;
CREATE TRIGGER parent_school_bookings_no_truncate BEFORE TRUNCATE ON hon.parent_school_bookings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

CREATE FUNCTION hon.guard_parent_school_booking() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  -- The booking must be of the same school as the family.
  IF (NEW.kind='EVENT' AND NOT EXISTS(SELECT 1 FROM hon.school_event_bookings b WHERE b.id=NEW.event_booking_id
        AND b.organization_id=NEW.organization_id AND b.school_id=NEW.school_id))
    OR (NEW.kind='BOOKING_TYPE' AND NOT EXISTS(SELECT 1 FROM hon.school_booking_type_bookings b WHERE b.id=NEW.type_booking_id
        AND b.organization_id=NEW.organization_id AND b.school_id=NEW.school_id)) THEN
    RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parent_school_bookings_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.parent_school_bookings FOR EACH ROW EXECUTE FUNCTION hon.guard_parent_school_booking();

-- P3: the details a booking from the account carries: the family's display name and the parent's sign-in email.
CREATE FUNCTION hon.parent_school_booking_contact(fam uuid, actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN hon.school_event_text_ok(f.display_name,1,120) AND length(u.email::text)<=254
      AND lower(u.email::text) ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$'
    THEN jsonb_build_object('name',f.display_name,'email',lower(u.email::text)) END
  FROM hon.families f, hon.principals p JOIN hon.users u ON u.id=p.user_id
  WHERE f.id=fam AND f.organization_id=hon.current_organization_id() AND f.school_id=hon.current_school_id() AND p.id=actor
$$;

-- One booking from the account, as the parent sees it.
CREATE FUNCTION hon.parent_school_booking_json(kind text, booking uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('kind','EVENT','bookingId',b.id,'parentId',e.id,'title',e.title,'localDate',to_char(e.local_date,'YYYY-MM-DD'),
      'localStart',to_char(s.local_start,'HH24:MI'),'localEnd',to_char(s.local_end,'HH24:MI'),'startsAt',hon.school_booking_type_utc(s.starts_at),
      'status',b.status,'version',b.version,'canCancel',b.status='BOOKED' AND s.starts_at>clock_timestamp())
    FROM hon.school_event_bookings b JOIN hon.school_events e ON e.id=b.event_id JOIN hon.school_event_slots s ON s.id=b.slot_id
    WHERE parent_school_booking_json.kind='EVENT' AND b.id=parent_school_booking_json.booking
  UNION ALL
  SELECT jsonb_build_object('kind','BOOKING_TYPE','bookingId',b.id,'parentId',t.id,'title',t.name,'localDate',to_char(b.local_date,'YYYY-MM-DD'),
      'localStart',to_char(b.local_start,'HH24:MI'),'localEnd',to_char(b.local_start+make_interval(mins=>((extract(epoch FROM b.ends_at-b.starts_at))::integer/60)),'HH24:MI'),
      'startsAt',hon.school_booking_type_utc(b.starts_at),'status',b.status,'version',b.version,'canCancel',b.status='BOOKED' AND b.starts_at>clock_timestamp())
    FROM hon.school_booking_type_bookings b JOIN hon.school_booking_types t ON t.id=b.type_id
    WHERE parent_school_booking_json.kind='BOOKING_TYPE' AND b.id=parent_school_booking_json.booking
$$;

-- The family's live account booking of one event, or of one booking type from now on (NULL when there is none).
CREATE FUNCTION hon.parent_school_booking_live(fam uuid, kind text, parent uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT b.id FROM hon.parent_school_bookings l JOIN hon.school_event_bookings b ON b.id=l.event_booking_id
    WHERE parent_school_booking_live.kind='EVENT' AND l.family_id=fam AND l.kind='EVENT' AND b.event_id=parent AND b.status<>'CANCELLED'
  UNION ALL
  SELECT b.id FROM hon.parent_school_bookings l JOIN hon.school_booking_type_bookings b ON b.id=l.type_booking_id
    WHERE parent_school_booking_live.kind='BOOKING_TYPE' AND l.family_id=fam AND l.kind='BOOKING_TYPE' AND b.type_id=parent AND b.status<>'CANCELLED' AND b.starts_at>=clock_timestamp()
  LIMIT 1
$$;

CREATE FUNCTION hon.parent_school_booking_finish(subject text, key text, actor uuid, fam uuid, kind text, booking uuid, result jsonb, action text,
  event_type text, prior_state jsonb, next_state jsonb, booking_version integer, request uuid, correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); live record;
  entity text:=CASE kind WHEN 'EVENT' THEN 'SCHOOL_EVENT_BOOKING' ELSE 'SCHOOL_BOOKING_TYPE_BOOKING' END;
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,entity,booking,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event_type,1,entity,booking,booking_version,correlation,request,next_state||jsonb_build_object('internalOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  -- Authority is checked again after every lock and write of the command, for the same parent and the same family.
  SELECT principal_id,family_id INTO live FROM hon.parent_class_booking_scope(subject,true);
  IF live.principal_id IS DISTINCT FROM actor OR live.family_id IS DISTINCT FROM fam THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- The shared start of a booking command: scope, contact and the family lock (after the organization and school).
CREATE FUNCTION hon.parent_school_booking_lock(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; contact jsonb; tz text;
BEGIN
  SELECT * INTO sc FROM hon.parent_class_booking_scope(subject,true);
  PERFORM 1 FROM hon.organizations WHERE id=sc.organization_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT timezone INTO tz FROM hon.schools WHERE id=sc.school_id AND organization_id=sc.organization_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM hon.families WHERE id=sc.family_id AND organization_id=sc.organization_id AND school_id=sc.school_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  contact:=hon.parent_school_booking_contact(sc.family_id,sc.principal_id);
  RETURN jsonb_build_object('principalId',sc.principal_id,'familyId',sc.family_id,'timezone',tz,'contact',contact);
END $$;

-- P2: choices. Read only; VIEWER sees canBook false.
CREATE FUNCTION hon.read_parent_school_bookings(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; tz text; events jsonb; types jsonb; mine jsonb;
BEGIN
  SELECT * INTO sc FROM hon.parent_class_booking_scope(subject,false);
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=sc.school_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',e.id,'title',e.title,'description',e.description,'place',e.place,
      'localDate',to_char(e.local_date,'YYYY-MM-DD'),'bookingId',hon.parent_school_booking_live(sc.family_id,'EVENT',e.id),
      'slots',(SELECT coalesce(jsonb_agg(jsonb_build_object('slotId',s.id,'localStart',to_char(s.local_start,'HH24:MI'),'localEnd',to_char(s.local_end,'HH24:MI'),
          'startsAt',hon.school_booking_type_utc(s.starts_at),'spotsLeft',greatest(e.spots_per_slot-hon.school_event_slot_taken(s.id),0)) ORDER BY s.position),'[]'::jsonb)
        FROM hon.school_event_slots s WHERE s.event_id=e.id AND s.starts_at>clock_timestamp()))
      ORDER BY e.local_date,e.id),'[]'::jsonb) INTO events
  FROM (SELECT * FROM hon.school_events x WHERE x.organization_id=sc.organization_id AND x.school_id=sc.school_id AND x.status='PUBLISHED'
        AND EXISTS(SELECT 1 FROM hon.school_event_slots s WHERE s.event_id=x.id AND s.starts_at>clock_timestamp())
        ORDER BY x.local_date,x.id LIMIT 20) e;
  SELECT coalesce(jsonb_agg(jsonb_build_object('typeId',x.id,'name',x.name,'description',x.description,'template',x.template,
      'durationMinutes',x.duration_minutes,'questions',x.questions,'waiver',x.waiver,'bookingId',hon.parent_school_booking_live(sc.family_id,'BOOKING_TYPE',x.id),
      'times',(SELECT coalesce(jsonb_agg(jsonb_build_object('startsAt',hon.school_booking_type_utc(t.starts_at),'localDate',to_char(t.local_date,'YYYY-MM-DD'),
          'localStart',to_char(t.local_start,'HH24:MI'),'localEnd',to_char(t.local_start+make_interval(mins=>x.duration_minutes),'HH24:MI'),
          'spotsLeft',greatest(x.spots_per_time-hon.school_booking_type_taken(x.id,t.starts_at),0)) ORDER BY t.starts_at),'[]'::jsonb)
        FROM hon.school_booking_type_times(x,tz,200) t))
      ORDER BY x.created_at,x.id),'[]'::jsonb) INTO types
  FROM (SELECT * FROM hon.school_booking_types y WHERE y.organization_id=sc.organization_id AND y.school_id=sc.school_id AND y.status='ACTIVE'
        AND y.audience='FAMILIES_ONLY' ORDER BY y.created_at,y.id LIMIT 20) x;
  SELECT coalesce(jsonb_agg(j ORDER BY j->>'startsAt',j->>'bookingId'),'[]'::jsonb) INTO mine FROM (
    SELECT hon.parent_school_booking_json(l.kind,coalesce(l.event_booking_id,l.type_booking_id)) j FROM hon.parent_school_bookings l
    LEFT JOIN hon.school_event_bookings eb ON eb.id=l.event_booking_id LEFT JOIN hon.school_event_slots es ON es.id=eb.slot_id
    LEFT JOIN hon.school_booking_type_bookings tb ON tb.id=l.type_booking_id
    WHERE l.organization_id=sc.organization_id AND l.school_id=sc.school_id AND l.family_id=sc.family_id
      AND coalesce(eb.status,tb.status)<>'CANCELLED' AND coalesce(es.ends_at,tb.ends_at)>clock_timestamp()
    ORDER BY coalesce(es.starts_at,tb.starts_at),l.id LIMIT 50) m;
  RETURN jsonb_build_object('canBook',sc.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN')
      AND hon.parent_school_booking_contact(sc.family_id,sc.principal_id) IS NOT NULL,
    'timezone',tz,'contact',hon.parent_school_booking_contact(sc.family_id,sc.principal_id),'events',events,'bookingTypes',types,'bookings',mine);
END $$;

-- P3: book one slot of a published event.
CREATE FUNCTION hon.book_parent_school_event_slot(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE slot uuid; prior jsonb; ctx jsonb; actor uuid; fam uuid; x hon.school_events%ROWTYPE; s hon.school_event_slots%ROWTYPE;
  b hon.school_event_bookings%ROWTYPE; kh text; code text; v jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)<>ARRAY['slotId']
    OR jsonb_typeof(p->'slotId') IS DISTINCT FROM 'string' OR p->>'slotId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  slot:=(p->>'slotId')::uuid;
  prior:=hon.parent_class_booking_begin(subject,key,encode(sha256(convert_to('school-event:'||slot,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('receipt',prior,'replayed',true); END IF;
  ctx:=hon.parent_school_booking_lock(subject);
  actor:=(ctx->>'principalId')::uuid; fam:=(ctx->>'familyId')::uuid;
  IF jsonb_typeof(ctx->'contact') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NO_CONTACT' USING ERRCODE='P0002'; END IF;
  SELECT e.* INTO x FROM hon.school_events e JOIN hon.school_event_slots y ON y.event_id=e.id
    WHERE y.id=slot AND e.organization_id=hon.current_organization_id() AND e.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NOT_OFFERED' USING ERRCODE='P0002'; END IF;
  SELECT * INTO x FROM hon.school_events WHERE id=x.id FOR SHARE;
  SELECT * INTO s FROM hon.school_event_slots WHERE id=slot AND event_id=x.id FOR UPDATE;
  IF x.status<>'PUBLISHED' OR s.starts_at<=clock_timestamp() THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NOT_OFFERED' USING ERRCODE='P0002'; END IF;
  IF hon.parent_school_booking_live(fam,'EVENT',x.id) IS NOT NULL
    OR EXISTS(SELECT 1 FROM hon.school_event_bookings y WHERE y.event_id=x.id AND y.status<>'CANCELLED' AND y.email=ctx#>>'{contact,email}') THEN
    RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_ALREADY_BOOKED' USING ERRCODE='23505'; END IF;
  IF hon.school_event_slot_taken(s.id)>=x.spots_per_slot THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_FULL' USING ERRCODE='23505'; END IF;
  v:=jsonb_build_object('slotId',slot,'name',ctx#>>'{contact,name}','email',ctx#>>'{contact,email}','mobile','');
  kh:=encode(sha256(convert_to(x.hash_secret||':key:account:'||actor||':'||key,'UTF8')),'hex');
  code:=upper(substr(encode(sha256(convert_to(x.hash_secret||':code:'||kh,'UTF8')),'hex'),1,12));
  INSERT INTO hon.school_event_bookings(event_id,slot_id,organization_id,school_id,family_name,email,mobile,key_hash,payload_hash,code_hash)
    VALUES(x.id,s.id,x.organization_id,x.school_id,ctx#>>'{contact,name}',ctx#>>'{contact,email}',NULL,kh,
      encode(sha256(convert_to(x.hash_secret||':payload:account:'||v::text,'UTF8')),'hex'),
      encode(sha256(convert_to(x.hash_secret||':code-check:'||code,'UTF8')),'hex')) RETURNING * INTO b;
  INSERT INTO hon.parent_school_bookings(organization_id,school_id,family_id,principal_id,kind,event_booking_id)
    VALUES(x.organization_id,x.school_id,fam,actor,'EVENT',b.id);
  result:=jsonb_build_object('booking',hon.parent_school_booking_json('EVENT',b.id),'spotsLeft',greatest(x.spots_per_slot-hon.school_event_slot_taken(s.id),0));
  PERFORM hon.parent_school_booking_finish(subject,key,actor,fam,'EVENT',b.id,result,'schedule.event.booking.parent_create','schedule.event.booking_created',NULL,
    jsonb_build_object('bookingId',b.id,'eventId',x.id,'slotId',s.id,'familyId',fam,'status',b.status,'version',b.version),b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- P3: book one time of an active families-only booking type.
CREATE FUNCTION hon.book_parent_school_booking_type(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE selected uuid; prior jsonb; ctx jsonb; actor uuid; fam uuid; x hon.school_booking_types%ROWTYPE; b hon.school_booking_type_bookings%ROWTYPE;
  v jsonb; s timestamptz; kh text; code text; tz text; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>6144
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)<>ARRAY['answers','startsAt','typeId','waiverAccepted']
    OR jsonb_typeof(p->'typeId') IS DISTINCT FROM 'string' OR p->>'typeId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'startsAt') IS DISTINCT FROM 'string' OR (p->>'startsAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\.000Z$'
    OR jsonb_typeof(p->'answers') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'waiverAccepted') IS DISTINCT FROM 'boolean'
    OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  selected:=(p->>'typeId')::uuid;
  prior:=hon.parent_class_booking_begin(subject,key,encode(sha256(convert_to('school-booking-type:'||p::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('receipt',prior,'replayed',true); END IF;
  ctx:=hon.parent_school_booking_lock(subject);
  actor:=(ctx->>'principalId')::uuid; fam:=(ctx->>'familyId')::uuid; tz:=ctx->>'timezone';
  IF jsonb_typeof(ctx->'contact') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NO_CONTACT' USING ERRCODE='P0002'; END IF;
  SELECT * INTO x FROM hon.school_booking_types WHERE id=selected AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND OR x.status<>'ACTIVE' OR x.audience<>'FAMILIES_ONLY' THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NOT_OFFERED' USING ERRCODE='P0002'; END IF;
  -- The answers and waiver follow the 0286 rule for this type, with the details from the account.
  v:=hon.school_booking_type_booking_input(x,jsonb_build_object('startsAt',p->>'startsAt','name',ctx#>>'{contact,name}','email',ctx#>>'{contact,email}',
    'mobile','','answers',p->'answers','waiverAccepted',p->'waiverAccepted','website',''));
  s:=(v->>'startsAt')::timestamptz;
  IF NOT hon.school_booking_type_time_ok(x,tz,s) THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NOT_OFFERED' USING ERRCODE='P0002'; END IF;
  IF hon.parent_school_booking_live(fam,'BOOKING_TYPE',x.id) IS NOT NULL
    OR EXISTS(SELECT 1 FROM hon.school_booking_type_bookings y WHERE y.type_id=x.id AND y.status<>'CANCELLED' AND y.starts_at>=clock_timestamp()
      AND y.email=v->>'email') THEN
    RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_ALREADY_BOOKED' USING ERRCODE='23505'; END IF;
  IF hon.school_booking_type_taken(x.id,s)>=x.spots_per_time THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_FULL' USING ERRCODE='23505'; END IF;
  kh:=encode(sha256(convert_to(x.hash_secret||':key:account:'||actor||':'||key,'UTF8')),'hex');
  code:=upper(substr(encode(sha256(convert_to(x.hash_secret||':code:'||kh,'UTF8')),'hex'),1,12));
  INSERT INTO hon.school_booking_type_bookings(type_id,organization_id,school_id,starts_at,ends_at,local_date,local_start,family_name,email,mobile,
      questions,answers,waiver_hash,waiver_accepted_at,key_hash,payload_hash,code_hash)
    VALUES(x.id,x.organization_id,x.school_id,s,s+make_interval(mins=>x.duration_minutes),(s AT TIME ZONE tz)::date,(s AT TIME ZONE tz)::time,
      v->>'name',v->>'email',NULL,x.questions,v->'answers',
      CASE WHEN x.waiver<>'' THEN encode(sha256(convert_to(x.waiver,'UTF8')),'hex') END,CASE WHEN x.waiver<>'' THEN clock_timestamp() END,
      kh,encode(sha256(convert_to(x.hash_secret||':payload:account:'||v::text,'UTF8')),'hex'),
      encode(sha256(convert_to(x.hash_secret||':code-check:'||code,'UTF8')),'hex')) RETURNING * INTO b;
  INSERT INTO hon.parent_school_bookings(organization_id,school_id,family_id,principal_id,kind,type_booking_id)
    VALUES(x.organization_id,x.school_id,fam,actor,'BOOKING_TYPE',b.id);
  result:=jsonb_build_object('booking',hon.parent_school_booking_json('BOOKING_TYPE',b.id),'spotsLeft',greatest(x.spots_per_time-hon.school_booking_type_taken(x.id,s),0));
  PERFORM hon.parent_school_booking_finish(subject,key,actor,fam,'BOOKING_TYPE',b.id,result,'schedule.booking_type.booking.parent_create',
    'schedule.booking_type.booking_created',NULL,jsonb_build_object('bookingId',b.id,'typeId',x.id,'familyId',fam,'status',b.status,'version',b.version),
    b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- P4: cancel a booking the family made from the account, before it starts.
CREATE FUNCTION hon.cancel_parent_school_booking(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE booking uuid; expected integer; prior jsonb; ctx jsonb; actor uuid; fam uuid; l hon.parent_school_bookings%ROWTYPE;
  eb hon.school_event_bookings%ROWTYPE; tb hon.school_booking_type_bookings%ROWTYPE; s hon.school_event_slots%ROWTYPE;
  nv integer; spots integer; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)<>ARRAY['bookingId','expectedVersion']
    OR jsonb_typeof(p->'bookingId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number'
    OR p->>'bookingId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  booking:=(p->>'bookingId')::uuid; expected:=(p->>'expectedVersion')::integer;
  prior:=hon.parent_class_booking_begin(subject,key,encode(sha256(convert_to('school-booking-cancel:'||booking||':'||expected,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('receipt',prior,'replayed',true); END IF;
  ctx:=hon.parent_school_booking_lock(subject);
  actor:=(ctx->>'principalId')::uuid; fam:=(ctx->>'familyId')::uuid;
  SELECT * INTO l FROM hon.parent_school_bookings x WHERE (x.event_booking_id=booking OR x.type_booking_id=booking)
    AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id() AND x.family_id=fam;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF l.kind='EVENT' THEN
    SELECT * INTO eb FROM hon.school_event_bookings WHERE id=booking;
    PERFORM 1 FROM hon.school_events WHERE id=eb.event_id FOR SHARE;
    SELECT * INTO s FROM hon.school_event_slots WHERE id=eb.slot_id FOR UPDATE;
    SELECT * INTO eb FROM hon.school_event_bookings WHERE id=booking FOR UPDATE;
    IF eb.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF eb.status<>'BOOKED' OR s.starts_at<=clock_timestamp() THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NOT_CANCELLABLE' USING ERRCODE='P0002'; END IF;
    UPDATE hon.school_event_bookings SET status='CANCELLED',cancelled_by='FAMILY',cancelled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
      WHERE id=booking RETURNING * INTO eb;
    nv:=eb.version;
    spots:=greatest((SELECT e.spots_per_slot FROM hon.school_events e WHERE e.id=eb.event_id)-hon.school_event_slot_taken(s.id),0);
  ELSE
    SELECT * INTO tb FROM hon.school_booking_type_bookings WHERE id=booking;
    PERFORM 1 FROM hon.school_booking_types WHERE id=tb.type_id FOR SHARE;
    SELECT * INTO tb FROM hon.school_booking_type_bookings WHERE id=booking FOR UPDATE;
    IF tb.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF tb.status<>'BOOKED' OR tb.starts_at<=clock_timestamp() THEN RAISE EXCEPTION 'PARENT_SCHOOL_BOOKING_NOT_CANCELLABLE' USING ERRCODE='P0002'; END IF;
    UPDATE hon.school_booking_type_bookings SET status='CANCELLED',cancelled_by='FAMILY',cancelled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
      WHERE id=booking RETURNING * INTO tb;
    nv:=tb.version;
    spots:=greatest((SELECT t.spots_per_time FROM hon.school_booking_types t WHERE t.id=tb.type_id)-hon.school_booking_type_taken(tb.type_id,tb.starts_at),0);
  END IF;
  result:=jsonb_build_object('booking',hon.parent_school_booking_json(l.kind,booking),'spotsLeft',spots);
  PERFORM hon.parent_school_booking_finish(subject,key,actor,fam,l.kind,booking,result,
    CASE l.kind WHEN 'EVENT' THEN 'schedule.event.booking.parent_cancel' ELSE 'schedule.booking_type.booking.parent_cancel' END,
    CASE l.kind WHEN 'EVENT' THEN 'schedule.event.booking_cancelled' ELSE 'schedule.booking_type.booking_cancelled' END,
    jsonb_build_object('status','BOOKED','version',expected),
    jsonb_build_object('bookingId',booking,'familyId',fam,'status','CANCELLED','version',nv),nv,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

COMMENT ON TABLE hon.parent_school_bookings IS '0457 event and booking type bookings a family made from the parent account. Insert only, private.';

DO $$ DECLARE r text; f text; t text; entry text[]:=ARRAY['hon.read_parent_school_bookings(text)',
  'hon.book_parent_school_event_slot(text,jsonb,text,uuid,uuid)','hon.book_parent_school_booking_type(text,jsonb,text,uuid,uuid)',
  'hon.cancel_parent_school_booking(text,jsonb,text,uuid,uuid)'];
  fns text[]:=ARRAY['hon.guard_parent_school_booking()','hon.parent_school_booking_contact(uuid,uuid)','hon.parent_school_booking_json(text,uuid)',
  'hon.parent_school_booking_live(uuid,text,uuid)',
  'hon.parent_school_booking_finish(text,text,uuid,uuid,text,uuid,jsonb,text,text,jsonb,jsonb,integer,uuid,uuid)',
  'hon.parent_school_booking_lock(text)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  EXECUTE 'REVOKE ALL ON TABLE hon.parent_school_bookings FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.parent_school_bookings FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2<>ALL(entry) AND has_function_privilege('hon_runtime',f2,'EXECUTE'))
      OR has_table_privilege('hon_runtime','hon.parent_school_bookings','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Parent school booking helpers must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
