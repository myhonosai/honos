BEGIN;

-- 0625 (allocated by the coordinator 2026-11-21): more profile details on the contact card's Edit profile pop-up.
-- Owner (David, 2026-11-21): "it should handle more than just name and contact. needs rank, program, more than 1 contact
-- both phone and email, date of birth, male or female and more."
-- Name, primary email, primary phone and birth date keep their existing commands (0217/0218); rank and program stay with
-- curriculum enrollments (0070). This adds one private row per person: gender, parent/guardian name, notes, a label for the
-- primary phone and email, and up to five other phones and five other emails with labels. Other phones and emails are kept for
-- staff to call or write by hand: nothing sends to them, and consent (0217 rule) still belongs to the primary address only.
-- Authority is the 0217 people actor (people.read to read, people.read + people.update to save; paid access must be live).
-- No entitlement, billing, consent, family, message, provider, automation or AI effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

CREATE TABLE hon.person_profile_details (
  person_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  gender text CHECK (gender IN ('MALE','FEMALE')),
  guardian_name text CHECK (length(guardian_name) BETWEEN 1 AND 200 AND guardian_name !~ '[[:cntrl:]]' AND guardian_name=btrim(guardian_name)),
  notes text CHECK (length(notes) BETWEEN 1 AND 2000 AND notes=btrim(notes) AND notes !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]'),
  primary_phone_label text CHECK (primary_phone_label IN ('MOBILE','HOME','WORK','OTHER')),
  primary_email_label text CHECK (primary_email_label IN ('PERSONAL','WORK','SCHOOL','OTHER')),
  other_phones jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(other_phones)='array' AND jsonb_array_length(other_phones)<=5),
  other_emails jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(other_emails)='array' AND jsonb_array_length(other_emails)<=5),
  version integer NOT NULL CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.person_profile_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.person_profile_details FORCE ROW LEVEL SECURITY;

-- Other phones or emails as the closed shape [{value,label}], normalized (trimmed; emails lower case), at most five, no repeats and
-- never the primary address; NULL when the input is not exactly that shape.
CREATE FUNCTION hon.person_profile_contact_list(p_list jsonb,p_kind text,p_primary text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE e jsonb; v text; l text; seen text[]:=ARRAY[]::text[]; out jsonb:='[]'::jsonb; field text:=CASE p_kind WHEN 'PHONE' THEN 'phoneE164' ELSE 'email' END;
BEGIN
  IF p_kind NOT IN ('PHONE','EMAIL') OR p_list IS NULL OR jsonb_typeof(p_list)<>'array' OR jsonb_array_length(p_list)>5 THEN RETURN NULL; END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_list) x LOOP
    IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(ARRAY['label',field]) k)
      OR jsonb_typeof(e->field)<>'string' OR jsonb_typeof(e->'label')<>'string' THEN RETURN NULL; END IF;
    v:=btrim(e->>field); l:=e->>'label';
    IF p_kind='PHONE' THEN
      IF v !~ '^\+[1-9][0-9]{1,14}$' OR l NOT IN ('MOBILE','HOME','WORK','OTHER') THEN RETURN NULL; END IF;
    ELSE
      v:=lower(v);
      IF length(v) NOT BETWEEN 3 AND 320 OR v !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
        OR l NOT IN ('PERSONAL','WORK','SCHOOL','OTHER') THEN RETURN NULL; END IF;
    END IF;
    IF v=ANY(seen) OR v IS NOT DISTINCT FROM p_primary THEN RETURN NULL; END IF;
    seen:=array_append(seen,v);
    out:=out||jsonb_build_array(jsonb_build_object(field,v,'label',l));
  END LOOP;
  RETURN out;
END $$;

