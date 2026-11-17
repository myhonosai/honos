BEGIN;

-- Membership agreement with one signing (0454, coordinator-allocated 2026-11-17; owner decisions 2026-11-17:
-- /mnt/project-files/membership-agreement/SPEC.md). A school writes its own membership agreement; a parent reads it in the
-- parent portal, ticks "I agree to sign electronically", types their full name and signs once for every child it covers.
-- Face check-in is a separate, optional box on the same page: ticking it for a child writes that child's 0443 face consent
-- in the same transaction, so either everything is saved or nothing is. Parents may also add or replace a child's photo.
--
-- * VERSIONS: each publish is a new immutable version (en required, ko/es optional) with a SHA-256 digest per language.
--   Signatures bind the exact version, language and digest. A new version leaves earlier signatures untouched; they show
--   "Needs signing (new version)". HON ships no agreement text: the school is responsible for its own wording.
-- * WHO SIGNS (v1): a PRIMARY or SECONDARY guardian, for a child of their family who is under 18 or has no birth date, on
--   the school's calendar date (0443 rule). A student who is 18 or older signs for themselves; the portal cannot tell that
--   the signed-in parent is that student, so such a child is shown as signing for themselves and is refused here. VIEWER
--   grants read only.
-- * NO CONDITIONING: the face box is optional and changes nothing else. It is refused for a school that is OFF, a program
--   that is CLOSED, a form that changed, or a child without a photo. An unsigned agreement does not block anything (D2).
-- * PRIVACY: audit and outbox carry identifiers only. The typed name lives only in the signature row; receipts never hold
--   it. Photos follow the 0390 rules (jpeg/png/webp, at most 400000 bytes, metadata-free); a change deletes the face
--   template through the 0443 trigger.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION '0454 requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.face_checkin_write_consent(uuid,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('hon.face_checkin_family_scope(text,boolean)') IS NULL OR to_regprocedure('hon.face_checkin_child_ok(uuid,uuid)') IS NULL
    OR to_regclass('hon.person_photos') IS NULL OR to_regprocedure('hon.paper_import_image_clean(text,bytea)') IS NULL
    OR to_regclass('hon.memberships') IS NULL THEN
    RAISE EXCEPTION '0454 requires 0390 and 0443'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('membership.agreement.manage','Write and publish the school membership agreement that parents sign',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='membership.agreement.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'membership.agreement.manage already exists with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'membership.agreement.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' ON CONFLICT DO NOTHING;

-- The school's working text, one row per language. Edited in place (each save steps the version by one).
CREATE TABLE hon.membership_agreement_drafts (
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND btrim(title)=title AND title !~ '[<>[:cntrl:]]'),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 50000 AND body !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (school_id,language),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);

-- Published versions (immutable). The highest number is the current one.
CREATE TABLE hon.membership_agreement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  number integer NOT NULL CHECK (number BETWEEN 1 AND 999999),
  published_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (school_id,number), UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE TABLE hon.membership_agreement_texts (
  version_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  language text NOT NULL CHECK (language IN ('en','ko','es')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (version_id,language), UNIQUE (version_id,language,digest),
  FOREIGN KEY (version_id,organization_id,school_id) REFERENCES hon.membership_agreement_versions(id,organization_id,school_id),
  CHECK (digest=encode(sha256(convert_to(title||E'\n\n'||body,'UTF8')),'hex'))
);

-- One row per child per signing (immutable). One signing covers several children; face_consent_id is the 0443 consent
-- written in the same transaction when the face box was ticked for that child.
CREATE TABLE hon.membership_agreement_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  signing_id uuid NOT NULL,
  version_id uuid NOT NULL, language text NOT NULL, digest text NOT NULL,
  student_profile_id uuid NOT NULL, family_id uuid NOT NULL,
  signer_kind text NOT NULL CHECK (signer_kind='GUARDIAN'),
  signer_name text NOT NULL CHECK (length(signer_name) BETWEEN 2 AND 200 AND btrim(signer_name)=signer_name AND signer_name !~ '[<>[:cntrl:]]'),
  esign_consent boolean NOT NULL CHECK (esign_consent),
  method text NOT NULL CHECK (method='PARENT_PORTAL'),
  signer_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  face_consent_id uuid UNIQUE REFERENCES hon.face_checkin_consents(id),
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (version_id,student_profile_id),
  FOREIGN KEY (version_id,language,digest) REFERENCES hon.membership_agreement_texts(version_id,language,digest),
  FOREIGN KEY (version_id,organization_id,school_id) REFERENCES hon.membership_agreement_versions(id,organization_id,school_id),
  FOREIGN KEY (student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  FOREIGN KEY (family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id)
);
CREATE INDEX membership_agreement_signatures_student_idx ON hon.membership_agreement_signatures(organization_id,school_id,student_profile_id,signed_at DESC);
CREATE INDEX membership_agreement_signatures_signing_idx ON hon.membership_agreement_signatures(signing_id);

CREATE TABLE hon.membership_agreement_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('draft','publish','family_sign','family_photo_set','family_photo_remove')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_agreement_drafts','membership_agreement_versions','membership_agreement_texts','membership_agreement_signatures',
      'membership_agreement_requests'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- Evidence guard. Versions, texts and signatures are never changed or removed; texts are added only while publishing. A draft keeps its school and language and
-- steps one version per save. A request records its response once. Nothing is truncated.
CREATE FUNCTION hon.guard_membership_agreement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  -- A version's text is written only in the transaction that published it, so no language is added later.
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM hon.membership_agreement_versions v WHERE v.id=NEW.version_id AND v.xmin=pg_current_xact_id()::xid) THEN
      RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('TRUNCATE','DELETE') OR TG_TABLE_NAME IN ('membership_agreement_versions','membership_agreement_texts','membership_agreement_signatures') THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='membership_agreement_drafts' THEN
    IF NEW.version<>OLD.version+1 OR (NEW.organization_id,NEW.school_id,NEW.language) IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.language) THEN
      RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL
    OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_agreement_drafts','membership_agreement_versions','membership_agreement_texts','membership_agreement_signatures',
      'membership_agreement_requests'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_agreement()',t||'_guard',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_agreement()',t||'_no_truncate',t);
  END LOOP;
