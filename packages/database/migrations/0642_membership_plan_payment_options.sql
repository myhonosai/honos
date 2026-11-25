BEGIN;

-- 0642 Membership plan payment options (coordinator-allocated 2026-11-22; owner request David 2026-11-22 07:58Z:
-- "Membership type should be made with payment plans as option", modelled on his Manus CRM New Plan form).
-- docs/architecture/MEMBERSHIP_PLAN_PAYMENT_OPTIONS.md.
--   PO1  A published plan version may carry a setup: classes per week, up to 12 feature lines and 1 to 6 payment
--        options. Each option: label, amount, how often (WEEKLY, MONTHLY, QUARTERLY, ANNUAL, PAID_IN_FULL), number
--        of payments (null = ongoing), length in months (null = ongoing), down payment at sign-up, and whether
--        checkout pages may offer it. Setups are immutable, like the 0175 version they belong to.
--   PO2  Option 1 is the standard option. Its amount, frequency and length ARE the 0175 version's price,
--        billing_frequency and term, written by the same command, so every existing reader of plan versions
--        (contact card, checkout, import, activation, reports) keeps reading exactly what it reads today.
--        Option 1 therefore uses only the four 0175 frequencies.
--   PO3  Two new commands publish a version and its setup in one transaction with the 0175 actor, lock order,
--        idempotency, audit action codes and outbox event. The 0175 create/revise commands are unchanged; a
--        version they publish has no setup, and the setup read shows one derived option from its price.
--   PO4  One new read returns the setup of every plan's current version for the 0175 catalog actor.
-- No schedule, invoice, payment, charge, processor, communication or AI effect. Payments stay off.

CREATE TABLE hon.membership_plan_version_setups (
  plan_id uuid NOT NULL,
  version integer NOT NULL,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  classes_per_week integer CHECK (classes_per_week BETWEEN 1 AND 14),
  features jsonb NOT NULL CHECK (jsonb_typeof(features)='array' AND jsonb_array_length(features)<=12),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(plan_id,version),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(plan_id,organization_id,school_id) REFERENCES hon.membership_plans(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(plan_id,version) REFERENCES hon.membership_plan_versions(plan_id,version) ON DELETE RESTRICT
);

CREATE TABLE hon.membership_plan_payment_options (
  plan_id uuid NOT NULL,
  version integer NOT NULL,
  option_no integer NOT NULL CHECK (option_no BETWEEN 1 AND 6),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80 AND btrim(label)=label AND label !~ '[[:cntrl:]<>]'),
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 0 AND 100000000),
  billing_frequency text NOT NULL CHECK (billing_frequency IN ('WEEKLY','MONTHLY','QUARTERLY','ANNUAL','PAID_IN_FULL')),
  payments integer CHECK (payments BETWEEN 1 AND 120),
  term_months integer CHECK (term_months BETWEEN 1 AND 60),
  down_payment_minor integer CHECK (down_payment_minor BETWEEN 1 AND 100000000),
  checkout_enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(plan_id,version,option_no),
  CHECK (billing_frequency<>'PAID_IN_FULL' OR (term_months IS NOT NULL AND payments IS NULL)),
  CHECK (billing_frequency<>'ANNUAL' OR term_months IS NULL OR term_months%12=0),
  CHECK (billing_frequency<>'QUARTERLY' OR term_months IS NULL OR term_months%3=0),
  CHECK (option_no<>1 OR billing_frequency<>'QUARTERLY'),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(plan_id,version) REFERENCES hon.membership_plan_version_setups(plan_id,version) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX membership_plan_payment_options_label_idx ON hon.membership_plan_payment_options(plan_id,version,lower(label));

ALTER TABLE hon.membership_plan_version_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_plan_version_setups FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_plan_payment_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_plan_payment_options FORCE ROW LEVEL SECURITY;

-- Setups and options are written once, beside their version, and never changed.
CREATE FUNCTION hon.guard_membership_plan_setup() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM hon.membership_plan_versions v WHERE v.plan_id=NEW.plan_id AND v.version=NEW.version
      AND v.organization_id=NEW.organization_id AND v.school_id=NEW.school_id) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PLAN_SETUP' USING ERRCODE='42501';
END $$;
CREATE TRIGGER membership_plan_setup_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.membership_plan_version_setups FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_plan_setup();
CREATE TRIGGER membership_plan_setup_no_truncate BEFORE TRUNCATE ON hon.membership_plan_version_setups FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_plan_setup();
CREATE TRIGGER membership_plan_payment_option_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.membership_plan_payment_options FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_plan_setup();
CREATE TRIGGER membership_plan_payment_option_no_truncate BEFORE TRUNCATE ON hon.membership_plan_payment_options FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_plan_setup();

