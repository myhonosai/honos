BEGIN;

-- Maya renewal prep, P5 (0646). Spec: docs/architecture/MAYA_RENEWAL_PREP.md. Owner request 2026-11-22 ("all ai agent backend
-- done and switch them on"): Maya reads the school's memberships whose term ends in the next 30 or 60 days and suggests, for up
-- to ten of them, a priority and a talking point for the renewal conversation. A person ticks the ones they want and each becomes
-- an OPEN renewal review through the ordinary human renewal path (0080), as that person. Nothing is sent to a family and no
-- membership, schedule or payment changes. A new kind on the shared AI text proposals (0550), built like Jordan follow-ups (0640)
-- and reusing the 0639 line, key and immutability helpers. The 0550 core and every S4 function are unchanged.
--   R1 Who asks: a direct human with retention.review.read (Maya, 0259 rules), billing.membership.read and
--      billing.renewal.manage (0080), and ai.invocation.plan at the session school, with an active Complete entitlement. The
--      planner enforces the per-staff Maya switch (0635) on every Maya call.
--   R2 Facts: the brief, the school name, the local date and up to 30 memberships as M1.. with state,
--      days until the term ends, months as a member, classes attended in the last 30 days and the 30 before, days since the last
--      class and whether a renewal review is already open. No name, contact, family, plan code, amount or payment record is sent.
--   R3 Answer: {summary, suggestions[1..10]}, one suggestion per membership; checked here and by the contracts validator.
--   R4 Apply: the requester ticks suggestions; each runs hon.mutate_renewal CREATE as that person (review from now to the term
--      end, Maya's talking point as the note, reminder on). A membership that changed since Maya read it, has ended, or already
--      has an open review is refused; everything is all or nothing; an exact retry replays.
--   R5 Who reads: the requester only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Maya renewal prep requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Maya renewal prep requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.alex_plan_line_ok(text,integer)') IS NULL OR to_regprocedure('hon.begin_claire_kpi_report(text,jsonb,uuid)') IS NULL
    OR to_regprocedure('hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.require_maya_actor(text,text)') IS NULL
    OR to_regprocedure('hon.begin_maya_renewal_prep(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Maya renewal prep requires migrations 0639 to 0643 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('MAYA_RENEWAL_PREP','maya','ANALYZE',12000,3000,80000,12288,'HUMAN_UI','SCHOOL','RETENTION');

-- The memberships Maya saw, fixed when the facts were built: M<n> is a membership at the version Maya read.
CREATE TABLE hon.maya_renewal_refs (
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^M([1-9]|[12][0-9]|30)$'),
  membership_id uuid NOT NULL REFERENCES hon.memberships(id) ON DELETE RESTRICT,
  membership_version integer NOT NULL CHECK (membership_version BETWEEN 1 AND 999999999),
  PRIMARY KEY (proposal_id, ref)
);
CREATE UNIQUE INDEX maya_renewal_refs_membership ON hon.maya_renewal_refs(proposal_id, membership_id);
-- What an apply created, one renewal review per ticked suggestion.
CREATE TABLE hon.maya_renewal_applied (
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  suggestion_index integer NOT NULL CHECK (suggestion_index BETWEEN 0 AND 9),
  renewal_id uuid NOT NULL REFERENCES hon.membership_renewal_reviews(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  applied_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (proposal_id, suggestion_index)
);
CREATE TRIGGER maya_renewal_refs_guard BEFORE UPDATE OR DELETE ON hon.maya_renewal_refs FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER maya_renewal_refs_no_truncate BEFORE TRUNCATE ON hon.maya_renewal_refs FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER maya_renewal_applied_guard BEFORE UPDATE OR DELETE ON hon.maya_renewal_applied FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER maya_renewal_applied_no_truncate BEFORE TRUNCATE ON hon.maya_renewal_applied FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.maya_renewal_refs','hon.maya_renewal_applied'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- {window: NEXT_30_DAYS | NEXT_60_DAYS, note: 0..300 (empty allowed)}.
CREATE FUNCTION hon.maya_renewal_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(p,ARRAY['note','window'])
    AND jsonb_typeof(p->'window')='string' AND (p->>'window') IN ('NEXT_30_DAYS','NEXT_60_DAYS')
    AND jsonb_typeof(p->'note')='string' AND ((p->>'note')='' OR hon.alex_plan_line_ok(p->>'note',300))
$$;

-- What an answer may hold: one suggestion per membership, a priority, a talking point and why.
CREATE FUNCTION hon.maya_renewal_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(r,ARRAY['suggestions','summary'])
    AND jsonb_typeof(r->'summary')='string' AND hon.alex_plan_line_ok(r->>'summary',300)
    AND jsonb_typeof(r->'suggestions')='array' AND jsonb_array_length(r->'suggestions') BETWEEN 1 AND 10 AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'suggestions') t WHERE NOT (
      hon.alex_plan_keys_are(t,ARRAY['membership','priority','reason','talkingPoint'])
      AND jsonb_typeof(t->'membership')='string' AND (t->>'membership') ~ '^M([1-9]|[12][0-9]|30)$'
      AND jsonb_typeof(t->'priority')='string' AND (t->>'priority') IN ('HIGH','NORMAL','LOW')
      AND jsonb_typeof(t->'talkingPoint')='string' AND hon.alex_plan_line_ok(t->>'talkingPoint',300)
      AND jsonb_typeof(t->'reason')='string' AND hon.alex_plan_line_ok(t->>'reason',300)))
    AND (SELECT count(DISTINCT t->>'membership') FROM jsonb_array_elements(r->'suggestions') t)=jsonb_array_length(r->'suggestions')
$$;

-- The reader: Maya's capability (0259 direct-human rules, Complete) and membership read at the session school.
CREATE FUNCTION hon.maya_renewal_reader(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_maya_actor(p_subject,'retention.review.read');
BEGIN
  IF NOT hon.renewal_has_permission(actor,hon.current_organization_id(),hon.current_school_id(),'billing.membership.read') THEN
    RAISE EXCEPTION 'MAYA_RENEWAL_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- The requester for a command: the reader plus renewal review management and AI planning at the session school.
CREATE FUNCTION hon.maya_renewal_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_renewal_reader(p_subject);
BEGIN
  IF NOT hon.renewal_has_permission(actor,hon.current_organization_id(),hon.current_school_id(),'billing.renewal.manage')
    OR NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),'ai.invocation.plan') THEN
    RAISE EXCEPTION 'MAYA_RENEWAL_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- A renewal review counts as open while its latest version is OPEN or DEFERRED.
CREATE FUNCTION hon.maya_renewal_open_review(p_membership uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.membership_renewal_reviews f
    WHERE f.membership_id=p_membership AND f.organization_id=hon.current_organization_id() AND f.school_id=hon.current_school_id()
      AND (SELECT v.status FROM hon.membership_renewal_versions v WHERE v.renewal_id=f.id ORDER BY v.version DESC LIMIT 1) IN ('OPEN','DEFERRED'))
$$;

-- Fix the aliases (once): ACTIVE or CANCELLATION_PENDING memberships whose term ends within the window, soonest first.
CREATE FUNCTION hon.maya_renewal_fix_refs(p_id uuid, p_window text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
  horizon interval := CASE p_window WHEN 'NEXT_60_DAYS' THEN interval '60 days' ELSE interval '30 days' END;
BEGIN
  IF EXISTS(SELECT 1 FROM hon.maya_renewal_refs WHERE proposal_id=p_id) THEN RETURN; END IF;
  INSERT INTO hon.maya_renewal_refs(proposal_id,organization_id,school_id,ref,membership_id,membership_version)
    SELECT p_id, org, school, 'M'||row_number() OVER (ORDER BY x.term_ends_at, x.id), x.id, x.version
    FROM (SELECT m.id, m.version, m.term_ends_at FROM hon.memberships m
          WHERE m.organization_id=org AND m.school_id=school AND m.state IN ('ACTIVE','CANCELLATION_PENDING')
            AND m.term_ends_at IS NOT NULL AND m.term_ends_at>clock_timestamp()+interval '1 minute' AND m.term_ends_at<=clock_timestamp()+horizon
          ORDER BY m.term_ends_at, m.id LIMIT 30) x;
END $$;

-- The facts Maya sees (at most about 8 KB). Record-derived numbers only.
CREATE FUNCTION hon.maya_renewal_facts(p_subject text, p_id uuid, p_brief jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('brief',p_brief,'schoolName',left(s.name,120),'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'state',m.state::text,
        'daysUntilTermEnds',((m.term_ends_at AT TIME ZONE s.timezone)::date - hon.membership_school_today()),
        'monthsAsMember',floor(extract(epoch FROM clock_timestamp()-coalesce(m.term_started_at,m.created_at))/2629800)::integer,
        'classesLast30Days',coalesce(a.recent,0),'classesPrevious30Days',coalesce(a.prior,0),
        'daysSinceLastClass',CASE WHEN a.last_seen IS NULL THEN NULL ELSE floor(extract(epoch FROM clock_timestamp()-a.last_seen)/86400)::integer END,
        'renewalReviewOpen',hon.maya_renewal_open_review(m.id)) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.maya_renewal_refs r JOIN hon.memberships m ON m.id=r.membership_id
      LEFT JOIN LATERAL (SELECT max(cs.starts_at) last_seen,
          count(*) FILTER (WHERE cs.starts_at>=clock_timestamp()-interval '30 days') recent,
          count(*) FILTER (WHERE cs.starts_at>=clock_timestamp()-interval '60 days' AND cs.starts_at<clock_timestamp()-interval '30 days') prior
        FROM hon.student_profiles sp
        JOIN hon.attendance_records ar ON ar.student_profile_id=sp.id AND ar.organization_id=m.organization_id AND ar.school_id=m.school_id
          AND ar.status IN ('PRESENT','LATE','MAKEUP')
        JOIN hon.class_sessions cs ON cs.id=ar.class_session_id AND cs.organization_id=m.organization_id AND cs.school_id=m.school_id AND cs.starts_at<=clock_timestamp()
        WHERE sp.person_id=m.participant_person_id AND sp.organization_id=m.organization_id AND sp.school_id=m.school_id) a ON true
      WHERE r.proposal_id=p_id),'[]'::jsonb))
  FROM hon.schools s WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id()
