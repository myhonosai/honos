BEGIN;

-- 0255 (allocated by the coordinator 2026-11-11): What HON remembers. School notes a person saves on purpose, shown to
-- every HON user at the school, given to HON's answers, erased on delete. Spec: docs/architecture/HON_SCHOOL_NOTES.md.
-- 1. Manage (add, delete): direct human staff with ai.school_notes.manage at the session school (OWNER by default,
--    staff-assignable). Read: ai.invocation.plan (asks HON) or manage. Authority is decided again after the last write.
-- 2. A note is 3-200 characters, one trimmed line, never a contact (email, 7+ digit run), link or markup. At most 20
--    active notes and 2,000 characters per school, under a per-school transaction lock.
-- 3. Delete erases the text at once (body NULL); the row keeps ids and times as evidence. Nothing is ever removed.
--    Audit and outbox carry ids only. Commands are idempotent by key (same key, other input: refused).
-- 4. prepare_hon_reply (0254 body) adds schoolNotes for HON only; 'schoolNotes' joins the closed source keys.

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('ai.school_notes.manage','Add or delete the school notes HON uses in its answers (never about a student, family or staff member)',false,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='ai.school_notes.manage' AND NOT is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'ai.school_notes.manage already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'ai.school_notes.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

CREATE FUNCTION hon.hon_school_note_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  -- Spelled out instead of locale classes ([[:space:]], [[:cntrl:]]) so the rule is the contract's isHonSchoolNoteText
  -- character for character: length in code points, C0/C1 controls and line separators, Unicode spaces at the edges and inside contacts.
  SELECT p IS NOT NULL AND length(p) BETWEEN 3 AND 200
    AND p !~ '^[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
    AND p !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029<>]' AND p !~* '(https?|www\.|://)'
    AND p !~ '[^ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff@]+@[^ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff@]+'
    AND regexp_replace(p, '[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff().+-]', '', 'g') !~ '[0-9]{7,}';
$$;

CREATE TABLE hon.hon_school_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  body text CHECK (body IS NULL OR hon.hon_school_note_ok(body)),
  created_by uuid NOT NULL REFERENCES hon.principals(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_by uuid REFERENCES hon.principals(id), deleted_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((deleted_at IS NULL) = (body IS NOT NULL) AND (deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE INDEX hon_school_notes_live ON hon.hon_school_notes(organization_id, school_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE hon.hon_school_note_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('add','delete')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);
ALTER TABLE hon.hon_school_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hon_school_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hon_school_note_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hon_school_note_requests FORCE ROW LEVEL SECURITY;

-- Evidence guard: never removed; a note changes only once, by the erase; a request records its response once.
CREATE FUNCTION hon.guard_hon_school_notes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'HON_SCHOOL_NOTES_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='hon_school_note_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'HON_SCHOOL_NOTES_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.body IS NOT NULL
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'HON_SCHOOL_NOTES_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hon_school_notes_guard BEFORE UPDATE OR DELETE ON hon.hon_school_notes FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_school_notes();
CREATE TRIGGER hon_school_note_requests_guard BEFORE UPDATE OR DELETE ON hon.hon_school_note_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_school_notes();
CREATE TRIGGER hon_school_notes_no_truncate BEFORE TRUNCATE ON hon.hon_school_notes FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hon_school_notes();
CREATE TRIGGER hon_school_note_requests_no_truncate BEFORE TRUNCATE ON hon.hon_school_note_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hon_school_notes();

-- Direct human at the session school with manage (p_manage) or HON/manage (read) permission now, or an error.
CREATE FUNCTION hon.hon_school_notes_actor(p_subject text, p_manage boolean) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid; org uuid; school uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  org := hon.current_organization_id(); school := hon.current_school_id();
  IF p_subject IS NULL
     OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
     OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
     OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
     OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
                    WHERE u.external_subject = p_subject AND p.id = actor AND p.is_active AND p.principal_type = 'HUMAN_USER')
     OR NOT (hon.principal_has_school_permission(actor, org, school, 'ai.school_notes.manage')
             OR (NOT p_manage AND hon.principal_has_school_permission(actor, org, school, 'ai.invocation.plan'))) THEN
    RAISE EXCEPTION 'HON_SCHOOL_NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.hon_school_note_view(n hon.hon_school_notes) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id', n.id, 'text', n.body, 'createdAt', hon.saas_ts(n.created_at));
$$;

CREATE FUNCTION hon.read_hon_school_notes(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_school_notes_actor(p_subject, false);
BEGIN
  RETURN jsonb_build_object(
    'notes', (SELECT coalesce(jsonb_agg(hon.hon_school_note_view(n) ORDER BY n.created_at DESC, n.id), '[]'::jsonb) FROM hon.hon_school_notes n
              WHERE n.organization_id = hon.current_organization_id() AND n.school_id = hon.current_school_id() AND n.deleted_at IS NULL),
    'canManage', hon.principal_has_school_permission(actor, hon.current_organization_id(), hon.current_school_id(), 'ai.school_notes.manage'),
    'limits', jsonb_build_object('maxNotes', 20, 'maxCharacters', 2000, 'noteCharacters', 200));
END $$;

-- Shared command frame: closed input, idempotency by key (fingerprint of operation + input), per-school lock, audit and
-- an internal-only outbox event with ids only, the response recorded once, and authority decided again at the end.
CREATE FUNCTION hon.hon_school_note_command(p_subject text, p_operation text, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id(); actor uuid; fp text;
  prior hon.hon_school_note_requests%ROWTYPE; n hon.hon_school_notes%ROWTYPE; live_count integer; live_chars integer; result jsonb; target uuid;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key) <> p_key OR p_key ~ '[[:cntrl:]]'
     OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id', true)
     OR (p_operation = 'add' AND ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['text']
         OR jsonb_typeof(p_input->'text') <> 'string' OR NOT hon.hon_school_note_ok(p_input->>'text')))
     OR (p_operation = 'delete' AND ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['noteId']
         OR jsonb_typeof(p_input->'noteId') <> 'string' OR (p_input->>'noteId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
     OR p_operation NOT IN ('add', 'delete') THEN
    RAISE EXCEPTION 'HON_SCHOOL_NOTE_INVALID' USING ERRCODE = '22023';
  END IF;
  actor := hon.hon_school_notes_actor(p_subject, true);
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_notes:' || school::text, 0));
  fp := encode(sha256(convert_to(jsonb_build_object('operation', p_operation, 'input', p_input)::text, 'UTF8')), 'hex');
  INSERT INTO hon.hon_school_note_requests(organization_id, school_id, principal_id, idempotency_key, operation, fingerprint)
    VALUES (org, school, actor, p_key, p_operation, fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.hon_school_note_requests WHERE organization_id = org AND school_id = school AND principal_id = actor AND idempotency_key = p_key FOR UPDATE;
    IF prior.fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'HON_SCHOOL_NOTE_BUSY' USING ERRCODE = '55P03'; END IF;
    PERFORM hon.hon_school_notes_actor(p_subject, true);
    RETURN jsonb_build_object('record', prior.response, 'replayed', true);
  END IF;
  IF p_operation = 'add' THEN
    SELECT count(*), coalesce(sum(length(body)), 0) INTO live_count, live_chars FROM hon.hon_school_notes
    WHERE organization_id = org AND school_id = school AND deleted_at IS NULL;
    IF live_count >= 20 OR live_chars + length(p_input->>'text') > 2000 THEN
      RAISE EXCEPTION 'HON_SCHOOL_NOTES_FULL' USING ERRCODE = '23514';
    END IF;
    INSERT INTO hon.hon_school_notes(organization_id, school_id, body, created_by) VALUES (org, school, p_input->>'text', actor) RETURNING * INTO n;
    target := n.id; result := jsonb_build_object('note', hon.hon_school_note_view(n));
  ELSE
    SELECT * INTO n FROM hon.hon_school_notes WHERE id = (p_input->>'noteId')::uuid AND organization_id = org AND school_id = school AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'HON_SCHOOL_NOTE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    UPDATE hon.hon_school_notes SET body = NULL, deleted_at = clock_timestamp(), deleted_by = actor WHERE id = n.id;
    target := n.id; result := jsonb_build_object('noteId', n.id, 'deleted', true);
  END IF;
  INSERT INTO hon.audit_events(organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, next_state, result, request_id, correlation_id)
    VALUES (org, school, actor, 'HUMAN_UI', 'hon.school_note.' || p_operation, 'HON_SCHOOL_NOTE', target,
      jsonb_build_object('noteId', target, 'operation', p_operation), 'SUCCEEDED', p_request, p_correlation);
  INSERT INTO hon.outbox_events(organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
    VALUES (org, school, 'hon.school_note.' || p_operation, 1, 'HON_SCHOOL_NOTE', target, CASE p_operation WHEN 'add' THEN 1 ELSE 2 END, p_correlation, p_request,
      jsonb_build_object('noteId', target, 'operation', p_operation, 'internalOnly', true));
  UPDATE hon.hon_school_note_requests SET response = result, completed_at = clock_timestamp()
    WHERE organization_id = org AND school_id = school AND principal_id = actor AND idempotency_key = p_key;
  IF hon.hon_school_notes_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'HON_SCHOOL_NOTES_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('record', result, 'replayed', false);
END $$;

CREATE FUNCTION hon.add_hon_school_note(p_subject text, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT hon.hon_school_note_command(p_subject, 'add', p_input, p_key, p_request, p_correlation);
$$;
CREATE FUNCTION hon.delete_hon_school_note(p_subject text, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT hon.hon_school_note_command(p_subject, 'delete', p_input, p_key, p_request, p_correlation);
$$;

-- 0254 source keys plus 'schoolNotes' (a superset, so every stored row stays valid).
CREATE OR REPLACE FUNCTION hon.hon_reply_source_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['newLeads24h', 'upcomingTrials24h', 'upcomingTestingEvents30d', 'pendingActionApprovals', 'outstandingWorkItems',
    'membershipTermsEnding30d', 'paidInvoicesCreated30d', 'unansweredInquiries', 'attendanceDecline', 'trialConversion', 'revenue',
    'conversation', 'specialistResults', 'schoolNotes']::text[];
$$;

-- 0254 body, plus the school notes for HON answers.
CREATE OR REPLACE FUNCTION hon.prepare_hon_reply(p_subject text, p_turn uuid, p_plan uuid, p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  actor uuid := hon.hon_conversation_actor(p_subject); lim jsonb;
  i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  why text; school_facts jsonb; history jsonb; facts jsonb; continuation jsonb; has_reporting boolean; derived boolean := false;
  prior hon.hon_reply_invocations%ROWTYPE; grp jsonb; notes jsonb;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'PENDING' THEN RETURN NULL; END IF;
  lim := hon.hon_reply_limits(i.reply_mode);
  -- Every row this prepare writes is locked before any decision (work item first, as the planner does), so no wait can
  -- fall between the authority checks below and the provider input leaving this function.
  PERFORM 1 FROM hon.work_items WHERE id = i.work_item_id FOR UPDATE;
  -- The row locks can wait behind a concurrent resend: conversation authority is held and checked again first.
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  -- After every wait above: the live-clock access gate (Complete at clock_timestamp(), not the transaction start).
  IF NOT hon.hon_reply_access(p_subject) THEN why := 'AI_ACCESS_REFUSED'; END IF;
  has_reporting := hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view');
  -- A continuation of a reporting-derived answer needs that source authority now; otherwise nothing is reserved.
  IF why IS NULL AND i.continues_turn_id IS NOT NULL THEN
    SELECT * INTO prior FROM hon.hon_reply_invocations WHERE turn_id = i.continues_turn_id AND status = 'COMPLETED';
    IF NOT FOUND OR (prior.used_reporting AND NOT has_reporting) THEN why := 'SOURCE_ACCESS_REFUSED'; END IF;
  END IF;
  -- K2: Claire analyses reporting facts only; without reporting.view now nothing is reserved or sent.
  IF why IS NULL AND i.specialist = 'claire' AND NOT has_reporting THEN why := 'SOURCE_ACCESS_REFUSED'; END IF;
  -- C3b: a group summary needs its group still summarizable for this human now; otherwise nothing is reserved.
  IF why IS NULL AND i.summarizes_turn_id IS NOT NULL
     AND hon.hon_orchestration_summary_facts(p_subject, i.conversation_id, actor, i.summarizes_turn_id) IS NULL THEN
    why := 'GROUP_NOT_SUMMARIZABLE';
  END IF;
  IF why IS NULL THEN why := hon.ai_spend_allowed(i.organization_id, clock_timestamp(), 'AGENT_INFERENCE'); END IF;
  IF why IS NULL THEN
    IF p_plan IS NULL THEN why := 'NO_ELIGIBLE_ROUTE';
    ELSE
      SELECT * INTO p FROM hon.ai_invocation_plans WHERE id = p_plan AND organization_id = i.organization_id AND school_id = i.school_id
        AND work_item_id = i.work_item_id AND agent_key = i.specialist AND task_class = lim->>'taskClass' AND input_budget = (lim->>'inputBudget')::integer
        AND output_budget = (lim->>'outputBudget')::integer AND max_provider_cost_microunits = (lim->>'maxProviderCostMicrounits')::bigint;
      IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_PLAN_SWAP' USING ERRCODE = '42501'; END IF;
      IF p.provider_id <> 'OPENROUTER' THEN why := 'UNSUPPORTED_PROVIDER'; ELSIF NOT p_ready THEN why := 'CONFIGURATION_REQUIRED'; END IF;
    END IF;
  END IF;
  -- ai.budget:<org> is already held (first declaration above).
  IF why IS NULL AND hon.ai_org_committed_credits(i.organization_id, clock_timestamp()) + p.customer_credit_estimate
                     > hon.ai_org_ceiling(i.organization_id, clock_timestamp()) THEN
    why := 'CUSTOMER_BUDGET_EXCEEDED';
  END IF;
  UPDATE hon.hon_reply_invocations SET plan_id = p.id,
    status = CASE WHEN why IS NULL THEN 'SENDING' WHEN why = 'CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,
    reason = why, reserved_credits = CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = i.id;
  UPDATE hon.work_items SET status = CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = i.work_item_id;
  IF why IS NOT NULL THEN RETURN NULL; END IF;
  -- Authorized school context only (see header). The Command Center projection re-checks reporting.view itself.
  IF has_reporting THEN
    BEGIN
      school_facts := hon.read_school_command_center(p_subject, i.organization_id, i.school_id)->'metrics';
    -- A refused fresh read means no reporting authority for this whole context: no protected history either.
    EXCEPTION WHEN insufficient_privilege THEN school_facts := NULL; has_reporting := false;
    END;
  END IF;
  SELECT * INTO STRICT t FROM hon.hon_conversation_turns WHERE id = i.turn_id;
  -- K2: Claire gets the metrics and the question only (no conversation history).
  IF i.specialist = 'hon' THEN
  SELECT coalesce(jsonb_agg(z.h ORDER BY z.seq), '[]'::jsonb) INTO history FROM (
    SELECT x.seq, jsonb_strip_nulls(jsonb_build_object('question', left(x.text, 400),
        -- A reporting-derived earlier answer is reused only while this human still holds reporting.view.
        'answer', CASE WHEN x.agent_key = 'hon' AND (NOT r.used_reporting OR has_reporting) THEN left(r.reply_text, 600) END,
      -- Owner blueprint: a legacy 'claire' teaching delegate (no reply row) is Kai; a K2 Claire analysis is Claire's.
        'delegatedTo', CASE WHEN x.agent_key = 'claire' AND NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations c WHERE c.turn_id = x.id) THEN 'kai'
                            WHEN x.agent_key <> 'hon' THEN x.agent_key END)) h
    FROM hon.hon_conversation_turns x
    LEFT JOIN hon.hon_reply_invocations r ON r.turn_id = x.id AND r.status = 'COMPLETED'
    WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq
    ORDER BY x.seq DESC LIMIT 3) z;
  SELECT coalesce(bool_or(r.used_reporting AND has_reporting), false) INTO derived FROM (
    SELECT x.id FROM hon.hon_conversation_turns x WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq ORDER BY x.seq DESC LIMIT 3) z
    JOIN hon.hon_reply_invocations r ON r.turn_id = z.id AND r.status = 'COMPLETED';
  END IF;
  -- A continuation also gets the answer's original question and the end of the part already given (data only).
  IF i.continues_turn_id IS NOT NULL THEN
    WITH RECURSIVE chain AS (
      SELECT r.turn_id, r.continues_turn_id FROM hon.hon_reply_invocations r WHERE r.turn_id = i.continues_turn_id
      UNION ALL
      SELECT r.turn_id, r.continues_turn_id FROM hon.hon_reply_invocations r JOIN chain c ON r.turn_id = c.continues_turn_id)
    SELECT jsonb_build_object('step', i.step, 'maxSteps', hon.hon_reply_max_steps(),
        'originalQuestion', (SELECT left(x.text, 2000) FROM chain c JOIN hon.hon_conversation_turns x ON x.id = c.turn_id WHERE c.continues_turn_id IS NULL),
        'previousAnswerEnd', (SELECT right(r.reply_text, 2500) FROM hon.hon_reply_invocations r WHERE r.turn_id = i.continues_turn_id AND r.status = 'COMPLETED'))
      INTO continuation;
    derived := derived OR prior.used_reporting;
  END IF;
  -- C3b: the group's recorded outcomes, read last (a source answer derived from reporting makes the context derived).
  IF i.summarizes_turn_id IS NOT NULL THEN
    grp := hon.hon_orchestration_summary_facts(p_subject, i.conversation_id, actor, i.summarizes_turn_id);
    derived := derived OR coalesce((SELECT r.used_reporting FROM hon.hon_reply_invocations r WHERE r.turn_id = i.summarizes_turn_id), false);
  END IF;
  -- Final live-clock revalidation before any context leaves prepare: access (Complete at clock_timestamp()) and, when the
  -- context carries reporting-derived material, reporting.view. A lapse here releases the reservation and sends nothing.
  why := CASE WHEN NOT hon.hon_reply_access(p_subject) THEN 'AI_ACCESS_REFUSED'
    WHEN i.summarizes_turn_id IS NOT NULL AND grp IS NULL THEN 'GROUP_NOT_SUMMARIZABLE'
    WHEN i.specialist = 'claire' AND school_facts IS NULL THEN 'SOURCE_ACCESS_REFUSED'
    WHEN (school_facts IS NOT NULL OR derived) AND NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view') THEN 'SOURCE_ACCESS_REFUSED' END;
  IF why IS NOT NULL THEN
    UPDATE hon.hon_reply_invocations SET status = 'BLOCKED', reason = why, reserved_credits = 0, updated_at = clock_timestamp() WHERE id = i.id;
    UPDATE hon.work_items SET status = 'NEEDS_ATTENTION', version = version + 1, updated_at = clock_timestamp() WHERE id = i.work_item_id;
    RETURN NULL;
  END IF;
  -- 0255: the school's saved notes (newest first) for HON answers only; Claire keeps metrics only.
  IF i.specialist = 'hon' THEN
    SELECT nullif(coalesce(jsonb_agg(n.body ORDER BY n.created_at DESC, n.id), '[]'::jsonb), '[]'::jsonb) INTO notes
    FROM hon.hon_school_notes n WHERE n.organization_id = i.organization_id AND n.school_id = i.school_id AND n.deleted_at IS NULL;
  END IF;
  facts := jsonb_strip_nulls(jsonb_build_object('school', coalesce(school_facts, jsonb_build_object('availability', 'NOT_AUTHORIZED')), 'history', history,
    'continuation', continuation, 'group', grp, 'schoolNotes', notes));
  -- 0254: the closed fact areas this context actually carries, for "Based on": AVAILABLE metrics (in the closed key
  -- order), the earlier conversation (history or a continuation) and recorded specialist results (a group).
  UPDATE hon.hon_reply_invocations SET available_sources = ARRAY(
      SELECT k FROM unnest(hon.hon_reply_source_keys()) WITH ORDINALITY s(k, n)
      WHERE (k NOT IN ('conversation', 'specialistResults') AND school_facts->k->>'availability' = 'AVAILABLE')
         OR (k = 'conversation' AND (jsonb_array_length(coalesce(history, '[]'::jsonb)) > 0 OR continuation IS NOT NULL))
         OR (k = 'specialistResults' AND grp IS NOT NULL)
         OR (k = 'schoolNotes' AND notes IS NOT NULL)
      ORDER BY n)
  WHERE id = i.id;
  UPDATE hon.hon_reply_invocations SET used_reporting = school_facts IS NOT NULL OR derived, context_digest = encode(sha256(convert_to(jsonb_build_object('question', t.text, 'facts', facts)::text, 'UTF8')), 'hex')
  WHERE id = i.id;
  RETURN jsonb_build_object('providerId', p.provider_id, 'modelId', p.model_id, 'providerRequestId', i.provider_request_id,
    'specialist', i.specialist, 'replyMode', i.reply_mode, 'step', i.step, 'question', t.text, 'facts', facts::text, 'inputBudget', p.input_budget, 'outputBudget', p.output_budget,
    'maxCostMicrounits', p.max_provider_cost_microunits);
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['hon_school_notes','hon_school_note_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.hon_school_note_ok(text)','hon.guard_hon_school_notes()','hon.hon_school_notes_actor(text,boolean)',
    'hon.hon_school_note_view(hon.hon_school_notes)','hon.read_hon_school_notes(text)','hon.hon_school_note_command(text,text,jsonb,text,uuid,uuid)',
    'hon.add_hon_school_note(text,jsonb,text,uuid,uuid)','hon.delete_hon_school_note(text,jsonb,text,uuid,uuid)','hon.hon_reply_source_keys()']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hon_school_notes(text),hon.add_hon_school_note(text,jsonb,text,uuid,uuid),hon.delete_hon_school_note(text,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
