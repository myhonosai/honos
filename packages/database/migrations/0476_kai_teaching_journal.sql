BEGIN;

-- Kai teaching journal KJ1 (0476, allocated 2026-11-18). Owner request (David, 2026-11-18): "kai should also be teaching
-- journal. instructor can speak to it regarding what they taught that day. and kai can recall it when instructor ask what did
-- we work on last week. at same time have few recommendation from the pattern". Verified on main d4a765c: nothing stores what
-- an instructor taught. Spec: docs/architecture/KAI_TEACHING_JOURNAL.md. Rules:
--   J1  teaching.journal.use (staff-assignable, not sensitive, OWNER by default): keep one's own teaching journal at the exact
--       school. Live COMPLETE access only (Kai is part of the Complete AI team). Direct human only (HUMAN_USER, HUMAN_UI, no
--       action request or delegation); family, student, HQ and platform roles are refused; the actor is proved again after
--       the locks and at the end.
--   J2  An instructor reads and changes only their own entries. Another person's entry is "not found".
--   J3  An entry is a school-local date (400 days back to today at the school), an optional class name (1-80), notes (1-2,000,
--       line breaks allowed), 0-10 topics (1-40 each, unique ignoring case) and TYPED or SPOKEN.
--   J4  Every change is the next version. A removed entry is final and its notes, class and topics are erased in the same
--       update. Entries are never deleted. Saves are idempotent; the replay record keeps only ids, version and status, never
--       journal text. The audit keeps no free text. Each save adds an inert outbox event.
--   J5  Nothing here runs AI, sends a message or charges anyone. The runtime gains no table privilege, only EXECUTE on two
--       entry points.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Kai journal requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL OR to_regprocedure('hon.membership_school_today()') IS NULL THEN
    RAISE EXCEPTION '0476 requires 0077, 0154 and 0224'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('teaching.journal.use','Keep their own Kai teaching journal: log what they taught, recall it and see pattern notes',false,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code='teaching.journal.use' AND NOT is_sensitive AND is_staff_assignable)<>1 THEN
    RAISE EXCEPTION 'teaching.journal.use already exists with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'teaching.journal.use' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' ON CONFLICT DO NOTHING;