END $$;
CREATE TRIGGER membership_agreement_texts_publish_only BEFORE INSERT ON hon.membership_agreement_texts FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_agreement();

-- ---------- helpers (migration owner only) ----------
-- Staff authority (the 0443 rules with membership.agreement.manage): the direct human of this request, one active human
-- principal, active organization and school, paid access, the permission at this exact school through a staff role, and
-- no family access at the school. Read-only.
CREATE FUNCTION hon.membership_agreement_staff_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR p_subject IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
  WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1;
  IF actor IS NULL
    OR NOT EXISTS(SELECT 1 FROM hon.organizations WHERE id=org AND status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code='membership.agreement.manage'
        AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school))
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND organization_id=org AND school_id=school
      AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The parent's one live family grant (0443 helper), re-raised with this feature's code.
CREATE FUNCTION hon.membership_agreement_family(p_subject text,p_guardian boolean)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN QUERY SELECT * FROM hon.face_checkin_family_scope(p_subject,p_guardian);
EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501';
END $$;

-- The current (highest) published version of the school, or NULL.
CREATE FUNCTION hon.membership_agreement_current(p_org uuid,p_school uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT id FROM hon.membership_agreement_versions WHERE organization_id=p_org AND school_id=p_school ORDER BY number DESC LIMIT 1
$$;

-- A child the agreement covers: a DRAFT or ACTIVE membership at the school.
CREATE FUNCTION hon.membership_agreement_covered(p_org uuid,p_school uuid,p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=p_org AND m.school_id=p_school AND m.participant_person_id=p_person
    AND m.state IN ('DRAFT','ACTIVE'))
$$;

-- Under 18 or no birth date, on the school's own calendar date (0443).
CREATE FUNCTION hon.membership_agreement_minor(p_org uuid,p_school uuid,p_birth date) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  SELECT p_birth IS NULL OR p_birth>(hon.face_checkin_today(p_org,p_school)-interval '18 years')::date
$$;

-- SIGNED (the current version), NEEDS_NEW_VERSION (an earlier one only) or NOT_SIGNED, with the latest signature.
CREATE FUNCTION hon.membership_agreement_status_json(p_org uuid,p_school uuid,p_student uuid,p_current uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN s.id IS NULL THEN jsonb_build_object('status','NOT_SIGNED','versionNumber',NULL,'signedAt',NULL)
    ELSE jsonb_build_object('status',CASE WHEN s.version_id=p_current THEN 'SIGNED' ELSE 'NEEDS_NEW_VERSION' END,
      'versionNumber',v.number,'signedAt',hon.saas_ts(s.signed_at)) END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT * FROM hon.membership_agreement_signatures x WHERE x.organization_id=p_org AND x.school_id=p_school AND x.student_profile_id=p_student
    ORDER BY (x.version_id=p_current) DESC,x.signed_at DESC,x.id LIMIT 1) s ON true
  LEFT JOIN hon.membership_agreement_versions v ON v.id=s.version_id
$$;

CREATE FUNCTION hon.membership_agreement_version_json(p_version uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('versionId',v.id,'number',v.number,'publishedAt',hon.saas_ts(v.published_at),
    'texts',(SELECT jsonb_agg(jsonb_build_object('language',t.language,'title',t.title,'body',t.body,'digest',t.digest) ORDER BY t.language='en' DESC,t.language)
      FROM hon.membership_agreement_texts t WHERE t.version_id=v.id))
  FROM hon.membership_agreement_versions v WHERE v.id=p_version
$$;

CREATE FUNCTION hon.membership_agreement_draft_json(d hon.membership_agreement_drafts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('language',d.language,'title',d.title,'body',d.body,'version',d.version,'updatedAt',hon.saas_ts(d.updated_at))
$$;

CREATE FUNCTION hon.membership_agreement_photo_json(ph hon.person_photos) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN ph.person_id IS NULL THEN NULL ELSE jsonb_build_object('mediaType',ph.media_type,'bytes',octet_length(ph.content),'version',ph.version,
    'updatedAt',hon.saas_ts(ph.updated_at)) END
$$;

CREATE FUNCTION hon.membership_agreement_name_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(p->'signerName')='string' AND length(p->>'signerName') BETWEEN 2 AND 200 AND btrim(p->>'signerName')=p->>'signerName'
    AND p->>'signerName' !~ '[<>[:cntrl:]]'
$$;

-- Receipt (exact replay). The caller has already decided authority. NULL means reserved now.
CREATE FUNCTION hon.membership_agreement_begin(p_actor uuid,p_operation text,p_scope jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prior hon.membership_agreement_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_INVALID' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_scope)::text,'UTF8')),'hex');
  INSERT INTO hon.membership_agreement_requests(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,p_actor,p_key,p_operation,fp) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.membership_agreement_requests WHERE organization_id=org AND school_id=school AND principal_id=p_actor AND idempotency_key=p_key FOR UPDATE;
  IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.response IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_BUSY' USING ERRCODE='55P03'; END IF;
  RETURN prior.response;
END $$;

-- Identifier-only audit and inert outbox under p_action, then receipt completion.
CREATE FUNCTION hon.membership_agreement_event(p_actor uuid,p_action text,p_entity_type text,p_entity uuid,p_payload jsonb,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); payload jsonb:=p_payload||jsonb_build_object('internalOnly',true);
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI',p_action,p_entity_type,p_entity,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,p_action,1,p_entity_type,p_entity,coalesce((payload->>'version')::integer,1),p_correlation,p_request,payload);
END $$;
CREATE FUNCTION hon.membership_agreement_finish(p_actor uuid,p_action text,p_entity_type text,p_entity uuid,p_payload jsonb,p_key text,
  p_request uuid,p_correlation uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.membership_agreement_event(p_actor,p_action,p_entity_type,p_entity,p_payload,p_request,p_correlation);
  UPDATE hon.membership_agreement_requests SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND principal_id=p_actor AND idempotency_key=p_key;
  RETURN jsonb_build_object('record',p_result,'replayed',false);
END $$;

-- ---------- staff entry points ----------
-- Read: the drafts, the published versions (latest first, at most 50), the current version's text, and how many covered
-- students (a DRAFT or ACTIVE membership) have signed the current version, only an earlier one, or none.
CREATE FUNCTION hon.read_membership_agreement(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); cur uuid; result jsonb;
BEGIN
  PERFORM hon.membership_agreement_staff_actor(p_subject);
  cur:=hon.membership_agreement_current(org,school);
  WITH covered AS (
    SELECT hon.membership_agreement_status_json(org,school,sp.id,cur)->>'status' status FROM hon.student_profiles sp
    WHERE sp.organization_id=org AND sp.school_id=school AND hon.membership_agreement_covered(org,school,sp.person_id))
  SELECT jsonb_build_object(
    'drafts',coalesce((SELECT jsonb_agg(hon.membership_agreement_draft_json(d) ORDER BY d.language='en' DESC,d.language) FROM hon.membership_agreement_drafts d
      WHERE d.organization_id=org AND d.school_id=school),'[]'::jsonb),
    'current',hon.membership_agreement_version_json(cur),
    'versions',coalesce((SELECT jsonb_agg(jsonb_build_object('versionId',v.id,'number',v.number,'publishedAt',hon.saas_ts(v.published_at),
        'languages',(SELECT jsonb_agg(t.language ORDER BY t.language='en' DESC,t.language) FROM hon.membership_agreement_texts t WHERE t.version_id=v.id),
        'signatures',(SELECT count(*) FROM hon.membership_agreement_signatures s WHERE s.version_id=v.id)) ORDER BY v.number DESC)
      FROM (SELECT * FROM hon.membership_agreement_versions WHERE organization_id=org AND school_id=school ORDER BY number DESC LIMIT 50) v),'[]'::jsonb),
    'summary',jsonb_build_object('covered',(SELECT count(*) FROM covered),'signed',(SELECT count(*) FROM covered WHERE status='SIGNED'),
      'needsNewVersion',(SELECT count(*) FROM covered WHERE status='NEEDS_NEW_VERSION'),'notSigned',(SELECT count(*) FROM covered WHERE status='NOT_SIGNED'))) INTO result;
  RETURN result;
END $$;

-- Input: {language, title, body, expectedVersion} (0 for a language with no draft yet).
CREATE FUNCTION hon.save_membership_agreement_draft(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; cur hon.membership_agreement_drafts%ROWTYPE;
  nxt hon.membership_agreement_drafts%ROWTYPE;
BEGIN
  actor:=hon.membership_agreement_staff_actor(p_subject);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['body','expectedVersion','language','title'])
    OR jsonb_typeof(p_input->'language') IS DISTINCT FROM 'string' OR p_input->>'language' NOT IN ('en','ko','es')
    OR jsonb_typeof(p_input->'title') IS DISTINCT FROM 'string' OR length(p_input->>'title') NOT BETWEEN 1 AND 200 OR btrim(p_input->>'title')<>p_input->>'title'
    OR p_input->>'title' ~ '[<>[:cntrl:]]'
    OR jsonb_typeof(p_input->'body') IS DISTINCT FROM 'string' OR length(p_input->>'body') NOT BETWEEN 1 AND 50000
    OR p_input->>'body' ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$' THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.membership_agreement_begin(actor,'draft',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('membership-agreement:'||school::text,0));
  SELECT * INTO cur FROM hon.membership_agreement_drafts WHERE school_id=school AND organization_id=org AND language=p_input->>'language' FOR UPDATE;
  IF coalesce(cur.version,0)<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF cur.school_id IS NULL THEN
    INSERT INTO hon.membership_agreement_drafts(organization_id,school_id,language,title,body,updated_by_principal_id)
      VALUES(org,school,p_input->>'language',p_input->>'title',p_input->>'body',actor) RETURNING * INTO nxt;
  ELSE
    UPDATE hon.membership_agreement_drafts SET title=p_input->>'title',body=p_input->>'body',version=version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
      WHERE school_id=school AND language=cur.language RETURNING * INTO nxt;
  END IF;
  replay:=hon.membership_agreement_finish(actor,'membership_agreement.draft','MEMBERSHIP_AGREEMENT_DRAFT',school,
    jsonb_build_object('language',nxt.language,'version',nxt.version),p_key,p_request,p_correlation,hon.membership_agreement_draft_json(nxt));
  IF hon.membership_agreement_staff_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- Input: {expectedNumber (0 before the first publish), drafts: [{language, version}] (the drafts the owner previewed; en
-- required), schoolResponsible: true}. Publishes them as the next version. Refused when a draft changed since the preview,
-- when another version was published meanwhile, or when the text is the same as the current version.
CREATE FUNCTION hon.publish_membership_agreement(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; cur hon.membership_agreement_versions%ROWTYPE;
  nxt hon.membership_agreement_versions%ROWTYPE; d record; n integer;
BEGIN
  actor:=hon.membership_agreement_staff_actor(p_subject);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['drafts','expectedNumber','schoolResponsible']) OR p_input->'schoolResponsible' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_input->'expectedNumber') IS DISTINCT FROM 'number' OR p_input->>'expectedNumber' !~ '^(0|[1-9][0-9]{0,5})$'
    OR jsonb_typeof(p_input->'drafts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'drafts') NOT BETWEEN 1 AND 3
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'drafts') x WHERE CASE WHEN jsonb_typeof(x)='object' THEN NOT hon.face_checkin_keys_ok(x,ARRAY['language','version']) ELSE true END
      OR jsonb_typeof(x->'language') IS DISTINCT FROM 'string' OR x->>'language' NOT IN ('en','ko','es')
      OR jsonb_typeof(x->'version') IS DISTINCT FROM 'number' OR x->>'version' !~ '^[1-9][0-9]{0,8}$')
    OR (SELECT count(DISTINCT x->>'language') FROM jsonb_array_elements(p_input->'drafts') x)<>jsonb_array_length(p_input->'drafts')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'drafts') x WHERE x->>'language'='en') THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.membership_agreement_begin(actor,'publish',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('membership-agreement:'||school::text,0));
  SELECT * INTO cur FROM hon.membership_agreement_versions WHERE id=hon.membership_agreement_current(org,school);
  IF coalesce(cur.number,0)<>(p_input->>'expectedNumber')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  SELECT count(*) INTO n FROM jsonb_array_elements(p_input->'drafts') x JOIN hon.membership_agreement_drafts dr
    ON dr.organization_id=org AND dr.school_id=school AND dr.language=x->>'language' AND dr.version=(x->>'version')::integer;
  IF n<>jsonb_array_length(p_input->'drafts') THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_DRAFT_CHANGED' USING ERRCODE='40001'; END IF;
  IF cur.id IS NOT NULL AND (SELECT array_agg(dr.language||':'||encode(sha256(convert_to(dr.title||E'\n\n'||dr.body,'UTF8')),'hex') ORDER BY dr.language)
      FROM jsonb_array_elements(p_input->'drafts') x JOIN hon.membership_agreement_drafts dr ON dr.organization_id=org AND dr.school_id=school AND dr.language=x->>'language')
    IS NOT DISTINCT FROM (SELECT array_agg(t.language||':'||t.digest ORDER BY t.language) FROM hon.membership_agreement_texts t WHERE t.version_id=cur.id) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_UNCHANGED' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.membership_agreement_versions(organization_id,school_id,number,published_by_principal_id)
    VALUES(org,school,coalesce(cur.number,0)+1,actor) RETURNING * INTO nxt;
  -- These inserts must stay in the same (sub)transaction as the version insert above: the texts guard admits a text only
  -- when its version's xmin is the current transaction id, so moving them into a subtransaction (an EXCEPTION block or a
  -- savepoint) would refuse every publish.
  FOR d IN SELECT dr.* FROM jsonb_array_elements(p_input->'drafts') x JOIN hon.membership_agreement_drafts dr
      ON dr.organization_id=org AND dr.school_id=school AND dr.language=x->>'language' ORDER BY dr.language LOOP
    INSERT INTO hon.membership_agreement_texts(version_id,organization_id,school_id,language,title,body,digest)
      VALUES(nxt.id,org,school,d.language,d.title,d.body,encode(sha256(convert_to(d.title||E'\n\n'||d.body,'UTF8')),'hex'));
  END LOOP;
  replay:=hon.membership_agreement_finish(actor,'membership_agreement.publish','MEMBERSHIP_AGREEMENT_VERSION',nxt.id,
    jsonb_build_object('versionId',nxt.id,'number',nxt.number,'version',nxt.number),p_key,p_request,p_correlation,
    jsonb_build_object('versionId',nxt.id,'number',nxt.number,'publishedAt',hon.saas_ts(nxt.published_at),
      'texts',(SELECT jsonb_agg(jsonb_build_object('language',t.language,'digest',t.digest) ORDER BY t.language='en' DESC,t.language)
        FROM hon.membership_agreement_texts t WHERE t.version_id=nxt.id)));
  IF hon.membership_agreement_staff_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- ---------- family (parent portal) entry points ----------
