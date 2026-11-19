BEGIN;

-- Automatic contact consent at lead intake (IC1, 0545, assigned by the coordinator 2026-11-19).
-- Owner decision 2026-11-19 05:12Z "Email automatic, texts one tick": a contact that reaches a school through lead
-- intake gets email consent recorded when the record is created; text consent only when the lead ticks the unticked
-- "Text me" box (website form, walk-in kiosk) or has texted the school (conversation lead). Staff adds and CSV imports
-- record both by default, and staff can untick either. Spec: docs/architecture/INTAKE_CONTACT_CONSENT.md.
--   * Never overwrites: an existing consent row for the person and channel (either status) is left alone.
--   * An opt-out wins: if any record of the same school with the same email (EMAIL) or phone (SMS) is OPTED_OUT, the new
--     record gets OPTED_OUT (method PRIOR_OPT_OUT) instead of an agreement. STOP/unsubscribe (0243/0248) are unchanged.
--   * Each automatic record keeps an append-only capture row: method, consent version, form/batch/visit ids and the
--     wording version. Never a name, email, phone or IP.
--   * Recording consent sends nothing and starts no automation.
-- System intake is detected from rows only that path can write in the same transaction (form receipt, Zernio receipt,
-- kiosk visit, linked conversation with an inbound text), by a deferred trigger on hon.crm_leads, so no existing intake
-- function is rewritten. Staff paths call one runtime entry point, hon.record_staff_intake_consent, after creating the
-- people in the same transaction. Demo data and registration records never get automatic consent.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Intake contact consent requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Intake contact consent requires a restricted runtime';
  END IF;
  IF to_regclass('hon.communication_consents') IS NULL OR to_regclass('hon.public_lead_form_receipts') IS NULL
    OR to_regclass('hon.zernio_lead_receipts') IS NULL OR to_regclass('hon.walkin_visits') IS NULL
    OR to_regclass('hon.school_conversation_messages') IS NULL OR to_regclass('hon.lead_import_rows') IS NULL
    OR to_regclass('hon.student_import_rows') IS NULL
    OR to_regprocedure('hon.conversation_staff_has(uuid,uuid,uuid,text)') IS NULL
    OR to_regprocedure('hon.validate_public_form_submission(jsonb,jsonb)') IS NULL
    OR to_regprocedure('hon.read_published_form(text)') IS NULL THEN
    RAISE EXCEPTION 'Intake contact consent requires 0046, 0067, 0075, 0226, 0243, 0250, 0364 and 0414';
  END IF;
END $$;

CREATE TABLE hon.communication_consent_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  consent_id uuid NOT NULL,
  channel hon.communication_consent_channel NOT NULL,
  status hon.communication_consent_status NOT NULL,
  consent_version integer NOT NULL CHECK (consent_version >= 1),
  method text NOT NULL CHECK (method IN ('LEAD_FORM','WALK_IN_KIOSK','FACEBOOK_LEAD_FORM','INBOUND_TEXT',
    'STAFF_ADD','LEAD_IMPORT','STUDENT_IMPORT','PRIOR_OPT_OUT')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text) <= 2048),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (consent_id, organization_id, school_id)
    REFERENCES hon.communication_consents(id, organization_id, school_id) ON DELETE RESTRICT,
  CHECK ((method='PRIOR_OPT_OUT') = (status='OPTED_OUT'))
);
CREATE INDEX communication_consent_captures_consent_idx ON hon.communication_consent_captures(consent_id, captured_at DESC);
ALTER TABLE hon.communication_consent_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.communication_consent_captures FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_consent_captures_tenant_isolation ON hon.communication_consent_captures
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (false);

