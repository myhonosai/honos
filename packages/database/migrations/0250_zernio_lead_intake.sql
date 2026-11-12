BEGIN;
-- 0250 Zernio lead intake (docs/architecture/COMMUNICATION_DELIVERY.md §5c). Owner decision 2026-11-09: a signed
-- Zernio `lead.received` event (Meta Lead Gen form) becomes a CRM lead automatically, but only when a human HON HQ
-- owner has mapped that exact Facebook account + form to one school and pipeline stage. Unknown, disabled or
-- ambiguous routing creates nothing. No raw payload, answer text or provider error is stored; the receipt keeps
-- only ids and the outcome. The lead's contact fields go to hon.people exactly as any CRM lead's do.

INSERT INTO hon.principals (id, principal_type, user_id, display_name, is_active)
VALUES ('00000000-0000-4000-8000-00000000c050', 'SYSTEM_SERVICE', NULL, 'Zernio lead intake', true);

CREATE TABLE hon.zernio_lead_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  account_id text NOT NULL CHECK (account_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  form_id text NOT NULL CHECK (form_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  pipeline_id uuid NOT NULL,
  pipeline_stage_id uuid NOT NULL,
  -- Which answer keys hold the name and contact. Only these five names, each a bounded key.
  field_map jsonb NOT NULL CHECK (jsonb_typeof(field_map) = 'object' AND octet_length(field_map::text) <= 1024),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  set_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_id, organization_id, school_id) REFERENCES hon.crm_pipelines(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_stage_id, organization_id, school_id) REFERENCES hon.crm_pipeline_stages(id, organization_id, school_id) ON DELETE RESTRICT,
  -- One school per Facebook account + form, ever: a form is never silently moved between schools.
  UNIQUE (account_id, form_id)
);
ALTER TABLE hon.zernio_lead_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.zernio_lead_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY zernio_lead_forms_tenant_isolation ON hon.zernio_lead_forms
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- One row per routed lead event. Unrouted events are not stored.
CREATE TABLE hon.zernio_lead_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  form_mapping_id uuid NOT NULL REFERENCES hon.zernio_lead_forms(id) ON DELETE RESTRICT,
  form_mapping_version integer NOT NULL,
  event_id text NOT NULL UNIQUE CHECK (event_id ~ '^[0-9A-Za-z_:.-]{1,128}$'),
  leadgen_id text NOT NULL UNIQUE CHECK (leadgen_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  outcome text NOT NULL CHECK (outcome IN ('CREATED', 'INVALID_CONTACT', 'SCHOOL_INACTIVE')),
  lead_id uuid REFERENCES hon.crm_leads(id) ON DELETE RESTRICT,
  lead_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK ((outcome = 'CREATED') = (lead_id IS NOT NULL))
);
CREATE INDEX zernio_lead_receipts_form_time_idx ON hon.zernio_lead_receipts (form_mapping_id, received_at DESC);
ALTER TABLE hon.zernio_lead_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.zernio_lead_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY zernio_lead_receipts_tenant_isolation ON hon.zernio_lead_receipts
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