-- Private: one bounded JSON integer, or null when absent/null and allowed.
CREATE FUNCTION hon.membership_plan_setup_int(v jsonb,lo integer,hi integer,nullable boolean) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF v IS NULL OR jsonb_typeof(v)='null' THEN
    IF nullable THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(v)<>'number' OR v::text !~ '^(0|[1-9][0-9]{0,8})$' OR v::text::bigint NOT BETWEEN lo AND hi THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  RETURN v::text::integer;
END $$;

-- Private closed validation of a setup: {classesPerWeek?, features?, paymentOptions}. Returns the normalized setup
-- with optionNo 1..n in the order given and every key present.
CREATE FUNCTION hon.membership_plan_validated_setup(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE features jsonb:='[]'::jsonb; options jsonb:='[]'::jsonb; o jsonb; f jsonb; n integer:=0; freq text; months integer; payments integer; label text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ? 'paymentOptions'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('classesPerWeek','features','paymentOptions'))
    OR jsonb_typeof(p->'paymentOptions') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'paymentOptions') NOT BETWEEN 1 AND 6
    OR (p ? 'features' AND (jsonb_typeof(p->'features')<>'array' OR jsonb_array_length(p->'features')>12)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p ? 'features' THEN
    FOR f IN SELECT value FROM jsonb_array_elements(p->'features') LOOP
      IF jsonb_typeof(f)<>'string' OR length(f#>>'{}') NOT BETWEEN 1 AND 120 OR btrim(f#>>'{}')<>f#>>'{}' OR f#>>'{}' ~ '[[:cntrl:]<>]' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
      features:=features||jsonb_build_array(f);
    END LOOP;
  END IF;
  FOR o IN SELECT value FROM jsonb_array_elements(p->'paymentOptions') WITH ORDINALITY x(value,i) ORDER BY i LOOP
    n:=n+1;
    IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR NOT o ?& ARRAY['label','priceMinor','billingFrequency','checkoutEnabled']
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(o) k WHERE k NOT IN ('label','priceMinor','billingFrequency','payments','termMonths','downPaymentMinor','checkoutEnabled'))
      OR jsonb_typeof(o->'label')<>'string' OR length(o->>'label') NOT BETWEEN 1 AND 80 OR btrim(o->>'label')<>o->>'label' OR o->>'label' ~ '[[:cntrl:]<>]'
      OR jsonb_typeof(o->'billingFrequency')<>'string' OR o->>'billingFrequency' NOT IN ('WEEKLY','MONTHLY','QUARTERLY','ANNUAL','PAID_IN_FULL')
      OR jsonb_typeof(o->'checkoutEnabled')<>'boolean' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    label:=o->>'label'; freq:=o->>'billingFrequency';
    months:=hon.membership_plan_setup_int(o->'termMonths',1,60,true);
    payments:=hon.membership_plan_setup_int(o->'payments',1,120,true);
    IF (freq='PAID_IN_FULL' AND (months IS NULL OR payments IS NOT NULL)) OR (freq='ANNUAL' AND months%12<>0) OR (freq='QUARTERLY' AND months%3<>0)
      OR (n=1 AND freq='QUARTERLY')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(options) x WHERE lower(x->>'label')=lower(label)) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    options:=options||jsonb_build_array(jsonb_build_object('optionNo',n,'label',label,'priceMinor',hon.membership_plan_setup_int(o->'priceMinor',0,100000000,false),
      'billingFrequency',freq,'payments',payments,'termMonths',months,'downPaymentMinor',hon.membership_plan_setup_int(o->'downPaymentMinor',1,100000000,true),
      'checkoutEnabled',(o->'checkoutEnabled')::boolean));
  END LOOP;
  RETURN jsonb_build_object('classesPerWeek',hon.membership_plan_setup_int(p->'classesPerWeek',1,14,true),'features',features,'paymentOptions',options);
END $$;