-- The one writer. Takes the shared person/channel advisory lock (0217, consent service), then applies the rules.
-- p_adopt: the path already wrote this person's row in this transaction (kiosk tick); keep it and only add evidence.
CREATE FUNCTION hon.record_intake_consent(p_person uuid, p_channel text, p_method text, p_evidence jsonb, p_actor uuid, p_adopt boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE pe hon.people; cur hon.communication_consents; prior hon.communication_consents; nxt hon.communication_consents;
  v_status text:='OPTED_IN'; v_method text:=p_method; v_source text; v_evidence jsonb:=coalesce(p_evidence,'{}'::jsonb)||jsonb_build_object('wording','IC1-2026-11-19');
  v_req uuid:=gen_random_uuid();
BEGIN
  IF p_channel NOT IN ('EMAIL','SMS') OR p_method NOT IN ('LEAD_FORM','WALK_IN_KIOSK','FACEBOOK_LEAD_FORM','INBOUND_TEXT','STAFF_ADD','LEAD_IMPORT','STUDENT_IMPORT') THEN
    RAISE EXCEPTION 'HON intake consent input is invalid.' USING ERRCODE='22023'; END IF;
  SELECT * INTO pe FROM hon.people WHERE id=p_person;
  IF NOT FOUND THEN RETURN 'NO_PERSON'; END IF;
  IF (p_channel='EMAIL' AND coalesce(pe.email::text,'')='') OR (p_channel='SMS' AND coalesce(pe.phone_e164,'')='') THEN RETURN 'NO_ADDRESS'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_person::text||':'||p_channel,0));
  SELECT * INTO cur FROM hon.communication_consents WHERE person_id=p_person AND channel=p_channel::hon.communication_consent_channel FOR UPDATE;
  IF FOUND THEN
    IF p_adopt AND cur.status='OPTED_IN' AND cur.created_at=now()
       AND NOT EXISTS(SELECT 1 FROM hon.communication_consent_captures c WHERE c.consent_id=cur.id) THEN
      INSERT INTO hon.communication_consent_captures(organization_id,school_id,consent_id,channel,status,consent_version,method,evidence,actor_principal_id)
        VALUES(cur.organization_id,cur.school_id,cur.id,cur.channel,cur.status,cur.version,p_method,v_evidence,p_actor);
      RETURN 'ADOPTED';
    END IF;
    RETURN 'ALREADY_RECORDED';
  END IF;
  SELECT k.* INTO prior FROM hon.communication_consents k JOIN hon.people q ON q.id=k.person_id
  WHERE k.organization_id=pe.organization_id AND k.school_id=pe.school_id AND k.channel=p_channel::hon.communication_consent_channel
    AND k.status='OPTED_OUT' AND k.person_id<>p_person
    AND CASE p_channel WHEN 'EMAIL' THEN q.email=pe.email ELSE q.phone_e164=pe.phone_e164 END
  ORDER BY k.updated_at DESC, k.id LIMIT 1;
  IF prior.id IS NOT NULL THEN
    v_status:='OPTED_OUT'; v_method:='PRIOR_OPT_OUT'; v_source:='RECIPIENT';
    v_evidence:=jsonb_build_object('priorConsentId',prior.id,'intakeMethod',p_method,'wording','IC1-2026-11-19');
  ELSE
    v_source:=CASE WHEN p_method IN ('LEAD_FORM','WALK_IN_KIOSK','FACEBOOK_LEAD_FORM','INBOUND_TEXT') THEN 'RECIPIENT'
      WHEN p_method IN ('LEAD_IMPORT','STUDENT_IMPORT') THEN 'IMPORT' ELSE 'STAFF' END;
  END IF;
  INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id)
    VALUES(pe.organization_id,pe.school_id,p_person,p_channel::hon.communication_consent_channel,v_status::hon.communication_consent_status,
      v_source::hon.communication_consent_source,clock_timestamp(),p_actor) RETURNING * INTO nxt;
  INSERT INTO hon.communication_consent_captures(organization_id,school_id,consent_id,channel,status,consent_version,method,evidence,actor_principal_id)
    VALUES(nxt.organization_id,nxt.school_id,nxt.id,nxt.channel,nxt.status,nxt.version,v_method,v_evidence,p_actor);
  -- Identifiers only: never a contact value in audit or outbox.
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
    VALUES(nxt.organization_id,nxt.school_id,p_actor,CASE WHEN v_source='RECIPIENT' AND p_method<>'INBOUND_TEXT' THEN 'INTEGRATION' ELSE 'HUMAN_UI' END,
      'communication.consent.intake_recorded','COMMUNICATION_CONSENT',nxt.id,NULL,
      jsonb_build_object('personId',p_person,'channel',p_channel,'status',v_status,'source',v_source,'method',v_method,'version',nxt.version),
      'SUCCEEDED',v_req,v_req,now());
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(gen_random_uuid(),nxt.organization_id,nxt.school_id,'communication.consent.recorded',1,'COMMUNICATION_CONSENT',nxt.id,nxt.version,v_req,v_req,
      jsonb_build_object('personId',p_person,'channel',p_channel,'status',v_status,'source',v_source));
  RETURN v_status;
