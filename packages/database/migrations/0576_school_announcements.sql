BEGIN;

-- School announcements (0576, assigned by the coordinator 2026-11-19; docs/architecture/PARENT_ACCOUNT_BOOKING_AND_MESSAGES.md).
-- The owner asked for announcements the school pushes out from the CRM to the HON Family app's Home screen.
--   A1  Staff with family_messages.manage (0330; the staff who already write to families) post an announcement to every
--       family of their school: a title of 1-120 characters and a plain-text body of 1-2,000 characters. A posted
--       announcement never changes; staff can take it down (WITHDRAWN), which hides it from families at once.
--   A2  Families with one live grant at the school (any access level, VIEWER included) read the school's live
--       announcements from the last 60 days, newest first, at most 20. Staff identity is never shown; families see the school.
--   A3  Nothing is texted, emailed or pushed to a phone yet. The outbox events are inert notices with ids only.
--   A4  At most 20 announcements per school per day, counted exactly under a per-school transaction lock.
-- School, organization and entitlement must be live, and authority is checked again after the locks and writes. Posting and
-- taking down have exact-request idempotency. The runtime gains no table privilege: entry points are SECURITY DEFINER.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School announcements require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School announcements require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.parent_class_booking_scope(text,boolean)') IS NULL OR to_regprocedure('hon.require_family_messages_actor(text)') IS NULL
    OR to_regprocedure('hon.family_message_body_ok(text)') IS NULL OR to_regprocedure('hon.family_message_begin(uuid,text,text)') IS NULL
    OR to_regprocedure('hon.family_message_time(timestamp with time zone)') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'School announcements require 0177, 0329 and 0330';
  END IF;
END $$;