-- The current version, the family's children (at most 20) with whether the agreement covers them, who signs, their status,
-- photo and face consent, the face check-in section (forms only while the program is open and the school is ON), and the
-- family's signings of the current version for the printable copy.
CREATE FUNCTION hon.read_family_membership_agreement(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; cur uuid; st hon.face_checkin_settings%ROWTYPE; guardian boolean; face_open boolean; result jsonb;
BEGIN
  SELECT * INTO sc FROM hon.membership_agreement_family(p_subject,false);
  guardian:=sc.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN');
  cur:=hon.membership_agreement_current(sc.organization_id,sc.school_id);
  SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=sc.school_id AND organization_id=sc.organization_id;
  face_open:=st.status='ON' AND hon.face_checkin_open();
  SELECT jsonb_build_object('canSign',guardian AND cur IS NOT NULL,'canChangePhotos',guardian,
    'agreement',hon.membership_agreement_version_json(cur),
    'face',jsonb_build_object('available',face_open,'forms',CASE WHEN face_open THEN hon.face_checkin_forms_json(st.profile_code) ELSE '[]'::jsonb END),
    'children',coalesce((SELECT jsonb_agg(jsonb_build_object('studentProfileId',x.id,'givenName',x.given_name,'familyName',x.family_name,'covered',x.covered,
        'signer',CASE WHEN x.minor THEN 'GUARDIAN' ELSE 'SELF' END,'agreement',hon.membership_agreement_status_json(sc.organization_id,sc.school_id,x.id,cur),
        'photo',hon.membership_agreement_photo_json(x.photo),'faceConsent',hon.face_checkin_consent_json(st,x.consent),'faceEnrolled',x.enrolled)
        ORDER BY x.given_name,x.id)
      FROM (SELECT sp.id,p.given_name,p.family_name,hon.membership_agreement_covered(sp.organization_id,sp.school_id,sp.person_id) covered,
          hon.membership_agreement_minor(sp.organization_id,sp.school_id,sp.birth_date) minor,
          (SELECT ph FROM hon.person_photos ph WHERE ph.person_id=sp.person_id AND ph.organization_id=sp.organization_id AND ph.school_id=sp.school_id) photo,
          (SELECT c FROM hon.face_checkin_consents c WHERE c.student_profile_id=sp.id ORDER BY c.signed_at DESC,c.id LIMIT 1) consent,
          EXISTS(SELECT 1 FROM hon.face_templates t WHERE t.student_profile_id=sp.id) enrolled
        FROM hon.student_profiles sp JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id
        WHERE sp.organization_id=sc.organization_id AND sp.school_id=sc.school_id AND hon.face_checkin_child_ok(sc.family_id,sp.id)
        ORDER BY p.given_name,sp.id LIMIT 20) x),'[]'::jsonb),
    -- The printable copy carries the typed signer name, so only guardians receive it (a VIEWER sees statuses only).
    'signings',CASE WHEN NOT guardian THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('signingId',g.signing_id,'language',g.language,'digest',g.digest,'signerName',g.signer_name,
        'signedAt',hon.saas_ts(g.signed_at),'children',g.children) ORDER BY g.signed_at DESC,g.signing_id)
      FROM (SELECT s.signing_id,min(s.language) language,min(s.digest) digest,min(s.signer_name) signer_name,min(s.signed_at) signed_at,
          jsonb_agg(jsonb_build_object('studentProfileId',s.student_profile_id,'faceOptIn',s.face_consent_id IS NOT NULL) ORDER BY s.student_profile_id) children
        FROM hon.membership_agreement_signatures s WHERE s.version_id=cur AND s.family_id=sc.family_id
        GROUP BY s.signing_id ORDER BY min(s.signed_at) DESC LIMIT 20) g),'[]'::jsonb) END) INTO result;
  RETURN result;
