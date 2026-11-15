BEGIN;

-- WB2 (0361, coordinator-allocated 2026-11-15): school websites. One site per school, kept as one validated document
-- (theme + pages + typed sections from a closed library) that HON renders with escaped components. A draft is edited
-- with optimistic revisions; publishing snapshots the draft as an immutable version; rollback republishes an old
-- version as a new one; unpublishing takes the site offline. The public read returns only the published snapshot and
-- the school's display name.
-- A site holds no visitor data: its form and booking sections point at the school's own published lead forms (0075)
-- and booking types (0286), so every lead still goes through the 0075 intake. Nothing here sends a message, creates a
-- lead, calls a provider or AI, touches billing, credits or entitlements, or attaches a domain.
-- The runtime role gets EXECUTE on three entry points and nothing on any table.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.public_lead_forms') IS NULL OR to_regclass('hon.school_booking_types') IS NULL OR to_regclass('hon.marketing_campaigns') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '0361 requires 0073, 0075 and 0286';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('website.read','See the school website, its draft and its published versions',false,true),
  ('website.edit','Create the school website and edit its draft',false,true),
  ('website.publish','Publish, roll back or unpublish the school website',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
  WHERE r.is_system_role AND r.code='OWNER' AND p.code IN ('website.read','website.edit','website.publish') ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------
-- Document rules (mirror of packages/contracts/src/school-website.ts). Pure functions: no table is read.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.school_website_https_ok(s text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT s IS NOT NULL AND length(s)<=500
    AND s ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&''()*+,;=:@/-]*)?(\?[A-Za-z0-9._~%!$&''()*+,;=:@/?-]*)?(#[A-Za-z0-9._~%!$&''()*+,;=:@/?-]*)?$'
$$;

-- Field kinds: lN one line of at most N characters; pN text with line breaks; href ('', https, '/', '/page', '#section');
-- image ('' or https); pid ('' or a 48-hex public id); e:A|B one of the listed values.
CREATE FUNCTION hon.school_website_field_ok(p_kind text,v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE s text;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  s:=v#>>'{}';
  IF p_kind ~ '^l[0-9]+$' THEN
    RETURN length(s)<=substr(p_kind,2)::integer AND s !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029​-‏‪-‮⁠-⁯﻿]';
  ELSIF p_kind ~ '^p[0-9]+$' THEN
    RETURN length(s)<=substr(p_kind,2)::integer AND s !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029​-‏‪-‮⁠-⁯﻿]';
  ELSIF p_kind='href' THEN
    RETURN s='' OR s='/' OR (left(s,1)='/' AND substr(s,2) ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$')
      OR (left(s,1)='#' AND substr(s,2) ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$') OR hon.school_website_https_ok(s);
  ELSIF p_kind='image' THEN RETURN s='' OR hon.school_website_https_ok(s);
  ELSIF p_kind='pid' THEN RETURN s='' OR s ~ '^[a-f0-9]{48}$';
  ELSIF left(p_kind,2)='e:' THEN RETURN s=ANY(string_to_array(substr(p_kind,3),'|'));
  END IF;
  RETURN false;
END $$;

-- The closed section library: {"f": fields, "i": item fields, "n": max items}.
CREATE FUNCTION hon.school_website_section_spec(p_type text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE p_type
    WHEN 'HERO' THEN '{"f":{"heading":"l120","subheading":"p300","ctaLabel":"l40","ctaHref":"href","imageUrl":"image","layout":"e:CENTER|SPLIT"}}'
    WHEN 'PROGRAMS' THEN '{"f":{"heading":"l120","intro":"p400"},"n":12,"i":{"name":"l80","ages":"l40","description":"p400","imageUrl":"image"}}'
    WHEN 'SCHEDULE' THEN '{"f":{"heading":"l120","note":"p600"},"n":24,"i":{"day":"l20","time":"l40","className":"l80"}}'
    WHEN 'TRIAL_CTA' THEN '{"f":{"heading":"l120","body":"p400","ctaLabel":"l40","ctaHref":"href"}}'
    WHEN 'LEAD_FORM' THEN '{"f":{"heading":"l120","body":"p400","publicFormId":"pid"}}'
    WHEN 'BOOKING' THEN '{"f":{"heading":"l120","body":"p400","ctaLabel":"l40","bookingPublicId":"pid"}}'
    WHEN 'FAQ' THEN '{"f":{"heading":"l120"},"n":20,"i":{"question":"l200","answer":"p1000"}}'
    WHEN 'TESTIMONIALS' THEN '{"f":{"heading":"l120"},"n":12,"i":{"quote":"p500","author":"l80"}}'
    WHEN 'INSTRUCTORS' THEN '{"f":{"heading":"l120"},"n":12,"i":{"name":"l80","title":"l80","bio":"p500","imageUrl":"image"}}'
    WHEN 'TEXT' THEN '{"f":{"heading":"l120","body":"p4000"}}'
    WHEN 'IMAGE' THEN '{"f":{"imageUrl":"image","alt":"l200","caption":"l200"}}'
    WHEN 'VIDEO' THEN '{"f":{"provider":"e:YOUTUBE|VIMEO","videoId":"l20","title":"l120"}}'
    WHEN 'CONTACT' THEN '{"f":{"heading":"l120","address":"p300","phone":"l40","email":"l254","hours":"p300"}}'
    WHEN 'PROMO_BANNER' THEN '{"f":{"text":"l200","ctaLabel":"l40","ctaHref":"href"}}'
    WHEN 'CHAT' THEN '{"f":{"heading":"l120","body":"p300"}}'
  END::jsonb
$$;

CREATE FUNCTION hon.school_website_keys_are(o jsonb,keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(o)='object' AND (SELECT coalesce(array_agg(k ORDER BY k),'{}') FROM jsonb_object_keys(o) k)=(SELECT coalesce(array_agg(k ORDER BY k),'{}') FROM unnest(keys) k)
$$;

CREATE FUNCTION hon.school_website_section_ok(s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE spec jsonb; props jsonb; k text; kind text; item jsonb; keys text[];
BEGIN
  IF NOT hon.school_website_keys_are(s,ARRAY['id','type','props']) OR jsonb_typeof(s->'id')<>'string' OR jsonb_typeof(s->'type')<>'string'
    OR (s->>'id') !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' THEN RETURN false; END IF;
  spec:=hon.school_website_section_spec(s->>'type');
  IF spec IS NULL THEN RETURN false; END IF;
  props:=s->'props';
  keys:=ARRAY(SELECT jsonb_object_keys(spec->'f'));
  IF spec ? 'i' THEN keys:=keys||'items'::text; END IF;
  IF NOT hon.school_website_keys_are(props,keys) THEN RETURN false; END IF;
  FOR k,kind IN SELECT key,value FROM jsonb_each_text(spec->'f') LOOP
    IF NOT hon.school_website_field_ok(kind,props->k) THEN RETURN false; END IF;
  END LOOP;
  IF s->>'type'='VIDEO' AND (props->>'videoId') !~ '^[A-Za-z0-9_-]{6,20}$' THEN RETURN false; END IF;
  IF spec ? 'i' THEN
    IF jsonb_typeof(props->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(props->'items')>(spec->>'n')::integer THEN RETURN false; END IF;
    keys:=ARRAY(SELECT jsonb_object_keys(spec->'i'));
    FOR item IN SELECT value FROM jsonb_array_elements(props->'items') LOOP
      IF NOT hon.school_website_keys_are(item,keys) THEN RETURN false; END IF;
      FOR k,kind IN SELECT key,value FROM jsonb_each_text(spec->'i') LOOP
        IF NOT hon.school_website_field_ok(kind,item->k) THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END IF;
  RETURN true;
END $$;

-- A complete closed document: schema 1, theme, 1..20 pages (first is the one HOME page 'home'), 1..30 sections each,
-- unique slugs and section ids per page, internal links only to pages that exist, at most 256 KiB.
CREATE FUNCTION hon.school_website_document_ok(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE t jsonb; p jsonb; s jsonb; slugs text[]:='{}'; ids text[]; k text; v jsonb; n integer:=0;
BEGIN
  IF d IS NULL OR NOT hon.school_website_keys_are(d,ARRAY['schemaVersion','theme','pages']) OR d->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR octet_length(d::text)>262144 THEN RETURN false; END IF;
  t:=d->'theme';
  IF NOT hon.school_website_keys_are(t,ARRAY['template','font','logoUrl','palette'])
    OR NOT hon.school_website_field_ok('e:MODERN_CLEAN|FAMILY_FRIENDLY|BOLD_POWERFUL|TRADITIONAL|HIGH_CONVERSION',t->'template')
    OR NOT hon.school_website_field_ok('e:MODERN|FRIENDLY|BOLD|CLASSIC',t->'font') OR NOT hon.school_website_field_ok('image',t->'logoUrl')
    OR NOT hon.school_website_keys_are(t->'palette',ARRAY['primary','accent','background','surface','text']) THEN RETURN false; END IF;
  FOR k,v IN SELECT key,value FROM jsonb_each(t->'palette') LOOP
    IF jsonb_typeof(v)<>'string' OR (v#>>'{}') !~ '^#[0-9a-f]{6}$' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(d->'pages') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'pages') NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(d->'pages') LOOP
    n:=n+1;
    IF NOT hon.school_website_keys_are(p,ARRAY['slug','kind','title','inNav','seo','campaignId','sections'])
      OR jsonb_typeof(p->'slug')<>'string' OR (p->>'slug') !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' OR (p->>'slug')=ANY(slugs)
      OR NOT hon.school_website_field_ok('e:HOME|PROGRAM|LANDING|PROMOTION|CUSTOM',p->'kind')
      OR NOT hon.school_website_field_ok('l120',p->'title') OR btrim(p->>'title')=''
      OR jsonb_typeof(p->'inNav') IS DISTINCT FROM 'boolean'
      OR NOT hon.school_website_keys_are(p->'seo',ARRAY['title','description'])
      OR NOT hon.school_website_field_ok('l70',p->'seo'->'title') OR NOT hon.school_website_field_ok('l160',p->'seo'->'description')
      OR (n=1)<>((p->>'slug')='home' AND p->>'kind'='HOME') OR (n>1 AND p->>'kind'='HOME')
      OR jsonb_typeof(p->'sections') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'sections') NOT BETWEEN 1 AND 30 THEN RETURN false; END IF;
    IF jsonb_typeof(p->'campaignId')<>'null' AND (jsonb_typeof(p->'campaignId')<>'string'
      OR (p->>'campaignId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR p->>'kind' NOT IN ('LANDING','PROMOTION')) THEN RETURN false; END IF;
    slugs:=slugs||(p->>'slug');
    ids:='{}';
    FOR s IN SELECT value FROM jsonb_array_elements(p->'sections') LOOP
      IF NOT hon.school_website_section_ok(s) OR (s->>'id')=ANY(ids) THEN RETURN false; END IF;
      ids:=ids||(s->>'id');
    END LOOP;
  END LOOP;
  -- Internal links (href fields only) point at pages of this document.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'pages') pg_, jsonb_array_elements(pg_.value->'sections') sc, jsonb_each(sc.value->'props') pr
    WHERE hon.school_website_section_spec(sc.value->>'type')->'f'->>pr.key='href' AND left(pr.value#>>'{}',1)='/' AND (pr.value#>>'{}')<>'/' AND NOT (substr(pr.value#>>'{}',2)=ANY(slugs))) THEN RETURN false; END IF;
  RETURN true;
END $$;

CREATE FUNCTION hon.school_website_slug_ok(s text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT s IS NOT NULL AND s ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' AND position('--' IN s)=0
    AND s<>ALL(ARRAY['admin','api','app','hq','hon','staff','www','sites','static','assets','login','auth','support','help','mail','test'])
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE hon.school_websites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  public_slug text NOT NULL UNIQUE CHECK (hon.school_website_slug_ok(public_slug)),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND btrim(name)=name AND hon.school_website_field_ok('l120',to_jsonb(name))),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','UNPUBLISHED')),
  draft_document jsonb NOT NULL CHECK (hon.school_website_document_ok(draft_document)),
  draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision BETWEEN 1 AND 999999999),
  published_version integer CHECK (published_version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,school_id),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((status='PUBLISHED')=(published_version IS NOT NULL))
);

CREATE TABLE hon.school_website_versions (
  website_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 999999999),
  source text NOT NULL CHECK (source IN ('PUBLISH','ROLLBACK')),
  rolled_back_from integer CHECK (rolled_back_from>=1),
  document jsonb NOT NULL CHECK (hon.school_website_document_ok(document)),
  note text NOT NULL CHECK (length(note)<=200 AND hon.school_website_field_ok('l200',to_jsonb(note))),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), request_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (website_id,version),
  FOREIGN KEY (website_id,organization_id,school_id) REFERENCES hon.school_websites(id,organization_id,school_id),
  CHECK ((source='ROLLBACK')=(rolled_back_from IS NOT NULL) AND (rolled_back_from IS NULL OR rolled_back_from<version))
);

CREATE TABLE hon.school_website_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('create','save','publish','rollback','unpublish')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

ALTER TABLE hon.school_websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_websites FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_website_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_website_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_website_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_website_requests FORCE ROW LEVEL SECURITY;

-- Evidence guard: nothing is deleted; versions never change; a site keeps its identity, address and creator, and every
-- change advances its draft revision by exactly one; a request records its response once.
CREATE FUNCTION hon.guard_school_website() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') OR TG_TABLE_NAME='school_website_versions' THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='school_website_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL
      OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'SCHOOL_WEBSITE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF NEW.draft_revision<>OLD.draft_revision+1
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.public_slug,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.public_slug,OLD.created_by_principal_id,OLD.created_at) THEN
    RAISE EXCEPTION 'SCHOOL_WEBSITE_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_websites_guard BEFORE UPDATE OR DELETE ON hon.school_websites FOR EACH ROW EXECUTE FUNCTION hon.guard_school_website();
CREATE TRIGGER school_website_versions_guard BEFORE UPDATE OR DELETE ON hon.school_website_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_school_website();
CREATE TRIGGER school_website_requests_guard BEFORE UPDATE OR DELETE ON hon.school_website_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_school_website();
CREATE TRIGGER school_websites_no_truncate BEFORE TRUNCATE ON hon.school_websites FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_website();
CREATE TRIGGER school_website_versions_no_truncate BEFORE TRUNCATE ON hon.school_website_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_website();
CREATE TRIGGER school_website_requests_no_truncate BEFORE TRUNCATE ON hon.school_website_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_website();

-- ---------------------------------------------------------------------------------------------------------------
-- Authority and references
-- ---------------------------------------------------------------------------------------------------------------
-- Live direct-human staff authority at the session school with one website permission, decided against
-- clock_timestamp(), or an error. Family, HQ and delegated authority never qualify.
CREATE FUNCTION hon.require_school_website_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL OR p_permission IS NULL OR p_permission NOT IN ('website.read','website.edit','website.publish') THEN
    RAISE EXCEPTION 'SCHOOL_WEBSITE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
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
        AND x.code=p_permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- A form is live for visitors exactly when read_published_form (0075) would serve it: PUBLISHED, its pipeline stage not
-- terminal, and its campaign (if any) ACTIVE. Subscription and school status are checked by the public site read itself.
CREATE FUNCTION hon.school_website_form_live(p_org uuid,p_school uuid,p_public_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.public_lead_forms f
    WHERE f.public_id=p_public_id AND f.organization_id=p_org AND f.school_id=p_school AND f.status='PUBLISHED'
      AND EXISTS(SELECT 1 FROM hon.crm_pipeline_stages st WHERE st.id=f.pipeline_stage_id AND st.pipeline_id=f.pipeline_id AND st.terminal_status IS NULL)
      AND (f.campaign_id IS NULL OR EXISTS(SELECT 1 FROM hon.marketing_campaigns c WHERE c.id=f.campaign_id AND c.organization_id=f.organization_id
        AND c.school_id=f.school_id AND c.status='ACTIVE')))
$$;

-- Every form, booking type and campaign a document names belongs to this exact school; when p_live, each is also live
-- now (form served by read_published_form, booking type ACTIVE, campaign ACTIVE).
CREATE FUNCTION hon.school_website_refs_ok(p_org uuid,p_school uuid,d jsonb,p_live boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(d->'pages') pg_, jsonb_array_elements(pg_.value->'sections') sc
    WHERE (sc.value->>'type'='LEAD_FORM' AND sc.value->'props'->>'publicFormId'<>'' AND (NOT EXISTS(SELECT 1 FROM hon.public_lead_forms f
        WHERE f.public_id=sc.value->'props'->>'publicFormId' AND f.organization_id=p_org AND f.school_id=p_school)
        OR (p_live AND NOT hon.school_website_form_live(p_org,p_school,sc.value->'props'->>'publicFormId'))))
      OR (sc.value->>'type'='BOOKING' AND sc.value->'props'->>'bookingPublicId'<>'' AND NOT EXISTS(SELECT 1 FROM hon.school_booking_types b
        WHERE b.public_id=sc.value->'props'->>'bookingPublicId' AND b.organization_id=p_org AND b.school_id=p_school AND (NOT p_live OR b.status='ACTIVE'))))
  AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(d->'pages') pg_
    WHERE jsonb_typeof(pg_.value->'campaignId')='string' AND NOT EXISTS(SELECT 1 FROM hon.marketing_campaigns c
      WHERE c.id=(pg_.value->>'campaignId')::uuid AND c.organization_id=p_org AND c.school_id=p_school AND (NOT p_live OR c.status='ACTIVE')))
$$;

-- The public copy of a published document: no campaign ids, and a form or booking section whose target is no longer
-- live is emptied ('' = nothing to show) rather than pointing at something that would refuse the visitor.
CREATE FUNCTION hon.school_website_public_document(p_org uuid,p_school uuid,d jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_set(d,'{pages}',(SELECT jsonb_agg(jsonb_set(jsonb_set(pg_.value,'{campaignId}','null'::jsonb),'{sections}',
    (SELECT jsonb_agg(CASE
      WHEN sc.value->>'type'='LEAD_FORM' AND sc.value->'props'->>'publicFormId'<>'' AND NOT hon.school_website_form_live(p_org,p_school,sc.value->'props'->>'publicFormId')
        THEN jsonb_set(sc.value,'{props,publicFormId}','""'::jsonb)
      WHEN sc.value->>'type'='BOOKING' AND sc.value->'props'->>'bookingPublicId'<>'' AND NOT EXISTS(SELECT 1 FROM hon.school_booking_types b
        WHERE b.public_id=sc.value->'props'->>'bookingPublicId' AND b.organization_id=p_org AND b.school_id=p_school AND b.status='ACTIVE')
        THEN jsonb_set(sc.value,'{props,bookingPublicId}','""'::jsonb)
      ELSE sc.value END ORDER BY sc.ordinality) FROM jsonb_array_elements(pg_.value->'sections') WITH ORDINALITY sc))
    ORDER BY pg_.ordinality) FROM jsonb_array_elements(d->'pages') WITH ORDINALITY pg_))
$$;

CREATE FUNCTION hon.school_website_record(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',w.id,'publicSlug',w.public_slug,'name',w.name,'status',w.status,'draftRevision',w.draft_revision,
    'publishedVersion',w.published_version,'draft',w.draft_document,
    'versions',coalesce((SELECT jsonb_agg(jsonb_build_object('version',v.version,'source',v.source,'note',v.note,
      'publishedAt',to_char(v.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'rolledBackFrom',v.rolled_back_from) ORDER BY v.version DESC)
      FROM (SELECT * FROM hon.school_website_versions x WHERE x.website_id=w.id ORDER BY x.version DESC LIMIT 50) v),'[]'::jsonb),
    'createdAt',to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(w.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.school_websites w WHERE w.id=p_id
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Entry points
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.read_school_website(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE id uuid;
BEGIN
  PERFORM hon.require_school_website_actor(p_subject,'website.read');
  SELECT w.id INTO id FROM hon.school_websites w WHERE w.organization_id=hon.current_organization_id() AND w.school_id=hon.current_school_id();
  RETURN jsonb_build_object('website',CASE WHEN id IS NULL THEN 'null'::jsonb ELSE hon.school_website_record(id) END,
    'templates',jsonb_build_array('MODERN_CLEAN','FAMILY_FRIENDLY','BOLD_POWERFUL','TRADITIONAL','HIGH_CONVERSION'));
END $$;

-- One command boundary: create | save (website.edit), publish | rollback | unpublish (website.publish). Serialized per
-- school, authority decided before the lock, again after waiting, and again after the last write. Actor-scoped retry
-- fingerprints bind operation and exact input; an exact retry returns the historical receipt.
CREATE FUNCTION hon.mutate_school_website(p_subject text,p_operation text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); perm text; actor uuid; fp text;
  prior hon.school_website_requests%ROWTYPE; w hon.school_websites%ROWTYPE; doc jsonb; v integer; result jsonb; old_version integer;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('create','save','publish','rollback','unpublish') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'SCHOOL_WEBSITE_INVALID' USING ERRCODE='22023'; END IF;
  perm:=CASE WHEN p_operation IN ('create','save') THEN 'website.edit' ELSE 'website.publish' END;
  actor:=hon.require_school_website_actor(p_subject,perm);
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_website:'||school::text,0));
  IF hon.require_school_website_actor(p_subject,perm) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_FORBIDDEN' USING ERRCODE='42501'; END IF;

  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
  INSERT INTO hon.school_website_requests(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,actor,p_key,p_operation,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.school_website_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_BUSY' USING ERRCODE='55P03'; END IF;
    RETURN jsonb_build_object('website',prior.response,'replayed',true);
  END IF;

  IF p_operation='create' THEN
    IF NOT hon.school_website_keys_are(p_input,ARRAY['publicSlug','name','document']) OR jsonb_typeof(p_input->'publicSlug')<>'string'
      OR jsonb_typeof(p_input->'name')<>'string' OR NOT hon.school_website_slug_ok(p_input->>'publicSlug')
      OR length(p_input->>'name') NOT BETWEEN 1 AND 120 OR btrim(p_input->>'name')<>(p_input->>'name') OR NOT hon.school_website_field_ok('l120',p_input->'name')
      OR NOT hon.school_website_document_ok(p_input->'document') THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_INVALID' USING ERRCODE='22023'; END IF;
    IF NOT hon.school_website_refs_ok(org,school,p_input->'document',false) THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_REFERENCE_INVALID' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM hon.school_websites WHERE organization_id=org AND school_id=school) THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_EXISTS' USING ERRCODE='23505'; END IF;
    IF EXISTS(SELECT 1 FROM hon.school_websites WHERE public_slug=p_input->>'publicSlug') THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_ADDRESS_TAKEN' USING ERRCODE='23505'; END IF;
    INSERT INTO hon.school_websites(organization_id,school_id,public_slug,name,draft_document,created_by_principal_id)
      VALUES(org,school,p_input->>'publicSlug',p_input->>'name',p_input->'document',actor) RETURNING * INTO w;
  ELSE
    SELECT * INTO w FROM hon.school_websites WHERE organization_id=org AND school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF jsonb_typeof(p_input->'expectedRevision')<>'number' OR (p_input->>'expectedRevision') !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_INVALID' USING ERRCODE='22023'; END IF;
    IF (p_input->>'expectedRevision')::integer<>w.draft_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF p_operation='save' THEN
      IF NOT hon.school_website_keys_are(p_input,ARRAY['expectedRevision','name','document']) OR jsonb_typeof(p_input->'name')<>'string'
        OR length(p_input->>'name') NOT BETWEEN 1 AND 120 OR btrim(p_input->>'name')<>(p_input->>'name') OR NOT hon.school_website_field_ok('l120',p_input->'name')
        OR NOT hon.school_website_document_ok(p_input->'document') THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_INVALID' USING ERRCODE='22023'; END IF;
      IF NOT hon.school_website_refs_ok(org,school,p_input->'document',false) THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_REFERENCE_INVALID' USING ERRCODE='22023'; END IF;
      UPDATE hon.school_websites SET name=p_input->>'name',draft_document=p_input->'document',draft_revision=draft_revision+1,updated_at=clock_timestamp()
        WHERE id=w.id RETURNING * INTO w;
    ELSIF p_operation IN ('publish','rollback') THEN
      IF p_operation='publish' THEN
        IF NOT hon.school_website_keys_are(p_input,ARRAY['expectedRevision','note']) THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_INVALID' USING ERRCODE='22023'; END IF;
        doc:=w.draft_document;
      ELSE
        IF NOT hon.school_website_keys_are(p_input,ARRAY['expectedRevision','version','note']) OR jsonb_typeof(p_input->'version')<>'number'
          OR (p_input->>'version') !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_INVALID' USING ERRCODE='22023'; END IF;
        old_version:=(p_input->>'version')::integer;
        SELECT x.document INTO doc FROM hon.school_website_versions x WHERE x.website_id=w.id AND x.version=old_version;
        IF doc IS NULL THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
      END IF;
      IF jsonb_typeof(p_input->'note')<>'string' OR NOT hon.school_website_field_ok('l200',p_input->'note') THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_INVALID' USING ERRCODE='22023'; END IF;
      IF NOT hon.school_website_refs_ok(org,school,doc,true) THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_REFERENCE_NOT_LIVE' USING ERRCODE='22023'; END IF;
      SELECT coalesce(max(x.version),0)+1 INTO v FROM hon.school_website_versions x WHERE x.website_id=w.id;
      INSERT INTO hon.school_website_versions(website_id,organization_id,school_id,version,source,rolled_back_from,document,note,actor_principal_id,request_id)
        VALUES(w.id,org,school,v,CASE p_operation WHEN 'publish' THEN 'PUBLISH' ELSE 'ROLLBACK' END,old_version,doc,p_input->>'note',actor,p_request);
      UPDATE hon.school_websites SET status='PUBLISHED',published_version=v,draft_document=doc,draft_revision=draft_revision+1,updated_at=clock_timestamp()
        WHERE id=w.id RETURNING * INTO w;
    ELSE
      IF NOT hon.school_website_keys_are(p_input,ARRAY['expectedRevision']) THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_INVALID' USING ERRCODE='22023'; END IF;
      IF w.status<>'PUBLISHED' THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_NOT_PUBLISHED' USING ERRCODE='22023'; END IF;
      UPDATE hon.school_websites SET status='UNPUBLISHED',published_version=NULL,draft_revision=draft_revision+1,updated_at=clock_timestamp()
        WHERE id=w.id RETURNING * INTO w;
    END IF;
  END IF;

  result:=hon.school_website_record(w.id);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','website.'||p_operation,'SCHOOL_WEBSITE',w.id,
      jsonb_build_object('status',w.status,'draftRevision',w.draft_revision,'publishedVersion',w.published_version),'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'website.'||p_operation,1,'SCHOOL_WEBSITE',w.id,w.draft_revision,p_correlation,p_request,
      jsonb_build_object('id',w.id,'status',w.status,'draftRevision',w.draft_revision,'publishedVersion',w.published_version,'internalOnly',true));
  UPDATE hon.school_website_requests SET response=result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
  IF hon.require_school_website_actor(p_subject,perm) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_WEBSITE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('website',result,'replayed',false);
END $$;

-- Public read: the published snapshot of a live school with an active subscription, or NULL. Only the address, the
-- school's display name, the version and the public copy of the document leave the database.
CREATE FUNCTION hon.read_published_school_website(p_slug text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('publicSlug',w.public_slug,'schoolName',s.name,'version',v.version,
    'document',hon.school_website_public_document(w.organization_id,w.school_id,v.document))
  FROM hon.school_websites w
  JOIN hon.school_website_versions v ON v.website_id=w.id AND v.version=w.published_version
  JOIN hon.organizations o ON o.id=w.organization_id
  JOIN hon.schools s ON s.id=w.school_id AND s.organization_id=w.organization_id
  WHERE p_slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' AND w.public_slug=p_slug AND w.status='PUBLISHED' AND o.status='ACTIVE' AND s.status='ACTIVE'
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=w.organization_id AND e.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

-- Deny first, then exactly the three entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['school_websites','school_website_versions','school_website_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.school_website_https_ok(text)','hon.school_website_field_ok(text,jsonb)','hon.school_website_section_spec(text)',
    'hon.school_website_keys_are(jsonb,text[])','hon.school_website_section_ok(jsonb)','hon.school_website_document_ok(jsonb)','hon.school_website_slug_ok(text)',
    'hon.guard_school_website()','hon.require_school_website_actor(text,text)','hon.school_website_form_live(uuid,uuid,text)','hon.school_website_refs_ok(uuid,uuid,jsonb,boolean)',
    'hon.school_website_public_document(uuid,uuid,jsonb)','hon.school_website_record(uuid)','hon.read_school_website(text)',
    'hon.mutate_school_website(text,text,jsonb,text,uuid,uuid)','hon.read_published_school_website(text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_website(text),hon.mutate_school_website(text,text,jsonb,text,uuid,uuid),
      hon.read_published_school_website(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
