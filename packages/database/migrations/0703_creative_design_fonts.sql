BEGIN;

-- 0703 Design editor designer fonts (coordinator-allocated 2026-11-28; docs/architecture/CREATIVE_DESIGN_EDITOR.md "E1").
-- Owner decision (David, 2026-11-28 01:18Z, card "Which way should we get Canva-quality designs with AI?"):
-- "Upgrade ours now, Canva later". First piece: real designer fonts in the flyer, poster and social editor.
--   F1  A text element may also use 16 open-licence fonts the web app ships itself (no outside font service at run time).
--   F2  The six original font values stay valid, so every saved school (0617) and HQ (0678) design is still valid.
--   F3  Only hon.creative_design_document_ok changes: same signature, same rules except the wider font list. Its grants,
--       owner and the table checks that call it are unchanged (CREATE OR REPLACE keeps them).
-- Nothing here sends, publishes, charges, spends credits or calls an AI or any other outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.creative_design_document_ok(jsonb,text)') IS NULL OR to_regclass('hon.school_creative_designs') IS NULL
    OR to_regclass('hon.hq_creative_designs') IS NULL THEN RAISE EXCEPTION '0703 requires 0617 and 0678'; END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.creative_design_document_ok(d jsonb,p_size text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE sz record; pg jsonb; e jsonb; k text; keys text[]; ids text[]:='{}'; w numeric; h numeric; t text;
BEGIN
  SELECT * INTO sz FROM hon.creative_design_size(p_size);
  IF sz.sides IS NULL OR jsonb_typeof(d) IS DISTINCT FROM 'object' OR length(d::text)>330000
    OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(d) x) IS DISTINCT FROM ARRAY['pages','v']
    OR d->'v' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(d->'pages') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'pages')<>sz.sides THEN RETURN false; END IF;
  w:=sz.width; h:=sz.height;
  FOR pg IN SELECT x FROM jsonb_array_elements(d->'pages') x LOOP
    IF jsonb_typeof(pg) IS DISTINCT FROM 'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(pg) x) IS DISTINCT FROM ARRAY['background','elements']
      OR NOT hon.creative_design_color_ok(pg->'background',false) OR jsonb_typeof(pg->'elements') IS DISTINCT FROM 'array'
      OR jsonb_array_length(pg->'elements')>150 THEN RETURN false; END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(pg->'elements') x LOOP
      IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR jsonb_typeof(e->'kind') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      k:=e->>'kind';
      keys:=ARRAY['h','id','kind','locked','opacity','rotation','w','x','y']||CASE k
        WHEN 'text' THEN ARRAY['align','bold','color','font','italic','lineHeight','size','text']
        WHEN 'rect' THEN ARRAY['fill','radius','stroke','strokeWidth']
        WHEN 'ellipse' THEN ARRAY['fill','stroke','strokeWidth']
        WHEN 'line' THEN ARRAY['stroke','strokeWidth']
        WHEN 'image' THEN ARRAY['fit','imageId']
        WHEN 'qr' THEN ARRAY['background','color','data'] END;
      IF keys IS NULL OR array_length(keys,1)=9 THEN RETURN false; END IF;
      IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(e) x) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(keys) x)
        OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string' OR e->>'id' !~ '^[a-z0-9-]{1,40}$' OR e->>'id'=ANY(ids)
        OR NOT hon.creative_design_num_ok(e->'x',-2*w,3*w) OR NOT hon.creative_design_num_ok(e->'y',-2*h,3*h)
        OR NOT ((k='line' AND hon.creative_design_num_ok(e->'w',-3*w,3*w) AND hon.creative_design_num_ok(e->'h',-3*h,3*h))
          OR (k<>'line' AND hon.creative_design_num_ok(e->'w',0.01,3*w) AND hon.creative_design_num_ok(e->'h',0.01,3*h)))
        OR NOT hon.creative_design_num_ok(e->'rotation',-360,360) OR NOT hon.creative_design_num_ok(e->'opacity',0,1)
        OR jsonb_typeof(e->'locked') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
      ids:=ids||(e->>'id');
      IF k='text' THEN
        t:=e->>'text';
        IF jsonb_typeof(e->'text') IS DISTINCT FROM 'string' OR length(t) NOT BETWEEN 1 AND 2000 OR t ~ '[\x01-\x09\x0b-\x1f\x7f‎‏‪-‮⁦-⁩﻿]'
          OR jsonb_typeof(e->'font') IS DISTINCT FROM 'string' OR e->>'font' NOT IN ('SANS','SERIF','DISPLAY','ROUNDED','HANDWRITING','MONO',
            'MONTSERRAT','POPPINS','OSWALD','BEBAS','ANTON','ARCHIVO_BLACK','PLAYFAIR','MERRIWEATHER','RALEWAY','NUNITO',
            'ROBOTO_SLAB','MARKER','PACIFICO','DANCING','LOBSTER','BANGERS')
          OR NOT hon.creative_design_num_ok(e->'size',4,600) OR jsonb_typeof(e->'bold') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(e->'italic') IS DISTINCT FROM 'boolean' OR NOT hon.creative_design_color_ok(e->'color',false)
          OR jsonb_typeof(e->'align') IS DISTINCT FROM 'string' OR e->>'align' NOT IN ('left','center','right')
          OR NOT hon.creative_design_num_ok(e->'lineHeight',0.8,3) THEN RETURN false; END IF;
      ELSIF k IN ('rect','ellipse') THEN
        IF NOT hon.creative_design_color_ok(e->'fill',true) OR NOT hon.creative_design_color_ok(e->'stroke',true)
          OR NOT hon.creative_design_num_ok(e->'strokeWidth',0,200) OR (k='rect' AND NOT hon.creative_design_num_ok(e->'radius',0,2000)) THEN RETURN false; END IF;
      ELSIF k='line' THEN
        IF NOT hon.creative_design_color_ok(e->'stroke',false) OR NOT hon.creative_design_num_ok(e->'strokeWidth',0.5,200) THEN RETURN false; END IF;
      ELSIF k='qr' THEN
        IF jsonb_typeof(e->'data') IS DISTINCT FROM 'string' OR length(e->>'data') NOT BETWEEN 1 AND 200 OR e->>'data' !~ '^[\x20-\x7e]+$'
          OR NOT hon.creative_design_color_ok(e->'color',false) OR NOT hon.creative_design_color_ok(e->'background',true) THEN RETURN false; END IF;
      ELSE
        IF jsonb_typeof(e->'imageId') IS DISTINCT FROM 'string' OR e->>'imageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR jsonb_typeof(e->'fit') IS DISTINCT FROM 'string' OR e->>'fit' NOT IN ('cover','contain') THEN RETURN false; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;

-- The function is still not callable by any runtime role (0617 revoked it; CREATE OR REPLACE keeps that).
REVOKE ALL ON FUNCTION hon.creative_design_document_ok(jsonb,text) FROM PUBLIC;

COMMIT;