END $$;

-- A guardian signs once for several children. Input: {versionId, language, digest, signerName, eSignConsent: true,
-- studentProfileIds: [1..20], faceOptIns: [{studentProfileId, formId, formDigest}]}. Every face opt-in child must be in
-- studentProfileIds and already have a photo; each writes that child's 0443 face consent (PARENT_PORTAL, GUARDIAN) in the
-- same transaction.
CREATE FUNCTION hon.sign_family_membership_agreement(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; replay jsonb; cur uuid; v hon.membership_agreement_versions%ROWTYPE; sp hon.student_profiles%ROWTYPE; opt jsonb; c hon.face_checkin_consents%ROWTYPE;
  st hon.face_checkin_settings%ROWTYPE; signing uuid:=gen_random_uuid(); sig hon.membership_agreement_signatures%ROWTYPE; children jsonb:='[]'::jsonb;
  student uuid; live uuid; faces uuid[]:='{}';
BEGIN
  SELECT * INTO sc FROM hon.membership_agreement_family(p_subject,true);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['digest','eSignConsent','faceOptIns','language','signerName','studentProfileIds','versionId'])
    OR NOT hon.face_checkin_uuid_ok(p_input,'versionId') OR NOT hon.membership_agreement_name_ok(p_input) OR p_input->'eSignConsent' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_input->'language') IS DISTINCT FROM 'string' OR p_input->>'language' NOT IN ('en','ko','es')
    OR jsonb_typeof(p_input->'digest') IS DISTINCT FROM 'string' OR p_input->>'digest' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_input->'studentProfileIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'studentProfileIds') NOT BETWEEN 1 AND 20
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'studentProfileIds') x WHERE jsonb_typeof(x)<>'string'
      OR x#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(p_input->'studentProfileIds') x)<>jsonb_array_length(p_input->'studentProfileIds')
    OR jsonb_typeof(p_input->'faceOptIns') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'faceOptIns')>20
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'faceOptIns') x WHERE CASE WHEN jsonb_typeof(x)='object' THEN NOT hon.face_checkin_keys_ok(x,ARRAY['formDigest','formId','studentProfileId']) ELSE true END
      OR NOT hon.face_checkin_uuid_ok(x,'studentProfileId') OR NOT (p_input->'studentProfileIds') @> jsonb_build_array(x->'studentProfileId')
      OR jsonb_typeof(x->'formId') IS DISTINCT FROM 'number' OR x->>'formId' !~ '^[1-9][0-9]{0,3}$'
      OR jsonb_typeof(x->'formDigest') IS DISTINCT FROM 'string' OR x->>'formDigest' !~ '^[a-f0-9]{64}$')
    OR (SELECT count(DISTINCT x->>'studentProfileId') FROM jsonb_array_elements(p_input->'faceOptIns') x)<>jsonb_array_length(p_input->'faceOptIns') THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.membership_agreement_begin(sc.principal_id,'family_sign',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  -- The version and text the parent read must still be the current ones (a publish takes this lock exclusively).
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('membership-agreement:'||sc.school_id::text,0));
  cur:=hon.membership_agreement_current(sc.organization_id,sc.school_id);
  SELECT * INTO v FROM hon.membership_agreement_versions WHERE id=cur;
  IF cur IS NULL OR cur<>(p_input->>'versionId')::uuid OR NOT EXISTS(SELECT 1 FROM hon.membership_agreement_texts t
      WHERE t.version_id=cur AND t.language=p_input->>'language' AND t.digest=p_input->>'digest') THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_CHANGED' USING ERRCODE='40001'; END IF;
  FOR student IN SELECT x::uuid FROM jsonb_array_elements_text(p_input->'studentProfileIds') x ORDER BY 1 LOOP
    IF NOT hon.face_checkin_child_ok(sc.family_id,student) THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    SELECT * INTO sp FROM hon.student_profiles WHERE id=student AND organization_id=sc.organization_id AND school_id=sc.school_id FOR KEY SHARE;
    IF NOT hon.membership_agreement_covered(sc.organization_id,sc.school_id,sp.person_id) THEN
      RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_NOT_COVERED' USING ERRCODE='22023'; END IF;
    IF NOT hon.membership_agreement_minor(sc.organization_id,sc.school_id,sp.birth_date) THEN
      RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_ADULT_SIGNS' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('membership-agreement-student:'||student::text,0));
    IF EXISTS(SELECT 1 FROM hon.membership_agreement_signatures WHERE version_id=cur AND student_profile_id=student) THEN
      RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_ALREADY_SIGNED' USING ERRCODE='40001'; END IF;
    c:=NULL; opt:=NULL;
    SELECT x INTO opt FROM jsonb_array_elements(p_input->'faceOptIns') x WHERE (x->>'studentProfileId')::uuid=student;
    IF opt IS NOT NULL THEN
      PERFORM 1 FROM hon.person_photos WHERE person_id=sp.person_id AND organization_id=sc.organization_id AND school_id=sc.school_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_PHOTO_REQUIRED' USING ERRCODE='22023'; END IF;
      c:=hon.face_checkin_write_consent(sc.principal_id,student,
        jsonb_build_object('formId',(opt->>'formId')::integer,'formDigest',opt->>'formDigest','signerName',p_input->>'signerName'),'PARENT_PORTAL','GUARDIAN');
      faces:=faces||c.id;
      -- The face consent keeps its own identifier-only trail, as when it is signed on its own page.
      PERFORM hon.membership_agreement_event(sc.principal_id,'face_checkin.family_sign','FACE_CHECKIN_CONSENT',c.id,
        jsonb_build_object('consentId',c.id,'studentProfileId',c.student_profile_id,'method',c.method,'formId',c.form_id,'version',c.version,'signingId',signing),
        p_request,p_correlation);
    END IF;
    INSERT INTO hon.membership_agreement_signatures(organization_id,school_id,signing_id,version_id,language,digest,student_profile_id,family_id,signer_kind,
        signer_name,esign_consent,method,signer_principal_id,face_consent_id)
      VALUES(sc.organization_id,sc.school_id,signing,cur,p_input->>'language',p_input->>'digest',student,sc.family_id,'GUARDIAN',p_input->>'signerName',true,
        'PARENT_PORTAL',sc.principal_id,c.id) RETURNING * INTO sig;
    SELECT * INTO st FROM hon.face_checkin_settings WHERE school_id=sc.school_id AND organization_id=sc.organization_id;
    children:=children||jsonb_build_array(jsonb_build_object('studentProfileId',student,'signatureId',sig.id,'faceConsent',hon.face_checkin_consent_json(st,c)));
  END LOOP;
  replay:=hon.membership_agreement_finish(sc.principal_id,'membership_agreement.family_sign','MEMBERSHIP_AGREEMENT_SIGNING',signing,
    jsonb_build_object('signingId',signing,'versionId',cur,'number',v.number,'studentProfileIds',(SELECT jsonb_agg(x->'studentProfileId') FROM jsonb_array_elements(children) x),
      'faceConsentIds',to_jsonb(faces),'version',1),p_key,p_request,p_correlation,
    jsonb_build_object('signingId',signing,'versionId',cur,'number',v.number,'language',p_input->>'language','digest',p_input->>'digest',
      'signedAt',hon.saas_ts(sig.signed_at),'children',children));
  SELECT principal_id INTO live FROM hon.membership_agreement_family(p_subject,true);
  IF live IS DISTINCT FROM sc.principal_id THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- Shared prologue for a guardian's photo change: a child of the family who is under 18 (or has no birth date).