END $$;

-- Deferred to commit, so it runs after the intake path's own writes (receipt, visit, conversation link, kiosk tick).
-- The lead is new in this transaction, so a receipt, visit or conversation that names it was written here too.
CREATE FUNCTION hon.intake_consent_after_lead() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE l hon.crm_leads; v hon.walkin_visits; c hon.school_conversations; ev jsonb; text_opt_in boolean;
BEGIN
  SELECT * INTO l FROM hon.crm_leads WHERE id=NEW.id;
  IF NOT FOUND OR hon.demo_data_is_demo('crm_leads',l.id) THEN RETURN NULL; END IF;
  IF l.source_code='PUBLIC_API' THEN
    -- Only the public form submit writes a receipt for this lead in this transaction.
    IF EXISTS(SELECT 1 FROM hon.public_lead_form_receipts r WHERE r.lead_id=l.id AND r.organization_id=l.organization_id
        AND r.school_id=l.school_id AND r.transaction_id=txid_current()) THEN
      ev:=jsonb_build_object('leadId',l.id,'formId',l.attribution->'publicForm'->'id','formVersion',l.attribution->'publicForm'->'version');
      text_opt_in:=coalesce(l.attribution->'optionalAnswers'->'textOptIn','false'::jsonb)='true'::jsonb;
      PERFORM hon.record_intake_consent(l.primary_person_id,'EMAIL','LEAD_FORM',ev,'00000000-0000-4000-8000-000000000075');
      IF text_opt_in THEN
        PERFORM hon.record_intake_consent(l.primary_person_id,'SMS','LEAD_FORM',ev||jsonb_build_object('textOptIn',true),'00000000-0000-4000-8000-000000000075');
      END IF;
    END IF;
  ELSIF l.source_code='ZERNIO_META' THEN
    IF EXISTS(SELECT 1 FROM hon.zernio_lead_receipts r WHERE r.lead_id=l.id AND r.outcome='CREATED') THEN
      ev:=jsonb_build_object('leadId',l.id,'formMappingId',l.attribution->'zernio'->'formMappingId','formMappingVersion',l.attribution->'zernio'->'formMappingVersion');
      PERFORM hon.record_intake_consent(l.primary_person_id,'EMAIL','FACEBOOK_LEAD_FORM',ev,'00000000-0000-4000-8000-00000000c050');
    END IF;
  ELSIF l.source_code='WALK_IN_KIOSK' THEN
    SELECT * INTO v FROM hon.walkin_visits x WHERE x.lead_id=l.id AND x.organization_id=l.organization_id AND x.school_id=l.school_id;
    IF v.id IS NOT NULL THEN
      ev:=jsonb_build_object('leadId',l.id,'visitId',v.id,'textOptIn',v.marketing_opt_in);
      PERFORM hon.record_intake_consent(l.primary_person_id,'EMAIL','WALK_IN_KIOSK',ev,'00000000-0000-4000-8000-000000000414',true);
      IF v.marketing_opt_in THEN
        PERFORM hon.record_intake_consent(l.primary_person_id,'SMS','WALK_IN_KIOSK',ev,'00000000-0000-4000-8000-000000000414',true);
      END IF;
    END IF;
  ELSIF l.source_code='CONVERSATION_SMS' THEN
    -- The person texted the school first: an inbound message on the conversation linked to this lead and person.
    SELECT * INTO c FROM hon.school_conversations x WHERE x.lead_id=l.id AND x.person_id=l.primary_person_id AND x.channel='SMS'
      AND x.organization_id=l.organization_id AND x.school_id=l.school_id;
    IF c.id IS NOT NULL AND EXISTS(SELECT 1 FROM hon.school_conversation_messages m WHERE m.conversation_id=c.id AND m.direction='INBOUND')
       AND EXISTS(SELECT 1 FROM hon.people p WHERE p.id=l.primary_person_id AND p.phone_e164=c.contact_address) THEN
      PERFORM hon.record_intake_consent(l.primary_person_id,'SMS','INBOUND_TEXT',jsonb_build_object('leadId',l.id,'conversationId',c.id),
        nullif(current_setting('app.hon_principal_id',true),'')::uuid);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crm_leads_intake_consent AFTER INSERT ON hon.crm_leads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.intake_consent_after_lead();

