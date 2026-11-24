BEGIN;

-- Parent announcement push (0601, assigned by the coordinator 2026-11-20; docs/architecture/PARENT_ANNOUNCEMENT_PUSH.md).
-- The owner asked that an announcement staff post in the CRM (0576) also reaches families as a phone notification.
--   P1  A family member signed in to the HON Family app registers the phone's Expo push token for the one school their
--       live grant is at (the 0576 parent scope). One token belongs to one person at a time: the same phone signed in by
--       someone else moves the token to them. At most 10 live phones per person; the oldest is let go first. Signing out
--       lets the phone go.
--   P2  A published announcement is fanned out once, by the communication worker, to every live phone at its school whose
--       person is still a live family member there. Nothing is fanned out or sent for announcements older than 24 hours.
--   P3  Just before sending, the worker checks again: the announcement is still PUBLISHED and under 24 hours old, the
--       phone is still registered and the person is still live at the school. Otherwise the delivery is SKIPPED.
--   P4  A send that may have reached Expo but has no answer (timeout, lost lease) is UNKNOWN and is never sent again.
--       Only a definite refusal (rate limited) is retried, at most 3 attempts. Expo's DeviceNotRegistered lets the phone go.
--   P5  The notification carries the school's name and the announcement title, never a child's name or the body.
-- Nothing sends unless the API is configured to (HON_PARENT_PUSH_APPROVED, off by default). The runtime gains no table
-- privilege: entry points are SECURITY DEFINER. The worker (hon_communication_worker) gains only its four functions.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Parent announcement push requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Parent announcement push requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.school_announcement_parent_scope(text)') IS NULL OR to_regclass('hon.school_announcements') IS NULL
    OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Parent announcement push requires 0177, 0224 and 0576';
  END IF;
END $$;

-- An Expo push token as Expo issues it.
CREATE FUNCTION hon.parent_push_token_ok(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND v ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,100}\]$'
$$;

CREATE TABLE hon.parent_push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  expo_token text NOT NULL CHECK (hon.parent_push_token_ok(expo_token)),
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('SIGNED_OUT','REPLACED','DEVICE_LIMIT','DEVICE_NOT_REGISTERED')),
  CHECK ((revoked_at IS NULL)=(revoke_reason IS NULL)),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX parent_push_devices_live_token ON hon.parent_push_devices(expo_token) WHERE revoked_at IS NULL;
CREATE INDEX parent_push_devices_live_school ON hon.parent_push_devices(school_id) WHERE revoked_at IS NULL;
CREATE INDEX parent_push_devices_live_principal ON hon.parent_push_devices(principal_id) WHERE revoked_at IS NULL;

