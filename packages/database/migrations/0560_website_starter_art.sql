BEGIN;

-- 0560 (allocated 2026-11-19 above the 0550 main ceiling; first drafted as 0479, then 0517 and 0525): website starter art
-- and three more templates. HON ships eleven images of its own under /site-art/
-- (made once with Higgsfield; children appear only in illustrations, never in photographs) and every template starts
-- with them, so a new site never looks empty. The image field kind now also accepts exactly those eleven same-origin
-- paths; everything else about it is unchanged ('' or an https URL). Mirror of WEBSITE_STARTER_ART in
-- packages/contracts/src/school-website.ts. The rule only widens, so every stored draft and version stays valid.
-- No table, grant, entry point, provider, message, billing, credit or entitlement changes.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.school_website_field_ok(text,jsonb)') IS NULL OR to_regprocedure('hon.school_website_https_ok(text)') IS NULL THEN
    RAISE EXCEPTION '0560 requires 0361';
  END IF;
END $$;

-- Same function as 0361 except the image branch.
CREATE OR REPLACE FUNCTION hon.school_website_field_ok(p_kind text,v jsonb) RETURNS boolean
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
  ELSIF p_kind='image' THEN RETURN s='' OR hon.school_website_https_ok(s)
    OR s=ANY(ARRAY['/site-art/hero-bold.webp','/site-art/hero-family.webp','/site-art/hero-traditional.webp','/site-art/hero-modern.webp','/site-art/hero-conversion.webp','/site-art/program-little.webp','/site-art/program-kids.webp','/site-art/program-adults.webp','/site-art/hero-neon.webp','/site-art/hero-editorial.webp','/site-art/hero-bento.webp']);
  ELSIF p_kind='pid' THEN RETURN s='' OR s ~ '^[a-f0-9]{48}$';
  ELSIF left(p_kind,2)='e:' THEN RETURN s=ANY(string_to_array(substr(p_kind,3),'|'));
  END IF;
  RETURN false;
END $$;

-- Three more templates that show off a modern product look (NEON_GRID, EDITORIAL, BENTO) and two fonts for them (TECH,
-- EDITORIAL). Same functions as 0361 except the template and font lists, which only widen.
CREATE OR REPLACE FUNCTION hon.school_website_document_ok(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE t jsonb; p jsonb; s jsonb; slugs text[]:='{}'; ids text[]; k text; v jsonb; n integer:=0;
BEGIN
  IF d IS NULL OR NOT hon.school_website_keys_are(d,ARRAY['schemaVersion','theme','pages']) OR d->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR octet_length(d::text)>262144 THEN RETURN false; END IF;
  t:=d->'theme';
  IF NOT hon.school_website_keys_are(t,ARRAY['template','font','logoUrl','palette'])
    OR NOT hon.school_website_field_ok('e:MODERN_CLEAN|FAMILY_FRIENDLY|BOLD_POWERFUL|TRADITIONAL|HIGH_CONVERSION|NEON_GRID|EDITORIAL|BENTO',t->'template')
    OR NOT hon.school_website_field_ok('e:MODERN|FRIENDLY|BOLD|CLASSIC|TECH|EDITORIAL',t->'font') OR NOT hon.school_website_field_ok('image',t->'logoUrl')
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

CREATE OR REPLACE FUNCTION hon.read_school_website(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE id uuid;
BEGIN
  PERFORM hon.require_school_website_actor(p_subject,'website.read');
  SELECT w.id INTO id FROM hon.school_websites w WHERE w.organization_id=hon.current_organization_id() AND w.school_id=hon.current_school_id();
  RETURN jsonb_build_object('website',CASE WHEN id IS NULL THEN 'null'::jsonb ELSE hon.school_website_record(id) END,
    'templates',jsonb_build_array('MODERN_CLEAN','FAMILY_FRIENDLY','BOLD_POWERFUL','TRADITIONAL','HIGH_CONVERSION','NEON_GRID','EDITORIAL','BENTO'));
END $$;

COMMIT;
