BEGIN;
-- Operational allowances only. There is no purchase or financial state here.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'ClassPass requires trusted migration owner';
 END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive) VALUES
 ('classpass.manage','Direct human nonfinancial ClassPass configuration and grants',true),
 ('classpass.admit','Direct human capacity-safe ClassPass walk-in admission',true),
 ('classpass.reverse','Direct human bounded nonfinancial ClassPass reversals',true),
 ('classpass.read','Exact human staff ClassPass operational projection',false)
ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
WHERE r.is_system_role AND r.code IN('OWNER','ADMIN') AND p.code IN('classpass.manage','classpass.admit','classpass.reverse','classpass.read')
ON CONFLICT(role_id,permission_code) DO NOTHING;

CREATE TABLE hon.classpass_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 program_id uuid NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100 AND btrim(name)=name AND name !~ '[[:cntrl:]]'),
 allowed_uses integer NOT NULL CHECK(allowed_uses BETWEEN 1 AND 1000), validity_days integer NOT NULL CHECK(validity_days BETWEEN 1 AND 365),
 allowed_booking_policy text NOT NULL DEFAULT 'WALK_IN' CHECK(allowed_booking_policy='WALK_IN'),
 status text NOT NULL CHECK(status IN('ACTIVE','RETIRED')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,school_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.classpass_passes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 product_id uuid NOT NULL, student_profile_id uuid NOT NULL, program_id uuid NOT NULL,
 issuance_kind text NOT NULL CHECK(issuance_kind='MANUAL_NONFINANCIAL'),
 product_version integer NOT NULL CHECK(product_version>0), product_name text NOT NULL,
 allowed_uses integer NOT NULL CHECK(allowed_uses BETWEEN 1 AND 1000), validity_days integer NOT NULL CHECK(validity_days BETWEEN 1 AND 365),
 allowed_booking_policy text NOT NULL CHECK(allowed_booking_policy='WALK_IN'),
 program_version integer NOT NULL CHECK(program_version>0), program_name text NOT NULL,
 program_status text NOT NULL CHECK(program_status='SCHEDULED'), minimum_age_months integer, maximum_age_months integer,
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 issued_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 remaining_uses integer NOT NULL CHECK(remaining_uses BETWEEN 0 AND allowed_uses),
 status text NOT NULL CHECK(status IN('ACTIVE','EXHAUSTED','REVERSED')), version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at=issued_at+validity_days*interval '24 hours'),
 CHECK((status='ACTIVE' AND remaining_uses>0) OR (status IN('EXHAUSTED','REVERSED') AND remaining_uses=0)),
 UNIQUE(id,organization_id,school_id), UNIQUE(id,organization_id,school_id,student_profile_id),
 FOREIGN KEY(product_id,organization_id,school_id) REFERENCES hon.classpass_products(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.class_bookings DROP CONSTRAINT class_bookings_booking_kind_check;
ALTER TABLE hon.class_bookings ADD COLUMN classpass_id uuid;
ALTER TABLE hon.class_bookings ADD CONSTRAINT class_bookings_booking_kind_check CHECK(booking_kind IN('REGULAR','TRIAL','MAKEUP','PRIVATE_LESSON','EVENT','CLASS_PASS'));
ALTER TABLE hon.class_bookings ADD CONSTRAINT classpass_booking_link CHECK((booking_kind='CLASS_PASS')=(classpass_id IS NOT NULL));
ALTER TABLE hon.class_bookings ADD CONSTRAINT classpass_booking_student_fk FOREIGN KEY(classpass_id,organization_id,school_id,student_profile_id) REFERENCES hon.classpass_passes(id,organization_id,school_id,student_profile_id) ON DELETE RESTRICT;
ALTER TABLE hon.class_bookings ADD CONSTRAINT classpass_booking_ledger_key UNIQUE(id,organization_id,school_id,classpass_id);
CREATE TABLE hon.classpass_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL, pass_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('ISSUANCE','REDEMPTION','ISSUANCE_REVERSAL','REDEMPTION_REVERSAL')),
 use_delta integer NOT NULL, class_booking_id uuid, reverses_ledger_id uuid,
 pass_version integer NOT NULL CHECK(pass_version>0), reason text,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='ISSUANCE' AND use_delta BETWEEN 1 AND 1000 AND class_booking_id IS NULL AND reverses_ledger_id IS NULL)
  OR (kind='REDEMPTION' AND use_delta=-1 AND class_booking_id IS NOT NULL AND reverses_ledger_id IS NULL AND reason IS NULL)
  OR (kind='ISSUANCE_REVERSAL' AND use_delta BETWEEN -1000 AND -1 AND class_booking_id IS NULL AND reverses_ledger_id IS NOT NULL)
  OR (kind='REDEMPTION_REVERSAL' AND use_delta=1 AND class_booking_id IS NOT NULL AND reverses_ledger_id IS NOT NULL)),
 CHECK(kind='REDEMPTION' OR (reason IS NOT NULL AND length(reason) BETWEEN 1 AND 500 AND btrim(reason)=reason AND reason !~ '[[:cntrl:]]')),
 UNIQUE(id,organization_id,school_id,pass_id), UNIQUE(pass_id,pass_version),
 FOREIGN KEY(pass_id,organization_id,school_id) REFERENCES hon.classpass_passes(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(class_booking_id,organization_id,school_id,pass_id) REFERENCES hon.class_bookings(id,organization_id,school_id,classpass_id) ON DELETE RESTRICT,
 FOREIGN KEY(reverses_ledger_id,organization_id,school_id,pass_id) REFERENCES hon.classpass_ledger(id,organization_id,school_id,pass_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX classpass_one_issuance ON hon.classpass_ledger(pass_id) WHERE kind='ISSUANCE';
CREATE UNIQUE INDEX classpass_one_debit ON hon.classpass_ledger(class_booking_id) WHERE kind='REDEMPTION';
CREATE UNIQUE INDEX classpass_one_reversal ON hon.classpass_ledger(reverses_ledger_id) WHERE reverses_ledger_id IS NOT NULL;
ALTER TABLE hon.classpass_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.classpass_products FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.classpass_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.classpass_passes FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.classpass_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.classpass_ledger FORCE ROW LEVEL SECURITY;
-- No policies: runtime/client direct access is denied even if an ACL drifts.
CREATE TRIGGER classpass_ledger_immutable BEFORE UPDATE OR DELETE ON hon.classpass_ledger FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER classpass_ledger_no_truncate BEFORE TRUNCATE ON hon.classpass_ledger FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER classpass_passes_no_delete BEFORE DELETE ON hon.classpass_passes FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER classpass_passes_no_truncate BEFORE TRUNCATE ON hon.classpass_passes FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER classpass_products_no_delete BEFORE DELETE ON hon.classpass_products FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER classpass_products_no_truncate BEFORE TRUNCATE ON hon.classpass_products FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE FUNCTION hon.guard_classpass_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['remaining_uses','status','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['remaining_uses','status','version','updated_at'])
  OR NEW.version<>OLD.version+1 OR OLD.status='REVERSED' THEN RAISE EXCEPTION 'CLASSPASS_SNAPSHOT_IMMUTABLE' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER classpass_snapshot_immutable BEFORE UPDATE ON hon.classpass_passes FOR EACH ROW EXECUTE FUNCTION hon.guard_classpass_snapshot();
CREATE FUNCTION hon.guard_classpass_booking() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF (TG_OP<>'DELETE' AND NEW.booking_kind='CLASS_PASS') OR (TG_OP<>'INSERT' AND OLD.booking_kind='CLASS_PASS') THEN
  IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid)'::regprocedure)
   OR current_setting('app.hon_classpass_write',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'CLASSPASS_FUNCTION_REQUIRED' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['status','cancelled_at','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancelled_at','version','updated_at']) OR NEW.version<>OLD.version+1)) THEN
   RAISE EXCEPTION 'CLASSPASS_BOOKING_IMMUTABLE' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER classpass_booking_command_only BEFORE INSERT OR UPDATE OR DELETE ON hon.class_bookings FOR EACH ROW EXECUTE FUNCTION hon.guard_classpass_booking();