-- Staff paths: the API calls this in the same transaction that created the people, with the channels staff left ticked.
-- Input exactly {method, channels, personId} for STAFF_ADD or {method, channels, batchId} for an import finalize.
-- Only people created in this transaction (created_at = transaction start) are touched; anything else is ignored.
CREATE FUNCTION hon.record_staff_intake_consent(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; m text; ch text; person uuid;
  people uuid[]:=ARRAY[]::uuid[]; recorded integer:=0; outcome text; ev jsonb; allowed boolean;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'method') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'channels') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'channels')>2
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'channels') e WHERE e NOT IN ('"EMAIL"'::jsonb,'"SMS"'::jsonb))
    OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(p->'channels') e)<>jsonb_array_length(p->'channels') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  m:=p->>'method';
  IF NOT ((m='STAFF_ADD' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)=ARRAY['channels','method','personId'] AND jsonb_typeof(p->'personId')='string')
       OR (m IN ('LEAD_IMPORT','STUDENT_IMPORT') AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)=ARRAY['batchId','channels','method'] AND jsonb_typeof(p->'batchId')='string'))
    OR coalesce(p->>'personId',p->>'batchId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'INTAKE_CONSENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT x.id INTO actor FROM hon.users u JOIN hon.principals x ON x.user_id=u.id
  WHERE u.external_subject=subject AND x.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
  allowed:=CASE m WHEN 'STAFF_ADD' THEN hon.conversation_staff_has(actor,org,school,'crm.lead.create') OR hon.conversation_staff_has(actor,org,school,'people.create')
      WHEN 'LEAD_IMPORT' THEN hon.conversation_staff_has(actor,org,school,'migration.lead_import.review')
      ELSE hon.conversation_staff_has(actor,org,school,'students.import') END;
  IF NOT coalesce(allowed,false) THEN
    RAISE EXCEPTION 'INTAKE_CONSENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF m='STAFF_ADD' THEN
    people:=ARRAY(SELECT x.id FROM hon.people x WHERE x.id=(p->>'personId')::uuid AND x.organization_id=org AND x.school_id=school
      AND x.created_at=now());
    ev:='{}'::jsonb;
  ELSIF m='LEAD_IMPORT' THEN
    people:=ARRAY(SELECT l.primary_person_id FROM hon.lead_import_rows r JOIN hon.crm_leads l ON l.id=r.lead_id
      JOIN hon.people x ON x.id=l.primary_person_id
      WHERE r.batch_id=(p->>'batchId')::uuid AND l.organization_id=org AND l.school_id=school AND x.created_at=now() ORDER BY r.row_index);
    ev:=jsonb_build_object('batchId',p->>'batchId');
  ELSE
    people:=ARRAY(SELECT DISTINCT x.id FROM hon.student_import_rows r JOIN hon.people x ON x.id IN (r.guardian_person_id,r.student_person_id)
      WHERE r.batch_id=(p->>'batchId')::uuid AND x.organization_id=org AND x.school_id=school AND x.created_at=now() ORDER BY x.id);
    ev:=jsonb_build_object('batchId',p->>'batchId');
  END IF;
  FOREACH person IN ARRAY people LOOP
    FOR ch IN SELECT e FROM jsonb_array_elements_text(p->'channels') e ORDER BY CASE e WHEN 'EMAIL' THEN 0 ELSE 1 END LOOP
      outcome:=hon.record_intake_consent(person,ch,m,ev,actor);
      IF outcome IN ('OPTED_IN','OPTED_OUT') THEN recorded:=recorded+1; END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('people',cardinality(people),'recorded',recorded);
END $$;

-- Public form: an optional boolean textOptIn (the lead's own "Text me" tick). It is kept in the lead's optional answers,
-- where the deferred trigger reads it. Everything else is the 0075 body unchanged.
CREATE OR REPLACE FUNCTION hon.validate_public_form_submission(p jsonb,p_fields jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE k text; v text; cap integer; result jsonb:='{}';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>8192 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) AS keys(key) WHERE key NOT IN('name','email','mobile','interest','source','website','acknowledged','ageBand','experience','preferredTime','textOptIn')) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p->'website') IS DISTINCT FROM 'string' OR p->>'website'<>'' OR jsonb_typeof(p->'acknowledged') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 IF p ? 'textOptIn' AND jsonb_typeof(p->'textOptIn') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['name','email','mobile','interest','source','ageBand','experience','preferredTime']) LOOP
  IF p ? k THEN
   cap:=CASE k WHEN 'name' THEN 120 WHEN 'email' THEN 254 WHEN 'mobile' THEN 16 WHEN 'interest' THEN 80 WHEN 'source' THEN 80 ELSE 30 END;
   IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k)>cap OR (p->>k) ~ '[[:cntrl:]\u0080-\u009F - ​-‏‪-‮⁠-⁯﻿]' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   v:=regexp_replace(p->>k,'^[[:space:]   -   　]+|[[:space:]   -   　]+$','','g');
   IF k<>'mobile' AND v ~ '^[=+@-]' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   IF k='mobile' AND v<>'' AND v !~ '^\+[1-9][0-9]{6,14}$' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   IF k='email' THEN v:=lower(v); IF v<>'' AND v !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF; END IF;
   IF k IN('ageBand','experience','preferredTime') THEN
    IF NOT(p_fields ? k) OR (k='ageBand' AND v NOT IN('CHILD','TEEN','ADULT')) OR (k='experience' AND v NOT IN('NEW','SOME','EXPERIENCED')) OR (k='preferredTime' AND v NOT IN('MORNING','AFTERNOON','EVENING','WEEKEND')) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   END IF;
   result:=result||jsonb_build_object(k,v);
  END IF;
 END LOOP;
 IF coalesce(result->>'name','')='' OR (coalesce(result->>'email','')='' AND coalesce(result->>'mobile','')='') THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 -- A text tick without a mobile number records nothing, so it is dropped rather than kept as a misleading answer.
 IF (p->'textOptIn')='true'::jsonb AND coalesce(result->>'mobile','')<>'' THEN result:=result||jsonb_build_object('textOptIn',true); END IF;
 RETURN jsonb_build_object('name',result->>'name','email',coalesce(result->>'email',''),'mobile',coalesce(result->>'mobile',''),'interest',coalesce(result->>'interest',''),'source',coalesce(result->>'source',''),'acknowledged',p->'acknowledged')||(result-ARRAY['name','email','mobile','interest','source']);