-- A title: 1-120 characters on one line, not blank, no control characters.
CREATE FUNCTION hon.school_announcement_title_ok(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND length(v) BETWEEN 1 AND 120 AND btrim(v)<>'' AND v !~ E'[\\x01-\\x1f\\x7f]'
$$;

CREATE TABLE hon.school_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  title text NOT NULL CHECK (hon.school_announcement_title_ok(title)),
  body text NOT NULL CHECK (hon.family_message_body_ok(body)),
  status text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','WITHDRAWN')),
  author_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  withdrawn_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  CHECK ((status='WITHDRAWN')=(withdrawn_at IS NOT NULL AND withdrawn_by_principal_id IS NOT NULL)),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX school_announcements_school_time ON hon.school_announcements(school_id,published_at DESC,id);
ALTER TABLE hon.school_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_announcements FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_announcements_no_truncate BEFORE TRUNCATE ON hon.school_announcements
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A posted announcement never changes and is never deleted; the only change is PUBLISHED to WITHDRAWN, once, with the version
-- moving on by exactly one.
CREATE FUNCTION hon.guard_school_announcement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'School announcements are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'PUBLISHED' THEN RAISE EXCEPTION 'A new school announcement is published at version 1' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.title<>OLD.title OR NEW.body<>OLD.body
    OR NEW.author_principal_id<>OLD.author_principal_id OR NEW.published_at<>OLD.published_at OR NEW.version<>OLD.version+1
    OR OLD.status<>'PUBLISHED' OR NEW.status<>'WITHDRAWN' THEN
    RAISE EXCEPTION 'A school announcement can only be taken down once' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_announcements_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_announcements
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_announcement();

-- A2 parent side: the 0329 family scope (one live grant, tenant, principal, source, live school and entitlement), with its
-- own refusal code. Reading needs no guardian level.
CREATE FUNCTION hon.school_announcement_parent_scope(subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  BEGIN
    RETURN QUERY SELECT * FROM hon.parent_class_booking_scope(subject,false);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' USING ERRCODE='42501';
  END;
END $$;

-- A1 staff side: the 0330 family_messages.manage authority at the current school, with its own refusal code.
CREATE FUNCTION hon.require_school_announcements_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  BEGIN
    RETURN hon.require_family_messages_actor(subject);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' USING ERRCODE='42501';
  END;
END $$;

-- One announcement as a family sees it: no author, no status, no history.
CREATE FUNCTION hon.school_announcement_family_json(a hon.school_announcements) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('announcementId',a.id,'title',a.title,'body',a.body,'publishedAt',hon.family_message_time(a.published_at));
$$;

-- One announcement as staff see it: status and version for taking it down, never the author's identity.
CREATE FUNCTION hon.school_announcement_staff_json(a hon.school_announcements) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('announcementId',a.id,'title',a.title,'body',a.body,'status',a.status,'publishedAt',hon.family_message_time(a.published_at),
    'withdrawnAt',hon.family_message_time(a.withdrawn_at),'version',a.version);
$$;

-- A2 parent read: the school's live announcements from the last 60 days, newest first, at most 20.
CREATE FUNCTION hon.read_parent_school_announcements(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; school_name text; items jsonb;
BEGIN
  SELECT * INTO sc FROM hon.school_announcement_parent_scope(subject);
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=sc.school_id AND s.organization_id=sc.organization_id;
  SELECT coalesce(jsonb_agg(hon.school_announcement_family_json(x) ORDER BY x.published_at DESC, x.id),'[]') INTO items FROM (
    SELECT * FROM hon.school_announcements a WHERE a.organization_id=sc.organization_id AND a.school_id=sc.school_id AND a.status='PUBLISHED'
      AND a.published_at>clock_timestamp()-interval '60 days' ORDER BY a.published_at DESC, a.id LIMIT 20) x;
  RETURN jsonb_build_object('schoolName',school_name,'announcements',items);
END $$;

-- A1 staff list: the school's latest 100 announcements, live and taken down, newest first.
CREATE FUNCTION hon.read_school_announcements(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; items jsonb;
BEGIN
  actor:=hon.require_school_announcements_actor(subject);
  SELECT coalesce(jsonb_agg(hon.school_announcement_staff_json(x) ORDER BY x.published_at DESC, x.id),'[]') INTO items FROM (
    SELECT * FROM hon.school_announcements a WHERE a.organization_id=hon.current_organization_id() AND a.school_id=hon.current_school_id()
      ORDER BY a.published_at DESC, a.id LIMIT 100) x;
  IF hon.require_school_announcements_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('announcements',items);
END $$;

-- A1 + A4 post: under the per-school lock, check the daily limit, insert, audit, outbox and the idempotent result.
CREATE FUNCTION hon.publish_school_announcement(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; a hon.school_announcements; result jsonb; ids jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['body','title']
    OR jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR NOT hon.school_announcement_title_ok(p->>'title')
    OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR NOT hon.family_message_body_ok(p->>'body')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_announcements_actor(subject);
  prior:=hon.family_message_begin(actor,key,encode(sha256(convert_to('school_announcement.publish:'||(p->>'title')||E'\n'||(p->>'body'),'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_school_announcements_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_announcements:'||school::text,0));
  IF (SELECT count(*) FROM hon.school_announcements x WHERE x.school_id=school AND x.published_at>clock_timestamp()-interval '1 day')>=20 THEN
    RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_RATE_LIMITED' USING ERRCODE='53400'; END IF;
  INSERT INTO hon.school_announcements(organization_id,school_id,title,body,author_principal_id)
    VALUES(org,school,p->>'title',p->>'body',actor) RETURNING * INTO a;
  result:=jsonb_build_object('announcement',hon.school_announcement_staff_json(a));
  ids:=jsonb_build_object('announcementId',a.id,'status',a.status,'version',a.version);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','school_announcement.publish','SCHOOL_ANNOUNCEMENT',a.id,NULL,ids,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'school_announcement.published',1,'SCHOOL_ANNOUNCEMENT',a.id,a.version,correlation,request,ids);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  -- Authority is checked again after every lock and write of the command.
  IF hon.require_school_announcements_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- A1 take down: exact version, once. Taking down one that is already down is VERSION_CONFLICT with nothing changed.
CREATE FUNCTION hon.withdraw_school_announcement(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; a hon.school_announcements; result jsonb; ids jsonb; target uuid; expected integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['announcementId','expectedVersion']
    OR jsonb_typeof(p->'announcementId') IS DISTINCT FROM 'string' OR p->>'announcementId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=(p->>'announcementId')::uuid; expected:=(p->>'expectedVersion')::integer;
  actor:=hon.require_school_announcements_actor(subject);
  prior:=hon.family_message_begin(actor,key,encode(sha256(convert_to('school_announcement.withdraw:'||target||':'||expected,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_school_announcements_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  SELECT * INTO a FROM hon.school_announcements x WHERE x.id=target AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.version<>expected OR a.status<>'PUBLISHED' THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  UPDATE hon.school_announcements SET status='WITHDRAWN',withdrawn_at=clock_timestamp(),withdrawn_by_principal_id=actor,version=version+1
    WHERE id=a.id RETURNING * INTO a;
  result:=jsonb_build_object('announcement',hon.school_announcement_staff_json(a));
  ids:=jsonb_build_object('announcementId',a.id,'status',a.status,'version',a.version);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(a.organization_id,a.school_id,actor,'HUMAN_UI','school_announcement.withdraw','SCHOOL_ANNOUNCEMENT',a.id,
      jsonb_build_object('status','PUBLISHED','version',expected),ids,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(a.organization_id,a.school_id,'school_announcement.withdrawn',1,'SCHOOL_ANNOUNCEMENT',a.id,a.version,correlation,request,ids);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=a.organization_id AND school_id=a.school_id AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_announcements_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

COMMENT ON FUNCTION hon.read_parent_school_announcements(text) IS
'0576 parent read: the school''s live announcements from the last 60 days for the one live family grant, newest first, at most 20. No DML.';
COMMENT ON FUNCTION hon.publish_school_announcement(text,jsonb,text,uuid,uuid) IS
'0576 staff command (family_messages.manage): post an announcement to every family of the school; 20 per school per day; nothing is sent.';
COMMENT ON FUNCTION hon.withdraw_school_announcement(text,jsonb,text,uuid,uuid) IS
'0576 staff command (family_messages.manage): take a live announcement down at its exact version, once.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_parent_school_announcements(text)','hon.read_school_announcements(text)',
    'hon.publish_school_announcement(text,jsonb,text,uuid,uuid)','hon.withdraw_school_announcement(text,jsonb,text,uuid,uuid)'];
  fns text[]:=ARRAY['hon.school_announcement_title_ok(text)','hon.guard_school_announcement()','hon.school_announcement_parent_scope(text)',
    'hon.require_school_announcements_actor(text)','hon.school_announcement_family_json(hon.school_announcements)',
    'hon.school_announcement_staff_json(hon.school_announcements)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.school_announcements FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_announcements FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2<>ALL(entry) AND has_function_privilege('hon_runtime',f2,'EXECUTE'))
      OR has_table_privilege('hon_runtime','hon.school_announcements','SELECT') OR has_table_privilege('hon_runtime','hon.school_announcements','INSERT') THEN
      RAISE EXCEPTION 'School announcement helpers and table must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
