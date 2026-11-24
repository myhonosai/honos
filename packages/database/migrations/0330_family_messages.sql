BEGIN;

-- Family messages (0330, assigned by the coordinator 2026-11-13; docs/architecture/PARENT_ACCOUNT_BOOKING_AND_MESSAGES.md).
-- The owner asked to finish the product; parents message the school from their own account and staff reply inside HON.
--   B1  One thread per family and school. A PRIMARY_GUARDIAN or SECONDARY_GUARDIAN with exactly one live family grant writes a
--       plain-text message of 1-2,000 characters; the thread is created by the first family message. VIEWER grants read
--       only. Staff with the new staff-assignable permission family_messages.manage (granted to system OWNER roles, which
--       may assign it to other staff roles) read every family thread of their school and reply to an existing thread.
--   B2  Staff see threads newest first with an unread count (family messages newer than the staff read mark); staff mark a
--       thread read explicitly, and a staff reply marks it read. Parents see the whole thread with the school's replies.
--       Staff names are never shown to families; families see "the school".
--   B3  Nothing is texted, emailed or pushed. The outbox events are inert notices with ids only.
--   B4  At most 30 family messages per family per hour and 600 messages per school per hour (a per-school transaction lock
--       makes the count exact). Message text lives only on the message row; audit and outbox carry ids and versions only.
-- School, organization and entitlement must be live, and authority is checked again after the locks and writes. Every send
-- and reply has exact-request idempotency. The runtime gains no table privilege: entry points are SECURITY DEFINER.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Family messages require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Family messages require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.parent_class_booking_scope(text,boolean)') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Family messages require 0177, 0224 and 0329';
  END IF;
END $$;

