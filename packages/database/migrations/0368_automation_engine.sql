BEGIN;

-- AU-2 (0368, coordinator-allocated 2026-11-15): the Automation Builder engine.
-- Design: docs/superpowers/specs/2026-11-15-automation-builder-design.md (5.3, 5.4).
-- - A human with automation.workflow.activate turns a DRAFT or PAUSED workflow on at one of its versions, or pauses it.
--   Turning on checks that every id in the definition belongs to the school and that every trigger, step, condition,
--   exit and merge field it uses is one this engine runs (the rest come in later pieces and are refused by name).
-- - The engine role (hon_automation_worker, infra/postgres/014) runs two fixed functions and nothing else:
--   consume_automation_events reads qualifying outbox events (own receipts, never the delivery queue) and starts runs;
--   run_due_automation_steps executes due steps, each in its own subtransaction, all inside the database.
-- - Messages are created QUEUED in hon.communication_messages by the HON Automation principal with origin AUTOMATION;
--   the 0243 delivery worker sends them with its own consent, address, quiet-hours and STOP checks. Consent is also
--   checked here when the step runs. AI-written steps use their fixed fallback wording (no provider call in this piece).
-- - Rails: authority is re-proved before every step (school and organization active, active COMPLETE entitlement, the
--   person who turned it on still holds automation.workflow.activate there); if it fails the workflow pauses with a
--   reason. At most 3 automated messages per contact per 24 hours across workflows, 500 runs per workflow per day, an
--   automatic pause when 20% or more of the last 50 finished steps failed, one open run per workflow and contact,
--   START_WORKFLOW chains at most 3 deep and never into itself, and tag events a workflow caused never restart it.
-- - Ids in a definition are re-checked against the school when a step uses them (stage, workflow).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.validate_automation_definition(jsonb)') IS NULL OR to_regclass('hon.communication_deliveries') IS NULL
    OR to_regclass('hon.work_items') IS NULL OR to_regclass('hon.crm_appointments') IS NULL THEN RAISE EXCEPTION '0368 requires 0367, 0243, 0084 and 0043'; END IF;
END $$;

-- The HON Automation principal: creates automated messages and tasks, never signs in.
INSERT INTO hon.principals(id,principal_type,user_id,display_name,is_active)
  VALUES('00000000-0000-4000-8000-000000000368','AUTOMATION',NULL,'HON Automation',true) ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000368' AND principal_type='AUTOMATION' AND user_id IS NULL AND is_active) THEN
    RAISE EXCEPTION 'HON Automation principal is not in the expected state'; END IF;
END $$;

-- Where a queued message came from (shared with Conversation AI 0377) and an email subject the author wrote.
ALTER TABLE hon.communication_messages
  ADD COLUMN origin_kind text NOT NULL DEFAULT 'STAFF' CHECK (origin_kind IN ('STAFF','CONVERSATION_AI','CAMPAIGN','AUTOMATION')),
  ADD COLUMN origin_id uuid,
  ADD COLUMN email_subject text CHECK (email_subject IS NULL OR (char_length(email_subject) BETWEEN 1 AND 150 AND email_subject=btrim(email_subject)
    AND email_subject !~ '[[:cntrl:]]'));
ALTER TABLE hon.communication_messages ADD CONSTRAINT communication_messages_origin_shape
  CHECK ((origin_kind='STAFF') = (origin_id IS NULL) AND (email_subject IS NULL OR channel='EMAIL'));
CREATE INDEX communication_messages_automation_cap_idx ON hon.communication_messages (organization_id,school_id,recipient_person_id,created_at)
  WHERE origin_kind='AUTOMATION';

ALTER TABLE hon.automation_commands DROP CONSTRAINT automation_commands_operation_check;
ALTER TABLE hon.automation_commands ADD CONSTRAINT automation_commands_operation_check
  CHECK (operation IN ('WF_CREATE','WF_SAVE','WF_RESTORE','WF_ARCHIVE','TAG_ADD','TAG_REMOVE','WF_ACTIVATE','WF_PAUSE'));

-- One receipt per consumed outbox event.
CREATE TABLE hon.automation_event_receipts (
  outbox_event_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  runs_started integer NOT NULL CHECK (runs_started BETWEEN 0 AND 100),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE INDEX automation_event_receipts_school_idx ON hon.automation_event_receipts (organization_id,school_id,consumed_at DESC);

CREATE TABLE hon.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  workflow_id uuid NOT NULL, workflow_version integer NOT NULL CHECK (workflow_version BETWEEN 1 AND 500),
  person_id uuid NOT NULL,
  trigger_key text NOT NULL CHECK (trigger_key ~ '^[a-z]{2,10}:[0-9a-f-]{36}(:[A-Z_]{1,20})?$'),
  trigger_event_id uuid, parent_run_id uuid REFERENCES hon.automation_runs(id),
  depth integer NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 3),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','EXITED','STOPPED','FAILED','CANCELLED')),
  end_code text CHECK (end_code IS NULL OR end_code ~ '^[A-Z_]{1,40}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), ended_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  UNIQUE (id,organization_id,school_id),
  UNIQUE (workflow_id,trigger_key,person_id),
  FOREIGN KEY (workflow_id,organization_id,school_id) REFERENCES hon.automation_workflows(id,organization_id,school_id),
  FOREIGN KEY (workflow_id,workflow_version) REFERENCES hon.automation_workflow_versions(workflow_id,version),
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id),
  CHECK ((status='RUNNING') = (ended_at IS NULL)),
  CHECK ((status IN ('RUNNING','COMPLETED')) = (end_code IS NULL)),
  CHECK ((depth=0) = (parent_run_id IS NULL))
);
CREATE UNIQUE INDEX automation_runs_one_open_idx ON hon.automation_runs (workflow_id,person_id) WHERE status='RUNNING';
CREATE INDEX automation_runs_workflow_idx ON hon.automation_runs (organization_id,school_id,workflow_id,started_at DESC);
CREATE INDEX automation_runs_person_idx ON hon.automation_runs (workflow_id,person_id,started_at DESC);

