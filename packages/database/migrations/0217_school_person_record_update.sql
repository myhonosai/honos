BEGIN;

-- B-CRM-1a (proposed number 0217; the owner allocates the final number). A school can read one person
-- (student, guardian, adult member or contact) and correct that person's name, email and phone with
-- optimistic concurrency. The runtime role still has no UPDATE on hon.people: the only write path is the
-- fixed SECURITY DEFINER command below. No entitlement, billing, credit, AI, consent or family effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

-- Staff assignable so a school owner can delegate edits to a custom front-desk role. Every existing system
-- OWNER role receives it; HQ provisioning copies all current permissions into new OWNER roles.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
  VALUES('people.update','Edit a person''s name and contact details within an authorized school',false,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,'people.update' FROM hon.roles r WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

-- Live human authority at this exact school, or NULL. Unlike resolve_authorized_scope (statement time), every
-- window is checked against clock_timestamp(), so a grant or paid access that ends while the command waits on a
-- lock is seen when authority is decided again after the last write. Fail closed for paid access (B6A predicate):
-- a suspended, lapsed or not-yet-started organization cannot read or edit people here.
CREATE FUNCTION hon.school_person_actor(p_subject text,p_school uuid,p_update boolean) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT p.id FROM hon.users u
  JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
  JOIN hon.schools s ON s.id=p_school AND s.status='ACTIVE'
  JOIN hon.organizations o ON o.id=s.organization_id AND o.status='ACTIVE'
  WHERE u.external_subject=p_subject
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM unnest(CASE WHEN p_update THEN ARRAY['people.read','people.update'] ELSE ARRAY['people.read'] END) need
      WHERE NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g
        JOIN hon.role_permissions rp ON rp.role_id=g.role_id AND rp.organization_id=s.organization_id AND rp.permission_code=need
        WHERE g.principal_id=p.id AND g.organization_id=s.organization_id AND g.school_id=s.id AND g.revoked_at IS NULL
          AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())))
  LIMIT 1
$$;