CREATE FUNCTION hon.lock_classpass_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
 IF p_permission IS NULL OR p_permission NOT IN('classpass.manage','classpass.admit','classpass.reverse','classpass.read')
  OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
  OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLASSPASS_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLASSPASS_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.users WHERE external_subject=p_subject FOR SHARE;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1 FOR SHARE OF p;
 IF actor IS NULL THEN RAISE EXCEPTION 'CLASSPASS_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.family_access_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.hq_operator_grants WHERE principal_id=actor FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 IF EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)
  OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND organization_id=org AND school_id=school AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
  OR NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
   WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=p_permission AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp()
   AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()) AND (r.management_school_id IS NULL OR r.management_school_id=school))
  OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN('ESSENTIAL','CORE','COMPLETE') AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN
  RAISE EXCEPTION 'CLASSPASS_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;

CREATE FUNCTION hon.read_classpass(p_subject text,p_kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
 PERFORM hon.lock_classpass_actor(p_subject,'classpass.read');
 IF p_kind='PRODUCT' THEN
  SELECT jsonb_build_object('id',id,'programId',program_id,'name',name,'allowedUses',allowed_uses,'validityDays',validity_days,'allowedBookingPolicy',allowed_booking_policy,'status',status,'version',version) INTO result
  FROM hon.classpass_products WHERE id=p_id AND organization_id=org AND school_id=school;
 ELSIF p_kind='PASS' THEN
  SELECT jsonb_build_object('id',id,'productId',product_id,'studentProfileId',student_profile_id,'programId',program_id,'issuanceKind',issuance_kind,'productVersion',product_version,'productName',product_name,
   'allowedUses',allowed_uses,'remainingUses',remaining_uses,'validityDays',validity_days,'allowedBookingPolicy',allowed_booking_policy,'programVersion',program_version,'programName',program_name,
   'minimumAgeMonths',minimum_age_months,'maximumAgeMonths',maximum_age_months,'issuedAt',issued_at,'expiresAt',expires_at,'status',status,'version',version,'expired',expires_at<=clock_timestamp(),
   'ledger',coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'kind',l.kind,'useDelta',l.use_delta,'classBookingId',l.class_booking_id,'reversesLedgerId',l.reverses_ledger_id,'passVersion',l.pass_version,'recordedAt',l.recorded_at) ORDER BY l.pass_version)
    FROM hon.classpass_ledger l WHERE l.pass_id=p.id AND l.organization_id=org AND l.school_id=school),'[]'::jsonb)) INTO result
  FROM hon.classpass_passes p WHERE id=p_id AND organization_id=org AND school_id=school;
 ELSIF p_kind='BOOKING' THEN
  SELECT jsonb_build_object('id',id,'classSessionId',class_session_id,'studentProfileId',student_profile_id,'passId',classpass_id,'bookingKind',booking_kind,'status',status,'version',version) INTO result
  FROM hon.class_bookings WHERE id=p_id AND organization_id=org AND school_id=school AND booking_kind='CLASS_PASS';
 ELSE RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'CLASSPASS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 RETURN result || jsonb_build_object('paymentProviderOutcome','UNAVAILABLE','attendanceOutcome','NOT_RECORDED_BY_CLASSPASS','parentProjection','UNAVAILABLE');
