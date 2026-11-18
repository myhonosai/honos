BEGIN;

-- 0560 (allocated 2026-11-19 above the 0550 main ceiling; first drafted as 0479, then 0517 and 0525): website starter art. HON ships eight images of its own under /site-art/
-- (made once with Higgsfield; children appear only in illustrations, never in photographs) and every template starts
-- with them, so a new site never looks empty. The image field kind now also accepts exactly those eight same-origin
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
    OR s=ANY(ARRAY['/site-art/hero-bold.webp','/site-art/hero-family.webp','/site-art/hero-traditional.webp','/site-art/hero-modern.webp','/site-art/hero-conversion.webp','/site-art/program-little.webp','/site-art/program-kids.webp','/site-art/program-adults.webp']);
  ELSIF p_kind='pid' THEN RETURN s='' OR s ~ '^[a-f0-9]{48}$';
  ELSIF left(p_kind,2)='e:' THEN RETURN s=ANY(string_to_array(substr(p_kind,3),'|'));
  END IF;
  RETURN false;
END $$;

COMMIT;