CREATE TABLE hon.automation_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL, run_id uuid NOT NULL,
  step_id text NOT NULL CHECK (step_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  step_type text NOT NULL CHECK (step_type IN ('SEND_SMS','SEND_EMAIL','CREATE_TASK','NOTIFY_STAFF','ASSIGN_LEAD','ADD_TAG','REMOVE_TAG','MOVE_STAGE',
    'START_WORKFLOW','WAIT','WAIT_FOR','IF','REQUEST_APPROVAL','STOP')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','WAITING','DONE','SKIPPED','FAILED')),
  due_at timestamptz NOT NULL, wait_until timestamptz,
  outcome_code text CHECK (outcome_code IS NULL OR outcome_code ~ '^[A-Z_]{1,40}$'),
  branch text CHECK (branch IS NULL OR branch IN ('YES','NO')),
  message_id uuid, work_item_id uuid, started_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  UNIQUE (run_id,step_id),
  FOREIGN KEY (run_id,organization_id,school_id) REFERENCES hon.automation_runs(id,organization_id,school_id),
  FOREIGN KEY (message_id,organization_id,school_id) REFERENCES hon.communication_messages(id,organization_id,school_id),
  FOREIGN KEY (work_item_id,organization_id,school_id) REFERENCES hon.work_items(id,organization_id,school_id),
  CHECK ((status IN ('PENDING','WAITING')) = (finished_at IS NULL)),
  CHECK ((status IN ('PENDING','WAITING')) = (outcome_code IS NULL)),
  CHECK ((status='WAITING') = (wait_until IS NOT NULL))
);
CREATE INDEX automation_run_steps_due_idx ON hon.automation_run_steps (due_at,id) WHERE status IN ('PENDING','WAITING');
CREATE INDEX automation_run_steps_finished_idx ON hon.automation_run_steps (organization_id,school_id,finished_at DESC) WHERE finished_at IS NOT NULL;

-- The engine reads only these outbox events.
CREATE INDEX outbox_events_automation_idx ON hon.outbox_events (occurred_at,id) WHERE event_type IN (
  'crm.lead.created','marketing.form.lead_received','marketing.zernio.lead_received','crm.trial.scheduled','crm.trial.outcome.recorded',
  'class.booking.created','billing.membership.activated','billing.membership.cancelled','testing.registration.interest.submitted','contact.tag.added');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['automation_event_receipts','automation_runs','automation_run_steps'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_automation_workflow_history()',t);
  END LOOP;
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.automation_event_receipts FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_workflow_history();

-- Runs and steps only move forward: identity never changes, nothing is deleted, a finished record never changes.
CREATE FUNCTION hon.guard_automation_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='automation_runs' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.workflow_id,NEW.workflow_version,NEW.person_id,NEW.trigger_key,NEW.trigger_event_id,NEW.parent_run_id,NEW.depth,NEW.started_at)
        IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.workflow_id,OLD.workflow_version,OLD.person_id,OLD.trigger_key,OLD.trigger_event_id,OLD.parent_run_id,OLD.depth,OLD.started_at)
      AND OLD.status='RUNNING' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='automation_run_steps' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.run_id,NEW.step_id,NEW.step_type,NEW.created_at)
        IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.run_id,OLD.step_id,OLD.step_type,OLD.created_at)
      AND OLD.status IN ('PENDING','WAITING') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'AUTOMATION_HISTORY_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.automation_runs FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_run();
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.automation_run_steps FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_run();

-- ---------------------------------------------------------------------------------------------------------------------
-- What this engine runs, and the ids a definition names
-- ---------------------------------------------------------------------------------------------------------------------
-- The first part of the definition this engine does not run yet, or NULL when it runs all of it.
CREATE FUNCTION hon.automation_unavailable(d jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE s jsonb; c jsonb; t text; m text;
BEGIN
  IF NOT (d->'trigger'->>'kind' = ANY (ARRAY['LEAD_CREATED','FORM_LEAD_RECEIVED','META_LEAD_RECEIVED','TRIAL_BOOKED','TRIAL_CANCELLED','TRIAL_ATTENDED',
      'TRIAL_NO_SHOW','CLASS_BOOKING_CREATED','MEMBERSHIP_ACTIVATED','MEMBERSHIP_CANCELLED','TESTING_REGISTRATION_SUBMITTED','TAG_ADDED'])) THEN
    RETURN 'trigger '||(d->'trigger'->>'kind'); END IF;
  IF d->'exitWhen' ? 'REPLIED' THEN RETURN 'exit REPLIED'; END IF;
  FOR c IN SELECT x FROM jsonb_array_elements(d->'entry'->'conditions') x UNION ALL
    SELECT y->'condition' FROM jsonb_array_elements(d->'steps') y WHERE y->>'type'='IF' LOOP
    IF c->>'kind' IN ('REPLIED','IN_PROGRAM','CUSTOM_FIELD_EQUALS') THEN RETURN 'condition '||(c->>'kind'); END IF;
  END LOOP;
  FOR s IN SELECT x FROM jsonb_array_elements(d->'steps') x LOOP
    IF s->>'type' IN ('ASSIGN_LEAD','REQUEST_APPROVAL') THEN RETURN 'step '||(s->>'type'); END IF;
    IF s->>'type'='WAIT_FOR' AND s->>'event'='REPLIED' THEN RETURN 'wait for REPLIED'; END IF;
    IF s->>'type' IN ('CREATE_TASK','NOTIFY_STAFF') AND coalesce(s->>'assignTo',s->>'to')='LEAD_ASSIGNEE' THEN RETURN 'staff target LEAD_ASSIGNEE'; END IF;
    FOREACH t IN ARRAY ARRAY[s->'content'->>'text',s->'content'->>'subject',s->'content'->>'fallbackText',s->'content'->>'fallbackSubject',s->>'title',s->>'details',s->>'text'] LOOP
      IF t IS NOT NULL THEN
        m:=substring(t from '\{\{(program_name|trial_time|booking_link|staff_name)\}\}');
        IF m IS NOT NULL THEN RETURN 'merge field '||m; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

-- True when every id the definition names belongs to the school (stages, forms, workflows). Checked when turned on.
CREATE FUNCTION hon.automation_references_ok(p_org uuid,p_school uuid,p_workflow uuid,d jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT (d->'trigger'->>'kind'<>'FORM_LEAD_RECEIVED' OR jsonb_typeof(d->'trigger'->'config'->'formId')='null'
      OR EXISTS(SELECT 1 FROM hon.public_lead_forms f WHERE f.id=(d->'trigger'->'config'->>'formId')::uuid AND f.organization_id=p_org AND f.school_id=p_school))
    AND NOT EXISTS(SELECT 1 FROM (SELECT x->>'stageId' sid FROM jsonb_array_elements(d->'steps') x WHERE x->>'type'='MOVE_STAGE'
        UNION ALL SELECT c->>'stageId' FROM jsonb_array_elements(d->'entry'->'conditions') c WHERE c->>'kind'='LEAD_STAGE_IS'
        UNION ALL SELECT x->'condition'->>'stageId' FROM jsonb_array_elements(d->'steps') x WHERE x->>'type'='IF' AND x->'condition'->>'kind'='LEAD_STAGE_IS') r
      WHERE NOT EXISTS(SELECT 1 FROM hon.crm_pipeline_stages st WHERE st.id=r.sid::uuid AND st.organization_id=p_org AND st.school_id=p_school))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'steps') x WHERE x->>'type'='START_WORKFLOW'
      AND ((x->>'workflowId')::uuid=p_workflow OR NOT EXISTS(SELECT 1 FROM hon.automation_workflows w WHERE w.id=(x->>'workflowId')::uuid
        AND w.organization_id=p_org AND w.school_id=p_school AND w.status<>'ARCHIVED')))
$$;

-- The person who turned the workflow on still may: active human staff with automation.workflow.activate live at the
-- school, active organization and school, active COMPLETE entitlement.
CREATE FUNCTION hon.automation_activator_ok(p_principal uuid,p_org uuid,p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
    WHERE p.id=p_principal AND p.principal_type='HUMAN_USER' AND p.is_active
      AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=p_org AND o.status='ACTIVE')
      AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=p_school AND s.organization_id=p_org AND s.status='ACTIVE')
      AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
      AND hon.staff_member_eligible(p.id,p_org,p_school)
      AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
        JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
        WHERE g.principal_id=p.id AND g.organization_id=p_org AND g.school_id=p_school AND g.revoked_at IS NULL
          AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
          AND (r.management_school_id IS NULL OR r.management_school_id=p_school)
          AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
          AND x.code='automation.workflow.activate' AND x.is_staff_assignable)
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=p_org AND e.status='ACTIVE'
        AND e.tier='COMPLETE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Conditions and exits about one contact
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.automation_trial_booked(p_org uuid,p_school uuid,p_person uuid,p_since timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.crm_appointments a JOIN hon.crm_leads l ON l.id=a.crm_lead_id AND l.organization_id=a.organization_id AND l.school_id=a.school_id
    WHERE a.organization_id=p_org AND a.school_id=p_school AND l.primary_person_id=p_person AND a.appointment_type='TRIAL'
      AND a.status IN ('SCHEDULED','COMPLETED') AND a.created_at>=p_since)