-- Free text: trimmed, 1..max characters, no control (line breaks only when multiline), markup or invisible direction characters.
CREATE FUNCTION hon.kai_journal_text_ok(v text,max_len integer,multiline boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(length(v) BETWEEN 1 AND max_len AND btrim(v,E' \t\n\r')=v
    AND v !~ CASE WHEN multiline THEN '[\x01-\x09\x0b-\x1f\x7f-\x9f<>\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]'
                  ELSE '[\x01-\x1f\x7f-\x9f<>\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]' END,false)
$$;
-- Topics: at most 10, each a single line of 1..40 with no double spaces, unique ignoring case.
CREATE FUNCTION hon.kai_journal_topics_ok(t text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(t IS NOT NULL AND array_ndims(t) IS NOT DISTINCT FROM CASE WHEN cardinality(t)=0 THEN NULL ELSE 1 END
    AND cardinality(t)<=10
    AND NOT EXISTS (SELECT 1 FROM unnest(t) x WHERE x IS NULL OR NOT hon.kai_journal_text_ok(x,40,false) OR x ~ '\s{2}')
    AND (SELECT count(DISTINCT lower(regexp_replace(x,'\s+',' ','g'))) FROM unnest(t) x)=cardinality(t),false)
$$;

CREATE TABLE hon.kai_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  author_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  taught_on date NOT NULL,
  class_name text,
  notes text,
  topics text[] NOT NULL DEFAULT '{}',
  entry_source text NOT NULL CHECK (entry_source IN ('TYPED','SPOKEN')),
  status text NOT NULL CHECK (status IN ('ACTIVE','REMOVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id),
  CHECK (taught_on BETWEEN date '2000-01-01' AND date '2099-12-31'),
  CHECK (hon.kai_journal_topics_ok(topics)),
  CHECK ((status='ACTIVE' AND hon.kai_journal_text_ok(notes,2000,true) AND (class_name IS NULL OR hon.kai_journal_text_ok(class_name,80,false)))
      OR (status='REMOVED' AND notes IS NULL AND class_name IS NULL AND cardinality(topics)=0))
);
CREATE INDEX kai_journal_entries_author_day ON hon.kai_journal_entries(organization_id,school_id,author_principal_id,taught_on DESC) WHERE status='ACTIVE';
ALTER TABLE hon.kai_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.kai_journal_entries FORCE ROW LEVEL SECURITY;
-- No policies: reachable only through the fixed definer functions below.

-- Entries are never deleted; scope, author and creation time never change; a removed entry never changes again; every
-- update is the next version.
CREATE FUNCTION hon.guard_kai_journal_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'KAI_JOURNAL_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'ACTIVE' THEN RAISE EXCEPTION 'KAI_JOURNAL_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.author_principal_id,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.author_principal_id,OLD.created_at)
    OR OLD.status='REMOVED' OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'KAI_JOURNAL_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.kai_journal_entries FOR EACH ROW EXECUTE FUNCTION hon.guard_kai_journal_entry();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.kai_journal_entries FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_kai_journal_entry();

-- Live direct-human authority at the current school with teaching.journal.use and live COMPLETE access only.
-- Same identity rules as 0467.
CREATE FUNCTION hon.require_kai_journal_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 2048 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'KAI_JOURNAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
        AND x.code='teaching.journal.use' AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier='COMPLETE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier<>'COMPLETE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'KAI_JOURNAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.kai_journal_json(e hon.kai_journal_entries) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('entryId',e.id,'taughtOn',to_char(e.taught_on,'YYYY-MM-DD'),'className',e.class_name,'notes',e.notes,
    'topics',to_jsonb(e.topics),'source',e.entry_source,'status',e.status,'version',e.version,
    'createdAt',hon.saas_ts(e.created_at),'updatedAt',hon.saas_ts(e.updated_at))
$$;

-- One's own active entries between two school-local dates (inclusive, at most 120 days), newest first, at most 300.
CREATE FUNCTION hon.read_kai_journal(subject text,from_day date,to_day date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; tz text; result jsonb;
BEGIN
  IF from_day IS NULL OR to_day IS NULL OR to_day<from_day OR to_day-from_day>119
    OR from_day<date '2000-01-01' OR to_day>date '2099-12-31' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_kai_journal_actor(subject);
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  SELECT jsonb_build_object('timezone',tz,'today',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
      'from',to_char(from_day,'YYYY-MM-DD'),'to',to_char(to_day,'YYYY-MM-DD'),
      'entries',coalesce((SELECT jsonb_agg(hon.kai_journal_json(e) ORDER BY e.taught_on DESC,e.created_at DESC,e.id) FROM (
        SELECT * FROM hon.kai_journal_entries x WHERE x.organization_id=org AND x.school_id=school AND x.author_principal_id=actor
          AND x.status='ACTIVE' AND x.taught_on BETWEEN from_day AND to_day ORDER BY x.taught_on DESC,x.created_at DESC,x.id LIMIT 300) e),'[]'::jsonb))
    INTO result;
  IF hon.require_kai_journal_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'KAI_JOURNAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Add, change or remove one of one's own entries. Input:
--   {entryId|null, expectedVersion, taughtOn, className|null, notes, topics, source, status}
-- A new entry has entryId null, expectedVersion 0 and status ACTIVE. Removing sends status REMOVED; the other fields must
-- still be well formed and are not kept.
CREATE FUNCTION hon.save_kai_journal_entry(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; e hon.kai_journal_entries%ROWTYPE; before jsonb; result jsonb; d date; today date;
  t text[]; action text; expected integer; summary jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)
       IS DISTINCT FROM ARRAY['className','entryId','expectedVersion','notes','source','status','taughtOn','topics']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT (jsonb_typeof(p->'entryId')='null' OR (jsonb_typeof(p->'entryId')='string' AND p->>'entryId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR jsonb_typeof(p->'taughtOn') IS DISTINCT FROM 'string' OR p->>'taughtOn' !~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    OR NOT (jsonb_typeof(p->'className')='null' OR (jsonb_typeof(p->'className')='string' AND hon.kai_journal_text_ok(p->>'className',80,false)))
    OR jsonb_typeof(p->'notes') IS DISTINCT FROM 'string' OR NOT hon.kai_journal_text_ok(p->>'notes',2000,true)
    OR jsonb_typeof(p->'topics') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'topics')>10
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p->'topics') x WHERE jsonb_typeof(x)<>'string')
    OR jsonb_typeof(p->'source') IS DISTINCT FROM 'string' OR p->>'source' NOT IN ('TYPED','SPOKEN')
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ACTIVE','REMOVED')
    OR (jsonb_typeof(p->'entryId')='null' AND ((p->>'expectedVersion')::integer<>0 OR p->>'status'<>'ACTIVE'))
    OR (jsonb_typeof(p->'entryId')='string' AND (p->>'expectedVersion')::integer<1) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF to_char(to_date(p->>'taughtOn','YYYY-MM-DD'),'YYYY-MM-DD')<>p->>'taughtOn' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  t:=ARRAY(SELECT x FROM jsonb_array_elements_text(p->'topics') WITH ORDINALITY a(x,n) ORDER BY n);
  IF NOT hon.kai_journal_topics_ok(t) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  d:=(p->>'taughtOn')::date; expected:=(p->>'expectedVersion')::integer;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','kai_journal.save','input',p)::text,'UTF8')),'hex');
  actor:=hon.require_kai_journal_actor(subject);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_kai_journal_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'KAI_JOURNAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    -- The replay record holds no journal text: answer from the entry itself, only while it is still at that version.
    SELECT * INTO e FROM hon.kai_journal_entries x WHERE x.id=(prior.response_body->>'entryId')::uuid AND x.organization_id=org AND x.school_id=school
      AND x.author_principal_id=actor;
    IF NOT FOUND OR e.version<>(prior.response_body->>'version')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('entry',hon.kai_journal_json(e),'replayed',true);
  END IF;
  today:=hon.membership_school_today();
  IF p->>'status'='ACTIVE' AND d NOT BETWEEN today-400 AND today THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p->'entryId')='string' THEN
    -- Someone else's entry is indistinguishable from a missing one.
    SELECT * INTO e FROM hon.kai_journal_entries x WHERE x.id=(p->>'entryId')::uuid AND x.organization_id=org AND x.school_id=school
      AND x.author_principal_id=actor FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'KAI_JOURNAL_ENTRY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF e.status='REMOVED' THEN RAISE EXCEPTION 'KAI_JOURNAL_ENTRY_REMOVED' USING ERRCODE='55000'; END IF;
    IF e.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  END IF;
  IF e.id IS NULL THEN
    INSERT INTO hon.kai_journal_entries(organization_id,school_id,author_principal_id,taught_on,class_name,notes,topics,entry_source,status)
      VALUES(org,school,actor,d,p->>'className',p->>'notes',t,p->>'source','ACTIVE') RETURNING * INTO e;
    action:='kai_journal.create';
  ELSE
    before:=jsonb_build_object('entryId',e.id,'taughtOn',to_char(e.taught_on,'YYYY-MM-DD'),'status',e.status,'version',e.version,'source',e.entry_source,'topicCount',cardinality(e.topics));
    IF p->>'status'='REMOVED' THEN
      UPDATE hon.kai_journal_entries SET status='REMOVED',notes=NULL,class_name=NULL,topics='{}',version=e.version+1,updated_at=clock_timestamp()
        WHERE id=e.id RETURNING * INTO e;
      action:='kai_journal.remove';
    ELSE
      UPDATE hon.kai_journal_entries SET taught_on=d,class_name=p->>'className',notes=p->>'notes',topics=t,entry_source=p->>'source',
          version=e.version+1,updated_at=clock_timestamp()
        WHERE id=e.id RETURNING * INTO e;
      action:='kai_journal.update';
    END IF;
  END IF;
  result:=hon.kai_journal_json(e);
  summary:=jsonb_build_object('entryId',e.id,'taughtOn',to_char(e.taught_on,'YYYY-MM-DD'),'status',e.status,'version',e.version,'source',e.entry_source,'topicCount',cardinality(e.topics));
  -- The audit keeps dates, status, version and counts; notes, class and topics stay only on the entry.
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'KAI_JOURNAL_ENTRY',e.id,before,summary,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'kai_journal.entry_saved',1,'KAI_JOURNAL_ENTRY',e.id,e.version,correlation,request,
      jsonb_build_object('entryId',e.id,'version',e.version,'status',e.status));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=jsonb_build_object('entryId',e.id,'version',e.version,'status',e.status)
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_kai_journal_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'KAI_JOURNAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('entry',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_kai_journal(text,date,date)','hon.save_kai_journal_entry(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.kai_journal_text_ok(text,integer,boolean)','hon.kai_journal_topics_ok(text[])','hon.guard_kai_journal_entry()',
    'hon.require_kai_journal_actor(text)','hon.kai_journal_json(hon.kai_journal_entries)'];
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE hon.kai_journal_entries FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.kai_journal_entries FROM %I',r); END LOOP;
  FOREACH f IN ARRAY helpers||entry LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;
COMMIT;