-- Read shape for one person of the session school (version 0 while nothing was saved).
CREATE FUNCTION hon.person_profile_details_json(p_person uuid,p_subject text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('personId',x.id,'version',coalesce(d.version,0),'gender',d.gender,'guardianName',d.guardian_name,'notes',d.notes,
    'primaryPhoneLabel',d.primary_phone_label,'primaryEmailLabel',d.primary_email_label,
    'otherPhones',coalesce(d.other_phones,'[]'::jsonb),'otherEmails',coalesce(d.other_emails,'[]'::jsonb),
    'canEdit',hon.school_person_actor(p_subject,x.school_id,true) IS NOT NULL)
  FROM hon.people x LEFT JOIN hon.person_profile_details d ON d.person_id=x.id AND d.organization_id=x.organization_id AND d.school_id=x.school_id
  WHERE x.id=p_person
$$;

CREATE FUNCTION hon.read_school_person_details(p_subject text,p_school uuid,p_person uuid) RETURNS jsonb
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
  RETURN hon.person_profile_details_json(p_person,p_subject);
END $$;

-- Input: exactly schoolId, personId, expectedVersion (0 before the first save), gender (MALE|FEMALE|null), guardianName, notes
-- (string|null), primaryPhoneLabel, primaryEmailLabel (label|null), otherPhones [{phoneE164,label}], otherEmails [{email,label}].
-- Order (as 0217): authority -> people write lock -> idempotency reservation (replay only while authority is current) -> person row
-- FOR SHARE (a concurrent primary email/phone change waits, so "never the primary" holds) -> details row -> version -> unchanged ->
-- write -> audit -> outbox -> completion -> authority decided again after the last write.
CREATE FUNCTION hon.update_school_person_details(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_school uuid; v_org uuid; v_person uuid; v_version integer; fp text; prior hon.idempotency_records%ROWTYPE;
  p hon.people%ROWTYPE; cur hon.person_profile_details%ROWTYPE; had boolean; v_gender text; v_guardian text; v_notes text;
  v_pl text; v_el text; v_phones jsonb; v_emails jsonb; changed text[]:=ARRAY[]::text[]; before jsonb; after jsonb; result jsonb;
  v_request uuid:=gen_random_uuid(); v_next integer;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_subject IS NULL OR p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM
      ARRAY['expectedVersion','gender','guardianName','notes','otherEmails','otherPhones','personId','primaryEmailLabel','primaryPhoneLabel','schoolId']
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ uuid_re
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR p_input->>'personId' !~ uuid_re
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p_input->'gender') NOT IN ('string','null') OR jsonb_typeof(p_input->'guardianName') NOT IN ('string','null')
    OR jsonb_typeof(p_input->'notes') NOT IN ('string','null') OR jsonb_typeof(p_input->'primaryPhoneLabel') NOT IN ('string','null')
    OR jsonb_typeof(p_input->'primaryEmailLabel') NOT IN ('string','null')
    OR jsonb_typeof(p_input->'otherPhones') IS DISTINCT FROM 'array' OR jsonb_typeof(p_input->'otherEmails') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_gender:=p_input->>'gender'; v_guardian:=nullif(btrim(p_input->>'guardianName'),''); v_notes:=nullif(btrim(p_input->>'notes'),'');
  v_pl:=p_input->>'primaryPhoneLabel'; v_el:=p_input->>'primaryEmailLabel';
  IF (v_gender IS NOT NULL AND v_gender NOT IN ('MALE','FEMALE'))
    OR (v_guardian IS NOT NULL AND (length(v_guardian)>200 OR v_guardian ~ '[[:cntrl:]]'))
    OR (v_notes IS NOT NULL AND (length(v_notes)>2000 OR v_notes ~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]'))
    OR (v_pl IS NOT NULL AND v_pl NOT IN ('MOBILE','HOME','WORK','OTHER'))
    OR (v_el IS NOT NULL AND v_el NOT IN ('PERSONAL','WORK','SCHOOL','OTHER')) THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid; v_person:=(p_input->>'personId')::uuid; v_version:=(p_input->>'expectedVersion')::integer;
  -- Shape check before authority (the primary-address check is repeated under the person lock below).
  IF hon.person_profile_contact_list(p_input->'otherPhones','PHONE',NULL) IS NULL OR hon.person_profile_contact_list(p_input->'otherEmails','EMAIL',NULL) IS NULL THEN
    RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;

  actor:=hon.school_person_actor(p_subject,v_school,true);
  IF actor IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Same table order as 0217 (hon.people before hon.idempotency_records), so this can never deadlock with the CRM flows.
  LOCK TABLE hon.people IN ROW EXCLUSIVE MODE;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=v_school;
  fp:=encode(sha256(convert_to('PERSON_DETAILS_UPDATE:'||jsonb_build_object('schoolId',v_school,'personId',v_person,'expectedVersion',v_version,
    'gender',v_gender,'guardianName',v_guardian,'notes',v_notes,'primaryPhoneLabel',v_pl,'primaryEmailLabel',v_el,
    'otherPhones',hon.person_profile_contact_list(p_input->'otherPhones','PHONE',NULL),'otherEmails',hon.person_profile_contact_list(p_input->'otherEmails','EMAIL',NULL))::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(v_org,v_school,actor,'people.details:'||p_key::text,fp,'IN_PROGRESS',now()+interval '24 hours')
    ON CONFLICT (organization_id,school_id,principal_id,idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor
      AND idempotency_key='people.details:'||p_key::text FOR UPDATE;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'PERSON_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR prior.response_body IS NULL THEN RAISE EXCEPTION 'PERSON_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.school_person_actor(p_subject,v_school,true) IS NULL THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN prior.response_body;
  END IF;

  -- Exact school only. FOR SHARE: a concurrent 0217 name/contact save (FOR NO KEY UPDATE) waits until this commits.
  SELECT * INTO p FROM hon.people WHERE id=v_person AND organization_id=v_org AND school_id=v_school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  v_phones:=hon.person_profile_contact_list(p_input->'otherPhones','PHONE',p.phone_e164);
  v_emails:=hon.person_profile_contact_list(p_input->'otherEmails','EMAIL',lower(p.email::text));
  IF v_phones IS NULL OR v_emails IS NULL THEN RAISE EXCEPTION 'PERSON_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO cur FROM hon.person_profile_details WHERE person_id=v_person FOR UPDATE;
  had:=FOUND;
  IF coalesce(cur.version,0)<>v_version THEN RAISE EXCEPTION 'PERSON_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF cur.gender IS DISTINCT FROM v_gender THEN changed:=array_append(changed,'gender'); END IF;
  IF cur.guardian_name IS DISTINCT FROM v_guardian THEN changed:=array_append(changed,'guardianName'); END IF;
  IF cur.notes IS DISTINCT FROM v_notes THEN changed:=array_append(changed,'notes'); END IF;
  IF cur.primary_phone_label IS DISTINCT FROM v_pl THEN changed:=array_append(changed,'primaryPhoneLabel'); END IF;
  IF cur.primary_email_label IS DISTINCT FROM v_el THEN changed:=array_append(changed,'primaryEmailLabel'); END IF;
  IF coalesce(cur.other_phones,'[]'::jsonb) IS DISTINCT FROM v_phones THEN changed:=array_append(changed,'otherPhones'); END IF;
  IF coalesce(cur.other_emails,'[]'::jsonb) IS DISTINCT FROM v_emails THEN changed:=array_append(changed,'otherEmails'); END IF;
  IF cardinality(changed)=0 THEN RAISE EXCEPTION 'PERSON_UNCHANGED' USING ERRCODE='22023'; END IF;

  v_next:=coalesce(cur.version,0)+1;
  before:=CASE WHEN had THEN jsonb_build_object('gender',cur.gender,'guardianName',cur.guardian_name,'notes',cur.notes,'primaryPhoneLabel',cur.primary_phone_label,
    'primaryEmailLabel',cur.primary_email_label,'otherPhones',cur.other_phones,'otherEmails',cur.other_emails,'version',cur.version) ELSE NULL END;
  IF had THEN
    UPDATE hon.person_profile_details SET gender=v_gender,guardian_name=v_guardian,notes=v_notes,primary_phone_label=v_pl,primary_email_label=v_el,
      other_phones=v_phones,other_emails=v_emails,version=v_next,updated_at=clock_timestamp() WHERE person_id=v_person;
  ELSE
    INSERT INTO hon.person_profile_details(person_id,organization_id,school_id,gender,guardian_name,notes,primary_phone_label,primary_email_label,other_phones,other_emails,version)
      VALUES(v_person,v_org,v_school,v_gender,v_guardian,v_notes,v_pl,v_el,v_phones,v_emails,v_next);
  END IF;
  after:=jsonb_build_object('gender',v_gender,'guardianName',v_guardian,'notes',v_notes,'primaryPhoneLabel',v_pl,'primaryEmailLabel',v_el,
    'otherPhones',v_phones,'otherEmails',v_emails,'version',v_next,'changedFields',to_jsonb(changed));
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(v_org,v_school,actor,'HUMAN_UI','people.details.update','PERSON',v_person,before,after,'SUCCEEDED',v_request,v_request,clock_timestamp());
  -- Outbox carries ids, version and field names only: never a value.
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),v_org,v_school,'people.person.details_updated',1,'PERSON',v_person,v_next,v_request,v_request,
      jsonb_build_object('personId',v_person,'version',v_next,'changedFields',to_jsonb(changed)));
  result:=jsonb_build_object('details',hon.person_profile_details_json(v_person,p_subject),'changedFields',to_jsonb(changed));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=v_org AND school_id=v_school AND principal_id=actor AND idempotency_key='people.details:'||p_key::text;
  -- Decide authority after the last write: a grant revoked or expired, or paid access ended, while this waited commits nothing.
  IF hon.school_person_actor(p_subject,v_school,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PERSON_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON FUNCTION hon.update_school_person_details(text,jsonb,uuid) IS
'Only a direct human with people.read + people.update at the exact school while paid access is live: gender, guardian name, notes, contact labels and up to five other phones and emails for one person. Nothing is sent to any address; consent stays with the primary address (0217).';

-- Deny first, then exactly the two entry points for the runtime role; the table has no runtime privilege.
DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_school_person_details(text,uuid,uuid)','hon.update_school_person_details(text,jsonb,uuid)'];
  fns text[]:=ARRAY['hon.person_profile_contact_list(jsonb,text,text)','hon.person_profile_details_json(uuid,text)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  EXECUTE 'REVOKE ALL ON TABLE hon.person_profile_details FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.person_profile_details FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