$$;
CREATE FUNCTION hon.automation_enrolled(p_org uuid,p_school uuid,p_person uuid,p_since timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=p_org AND m.school_id=p_school AND m.participant_person_id=p_person
    AND m.state='ACTIVE' AND m.created_at>=p_since)
$$;
CREATE FUNCTION hon.automation_condition_holds(p_org uuid,p_school uuid,p_person uuid,p_since timestamptz,c jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE r boolean;
BEGIN
  r:=CASE c->>'kind'
    WHEN 'LEAD_IS_OPEN' THEN EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.organization_id=p_org AND l.school_id=p_school AND l.primary_person_id=p_person AND l.status='OPEN')
    WHEN 'IS_ACTIVE_STUDENT' THEN EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=p_org AND m.school_id=p_school AND m.participant_person_id=p_person AND m.state='ACTIVE')
    WHEN 'TRIAL_BOOKED' THEN hon.automation_trial_booked(p_org,p_school,p_person,p_since)
    WHEN 'LEAD_STAGE_IS' THEN EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.organization_id=p_org AND l.school_id=p_school AND l.primary_person_id=p_person
      AND l.status='OPEN' AND l.pipeline_stage_id=(c->>'stageId')::uuid)
    WHEN 'HAS_CONSENT' THEN EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=p_org AND k.school_id=p_school AND k.person_id=p_person
      AND k.channel::text=c->>'channel' AND k.status='OPTED_IN')
    WHEN 'MEMBERSHIP_ENDS_WITHIN' THEN EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=p_org AND m.school_id=p_school AND m.participant_person_id=p_person
      AND m.state='ACTIVE' AND m.term_ends_at>=clock_timestamp() AND m.term_ends_at<clock_timestamp()+make_interval(days=>(c->>'days')::integer))
    WHEN 'HAS_TAG' THEN EXISTS(SELECT 1 FROM hon.contact_tags t WHERE t.organization_id=p_org AND t.school_id=p_school AND t.person_id=p_person AND t.tag_key=lower(c->>'tag'))
    WHEN 'ATTENDED_AT_LEAST' THEN (SELECT count(*) FROM hon.attendance_records a JOIN hon.student_profiles sp ON sp.id=a.student_profile_id
        AND sp.organization_id=a.organization_id AND sp.school_id=a.school_id
      WHERE a.organization_id=p_org AND a.school_id=p_school AND sp.person_id=p_person AND a.status IN ('PRESENT','LATE','MAKEUP')
        AND a.recorded_at>=clock_timestamp()-make_interval(days=>(c->>'days')::integer))>=(c->>'count')::integer
    ELSE NULL END;
  IF r IS NULL THEN RAISE EXCEPTION 'AUTOMATION_CONDITION_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  RETURN r<>(c->>'negate')::boolean;
END $$;
-- The first exit rule the contact now meets, or NULL.
CREATE FUNCTION hon.automation_exit_reached(p_org uuid,p_school uuid,p_person uuid,p_since timestamptz,p_exits jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT x FROM jsonb_array_elements_text(p_exits) WITH ORDINALITY e(x,n) WHERE CASE x
    WHEN 'TRIAL_BOOKED' THEN hon.automation_trial_booked(p_org,p_school,p_person,p_since)
    WHEN 'ENROLLED' THEN hon.automation_enrolled(p_org,p_school,p_person,p_since)
    WHEN 'LEAD_CLOSED' THEN EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.organization_id=p_org AND l.school_id=p_school AND l.primary_person_id=p_person)
      AND NOT EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.organization_id=p_org AND l.school_id=p_school AND l.primary_person_id=p_person AND l.status='OPEN')
    WHEN 'OPTED_OUT' THEN EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=p_org AND k.school_id=p_school AND k.person_id=p_person
      AND k.status='OPTED_OUT' AND k.updated_at>=p_since)
    ELSE false END ORDER BY n LIMIT 1
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Starting runs
-- ---------------------------------------------------------------------------------------------------------------------
-- Starts one run when the entry rules, reentry rule and daily run cap allow it; returns the run id or NULL.
CREATE FUNCTION hon.automation_start_run(w hon.automation_workflows,p_person uuid,p_trigger_key text,p_event uuid,p_parent uuid,p_depth integer,p_since timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE d jsonb; c jsonb; run_id uuid; first_step jsonb;
BEGIN
  IF w.status<>'ACTIVE' THEN RETURN NULL; END IF;
  SELECT v.definition INTO d FROM hon.automation_workflow_versions v WHERE v.workflow_id=w.id AND v.version=w.active_version;
  IF NOT EXISTS(SELECT 1 FROM hon.people p WHERE p.id=p_person AND p.organization_id=w.organization_id AND p.school_id=w.school_id) THEN RETURN NULL; END IF;
  -- One open run per contact; the reentry rule; at most 500 runs per workflow per day.
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-run:'||w.id::text||':'||p_person::text,0));
  IF EXISTS(SELECT 1 FROM hon.automation_runs r WHERE r.workflow_id=w.id AND r.person_id=p_person AND (r.status='RUNNING' OR r.trigger_key=p_trigger_key)) THEN RETURN NULL; END IF;
  IF d->'entry'->>'reentry'='ONCE_EVER' AND EXISTS(SELECT 1 FROM hon.automation_runs r WHERE r.workflow_id=w.id AND r.person_id=p_person) THEN RETURN NULL; END IF;
  IF d->'entry'->>'reentry'='ONCE_PER_PERIOD' AND EXISTS(SELECT 1 FROM hon.automation_runs r WHERE r.workflow_id=w.id AND r.person_id=p_person
      AND r.started_at>clock_timestamp()-make_interval(days=>(d->'entry'->>'reentryDays')::integer)) THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM hon.automation_runs r WHERE r.workflow_id=w.id AND r.started_at>clock_timestamp()-interval '1 day')>=500 THEN RETURN NULL; END IF;
  FOR c IN SELECT x FROM jsonb_array_elements(d->'entry'->'conditions') x LOOP
    IF NOT hon.automation_condition_holds(w.organization_id,w.school_id,p_person,p_since,c) THEN RETURN NULL; END IF;
  END LOOP;
  INSERT INTO hon.automation_runs(organization_id,school_id,workflow_id,workflow_version,person_id,trigger_key,trigger_event_id,parent_run_id,depth)
    VALUES(w.organization_id,w.school_id,w.id,w.active_version,p_person,p_trigger_key,p_event,p_parent,p_depth) RETURNING id INTO run_id;
  first_step:=d->'steps'->0;
  INSERT INTO hon.automation_run_steps(organization_id,school_id,run_id,step_id,step_type,due_at)
    VALUES(w.organization_id,w.school_id,run_id,first_step->>'id',first_step->>'type',clock_timestamp());
  RETURN run_id;
