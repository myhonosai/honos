BEGIN;

-- Family referrals (0604, assigned by the coordinator 2026-11-20; docs/architecture/FAMILY_REFERRALS.md).
-- Owner ask (2026-11-20): a referral section in the HON Family app with a link to send to contacts, how many they referred,
-- what reward they get, linked to the school CRM. This is the school's own family referral program, not HON Champions Club.
--   F1  The reward is the school's own words. Recording a reward decision moves no money, invoice, tuition or HON credit.
--   F2  Family scope only from the verified session (one current family, 0530 path) with a live entitlement; issuing a
--       link needs a GUARDIAN grant. No school or family selector.
--   F3  One code per (school, family): 16 lowercase hex characters (64 bits from two random UUIDs). Issuing again returns the same code.
--   F4  A link works only while the program is ON, its form is PUBLISHED and publicly readable (0075 read_published_form),
--       and the family is ACTIVE with a live grant at the school. Every other case answers the same "not available".
--   F5  The friend's submission goes through hon.submit_public_form UNCHANGED. A referral is recorded only for a lead that
--       this same transaction created (first touch); replays and submissions folded into an existing lead record nothing.
--   F6  SELF (contact matches a person or guardian of the referring family) and EXISTING_CONTACT (another person of the
--       school has that contact) flags for staff. SELF referrals are not shown or counted for the family.
--   F7  Per-code public limit: 30 attempts an hour, in 0075's rate table, taken after 0075's org -> school -> form locks.
--   F8  Family status from the lead: OPEN interested, WON joined, LOST/ARCHIVED not joined. No friend name or contact
--       ever reaches the family.
--   F9  Staff permissions crm.referral.read / crm.referral.manage (system OWNER roles). Versioned, idempotent per actor
--       and key, audited, outbox internalOnly.
-- No runtime table privilege: every entry point is SECURITY DEFINER.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Family referrals require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Family referrals require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.submit_public_form(text,jsonb,text)') IS NULL OR to_regprocedure('hon.read_published_form(text)') IS NULL
    OR to_regprocedure('hon.validate_public_form_submission(jsonb,jsonb)') IS NULL OR to_regprocedure('hon.take_public_form_rate(uuid,text,integer)') IS NULL
    OR to_regprocedure('hon.resolve_parent_journey_scopes(text)') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Family referrals require 0075, 0077, 0087 and 0177';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('crm.referral.read','See the school family referral program and the referrals families made',true,true),
  ('crm.referral.manage','Change the school family referral program and record referral reward decisions (no money moves)',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
  WHERE r.is_system_role AND r.code='OWNER' AND p.code IN ('crm.referral.read','crm.referral.manage') ON CONFLICT DO NOTHING;

-- Code-owned recorder of referral intake. No user, role, HQ, family or delegated authority.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000604','SYSTEM_SERVICE','Code-owned family referral intake');

CREATE TABLE hon.school_referral_programs (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 999999999),
  status text NOT NULL CHECK (status IN ('ON','OFF')),
  form_id uuid,
  referrer_reward text NOT NULL CHECK (length(referrer_reward)<=200),
  friend_offer text NOT NULL CHECK (length(friend_offer)<=200),
  rules text NOT NULL CHECK (length(rules)<=500),
  share_message text NOT NULL CHECK (length(share_message)<=280),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status='OFF' OR (form_id IS NOT NULL AND length(referrer_reward)>=1)),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (form_id,organization_id,school_id) REFERENCES hon.public_lead_forms(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.school_referral_program_versions (
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  version integer NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (school_id,version),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE hon.school_referral_requests (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,100}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE hon.family_referral_codes (
  code text PRIMARY KEY CHECK (code ~ '^[0-9a-f]{16}$'),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  issued_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (school_id,family_id),
  FOREIGN KEY (family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.family_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  code text NOT NULL REFERENCES hon.family_referral_codes(code) ON DELETE RESTRICT,
  lead_id uuid NOT NULL UNIQUE,
  self_referral boolean NOT NULL,
  existing_contact boolean NOT NULL,
  reward_status text NOT NULL DEFAULT 'PENDING' CHECK (reward_status IN ('PENDING','GIVEN','NOT_ELIGIBLE')),
  reward_note text NOT NULL DEFAULT '' CHECK (length(reward_note)<=300),
  reward_decided_at timestamptz,
  reward_decided_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((reward_status='PENDING')=(reward_decided_at IS NULL) AND (reward_decided_at IS NULL)=(reward_decided_by_principal_id IS NULL)),
  FOREIGN KEY (family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX family_referrals_family ON hon.family_referrals(family_id,created_at DESC);
CREATE INDEX family_referrals_school ON hon.family_referrals(school_id,created_at DESC,id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_referral_programs','school_referral_program_versions','school_referral_requests','family_referral_codes','family_referrals'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence()',t||'_no_truncate',t);
  END LOOP;
END $$;

-- History, requests and codes never change or disappear. A referral never changes who referred whom; only its reward
-- decision moves, with the version moving on by one. Programs are never deleted.
CREATE FUNCTION hon.guard_family_referral_rows() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FAMILY_REFERRAL_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME IN ('school_referral_program_versions','school_referral_requests','family_referral_codes') THEN
    RAISE EXCEPTION 'FAMILY_REFERRAL_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='school_referral_programs' THEN
    IF NEW.school_id<>OLD.school_id OR NEW.organization_id<>OLD.organization_id OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'FAMILY_REFERRAL_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.family_id<>OLD.family_id
    OR NEW.code<>OLD.code OR NEW.lead_id<>OLD.lead_id OR NEW.self_referral<>OLD.self_referral OR NEW.existing_contact<>OLD.existing_contact
    OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'FAMILY_REFERRAL_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_referral_programs','school_referral_program_versions','school_referral_requests','family_referral_codes','family_referrals'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_family_referral_rows()',t||'_guard',t);
  END LOOP;
END $$;

-- F9 staff actor: the direct human subject of the tenant session, an eligible staff member of this school whose live
-- role holds the permission, with a live entitlement. Family, HQ and family-like roles never qualify.
CREATE FUNCTION hon.require_school_referral_actor(subject text, permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission NOT IN ('crm.referral.read','crm.referral.manage')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_REFERRAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_REFERRAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_referral_program_json(org uuid, school uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT jsonb_build_object('version',p.version,'status',p.status,'formId',p.form_id,'referrerReward',p.referrer_reward,
      'friendOffer',p.friend_offer,'rules',p.rules,'shareMessage',p.share_message,'updatedAt',p.updated_at)
    FROM hon.school_referral_programs p WHERE p.school_id=school AND p.organization_id=org),
    jsonb_build_object('version',0,'status','OFF','formId',NULL,'referrerReward','','friendOffer','','rules','','shareMessage','','updatedAt',NULL));
$$;

-- A stored name as one safe display line: control and invisible formatting characters become spaces, runs of space
-- collapse, and it is cut to the cap. Names are kept elsewhere unchanged; this only shapes what staff see.
CREATE FUNCTION hon.family_referral_display(v text, cap integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT left(btrim(regexp_replace(regexp_replace(coalesce(v,''),'[[:cntrl:]\u0080-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]',' ','g'),'\s+',' ','g')),cap);
$$;

CREATE FUNCTION hon.family_referral_staff_json(r hon.family_referrals) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('referralId',r.id,'version',r.version,
    'familyName',hon.family_referral_display((SELECT f.display_name FROM hon.families f WHERE f.id=r.family_id),200),
    'friendName',hon.family_referral_display((SELECT concat_ws(' ',nullif(pe.given_name,''),nullif(pe.family_name,'')) FROM hon.crm_leads l JOIN hon.people pe ON pe.id=l.primary_person_id WHERE l.id=r.lead_id),300),
    'leadId',r.lead_id,'leadStatus',(SELECT l.status::text FROM hon.crm_leads l WHERE l.id=r.lead_id),
    'selfReferral',r.self_referral,'existingContact',r.existing_contact,'rewardStatus',r.reward_status,'rewardNote',r.reward_note,
    'rewardDecidedAt',r.reward_decided_at,'createdAt',r.created_at);
$$;

-- F9 staff read: the program, the school's published forms to choose from, and the latest 200 referrals.
CREATE FUNCTION hon.read_school_referrals(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); forms jsonb; items jsonb; counts jsonb;
BEGIN
  actor:=hon.require_school_referral_actor(subject,'crm.referral.read');
  SELECT coalesce(jsonb_agg(jsonb_build_object('formId',f.id,'title',f.title,'status',f.status) ORDER BY lower(f.title),f.id),'[]'::jsonb) INTO forms
    FROM (SELECT k.* FROM hon.public_lead_forms k WHERE k.organization_id=org AND k.school_id=school AND (k.status='PUBLISHED'
      OR k.id IS NOT DISTINCT FROM (SELECT p.form_id FROM hon.school_referral_programs p WHERE p.school_id=school AND p.organization_id=org))
      ORDER BY k.id IS DISTINCT FROM (SELECT p.form_id FROM hon.school_referral_programs p WHERE p.school_id=school AND p.organization_id=org),
        lower(k.title),k.id LIMIT 100) f;
  SELECT coalesce(jsonb_agg(hon.family_referral_staff_json(r) ORDER BY r.created_at DESC,r.id),'[]'::jsonb) INTO items
    FROM (SELECT * FROM hon.family_referrals k WHERE k.organization_id=org AND k.school_id=school ORDER BY k.created_at DESC,k.id LIMIT 200) r;
  SELECT jsonb_build_object('referred',count(*) FILTER (WHERE NOT r.self_referral),
      'joined',count(*) FILTER (WHERE NOT r.self_referral AND l.status='WON'),
      'rewarded',count(*) FILTER (WHERE NOT r.self_referral AND r.reward_status='GIVEN'),
      'awaitingDecision',count(*) FILTER (WHERE NOT r.self_referral AND r.reward_status='PENDING' AND l.status='WON')) INTO counts
    FROM hon.family_referrals r JOIN hon.crm_leads l ON l.id=r.lead_id WHERE r.organization_id=org AND r.school_id=school;
  IF hon.require_school_referral_actor(subject,'crm.referral.read') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_REFERRAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('program',hon.school_referral_program_json(org,school),'forms',forms,'counts',counts,'referrals',items,
    'canManage',EXISTS(SELECT 1 WHERE hon.principal_has_school_permission(actor,org,school,'crm.referral.manage')));
END $$;

-- One display text: trimmed, single line unless multiline, no control or invisible formatting characters.
CREATE FUNCTION hon.family_referral_text(v jsonb, cap integer, required boolean, multiline boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE t text;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  t:=v#>>'{}';
  IF length(t)>cap OR (required AND length(t)=0)
    OR regexp_replace(t,'^[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+|[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+$','','g')<>t
    OR (NOT multiline AND t ~ '[\n\r]')
    OR regexp_replace(t,'[\n]','','g') ~ '[[:cntrl:]\u0080-\u009F\u2028-\u2029\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  RETURN t;
END $$;

CREATE FUNCTION hon.school_referral_begin(actor uuid, key text, fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prev hon.school_referral_requests%ROWTYPE;
BEGIN
  IF key IS NULL OR key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO prev FROM hon.school_referral_requests WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
    AND principal_id=actor AND idempotency_key=key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prev.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN prev.response||jsonb_build_object('replayed',true);
END $$;

-- F9: turn the program on or off and set its texts and form, at the exact version the staff member saw.
CREATE FUNCTION hon.configure_school_referral_program(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prev jsonb; cur hon.school_referral_programs%ROWTYPE;
  expected integer; st text; form uuid; reward text; offer text; rules_t text; share text; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>4096
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','status','formId','referrerReward','friendOffer','rules','shareMessage'))
    OR (SELECT count(*) FROM jsonb_object_keys(p))<>7
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::bigint>999999998
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ON','OFF')
    OR (p->'formId'<>'null'::jsonb AND (jsonb_typeof(p->'formId') IS DISTINCT FROM 'string' OR (p->>'formId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  expected:=(p->>'expectedVersion')::integer; st:=p->>'status'; form:=(p->>'formId')::uuid;
  reward:=hon.family_referral_text(p->'referrerReward',200,st='ON',false);
  offer:=hon.family_referral_text(p->'friendOffer',200,false,false);
  rules_t:=hon.family_referral_text(p->'rules',500,false,true);
  share:=hon.family_referral_text(p->'shareMessage',280,false,true);
  IF st='ON' AND form IS NULL THEN RAISE EXCEPTION 'REFERRAL_FORM_REQUIRED' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR SHARE;
  PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR SHARE;
  actor:=hon.require_school_referral_actor(subject,'crm.referral.manage');
  fp:=encode(sha256(convert_to(jsonb_build_object('op','configure','input',p)::text,'UTF8')),'hex');
  prev:=hon.school_referral_begin(actor,key,fp);
  IF prev IS NOT NULL THEN RETURN prev; END IF;
  SELECT * INTO cur FROM hon.school_referral_programs WHERE school_id=school AND organization_id=org FOR UPDATE;
  IF coalesce(cur.version,0)<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF form IS NOT NULL THEN
    PERFORM 1 FROM hon.public_lead_forms f WHERE f.id=form AND f.organization_id=org AND f.school_id=school AND (st='OFF' OR f.status='PUBLISHED') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'REFERRAL_FORM_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  END IF;
  IF cur.school_id IS NULL THEN
    INSERT INTO hon.school_referral_programs(school_id,organization_id,version,status,form_id,referrer_reward,friend_offer,rules,share_message,updated_by_principal_id)
      VALUES(school,org,1,st,form,reward,offer,rules_t,share,actor) RETURNING * INTO cur;
  ELSE
    UPDATE hon.school_referral_programs SET version=version+1,status=st,form_id=form,referrer_reward=reward,friend_offer=offer,rules=rules_t,
      share_message=share,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE school_id=school RETURNING * INTO cur;
  END IF;
  result:=jsonb_build_object('program',hon.school_referral_program_json(org,school));
  IF hon.require_school_referral_actor(subject,'crm.referral.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_REFERRAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  INSERT INTO hon.school_referral_program_versions(school_id,organization_id,version,actor_principal_id,request_id,snapshot) VALUES(school,org,cur.version,actor,request,result->'program');
  INSERT INTO hon.school_referral_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,key,fp,result);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','crm.referral.program.configure','SCHOOL_REFERRAL_PROGRAM',school,jsonb_build_object('version',cur.version,'status',cur.status,'formId',cur.form_id),'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'crm.referral.program_changed',1,'SCHOOL_REFERRAL_PROGRAM',school,cur.version,correlation,request,jsonb_build_object('version',cur.version,'status',cur.status,'internalOnly',true));
  RETURN result||jsonb_build_object('replayed',false);
END $$;

-- F1/F9: record the school's reward decision for one referral at the exact version. Nothing is paid or credited.
CREATE FUNCTION hon.decide_family_referral_reward(subject text, referral uuid, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prev jsonb; r hon.family_referrals%ROWTYPE;
  decision text; note text; result jsonb; prior text;
BEGIN
  IF referral IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>2048
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('expectedVersion','decision','note')) OR (SELECT count(*) FROM jsonb_object_keys(p))<>3
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' OR (p->>'expectedVersion')::bigint>999999998
    OR jsonb_typeof(p->'decision') IS DISTINCT FROM 'string' OR p->>'decision' NOT IN ('PENDING','GIVEN','NOT_ELIGIBLE')
    OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  decision:=p->>'decision'; note:=hon.family_referral_text(p->'note',300,false,false);
  IF decision='PENDING' AND note<>'' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR SHARE;
  PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR SHARE;
  actor:=hon.require_school_referral_actor(subject,'crm.referral.manage');
  fp:=encode(sha256(convert_to(jsonb_build_object('op','reward','referral',referral,'input',p)::text,'UTF8')),'hex');
  prev:=hon.school_referral_begin(actor,key,fp);
  IF prev IS NOT NULL THEN RETURN prev; END IF;
  SELECT * INTO r FROM hon.family_referrals WHERE id=referral AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFERRAL_NOT_FOUND' USING ERRCODE='22023'; END IF;
  IF r.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  prior:=r.reward_status;
  UPDATE hon.family_referrals SET version=version+1,reward_status=decision,reward_note=note,
    reward_decided_at=CASE WHEN decision='PENDING' THEN NULL ELSE clock_timestamp() END,
    reward_decided_by_principal_id=CASE WHEN decision='PENDING' THEN NULL ELSE actor END WHERE id=r.id RETURNING * INTO r;
  result:=jsonb_build_object('referral',hon.family_referral_staff_json(r));
  IF hon.require_school_referral_actor(subject,'crm.referral.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_REFERRAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  INSERT INTO hon.school_referral_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,key,fp,result);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','crm.referral.reward.decide','FAMILY_REFERRAL',r.id,jsonb_build_object('rewardStatus',prior),
      jsonb_build_object('rewardStatus',r.reward_status,'version',r.version),'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'crm.referral.reward_decided',1,'FAMILY_REFERRAL',r.id,r.version,correlation,request,jsonb_build_object('referralId',r.id,'rewardStatus',r.reward_status,'internalOnly',true));
  RETURN result||jsonb_build_object('replayed',false);
END $$;

-- F2 family scope: the direct human subject of the tenant session, exactly one current family (0530 path), its tenant,
-- a live school and organization and a live entitlement. GUARDIAN only when asked.
CREATE FUNCTION hon.family_referral_scope(subject text, guardian boolean)
  RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; s record;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'PARENT_REFERRALS_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT count(*) INTO n FROM hon.resolve_parent_journey_scopes(subject);
  IF n<>1 THEN RAISE EXCEPTION 'PARENT_REFERRALS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM hon.resolve_parent_journey_scopes(subject);
  IF s.principal_id::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
    OR s.organization_id IS DISTINCT FROM hon.current_organization_id() OR s.school_id IS DISTINCT FROM hon.current_school_id()
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    OR (guardian AND s.access_level NOT IN ('PRIMARY_GUARDIAN'::hon.family_access_level,'SECONDARY_GUARDIAN'::hon.family_access_level)) THEN
    RAISE EXCEPTION 'PARENT_REFERRALS_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT s.principal_id,s.organization_id,s.school_id,s.family_id,s.access_level::text;
END $$;

-- F4: can a link of this program bring in a friend right now (the same answer for every reason it cannot).
CREATE FUNCTION hon.family_referral_program_live(org uuid, school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.school_referral_programs p JOIN hon.public_lead_forms f ON f.id=p.form_id AND f.organization_id=p.organization_id AND f.school_id=p.school_id
    WHERE p.school_id=school AND p.organization_id=org AND p.status='ON' AND f.status='PUBLISHED' AND hon.read_published_form(f.public_id) IS NOT NULL);
$$;

-- F2/F8 family read: the program as the school wrote it, the family's code (when the program is live), counts and up to
-- 100 referrals (newest first) with date, status and reward state only. SELF referrals are left out.
CREATE FUNCTION hon.read_parent_referrals(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; prog hon.school_referral_programs%ROWTYPE; live boolean; code_v text; items jsonb; counts jsonb; school_name text;
BEGIN
  SELECT * INTO sc FROM hon.family_referral_scope(subject,false);
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=sc.school_id AND s.organization_id=sc.organization_id;
  SELECT * INTO prog FROM hon.school_referral_programs p WHERE p.school_id=sc.school_id AND p.organization_id=sc.organization_id;
  live:=hon.family_referral_program_live(sc.organization_id,sc.school_id);
  IF live AND sc.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN') THEN SELECT c.code INTO code_v FROM hon.family_referral_codes c WHERE c.school_id=sc.school_id AND c.family_id=sc.family_id; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('referredAt',x.created_at,
      'status',CASE x.status WHEN 'WON' THEN 'JOINED' WHEN 'OPEN' THEN 'INTERESTED' ELSE 'NOT_JOINED' END,'reward',x.reward_status) ORDER BY x.created_at DESC,x.id),'[]'::jsonb) INTO items
    FROM (SELECT r.id,r.created_at,r.reward_status,l.status::text status FROM hon.family_referrals r JOIN hon.crm_leads l ON l.id=r.lead_id
      WHERE r.organization_id=sc.organization_id AND r.school_id=sc.school_id AND r.family_id=sc.family_id AND NOT r.self_referral
      ORDER BY r.created_at DESC,r.id LIMIT 100) x;
  SELECT jsonb_build_object('referred',count(*),'joined',count(*) FILTER (WHERE l.status='WON'),'rewarded',count(*) FILTER (WHERE r.reward_status='GIVEN')) INTO counts
    FROM hon.family_referrals r JOIN hon.crm_leads l ON l.id=r.lead_id
    WHERE r.organization_id=sc.organization_id AND r.school_id=sc.school_id AND r.family_id=sc.family_id AND NOT r.self_referral;
  RETURN jsonb_build_object('schoolName',school_name,'on',live,
    'referrerReward',CASE WHEN live THEN prog.referrer_reward ELSE NULL END,'friendOffer',CASE WHEN live THEN prog.friend_offer ELSE NULL END,
    'rules',CASE WHEN live THEN prog.rules ELSE NULL END,'shareMessage',CASE WHEN live THEN prog.share_message ELSE NULL END,
    'code',code_v,'canShare',live AND sc.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN'),'counts',counts,'referrals',items);
END $$;

-- F2/F3: the guardian's family code, created once. Refused while the program is not live.
CREATE FUNCTION hon.issue_parent_referral_link(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; code_v text; created boolean:=false; request uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO sc FROM hon.family_referral_scope(subject,true);
  PERFORM 1 FROM hon.families f WHERE f.id=sc.family_id AND f.organization_id=sc.organization_id AND f.school_id=sc.school_id FOR SHARE;
  IF NOT hon.family_referral_program_live(sc.organization_id,sc.school_id) THEN RAISE EXCEPTION 'REFERRALS_NOT_AVAILABLE' USING ERRCODE='22023'; END IF;
  SELECT c.code INTO code_v FROM hon.family_referral_codes c WHERE c.school_id=sc.school_id AND c.family_id=sc.family_id;
  IF code_v IS NULL THEN
    INSERT INTO hon.family_referral_codes(code,organization_id,school_id,family_id,issued_by_principal_id)
      VALUES(left(encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),16),sc.organization_id,sc.school_id,sc.family_id,sc.principal_id)
      ON CONFLICT (school_id,family_id) DO NOTHING RETURNING code INTO code_v;
    created:=code_v IS NOT NULL;
    IF code_v IS NULL THEN SELECT c.code INTO code_v FROM hon.family_referral_codes c WHERE c.school_id=sc.school_id AND c.family_id=sc.family_id; END IF;
  END IF;
  IF created THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
      VALUES(sc.organization_id,sc.school_id,sc.principal_id,'HUMAN_UI','crm.referral.link.issue','FAMILY',sc.family_id,jsonb_build_object('familyId',sc.family_id),'SUCCEEDED',request,request);
  END IF;
  RETURN jsonb_build_object('code',code_v);
END $$;

-- F4: the code's school and family when its link works right now, else nothing.
CREATE FUNCTION hon.family_referral_code_live(p_code text) RETURNS hon.family_referral_codes
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.family_referral_codes%ROWTYPE;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[0-9a-f]{16}$' THEN RETURN NULL; END IF;
  SELECT * INTO c FROM hon.family_referral_codes WHERE code=p_code;
  IF NOT FOUND OR NOT hon.family_referral_program_live(c.organization_id,c.school_id)
    OR NOT EXISTS(SELECT 1 FROM hon.families f WHERE f.id=c.family_id AND f.organization_id=c.organization_id AND f.school_id=c.school_id AND f.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.family_access_grants g JOIN hon.principals p ON p.id=g.principal_id AND p.is_active
      WHERE g.family_id=c.family_id AND g.organization_id=c.organization_id AND g.school_id=c.school_id
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN
    RETURN NULL;
  END IF;
  RETURN c;
END $$;

-- F4 public read: the school's name, the friend offer and the form. Nothing about the referring family.
CREATE FUNCTION hon.read_public_referral(p_code text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.family_referral_codes%ROWTYPE; prog hon.school_referral_programs%ROWTYPE; f hon.public_lead_forms%ROWTYPE; form jsonb;
BEGIN
  c:=hon.family_referral_code_live(p_code);
  IF c.code IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO prog FROM hon.school_referral_programs WHERE school_id=c.school_id;
  SELECT * INTO f FROM hon.public_lead_forms WHERE id=prog.form_id;
  form:=hon.read_published_form(f.public_id);
  IF form IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=c.school_id),'friendOffer',prog.friend_offer,
    'form',jsonb_build_object('title',form->>'title','description',form->>'description','optionalFields',form->'optionalFields'));
END $$;

-- F5-F7 public submission through the unchanged 0075 intake, then the first-touch referral record.
CREATE FUNCTION hon.submit_family_referral(p_code text, p_input jsonb, p_key text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.family_referral_codes%ROWTYPE; prog hon.school_referral_programs%ROWTYPE; f hon.public_lead_forms%ROWTYPE; outcome text;
  kh text; rc hon.public_lead_form_receipts%ROWTYPE; normalized jsonb; v_email text; v_mobile text; v_person uuid; self_ref boolean; existing boolean;
  ref_id uuid; request uuid:=gen_random_uuid();
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RETURN 'INVALID'; END IF;
  c:=hon.family_referral_code_live(p_code);
  IF c.code IS NULL THEN RETURN 'INVALID'; END IF;
  -- Lock order: org -> school -> program -> form (the same as configure_school_referral_program; 0075 then re-locks the
  -- form it already holds), then the per-code limit (F7).
  PERFORM 1 FROM hon.organizations WHERE id=c.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN 'INVALID'; END IF;
  PERFORM 1 FROM hon.schools WHERE id=c.school_id AND organization_id=c.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN 'INVALID'; END IF;
  SELECT * INTO prog FROM hon.school_referral_programs WHERE school_id=c.school_id FOR SHARE;
  SELECT * INTO f FROM hon.public_lead_forms WHERE id=prog.form_id FOR UPDATE;
  IF prog.status<>'ON' OR prog.form_id IS DISTINCT FROM f.id OR f.status<>'PUBLISHED' THEN RETURN 'INVALID'; END IF;
  IF NOT hon.take_public_form_rate(f.id,'REF:'||c.code,30) THEN RETURN 'RATE_LIMITED'; END IF;
  outcome:=hon.submit_public_form(f.public_id,p_input,p_key);
  IF outcome<>'ACCEPTED' THEN RETURN outcome; END IF;
  -- F5 first touch: only a lead whose only receipt is this transaction's (a new lead) gets a referral.
  kh:=encode(sha256(convert_to(f.hash_secret||':key:'||p_key,'UTF8')),'hex');
  SELECT * INTO rc FROM hon.public_lead_form_receipts WHERE form_id=f.id AND key_hash=kh AND transaction_id=txid_current();
  IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.public_lead_form_receipts x WHERE x.lead_id=rc.lead_id AND x.transaction_id<>txid_current())
    OR EXISTS(SELECT 1 FROM hon.family_referrals r WHERE r.lead_id=rc.lead_id) THEN
    RETURN 'ACCEPTED';
  END IF;
  normalized:=hon.validate_public_form_submission(p_input,f.optional_fields);
  v_email:=nullif(normalized->>'email',''); v_mobile:=nullif(normalized->>'mobile','');
  SELECT l.primary_person_id INTO v_person FROM hon.crm_leads l WHERE l.id=rc.lead_id;
  -- F6 flags.
  self_ref:=EXISTS(SELECT 1 FROM hon.family_members m JOIN hon.people pe ON pe.id=m.person_id
      WHERE m.family_id=c.family_id AND m.organization_id=c.organization_id AND m.school_id=c.school_id
        AND ((v_email IS NOT NULL AND lower(pe.email::text)=v_email) OR (v_mobile IS NOT NULL AND pe.phone_e164=v_mobile)))
    OR (v_email IS NOT NULL AND EXISTS(SELECT 1 FROM hon.family_access_grants g JOIN hon.principals p ON p.id=g.principal_id JOIN hon.users u ON u.id=p.user_id
      WHERE g.family_id=c.family_id AND g.organization_id=c.organization_id AND g.school_id=c.school_id AND lower(u.email::text)=v_email));
  existing:=EXISTS(SELECT 1 FROM hon.people pe WHERE pe.organization_id=c.organization_id AND pe.school_id=c.school_id AND pe.id<>v_person
    AND ((v_email IS NOT NULL AND lower(pe.email::text)=v_email) OR (v_mobile IS NOT NULL AND pe.phone_e164=v_mobile)));
  INSERT INTO hon.family_referrals(organization_id,school_id,family_id,code,lead_id,self_referral,existing_contact)
    VALUES(c.organization_id,c.school_id,c.family_id,c.code,rc.lead_id,self_ref,existing) RETURNING id INTO ref_id;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(c.organization_id,c.school_id,'00000000-0000-4000-8000-000000000604','PUBLIC_API','crm.referral.record','FAMILY_REFERRAL',ref_id,
      jsonb_build_object('leadId',rc.lead_id,'familyId',c.family_id,'selfReferral',self_ref,'existingContact',existing),'SUCCEEDED',request,request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(c.organization_id,c.school_id,'crm.referral.received',1,'FAMILY_REFERRAL',ref_id,1,request,request,
      jsonb_build_object('referralId',ref_id,'leadId',rc.lead_id,'internalOnly',true));
  RETURN 'ACCEPTED';
END $$;

COMMENT ON FUNCTION hon.submit_family_referral(text,jsonb,text) IS
'0604 public referral intake: the unchanged 0075 hon.submit_public_form, then a first-touch referral record for a lead this transaction created. No money or credit moves.';

-- F11 ACL: runtime executes the seven entry points only; every helper stays private.
DO $$ DECLARE r text; f text;
  fns text[]:=ARRAY['hon.guard_family_referral_rows()','hon.require_school_referral_actor(text,text)','hon.school_referral_program_json(uuid,uuid)',
    'hon.family_referral_display(text,integer)','hon.family_referral_staff_json(hon.family_referrals)','hon.read_school_referrals(text)','hon.family_referral_text(jsonb,integer,boolean,boolean)',
    'hon.school_referral_begin(uuid,text,text)','hon.configure_school_referral_program(text,jsonb,text,uuid,uuid)',
    'hon.decide_family_referral_reward(text,uuid,jsonb,text,uuid,uuid)','hon.family_referral_scope(text,boolean)',
    'hon.family_referral_program_live(uuid,uuid)','hon.read_parent_referrals(text)','hon.issue_parent_referral_link(text)',
    'hon.family_referral_code_live(text)','hon.read_public_referral(text)','hon.submit_family_referral(text,jsonb,text)'];
  entry text[]:=ARRAY['hon.read_school_referrals(text)','hon.configure_school_referral_program(text,jsonb,text,uuid,uuid)',
    'hon.decide_family_referral_reward(text,uuid,jsonb,text,uuid,uuid)','hon.read_parent_referrals(text)','hon.issue_parent_referral_link(text)',
    'hon.read_public_referral(text)','hon.submit_family_referral(text,jsonb,text)'];
BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    FOREACH f IN ARRAY ARRAY['school_referral_programs','school_referral_program_versions','school_referral_requests','family_referral_codes','family_referrals'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