-- 0329 review follow-ups (P3), applied here so the reviewed 0329 file stays as it was merged:
--   the parent scope's own grant queries also require an ACTIVE family, as the API's first resolution (0071) does, which
--   family messages inherit; and a parent cancel audits the booking's real prior status (BOOKED or WAITLISTED).
CREATE OR REPLACE FUNCTION hon.parent_class_booking_scope(subject text, guardian boolean)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; r record;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT count(*) INTO n FROM (
    SELECT DISTINCT g.school_id,g.family_id FROM hon.users u
    JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    JOIN hon.family_access_grants g ON g.principal_id=p.id
    JOIN hon.families f ON f.id=g.family_id AND f.organization_id=g.organization_id AND f.school_id=g.school_id AND f.status='ACTIVE'
    WHERE u.external_subject=subject AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) x;
  IF n<>1 THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id pid,g.organization_id org,g.school_id school,g.family_id fam,g.access_level::text lvl INTO r
  FROM hon.users u
  JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
  JOIN hon.family_access_grants g ON g.principal_id=p.id
  JOIN hon.families f ON f.id=g.family_id AND f.organization_id=g.organization_id AND f.school_id=g.school_id AND f.status='ACTIVE'
  WHERE u.external_subject=subject AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
  ORDER BY CASE g.access_level WHEN 'PRIMARY_GUARDIAN' THEN 3 WHEN 'SECONDARY_GUARDIAN' THEN 2 ELSE 1 END DESC, g.effective_from DESC
  LIMIT 1;
  IF r.pid IS NULL
    OR r.pid::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
    OR r.org IS DISTINCT FROM hon.current_organization_id() OR r.school IS DISTINCT FROM hon.current_school_id()
    OR NOT EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=r.org AND o.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=r.school AND s.organization_id=r.org AND s.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=r.org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    OR (guardian AND r.lvl NOT IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN')) THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT r.pid,r.org,r.school,r.fam,r.lvl;
END $$;

CREATE OR REPLACE FUNCTION hon.cancel_parent_class_booking(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; booking uuid; expected integer; prior jsonb; s hon.class_sessions; b hon.class_bookings; session uuid; result jsonb; before jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)<>ARRAY['bookingId','expectedVersion']
    OR jsonb_typeof(p->'bookingId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number'
    OR p->>'bookingId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  booking:=(p->>'bookingId')::uuid; expected:=(p->>'expectedVersion')::integer;
  prior:=hon.parent_class_booking_begin(subject,key,encode(sha256(convert_to('cancel:'||booking||':'||expected,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('receipt',prior,'replayed',true); END IF;
  SELECT * INTO sc FROM hon.parent_class_booking_scope(subject,true);
  SELECT x.class_session_id INTO session FROM hon.class_bookings x WHERE x.id=booking AND x.organization_id=sc.organization_id AND x.school_id=sc.school_id;
  IF session IS NULL THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM hon.class_sessions WHERE id=session FOR UPDATE;
  SELECT * INTO b FROM hon.class_bookings WHERE id=booking FOR UPDATE;
  IF NOT hon.parent_class_booking_child_ok(sc.family_id,b.student_profile_id) THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF b.source<>'PARENT_APP' OR b.booking_kind<>'REGULAR' OR b.status NOT IN ('BOOKED','WAITLISTED') OR s.starts_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_NOT_CANCELLABLE' USING ERRCODE='P0002'; END IF;
  before:=jsonb_build_object('status',b.status::text,'version',b.version);
  UPDATE hon.class_bookings SET status='CANCELLED',cancelled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE id=b.id RETURNING * INTO b;
  result:=jsonb_build_object('booking',hon.parent_class_booking_json(b,s),'spotsLeft',greatest(s.capacity-hon.parent_class_booking_seats(s.id),0));
  PERFORM hon.parent_class_booking_finish(subject,key,sc.principal_id,result,'class_booking.parent_cancel',b.id,
    before,
    jsonb_build_object('bookingId',b.id,'sessionId',s.id,'studentProfileId',b.student_profile_id,'familyId',sc.family_id,'status','CANCELLED','version',b.version),
    'class_booking.parent_cancelled',b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('family_messages.manage','Read and reply to messages families send the school in the HON parent app',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='family_messages.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'family_messages.manage already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'family_messages.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- Plain text: 1-2,000 characters, not blank, no control characters except line breaks and tabs.
CREATE FUNCTION hon.family_message_body_ok(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND length(v) BETWEEN 1 AND 2000 AND btrim(v,E' \t\r\n')<>'' AND v !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'
$$;

CREATE TABLE hon.family_message_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count>=0),
  last_message_at timestamptz,
  last_from text CHECK (last_from IN ('FAMILY','SCHOOL')),
  staff_read_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (school_id,family_id),
  UNIQUE (id,organization_id,school_id,family_id),
  FOREIGN KEY (family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.family_message_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.family_message_threads FORCE ROW LEVEL SECURITY;

CREATE TABLE hon.family_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('FAMILY','SCHOOL')),
  author_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (hon.family_message_body_ok(body)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (thread_id,organization_id,school_id,family_id) REFERENCES hon.family_message_threads(id,organization_id,school_id,family_id) ON DELETE RESTRICT
);
CREATE INDEX family_messages_thread_time ON hon.family_messages(thread_id,created_at,id);
CREATE INDEX family_messages_school_time ON hon.family_messages(school_id,created_at);
ALTER TABLE hon.family_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.family_messages FORCE ROW LEVEL SECURITY;
-- Messages are append-only for every writer.
CREATE TRIGGER family_messages_immutable BEFORE UPDATE OR DELETE ON hon.family_messages
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER family_messages_no_truncate BEFORE TRUNCATE ON hon.family_messages
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER family_message_threads_no_truncate BEFORE TRUNCATE ON hon.family_message_threads
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Threads are never deleted, never move, and every update bumps the version by exactly one.
CREATE FUNCTION hon.guard_family_message_thread() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Family message threads are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.message_count<>0 THEN RAISE EXCEPTION 'A new family message thread starts empty at version 1' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.family_id<>OLD.family_id
    OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR NEW.message_count<OLD.message_count THEN
    RAISE EXCEPTION 'Family message thread scope and history are fixed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER family_message_threads_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.family_message_threads
  FOR EACH ROW EXECUTE FUNCTION hon.guard_family_message_thread();

-- B1 parent side: the 0329 family scope (one live grant, tenant, principal, source, live school and entitlement), with its
-- own refusal code.
CREATE FUNCTION hon.family_message_parent_scope(subject text, guardian boolean)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  BEGIN
    RETURN QUERY SELECT * FROM hon.parent_class_booking_scope(subject,guardian);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501';
  END;
END $$;

-- B1 staff side: live direct-human staff authority with family_messages.manage at the current school (the 0285 rules).
CREATE FUNCTION hon.require_family_messages_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
        AND x.code='family_messages.manage' AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.family_message_time(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN t IS NULL THEN NULL ELSE to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;

-- One message as a viewer sees it. Staff identity is never part of the projection; mine marks the viewer's own messages.
CREATE FUNCTION hon.family_message_json(m hon.family_messages, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('messageId',m.id,'from',m.author_kind,'mine',m.author_principal_id=viewer,'body',m.body,
    'sentAt',hon.family_message_time(m.created_at));
$$;

-- The latest 200 messages of one thread, oldest first.
CREATE FUNCTION hon.family_message_list(thread uuid, viewer uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(hon.family_message_json(x,viewer) ORDER BY x.created_at, x.id),'[]') FROM (
    SELECT * FROM hon.family_messages m WHERE m.thread_id=thread ORDER BY m.created_at DESC, m.id DESC LIMIT 200) x;
$$;

CREATE FUNCTION hon.family_message_unread(t hon.family_message_threads) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT count(*)::integer FROM hon.family_messages m WHERE m.thread_id=t.id AND m.author_kind='FAMILY'
    AND (t.staff_read_at IS NULL OR m.created_at>t.staff_read_at);
$$;

-- Moves the staff read mark of a locked thread up to one of its own messages, never back and never past it.
CREATE FUNCTION hon.family_message_read_through(t hon.family_message_threads, through uuid) RETURNS hon.family_message_threads
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE upto timestamptz; nt hon.family_message_threads;
BEGIN
  SELECT m.created_at INTO upto FROM hon.family_messages m WHERE m.id=through AND m.thread_id=t.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAMILY_MESSAGES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.family_messages m WHERE m.thread_id=t.id AND m.author_kind='FAMILY' AND m.created_at<=upto
      AND (t.staff_read_at IS NULL OR m.created_at>t.staff_read_at)) THEN RETURN t; END IF;
  UPDATE hon.family_message_threads SET staff_read_at=upto,version=version+1,updated_at=clock_timestamp() WHERE id=t.id RETURNING * INTO nt;
  RETURN nt;
END $$;

-- Exact-request idempotency for one actor: NULL when reserved now, else the earlier exact result.
CREATE FUNCTION hon.family_message_begin(actor uuid, key text, fp text) RETURNS jsonb
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

-- B4 + the write itself: under the per-school lock, check the hourly limits, append the message, move the thread on, and
-- record audit, outbox and the idempotent result. Text never leaves the message row.
CREATE FUNCTION hon.family_message_append(t hon.family_message_threads, actor uuid, author text, body text, key text, request uuid, correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE m hon.family_messages; nt hon.family_message_threads; result jsonb; ids jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.family_messages:'||t.school_id::text,0));
  IF author='FAMILY' AND (SELECT count(*) FROM hon.family_messages x WHERE x.thread_id=t.id AND x.author_kind='FAMILY'
      AND x.created_at>clock_timestamp()-interval '1 hour')>=30 THEN
    RAISE EXCEPTION 'FAMILY_MESSAGES_RATE_LIMITED' USING ERRCODE='53400'; END IF;
  IF (SELECT count(*) FROM hon.family_messages x WHERE x.school_id=t.school_id AND x.created_at>clock_timestamp()-interval '1 hour')>=600 THEN
    RAISE EXCEPTION 'FAMILY_MESSAGES_RATE_LIMITED' USING ERRCODE='53400'; END IF;
  INSERT INTO hon.family_messages(thread_id,organization_id,school_id,family_id,author_kind,author_principal_id,body)
    VALUES(t.id,t.organization_id,t.school_id,t.family_id,author,actor,body) RETURNING * INTO m;
  UPDATE hon.family_message_threads SET message_count=message_count+1,last_message_at=m.created_at,last_from=author,
    version=version+1,updated_at=clock_timestamp()
    WHERE id=t.id RETURNING * INTO nt;
  result:=jsonb_build_object('threadId',nt.id,'version',nt.version,'message',hon.family_message_json(m,actor));
  ids:=jsonb_build_object('threadId',nt.id,'messageId',m.id,'familyId',nt.family_id,'from',author,'version',nt.version);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(nt.organization_id,nt.school_id,actor,'HUMAN_UI',CASE author WHEN 'FAMILY' THEN 'family_message.family_send' ELSE 'family_message.staff_reply' END,
      'FAMILY_MESSAGE_THREAD',nt.id,jsonb_build_object('version',t.version,'messageCount',t.message_count),ids,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(nt.organization_id,nt.school_id,CASE author WHEN 'FAMILY' THEN 'family_message.family_sent' ELSE 'family_message.staff_replied' END,
      1,'FAMILY_MESSAGE_THREAD',nt.id,nt.version,correlation,request,ids);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=nt.organization_id AND school_id=nt.school_id AND principal_id=actor AND idempotency_key=key;
  RETURN result;
END $$;

-- B1/B2 parent read: the family's thread (empty before the first message). VIEWER sees canWrite false.
CREATE FUNCTION hon.read_parent_family_messages(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; t hon.family_message_threads; school_name text;
BEGIN
  SELECT * INTO sc FROM hon.family_message_parent_scope(subject,false);
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=sc.school_id;
  SELECT * INTO t FROM hon.family_message_threads x WHERE x.school_id=sc.school_id AND x.family_id=sc.family_id AND x.organization_id=sc.organization_id;
  RETURN jsonb_build_object('canWrite',sc.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN'),'schoolName',school_name,
    'threadId',t.id,'messages',CASE WHEN t.id IS NULL THEN '[]'::jsonb ELSE hon.family_message_list(t.id,sc.principal_id) END);
END $$;

-- B1 parent send.
CREATE FUNCTION hon.send_parent_family_message(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; prior jsonb; t hon.family_message_threads; result jsonb; live uuid; live_family uuid;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['body']
    OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR NOT hon.family_message_body_ok(p->>'body')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO sc FROM hon.family_message_parent_scope(subject,true);
  prior:=hon.family_message_begin(sc.principal_id,key,encode(sha256(convert_to('family_message.send:'||(p->>'body'),'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    PERFORM hon.family_message_parent_scope(subject,true);
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  INSERT INTO hon.family_message_threads(organization_id,school_id,family_id) VALUES(sc.organization_id,sc.school_id,sc.family_id)
    ON CONFLICT (school_id,family_id) DO NOTHING;
  SELECT * INTO t FROM hon.family_message_threads x WHERE x.school_id=sc.school_id AND x.family_id=sc.family_id AND x.organization_id=sc.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  result:=hon.family_message_append(t,sc.principal_id,'FAMILY',p->>'body',key,request,correlation);
  -- Authority is checked again after every lock and write of the command.
  SELECT x.principal_id, x.family_id INTO live, live_family FROM hon.family_message_parent_scope(subject,true) x;
  IF live IS DISTINCT FROM sc.principal_id OR live_family IS DISTINCT FROM sc.family_id THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- B2 staff inbox: the school's threads, newest first, with unread counts. No message text.
CREATE FUNCTION hon.read_family_message_inbox(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; threads jsonb; result jsonb;
BEGIN
  actor:=hon.require_family_messages_actor(subject);
  SELECT coalesce(jsonb_agg(j ORDER BY at DESC, id),'[]') INTO threads FROM (
    SELECT t.id, t.last_message_at at, jsonb_build_object('threadId',t.id,'familyId',t.family_id,'familyName',f.display_name,
      'lastMessageAt',hon.family_message_time(t.last_message_at),'lastFrom',t.last_from,'messageCount',t.message_count,
      'unreadCount',hon.family_message_unread(t),'version',t.version) j
    FROM hon.family_message_threads t JOIN hon.families f ON f.id=t.family_id AND f.organization_id=t.organization_id AND f.school_id=t.school_id
    WHERE t.organization_id=hon.current_organization_id() AND t.school_id=hon.current_school_id() AND t.message_count>0
    ORDER BY t.last_message_at DESC, t.id LIMIT 200) x;
  result:=jsonb_build_object('threads',threads,'unreadThreads',(SELECT count(*) FROM jsonb_array_elements(threads) e WHERE (e->>'unreadCount')::integer>0));
  IF hon.require_family_messages_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- B2 staff thread read (read only; marking read is its own command).
CREATE FUNCTION hon.read_family_message_thread(subject text, thread uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; t hon.family_message_threads; fam text; result jsonb;
BEGIN
  IF thread IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_family_messages_actor(subject);
  SELECT * INTO t FROM hon.family_message_threads x WHERE x.id=thread AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'FAMILY_MESSAGES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT f.display_name INTO fam FROM hon.families f WHERE f.id=t.family_id AND f.organization_id=t.organization_id AND f.school_id=t.school_id;
  result:=jsonb_build_object('threadId',t.id,'familyId',t.family_id,'familyName',fam,'version',t.version,'unreadCount',hon.family_message_unread(t),
    'messages',hon.family_message_list(t.id,actor));
  IF hon.require_family_messages_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- B2 staff mark read: moves the staff read mark up to the newest message the staff member loaded (throughMessageId), never
-- past it, so a family message that arrives after the thread was loaded stays unread. Repeating it is harmless: no key.
CREATE FUNCTION hon.mark_family_message_thread_read(subject text, p jsonb, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; t hon.family_message_threads; thread uuid;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['threadId','throughMessageId']
    OR jsonb_typeof(p->'threadId') IS DISTINCT FROM 'string' OR p->>'threadId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'throughMessageId') IS DISTINCT FROM 'string' OR p->>'throughMessageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR request IS NULL OR correlation IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  thread:=(p->>'threadId')::uuid;
  actor:=hon.require_family_messages_actor(subject);
  SELECT * INTO t FROM hon.family_message_threads x WHERE x.id=thread AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAMILY_MESSAGES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  t:=hon.family_message_read_through(t,(p->>'throughMessageId')::uuid);
  IF hon.require_family_messages_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('threadId',t.id,'version',t.version,'unreadCount',hon.family_message_unread(t));
END $$;

-- B1 staff reply to an existing family thread. The reply also marks read up to throughMessageId, the newest message the
-- staff member loaded. It is not part of the request fingerprint, so a retry after a refresh replays the first reply.
CREATE FUNCTION hon.reply_family_message(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; t hon.family_message_threads; thread uuid; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['body','threadId','throughMessageId']
    OR jsonb_typeof(p->'threadId') IS DISTINCT FROM 'string' OR p->>'threadId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'throughMessageId') IS DISTINCT FROM 'string' OR p->>'throughMessageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR NOT hon.family_message_body_ok(p->>'body')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  thread:=(p->>'threadId')::uuid;
  actor:=hon.require_family_messages_actor(subject);
  prior:=hon.family_message_begin(actor,key,encode(sha256(convert_to('family_message.reply:'||thread||':'||(p->>'body'),'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_family_messages_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  SELECT * INTO t FROM hon.family_message_threads x WHERE x.id=thread AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND OR t.message_count=0 THEN RAISE EXCEPTION 'FAMILY_MESSAGES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  t:=hon.family_message_read_through(t,(p->>'throughMessageId')::uuid);
  result:=hon.family_message_append(t,actor,'SCHOOL',p->>'body',key,request,correlation);
  IF hon.require_family_messages_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.read_parent_family_messages(text)','hon.send_parent_family_message(text,jsonb,text,uuid,uuid)',
    'hon.read_family_message_inbox(text)','hon.read_family_message_thread(text,uuid)','hon.mark_family_message_thread_read(text,jsonb,uuid,uuid)',
    'hon.reply_family_message(text,jsonb,text,uuid,uuid)'];
  fns text[]:=ARRAY['hon.family_message_body_ok(text)','hon.guard_family_message_thread()','hon.family_message_parent_scope(text,boolean)',
    'hon.require_family_messages_actor(text)','hon.family_message_time(timestamp with time zone)','hon.family_message_json(hon.family_messages,uuid)',
    'hon.family_message_list(uuid,uuid)','hon.family_message_unread(hon.family_message_threads)','hon.family_message_read_through(hon.family_message_threads,uuid)','hon.family_message_begin(uuid,text,text)',
    'hon.family_message_append(hon.family_message_threads,uuid,text,text,text,uuid,uuid)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['family_message_threads','family_messages'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2<>ALL(entry) AND has_function_privilege('hon_runtime',f2,'EXECUTE'))
      OR has_table_privilege('hon_runtime','hon.family_message_threads','SELECT') OR has_table_privilege('hon_runtime','hon.family_messages','SELECT') THEN
      RAISE EXCEPTION 'Family message helpers and tables must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