$$;

-- The requester's view: names and term dates are shown to the requester (who holds billing.membership.read), never sent to Maya.
CREATE FUNCTION hon.maya_renewal_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,
    'summary',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'summary' END,
    'suggestions',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->'suggestions' END,
    'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'membershipId',r.membership_id,
        'name',left(btrim(coalesce(pp.given_name,'')||' '||coalesce(pp.family_name,'')),120),
        'termEndsOn',to_char((m.term_ends_at AT TIME ZONE s.timezone)::date,'YYYY-MM-DD')) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.maya_renewal_refs r JOIN hon.memberships m ON m.id=r.membership_id JOIN hon.people pp ON pp.id=m.participant_person_id
      JOIN hon.schools s ON s.id=m.school_id WHERE r.proposal_id=i.id),'[]'::jsonb),
    'applied',coalesce((SELECT jsonb_agg(jsonb_build_object('index',c.suggestion_index,'renewalId',c.renewal_id) ORDER BY c.suggestion_index)
      FROM hon.maya_renewal_applied c WHERE c.proposal_id=i.id),'[]'::jsonb),
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='MAYA_RENEWAL_PREP' AND i.requested_by=p_actor
    AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_maya_renewal_prep(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_renewal_actor(p_subject); pid uuid;
BEGIN
  IF p_key IS NULL OR NOT hon.maya_renewal_brief_ok(p_input) THEN RAISE EXCEPTION 'MAYA_RENEWAL_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('MAYA_RENEWAL_PREP',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  RETURN hon.maya_renewal_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_maya_renewal_prep(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MAYA_RENEWAL_PREP') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, hon.maya_renewal_actor(p_subject));
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, then the facts.
CREATE FUNCTION hon.prepare_maya_renewal_prep(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.maya_renewal_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'MAYA_RENEWAL_PREP' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  PERFORM hon.maya_renewal_fix_refs(p_id, i.request->>'window');
  RETURN inv || jsonb_build_object('request',hon.maya_renewal_facts(p_subject,p_id,i.request)::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule).
CREATE FUNCTION hon.fail_maya_renewal_prep(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MAYA_RENEWAL_PREP') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape, or naming a membership alias Maya was not given,
-- is stored empty and rejected.
CREATE FUNCTION hon.record_maya_renewal_prep(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MAYA_RENEWAL_PREP') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.alex_plan_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.maya_renewal_ok(proposal) OR EXISTS(SELECT 1 FROM jsonb_array_elements(proposal->'suggestions') t
      WHERE NOT EXISTS(SELECT 1 FROM hon.maya_renewal_refs r WHERE r.proposal_id=p_id AND r.ref=t->>'membership')) THEN
    proposal := jsonb_build_object('summary','','suggestions','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a renewal list for these memberships.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.maya_renewal_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The requester's newest 20 renewal lists, or one by id.
CREATE FUNCTION hon.read_maya_renewal_preps(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_renewal_reader(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.maya_renewal_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.maya_renewal_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='MAYA_RENEWAL_PREP' AND requested_by=actor
      AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY created_at DESC, id LIMIT 20) x),'[]'::jsonb);
END $$;

-- Open a renewal review for each ticked suggestion through 0080 as the requester, then close the list APPLIED.
-- p_input = {suggestions: [index, ...]} (1..10 distinct). p_key is the request's Idempotency-Key; each step uses <p_key>:<index>.
CREATE FUNCTION hon.apply_maya_renewal_preps(p_subject text, p_id uuid, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_renewal_actor(p_subject); i hon.ai_text_proposals%ROWTYPE; idx integer; t jsonb; ref hon.maya_renewal_refs%ROWTYPE;
  m hon.memberships%ROWTYPE; made jsonb; picked integer[]; iso text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'; now_ms timestamptz;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 160 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR NOT hon.alex_plan_keys_are(p_input,ARRAY['suggestions']) OR jsonb_typeof(p_input->'suggestions')<>'array' OR jsonb_array_length(p_input->'suggestions') NOT BETWEEN 1 AND 10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'suggestions') e WHERE jsonb_typeof(e)<>'number' OR (e#>>'{}') !~ '^[0-9]$') THEN
    RAISE EXCEPTION 'MAYA_RENEWAL_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(DISTINCT (e#>>'{}')::integer ORDER BY (e#>>'{}')::integer) INTO picked FROM jsonb_array_elements(p_input->'suggestions') e;
  IF cardinality(picked)<>jsonb_array_length(p_input->'suggestions') THEN RAISE EXCEPTION 'MAYA_RENEWAL_INVALID' USING ERRCODE='22023'; END IF;
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'MAYA_RENEWAL_PREP' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF i.status='APPLIED' THEN
    IF (SELECT array_agg(suggestion_index ORDER BY suggestion_index) FROM hon.maya_renewal_applied WHERE proposal_id=i.id) IS NOT DISTINCT FROM picked
      AND NOT EXISTS(SELECT 1 FROM hon.maya_renewal_applied WHERE proposal_id=i.id AND idempotency_key<>p_key) THEN
      RETURN hon.maya_renewal_view(i.id, actor) || jsonb_build_object('replayed',true);
    END IF;
    RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001';
  END IF;
  IF i.status<>'RESULT_RECORDED' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(picked) x WHERE x>=jsonb_array_length(i.result->'suggestions')) THEN RAISE EXCEPTION 'MAYA_RENEWAL_INVALID' USING ERRCODE='22023'; END IF;
  now_ms := date_trunc('milliseconds', clock_timestamp());
  FOREACH idx IN ARRAY picked LOOP
    t := i.result->'suggestions'->idx;
    SELECT * INTO ref FROM hon.maya_renewal_refs r WHERE r.proposal_id=i.id AND r.ref=t->>'membership';
    IF NOT FOUND THEN RAISE EXCEPTION 'MAYA_RENEWAL_INVALID' USING ERRCODE='22023'; END IF;
    SELECT * INTO m FROM hon.memberships x WHERE x.id=ref.membership_id AND x.organization_id=i.organization_id AND x.school_id=i.school_id FOR SHARE;
    -- The membership must still be the one Maya read, still running, with its term still ahead.
    IF NOT FOUND OR m.version<>ref.membership_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF m.state NOT IN ('ACTIVE','CANCELLATION_PENDING') OR m.term_ends_at IS NULL OR m.term_ends_at<now_ms+interval '1 minute' THEN
      RAISE EXCEPTION 'MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002';
    END IF;
    IF hon.maya_renewal_open_review(m.id) THEN RAISE EXCEPTION 'MAYA_RENEWAL_REVIEW_OPEN' USING ERRCODE='40001'; END IF;
    made := hon.mutate_renewal(p_subject,'CREATE',NULL,jsonb_build_object('expectedVersion',0,'membershipId',m.id::text,
      'reviewFrom',to_char(now_ms AT TIME ZONE 'UTC',iso),'reviewTo',to_char(date_trunc('milliseconds',m.term_ends_at) AT TIME ZONE 'UTC',iso),'status','OPEN',
      'note',(t->>'talkingPoint')||E'\n'||'Why: '||(t->>'reason'),
      'reason','Prepared with Maya ('||initcap(t->>'priority')||' priority)','reminderNeeded',true),
      p_key||':'||idx,p_request,p_correlation);
    INSERT INTO hon.maya_renewal_applied(proposal_id,organization_id,school_id,suggestion_index,renewal_id,idempotency_key,applied_by)
      VALUES(i.id,i.organization_id,i.school_id,idx,(made->'renewal'->>'renewalId')::uuid,p_key,actor);
  END LOOP;
  PERFORM hon.ai_text_close(i.id, actor, 'APPLIED');
  RETURN hon.maya_renewal_view(i.id, actor) || jsonb_build_object('replayed',false);
END $$;

-- DISMISSED. The requester only; they must still be able to read the lists.
CREATE FUNCTION hon.close_maya_renewal_prep(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_renewal_reader(p_subject);
BEGIN
  IF p_status IS DISTINCT FROM 'DISMISSED' THEN RAISE EXCEPTION 'MAYA_RENEWAL_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MAYA_RENEWAL_PREP') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.maya_renewal_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the eight entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.maya_renewal_brief_ok(jsonb)','hon.maya_renewal_ok(jsonb)','hon.maya_renewal_reader(text)',
    'hon.maya_renewal_actor(text)','hon.maya_renewal_open_review(uuid)','hon.maya_renewal_fix_refs(uuid,text)','hon.maya_renewal_facts(text,uuid,jsonb)',
    'hon.maya_renewal_view(uuid,uuid)','hon.begin_maya_renewal_prep(text,jsonb,uuid)','hon.plan_maya_renewal_prep(text,uuid)',
    'hon.prepare_maya_renewal_prep(text,uuid,uuid,boolean)','hon.fail_maya_renewal_prep(text,uuid,text,text)','hon.record_maya_renewal_prep(text,uuid,jsonb)',
    'hon.read_maya_renewal_preps(text,uuid)','hon.apply_maya_renewal_preps(text,uuid,jsonb,text,uuid,uuid)','hon.close_maya_renewal_prep(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_maya_renewal_prep(text,jsonb,uuid), hon.plan_maya_renewal_prep(text,uuid), hon.prepare_maya_renewal_prep(text,uuid,uuid,boolean),
      hon.fail_maya_renewal_prep(text,uuid,text,text), hon.record_maya_renewal_prep(text,uuid,jsonb), hon.read_maya_renewal_preps(text,uuid),
      hon.apply_maya_renewal_preps(text,uuid,jsonb,text,uuid,uuid), hon.close_maya_renewal_prep(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