-- Private: the setup of one version. A version published without a setup (0175 commands) shows one derived option
-- made from its price; derived=true tells the screen it was never published with options.
CREATE FUNCTION hon.membership_plan_setup_summary(selected_plan uuid,selected_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN s.plan_id IS NULL THEN jsonb_build_object('planId',v.plan_id,'version',v.version,'derived',true,'classesPerWeek',NULL,'features','[]'::jsonb,
      'paymentOptions',jsonb_build_array(jsonb_build_object('optionNo',1,'label',NULL,'priceMinor',v.price_minor,'billingFrequency',v.billing_frequency,'payments',NULL,
        'termMonths',v.term_months,'downPaymentMinor',NULL,'checkoutEnabled',true)))
    ELSE jsonb_build_object('planId',v.plan_id,'version',v.version,'derived',false,'classesPerWeek',s.classes_per_week,'features',s.features,
      'paymentOptions',(SELECT jsonb_agg(jsonb_build_object('optionNo',o.option_no,'label',o.label,'priceMinor',o.price_minor,'billingFrequency',o.billing_frequency,
        'payments',o.payments,'termMonths',o.term_months,'downPaymentMinor',o.down_payment_minor,'checkoutEnabled',o.checkout_enabled) ORDER BY o.option_no)
        FROM hon.membership_plan_payment_options o WHERE o.plan_id=v.plan_id AND o.version=v.version)) END
  FROM hon.membership_plan_versions v LEFT JOIN hon.membership_plan_version_setups s ON s.plan_id=v.plan_id AND s.version=v.version
  WHERE v.plan_id=selected_plan AND v.version=selected_version AND v.organization_id=hon.current_organization_id() AND v.school_id=hon.current_school_id()
$$;

-- Private: the 0175 terms of a setup publish (option 1 is the version's price, frequency and term).
CREATE FUNCTION hon.membership_plan_setup_terms(p jsonb,setup jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (p-'paymentOptions'-'classesPerWeek'-'features'-'planCode'-'expectedVersion'-'confirmation')
    || jsonb_build_object('priceMinor',setup#>'{paymentOptions,0,priceMinor}','billingFrequency',setup#>'{paymentOptions,0,billingFrequency}',
      'termKind',CASE WHEN jsonb_typeof(setup#>'{paymentOptions,0,termMonths}')='number' THEN 'FIXED_MONTHS' ELSE 'OPEN_ENDED' END,
      'termMonths',setup#>'{paymentOptions,0,termMonths}')
$$;

-- Private: write the setup rows of a version published in this transaction.
CREATE FUNCTION hon.membership_plan_insert_setup(selected_plan uuid,selected_version integer,setup jsonb,actor uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); o jsonb;
BEGIN
  INSERT INTO hon.membership_plan_version_setups(plan_id,version,organization_id,school_id,classes_per_week,features,actor_principal_id)
    VALUES(selected_plan,selected_version,org,school,(setup->>'classesPerWeek')::integer,setup->'features',actor);
  FOR o IN SELECT value FROM jsonb_array_elements(setup->'paymentOptions') LOOP
    INSERT INTO hon.membership_plan_payment_options(plan_id,version,option_no,organization_id,school_id,label,price_minor,billing_frequency,payments,term_months,down_payment_minor,checkout_enabled)
      VALUES(selected_plan,selected_version,(o->>'optionNo')::integer,org,school,o->>'label',(o->>'priceMinor')::integer,o->>'billingFrequency',
        (o->>'payments')::integer,(o->>'termMonths')::integer,(o->>'downPaymentMinor')::integer,(o->>'checkoutEnabled')::boolean);
  END LOOP;
END $$;

-- Read: the setup of every plan's current version at the current school, for the 0175 catalog actor.
CREATE FUNCTION hon.read_school_membership_plan_setups(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
  PERFORM hon.require_membership_plan_manager(subject);
  SELECT jsonb_build_object('setups',coalesce((SELECT jsonb_agg(hon.membership_plan_setup_summary(h.id,h.current_version) ORDER BY h.plan_code)
    FROM hon.membership_plans h WHERE h.organization_id=org AND h.school_id=school),'[]'::jsonb)) INTO result;
  PERFORM hon.require_membership_plan_manager(subject);
  RETURN result;
END $$;

CREATE FUNCTION hon.create_school_membership_plan_with_options(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; terms jsonb; setup jsonb; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; plan hon.membership_plans%ROWTYPE; summary jsonb; body jsonb;
BEGIN
  actor:=hon.require_membership_plan_manager(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['planCode','confirmation']
    OR jsonb_typeof(p->'planCode') IS DISTINCT FROM 'string' OR p->>'planCode' !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE'
    OR p ?| ARRAY['priceMinor','billingFrequency','termKind','termMonths'] THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership_plan.create_with_options','input',p)::text,'UTF8')),'hex');
  -- Canonical lock order (0169/0175): key reservation, IAM SHARE, catalog tables, evidence last.
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE ROW EXCLUSIVE MODE;
  IF hon.require_membership_plan_manager(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body#>'{plan,planId}') IS DISTINCT FROM 'string'
      OR prior.response_body IS DISTINCT FROM jsonb_build_object('plan',hon.membership_plan_version_summary((prior.response_body#>>'{plan,planId}')::uuid,1),
        'setup',hon.membership_plan_setup_summary((prior.response_body#>>'{plan,planId}')::uuid,1)) THEN
      RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
    PERFORM hon.require_membership_plan_manager(subject);
    RETURN prior.response_body || jsonb_build_object('replayed',true);
  END IF;
  setup:=hon.membership_plan_validated_setup(jsonb_strip_nulls(jsonb_build_object('classesPerWeek',p->'classesPerWeek','features',p->'features','paymentOptions',p->'paymentOptions')));
  terms:=hon.membership_plan_validated_terms(hon.membership_plan_setup_terms(p,setup));
  IF EXISTS(SELECT 1 FROM hon.membership_plans x WHERE x.organization_id=org AND x.school_id=school AND x.plan_code=p->>'planCode') THEN
    RAISE EXCEPTION 'MEMBERSHIP_PLAN_CODE_TAKEN' USING ERRCODE='23505'; END IF;
  IF (SELECT count(*) FROM hon.membership_plans x WHERE x.organization_id=org AND x.school_id=school)>=200 THEN
    RAISE EXCEPTION 'MEMBERSHIP_PLAN_LIMIT' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.membership_plans(organization_id,school_id,plan_code,current_version,created_by_principal_id)
    VALUES(org,school,p->>'planCode',1,actor) RETURNING * INTO plan;
  INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,description,program_id,availability,currency,price_minor,billing_frequency,term_kind,term_months,actor_principal_id,created_at)
    VALUES(plan.id,1,org,school,terms->>'displayName',terms->>'description',(terms->>'programId')::uuid,terms->>'availability',terms->>'currency',(terms->>'priceMinor')::integer,
      terms->>'billingFrequency',terms->>'termKind',(terms->>'termMonths')::integer,actor,plan.created_at);
  PERFORM hon.membership_plan_insert_setup(plan.id,1,setup,actor);
  summary:=hon.membership_plan_version_summary(plan.id,1);
  body:=jsonb_build_object('plan',summary,'setup',hon.membership_plan_setup_summary(plan.id,1));
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership_plan.create','MEMBERSHIP_PLAN',plan.id,NULL,summary || jsonb_build_object('setup',body->'setup'),'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership_plan.published',1,'MEMBERSHIP_PLAN',plan.id,1,correlation,request,summary || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=body
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  IF summary IS NULL OR summary->>'planCode' IS DISTINCT FROM p->>'planCode' OR body#>'{setup,paymentOptions}' IS DISTINCT FROM setup->'paymentOptions'
    OR (body->'setup'->>'derived')::boolean THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.require_membership_plan_manager(subject);
  RETURN body || jsonb_build_object('replayed',false);
END $$;

-- A revision publishes a complete new set of terms and options as the next version. The caller names the version it
-- reviewed; a concurrent revision makes it stale. Sending the same terms and options again is refused as unchanged.
CREATE FUNCTION hon.revise_school_membership_plan_with_options(subject text,selected_plan uuid,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; terms jsonb; setup jsonb; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; plan hon.membership_plans%ROWTYPE; before_summary jsonb; before_setup jsonb; summary jsonb; body jsonb; next_version integer;
BEGIN
  actor:=hon.require_membership_plan_manager(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected_plan IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['expectedVersion','confirmation']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,5}$'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE'
    OR p ?| ARRAY['planCode','priceMinor','billingFrequency','termKind','termMonths'] THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership_plan.revise_with_options','planId',selected_plan,'input',p)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE ROW EXCLUSIVE MODE;
  IF hon.require_membership_plan_manager(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR prior.response_body#>>'{plan,planId}' IS DISTINCT FROM selected_plan::text
      OR prior.response_body#>>'{plan,version}' IS DISTINCT FROM ((p->>'expectedVersion')::integer+1)::text
      OR prior.response_body IS DISTINCT FROM jsonb_build_object('plan',hon.membership_plan_version_summary(selected_plan,(p->>'expectedVersion')::integer+1),
        'setup',hon.membership_plan_setup_summary(selected_plan,(p->>'expectedVersion')::integer+1)) THEN
      RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
    PERFORM hon.require_membership_plan_manager(subject);
    RETURN prior.response_body || jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO plan FROM hon.membership_plans x WHERE x.id=selected_plan AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF plan.current_version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_VERSION_STALE' USING ERRCODE='40001'; END IF;
  IF plan.current_version>=1000 THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_LIMIT' USING ERRCODE='54000'; END IF;
  setup:=hon.membership_plan_validated_setup(jsonb_strip_nulls(jsonb_build_object('classesPerWeek',p->'classesPerWeek','features',p->'features','paymentOptions',p->'paymentOptions')));
  terms:=hon.membership_plan_validated_terms(hon.membership_plan_setup_terms(p,setup));
  before_summary:=hon.membership_plan_version_summary(plan.id,plan.current_version);
  before_setup:=hon.membership_plan_setup_summary(plan.id,plan.current_version);
  IF terms=(before_summary-'planId'-'planCode'-'version'-'publishedAt') AND NOT (before_setup->>'derived')::boolean
    AND setup=(before_setup-'planId'-'version'-'derived') THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_UNCHANGED' USING ERRCODE='22023'; END IF;
  next_version:=plan.current_version+1;
  INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,description,program_id,availability,currency,price_minor,billing_frequency,term_kind,term_months,actor_principal_id)
    VALUES(plan.id,next_version,org,school,terms->>'displayName',terms->>'description',(terms->>'programId')::uuid,terms->>'availability',terms->>'currency',(terms->>'priceMinor')::integer,
      terms->>'billingFrequency',terms->>'termKind',(terms->>'termMonths')::integer,actor);
  PERFORM hon.membership_plan_insert_setup(plan.id,next_version,setup,actor);
  UPDATE hon.membership_plans SET current_version=next_version,updated_at=clock_timestamp() WHERE id=plan.id AND organization_id=org AND school_id=school;
  summary:=hon.membership_plan_version_summary(plan.id,next_version);
  body:=jsonb_build_object('plan',summary,'setup',hon.membership_plan_setup_summary(plan.id,next_version));
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership_plan.revise','MEMBERSHIP_PLAN',plan.id,before_summary || jsonb_build_object('setup',before_setup),
      summary || jsonb_build_object('setup',body->'setup'),'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership_plan.published',1,'MEMBERSHIP_PLAN',plan.id,next_version,correlation,request,summary || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=body
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  IF summary IS NULL OR (SELECT current_version FROM hon.membership_plans WHERE id=plan.id)<>next_version
    OR body#>'{setup,paymentOptions}' IS DISTINCT FROM setup->'paymentOptions' THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.require_membership_plan_manager(subject);
  RETURN body || jsonb_build_object('replayed',false);
END $$;

COMMENT ON FUNCTION hon.create_school_membership_plan_with_options(text,jsonb,uuid,uuid,uuid) IS
'Direct HUMAN_UI publish of one school membership plan with 1-6 payment options (option 1 = the 0175 price/frequency/term). Terms only: no schedule, invoice, payment, charge, provider, communication or AI effect.';
COMMENT ON FUNCTION hon.revise_school_membership_plan_with_options(text,uuid,jsonb,uuid,uuid,uuid) IS
'Direct HUMAN_UI publish of the next version of one school membership plan with its payment options. Existing memberships keep their version. No money effect.';

REVOKE ALL ON TABLE hon.membership_plan_version_setups,hon.membership_plan_payment_options FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_membership_plan_setup(),hon.membership_plan_setup_int(jsonb,integer,integer,boolean),hon.membership_plan_validated_setup(jsonb),
  hon.membership_plan_setup_summary(uuid,integer),hon.membership_plan_setup_terms(jsonb,jsonb),hon.membership_plan_insert_setup(uuid,integer,jsonb,uuid),
  hon.read_school_membership_plan_setups(text),hon.create_school_membership_plan_with_options(text,jsonb,uuid,uuid,uuid),
  hon.revise_school_membership_plan_with_options(text,uuid,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.membership_plan_version_setups,hon.membership_plan_payment_options FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_membership_plan_setup(),hon.membership_plan_setup_int(jsonb,integer,integer,boolean),hon.membership_plan_validated_setup(jsonb),
      hon.membership_plan_setup_summary(uuid,integer),hon.membership_plan_setup_terms(jsonb,jsonb),hon.membership_plan_insert_setup(uuid,integer,jsonb,uuid),
      hon.read_school_membership_plan_setups(text),hon.create_school_membership_plan_with_options(text,jsonb,uuid,uuid,uuid),
      hon.revise_school_membership_plan_with_options(text,uuid,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_membership_plan_setups(text),hon.create_school_membership_plan_with_options(text,jsonb,uuid,uuid,uuid),
      hon.revise_school_membership_plan_with_options(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