END $$;

-- The contact an event is about, the trigger kinds it can start and the key that keeps one run per subject.
CREATE FUNCTION hon.automation_event_subject(e hon.outbox_events,OUT person_id uuid,OUT kinds text[],OUT trigger_key text,OUT form_id uuid,OUT tag_key text,OUT caused_by_workflow uuid)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE a hon.crm_appointments%ROWTYPE; st text;
BEGIN
  CASE e.event_type
    WHEN 'crm.lead.created','marketing.form.lead_received','marketing.zernio.lead_received' THEN
      SELECT l.primary_person_id INTO person_id FROM hon.crm_leads l WHERE l.id=e.aggregate_id AND l.organization_id=e.organization_id AND l.school_id=e.school_id;
      kinds:=CASE e.event_type WHEN 'crm.lead.created' THEN ARRAY['LEAD_CREATED'] WHEN 'marketing.form.lead_received' THEN ARRAY['LEAD_CREATED','FORM_LEAD_RECEIVED']
        ELSE ARRAY['LEAD_CREATED','META_LEAD_RECEIVED'] END;
      trigger_key:='lead:'||e.aggregate_id::text;
      IF e.event_type='marketing.form.lead_received' AND e.payload->>'formId' ~ '^[0-9a-f-]{36}$' THEN form_id:=(e.payload->>'formId')::uuid; END IF;
    WHEN 'crm.trial.scheduled','crm.trial.outcome.recorded' THEN
      SELECT * INTO a FROM hon.crm_appointments x WHERE x.id=e.aggregate_id AND x.organization_id=e.organization_id AND x.school_id=e.school_id;
      IF a.id IS NULL OR a.appointment_type<>'TRIAL' THEN RETURN; END IF;
      SELECT l.primary_person_id INTO person_id FROM hon.crm_leads l WHERE l.id=a.crm_lead_id AND l.organization_id=a.organization_id AND l.school_id=a.school_id;
      st:=CASE WHEN e.event_type='crm.trial.scheduled' THEN 'SCHEDULED' ELSE e.payload->>'status' END;
      kinds:=CASE st WHEN 'SCHEDULED' THEN ARRAY['TRIAL_BOOKED'] WHEN 'CANCELLED' THEN ARRAY['TRIAL_CANCELLED'] WHEN 'COMPLETED' THEN ARRAY['TRIAL_ATTENDED']
        WHEN 'NO_SHOW' THEN ARRAY['TRIAL_NO_SHOW'] ELSE NULL END;
      IF kinds IS NULL THEN person_id:=NULL; RETURN; END IF;
      trigger_key:='appt:'||a.id::text||':'||st;
    WHEN 'class.booking.created' THEN
      SELECT sp.person_id INTO person_id FROM hon.class_bookings b JOIN hon.student_profiles sp ON sp.id=b.student_profile_id
        AND sp.organization_id=b.organization_id AND sp.school_id=b.school_id
        WHERE b.id=e.aggregate_id AND b.organization_id=e.organization_id AND b.school_id=e.school_id;
      kinds:=ARRAY['CLASS_BOOKING_CREATED']; trigger_key:='book:'||e.aggregate_id::text;
    WHEN 'billing.membership.activated','billing.membership.cancelled' THEN
      SELECT m.participant_person_id INTO person_id FROM hon.memberships m WHERE m.id=e.aggregate_id AND m.organization_id=e.organization_id AND m.school_id=e.school_id;
      kinds:=CASE e.event_type WHEN 'billing.membership.activated' THEN ARRAY['MEMBERSHIP_ACTIVATED'] ELSE ARRAY['MEMBERSHIP_CANCELLED'] END;
      trigger_key:=CASE e.event_type WHEN 'billing.membership.activated' THEN 'mact:' ELSE 'mcan:' END||e.aggregate_id::text;
    WHEN 'testing.registration.interest.submitted' THEN
      SELECT sp.person_id INTO person_id FROM hon.testing_registration_interests i JOIN hon.student_profiles sp ON sp.id=i.student_profile_id
        AND sp.organization_id=i.organization_id AND sp.school_id=i.school_id
        WHERE i.id=e.aggregate_id AND i.organization_id=e.organization_id AND i.school_id=e.school_id;
      kinds:=ARRAY['TESTING_REGISTRATION_SUBMITTED']; trigger_key:='test:'||e.aggregate_id::text;
    WHEN 'contact.tag.added' THEN
      SELECT p.id INTO person_id FROM hon.people p WHERE p.id=e.aggregate_id AND p.organization_id=e.organization_id AND p.school_id=e.school_id;
      kinds:=ARRAY['TAG_ADDED']; trigger_key:='tag:'||e.id::text; tag_key:=e.payload->>'tagKey';
      IF e.payload->>'automationRunId' ~ '^[0-9a-f-]{36}$' THEN
        SELECT r.workflow_id INTO caused_by_workflow FROM hon.automation_runs r WHERE r.id=(e.payload->>'automationRunId')::uuid;
      END IF;
    ELSE NULL;
  END CASE;
END $$;

