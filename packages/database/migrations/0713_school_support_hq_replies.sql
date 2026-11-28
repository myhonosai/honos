BEGIN;

-- 0713 (coordinator-allocated 2026-11-28): school help, HQ side. Owner (David, 2026-11-28): "HON in school OS answers
-- anything that's possible and relays to HQ, and HQ gets notified and I get on it."
-- - HQ answers a school's request inside it: a new REPLY event that the school sees as "HON support" (never an HQ
--   person's name). Only an HQ support person (0232 authority) writes it, only on a case that came from a school (0335
--   link), never on a closed case; versioned and idempotent like every 0232 command. Optionally the case then waits on
--   the school (a recorded CHANGED event).
-- - HQ sees which cases came from a school and which need a reply (open, and the school wrote last), and reads a small
--   alert summary for the menu badge and dashboard.
-- - The school sees HQ replies in its requests, which requests wait on it, and how many.
-- - HQ internal notes stay hidden from the school. Nothing is sent: no text, email or push, and nothing touches billing,
--   access, credits or AI. The case history stays the immutable record, as in 0232.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.add_hq_support_note(text,uuid,jsonb,uuid)') IS NULL OR to_regprocedure('hon.read_school_support_requests(text)') IS NULL THEN
    RAISE EXCEPTION '0713 requires 0232 and 0335'; END IF;
END $$;

-- ---------- data ----------
ALTER TABLE hon.hq_support_case_events DROP CONSTRAINT hq_support_case_events_kind_check;
ALTER TABLE hon.hq_support_case_events ADD CONSTRAINT hq_support_case_events_kind_check CHECK (kind IN ('OPENED','NOTE','CHANGED','REPLY'));
ALTER TABLE hon.hq_support_case_events ADD CONSTRAINT hq_support_case_events_reply_note_check CHECK (kind <> 'REPLY' OR note IS NOT NULL);
ALTER TABLE hon.hq_support_requests DROP CONSTRAINT hq_support_requests_operation_check;
ALTER TABLE hon.hq_support_requests ADD CONSTRAINT hq_support_requests_operation_check CHECK (operation IN ('OPEN','NOTE','CHANGE','REPLY'));
CREATE INDEX hq_support_case_events_case_idx ON hon.hq_support_case_events (case_id, seq DESC);

-- ---------- message facts ----------
-- A school message is a note written by someone with no HQ grant (OPENED or NOTE; no school actor ever holds one, 0335).
-- An HQ message to the school is a REPLY. Internal HQ notes and changes are neither.
CREATE FUNCTION hon.hq_support_last_school_message_at(p_case uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT max(e.occurred_at) FROM hon.hq_support_case_events e
  WHERE e.case_id = p_case AND e.kind IN ('OPENED','NOTE') AND e.note IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = e.actor_principal_id)
