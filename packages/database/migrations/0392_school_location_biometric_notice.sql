BEGIN;

-- School location and biometric jurisdiction notice (0392, coordinator-allocated 2026-11-16).
-- Owner request (David, 2026-11-16): face check-in must come with a notice and consent form made for the school's state or
-- country, and schools are told about it at onboarding from their address. Verified 2026-11-16: sign-up (0241) collected
-- no address and no table stored one. Spec: docs/architecture/FACE_CHECKIN.md.
--   L1  One location row per school (country, state/province, city, postal code, optional street) with an append-only
--       version history. New sign-ups give it in the same transaction as the account (register_hon_os_school_with_location,
--       which wraps the unchanged 0241 function); existing schools add it in Settings with school_location.manage (OWNER).
--   L2  Jurisdiction profiles are data: immutable rows mapping (country, region, city) to a profile, with the laws and the
--       local add-ons the notice must mention. The most specific rule wins. Unknown places are NOT_REVIEWED (unavailable);
--       no location is LOCATION_REQUIRED. Every profile is TEST_ONLY_DRAFT: a lawyer must review it before real use, and
--       changing it is a new reviewed migration.
--   L3  The notice is information only. Nothing here turns face check-in on, stores face data, or calls a provider.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'School location requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.register_hon_os_school(text,text,jsonb,uuid)') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.hon_os_registration_json(hon.hon_os_school_registrations)') IS NULL THEN
    RAISE EXCEPTION '0392 requires 0224, 0241 and the staff eligibility helper'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('school_location.manage','See and change the school''s address, which decides the local rules shown for features such as face check-in',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='school_location.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school_location.manage already exists with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'school_location.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' ON CONFLICT DO NOTHING;

-- ---------- L2: jurisdiction profiles and rules (immutable data) ----------
CREATE TABLE hon.biometric_jurisdiction_profiles (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  status text NOT NULL CHECK (status IN ('AVAILABLE_WITH_CONSENT','BLOCKED','NOT_REVIEWED')),
  laws text[] NOT NULL CHECK (cardinality(laws) BETWEEN 0 AND 6),
  add_ons text[] NOT NULL CHECK (cardinality(add_ons) BETWEEN 0 AND 8 AND add_ons <@ ARRAY['WRITTEN_RELEASE','PUBLIC_RETENTION_SCHEDULE',
    'PRIVATE_RIGHT_OF_ACTION','DESTROY_WITHIN_ONE_YEAR','HEALTH_DATA_CONSENT','SENSITIVE_DATA_NOTICE','NO_DENIAL_FOR_REFUSAL',
    'ENTRANCE_SIGN','IMPACT_ASSESSMENT','SEPARATE_CONSENT','RIGHT_TO_REFUSE_NOTICE','CITY_BAN']::text[]),
  review_status text NOT NULL CHECK (review_status='TEST_ONLY_DRAFT'),
  rules_version integer NOT NULL CHECK (rules_version=1),
  CHECK ((status='AVAILABLE_WITH_CONSENT') = (cardinality(laws)>0 AND NOT ('CITY_BAN'=ANY(add_ons)))),
  CHECK ((status='BLOCKED') = ('CITY_BAN'=ANY(add_ons)))
);
CREATE TABLE hon.biometric_jurisdiction_rules (
  id smallint PRIMARY KEY CHECK (id BETWEEN 1 AND 999),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  region_code text CHECK (region_code ~ '^[A-Z0-9]{1,3}$'),
  locality text CHECK (locality ~ '^[a-z][a-z .''-]{0,98}[a-z]$'),
  profile_code text NOT NULL REFERENCES hon.biometric_jurisdiction_profiles(code),
  CHECK (locality IS NULL OR region_code IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (country_code,region_code,locality)
);
INSERT INTO hon.biometric_jurisdiction_profiles(code,status,laws,add_ons,review_status,rules_version) VALUES
  ('US_IL_BIPA','AVAILABLE_WITH_CONSENT',ARRAY['Illinois Biometric Information Privacy Act (740 ILCS 14)'],
    ARRAY['WRITTEN_RELEASE','PUBLIC_RETENTION_SCHEDULE','PRIVATE_RIGHT_OF_ACTION'],'TEST_ONLY_DRAFT',1),
  ('US_TX_CUBI','AVAILABLE_WITH_CONSENT',ARRAY['Texas Capture or Use of Biometric Identifier Act (Bus. & Com. Code 503.001)'],
    ARRAY['DESTROY_WITHIN_ONE_YEAR'],'TEST_ONLY_DRAFT',1),
  ('US_WA_BIOMETRIC','AVAILABLE_WITH_CONSENT',ARRAY['Washington biometric identifiers law (RCW 19.375)','Washington My Health My Data Act (RCW 19.373)'],
    ARRAY['HEALTH_DATA_CONSENT'],'TEST_ONLY_DRAFT',1),
  ('US_CA_CCPA','AVAILABLE_WITH_CONSENT',ARRAY['California Consumer Privacy Act as amended by the CPRA'],
    ARRAY['SENSITIVE_DATA_NOTICE'],'TEST_ONLY_DRAFT',1),
  ('US_CO_CPA','AVAILABLE_WITH_CONSENT',ARRAY['Colorado Privacy Act biometric amendment (HB24-1130)'],
    ARRAY['PUBLIC_RETENTION_SCHEDULE','NO_DENIAL_FOR_REFUSAL'],'TEST_ONLY_DRAFT',1),
  ('US_NYC','AVAILABLE_WITH_CONSENT',ARRAY['New York City biometric identifier information law (Admin. Code 22-1201)'],
    ARRAY['ENTRANCE_SIGN'],'TEST_ONLY_DRAFT',1),
  ('US_PORTLAND_BAN','BLOCKED',ARRAY['City of Portland ban on private face recognition in places of public accommodation (Ordinance 190114)'],
    ARRAY['CITY_BAN'],'TEST_ONLY_DRAFT',1),
  ('US_GENERAL','AVAILABLE_WITH_CONSENT',ARRAY['State consumer privacy laws treating biometric data as sensitive','Children''s Online Privacy Protection Act (COPPA)'],
    ARRAY['SENSITIVE_DATA_NOTICE'],'TEST_ONLY_DRAFT',1),
  ('EU_GDPR','AVAILABLE_WITH_CONSENT',ARRAY['EU General Data Protection Regulation (Art. 9 and Art. 35)'],
    ARRAY['IMPACT_ASSESSMENT','RIGHT_TO_REFUSE_NOTICE'],'TEST_ONLY_DRAFT',1),
  ('UK_GDPR','AVAILABLE_WITH_CONSENT',ARRAY['UK GDPR and Data Protection Act 2018'],
    ARRAY['IMPACT_ASSESSMENT','RIGHT_TO_REFUSE_NOTICE'],'TEST_ONLY_DRAFT',1),
  ('KR_PIPA','AVAILABLE_WITH_CONSENT',ARRAY['Korea Personal Information Protection Act (Art. 22-2 and Art. 23)'],
    ARRAY['SEPARATE_CONSENT','RIGHT_TO_REFUSE_NOTICE'],'TEST_ONLY_DRAFT',1),
  ('NOT_REVIEWED','NOT_REVIEWED',ARRAY[]::text[],ARRAY[]::text[],'TEST_ONLY_DRAFT',1);
-- Rules: country default, then state, then city. EEA = 27 EU members + Iceland, Liechtenstein, Norway.
INSERT INTO hon.biometric_jurisdiction_rules(id,country_code,region_code,locality,profile_code) VALUES
  (1,'US',NULL,NULL,'US_GENERAL'),(2,'US','IL',NULL,'US_IL_BIPA'),(3,'US','TX',NULL,'US_TX_CUBI'),(4,'US','WA',NULL,'US_WA_BIOMETRIC'),
  (5,'US','CA',NULL,'US_CA_CCPA'),(6,'US','CO',NULL,'US_CO_CPA'),(7,'US','OR','portland','US_PORTLAND_BAN'),
  (8,'US','NY','new york','US_NYC'),(9,'US','NY','new york city','US_NYC'),(10,'US','NY','manhattan','US_NYC'),(11,'US','NY','brooklyn','US_NYC'),
  (12,'US','NY','bronx','US_NYC'),(13,'US','NY','the bronx','US_NYC'),(14,'US','NY','queens','US_NYC'),(15,'US','NY','staten island','US_NYC'),
  (16,'GB',NULL,NULL,'UK_GDPR'),(17,'KR',NULL,NULL,'KR_PIPA');
INSERT INTO hon.biometric_jurisdiction_rules(id,country_code,region_code,locality,profile_code)
SELECT 100+row_number() OVER (ORDER BY c),c,NULL,NULL,'EU_GDPR' FROM unnest(ARRAY['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE',
  'IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO']) c;

CREATE FUNCTION hon.guard_biometric_jurisdiction_data() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'BIOMETRIC_RULES_IMMUTABLE' USING ERRCODE='42501'; END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.biometric_jurisdiction_profiles FOR EACH ROW EXECUTE FUNCTION hon.guard_biometric_jurisdiction_data();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.biometric_jurisdiction_profiles FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_biometric_jurisdiction_data();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.biometric_jurisdiction_rules FOR EACH ROW EXECUTE FUNCTION hon.guard_biometric_jurisdiction_data();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.biometric_jurisdiction_rules FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_biometric_jurisdiction_data();

-- ---------- L1: school location ----------
-- US and Canada need a state or province code from the closed lists; elsewhere a region is optional.
CREATE FUNCTION hon.school_location_region_ok(country text,region text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE country
    WHEN 'US' THEN region = ANY(ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA',
      'MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
      'PR','GU','VI','AS','MP'])
    WHEN 'CA' THEN region = ANY(ARRAY['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'])
    ELSE region IS NULL OR region ~ '^[A-Z0-9]{1,3}$' END
$$;
CREATE FUNCTION hon.school_location_text_ok(v jsonb,max_len integer,required boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(CASE jsonb_typeof(v) WHEN 'null' THEN NOT required
    WHEN 'string' THEN length(v#>>'{}') BETWEEN 1 AND max_len AND btrim(v#>>'{}')=v#>>'{}' AND v#>>'{}' !~ '[[:cntrl:]<>]'
    ELSE false END,false)
$$;
-- The closed location shape the sign-up and settings commands take.
CREATE FUNCTION hon.school_location_input_ok(l jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(l)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(l) k)=ARRAY['addressLine1','addressLine2','city','country','postalCode','region']
    AND jsonb_typeof(l->'country')='string' AND l->>'country' ~ '^[A-Z]{2}$'
    AND (jsonb_typeof(l->'region')='null' OR (jsonb_typeof(l->'region')='string'))
    AND hon.school_location_region_ok(l->>'country',l->>'region')
    AND hon.school_location_text_ok(l->'city',100,true) AND hon.school_location_text_ok(l->'postalCode',20,false)
    AND hon.school_location_text_ok(l->'addressLine1',200,false) AND hon.school_location_text_ok(l->'addressLine2',200,false)
    AND (jsonb_typeof(l->'addressLine2')='null' OR jsonb_typeof(l->'addressLine1')='string'),false)
$$;

CREATE TABLE hon.school_locations (
  school_id uuid PRIMARY KEY, organization_id uuid NOT NULL,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  region_code text, city text NOT NULL, postal_code text, address_line1 text, address_line2 text,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id), updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK (hon.school_location_input_ok(jsonb_build_object('country',country_code,'region',region_code,'city',city,'postalCode',postal_code,
    'addressLine1',address_line1,'addressLine2',address_line2)))
);
CREATE TABLE hon.school_location_versions (
  school_id uuid NOT NULL REFERENCES hon.school_locations(school_id), version integer NOT NULL, organization_id uuid NOT NULL,
  location jsonb NOT NULL CHECK (hon.school_location_input_ok(location)),
  profile_code text NOT NULL REFERENCES hon.biometric_jurisdiction_profiles(code),
  source text NOT NULL CHECK (source IN ('SIGNUP','SETTINGS')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (school_id,version)
);
ALTER TABLE hon.school_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_locations FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_location_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_location_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.biometric_jurisdiction_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.biometric_jurisdiction_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.biometric_jurisdiction_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.biometric_jurisdiction_rules FORCE ROW LEVEL SECURITY;

-- Locations are never deleted; scope, creator and creation time never change; every update is the next version.
-- History rows are append-only.
CREATE FUNCTION hon.guard_school_location() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='TRUNCATE' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_LOCATION_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='school_location_versions' THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'SCHOOL_LOCATION_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'SCHOOL_LOCATION_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.school_id,NEW.organization_id,NEW.created_by_principal_id,NEW.created_at) IS DISTINCT FROM (OLD.school_id,OLD.organization_id,OLD.created_by_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'SCHOOL_LOCATION_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_locations FOR EACH ROW EXECUTE FUNCTION hon.guard_school_location();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_locations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_location();
CREATE TRIGGER guard BEFORE UPDATE OR DELETE ON hon.school_location_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_school_location();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_location_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_location();

-- City names are compared lower-case with single spaces and no trailing period (Portland, OR -> 'portland').
CREATE FUNCTION hon.biometric_locality(city text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT nullif(btrim(regexp_replace(regexp_replace(lower(coalesce(city,'')),'\s+',' ','g'),'\.$','')),'')
$$;
-- L2: the most specific rule wins (city, then state, then country); nothing matching is NOT_REVIEWED.
CREATE FUNCTION hon.biometric_profile_for(country text,region text,city text) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT r.profile_code FROM hon.biometric_jurisdiction_rules r
    WHERE r.country_code=country AND (r.region_code IS NULL OR r.region_code=region) AND (r.locality IS NULL OR r.locality=hon.biometric_locality(city))
    ORDER BY (r.locality IS NOT NULL) DESC,(r.region_code IS NOT NULL) DESC LIMIT 1),'NOT_REVIEWED')
$$;
-- The notice the school sees: which profile applies, whether face check-in can be offered there, the laws and local steps.
CREATE FUNCTION hon.biometric_notice_json(p_code text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN p_code IS NULL THEN jsonb_build_object('profile',NULL,'status','LOCATION_REQUIRED','laws','[]'::jsonb,'addOns','[]'::jsonb,
      'reviewStatus','TEST_ONLY_DRAFT','rulesVersion',1)
    ELSE (SELECT jsonb_build_object('profile',p.code,'status',p.status,'laws',to_jsonb(p.laws),'addOns',to_jsonb(p.add_ons),
      'reviewStatus',p.review_status,'rulesVersion',p.rules_version) FROM hon.biometric_jurisdiction_profiles p WHERE p.code=p_code) END
$$;
CREATE FUNCTION hon.school_location_json(l hon.school_locations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN l.school_id IS NULL THEN NULL ELSE jsonb_build_object('country',l.country_code,'region',l.region_code,'city',l.city,
    'postalCode',l.postal_code,'addressLine1',l.address_line1,'addressLine2',l.address_line2,'version',l.version,
    'updatedAt',to_char(l.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
$$;
CREATE FUNCTION hon.school_location_view(l hon.school_locations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('location',hon.school_location_json(l),'faceCheckInNotice',
    hon.biometric_notice_json(CASE WHEN l.school_id IS NULL THEN NULL ELSE hon.biometric_profile_for(l.country_code,l.region_code,l.city) END))
$$;

-- Live direct-human authority at the current school with school_location.manage. Same identity rules as 0285, but no
-- paid-access requirement: a newly registered school (no access yet) can still correct its own address.
CREATE FUNCTION hon.require_school_location_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 2048 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_LOCATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
        AND x.code='school_location.manage' AND x.is_staff_assignable);
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_LOCATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Writes one version (insert at 1 or the next version) and its history row; a settings save also writes the audit event
-- and an inert outbox event. Callers hold authority.
CREATE FUNCTION hon.school_location_write(p_org uuid,p_school uuid,p_actor uuid,p_location jsonb,p_expected integer,p_source text,
  p_request uuid,p_correlation uuid) RETURNS hon.school_locations
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE l hon.school_locations%ROWTYPE; before jsonb; profile text;
BEGIN
  IF NOT hon.school_location_input_ok(p_location) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM hon.schools s WHERE s.id=p_school AND s.organization_id=p_org FOR NO KEY UPDATE;
  SELECT * INTO l FROM hon.school_locations x WHERE x.school_id=p_school AND x.organization_id=p_org FOR UPDATE;
  IF FOUND THEN
    IF l.version<>p_expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    before:=hon.school_location_json(l);
    UPDATE hon.school_locations SET country_code=p_location->>'country',region_code=p_location->>'region',city=p_location->>'city',
      postal_code=p_location->>'postalCode',address_line1=p_location->>'addressLine1',address_line2=p_location->>'addressLine2',
      version=l.version+1,updated_by_principal_id=p_actor,updated_at=clock_timestamp() WHERE school_id=p_school RETURNING * INTO l;
  ELSE
    IF p_expected<>0 THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.school_locations(school_id,organization_id,country_code,region_code,city,postal_code,address_line1,address_line2,
        created_by_principal_id,updated_by_principal_id)
      VALUES (p_school,p_org,p_location->>'country',p_location->>'region',p_location->>'city',p_location->>'postalCode',
        p_location->>'addressLine1',p_location->>'addressLine2',p_actor,p_actor) RETURNING * INTO l;
  END IF;
  profile:=hon.biometric_profile_for(l.country_code,l.region_code,l.city);
  INSERT INTO hon.school_location_versions(school_id,version,organization_id,location,profile_code,source,actor_principal_id)
    VALUES (p_school,l.version,p_org,p_location,profile,p_source,p_actor);
  -- Sign-up keeps its 0241 shape (identity, school, grant and registration only): the version row is its evidence.
  IF p_source='SIGNUP' THEN RETURN l; END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES (p_org,p_school,p_actor,'HUMAN_UI','school_location.save','SCHOOL_LOCATION',p_school,before,
      hon.school_location_json(l)||jsonb_build_object('profile',profile),'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES (p_org,p_school,'school_location.saved',1,'SCHOOL_LOCATION',p_school,l.version,p_correlation,p_request,
      jsonb_build_object('schoolId',p_school,'version',l.version,'profile',profile));
  RETURN l;
END $$;

-- Staff read of the current school's location and its notice.
CREATE FUNCTION hon.read_school_location(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; l hon.school_locations%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_school_location_actor(subject);
  SELECT * INTO l FROM hon.school_locations x WHERE x.organization_id=org AND x.school_id=school;
  result:=hon.school_location_view(l);
  IF hon.require_school_location_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_LOCATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Save: create (expectedVersion 0) or replace the current school's location.
CREATE FUNCTION hon.save_school_location(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; l hon.school_locations%ROWTYPE; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','location']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT hon.school_location_input_ok(p->'location') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_location.save','input',p)::text,'UTF8')),'hex');
  actor:=hon.require_school_location_actor(subject);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools IN SHARE MODE;
  IF hon.require_school_location_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_LOCATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('receipt',prior.response_body,'replayed',true);
  END IF;
  l:=hon.school_location_write(org,school,actor,p->'location',(p->>'expectedVersion')::integer,'SETTINGS',request,correlation);
  result:=hon.school_location_view(l);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_location_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_LOCATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- L1: sign-up with the address, in one transaction. The unchanged 0241 function makes the account (all its checks, the
-- shared account envelope and idempotency); this records version 1 of the location for the new school. A replay of the
-- same key with the same address returns the same answer; with a different address it is refused as key reuse.
CREATE FUNCTION hon.register_hon_os_school_with_location(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE reg jsonb; r hon.hon_os_school_registrations%ROWTYPE; l hon.school_locations%ROWTYPE; first hon.school_location_versions%ROWTYPE; loc jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR NOT (p_input ? 'location') OR NOT hon.school_location_input_ok(p_input->'location') THEN
    RAISE EXCEPTION 'SIGNUP_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  loc:=p_input->'location';
  reg:=hon.register_hon_os_school(p_subject,p_verified_email,p_input-'location',p_key);
  SELECT * INTO r FROM hon.hon_os_school_registrations WHERE id=(reg->>'registrationId')::uuid AND subject=p_subject;
  IF NOT FOUND THEN RAISE EXCEPTION 'SIGNUP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO first FROM hon.school_location_versions v WHERE v.school_id=r.school_id AND v.version=1;
  IF FOUND THEN
    -- Replay: only the address this key first recorded.
    IF first.source<>'SIGNUP' OR first.location IS DISTINCT FROM loc THEN RAISE EXCEPTION 'SIGNUP_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO l FROM hon.school_locations x WHERE x.school_id=r.school_id;
  ELSE
    l:=hon.school_location_write(r.organization_id,r.school_id,r.owner_principal_id,loc,0,'SIGNUP',gen_random_uuid(),gen_random_uuid());
  END IF;
  RETURN jsonb_build_object('registration',reg)||hon.school_location_view(l);
END $$;

DO $$ DECLARE r text; t text; f text;
  entry text[]:=ARRAY['hon.read_school_location(text)','hon.save_school_location(text,jsonb,text,uuid,uuid)',
    'hon.register_hon_os_school_with_location(text,text,jsonb,uuid)'];
  helpers text[]:=ARRAY['hon.guard_biometric_jurisdiction_data()','hon.school_location_region_ok(text,text)','hon.school_location_text_ok(jsonb,integer,boolean)',
    'hon.school_location_input_ok(jsonb)','hon.guard_school_location()','hon.biometric_locality(text)','hon.biometric_profile_for(text,text,text)',
    'hon.biometric_notice_json(text)','hon.school_location_json(hon.school_locations)','hon.school_location_view(hon.school_locations)',
    'hon.require_school_location_actor(text)','hon.school_location_write(uuid,uuid,uuid,jsonb,integer,text,uuid,uuid)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['school_locations','school_location_versions','biometric_jurisdiction_profiles','biometric_jurisdiction_rules'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY helpers||entry LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;
COMMIT;
