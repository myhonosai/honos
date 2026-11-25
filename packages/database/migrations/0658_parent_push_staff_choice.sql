BEGIN;

-- Staff choose phone alerts per send (0658, assigned by the coordinator 2026-11-23; docs/architecture/PARENT_PUSH_STAFF_CHOICE.md).
-- The owner asked that every phone alert be optional, and that staff decide (David, 2026-11-23).
--   S1  An announcement (0576) is pushed only when staff tick "Also send as a phone alert" (phoneAlert true) when posting.
--       0601 pushed every announcement; from here an announcement posted without the tick is never pushed.
--   S2  A staff reply in parent app messages (0330) is pushed, when ticked, to the live phones of that family's members only.
--       The notification says the school's name and "You have a new message from the school.", never the message text.
--   S3  The choice is a private request row written by the staff command itself, audited, with exact-request idempotency:
--       the same key with a different choice is IDEMPOTENCY_KEY_REUSED. phoneAlert absent means false.
--   S4  The 0601 worker fans out only requested items under 24 hours old, once; the same leases, retries, receipts and
--       skips apply, and a family member who no longer has a live grant to that family is SKIPPED (NOT_LIVE).
-- Nothing sends unless the API is configured to (HON_PARENT_PUSH_APPROVED, off by default). The runtime and the worker
-- gain no table privilege.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Parent push staff choice requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Parent push staff choice requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.claim_parent_push_deliveries(integer,integer)') IS NULL OR to_regprocedure('hon.publish_school_announcement(text,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.reply_family_message(text,jsonb,text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Parent push staff choice requires 0330, 0576 and 0601';
  END IF;
END $$;

-- ---------- the staff choice ----------
CREATE TABLE hon.parent_push_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ANNOUNCEMENT','FAMILY_MESSAGE')),
  announcement_id uuid UNIQUE REFERENCES hon.school_announcements(id) ON DELETE RESTRICT,
  message_id uuid UNIQUE REFERENCES hon.family_messages(id) ON DELETE RESTRICT,
  family_id uuid,
  thread_id uuid,
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fanned_out_at timestamptz,
  CHECK ((kind='ANNOUNCEMENT' AND announcement_id IS NOT NULL AND message_id IS NULL AND family_id IS NULL AND thread_id IS NULL)
    OR (kind='FAMILY_MESSAGE' AND message_id IS NOT NULL AND announcement_id IS NULL AND family_id IS NOT NULL AND thread_id IS NOT NULL)),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX parent_push_requests_due ON hon.parent_push_requests(requested_at,id) WHERE fanned_out_at IS NULL;
ALTER TABLE hon.parent_push_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.parent_push_requests FORCE ROW LEVEL SECURITY;
CREATE TRIGGER parent_push_requests_no_truncate BEFORE TRUNCATE ON hon.parent_push_requests
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A request is never deleted and never changes, except that the worker marks it fanned out, once.
CREATE FUNCTION hon.guard_parent_push_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Parent push requests are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.fanned_out_at IS NOT NULL THEN RAISE EXCEPTION 'A new parent push request starts waiting' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.kind<>OLD.kind
    OR NEW.announcement_id IS DISTINCT FROM OLD.announcement_id OR NEW.message_id IS DISTINCT FROM OLD.message_id
    OR NEW.family_id IS DISTINCT FROM OLD.family_id OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
    OR NEW.requested_by_principal_id<>OLD.requested_by_principal_id OR NEW.requested_at<>OLD.requested_at
    OR OLD.fanned_out_at IS NOT NULL OR NEW.fanned_out_at IS NULL THEN
    RAISE EXCEPTION 'A parent push request can only be fanned out once' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parent_push_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.parent_push_requests
  FOR EACH ROW EXECUTE FUNCTION hon.guard_parent_push_request();

-- Written inside the staff command, after its own writes: one request and one audit row, ids only.
CREATE FUNCTION hon.request_parent_push(org uuid, school uuid, actor uuid, kind text, announcement uuid, message uuid, family uuid, thread uuid,
  request uuid, correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.parent_push_requests;
BEGIN
  INSERT INTO hon.parent_push_requests(organization_id,school_id,kind,announcement_id,message_id,family_id,thread_id,requested_by_principal_id)
    VALUES(org,school,kind,announcement,message,family,thread,actor) RETURNING * INTO r;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','parent_push.request','PARENT_PUSH_REQUEST',r.id,NULL,
      jsonb_strip_nulls(jsonb_build_object('kind',r.kind,'announcementId',r.announcement_id,'messageId',r.message_id,'threadId',r.thread_id)),
      'SUCCEEDED',request,correlation);
END $$;

-- phoneAlert in a staff command body: absent is false; present must be a JSON boolean.
CREATE FUNCTION hon.parent_push_choice(p jsonb, keys text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE got text[]:=(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k);
BEGIN
  IF got IS NOT DISTINCT FROM keys THEN RETURN false; END IF;
  IF got IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(keys||'phoneAlert'::text) k)
    OR jsonb_typeof(p->'phoneAlert') IS DISTINCT FROM 'boolean' THEN RETURN NULL; END IF;
  RETURN (p->>'phoneAlert')::boolean;
END $$;

-- ---------- deliveries carry an announcement or a family message ----------
ALTER TABLE hon.parent_push_deliveries ALTER COLUMN announcement_id DROP NOT NULL;
ALTER TABLE hon.parent_push_deliveries ADD COLUMN message_id uuid REFERENCES hon.parent_push_requests(message_id) ON DELETE RESTRICT;
ALTER TABLE hon.parent_push_deliveries ADD CONSTRAINT parent_push_deliveries_one_item CHECK (num_nonnulls(announcement_id,message_id)=1);
ALTER TABLE hon.parent_push_deliveries ADD CONSTRAINT parent_push_deliveries_message_device UNIQUE (message_id,device_id);

CREATE OR REPLACE FUNCTION hon.guard_parent_push_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Parent push deliveries are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'QUEUED' OR NEW.attempts<>0 OR NEW.ticket_id IS NOT NULL OR NEW.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new parent push delivery starts queued' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id
    OR NEW.announcement_id IS DISTINCT FROM OLD.announcement_id OR NEW.message_id IS DISTINCT FROM OLD.message_id
    OR NEW.device_id<>OLD.device_id OR NEW.created_at<>OLD.created_at OR NEW.attempts<OLD.attempts
    OR (OLD.ticket_id IS NOT NULL AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id)
    OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
    OR NOT ((OLD.status='QUEUED' AND NEW.status IN ('SENDING','SKIPPED'))
      OR (OLD.status='SENDING' AND NEW.status IN ('SENT','FAILED','UNKNOWN','QUEUED'))
      OR (OLD.status='SENT' AND NEW.status IN ('CHECKING','UNKNOWN'))
      OR (OLD.status='CHECKING' AND NEW.status IN ('DELIVERED','FAILED','SENT','UNKNOWN'))) THEN
    RAISE EXCEPTION 'A parent push delivery can only move forward' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

-- S4: the person still holds a live grant to this family (on top of 0601's live-at-school rule).
CREATE FUNCTION hon.parent_push_principal_in_family(principal uuid, org uuid, school uuid, family uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT hon.parent_push_principal_live_at(principal,org,school) AND EXISTS(SELECT 1 FROM hon.family_access_grants g
    JOIN hon.families f ON f.id=g.family_id AND f.organization_id=g.organization_id AND f.school_id=g.school_id AND f.status='ACTIVE'
    WHERE g.principal_id=principal AND g.organization_id=org AND g.school_id=school AND g.family_id=family
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()));
$$;

-- ---------- worker claim: only what staff asked for ----------
DROP FUNCTION hon.claim_parent_push_deliveries(integer,integer);
CREATE FUNCTION hon.claim_parent_push_deliveries(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(delivery_id uuid, lease_token uuid, expo_token text, title text, body text, push_kind text, announcement_id uuid, thread_id uuid, attempts integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz:=clock_timestamp(); a hon.school_announcements; r hon.parent_push_requests; q record; reason text; tok uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'INVALID_PARENT_PUSH_INPUT' USING ERRCODE='22023'; END IF;
  UPDATE hon.parent_push_deliveries x SET status='UNKNOWN',failure_code='LEASE_EXPIRED',lease_token=NULL,lease_until=NULL,finished_at=at
    WHERE x.status='SENDING' AND x.lease_until<=at;
  -- Announcements staff asked to push: published, under 24 hours, fanned out once to the school's live phones.
  FOR a IN SELECT s.* FROM hon.school_announcements s JOIN hon.parent_push_requests pr ON pr.announcement_id=s.id AND pr.fanned_out_at IS NULL
      WHERE s.status='PUBLISHED' AND s.published_at>at-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM hon.parent_push_fanouts f WHERE f.announcement_id=s.id)
      ORDER BY s.published_at, s.id LIMIT 20 FOR UPDATE OF s, pr SKIP LOCKED LOOP
    UPDATE hon.parent_push_requests pr SET fanned_out_at=at WHERE pr.announcement_id=a.id;
    INSERT INTO hon.parent_push_fanouts(announcement_id,organization_id,school_id) VALUES(a.id,a.organization_id,a.school_id)
      ON CONFLICT DO NOTHING;
    IF FOUND THEN
      INSERT INTO hon.parent_push_deliveries(organization_id,school_id,announcement_id,device_id)
        SELECT a.organization_id,a.school_id,a.id,d.id FROM hon.parent_push_devices d
        WHERE d.organization_id=a.organization_id AND d.school_id=a.school_id AND d.revoked_at IS NULL
          AND hon.parent_push_principal_live_at(d.principal_id,a.organization_id,a.school_id);
    END IF;
  END LOOP;
  -- Family message replies staff asked to push: under 24 hours, fanned out once to that family's live phones only.
  FOR r IN SELECT x.* FROM hon.parent_push_requests x WHERE x.kind='FAMILY_MESSAGE' AND x.fanned_out_at IS NULL AND x.requested_at>at-interval '24 hours'
      ORDER BY x.requested_at, x.id LIMIT 50 FOR UPDATE SKIP LOCKED LOOP
    UPDATE hon.parent_push_requests pr SET fanned_out_at=at WHERE pr.id=r.id;
    INSERT INTO hon.parent_push_deliveries(organization_id,school_id,message_id,device_id)
      SELECT r.organization_id,r.school_id,r.message_id,d.id FROM hon.parent_push_devices d
      WHERE d.organization_id=r.organization_id AND d.school_id=r.school_id AND d.revoked_at IS NULL
        AND hon.parent_push_principal_in_family(d.principal_id,r.organization_id,r.school_id,r.family_id)
      ON CONFLICT DO NOTHING;
  END LOOP;
  FOR q IN SELECT x.id, x.announcement_id ann, x.message_id msg, x.attempts tries, d.expo_token tokn, d.principal_id pid, d.revoked_at drev,
        s.status astatus, s.published_at apub, s.title atitle, m.created_at mat, m.family_id mfam, m.thread_id mthr,
        x.organization_id org, x.school_id sch, sc.name sname
      FROM hon.parent_push_deliveries x JOIN hon.parent_push_devices d ON d.id=x.device_id
      LEFT JOIN hon.school_announcements s ON s.id=x.announcement_id
      LEFT JOIN hon.family_messages m ON m.id=x.message_id
      JOIN hon.schools sc ON sc.id=x.school_id AND sc.organization_id=x.organization_id
      WHERE x.status='QUEUED' ORDER BY x.created_at, x.id LIMIT p_limit FOR UPDATE OF x SKIP LOCKED LOOP
    reason:=CASE WHEN q.ann IS NOT NULL AND q.astatus IS DISTINCT FROM 'PUBLISHED' THEN 'WITHDRAWN'
      WHEN (q.ann IS NOT NULL AND q.apub<=at-interval '24 hours') OR (q.msg IS NOT NULL AND (q.mat IS NULL OR q.mat<=at-interval '24 hours')) THEN 'STALE'
      WHEN q.drev IS NOT NULL THEN 'DEVICE_REVOKED'
      WHEN NOT hon.parent_push_principal_live_at(q.pid,q.org,q.sch) THEN 'NOT_LIVE'
      WHEN q.msg IS NOT NULL AND NOT hon.parent_push_principal_in_family(q.pid,q.org,q.sch,q.mfam) THEN 'NOT_LIVE' END;
    IF reason IS NOT NULL THEN
      UPDATE hon.parent_push_deliveries SET status='SKIPPED',failure_code=reason,finished_at=at WHERE id=q.id;
    ELSE
      tok:=gen_random_uuid();
      UPDATE hon.parent_push_deliveries SET status='SENDING',lease_token=tok,lease_until=at+make_interval(secs=>p_lease_seconds),
        attempts=q.tries+1 WHERE id=q.id;
      delivery_id:=q.id; lease_token:=tok; expo_token:=q.tokn; title:=left(q.sname,100); attempts:=q.tries+1;
      IF q.ann IS NOT NULL THEN
        body:=q.atitle; push_kind:='school_announcement'; announcement_id:=q.ann; thread_id:=NULL;
      ELSE
        body:='You have a new message from the school.'; push_kind:='school_message'; announcement_id:=NULL; thread_id:=q.mthr;
      END IF;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- ---------- staff commands carry the choice ----------
CREATE OR REPLACE FUNCTION hon.publish_school_announcement(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; a hon.school_announcements; result jsonb; ids jsonb; alert boolean; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  alert:=hon.parent_push_choice(p,ARRAY['body','title']);
  IF alert IS NULL
    OR jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR NOT hon.school_announcement_title_ok(p->>'title')
    OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR NOT hon.family_message_body_ok(p->>'body')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_announcements_actor(subject);
  -- Without a phone alert the fingerprint is exactly 0576's, so an earlier post replays; with one it is a different command.
  prior:=hon.family_message_begin(actor,key,encode(sha256(convert_to('school_announcement.publish:'||(p->>'title')||E'\n'||(p->>'body')
    ||CASE WHEN alert THEN E'\nphone-alert' ELSE '' END,'UTF8')),'hex'));
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
  IF alert THEN PERFORM hon.request_parent_push(org,school,actor,'ANNOUNCEMENT',a.id,NULL,NULL,NULL,request,correlation); END IF;
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  -- Authority is checked again after every lock and write of the command.
  IF hon.require_school_announcements_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

CREATE OR REPLACE FUNCTION hon.reply_family_message(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; t hon.family_message_threads; thread uuid; result jsonb; alert boolean;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  alert:=hon.parent_push_choice(p,ARRAY['body','threadId','throughMessageId']);
  IF alert IS NULL
    OR jsonb_typeof(p->'threadId') IS DISTINCT FROM 'string' OR p->>'threadId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'throughMessageId') IS DISTINCT FROM 'string' OR p->>'throughMessageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR NOT hon.family_message_body_ok(p->>'body')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  thread:=(p->>'threadId')::uuid;
  actor:=hon.require_family_messages_actor(subject);
  -- Without a phone alert the fingerprint is exactly 0330's; with one it is a different command.
  prior:=hon.family_message_begin(actor,key,encode(sha256(convert_to('family_message.reply:'||thread||':'||(p->>'body')
    ||CASE WHEN alert THEN E'\nphone-alert' ELSE '' END,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_family_messages_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  SELECT * INTO t FROM hon.family_message_threads x WHERE x.id=thread AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND OR t.message_count=0 THEN RAISE EXCEPTION 'FAMILY_MESSAGES_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  t:=hon.family_message_read_through(t,(p->>'throughMessageId')::uuid);
  result:=hon.family_message_append(t,actor,'SCHOOL',p->>'body',key,request,correlation);
  IF alert THEN
    PERFORM hon.request_parent_push(t.organization_id,t.school_id,actor,'FAMILY_MESSAGE',NULL,(result->'message'->>'messageId')::uuid,t.family_id,t.id,request,correlation);
  END IF;
  IF hon.require_family_messages_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'FAMILY_MESSAGES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

COMMENT ON FUNCTION hon.claim_parent_push_deliveries(integer,integer) IS
'0601/0658 worker: expire lost send leases as UNKNOWN, fan out once only the announcements and family-message replies staff asked to push, re-check and lease queued deliveries.';
COMMENT ON TABLE hon.parent_push_requests IS
'0658: staff asked for a phone alert on this announcement or family-message reply. Private; written only by the staff command.';

DO $$ DECLARE r text; f text;
  worker_entry text[]:=ARRAY['hon.claim_parent_push_deliveries(integer,integer)'];
  fns text[]:=ARRAY['hon.guard_parent_push_request()','hon.request_parent_push(uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid)',
    'hon.parent_push_choice(jsonb,text[])','hon.parent_push_principal_in_family(uuid,uuid,uuid,uuid)','hon.guard_parent_push_delivery()']||worker_entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  EXECUTE 'REVOKE ALL ON TABLE hon.parent_push_requests FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.parent_push_requests FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.claim_parent_push_deliveries(integer,integer) TO hon_communication_worker;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') AND (has_table_privilege('hon_runtime','hon.parent_push_requests','SELECT')
      OR has_function_privilege('hon_runtime','hon.request_parent_push(uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE')
      OR NOT has_function_privilege('hon_runtime','hon.publish_school_announcement(text,jsonb,text,uuid,uuid)','EXECUTE')
      OR NOT has_function_privilege('hon_runtime','hon.reply_family_message(text,jsonb,text,uuid,uuid)','EXECUTE')) THEN
    RAISE EXCEPTION 'Parent push staff choice: runtime access is not as expected';
  END IF;
END $$;

COMMIT;