-- Engine: consume up to p_limit qualifying outbox events from the last 7 days that occurred after a workflow of the
-- school was turned on; start the runs they qualify for. Returns counts only.
CREATE FUNCTION hon.consume_automation_events(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE e hon.outbox_events%ROWTYPE; s record; w hon.automation_workflows%ROWTYPE; started integer; consumed integer:=0; total integer:=0; d jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'AUTOMATION_INVALID' USING ERRCODE='22023'; END IF;
  FOR e IN SELECT x.* FROM hon.outbox_events x
    WHERE x.event_type IN ('crm.lead.created','marketing.form.lead_received','marketing.zernio.lead_received','crm.trial.scheduled','crm.trial.outcome.recorded',
        'class.booking.created','billing.membership.activated','billing.membership.cancelled','testing.registration.interest.submitted','contact.tag.added')
      AND x.occurred_at>=clock_timestamp()-interval '7 days'
      AND EXISTS(SELECT 1 FROM hon.automation_workflows aw WHERE aw.organization_id=x.organization_id AND aw.school_id=x.school_id AND aw.status='ACTIVE' AND aw.activated_at<=x.occurred_at)
      AND NOT EXISTS(SELECT 1 FROM hon.automation_event_receipts r WHERE r.outbox_event_id=x.id)
    ORDER BY x.occurred_at,x.id LIMIT p_limit LOOP
    -- One consumer per event: lock it, re-check the receipt, start the runs, then write the receipt once.
    PERFORM pg_advisory_xact_lock(hashtextextended('hon.automation_event:'||e.id::text,0));
    CONTINUE WHEN EXISTS(SELECT 1 FROM hon.automation_event_receipts r WHERE r.outbox_event_id=e.id);
    consumed:=consumed+1; started:=0;
    s:=hon.automation_event_subject(e);
    IF s.person_id IS NOT NULL THEN
      FOR w IN SELECT * FROM hon.automation_workflows aw WHERE aw.organization_id=e.organization_id AND aw.school_id=e.school_id AND aw.status='ACTIVE'
          AND aw.activated_at<=e.occurred_at AND aw.trigger_kind=ANY(s.kinds) ORDER BY aw.activated_at,aw.id LIMIT 100 LOOP
        -- No run starts for a workflow whose activator no longer may run it; it is paused instead.
        IF NOT hon.automation_activator_ok(w.activated_by_principal_id,w.organization_id,w.school_id) THEN
          PERFORM hon.automation_engine_pause(w.id,'AUTHORITY_LOST'); CONTINUE; END IF;
        SELECT v.definition INTO d FROM hon.automation_workflow_versions v WHERE v.workflow_id=w.id AND v.version=w.active_version;
        CONTINUE WHEN w.trigger_kind='FORM_LEAD_RECEIVED' AND jsonb_typeof(d->'trigger'->'config'->'formId')<>'null'
          AND (d->'trigger'->'config'->>'formId')::uuid IS DISTINCT FROM s.form_id;
        CONTINUE WHEN w.trigger_kind='TAG_ADDED' AND (lower(d->'trigger'->'config'->>'tag') IS DISTINCT FROM s.tag_key OR s.caused_by_workflow=w.id);
        IF hon.automation_start_run(w,s.person_id,s.trigger_key,e.id,NULL,0,e.occurred_at) IS NOT NULL THEN started:=started+1; END IF;
      END LOOP;
    END IF;
    INSERT INTO hon.automation_event_receipts(outbox_event_id,organization_id,school_id,event_type,runs_started)
      VALUES(e.id,e.organization_id,e.school_id,e.event_type,least(started,100));
    total:=total+started;
  END LOOP;
  RETURN jsonb_build_object('consumed',consumed,'runsStarted',total);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Running steps
-- ---------------------------------------------------------------------------------------------------------------------
-- Merge fields this engine fills: first_name and school_name.
CREATE FUNCTION hon.automation_render(p_text text,p_first text,p_school text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT replace(replace(p_text,'{{first_name}}',coalesce(nullif(btrim(p_first),''),'there')),'{{school_name}}',p_school)
$$;
-- The next school-local HH:MM after now.
CREATE FUNCTION hon.automation_next_local_time(p_zone text,p_hhmm text) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN c>clock_timestamp() THEN c ELSE ((((clock_timestamp() AT TIME ZONE p_zone)::date+1)+p_hhmm::time) AT TIME ZONE p_zone) END
  FROM (SELECT ((((clock_timestamp() AT TIME ZONE p_zone)::date)+p_hhmm::time) AT TIME ZONE p_zone) c) x
$$;

-- Ends a run and returns nothing.
CREATE FUNCTION hon.automation_end_run(p_run uuid,p_status text,p_code text) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  UPDATE hon.automation_runs SET status=p_status,end_code=p_code,ended_at=clock_timestamp(),version=version+1 WHERE id=p_run AND status='RUNNING';
$$;
-- Pauses a workflow the engine can no longer run safely.
CREATE FUNCTION hon.automation_engine_pause(p_workflow uuid,p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE w hon.automation_workflows%ROWTYPE;
BEGIN
  UPDATE hon.automation_workflows SET status='PAUSED',paused_reason=p_reason,revision=revision+1,updated_at=clock_timestamp()
    WHERE id=p_workflow AND status='ACTIVE' RETURNING * INTO w;
  IF w.id IS NOT NULL THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
      VALUES(w.organization_id,w.school_id,'00000000-0000-4000-8000-000000000368','AUTOMATION','automation.workflow.paused','AUTOMATION_WORKFLOW',w.id,
        jsonb_build_object('reason',p_reason,'version',w.active_version),'SUCCEEDED',gen_random_uuid(),gen_random_uuid());
  END IF;
END $$;

-- Executes one due step (locked by the caller) and moves the run on. Returns the step's resulting status.
CREATE FUNCTION hon.automation_execute_step(st hon.automation_run_steps,r hon.automation_runs,w hon.automation_workflows,d jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE s jsonb; person hon.people%ROWTYPE; school hon.schools%ROWTYPE; chan text; content jsonb; body text; subject text; msg uuid; item uuid;
  outcome text; res text:='DONE'; br text; nxt text; due timestamptz:=clock_timestamp(); waited boolean; child uuid; tw hon.automation_workflows%ROWTYPE;
  automation constant uuid:='00000000-0000-4000-8000-000000000368';
BEGIN
  SELECT x INTO s FROM jsonb_array_elements(d->'steps') x WHERE x->>'id'=st.step_id;
  SELECT * INTO person FROM hon.people WHERE id=r.person_id AND organization_id=r.organization_id AND school_id=r.school_id;
  SELECT * INTO school FROM hon.schools WHERE id=r.school_id AND organization_id=r.organization_id;
  CASE s->>'type'
    WHEN 'SEND_SMS','SEND_EMAIL' THEN
      chan:=CASE s->>'type' WHEN 'SEND_SMS' THEN 'SMS' ELSE 'EMAIL' END; content:=s->'content';
      body:=hon.automation_render(CASE content->>'mode' WHEN 'FIXED' THEN content->>'text' ELSE content->>'fallbackText' END,person.given_name,school.name);
      IF chan='EMAIL' THEN subject:=left(hon.automation_render(CASE content->>'mode' WHEN 'FIXED' THEN content->>'subject' ELSE content->>'fallbackSubject' END,person.given_name,school.name),150); END IF;
      outcome:=CASE
        WHEN NOT EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=r.organization_id AND k.school_id=r.school_id AND k.person_id=r.person_id
          AND k.channel::text=chan AND k.status='OPTED_IN') THEN 'NO_CONSENT'
        WHEN (chan='SMS' AND person.phone_e164 IS NULL) OR (chan='EMAIL' AND person.email IS NULL) THEN 'NO_ADDRESS'
        WHEN (SELECT count(*) FROM hon.communication_messages m WHERE m.organization_id=r.organization_id AND m.school_id=r.school_id AND m.recipient_person_id=r.person_id
          AND m.origin_kind='AUTOMATION' AND m.created_at>clock_timestamp()-interval '1 day')>=3 THEN 'DAILY_CAP'
        WHEN char_length(body)>4000 THEN 'TEXT_TOO_LONG' ELSE NULL END;
      IF outcome IS NOT NULL THEN res:='SKIPPED';
      ELSE
        INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,created_by_principal_id,queued_by_principal_id,
            origin_kind,origin_id,email_subject)
          VALUES(r.organization_id,r.school_id,r.person_id,chan::hon.communication_message_channel,body,'QUEUED',automation,automation,'AUTOMATION',st.id,nullif(btrim(subject),''))
          RETURNING id INTO msg;
        outcome:=CASE content->>'mode' WHEN 'FIXED' THEN 'QUEUED' ELSE 'QUEUED_FALLBACK_WORDING' END;
      END IF;
      nxt:=s->>'next';
    WHEN 'CREATE_TASK','NOTIFY_STAFF' THEN
      INSERT INTO hon.work_items(organization_id,school_id,work_origin,work_type,status,title,description,priority,due_at,assigned_principal_id,created_by_principal_id,correlation_id)
        VALUES(r.organization_id,r.school_id,'HUMAN_UI','HUMAN_TASK','READY',
          left(CASE s->>'type' WHEN 'CREATE_TASK' THEN hon.automation_render(s->>'title',person.given_name,school.name) ELSE 'Automation: '||w.name END,120),
          left(hon.automation_render(CASE s->>'type' WHEN 'CREATE_TASK' THEN s->>'details' ELSE s->>'text' END,person.given_name,school.name)
            ||E'\n\nContact: '||btrim(person.given_name||' '||person.family_name),2000),
          CASE s->>'type' WHEN 'CREATE_TASK' THEN 'NORMAL' ELSE 'HIGH' END,
          CASE s->>'type' WHEN 'CREATE_TASK' THEN clock_timestamp()+make_interval(hours=>(s->>'dueInHours')::integer) END,
          NULL,automation,r.id) RETURNING id INTO item;
      INSERT INTO hon.human_work_history(work_item_id,organization_id,school_id,version,operation,status,title,description,priority,due_at,assignee_id,actor_id,request_id)
        SELECT wi.id,wi.organization_id,wi.school_id,1,'CREATE',wi.status,wi.title,wi.description,wi.priority,wi.due_at,NULL,automation,st.id FROM hon.work_items wi WHERE wi.id=item;
      outcome:=CASE s->>'type' WHEN 'CREATE_TASK' THEN 'TASK_CREATED' ELSE 'STAFF_NOTIFIED' END; nxt:=s->>'next';
    WHEN 'ADD_TAG','REMOVE_TAG' THEN
      BEGIN
        outcome:=CASE WHEN hon.contact_tag_apply(r.organization_id,r.school_id,r.person_id,s->>'tag',s->>'type'='ADD_TAG',automation,'AUTOMATION',r.id,st.id)
          THEN CASE s->>'type' WHEN 'ADD_TAG' THEN 'TAG_ADDED' ELSE 'TAG_REMOVED' END ELSE 'NO_CHANGE' END;
      EXCEPTION WHEN SQLSTATE '54000' THEN outcome:='TAG_LIMIT_REACHED'; res:='SKIPPED';
      END;
      nxt:=s->>'next';
    WHEN 'MOVE_STAGE' THEN
      IF NOT EXISTS(SELECT 1 FROM hon.crm_pipeline_stages x WHERE x.id=(s->>'stageId')::uuid AND x.organization_id=r.organization_id AND x.school_id=r.school_id) THEN
        outcome:='STAGE_NOT_IN_SCHOOL'; res:='SKIPPED';
      ELSE
        UPDATE hon.crm_leads l SET pipeline_stage_id=(s->>'stageId')::uuid,version=l.version+1,updated_at=clock_timestamp()
          WHERE l.organization_id=r.organization_id AND l.school_id=r.school_id AND l.primary_person_id=r.person_id AND l.status='OPEN'
            AND l.pipeline_stage_id<>(s->>'stageId')::uuid
            AND EXISTS(SELECT 1 FROM hon.crm_pipeline_stages x WHERE x.id=(s->>'stageId')::uuid AND x.pipeline_id=l.pipeline_id AND x.terminal_status IS NULL);
        outcome:=CASE WHEN FOUND THEN 'STAGE_MOVED' ELSE 'NO_OPEN_LEAD_IN_PIPELINE' END;
        IF NOT FOUND THEN res:='SKIPPED'; END IF;
      END IF;
      nxt:=s->>'next';
    WHEN 'START_WORKFLOW' THEN
      SELECT * INTO tw FROM hon.automation_workflows x WHERE x.id=(s->>'workflowId')::uuid AND x.organization_id=r.organization_id AND x.school_id=r.school_id;
      IF tw.id IS NULL OR tw.id=w.id THEN outcome:='WORKFLOW_NOT_IN_SCHOOL'; res:='SKIPPED';
      ELSIF r.depth>=3 OR EXISTS(WITH RECURSIVE chain AS (SELECT r.id,r.parent_run_id,r.workflow_id UNION ALL
          SELECT p.id,p.parent_run_id,p.workflow_id FROM hon.automation_runs p JOIN chain ON p.id=chain.parent_run_id) SELECT 1 FROM chain WHERE chain.workflow_id=tw.id) THEN
        outcome:='CHAIN_LIMIT'; res:='SKIPPED';
      ELSIF tw.status<>'ACTIVE' THEN outcome:='WORKFLOW_NOT_ON'; res:='SKIPPED';
      ELSE
        child:=hon.automation_start_run(tw,r.person_id,'run:'||r.id::text,NULL,r.id,r.depth+1,clock_timestamp());
        outcome:=CASE WHEN child IS NULL THEN 'NOT_STARTED' ELSE 'WORKFLOW_STARTED' END;
        IF child IS NULL THEN res:='SKIPPED'; END IF;
      END IF;
      nxt:=s->>'next';
    WHEN 'WAIT' THEN
      IF st.status='PENDING' THEN
        due:=CASE WHEN jsonb_typeof(s->'minutes')='number' THEN clock_timestamp()+make_interval(mins=>(s->>'minutes')::integer)
          ELSE hon.automation_next_local_time(school.timezone,s->>'localTime') END;
        UPDATE hon.automation_run_steps SET status='WAITING',due_at=due,wait_until=due WHERE id=st.id;
        RETURN 'WAITING';
      END IF;
      outcome:='WAITED'; nxt:=s->>'next';
    WHEN 'WAIT_FOR' THEN
      waited:=CASE s->>'event' WHEN 'TRIAL_BOOKED' THEN hon.automation_trial_booked(r.organization_id,r.school_id,r.person_id,r.started_at)
        ELSE hon.automation_enrolled(r.organization_id,r.school_id,r.person_id,r.started_at) END;
      IF NOT waited AND (st.status='PENDING' OR st.wait_until>clock_timestamp()) THEN
        due:=coalesce(st.wait_until,clock_timestamp()+make_interval(mins=>(s->>'timeoutMinutes')::integer));
        UPDATE hon.automation_run_steps SET status='WAITING',wait_until=due,due_at=least(due,clock_timestamp()+interval '5 minutes') WHERE id=st.id;
        RETURN 'WAITING';
      END IF;
      br:=CASE WHEN waited THEN 'YES' ELSE 'NO' END; outcome:=CASE WHEN waited THEN 'EVENT_HAPPENED' ELSE 'TIMED_OUT' END;
      nxt:=CASE br WHEN 'YES' THEN s->>'yes' ELSE s->>'no' END;
    WHEN 'IF' THEN
      br:=CASE WHEN hon.automation_condition_holds(r.organization_id,r.school_id,r.person_id,r.started_at,s->'condition') THEN 'YES' ELSE 'NO' END;
      outcome:='CONDITION_'||br; nxt:=CASE br WHEN 'YES' THEN s->>'yes' ELSE s->>'no' END;
    WHEN 'STOP' THEN outcome:='STOPPED';
    ELSE RAISE EXCEPTION 'AUTOMATION_STEP_UNAVAILABLE' USING ERRCODE='22023';
  END CASE;
  UPDATE hon.automation_run_steps SET status=res,outcome_code=outcome,branch=br,message_id=msg,work_item_id=item,
    started_run_id=child,finished_at=clock_timestamp(),wait_until=NULL WHERE id=st.id;
  IF s->>'type'='STOP' THEN PERFORM hon.automation_end_run(r.id,'STOPPED','STOP_STEP');
  ELSIF nxt IS NULL THEN PERFORM hon.automation_end_run(r.id,'COMPLETED',NULL);
  ELSE
    INSERT INTO hon.automation_run_steps(organization_id,school_id,run_id,step_id,step_type,due_at)
      SELECT r.organization_id,r.school_id,r.id,x->>'id',x->>'type',clock_timestamp() FROM jsonb_array_elements(d->'steps') x WHERE x->>'id'=nxt;
  END IF;
  RETURN res;
END $$;

-- Engine: run up to p_limit due steps. Before each: the workflow must be on (a paused workflow's steps wait), authority
-- is re-proved, and exit rules are checked. Each step runs in its own subtransaction; an error fails only that run.
CREATE FUNCTION hon.run_due_automation_steps(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE st hon.automation_run_steps%ROWTYPE; r hon.automation_runs%ROWTYPE; w hon.automation_workflows%ROWTYPE; d jsonb; ex text; res text;
  ran integer:=0; failed integer:=0; exited integer:=0; paused integer:=0; i integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'AUTOMATION_INVALID' USING ERRCODE='22023'; END IF;
  WHILE i<p_limit LOOP
    SELECT x.* INTO st FROM hon.automation_run_steps x JOIN hon.automation_runs rr ON rr.id=x.run_id
      JOIN hon.automation_workflows ww ON ww.id=rr.workflow_id
      WHERE x.status IN ('PENDING','WAITING') AND x.due_at<=clock_timestamp() AND rr.status='RUNNING' AND ww.status='ACTIVE'
      ORDER BY x.due_at,x.id LIMIT 1 FOR UPDATE OF x SKIP LOCKED;
    EXIT WHEN st.id IS NULL;
    i:=i+1;
    SELECT * INTO w FROM hon.automation_workflows x WHERE x.id=(SELECT workflow_id FROM hon.automation_runs WHERE id=st.run_id) FOR UPDATE;
    SELECT * INTO r FROM hon.automation_runs x WHERE x.id=st.run_id FOR UPDATE;
    IF w.status<>'ACTIVE' OR r.status<>'RUNNING' THEN st:=NULL; CONTINUE; END IF;
    IF NOT hon.automation_activator_ok(w.activated_by_principal_id,w.organization_id,w.school_id) THEN
      PERFORM hon.automation_engine_pause(w.id,'AUTHORITY_LOST'); paused:=paused+1; st:=NULL; CONTINUE;
    END IF;
    SELECT v.definition INTO d FROM hon.automation_workflow_versions v WHERE v.workflow_id=r.workflow_id AND v.version=r.workflow_version;
    ex:=hon.automation_exit_reached(r.organization_id,r.school_id,r.person_id,r.started_at,d->'exitWhen');
    IF ex IS NOT NULL THEN
      UPDATE hon.automation_run_steps SET status='SKIPPED',outcome_code='RUN_EXITED',finished_at=clock_timestamp(),wait_until=NULL WHERE id=st.id;
      PERFORM hon.automation_end_run(r.id,'EXITED','EXIT_'||ex); exited:=exited+1; st:=NULL; CONTINUE;
    END IF;
    BEGIN
      res:=hon.automation_execute_step(st,r,w,d);
      ran:=ran+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE hon.automation_run_steps SET status='FAILED',outcome_code='STEP_ERROR',finished_at=clock_timestamp(),wait_until=NULL WHERE id=st.id;
      PERFORM hon.automation_end_run(r.id,'FAILED','STEP_FAILED'); failed:=failed+1;
      IF (SELECT count(*) FILTER (WHERE status='FAILED')*5>=count(*) AND count(*)>=10 FROM (SELECT x.status FROM hon.automation_run_steps x JOIN hon.automation_runs rr ON rr.id=x.run_id
          WHERE rr.workflow_id=w.id AND x.finished_at IS NOT NULL ORDER BY x.finished_at DESC LIMIT 50) last50) THEN
        PERFORM hon.automation_engine_pause(w.id,'FAILURE_RATE'); paused:=paused+1;
      END IF;
    END;
    st:=NULL;
  END LOOP;
  RETURN jsonb_build_object('ran',ran,'failed',failed,'exited',exited,'paused',paused);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Staff commands: turn on, pause; archive a draft or paused workflow
-- ---------------------------------------------------------------------------------------------------------------------
-- ACTIVATE {expectedRevision, version}: turn a DRAFT or PAUSED workflow on at one of its versions.
CREATE FUNCTION hon.activate_automation_workflow(p_subject text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb;
  w hon.automation_workflows%ROWTYPE; d jsonb; missing text; result jsonb; at timestamptz:=clock_timestamp();
BEGIN
  IF p_id IS NULL OR NOT hon.automation_keys(p_input,ARRAY['expectedRevision','version']) OR NOT hon.automation_int(p_input->'version',1,500) THEN
    PERFORM hon.automation_invalid('input'); END IF;
  PERFORM hon.automation_check_call(p_key,p_request,p_correlation);
  actor:=hon.require_automation_workflow_actor(p_subject,'automation.workflow.activate');
  replay:=hon.automation_claim(org,school,actor,p_key,'WF_ACTIVATE',hon.automation_fp('activate:'||p_id::text,p_input::text));
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  w:=hon.automation_lock_workflow(org,school,p_id,p_input->'expectedRevision');
  SELECT v.definition INTO d FROM hon.automation_workflow_versions v WHERE v.workflow_id=w.id AND v.version=(p_input->>'version')::integer;
  IF d IS NULL THEN RAISE EXCEPTION 'AUTOMATION_VERSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.validate_automation_definition(d);
  missing:=hon.automation_unavailable(d);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'AUTOMATION_NOT_AVAILABLE_YET' USING ERRCODE='0A000', DETAIL=missing; END IF;
  IF NOT hon.automation_references_ok(org,school,w.id,d) THEN RAISE EXCEPTION 'AUTOMATION_REFERENCE_INVALID' USING ERRCODE='23503'; END IF;
  UPDATE hon.automation_workflows SET status='ACTIVE',active_version=(p_input->>'version')::integer,activated_by_principal_id=actor,activated_at=at,
    paused_reason=NULL,revision=w.revision+1,updated_at=at WHERE id=w.id RETURNING * INTO w;
  result:=hon.automation_detail_json(w);
  PERFORM hon.automation_evidence(org,school,actor,'automation.workflow.activated','AUTOMATION_WORKFLOW',w.id,w.revision,
    jsonb_build_object('version',w.active_version,'triggerKind',w.trigger_kind),p_request,p_correlation);
  PERFORM hon.automation_finish(org,school,actor,p_key,result);
  IF hon.require_automation_workflow_actor(p_subject,'automation.workflow.activate') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- PAUSE {expectedRevision}: no new runs start and no step runs until someone turns it on again.
CREATE FUNCTION hon.pause_automation_workflow(p_subject text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; w hon.automation_workflows%ROWTYPE; result jsonb;
BEGIN
  IF p_id IS NULL OR NOT hon.automation_keys(p_input,ARRAY['expectedRevision']) THEN PERFORM hon.automation_invalid('input'); END IF;
  PERFORM hon.automation_check_call(p_key,p_request,p_correlation);
  actor:=hon.require_automation_workflow_actor(p_subject,'automation.workflow.activate');
  replay:=hon.automation_claim(org,school,actor,p_key,'WF_PAUSE',hon.automation_fp('pause:'||p_id::text,p_input::text));
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  w:=hon.automation_lock_workflow(org,school,p_id,p_input->'expectedRevision');
  IF w.status<>'ACTIVE' THEN RAISE EXCEPTION 'AUTOMATION_NOT_ACTIVE' USING ERRCODE='23514'; END IF;
  UPDATE hon.automation_workflows SET status='PAUSED',paused_reason='STAFF_PAUSED',revision=w.revision+1,updated_at=clock_timestamp() WHERE id=w.id RETURNING * INTO w;
  result:=hon.automation_detail_json(w);
  PERFORM hon.automation_evidence(org,school,actor,'automation.workflow.paused','AUTOMATION_WORKFLOW',w.id,w.revision,
    jsonb_build_object('version',w.active_version,'reason','STAFF_PAUSED'),p_request,p_correlation);
  PERFORM hon.automation_finish(org,school,actor,p_key,result);
  IF hon.require_automation_workflow_actor(p_subject,'automation.workflow.activate') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- Archive now also accepts a PAUSED workflow: its open runs are cancelled and it never changes again.
CREATE OR REPLACE FUNCTION hon.archive_automation_workflow(p_subject text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb;
  w hon.automation_workflows%ROWTYPE; result jsonb; open_run uuid;
BEGIN
  IF p_id IS NULL OR NOT hon.automation_keys(p_input,ARRAY['expectedRevision']) THEN PERFORM hon.automation_invalid('input'); END IF;
  PERFORM hon.automation_check_call(p_key,p_request,p_correlation);
  actor:=hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage');
  replay:=hon.automation_claim(org,school,actor,p_key,'WF_ARCHIVE',hon.automation_fp('archive:'||p_id::text,p_input::text));
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  w:=hon.automation_lock_workflow(org,school,p_id,p_input->'expectedRevision');
  IF w.status NOT IN ('DRAFT','PAUSED') THEN RAISE EXCEPTION 'AUTOMATION_NOT_DRAFT' USING ERRCODE='23514'; END IF;
  FOR open_run IN SELECT id FROM hon.automation_runs WHERE workflow_id=w.id AND status='RUNNING' LOOP
    UPDATE hon.automation_run_steps SET status='SKIPPED',outcome_code='WORKFLOW_ARCHIVED',finished_at=clock_timestamp(),wait_until=NULL
      WHERE run_id=open_run AND status IN ('PENDING','WAITING');
    PERFORM hon.automation_end_run(open_run,'CANCELLED','WORKFLOW_ARCHIVED');
  END LOOP;
  UPDATE hon.automation_workflows SET status='ARCHIVED',active_version=NULL,activated_by_principal_id=NULL,activated_at=NULL,paused_reason=NULL,
    revision=w.revision+1,updated_at=clock_timestamp() WHERE id=w.id RETURNING * INTO w;
  result:=hon.automation_detail_json(w);
  PERFORM hon.automation_evidence(org,school,actor,'automation.workflow.archived','AUTOMATION_WORKFLOW',w.id,w.revision,jsonb_build_object('version',w.latest_version),p_request,p_correlation);
  PERFORM hon.automation_finish(org,school,actor,p_key,result);
  IF hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- History reads (automation.workflow.read). Contacts appear by first name only; message text is never returned.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.automation_run_json(r hon.automation_runs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('runId',r.id,'workflowId',r.workflow_id,'workflowVersion',r.workflow_version,'personId',r.person_id,
    'contactFirstName',(SELECT left(p.given_name,60) FROM hon.people p WHERE p.id=r.person_id),
    'status',r.status,'endCode',r.end_code,'depth',r.depth,'parentRunId',r.parent_run_id,
    'startedAt',hon.saas_ts(r.started_at),'endedAt',hon.saas_ts(r.ended_at))
$$;
CREATE FUNCTION hon.read_automation_runs(p_subject text,p_workflow uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  PERFORM hon.require_automation_workflow_actor(p_subject,'automation.workflow.read');
  IF p_workflow IS NULL OR NOT EXISTS(SELECT 1 FROM hon.automation_workflows WHERE id=p_workflow AND organization_id=org AND school_id=school) THEN
    RAISE EXCEPTION 'AUTOMATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('workflowId',p_workflow,
    'runs',coalesce((SELECT jsonb_agg(hon.automation_run_json(x) ORDER BY x.started_at DESC,x.id) FROM (SELECT * FROM hon.automation_runs
      WHERE organization_id=org AND school_id=school AND workflow_id=p_workflow ORDER BY started_at DESC,id LIMIT 100) x),'[]'::jsonb),
    'counts',(SELECT jsonb_build_object('running',count(*) FILTER (WHERE status='RUNNING'),'completed',count(*) FILTER (WHERE status IN ('COMPLETED','STOPPED')),
      'exited',count(*) FILTER (WHERE status='EXITED'),'failed',count(*) FILTER (WHERE status='FAILED')) FROM hon.automation_runs
      WHERE organization_id=org AND school_id=school AND workflow_id=p_workflow),
    'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;
CREATE FUNCTION hon.read_automation_run(p_subject text,p_run uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); r hon.automation_runs%ROWTYPE;
BEGIN
  PERFORM hon.require_automation_workflow_actor(p_subject,'automation.workflow.read');
  SELECT * INTO r FROM hon.automation_runs WHERE id=p_run AND organization_id=org AND school_id=school;
  IF r.id IS NULL THEN RAISE EXCEPTION 'AUTOMATION_RUN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('run',hon.automation_run_json(r),
    'steps',coalesce((SELECT jsonb_agg(jsonb_build_object('stepId',s.step_id,'type',s.step_type,'status',s.status,'outcome',s.outcome_code,'branch',s.branch,
        'messageId',s.message_id,'deliveryStatus',(SELECT dl.status::text FROM hon.communication_deliveries dl WHERE dl.message_id=s.message_id),
        'workItemId',s.work_item_id,'startedRunId',s.started_run_id,'dueAt',hon.saas_ts(s.due_at),'createdAt',hon.saas_ts(s.created_at),
        'finishedAt',hon.saas_ts(s.finished_at)) ORDER BY s.created_at,s.id) FROM hon.automation_run_steps s WHERE s.run_id=r.id),'[]'::jsonb),
    'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------------------------
DO $$ DECLARE t text; f regprocedure; r record; BEGIN
  FOREACH t IN ARRAY ARRAY['automation_event_receipts','automation_runs','automation_run_steps'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_automation_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r.rolname);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN (
    'guard_automation_run','automation_unavailable','automation_references_ok','automation_activator_ok','automation_trial_booked','automation_enrolled',
    'automation_condition_holds','automation_exit_reached','automation_start_run','automation_event_subject','consume_automation_events','automation_render',
    'automation_next_local_time','automation_end_run','automation_engine_pause','automation_execute_step','run_due_automation_steps',
    'activate_automation_workflow','pause_automation_workflow','archive_automation_workflow','automation_run_json','read_automation_runs','read_automation_run') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_automation_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r.rolname);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.activate_automation_workflow(text,uuid,jsonb,text,uuid,uuid),hon.pause_automation_workflow(text,uuid,jsonb,text,uuid,uuid),
      hon.archive_automation_workflow(text,uuid,jsonb,text,uuid,uuid),hon.read_automation_runs(text,uuid),hon.read_automation_run(text,uuid) TO hon_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_automation_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.consume_automation_events(integer),hon.run_due_automation_steps(integer) TO hon_automation_worker;
  END IF;
END $$;

COMMIT;