-- One row per announcement once it has been fanned out, so it is fanned out exactly once.
CREATE TABLE hon.parent_push_fanouts (
  announcement_id uuid PRIMARY KEY REFERENCES hon.school_announcements(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  fanned_out_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.parent_push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  announcement_id uuid NOT NULL REFERENCES hon.parent_push_fanouts(announcement_id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES hon.parent_push_devices(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','SENT','CHECKING','DELIVERED','FAILED','UNKNOWN','SKIPPED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token uuid,
  lease_until timestamptz,
  ticket_id text CHECK (ticket_id ~ '^[A-Za-z0-9-]{1,100}$'),
  failure_code text CHECK (failure_code ~ '^[A-Za-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  next_check_at timestamptz,
  finished_at timestamptz,
  UNIQUE (announcement_id,device_id),
  CHECK ((status IN ('SENDING','CHECKING'))=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status IN ('SENT','CHECKING','DELIVERED'))<=(ticket_id IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK ((status IN ('DELIVERED','FAILED','UNKNOWN','SKIPPED'))=(finished_at IS NOT NULL)),
  CHECK ((status IN ('FAILED','UNKNOWN','SKIPPED'))<=(failure_code IS NOT NULL)),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX parent_push_deliveries_queued ON hon.parent_push_deliveries(created_at,id) WHERE status='QUEUED';
CREATE INDEX parent_push_deliveries_open ON hon.parent_push_deliveries(status,lease_until) WHERE status IN ('SENDING','SENT','CHECKING');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['parent_push_devices','parent_push_fanouts','parent_push_deliveries'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence()',t||'_no_truncate',t);
  END LOOP;
END $$;
CREATE TRIGGER parent_push_fanouts_immutable BEFORE UPDATE OR DELETE ON hon.parent_push_fanouts
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A phone row is never deleted; who, where and which token never change; last seen only moves forward; letting go is once.
CREATE FUNCTION hon.guard_parent_push_device() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Parent push devices are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.last_seen_at<NEW.registered_at THEN
      RAISE EXCEPTION 'A new parent push device starts live' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.principal_id<>OLD.principal_id
    OR NEW.expo_token<>OLD.expo_token OR NEW.platform<>OLD.platform OR NEW.registered_at<>OLD.registered_at
    OR OLD.revoked_at IS NOT NULL OR NEW.last_seen_at<OLD.last_seen_at THEN
    RAISE EXCEPTION 'A parent push device can only be seen again or let go once' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parent_push_devices_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.parent_push_devices
  FOR EACH ROW EXECUTE FUNCTION hon.guard_parent_push_device();

-- A delivery is never deleted, its identity never changes, attempts never go down and status only moves along
-- QUEUED -> SENDING|SKIPPED, SENDING -> SENT|FAILED|UNKNOWN|QUEUED (definite refusal only), SENT -> CHECKING|UNKNOWN,
-- CHECKING -> DELIVERED|FAILED|SENT|UNKNOWN. DELIVERED, FAILED, UNKNOWN and SKIPPED are final.
CREATE FUNCTION hon.guard_parent_push_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Parent push deliveries are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'QUEUED' OR NEW.attempts<>0 OR NEW.ticket_id IS NOT NULL OR NEW.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new parent push delivery starts queued' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.announcement_id<>OLD.announcement_id
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
CREATE TRIGGER parent_push_deliveries_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.parent_push_deliveries
  FOR EACH ROW EXECUTE FUNCTION hon.guard_parent_push_delivery();

-- P2/P3: the 0329 family rules for a person, without session settings: one active human principal, exactly one live
-- (school, family) grant and it is at this school, live organization, school and entitlement.
CREATE FUNCTION hon.parent_push_principal_live_at(principal uuid, org uuid, school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.principals p
    WHERE p.id=principal AND p.principal_type='HUMAN_USER' AND p.is_active AND p.user_id IS NOT NULL
      AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=p.user_id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
      AND (SELECT count(*) FROM (SELECT DISTINCT g.school_id,g.family_id FROM hon.family_access_grants g WHERE g.principal_id=p.id
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) y)=1
      AND EXISTS(SELECT 1 FROM hon.family_access_grants g WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
      AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
      AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
        AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())));
$$;

-- The 0576 parent scope with this feature's own refusal code.
CREATE FUNCTION hon.parent_push_scope(subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  BEGIN
    RETURN QUERY SELECT * FROM hon.school_announcement_parent_scope(subject);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'PARENT_PUSH_FORBIDDEN' USING ERRCODE='42501';
  END;
END $$;

-- P1 register: idempotent by token. Same person and school: seen again. Otherwise the old row is let go (REPLACED) and
-- a new live row is written; beyond 10 live phones the least recently seen is let go (DEVICE_LIMIT).
CREATE FUNCTION hon.register_parent_push_device(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; d hon.parent_push_devices; old hon.parent_push_devices; token text; plat text; replayed boolean:=false;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expoPushToken','platform']
    OR jsonb_typeof(p->'expoPushToken') IS DISTINCT FROM 'string' OR NOT hon.parent_push_token_ok(p->>'expoPushToken')
    OR jsonb_typeof(p->'platform') IS DISTINCT FROM 'string' OR (p->>'platform') NOT IN ('ios','android')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  token:=p->>'expoPushToken'; plat:=p->>'platform';
  SELECT * INTO sc FROM hon.parent_push_scope(subject);
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.parent_push_devices:token:'||token,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.parent_push_devices:principal:'||sc.principal_id::text,0));
  SELECT * INTO old FROM hon.parent_push_devices x WHERE x.expo_token=token AND x.revoked_at IS NULL FOR UPDATE;
  IF FOUND AND old.principal_id=sc.principal_id AND old.organization_id=sc.organization_id AND old.school_id=sc.school_id AND old.platform=plat THEN
    UPDATE hon.parent_push_devices SET last_seen_at=greatest(last_seen_at,clock_timestamp()) WHERE id=old.id RETURNING * INTO d;
    replayed:=true;
  ELSE
    IF FOUND THEN
      UPDATE hon.parent_push_devices SET revoked_at=clock_timestamp(),revoke_reason='REPLACED' WHERE id=old.id;
    END IF;
    INSERT INTO hon.parent_push_devices(organization_id,school_id,principal_id,expo_token,platform)
      VALUES(sc.organization_id,sc.school_id,sc.principal_id,token,plat) RETURNING * INTO d;
    UPDATE hon.parent_push_devices SET revoked_at=clock_timestamp(),revoke_reason='DEVICE_LIMIT'
      WHERE id IN (SELECT x.id FROM hon.parent_push_devices x WHERE x.principal_id=sc.principal_id AND x.revoked_at IS NULL
        ORDER BY x.last_seen_at DESC, x.registered_at DESC, x.id OFFSET 10);
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(sc.organization_id,sc.school_id,sc.principal_id,'HUMAN_UI','parent_push_device.register','PARENT_PUSH_DEVICE',d.id,
        CASE WHEN old.id IS NULL THEN NULL ELSE jsonb_build_object('replacedDeviceId',old.id) END,
        jsonb_build_object('deviceId',d.id,'platform',d.platform),'SUCCEEDED',request,correlation);
  END IF;
  -- Authority is checked again after every lock and write of the command.
  IF (SELECT x.principal_id FROM hon.parent_push_scope(subject) x) IS DISTINCT FROM sc.principal_id THEN
    RAISE EXCEPTION 'PARENT_PUSH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('device',jsonb_build_object('deviceId',d.id,'platform',d.platform),'replayed',replayed);
END $$;

-- P1 sign out: let this person's live phone with this token go. Nothing to let go is not an error.
CREATE FUNCTION hon.unregister_parent_push_device(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; d hon.parent_push_devices;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expoPushToken']
    OR jsonb_typeof(p->'expoPushToken') IS DISTINCT FROM 'string' OR NOT hon.parent_push_token_ok(p->>'expoPushToken')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO sc FROM hon.parent_push_scope(subject);
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.parent_push_devices:token:'||(p->>'expoPushToken'),0));
  UPDATE hon.parent_push_devices SET revoked_at=clock_timestamp(),revoke_reason='SIGNED_OUT'
    WHERE expo_token=p->>'expoPushToken' AND revoked_at IS NULL AND principal_id=sc.principal_id RETURNING * INTO d;
  IF d.id IS NOT NULL THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(d.organization_id,d.school_id,sc.principal_id,'HUMAN_UI','parent_push_device.unregister','PARENT_PUSH_DEVICE',d.id,
        jsonb_build_object('deviceId',d.id),jsonb_build_object('deviceId',d.id,'revokeReason','SIGNED_OUT'),'SUCCEEDED',request,correlation);
  END IF;
  IF (SELECT x.principal_id FROM hon.parent_push_scope(subject) x) IS DISTINCT FROM sc.principal_id THEN
    RAISE EXCEPTION 'PARENT_PUSH_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('unregistered',d.id IS NOT NULL);
END $$;

-- ---------- worker (hon_communication_worker) ----------
-- CLAIM sends: (1) a SENDING lease that ran out is UNKNOWN (LEASE_EXPIRED), never resent; (2) up to 20 published
-- announcements from the last 24 hours that were never fanned out are fanned out to their school's live phones;
-- (3) up to p_limit QUEUED deliveries are checked again (P3) and either SKIPPED or leased for sending.
CREATE FUNCTION hon.claim_parent_push_deliveries(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(delivery_id uuid, lease_token uuid, expo_token text, title text, body text, announcement_id uuid, attempts integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz:=clock_timestamp(); a hon.school_announcements; q record; reason text; tok uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'INVALID_PARENT_PUSH_INPUT' USING ERRCODE='22023'; END IF;
  UPDATE hon.parent_push_deliveries x SET status='UNKNOWN',failure_code='LEASE_EXPIRED',lease_token=NULL,lease_until=NULL,finished_at=at
    WHERE x.status='SENDING' AND x.lease_until<=at;
  FOR a IN SELECT * FROM hon.school_announcements s WHERE s.status='PUBLISHED' AND s.published_at>at-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM hon.parent_push_fanouts f WHERE f.announcement_id=s.id)
      ORDER BY s.published_at, s.id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
    INSERT INTO hon.parent_push_fanouts(announcement_id,organization_id,school_id) VALUES(a.id,a.organization_id,a.school_id)
      ON CONFLICT DO NOTHING;
    IF FOUND THEN
      INSERT INTO hon.parent_push_deliveries(organization_id,school_id,announcement_id,device_id)
        SELECT a.organization_id,a.school_id,a.id,d.id FROM hon.parent_push_devices d
        WHERE d.organization_id=a.organization_id AND d.school_id=a.school_id AND d.revoked_at IS NULL
          AND hon.parent_push_principal_live_at(d.principal_id,a.organization_id,a.school_id);
    END IF;
  END LOOP;
  FOR q IN SELECT x.id, x.announcement_id ann, x.attempts tries, d.expo_token tokn, d.principal_id pid, d.revoked_at drev,
        s.status astatus, s.published_at apub, s.title atitle, s.organization_id org, s.school_id sch, sc.name sname
      FROM hon.parent_push_deliveries x JOIN hon.parent_push_devices d ON d.id=x.device_id
      JOIN hon.school_announcements s ON s.id=x.announcement_id JOIN hon.schools sc ON sc.id=s.school_id AND sc.organization_id=s.organization_id
      WHERE x.status='QUEUED' ORDER BY x.created_at, x.id LIMIT p_limit FOR UPDATE OF x SKIP LOCKED LOOP
    reason:=CASE WHEN q.astatus<>'PUBLISHED' THEN 'WITHDRAWN'
      WHEN q.apub<=at-interval '24 hours' THEN 'STALE'
      WHEN q.drev IS NOT NULL THEN 'DEVICE_REVOKED'
      WHEN NOT hon.parent_push_principal_live_at(q.pid,q.org,q.sch) THEN 'NOT_LIVE' END;
    IF reason IS NOT NULL THEN
      UPDATE hon.parent_push_deliveries SET status='SKIPPED',failure_code=reason,finished_at=at WHERE id=q.id;
    ELSE
      tok:=gen_random_uuid();
      UPDATE hon.parent_push_deliveries SET status='SENDING',lease_token=tok,lease_until=at+make_interval(secs=>p_lease_seconds),
        attempts=q.tries+1 WHERE id=q.id;
      delivery_id:=q.id; lease_token:=tok; expo_token:=q.tokn; title:=left(q.sname,100); body:=q.atitle;
      announcement_id:=q.ann; attempts:=q.tries+1;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- RECORD a send under its live lease. p = {outcome: SENT (ticketId) | FAILED (failureCode) | UNKNOWN (failureCode) |
-- RETRYABLE (failureCode)}. RETRYABLE goes back to the queue while attempts are left, else FAILED RETRIES_EXHAUSTED.
-- FAILED DeviceNotRegistered lets the phone go. A lost lease records nothing.
CREATE FUNCTION hon.record_parent_push_send(p_delivery uuid, p_lease uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.parent_push_deliveries; o text; code text; at timestamptz:=clock_timestamp();
BEGIN
  IF p_delivery IS NULL OR p_lease IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'outcome') IS DISTINCT FROM 'string'
    OR (p->>'outcome') NOT IN ('SENT','FAILED','UNKNOWN','RETRYABLE')
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM
      (CASE WHEN p->>'outcome'='SENT' THEN ARRAY['outcome','ticketId'] ELSE ARRAY['failureCode','outcome'] END)
    OR (p->>'outcome'='SENT' AND (jsonb_typeof(p->'ticketId') IS DISTINCT FROM 'string' OR (p->>'ticketId') !~ '^[A-Za-z0-9-]{1,100}$'))
    OR (p->>'outcome'<>'SENT' AND (jsonb_typeof(p->'failureCode') IS DISTINCT FROM 'string' OR (p->>'failureCode') !~ '^[A-Za-z_]{1,64}$')) THEN
    RAISE EXCEPTION 'INVALID_PARENT_PUSH_INPUT' USING ERRCODE='22023'; END IF;
  o:=p->>'outcome'; code:=p->>'failureCode';
  SELECT * INTO x FROM hon.parent_push_deliveries d WHERE d.id=p_delivery FOR UPDATE;
  IF NOT FOUND OR x.status<>'SENDING' OR x.lease_token IS DISTINCT FROM p_lease OR x.lease_until<=at THEN
    RETURN jsonb_build_object('recorded',false); END IF;
  IF o='SENT' THEN
    UPDATE hon.parent_push_deliveries SET status='SENT',ticket_id=p->>'ticketId',sent_at=at,next_check_at=at+interval '15 minutes',
      lease_token=NULL,lease_until=NULL WHERE id=x.id RETURNING * INTO x;
  ELSIF o='RETRYABLE' AND x.attempts<3 THEN
    UPDATE hon.parent_push_deliveries SET status='QUEUED',failure_code=code,lease_token=NULL,lease_until=NULL WHERE id=x.id RETURNING * INTO x;
  ELSE
    UPDATE hon.parent_push_deliveries SET status=CASE WHEN o='UNKNOWN' THEN 'UNKNOWN' ELSE 'FAILED' END,
      failure_code=CASE WHEN o='RETRYABLE' THEN 'RETRIES_EXHAUSTED' ELSE code END,lease_token=NULL,lease_until=NULL,finished_at=at
      WHERE id=x.id RETURNING * INTO x;
    IF o='FAILED' AND code='DeviceNotRegistered' THEN
      UPDATE hon.parent_push_devices SET revoked_at=at,revoke_reason='DEVICE_NOT_REGISTERED' WHERE id=x.device_id AND revoked_at IS NULL;
    END IF;
  END IF;
  RETURN jsonb_build_object('recorded',true,'status',x.status);
END $$;

-- CLAIM receipts: a CHECKING lease that ran out goes back to SENT (reading a receipt sends nothing); a SENT delivery
-- with no receipt after 24 hours is UNKNOWN (RECEIPT_EXPIRED); up to p_limit SENT deliveries due a check are leased.
CREATE FUNCTION hon.claim_parent_push_receipts(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(delivery_id uuid, lease_token uuid, ticket_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz:=clock_timestamp(); q record; tok uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 300 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'INVALID_PARENT_PUSH_INPUT' USING ERRCODE='22023'; END IF;
  UPDATE hon.parent_push_deliveries x SET status='SENT',lease_token=NULL,lease_until=NULL WHERE x.status='CHECKING' AND x.lease_until<=at;
  UPDATE hon.parent_push_deliveries x SET status='UNKNOWN',failure_code='RECEIPT_EXPIRED',finished_at=at
    WHERE x.status='SENT' AND x.sent_at<=at-interval '24 hours';
  FOR q IN SELECT x.id, x.ticket_id tid FROM hon.parent_push_deliveries x WHERE x.status='SENT' AND x.next_check_at<=at
      ORDER BY x.next_check_at, x.id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    tok:=gen_random_uuid();
    UPDATE hon.parent_push_deliveries SET status='CHECKING',lease_token=tok,lease_until=at+make_interval(secs=>p_lease_seconds) WHERE id=q.id;
    delivery_id:=q.id; lease_token:=tok; ticket_id:=q.tid;
    RETURN NEXT;
  END LOOP;
END $$;

-- RECORD a receipt under its live lease. p = {outcome: DELIVERED | PENDING | FAILED (failureCode)}. DELIVERED means
-- Expo handed it to Apple or Google. PENDING (no receipt yet) checks again in 15 minutes.
CREATE FUNCTION hon.record_parent_push_receipt(p_delivery uuid, p_lease uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.parent_push_deliveries; o text; at timestamptz:=clock_timestamp();
BEGIN
  IF p_delivery IS NULL OR p_lease IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'outcome') IS DISTINCT FROM 'string'
    OR (p->>'outcome') NOT IN ('DELIVERED','PENDING','FAILED')
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM
      (CASE WHEN p->>'outcome'='FAILED' THEN ARRAY['failureCode','outcome'] ELSE ARRAY['outcome'] END)
    OR (p->>'outcome'='FAILED' AND (jsonb_typeof(p->'failureCode') IS DISTINCT FROM 'string' OR (p->>'failureCode') !~ '^[A-Za-z_]{1,64}$')) THEN
    RAISE EXCEPTION 'INVALID_PARENT_PUSH_INPUT' USING ERRCODE='22023'; END IF;
  o:=p->>'outcome';
  SELECT * INTO x FROM hon.parent_push_deliveries d WHERE d.id=p_delivery FOR UPDATE;
  IF NOT FOUND OR x.status<>'CHECKING' OR x.lease_token IS DISTINCT FROM p_lease OR x.lease_until<=at THEN
    RETURN jsonb_build_object('recorded',false); END IF;
  IF o='PENDING' THEN
    UPDATE hon.parent_push_deliveries SET status='SENT',next_check_at=at+interval '15 minutes',lease_token=NULL,lease_until=NULL WHERE id=x.id RETURNING * INTO x;
  ELSIF o='DELIVERED' THEN
    UPDATE hon.parent_push_deliveries SET status='DELIVERED',lease_token=NULL,lease_until=NULL,finished_at=at WHERE id=x.id RETURNING * INTO x;
  ELSE
    UPDATE hon.parent_push_deliveries SET status='FAILED',failure_code=p->>'failureCode',lease_token=NULL,lease_until=NULL,finished_at=at
      WHERE id=x.id RETURNING * INTO x;
    IF p->>'failureCode'='DeviceNotRegistered' THEN
      UPDATE hon.parent_push_devices SET revoked_at=at,revoke_reason='DEVICE_NOT_REGISTERED' WHERE id=x.device_id AND revoked_at IS NULL;
    END IF;
  END IF;
  RETURN jsonb_build_object('recorded',true,'status',x.status);
END $$;

COMMENT ON FUNCTION hon.register_parent_push_device(text,jsonb,text,uuid,uuid) IS
'0601 parent command: register this phone''s Expo push token for the one live family grant; idempotent by token; at most 10 live phones.';
COMMENT ON FUNCTION hon.unregister_parent_push_device(text,jsonb,text,uuid,uuid) IS
'0601 parent command: let this person''s phone with this token go (sign out).';
COMMENT ON FUNCTION hon.claim_parent_push_deliveries(integer,integer) IS
'0601 worker: expire lost send leases as UNKNOWN, fan out new announcements once, re-check and lease queued deliveries.';
COMMENT ON FUNCTION hon.claim_parent_push_receipts(integer,integer) IS
'0601 worker: lease sent deliveries due an Expo receipt check.';

DO $$ DECLARE r text; f text; t text;
  runtime_entry text[]:=ARRAY['hon.register_parent_push_device(text,jsonb,text,uuid,uuid)','hon.unregister_parent_push_device(text,jsonb,text,uuid,uuid)'];
  worker_entry text[]:=ARRAY['hon.claim_parent_push_deliveries(integer,integer)','hon.record_parent_push_send(uuid,uuid,jsonb)',
    'hon.claim_parent_push_receipts(integer,integer)','hon.record_parent_push_receipt(uuid,uuid,jsonb)'];
  fns text[]:=ARRAY['hon.parent_push_token_ok(text)','hon.guard_parent_push_device()','hon.guard_parent_push_delivery()',
    'hon.parent_push_principal_live_at(uuid,uuid,uuid)','hon.parent_push_scope(text)']||runtime_entry||worker_entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['parent_push_devices','parent_push_fanouts','parent_push_deliveries'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY runtime_entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    FOREACH f IN ARRAY worker_entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_communication_worker',f); END LOOP;
  END IF;
END $$;

COMMIT;