-- Read shape shared by the read and the command. Consent rows record a channel, not an address.
CREATE FUNCTION hon.school_person_json(p_person uuid,p_subject text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('personId',x.id,'schoolId',x.school_id,'givenName',x.given_name,'familyName',x.family_name,
    'email',x.email::text,'phoneE164',x.phone_e164,'version',x.version,'updatedAt',hon.saas_ts(x.updated_at),
    'student',(SELECT jsonb_build_object('birthDate',to_char(sp.birth_date,'YYYY-MM-DD'),'status',sp.status::text)
      FROM hon.student_profiles sp WHERE sp.person_id=x.id AND sp.organization_id=x.organization_id AND sp.school_id=x.school_id),
    'consents',jsonb_build_object(
      'EMAIL',coalesce((SELECT c.status::text FROM hon.communication_consents c WHERE c.person_id=x.id AND c.channel='EMAIL'),'NOT_RECORDED'),
      'SMS',coalesce((SELECT c.status::text FROM hon.communication_consents c WHERE c.person_id=x.id AND c.channel='SMS'),'NOT_RECORDED')),
    'canEdit',hon.school_person_actor(p_subject,x.school_id,true) IS NOT NULL)
  FROM hon.people x WHERE x.id=p_person
$$;

CREATE FUNCTION hon.read_school_person(p_subject text,p_school uuid,p_person uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_org uuid;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL OR p_person IS NULL THEN RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.school_person_actor(p_subject,p_school,false);
  IF actor IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=p_school;
  -- Exact school only: a person from another school or organization is indistinguishable from a missing one.
  PERFORM 1 FROM hon.people WHERE id=p_person AND organization_id=v_org AND school_id=p_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN hon.school_person_json(p_person,p_subject);
END $$;

-- Input: exactly schoolId, personId, expectedVersion, givenName, familyName, email (string|null), phoneE164 (string|null).
-- Order: authority -> people write lock -> idempotency reservation (replay only while authority is current) -> person row lock ->
-- version -> unchanged -> consent rule -> update -> audit -> outbox -> completion -> authority decided again.
CREATE FUNCTION hon.update_school_person(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_school uuid; v_org uuid; v_person uuid; v_version integer; fp text; prior hon.idempotency_records%ROWTYPE;
  cur hon.people%ROWTYPE; nxt hon.people%ROWTYPE; v_given text; v_family text; v_email text; v_phone text;
  changed text[]:=ARRAY[]::text[]; before jsonb; result jsonb; v_request uuid:=gen_random_uuid();
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_subject IS NULL OR p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['email','expectedVersion','familyName','givenName','personId','phoneE164','schoolId']
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ uuid_re
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR p_input->>'personId' !~ uuid_re
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'givenName') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'familyName') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'email') NOT IN ('string','null') OR jsonb_typeof(p_input->'phoneE164') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_given:=btrim(p_input->>'givenName'); v_family:=btrim(p_input->>'familyName');
  v_email:=lower(btrim(p_input->>'email')); v_phone:=p_input->>'phoneE164';
  IF length(v_given) NOT BETWEEN 1 AND 120 OR length(v_family) NOT BETWEEN 1 AND 120
    OR v_given ~ '[[:cntrl:]]' OR v_family ~ '[[:cntrl:]]'
    OR (v_email IS NOT NULL AND (length(v_email) NOT BETWEEN 3 AND 320 OR v_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'))
    OR (v_phone IS NOT NULL AND v_phone !~ '^\+[1-9][0-9]{1,14}$') THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid; v_person:=(p_input->>'personId')::uuid; v_version:=(p_input->>'expectedVersion')::integer;

  actor:=hon.school_person_actor(p_subject,v_school,true);
  IF actor IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Same table order as the CRM registration/DRAFT flows (0160-0176 lock hon.people before hon.idempotency_records in
  -- SHARE ROW EXCLUSIVE): take the people write lock before the idempotency insert so the two can never deadlock.
  LOCK TABLE hon.people IN ROW EXCLUSIVE MODE;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=v_school;
  fp:=encode(sha256(convert_to('PERSON_UPDATE:'||jsonb_build_object('schoolId',v_school,'personId',v_person,'expectedVersion',v_version,
    'givenName',v_given,'familyName',v_family,'email',v_email,'phoneE164',v_phone)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(v_org,v_school,actor,'people.update:'||p_key::text,fp,'IN_PROGRESS',now()+interval '24 hours')
    ON CONFLICT (organization_id,school_id,principal_id,idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor
      AND idempotency_key='people.update:'||p_key::text FOR UPDATE;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'PERSON_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR prior.response_body IS NULL THEN RAISE EXCEPTION 'PERSON_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.school_person_actor(p_subject,v_school,true) IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN prior.response_body;
  END IF;

  -- Exact school only. NO KEY UPDATE: does not block family/student/consent inserts that hold KEY SHARE on the person.
  SELECT * INTO cur FROM hon.people WHERE id=v_person AND organization_id=v_org AND school_id=v_school FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF cur.version<>v_version THEN RAISE EXCEPTION 'PERSON_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF cur.given_name IS DISTINCT FROM v_given THEN changed:=array_append(changed,'givenName'); END IF;
  IF cur.family_name IS DISTINCT FROM v_family THEN changed:=array_append(changed,'familyName'); END IF;
  IF lower(cur.email::text) IS DISTINCT FROM v_email THEN changed:=array_append(changed,'email'); END IF;
  IF cur.phone_e164 IS DISTINCT FROM v_phone THEN changed:=array_append(changed,'phoneE164'); END IF;
  IF cardinality(changed)=0 THEN RAISE EXCEPTION 'PERSON_UNCHANGED' USING ERRCODE='22023'; END IF;
  -- Consent records a channel, not an address: never carry an opt-in to a new or cleared address.
  IF ('email'=ANY(changed) AND EXISTS(SELECT 1 FROM hon.communication_consents WHERE person_id=v_person AND channel='EMAIL' AND status='OPTED_IN'))
    OR ('phoneE164'=ANY(changed) AND EXISTS(SELECT 1 FROM hon.communication_consents WHERE person_id=v_person AND channel='SMS' AND status='OPTED_IN')) THEN
    RAISE EXCEPTION 'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;

  before:=jsonb_build_object('givenName',cur.given_name,'familyName',cur.family_name,'email',cur.email::text,'phoneE164',cur.phone_e164,'version',cur.version);
  -- A case-only email difference is not a change (citext); keep the stored spelling then.
  UPDATE hon.people SET given_name=v_given,family_name=v_family,email=CASE WHEN 'email'=ANY(changed) THEN v_email ELSE cur.email END,phone_e164=v_phone,version=cur.version+1,updated_at=clock_timestamp()
    WHERE id=v_person RETURNING * INTO nxt;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(v_org,v_school,actor,'HUMAN_UI','people.update','PERSON',v_person,before,
      jsonb_build_object('givenName',nxt.given_name,'familyName',nxt.family_name,'email',nxt.email::text,'phoneE164',nxt.phone_e164,'version',nxt.version,'changedFields',to_jsonb(changed)),
      'SUCCEEDED',v_request,v_request,clock_timestamp());
  -- Outbox carries ids, version and field names only: never a contact value.
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),v_org,v_school,'people.person.updated',1,'PERSON',v_person,nxt.version,v_request,v_request,
      jsonb_build_object('personId',v_person,'version',nxt.version,'changedFields',to_jsonb(changed)));
  result:=jsonb_build_object('person',hon.school_person_json(v_person,p_subject),'changedFields',to_jsonb(changed));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor AND idempotency_key='people.update:'||p_key::text;
  -- Decide authority after the last write: a grant revoked or expired, or paid access ended, while this command
  -- waited on a lock commits nothing.
  IF hon.school_person_actor(p_subject,v_school,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Deny first, then exactly the two entry points for the runtime role.
DO $$ DECLARE f regprocedure; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.school_person_actor(text,uuid,boolean)','hon.school_person_json(uuid,text)',
    'hon.read_school_person(text,uuid,uuid)','hon.update_school_person(text,jsonb,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_person(text,uuid,uuid),hon.update_school_person(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