CREATE FUNCTION hon.zernio_valid_field_map(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_typeof(p) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e WHERE e.key NOT IN ('fullName', 'givenName', 'familyName', 'email', 'phone')
      OR jsonb_typeof(e.value) <> 'string' OR (e.value #>> '{}') !~ '^[0-9A-Za-z_.-]{1,64}$')
    AND (p ? 'fullName' OR p ? 'givenName')
    AND (p ? 'email' OR p ? 'phone')
$$;
ALTER TABLE hon.zernio_lead_forms ADD CONSTRAINT zernio_lead_forms_field_map_valid CHECK (hon.zernio_valid_field_map(field_map));

-- HQ owner maps one Facebook account + Lead Gen form to one school pipeline stage, or disables it.
CREATE FUNCTION hon.set_zernio_lead_form_from_hq(
  p_subject text, p_school uuid, p_account_id text, p_form_id text, p_pipeline_id uuid, p_pipeline_stage_id uuid,
  p_field_map jsonb, p_status text, p_expected_version integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; s hon.schools%ROWTYPE; prior hon.zernio_lead_forms; next hon.zernio_lead_forms; req uuid := gen_random_uuid();
  v_map jsonb := coalesce(p_field_map, '{"fullName":"full_name","email":"email","phone":"phone_number"}'::jsonb);
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_school IS NULL OR p_status NOT IN ('ACTIVE', 'DISABLED') OR p_account_id IS NULL OR p_form_id IS NULL
     OR p_pipeline_id IS NULL OR p_pipeline_stage_id IS NULL OR NOT hon.zernio_valid_field_map(v_map) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM hon.schools WHERE id = p_school;
  IF s.id IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM hon.crm_pipeline_stages WHERE id = p_pipeline_stage_id AND pipeline_id = p_pipeline_id
    AND organization_id = s.organization_id AND school_id = s.id AND terminal_status IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  -- Serialize mappings of one account + form, so a concurrent first mapping by the same school sees the row and gets
  -- VERSION_CONFLICT instead of a unique violation.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.zernio_lead_form:' || p_account_id || ':' || p_form_id, 0));
  SELECT * INTO prior FROM hon.zernio_lead_forms WHERE account_id = p_account_id AND form_id = p_form_id FOR UPDATE;
  IF prior.id IS NULL THEN
    IF p_expected_version IS NOT NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    INSERT INTO hon.zernio_lead_forms (organization_id, school_id, account_id, form_id, pipeline_id, pipeline_stage_id, field_map, status, set_by_principal_id)
    VALUES (s.organization_id, s.id, p_account_id, p_form_id, p_pipeline_id, p_pipeline_stage_id, v_map, p_status, actor) RETURNING * INTO next;
  ELSE
    IF prior.school_id <> s.id THEN RAISE EXCEPTION 'ZERNIO_FORM_BELONGS_TO_ANOTHER_SCHOOL' USING ERRCODE = '23505'; END IF;
    IF p_expected_version IS DISTINCT FROM prior.version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    UPDATE hon.zernio_lead_forms SET pipeline_id = p_pipeline_id, pipeline_stage_id = p_pipeline_stage_id, field_map = v_map, status = p_status,
      set_by_principal_id = actor, version = version + 1, updated_at = now()
    WHERE id = prior.id RETURNING * INTO next;
  END IF;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (s.organization_id, s.id, actor, 'HON_HQ', 'integration.zernio_lead_form.set', 'ZERNIO_LEAD_FORM', next.id,
    CASE WHEN prior.id IS NULL THEN NULL ELSE jsonb_build_object('status', prior.status, 'pipelineStageId', prior.pipeline_stage_id, 'version', prior.version) END,
    jsonb_build_object('accountId', next.account_id, 'formId', next.form_id, 'status', next.status, 'pipelineStageId', next.pipeline_stage_id, 'version', next.version),
    'SUCCEEDED', req, req, now());
  RETURN jsonb_build_object('id', next.id, 'schoolId', next.school_id, 'accountId', next.account_id, 'formId', next.form_id,
    'pipelineId', next.pipeline_id, 'pipelineStageId', next.pipeline_stage_id, 'fieldMap', next.field_map, 'status', next.status,
    'version', next.version, 'updatedAt', next.updated_at);
END $$;

-- Records one verified lead event. Outcomes: CREATED (new CRM lead), REPLAYED (event or Meta lead already handled),
-- UNROUTED (no ACTIVE mapping for this account + form: nothing stored), INVALID_CONTACT (no usable name plus email or
-- phone), SCHOOL_INACTIVE (school, organization or CRM entitlement not active), RATE_LIMITED (more than 300 leads in an
-- hour for one form: nothing stored, the provider retries).
CREATE FUNCTION hon.record_zernio_lead(
  p_event_id text, p_leadgen_id text, p_account_id text, p_form_id text, p_fields jsonb, p_ad jsonb
) RETURNS TABLE (outcome text, lead_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
#variable_conflict use_column
DECLARE f hon.zernio_lead_forms; r hon.zernio_lead_receipts; v_given text; v_family text; v_full text; v_email text; v_phone text;
  v_person uuid; v_lead uuid := gen_random_uuid(); v_req uuid := gen_random_uuid(); v_facts jsonb; v_ok boolean;
  v_lead_row hon.crm_leads;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[0-9A-Za-z_:.-]{1,128}$' OR p_leadgen_id IS NULL OR p_leadgen_id !~ '^[0-9A-Za-z_-]{1,64}$'
     OR p_account_id IS NULL OR p_form_id IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR octet_length(p_fields::text) > 16384
     OR jsonb_typeof(coalesce(p_ad, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'HON Zernio lead is invalid.' USING ERRCODE = '22023';
  END IF;
  -- Serialize one Meta lead across concurrent redeliveries.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.zernio_lead:' || p_leadgen_id, 0));
  SELECT * INTO r FROM hon.zernio_lead_receipts x WHERE x.event_id = p_event_id OR x.leadgen_id = p_leadgen_id LIMIT 1;
  IF r.id IS NOT NULL THEN outcome := 'REPLAYED'; lead_id := r.lead_id; RETURN NEXT; RETURN; END IF;
  SELECT * INTO f FROM hon.zernio_lead_forms x WHERE x.account_id = p_account_id AND x.form_id = p_form_id AND x.status = 'ACTIVE';
  IF f.id IS NULL THEN outcome := 'UNROUTED'; lead_id := NULL; RETURN NEXT; RETURN; END IF;
  -- Same lock order as the public form path: organization -> school -> mapping.
  PERFORM 1 FROM hon.organizations o WHERE o.id = f.organization_id AND o.status = 'ACTIVE' FOR SHARE;
  v_ok := FOUND;
  IF v_ok THEN
    PERFORM 1 FROM hon.schools s WHERE s.id = f.school_id AND s.organization_id = f.organization_id AND s.status = 'ACTIVE' FOR SHARE;
    v_ok := FOUND;
  END IF;
  SELECT * INTO f FROM hon.zernio_lead_forms x WHERE x.id = f.id FOR SHARE;
  IF f.status <> 'ACTIVE' THEN outcome := 'UNROUTED'; lead_id := NULL; RETURN NEXT; RETURN; END IF;
  IF v_ok THEN
    PERFORM 1 FROM hon.organization_entitlements e WHERE e.organization_id = f.organization_id AND e.tier IN ('ESSENTIAL', 'CORE', 'COMPLETE')
      AND e.status = 'ACTIVE' AND e.effective_from <= clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp()) FOR SHARE;
    v_ok := FOUND;
  END IF;
  IF v_ok THEN
    PERFORM 1 FROM hon.crm_pipeline_stages st WHERE st.id = f.pipeline_stage_id AND st.pipeline_id = f.pipeline_id
      AND st.organization_id = f.organization_id AND st.school_id = f.school_id AND st.terminal_status IS NULL FOR SHARE;
    v_ok := FOUND;
  END IF;
  -- Serialize the hourly count per form, so concurrent leads cannot each see 299 and all pass.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.zernio_lead_rate:' || f.id::text, 0));
  IF (SELECT count(*) FROM hon.zernio_lead_receipts x WHERE x.form_mapping_id = f.id AND x.received_at > now() - interval '1 hour') >= 300 THEN
    outcome := 'RATE_LIMITED'; lead_id := NULL; RETURN NEXT; RETURN;
  END IF;
  IF NOT v_ok THEN
    INSERT INTO hon.zernio_lead_receipts (organization_id, school_id, form_mapping_id, form_mapping_version, event_id, leadgen_id, outcome)
    VALUES (f.organization_id, f.school_id, f.id, f.version, p_event_id, p_leadgen_id, 'SCHOOL_INACTIVE');
    outcome := 'SCHOOL_INACTIVE'; lead_id := NULL; RETURN NEXT; RETURN;
  END IF;

  -- Answers by the mapped keys only. Text is trimmed, control characters removed and bounded like the CRM form.
  v_full := left(btrim(regexp_replace(coalesce(p_fields ->> (f.field_map ->> 'fullName'), ''), '[[:cntrl:]]', ' ', 'g')), 120);
  v_given := left(btrim(regexp_replace(coalesce(p_fields ->> (f.field_map ->> 'givenName'), ''), '[[:cntrl:]]', ' ', 'g')), 80);
  v_family := left(btrim(regexp_replace(coalesce(p_fields ->> (f.field_map ->> 'familyName'), ''), '[[:cntrl:]]', ' ', 'g')), 80);
  IF v_given = '' AND v_full <> '' THEN
    v_given := left(split_part(regexp_replace(v_full, '\s+', ' ', 'g'), ' ', 1), 80);
    v_family := left(btrim(substr(regexp_replace(v_full, '\s+', ' ', 'g'), length(split_part(regexp_replace(v_full, '\s+', ' ', 'g'), ' ', 1)) + 1)), 80);
  END IF;
  v_email := lower(btrim(coalesce(p_fields ->> (f.field_map ->> 'email'), '')));
  IF v_email !~ '^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,63}$' THEN v_email := NULL; END IF;
  v_phone := regexp_replace(coalesce(p_fields ->> (f.field_map ->> 'phone'), ''), '[\s().-]', '', 'g');
  IF v_phone !~ '^\+[1-9][0-9]{7,14}$' THEN v_phone := NULL; END IF;
  IF v_given = '' OR (v_email IS NULL AND v_phone IS NULL) THEN
    INSERT INTO hon.zernio_lead_receipts (organization_id, school_id, form_mapping_id, form_mapping_version, event_id, leadgen_id, outcome)
    VALUES (f.organization_id, f.school_id, f.id, f.version, p_event_id, p_leadgen_id, 'INVALID_CONTACT');
    outcome := 'INVALID_CONTACT'; lead_id := NULL; RETURN NEXT; RETURN;
  END IF;

  -- The intake principal must still be the active, grant-free system service (the 0075 public-form rule).
  PERFORM 1 FROM hon.principals x WHERE x.id = '00000000-0000-4000-8000-00000000c050' AND x.principal_type = 'SYSTEM_SERVICE'
    AND x.user_id IS NULL AND x.is_active FOR SHARE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id = '00000000-0000-4000-8000-00000000c050')
     OR EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = '00000000-0000-4000-8000-00000000c050')
     OR EXISTS (SELECT 1 FROM hon.family_access_grants g WHERE g.principal_id = '00000000-0000-4000-8000-00000000c050') THEN
    RAISE EXCEPTION 'HON Zernio intake principal is unavailable.' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('app.hon_organization_id', f.organization_id::text, true), set_config('app.hon_school_id', f.school_id::text, true),
    set_config('app.hon_principal_id', '00000000-0000-4000-8000-00000000c050', true), set_config('app.hon_principal_type', 'SYSTEM_SERVICE', true),
    set_config('app.hon_source', 'INTEGRATION', true), set_config('app.hon_request_id', v_req::text, true),
    set_config('app.hon_action_request_id', '', true), set_config('app.hon_delegated_by_principal_id', '', true);
  v_facts := jsonb_build_object('source', 'ZERNIO_META', 'zernio', jsonb_strip_nulls(jsonb_build_object(
    'formMappingId', f.id, 'formMappingVersion', f.version, 'formId', f.form_id, 'leadgenId', p_leadgen_id,
    'adId', p_ad ->> 'adId', 'adsetId', p_ad ->> 'adsetId', 'adCampaignId', p_ad ->> 'campaignId',
    'isOrganic', CASE WHEN jsonb_typeof(p_ad -> 'isOrganic') = 'boolean' THEN p_ad -> 'isOrganic' END)));
  IF octet_length(v_facts::text) > 4096 THEN RAISE EXCEPTION 'HON Zernio lead is invalid.' USING ERRCODE = '22023'; END IF;
  INSERT INTO hon.people (organization_id, school_id, given_name, family_name, email, phone_e164)
  VALUES (f.organization_id, f.school_id, v_given, v_family, v_email::public.citext, v_phone) RETURNING id INTO v_person;
  INSERT INTO hon.crm_leads (id, organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id, source_code, attribution)
  VALUES (v_lead, f.organization_id, f.school_id, v_person, f.pipeline_id, f.pipeline_stage_id, 'ZERNIO_META', v_facts)
  RETURNING * INTO v_lead_row;
  INSERT INTO hon.zernio_lead_receipts (organization_id, school_id, form_mapping_id, form_mapping_version, event_id, leadgen_id, outcome, lead_id, lead_created_at)
  VALUES (f.organization_id, f.school_id, f.id, f.version, p_event_id, p_leadgen_id, 'CREATED', v_lead, v_lead_row.created_at);
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (f.organization_id, f.school_id, '00000000-0000-4000-8000-00000000c050', 'INTEGRATION', 'crm.lead.create', 'CRM_LEAD', v_lead, NULL,
    jsonb_build_object('source', 'ZERNIO_META', 'formMappingId', f.id, 'formMappingVersion', f.version, 'pipelineStageId', f.pipeline_stage_id, 'version', 1),
    'SUCCEEDED', v_req, v_req, now());
  INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
    aggregate_version, correlation_id, causation_id, payload)
  VALUES (gen_random_uuid(), f.organization_id, f.school_id, 'marketing.zernio.lead_received', 1, 'CRM_LEAD', v_lead, 1, v_req, v_req,
    jsonb_build_object('leadId', v_lead, 'formMappingId', f.id, 'source', 'ZERNIO_META', 'internalOnly', true));
  outcome := 'CREATED'; lead_id := v_lead; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION hon.zernio_valid_field_map(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.set_zernio_lead_form_from_hq(text, uuid, text, text, uuid, uuid, jsonb, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.record_zernio_lead(text, text, text, text, jsonb, jsonb) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.zernio_lead_forms, hon.zernio_lead_receipts FROM %I', r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.record_zernio_lead(text, text, text, text, jsonb, jsonb) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_zernio_lead_form_from_hq(text, uuid, text, text, uuid, uuid, jsonb, text, integer) TO hon_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    GRANT EXECUTE ON FUNCTION hon.record_zernio_lead(text, text, text, text, jsonb, jsonb) TO hon_communication_worker;
  END IF;
END;
$$;
COMMIT;