END $$;

-- The published form also names its school, for the consent wording next to submit.
CREATE OR REPLACE FUNCTION hon.read_published_form(p_public_id text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('publicId',f.public_id,'title',f.title,'description',f.description,'optionalFields',f.optional_fields,'schoolName',s.name)
 FROM hon.public_lead_forms f JOIN hon.organizations o ON o.id=f.organization_id JOIN hon.schools s ON s.id=f.school_id AND s.organization_id=f.organization_id
 WHERE p_public_id ~ '^[a-f0-9]{48}$' AND f.public_id=p_public_id AND f.status='PUBLISHED' AND o.status='ACTIVE' AND s.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=f.organization_id AND e.tier IN('ESSENTIAL','CORE','COMPLETE') AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
 AND EXISTS(SELECT 1 FROM hon.crm_pipeline_stages st WHERE st.id=f.pipeline_stage_id AND st.pipeline_id=f.pipeline_id AND st.terminal_status IS NULL)
 AND (f.campaign_id IS NULL OR EXISTS(SELECT 1 FROM hon.marketing_campaigns c WHERE c.id=f.campaign_id AND c.organization_id=f.organization_id AND c.school_id=f.school_id AND c.status='ACTIVE'))
$$;

-- ACL: one runtime entry point and a read of the capture evidence; every helper stays migration-owner only.
DO $$ DECLARE r text; f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.record_intake_consent(uuid,text,text,jsonb,uuid,boolean)','hon.intake_consent_after_lead()',
      'hon.record_staff_intake_consent(text,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.communication_consent_captures FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.communication_consent_captures FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.record_staff_intake_consent(text,jsonb) TO hon_runtime;
    GRANT SELECT ON TABLE hon.communication_consent_captures TO hon_runtime;
  END IF;
END $$;

COMMIT;