END $$;

CREATE FUNCTION hon.command_classpass(p_subject text,p_action text,p_target uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text; keys text[]; expected integer; reason text;
 product hon.classpass_products%ROWTYPE; pass hon.classpass_passes%ROWTYPE; session hon.class_sessions%ROWTYPE; program hon.programs%ROWTYPE; student hon.student_profiles%ROWTYPE;
 booking hon.class_bookings%ROWTYPE; debit hon.classpass_ledger%ROWTYPE; previous hon.idempotency_records%ROWTYPE;
 reservation uuid; fp text; result jsonb; prior jsonb; entity uuid; entity_type text; decision text; seats integer; months integer; instant timestamptz;
BEGIN
 permission:=CASE WHEN p_action IN('CONFIGURE_PRODUCT','RETIRE_PRODUCT','ISSUE') THEN 'classpass.manage' WHEN p_action='ADMIT' THEN 'classpass.admit' WHEN p_action IN('REVERSE_ISSUANCE','REVERSE_REDEMPTION') THEN 'classpass.reverse' END;
 keys:=CASE p_action WHEN 'CONFIGURE_PRODUCT' THEN ARRAY['expectedVersion','programId','name','allowedUses','validityDays','reason'] WHEN 'RETIRE_PRODUCT' THEN ARRAY['expectedVersion','reason']
  WHEN 'ISSUE' THEN ARRAY['expectedVersion','studentProfileId','issuanceKind','reason'] WHEN 'ADMIT' THEN ARRAY['expectedVersion','passId'] WHEN 'REVERSE_ISSUANCE' THEN ARRAY['expectedVersion','reason'] WHEN 'REVERSE_REDEMPTION' THEN ARRAY['expectedVersion','passId','reason'] END;
 IF permission IS NULL OR p_target IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>cardinality(keys) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE NOT k=ANY(keys))
  OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[0-9]{1,10}$' OR (p_input->>'expectedVersion')::numeric>2147483646
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' OR p_key ~ U&'[\0080-\009f]'
  OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) OR p_correlation::text IS DISTINCT FROM current_setting('app.hon_correlation_id',true) THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 expected:=(p_input->>'expectedVersion')::integer;
 IF p_action<>'CONFIGURE_PRODUCT' AND expected<1 THEN RAISE EXCEPTION 'VERSION_REQUIRED' USING ERRCODE='40001'; END IF;
 IF p_action<>'ADMIT' THEN
  reason:=p_input->>'reason';
  IF jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(reason) NOT BETWEEN 1 AND 500 OR btrim(reason)<>reason OR reason ~ '[[:cntrl:]]' OR reason ~ U&'[\0080-\009f]' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_action IN('ADMIT','REVERSE_REDEMPTION','ISSUE','CONFIGURE_PRODUCT') THEN
  IF jsonb_typeof(p_input->CASE WHEN p_action='ISSUE' THEN 'studentProfileId' WHEN p_action='CONFIGURE_PRODUCT' THEN 'programId' ELSE 'passId' END) IS DISTINCT FROM 'string'
   OR (p_input->>CASE WHEN p_action='ISSUE' THEN 'studentProfileId' WHEN p_action='CONFIGURE_PRODUCT' THEN 'programId' ELSE 'passId' END) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_action='ISSUE' AND (p_input->>'issuanceKind') IS DISTINCT FROM 'MANUAL_NONFINANCIAL' THEN RAISE EXCEPTION 'NONFINANCIAL_ONLY' USING ERRCODE='22023'; END IF;
 IF p_action='CONFIGURE_PRODUCT' AND (jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(p_input->>'name') NOT BETWEEN 1 AND 100 OR btrim(p_input->>'name')<>p_input->>'name' OR (p_input->>'name') ~ '[[:cntrl:]]'
  OR jsonb_typeof(p_input->'allowedUses') IS DISTINCT FROM 'number' OR (p_input->>'allowedUses') !~ '^[0-9]{1,4}$' OR (p_input->>'allowedUses')::integer NOT BETWEEN 1 AND 1000
  OR jsonb_typeof(p_input->'validityDays') IS DISTINCT FROM 'number' OR (p_input->>'validityDays') !~ '^[0-9]{1,3}$' OR (p_input->>'validityDays')::integer NOT BETWEEN 1 AND 365) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_classpass_actor(p_subject,permission);
 fp:=encode(sha256(convert_to(jsonb_build_object('command','classpass.v1','action',p_action,'target',p_target,'input',p_input)::text,'UTF8')),'hex');
 -- Global canonical idempotency namespace, followed by session -> pass -> booking.
 INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at) VALUES(org,school,actor,p_key,fp,'IN_PROGRESS',now()+interval '24 hours')
 ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id INTO reservation;
 IF reservation IS NULL THEN
  SELECT * INTO previous FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
  actor:=hon.lock_classpass_actor(p_subject,permission);
  IF previous.request_fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='40001'; END IF;
  IF previous.status='COMPLETED' AND previous.response_body IS NOT NULL THEN RETURN previous.response_body || jsonb_build_object('replayed',true); END IF;
  RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001';
 END IF;
 PERFORM set_config('app.hon_classpass_write','on',true);
 IF p_action IN('CONFIGURE_PRODUCT','RETIRE_PRODUCT','ISSUE') THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('classpass.product:'||p_target::text,0));
  SELECT * INTO product FROM hon.classpass_products WHERE id=p_target AND organization_id=org AND school_id=school FOR UPDATE;
  actor:=hon.lock_classpass_actor(p_subject,permission);
  IF p_action='CONFIGURE_PRODUCT' THEN
   IF (product.id IS NULL AND expected<>0) OR (product.id IS NOT NULL AND product.version<>expected) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   IF product.status='RETIRED' THEN RAISE EXCEPTION 'PRODUCT_RETIRED' USING ERRCODE='22023'; END IF;
   SELECT * INTO program FROM hon.programs WHERE id=(p_input->>'programId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
   IF program.id IS NULL OR program.status<>'SCHEDULED' THEN RAISE EXCEPTION 'PROGRAM_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
   prior:=CASE WHEN product.id IS NOT NULL THEN to_jsonb(product) END;
   IF product.id IS NULL THEN
    INSERT INTO hon.classpass_products(id,organization_id,school_id,program_id,name,allowed_uses,validity_days,status) VALUES(p_target,org,school,program.id,p_input->>'name',(p_input->>'allowedUses')::integer,(p_input->>'validityDays')::integer,'ACTIVE') RETURNING * INTO product;
   ELSE
    UPDATE hon.classpass_products SET program_id=program.id,name=p_input->>'name',allowed_uses=(p_input->>'allowedUses')::integer,validity_days=(p_input->>'validityDays')::integer,version=version+1,updated_at=now() WHERE id=product.id RETURNING * INTO product;
   END IF;
   entity:=product.id; entity_type:='CLASSPASS_PRODUCT'; result:=jsonb_build_object('id',product.id,'programId',product.program_id,'name',product.name,'allowedUses',product.allowed_uses,'validityDays',product.validity_days,'allowedBookingPolicy',product.allowed_booking_policy,'status',product.status,'version',product.version);
  ELSE
   IF product.id IS NULL THEN RAISE EXCEPTION 'CLASSPASS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
   IF product.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   IF product.status<>'ACTIVE' THEN RAISE EXCEPTION 'PRODUCT_RETIRED' USING ERRCODE='22023'; END IF;
   IF p_action='RETIRE_PRODUCT' THEN
    prior:=to_jsonb(product); UPDATE hon.classpass_products SET status='RETIRED',version=version+1,updated_at=now() WHERE id=product.id RETURNING * INTO product;
    entity:=product.id; entity_type:='CLASSPASS_PRODUCT'; result:=jsonb_build_object('id',product.id,'programId',product.program_id,'name',product.name,'allowedUses',product.allowed_uses,'validityDays',product.validity_days,'allowedBookingPolicy',product.allowed_booking_policy,'status',product.status,'version',product.version);
   ELSE
    SELECT * INTO program FROM hon.programs WHERE id=product.program_id AND organization_id=org AND school_id=school FOR SHARE;
    SELECT * INTO student FROM hon.student_profiles WHERE id=(p_input->>'studentProfileId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
    IF program.id IS NULL OR program.status<>'SCHEDULED' OR student.id IS NULL OR student.status<>'ACTIVE' THEN RAISE EXCEPTION 'ISSUANCE_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
    actor:=hon.lock_classpass_actor(p_subject,permission); instant:=clock_timestamp();
    INSERT INTO hon.classpass_passes(organization_id,school_id,product_id,student_profile_id,program_id,issuance_kind,product_version,product_name,allowed_uses,validity_days,allowed_booking_policy,program_version,program_name,program_status,minimum_age_months,maximum_age_months,issued_at,expires_at,issued_by_principal_id,remaining_uses,status)
    VALUES(org,school,product.id,student.id,program.id,'MANUAL_NONFINANCIAL',product.version,product.name,product.allowed_uses,product.validity_days,product.allowed_booking_policy,program.version,program.name,program.status::text,program.minimum_age_months,program.maximum_age_months,instant,instant+product.validity_days*interval '24 hours',actor,product.allowed_uses,'ACTIVE') RETURNING * INTO pass;
    INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,pass_version,reason,actor_principal_id,request_id) VALUES(org,school,pass.id,'ISSUANCE',pass.allowed_uses,1,reason,actor,p_request);
    entity:=pass.id; entity_type:='CLASSPASS_PASS'; result:=jsonb_build_object('id',pass.id,'productId',pass.product_id,'studentProfileId',pass.student_profile_id,'programId',pass.program_id,'issuanceKind',pass.issuance_kind,'allowedUses',pass.allowed_uses,'remainingUses',pass.remaining_uses,'expiresAt',pass.expires_at,'status',pass.status,'version',pass.version);
   END IF;
  END IF;
 ELSE
  IF p_action='ADMIT' THEN
   SELECT * INTO session FROM hon.class_sessions WHERE id=p_target AND organization_id=org AND school_id=school FOR UPDATE;
  ELSIF p_action='REVERSE_REDEMPTION' THEN
   -- Only a nonlocking exact lookup is needed to derive the session lock first.
   SELECT s.* INTO session FROM hon.class_sessions s JOIN hon.class_bookings b ON b.class_session_id=s.id AND b.organization_id=s.organization_id AND b.school_id=s.school_id
   WHERE b.id=p_target AND b.organization_id=org AND b.school_id=school AND b.booking_kind='CLASS_PASS';
   IF session.id IS NOT NULL THEN SELECT * INTO session FROM hon.class_sessions WHERE id=session.id AND organization_id=org AND school_id=school FOR UPDATE; END IF;
  END IF;
  IF p_action<>'REVERSE_ISSUANCE' AND session.id IS NULL THEN RAISE EXCEPTION 'CLASSPASS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO pass FROM hon.classpass_passes WHERE id=CASE WHEN p_action='REVERSE_ISSUANCE' THEN p_target ELSE (p_input->>'passId')::uuid END AND organization_id=org AND school_id=school FOR UPDATE;
  actor:=hon.lock_classpass_actor(p_subject,permission);
  IF pass.id IS NULL THEN RAISE EXCEPTION 'CLASSPASS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF pass.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF pass.issuance_kind<>'MANUAL_NONFINANCIAL' OR pass.status='REVERSED' OR pass.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PASS_NOT_REDEEMABLE' USING ERRCODE='22023'; END IF;
  prior:=jsonb_build_object('passId',pass.id,'remainingUses',pass.remaining_uses,'status',pass.status,'version',pass.version);
  entity:=pass.id; entity_type:='CLASSPASS_PASS';
  IF p_action='REVERSE_ISSUANCE' THEN
   IF pass.status<>'ACTIVE' OR pass.remaining_uses<>pass.allowed_uses OR EXISTS(SELECT 1 FROM hon.classpass_ledger WHERE pass_id=pass.id AND kind<>'ISSUANCE')
    OR EXISTS(SELECT 1 FROM hon.class_bookings WHERE classpass_id=pass.id AND status<>'CANCELLED') THEN RAISE EXCEPTION 'ISSUANCE_REVERSAL_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
   SELECT * INTO debit FROM hon.classpass_ledger WHERE pass_id=pass.id AND kind='ISSUANCE';
   IF debit.id IS NULL OR debit.use_delta<>pass.allowed_uses THEN RAISE EXCEPTION 'PASS_LEDGER_AMBIGUOUS' USING ERRCODE='22023'; END IF;
   UPDATE hon.classpass_passes SET status='REVERSED',remaining_uses=0,version=version+1,updated_at=now() WHERE id=pass.id RETURNING * INTO pass;
   INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,reverses_ledger_id,pass_version,reason,actor_principal_id,request_id) VALUES(org,school,pass.id,'ISSUANCE_REVERSAL',-pass.allowed_uses,debit.id,pass.version,reason,actor,p_request);
   decision:='ISSUANCE_REVERSED';
  ELSE
   SELECT * INTO booking FROM hon.class_bookings WHERE organization_id=org AND school_id=school AND class_session_id=session.id AND student_profile_id=pass.student_profile_id FOR UPDATE;
   SELECT * INTO program FROM hon.programs WHERE id=session.program_id AND organization_id=org AND school_id=school FOR SHARE;
   SELECT * INTO student FROM hon.student_profiles WHERE id=pass.student_profile_id AND organization_id=org AND school_id=school FOR SHARE;
   actor:=hon.lock_classpass_actor(p_subject,permission); instant:=clock_timestamp();
   IF pass.expires_at<=instant OR session.status<>'SCHEDULED' OR session.booking_policy<>'WALK_IN' OR session.program_id<>pass.program_id OR program.id IS NULL OR program.status<>'SCHEDULED' OR student.id IS NULL OR student.status<>'ACTIVE' THEN RAISE EXCEPTION 'ADMISSION_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
   IF booking.id IS NOT NULL AND (booking.booking_kind<>'CLASS_PASS' OR booking.classpass_id<>pass.id) THEN RAISE EXCEPTION 'BOOKING_ALREADY_EXISTS' USING ERRCODE='40001'; END IF;
   SELECT * INTO debit FROM hon.classpass_ledger WHERE pass_id=pass.id AND class_booking_id=booking.id AND kind='REDEMPTION';
   IF p_action='REVERSE_REDEMPTION' THEN
    IF booking.id IS DISTINCT FROM p_target OR booking.status<>'BOOKED' OR instant>=session.starts_at
     OR EXISTS(SELECT 1 FROM hon.attendance_records WHERE organization_id=org AND school_id=school AND class_session_id=session.id AND student_profile_id=pass.student_profile_id)
     OR debit.id IS NULL OR EXISTS(SELECT 1 FROM hon.classpass_ledger WHERE reverses_ledger_id=debit.id) OR pass.remaining_uses>=pass.allowed_uses THEN RAISE EXCEPTION 'REDEMPTION_REVERSAL_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
    UPDATE hon.class_bookings SET status='CANCELLED',cancelled_at=instant,version=version+1,updated_at=now() WHERE id=booking.id RETURNING * INTO booking;
    UPDATE hon.classpass_passes SET status='ACTIVE',remaining_uses=remaining_uses+1,version=version+1,updated_at=now() WHERE id=pass.id RETURNING * INTO pass;
    INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,class_booking_id,reverses_ledger_id,pass_version,reason,actor_principal_id,request_id) VALUES(org,school,pass.id,'REDEMPTION_REVERSAL',1,booking.id,debit.id,pass.version,reason,actor,p_request);
    decision:='REDEMPTION_REVERSED';
   ELSE
    IF instant<session.starts_at-interval '2 hours' OR instant>=session.ends_at OR pass.expires_at<=session.starts_at THEN RAISE EXCEPTION 'ADMISSION_WINDOW_CLOSED' USING ERRCODE='22023'; END IF;
    IF program.minimum_age_months IS NOT NULL OR program.maximum_age_months IS NOT NULL OR pass.minimum_age_months IS NOT NULL OR pass.maximum_age_months IS NOT NULL THEN
     IF student.birth_date IS NULL OR student.birth_date>session.starts_at::date THEN RAISE EXCEPTION 'AGE_EVIDENCE_REQUIRED' USING ERRCODE='22023'; END IF;
     months:=extract(year FROM age(session.starts_at::date,student.birth_date))::integer*12+extract(month FROM age(session.starts_at::date,student.birth_date))::integer;
     IF months<greatest(coalesce(program.minimum_age_months,0),coalesce(pass.minimum_age_months,0)) OR months>least(coalesce(program.maximum_age_months,2147483647),coalesce(pass.maximum_age_months,2147483647)) THEN RAISE EXCEPTION 'PROGRAM_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
    END IF;
    IF booking.id IS NOT NULL AND booking.status='BOOKED' THEN
     IF debit.id IS NULL OR EXISTS(SELECT 1 FROM hon.classpass_ledger WHERE reverses_ledger_id=debit.id) THEN RAISE EXCEPTION 'PASS_LEDGER_AMBIGUOUS' USING ERRCODE='22023'; END IF;
     decision:='ADMITTED_REDEEMED';
    ELSE
     IF pass.status<>'ACTIVE' OR pass.remaining_uses<1 OR (booking.id IS NOT NULL AND booking.status<>'WAITLISTED') OR debit.id IS NOT NULL THEN RAISE EXCEPTION 'PASS_NOT_REDEEMABLE' USING ERRCODE='22023'; END IF;
     SELECT count(*)::integer INTO seats FROM hon.class_bookings WHERE organization_id=org AND school_id=school AND class_session_id=session.id AND status IN('BOOKED','CHECKED_IN');
     IF booking.id IS NULL THEN
      INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,classpass_id,status,source) VALUES(org,school,session.id,pass.student_profile_id,'CLASS_PASS',pass.id,CASE WHEN seats<session.capacity THEN 'BOOKED'::hon.class_booking_status ELSE 'WAITLISTED'::hon.class_booking_status END,'STAFF') RETURNING * INTO booking;
     ELSIF seats<session.capacity THEN
      UPDATE hon.class_bookings SET status='BOOKED',version=version+1,updated_at=now() WHERE id=booking.id RETURNING * INTO booking;
     END IF;
     IF booking.status='BOOKED' THEN
      UPDATE hon.classpass_passes SET remaining_uses=remaining_uses-1,status=CASE WHEN remaining_uses=1 THEN 'EXHAUSTED' ELSE 'ACTIVE' END,version=version+1,updated_at=now() WHERE id=pass.id RETURNING * INTO pass;
      INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,class_booking_id,pass_version,actor_principal_id,request_id) VALUES(org,school,pass.id,'REDEMPTION',-1,booking.id,pass.version,actor,p_request);
      decision:='ADMITTED_REDEEMED';
     ELSE decision:='WAITLISTED_NOT_REDEEMED'; END IF;
    END IF;
   END IF;
  END IF;
  result:=jsonb_build_object('id',pass.id,'passId',pass.id,'studentProfileId',pass.student_profile_id,'remainingUses',pass.remaining_uses,'status',pass.status,'version',pass.version,'decision',decision,
   'booking',CASE WHEN booking.id IS NOT NULL THEN jsonb_build_object('id',booking.id,'classSessionId',booking.class_session_id,'passId',booking.classpass_id,'bookingKind',booking.booking_kind,'status',booking.status,'version',booking.version) ELSE NULL END);
 END IF;
 actor:=hon.lock_classpass_actor(p_subject,permission);
 result:=result || jsonb_build_object('paymentProviderOutcome','UNAVAILABLE','attendanceOutcome','NOT_RECORDED_BY_CLASSPASS','externalEffects','NONE');
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id) VALUES(org,school,actor,'HUMAN_UI','classpass.'||lower(p_action),entity_type,entity,prior,result,'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload) VALUES(gen_random_uuid(),org,school,'classpass.operational',1,entity_type,entity,(result->>'version')::integer,p_correlation,p_request,result);
 UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result WHERE id=reservation;
 PERFORM set_config('app.hon_classpass_write','',true);
 RETURN result || jsonb_build_object('replayed',false);
END $$;

REVOKE ALL ON hon.classpass_products,hon.classpass_passes,hon.classpass_ledger FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_classpass_snapshot(),hon.guard_classpass_booking(),hon.lock_classpass_actor(text,text),hon.read_classpass(text,text,uuid),hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON hon.classpass_products,hon.classpass_passes,hon.classpass_ledger FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_classpass_snapshot(),hon.guard_classpass_booking(),hon.lock_classpass_actor(text,text),hon.read_classpass(text,text,uuid),hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_classpass(text,text,uuid),hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