CREATE FUNCTION hon.membership_agreement_photo_child(p_family uuid,p_student uuid) RETURNS hon.student_profiles
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sp hon.student_profiles%ROWTYPE;
BEGIN
  IF NOT hon.face_checkin_child_ok(p_family,p_student) THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO sp FROM hon.student_profiles WHERE id=p_student AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
  IF NOT hon.membership_agreement_minor(sp.organization_id,sp.school_id,sp.birth_date) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_ADULT_SIGNS' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM hon.people WHERE id=sp.person_id AND organization_id=sp.organization_id AND school_id=sp.school_id FOR KEY SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('person-photo:'||sp.person_id::text,0));
  RETURN sp;
END $$;

-- A guardian adds or replaces their child's photo. Input: {studentProfileId, expectedVersion (null when there is no photo),
-- mediaType, data} with data the base64 of an already metadata-free image (the API strips it). Replacing deletes the
-- child's face template (0443 trigger); the result says how many.
CREATE FUNCTION hon.set_family_child_photo(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; replay jsonb; sp hon.student_profiles%ROWTYPE; cur hon.person_photos%ROWTYPE; nxt hon.person_photos%ROWTYPE; bytes bytea; before integer; live uuid;
BEGIN
  SELECT * INTO sc FROM hon.membership_agreement_family(p_subject,true);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['data','expectedVersion','mediaType','studentProfileId']) OR NOT hon.face_checkin_uuid_ok(p_input,'studentProfileId')
    OR jsonb_typeof(p_input->'expectedVersion') NOT IN ('number','null')
    OR (jsonb_typeof(p_input->'expectedVersion')='number' AND p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$')
    OR jsonb_typeof(p_input->'mediaType') IS DISTINCT FROM 'string' OR p_input->>'mediaType' NOT IN ('image/jpeg','image/png','image/webp')
    OR jsonb_typeof(p_input->'data') IS DISTINCT FROM 'string' OR length(p_input->>'data') NOT BETWEEN 4 AND 533336
    OR length(p_input->>'data')%4<>0 OR (p_input->>'data') !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- The receipt fingerprint covers a hash of the image, not the image.
  replay:=hon.membership_agreement_begin(sc.principal_id,'family_photo_set',(p_input-'data')||jsonb_build_object('data',encode(sha256(convert_to(p_input->>'data','UTF8')),'hex')),
    p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  sp:=hon.membership_agreement_photo_child(sc.family_id,(p_input->>'studentProfileId')::uuid);
  bytes:=decode(p_input->>'data','base64');
  IF octet_length(bytes) NOT BETWEEN 1 AND 400000 OR NOT hon.paper_import_image_clean(p_input->>'mediaType',bytes) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_IMAGE_REFUSED' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO before FROM hon.face_templates WHERE student_profile_id=sp.id;
  SELECT * INTO cur FROM hon.person_photos WHERE person_id=sp.person_id FOR UPDATE;
  IF cur.person_id IS NULL THEN
    IF jsonb_typeof(p_input->'expectedVersion')<>'null' THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.person_photos(person_id,organization_id,school_id,media_type,content,checksum,created_by_principal_id,updated_by_principal_id)
      VALUES(sp.person_id,sp.organization_id,sp.school_id,p_input->>'mediaType',bytes,encode(sha256(bytes),'hex'),sc.principal_id,sc.principal_id) RETURNING * INTO nxt;
  ELSE
    IF jsonb_typeof(p_input->'expectedVersion')<>'number' OR cur.version<>(p_input->>'expectedVersion')::integer THEN
      RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    UPDATE hon.person_photos SET media_type=p_input->>'mediaType',content=bytes,checksum=encode(sha256(bytes),'hex'),version=version+1,
      updated_by_principal_id=sc.principal_id,updated_at=clock_timestamp() WHERE person_id=sp.person_id RETURNING * INTO nxt;
  END IF;
  replay:=hon.membership_agreement_finish(sc.principal_id,'people.photo.set','PERSON',sp.person_id,
    jsonb_build_object('personId',sp.person_id,'checksum',nxt.checksum,'version',nxt.version,'method','PARENT_PORTAL'),p_key,p_request,p_correlation,
    jsonb_build_object('studentProfileId',sp.id,'photo',hon.membership_agreement_photo_json(nxt),'replaced',cur.person_id IS NOT NULL,
      'templatesDeleted',before-(SELECT count(*) FROM hon.face_templates WHERE student_profile_id=sp.id)));
  SELECT principal_id INTO live FROM hon.membership_agreement_family(p_subject,true);
  IF live IS DISTINCT FROM sc.principal_id THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- A guardian removes their child's photo. Input: {studentProfileId, expectedVersion}. Deletes the bytes and the face template.
CREATE FUNCTION hon.remove_family_child_photo(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; replay jsonb; sp hon.student_profiles%ROWTYPE; cur hon.person_photos%ROWTYPE; before integer; live uuid;
BEGIN
  SELECT * INTO sc FROM hon.membership_agreement_family(p_subject,true);
  IF NOT hon.face_checkin_keys_ok(p_input,ARRAY['expectedVersion','studentProfileId']) OR NOT hon.face_checkin_uuid_ok(p_input,'studentProfileId')
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_INVALID' USING ERRCODE='22023'; END IF;
  replay:=hon.membership_agreement_begin(sc.principal_id,'family_photo_remove',p_input,p_key,p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  sp:=hon.membership_agreement_photo_child(sc.family_id,(p_input->>'studentProfileId')::uuid);
  SELECT count(*) INTO before FROM hon.face_templates WHERE student_profile_id=sp.id;
  SELECT * INTO cur FROM hon.person_photos WHERE person_id=sp.person_id FOR UPDATE;
  IF cur.person_id IS NULL OR cur.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  DELETE FROM hon.person_photos WHERE person_id=sp.person_id;
  replay:=hon.membership_agreement_finish(sc.principal_id,'people.photo.removed','PERSON',sp.person_id,
    jsonb_build_object('personId',sp.person_id,'checksum',cur.checksum,'version',cur.version,'method','PARENT_PORTAL'),p_key,p_request,p_correlation,
    jsonb_build_object('studentProfileId',sp.id,'photo',NULL,'replaced',false,
      'templatesDeleted',before-(SELECT count(*) FROM hon.face_templates WHERE student_profile_id=sp.id)));
  SELECT principal_id INTO live FROM hon.membership_agreement_family(p_subject,true);
  IF live IS DISTINCT FROM sc.principal_id THEN RAISE EXCEPTION 'MEMBERSHIP_AGREEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN replay;
END $$;

-- Deny first, then exactly the seven entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['membership_agreement_drafts','membership_agreement_versions','membership_agreement_texts','membership_agreement_signatures',
      'membership_agreement_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace
      AND (p.proname LIKE 'membership\_agreement\_%' OR p.proname IN ('guard_membership_agreement','read_membership_agreement','save_membership_agreement_draft',
        'publish_membership_agreement','read_family_membership_agreement','sign_family_membership_agreement','set_family_child_photo','remove_family_child_photo')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_membership_agreement(text),hon.save_membership_agreement_draft(text,jsonb,text,uuid,uuid),
      hon.publish_membership_agreement(text,jsonb,text,uuid,uuid),hon.read_family_membership_agreement(text),
      hon.sign_family_membership_agreement(text,jsonb,text,uuid,uuid),hon.set_family_child_photo(text,jsonb,text,uuid,uuid),
      hon.remove_family_child_photo(text,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