$$;
CREATE FUNCTION hon.hq_support_last_reply_at(p_case uuid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT max(e.occurred_at) FROM hon.hq_support_case_events e WHERE e.case_id = p_case AND e.kind = 'REPLY'
$$;
-- Whose message is last: the latest seq among school messages and replies ('SCHOOL', 'HON' or NULL for none).
CREATE FUNCTION hon.hq_support_last_message_from(p_case uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN e.kind = 'REPLY' THEN 'HON' ELSE 'SCHOOL' END FROM hon.hq_support_case_events e
  WHERE e.case_id = p_case AND e.note IS NOT NULL AND (e.kind = 'REPLY' OR (e.kind IN ('OPENED','NOTE')
    AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = e.actor_principal_id)))
  ORDER BY e.seq DESC LIMIT 1
$$;
-- HQ owes a reply: a school request that is open and whose last message is the school's.
CREATE FUNCTION hon.hq_support_needs_reply(c hon.hq_support_cases) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT c.status = 'OPEN' AND EXISTS (SELECT 1 FROM hon.school_support_requests r WHERE r.case_id = c.id)
    AND hon.hq_support_last_message_from(c.id) = 'SCHOOL'
$$;

-- ---------- HQ projections ----------
CREATE OR REPLACE FUNCTION hon.hq_support_case_json(c hon.hq_support_cases) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('caseId', c.id, 'organizationId', c.organization_id,
    'organizationDisplayName', left((SELECT o.display_name FROM hon.organizations o WHERE o.id = c.organization_id), 300),
    'schoolId', c.school_id,
    'schoolDisplayName', CASE WHEN c.school_id IS NULL THEN NULL ELSE left((SELECT s.name FROM hon.schools s WHERE s.id = c.school_id), 300) END,
    'subject', c.subject, 'category', c.category, 'priority', c.priority, 'status', c.status,
    'assignee', hon.hq_support_person_json(c.assignee_principal_id), 'openedBy', hon.hq_support_person_json(c.opened_by),
    'openedAt', hon.saas_ts(c.opened_at), 'updatedAt', hon.saas_ts(c.updated_at), 'closedAt', hon.saas_ts(c.closed_at),
    'version', c.version,
    'noteCount', (SELECT count(*) FROM hon.hq_support_case_events e WHERE e.case_id = c.id AND e.note IS NOT NULL),
    -- 0713: where it came from and whether HQ owes the school an answer.
    'fromSchool', EXISTS (SELECT 1 FROM hon.school_support_requests r WHERE r.case_id = c.id),
    'needsReply', hon.hq_support_needs_reply(c),
    'lastSchoolMessageAt', hon.saas_ts(hon.hq_support_last_school_message_at(c.id)),
    'lastReplyAt', hon.saas_ts(hon.hq_support_last_reply_at(c.id)))
$$;

-- ---------- HQ command ----------
-- REPLY: {expectedVersion, message, waitForSchool}. The school sees the message as "HON support".
CREATE FUNCTION hon.reply_to_hq_support_case(p_subject text, p_case uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.hq_support_cases%ROWTYPE; v_note text; v_expected integer; v_wait boolean; at timestamptz; fp text; seq integer; result jsonb;
BEGIN
  actor := hon.require_hq_support_actor(p_subject);
  IF p_case IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion','message','waitForSchool']
    OR jsonb_typeof(p_input->'waitForSchool') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_support_expected(p_input); v_note := hon.hq_support_text(p_input, 'message', 1, 4000);
  v_wait := (p_input->>'waitForSchool')::boolean;
  fp := hon.saas_fingerprint(ARRAY['hq.support.reply', p_case::text, p_input::text]);
  replay := hon.hq_support_claim(actor, p_key, 'REPLY', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_support_actor(p_subject); RETURN replay; END IF;
  c := hon.hq_support_lock_case(p_case, v_expected);
  IF NOT EXISTS (SELECT 1 FROM hon.school_support_requests r WHERE r.case_id = c.id) THEN
    RAISE EXCEPTION 'SUPPORT_NOT_FROM_SCHOOL' USING ERRCODE = '23514';
  END IF;
  at := greatest(clock_timestamp(), c.updated_at);
  SELECT max(e.seq) + 1 INTO seq FROM hon.hq_support_case_events e WHERE e.case_id = c.id;
  INSERT INTO hon.hq_support_case_events (case_id, seq, kind, actor_principal_id, note, occurred_at) VALUES (c.id, seq, 'REPLY', actor, v_note, at);
  IF v_wait AND c.status <> 'WAITING_ON_SCHOOL' THEN
    INSERT INTO hon.hq_support_case_events (case_id, seq, kind, actor_principal_id, status_from, status_to, occurred_at)
    VALUES (c.id, seq + 1, 'CHANGED', actor, c.status, 'WAITING_ON_SCHOOL', at);
    UPDATE hon.hq_support_cases SET status = 'WAITING_ON_SCHOOL', updated_at = at, version = version + 1 WHERE id = c.id RETURNING * INTO c;
  ELSE
    UPDATE hon.hq_support_cases SET updated_at = at, version = version + 1 WHERE id = c.id RETURNING * INTO c;
  END IF;
  result := jsonb_build_object('operation', 'REPLY', 'case', hon.hq_support_case_json(c));
  INSERT INTO hon.hq_support_requests VALUES (actor, p_key, 'REPLY', fp, c.id, result, at);
  PERFORM hon.require_hq_support_actor(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- HQ alert read ----------
-- The menu badge and dashboard: how many school requests wait for an HQ reply, and the 10 that have waited least long
-- (newest school message first). Names, subjects and times only, never the school's words.
CREATE FUNCTION hon.read_hq_support_alerts(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor := hon.require_hq_support_actor(p_subject);
  WITH w AS (
    SELECT c.id, c.organization_id, c.school_id, c.subject, c.priority, hon.hq_support_last_school_message_at(c.id) AS at
    FROM hon.hq_support_cases c JOIN hon.school_support_requests r ON r.case_id = c.id
    WHERE c.status = 'OPEN' AND hon.hq_support_last_message_from(c.id) = 'SCHOOL')
  SELECT jsonb_build_object('needsReply', (SELECT count(*) FROM w),
    'latest', coalesce((SELECT jsonb_agg(jsonb_build_object('caseId', x.id, 'subject', x.subject, 'priority', x.priority,
        'schoolDisplayName', left((SELECT s.name FROM hon.schools s WHERE s.id = x.school_id), 300),
        'organizationDisplayName', left((SELECT o.display_name FROM hon.organizations o WHERE o.id = x.organization_id), 300),
        'lastSchoolMessageAt', hon.saas_ts(x.at)) ORDER BY x.at DESC, x.id DESC)
      FROM (SELECT * FROM w ORDER BY w.at DESC, w.id DESC LIMIT 10) x), '[]'::jsonb),
    'asOf', hon.saas_ts(clock_timestamp())) INTO result;
  PERFORM hon.require_hq_support_actor(p_subject);
  RETURN result;
END $$;

-- ---------- school projections ----------
-- What a school may see of one request: its own topic, subject and messages, HQ's replies as "HON support", and the
-- case status. Never an HQ internal note, an assignee, a priority or an HQ person's name.
CREATE OR REPLACE FUNCTION hon.school_support_request_json(r hon.school_support_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('requestId',r.id,'topic',r.topic,'subject',c.subject,'status',c.status,'pageHint',r.page_hint,
    'openedAt',hon.saas_ts(c.opened_at),'updatedAt',hon.saas_ts(c.updated_at),'closedAt',hon.saas_ts(c.closed_at),
    'messages',coalesce((SELECT jsonb_agg(jsonb_build_object('seq',e.seq,'note',e.note,'at',hon.saas_ts(e.occurred_at),
        'from',CASE WHEN e.kind='REPLY' THEN 'HON' ELSE 'SCHOOL' END,
        'author',CASE WHEN e.kind='REPLY' THEN 'HON support' ELSE left(coalesce(nullif(btrim(u.display_name),''),'School staff'),120) END) ORDER BY e.seq)
      FROM hon.hq_support_case_events e JOIN hon.principals p ON p.id=e.actor_principal_id JOIN hon.users u ON u.id=p.user_id
      WHERE e.case_id=c.id AND e.note IS NOT NULL
        AND (e.kind='REPLY' OR (e.kind IN ('OPENED','NOTE') AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=e.actor_principal_id)))),'[]'::jsonb),
    -- 0713: HON support answered last and the request is still active, so it waits on the school.
    'awaitingSchool',c.status IN ('OPEN','WAITING_ON_SCHOOL') AND hon.hq_support_last_message_from(c.id)='HON')
  FROM hon.hq_support_cases c WHERE c.id=r.case_id;
$$;

CREATE OR REPLACE FUNCTION hon.read_school_support_requests(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  PERFORM hon.require_support_request_actor(p_subject);
  RETURN jsonb_build_object('requests',coalesce((SELECT jsonb_agg(hon.school_support_request_json(x) ORDER BY x.created_at DESC,x.id DESC)
      FROM (SELECT * FROM hon.school_support_requests WHERE organization_id=org AND school_id=school ORDER BY created_at DESC,id DESC LIMIT 50) x),'[]'::jsonb),
    'limits',jsonb_build_object('requestsPerDay',10,'messagesPerDay',30,'subjectMax',200,'messageMax',4000),
    'awaitingSchoolCount',(SELECT count(*) FROM hon.school_support_requests x JOIN hon.hq_support_cases c ON c.id=x.case_id
      WHERE x.organization_id=org AND x.school_id=school AND c.status IN ('OPEN','WAITING_ON_SCHOOL') AND hon.hq_support_last_message_from(c.id)='HON'),
    'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

-- ---------- grants ----------
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.hq_support_last_school_message_at(uuid)','hon.hq_support_last_reply_at(uuid)','hon.hq_support_last_message_from(uuid)',
    'hon.hq_support_needs_reply(hon.hq_support_cases)','hon.hq_support_case_json(hon.hq_support_cases)','hon.reply_to_hq_support_case(text,uuid,jsonb,uuid)',
    'hon.read_hq_support_alerts(text)','hon.school_support_request_json(hon.school_support_requests)','hon.read_school_support_requests(text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.reply_to_hq_support_case(text,uuid,jsonb,uuid), hon.read_hq_support_alerts(text),
      hon.read_school_support_requests(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
