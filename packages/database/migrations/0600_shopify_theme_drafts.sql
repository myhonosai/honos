BEGIN;

-- HON Shopify Theme Builder, first slice TB1 (0600, coordinator-allocated 2026-11-20; was 0595). Spec: docs/architecture/SHOPIFY_COMMERCE.md
-- (TB1). Commerce step 4. Builds on 0405 (SH1) and 0496 (SH4a).
-- * HON prepares a theme change from a ready-made recipe (school colors, size guide, pickup note) and writes it only to an
--   UNPUBLISHED copy of the store's live theme that HON made ("draft copy"). It never writes to the live (MAIN) theme and never
--   publishes or deletes a theme: the owner previews the copy in Shopify and publishes it there.
-- * Editing needs the store to have granted write_themes (a Shopify protected scope). HON asks for read_themes and write_themes
--   only when the owner presses Allow theme editing.
-- * One piece of theme work at a time per store: begin takes a three-minute lease on the store's theme draft row and hands the
--   sealed credential to the API, which reads the files in Shopify, prepares the change, writes it to the copy and records
--   what it wrote (each file's previous and new contents), so an edit can be undone. A lease that ends without a result
--   leaves its edit UNKNOWN: the copy may or may not have the change; previewing again shows what it has.
-- * PREVIEW reads only and records nothing. APPLY and UNDO record one edit row each.
-- * Rows go when the store stops being CONNECTED. Forced RLS with no policy and no client table privilege; the runtime
--   executes fixed definer functions only. Audit and outbox carry ids, the recipe, file names and the outcome only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.shopify_has_scope(text,text)') IS NULL OR to_regprocedure('hon.shopify_begin(text,jsonb,text[])') IS NULL THEN
    RAISE EXCEPTION '0600 requires 0405 and 0496 (Shopify connection and product changes)'; END IF;
END $$;

CREATE TABLE hon.shopify_theme_drafts (
  connection_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  base_theme_id bigint CHECK (base_theme_id IS NULL OR base_theme_id>0),
  base_theme_name text CHECK (base_theme_name IS NULL OR length(base_theme_name) BETWEEN 1 AND 120),
  draft_theme_id bigint CHECK (draft_theme_id IS NULL OR draft_theme_id>0),
  draft_theme_name text CHECK (draft_theme_name IS NULL OR length(draft_theme_name) BETWEEN 1 AND 120),
  lease_token uuid, lease_purpose text CHECK (lease_purpose IS NULL OR lease_purpose IN ('PREVIEW','APPLY','UNDO')),
  leased_by_principal_id uuid REFERENCES hon.principals(id), lease_expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.shopify_connections(id,organization_id,school_id) ON DELETE CASCADE,
  CHECK ((draft_theme_id IS NULL)=(draft_theme_name IS NULL) AND (base_theme_id IS NULL)=(base_theme_name IS NULL)),
  CHECK (draft_theme_id IS NULL OR base_theme_id IS NOT NULL),
  CHECK ((lease_token IS NULL)=(lease_purpose IS NULL) AND (lease_token IS NULL)=(leased_by_principal_id IS NULL)
    AND (lease_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX shopify_theme_drafts_school ON hon.shopify_theme_drafts (school_id);

CREATE TABLE hon.shopify_theme_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES hon.shopify_theme_drafts(connection_id) ON DELETE CASCADE,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('APPLY','UNDO')),
  recipe text NOT NULL CHECK (recipe IN ('SCHOOL_COLORS','SIZE_GUIDE','PICKUP_NOTE')),
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs)='object' AND pg_column_size(inputs)<=8192),
  undo_of uuid REFERENCES hon.shopify_theme_edits(id),
  -- [{filename, before, after}] as written to the draft copy; null until recorded.
  files jsonb CHECK (files IS NULL OR (jsonb_typeof(files)='array' AND pg_column_size(files)<=1572864)),
  draft_theme_id bigint CHECK (draft_theme_id IS NULL OR draft_theme_id>0),
  status text NOT NULL DEFAULT 'APPLYING' CHECK (status IN ('APPLYING','APPLIED','FAILED','UNKNOWN','UNDONE')),
  lease_token uuid NOT NULL,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z_]{1,40}$'),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((kind='UNDO')=(undo_of IS NOT NULL)),
  CHECK (status NOT IN ('APPLIED','UNDONE') OR (files IS NOT NULL AND draft_theme_id IS NOT NULL)),
  CHECK ((status IN ('APPLYING','UNKNOWN'))=(finished_at IS NULL)),
  CHECK (failure_code IS NULL OR status IN ('FAILED','UNKNOWN'))
);
CREATE INDEX shopify_theme_edits_connection_idx ON hon.shopify_theme_edits (connection_id,requested_at DESC);

ALTER TABLE hon.shopify_theme_drafts ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.shopify_theme_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.shopify_theme_edits ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.shopify_theme_edits FORCE ROW LEVEL SECURITY;
CREATE TRIGGER shopify_theme_drafts_no_truncate BEFORE TRUNCATE ON hon.shopify_theme_drafts FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify();
CREATE TRIGGER shopify_theme_edits_no_truncate BEFORE TRUNCATE ON hon.shopify_theme_edits FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_shopify();

-- Identity, recipe and the recorded files of an edit never change; an edit only moves forward.
CREATE FUNCTION hon.guard_shopify_theme_edit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM hon.shopify_connections c WHERE c.id=OLD.connection_id AND c.status='CONNECTED') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SHOPIFY_THEME_EDIT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF (NEW.id,NEW.connection_id,NEW.organization_id,NEW.school_id,NEW.kind,NEW.recipe,NEW.inputs,NEW.undo_of,NEW.lease_token,
      NEW.requested_by_principal_id,NEW.requested_at) IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.organization_id,OLD.school_id,OLD.kind,
      OLD.recipe,OLD.inputs,OLD.undo_of,OLD.lease_token,OLD.requested_by_principal_id,OLD.requested_at)
    OR (OLD.files IS NOT NULL AND NEW.files IS DISTINCT FROM OLD.files)
    OR (OLD.status IN ('FAILED','UNDONE')) OR (OLD.status='APPLIED' AND NEW.status NOT IN ('APPLIED','UNDONE')) THEN
    RAISE EXCEPTION 'SHOPIFY_THEME_EDIT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shopify_theme_edits_guard BEFORE UPDATE OR DELETE ON hon.shopify_theme_edits FOR EACH ROW EXECUTE FUNCTION hon.guard_shopify_theme_edit();

-- A store that stops being CONNECTED loses its theme work.
CREATE FUNCTION hon.shopify_theme_on_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.status<>'CONNECTED' THEN DELETE FROM hon.shopify_theme_drafts WHERE connection_id=NEW.id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shopify_connection_theme_end AFTER UPDATE OF status ON hon.shopify_connections FOR EACH ROW
  WHEN (NEW.status<>'CONNECTED') EXECUTE FUNCTION hon.shopify_theme_on_end();

-- The recipe inputs exactly as the API sends them (the API validates them too).
CREATE FUNCTION hon.shopify_theme_recipe_ok(p_recipe text,v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(v)='object' AND CASE p_recipe
    WHEN 'SCHOOL_COLORS' THEN hon.shopify_keys_ok(v,ARRAY['primary','secondary'],ARRAY[]::text[])
      AND jsonb_typeof(v->'primary')='string' AND v->>'primary' ~ '^#[0-9A-F]{6}$'
      AND (jsonb_typeof(v->'secondary')='null' OR (jsonb_typeof(v->'secondary')='string' AND v->>'secondary' ~ '^#[0-9A-F]{6}$'))
    WHEN 'SIZE_GUIDE' THEN hon.shopify_keys_ok(v,ARRAY['text'],ARRAY[]::text[]) AND hon.shopify_edit_text_ok(v->'text',2000,false,true)
    WHEN 'PICKUP_NOTE' THEN hon.shopify_keys_ok(v,ARRAY['text'],ARRAY[]::text[]) AND hon.shopify_edit_text_ok(v->'text',500,false,true)
    ELSE false END
$$;
-- Recorded files: 1 to 5 distinct JSON settings/template names, each with text before and after (at most 256 KB each).
CREATE FUNCTION hon.shopify_theme_files_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(v)='array' AND jsonb_array_length(v) BETWEEN 1 AND 5
    AND (SELECT count(DISTINCT e->>'filename')=count(*) AND bool_and(
        jsonb_typeof(e)='object' AND hon.shopify_keys_ok(e,ARRAY['filename','before','after'],ARRAY[]::text[])
        AND jsonb_typeof(e->'filename')='string'
        AND e->>'filename' ~ '^(config/settings_data\.json|templates/[a-z0-9_-]{1,40}(\.[a-z0-9_-]{1,40})?\.json)$'
        AND jsonb_typeof(e->'before')='string' AND jsonb_typeof(e->'after')='string'
        AND octet_length(e->>'before')<=262144 AND octet_length(e->>'after')<=262144)
      FROM jsonb_array_elements(v) e)
$$;
CREATE FUNCTION hon.shopify_theme_name_ok(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(v)='object' AND hon.shopify_keys_ok(v,ARRAY['id','name'],ARRAY[]::text[])
    AND jsonb_typeof(v->'id')='string' AND v->>'id' ~ '^[1-9][0-9]{0,17}$'
    AND jsonb_typeof(v->'name')='string' AND length(v->>'name') BETWEEN 1 AND 120 AND v->>'name' !~ '[[:cntrl:]]'
$$;

CREATE FUNCTION hon.shopify_theme_edit_json(x hon.shopify_theme_edits,p_files boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',x.id,'kind',x.kind,'recipe',x.recipe,'inputs',x.inputs,'undoOf',x.undo_of,'status',x.status,
    'failureCode',x.failure_code,'draftThemeId',x.draft_theme_id::text,'requestedAt',hon.saas_ts(x.requested_at),
    'finishedAt',hon.saas_ts(x.finished_at),
    'files',CASE WHEN x.files IS NULL THEN '[]'::jsonb WHEN p_files THEN x.files
      ELSE (SELECT jsonb_agg(e->'filename' ORDER BY o) FROM jsonb_array_elements(x.files) WITH ORDINALITY AS t(e,o)) END)
$$;

-- The store's draft row, locked; a lease that ran out is cleared and its edit settles as UNKNOWN.
CREATE FUNCTION hon.shopify_theme_locked(p_connection uuid) RETURNS hon.shopify_theme_drafts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.shopify_theme_drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM hon.shopify_theme_drafts WHERE connection_id=p_connection FOR UPDATE;
  IF d.connection_id IS NOT NULL AND d.lease_token IS NOT NULL AND d.lease_expires_at<=clock_timestamp() THEN
    UPDATE hon.shopify_theme_edits SET status='UNKNOWN',failure_code='LEASE_EXPIRED' WHERE lease_token=d.lease_token AND status='APPLYING';
    UPDATE hon.shopify_theme_drafts SET lease_token=NULL,lease_purpose=NULL,leased_by_principal_id=NULL,lease_expires_at=NULL,
      version=version+1,updated_at=clock_timestamp() WHERE connection_id=d.connection_id RETURNING * INTO d;
  END IF;
  RETURN d;
END $$;

-- READ: whether theme editing is allowed, the draft copy, and the latest 20 edits (files by name only).
CREATE FUNCTION hon.read_shopify_theme_workspace(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.shopify_connections%ROWTYPE; d hon.shopify_theme_drafts%ROWTYPE;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF hon.shopify_actor(p_subject,p_school,true) IS NULL THEN RAISE EXCEPTION 'SHOPIFY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  c:=hon.shopify_current(p_school);
  IF c.id IS NOT NULL AND c.status='CONNECTED' THEN SELECT * INTO d FROM hon.shopify_theme_drafts WHERE connection_id=c.id; END IF;
  RETURN jsonb_build_object('schoolId',p_school,'connected',coalesce(c.status='CONNECTED',false),
    'themesAllowed',coalesce(c.status='CONNECTED' AND hon.shopify_has_scope(c.scopes,'read_themes') AND hon.shopify_has_scope(c.scopes,'write_themes'),false),
    'baseTheme',CASE WHEN d.base_theme_id IS NULL THEN NULL ELSE jsonb_build_object('id',d.base_theme_id::text,'name',d.base_theme_name) END,
    'draftTheme',CASE WHEN d.draft_theme_id IS NULL THEN NULL ELSE jsonb_build_object('id',d.draft_theme_id::text,'name',d.draft_theme_name) END,
    'busy',coalesce(d.lease_token IS NOT NULL AND d.lease_expires_at>clock_timestamp(),false),
    'edits',coalesce((SELECT jsonb_agg(hon.shopify_theme_edit_json(x,false)||jsonb_build_object('undoable',x.status='APPLIED' AND x.kind='APPLY'
        AND NOT EXISTS(SELECT 1 FROM hon.shopify_theme_edits y WHERE y.undo_of=x.id AND y.status IN ('APPLYING','APPLIED','UNKNOWN'))) ORDER BY x.requested_at DESC,x.id)
      FROM (SELECT * FROM hon.shopify_theme_edits y WHERE y.connection_id=d.connection_id ORDER BY y.requested_at DESC,y.id LIMIT 20) x),'[]'::jsonb));
END $$;

-- BEGIN {schoolId, purpose, recipe, inputs, undoOf}: lease the store's theme work for three minutes.
--   PREVIEW: recipe and inputs, undoOf null; nothing is recorded.
--   APPLY: recipe and inputs, undoOf null; one edit row (APPLYING).
--   UNDO: recipe and inputs null, undoOf an APPLIED edit not yet undone; one edit row with that edit's recipe.
--   Answers the draft state, the edit (and, for UNDO, the files to restore), the lease and the sealed credential.
CREATE FUNCTION hon.begin_shopify_theme_work(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; c hon.shopify_connections%ROWTYPE; d hon.shopify_theme_drafts%ROWTYPE; x hon.shopify_theme_edits%ROWTYPE;
  u hon.shopify_theme_edits%ROWTYPE; k hon.shopify_credentials%ROWTYPE; v_purpose text; v_recipe text; v_inputs jsonb; v_lease uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['purpose','recipe','inputs','undoOf']);
  v_purpose:=CASE WHEN jsonb_typeof(p_input->'purpose')='string' THEN p_input->>'purpose' END;
  IF v_purpose IS NULL OR v_purpose NOT IN ('PREVIEW','APPLY','UNDO') THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF v_purpose='UNDO' THEN
    IF jsonb_typeof(p_input->'recipe')<>'null' OR jsonb_typeof(p_input->'inputs')<>'null' OR NOT hon.shopify_uuid_ok(p_input->'undoOf') THEN
      RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  ELSE
    v_recipe:=CASE WHEN jsonb_typeof(p_input->'recipe')='string' THEN p_input->>'recipe' END;
    v_inputs:=p_input->'inputs';
    IF jsonb_typeof(p_input->'undoOf')<>'null' OR v_recipe IS NULL OR NOT hon.shopify_theme_recipe_ok(v_recipe,v_inputs) THEN
      RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  END IF;
  c:=hon.shopify_current(b.school);
  IF c.id IS NULL OR c.status<>'CONNECTED' THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.shopify_connections WHERE id=c.id FOR UPDATE;
  IF c.status<>'CONNECTED' THEN RAISE EXCEPTION 'SHOPIFY_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
  IF NOT hon.shopify_has_scope(c.scopes,'read_themes') OR NOT hon.shopify_has_scope(c.scopes,'write_themes') THEN
    RAISE EXCEPTION 'SHOPIFY_THEMES_NOT_ALLOWED' USING ERRCODE='55000'; END IF;
  INSERT INTO hon.shopify_theme_drafts(connection_id,organization_id,school_id) VALUES(c.id,c.organization_id,c.school_id) ON CONFLICT DO NOTHING;
  d:=hon.shopify_theme_locked(c.id);
  IF d.lease_token IS NOT NULL THEN RAISE EXCEPTION 'SHOPIFY_THEME_BUSY' USING ERRCODE='55006'; END IF;
  IF v_purpose='UNDO' THEN
    SELECT * INTO u FROM hon.shopify_theme_edits WHERE id=(p_input->>'undoOf')::uuid AND connection_id=c.id FOR UPDATE;
    IF u.id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF u.kind<>'APPLY' OR u.status<>'APPLIED' OR u.draft_theme_id IS DISTINCT FROM d.draft_theme_id
      OR EXISTS(SELECT 1 FROM hon.shopify_theme_edits y WHERE y.undo_of=u.id AND y.status IN ('APPLYING','APPLIED','UNKNOWN')) THEN
      RAISE EXCEPTION 'SHOPIFY_THEME_NOT_UNDOABLE' USING ERRCODE='55000'; END IF;
    v_recipe:=u.recipe; v_inputs:=u.inputs;
  END IF;
  IF v_purpose<>'PREVIEW' AND (SELECT count(*) FROM hon.shopify_theme_edits y WHERE y.connection_id=c.id AND y.requested_at>clock_timestamp()-interval '1 day')>=50 THEN
    RAISE EXCEPTION 'SHOPIFY_THEME_LIMIT' USING ERRCODE='54000'; END IF;
  UPDATE hon.shopify_theme_drafts SET lease_token=v_lease,lease_purpose=v_purpose,leased_by_principal_id=b.actor,
    lease_expires_at=clock_timestamp()+interval '3 minutes',version=version+1,updated_at=clock_timestamp() WHERE connection_id=c.id RETURNING * INTO d;
  IF v_purpose<>'PREVIEW' THEN
    INSERT INTO hon.shopify_theme_edits(connection_id,organization_id,school_id,kind,recipe,inputs,undo_of,lease_token,requested_by_principal_id)
      VALUES(c.id,c.organization_id,c.school_id,v_purpose,v_recipe,v_inputs,u.id,v_lease,b.actor) RETURNING * INTO x;
    PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.theme_edit.started','SHOPIFY_THEME_EDIT',x.id,1,
      jsonb_build_object('kind',x.kind,'recipe',x.recipe,'undoOf',x.undo_of));
  END IF;
  SELECT * INTO k FROM hon.shopify_credentials WHERE connection_id=c.id AND destroyed_at IS NULL;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('purpose',v_purpose,'leaseToken',v_lease,'connectionId',c.id,'shopDomain',c.shop_domain,
    'recipe',v_recipe,'inputs',v_inputs,'editId',x.id,'restore',CASE WHEN v_purpose='UNDO' THEN u.files END,
    'baseTheme',CASE WHEN d.base_theme_id IS NULL THEN NULL ELSE jsonb_build_object('id',d.base_theme_id::text,'name',d.base_theme_name) END,
    'draftTheme',CASE WHEN d.draft_theme_id IS NULL THEN NULL ELSE jsonb_build_object('id',d.draft_theme_id::text,'name',d.draft_theme_name) END,
    'credential',jsonb_build_object('keyId',k.key_id,'sealed',k.sealed,'version',k.version,
      'accessExpiresAt',hon.saas_ts(k.access_expires_at),'refreshExpiresAt',hon.saas_ts(k.refresh_expires_at)));
END $$;

-- The live lease this person holds on the store's theme work.
CREATE FUNCTION hon.shopify_theme_leased(p_school uuid,p_actor uuid,p_lease jsonb) RETURNS hon.shopify_theme_drafts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE d hon.shopify_theme_drafts%ROWTYPE;
BEGIN
  IF NOT hon.shopify_uuid_ok(p_lease) THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO d FROM hon.shopify_theme_drafts WHERE school_id=p_school AND lease_token=(p_lease#>>'{}')::uuid FOR UPDATE;
  IF d.connection_id IS NULL OR d.leased_by_principal_id<>p_actor OR d.lease_expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM hon.shopify_connections c WHERE c.id=d.connection_id AND c.status='CONNECTED') THEN
    RAISE EXCEPTION 'SHOPIFY_THEME_NOT_LEASED' USING ERRCODE='55000'; END IF;
  RETURN d;
END $$;

-- ROTATE {schoolId, leaseToken, expectedVersion, credential}: the API refreshed the token pair under this lease.
CREATE FUNCTION hon.rotate_shopify_theme_credential(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; d hon.shopify_theme_drafts%ROWTYPE; k jsonb; v integer;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['leaseToken','expectedVersion','credential']);
  k:=p_input->'credential';
  IF NOT hon.shopify_int_ok(p_input->'expectedVersion',1,1000000000,false) OR NOT hon.shopify_credential_ok(k)
    OR (k->>'accessExpiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  d:=hon.shopify_theme_leased(b.school,b.actor,p_input->'leaseToken');
  UPDATE hon.shopify_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
    refresh_expires_at=(k->>'refreshExpiresAt')::timestamptz,rotated_at=clock_timestamp()
    WHERE connection_id=d.connection_id AND destroyed_at IS NULL AND version=(p_input->>'expectedVersion')::integer RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'SHOPIFY_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('version',v);
END $$;

-- FINISH {schoolId, leaseToken, outcome, failureCode, baseTheme, draftTheme, files}: what the API did under the lease.
--   PREVIEW: outcome DONE or FAILED; baseTheme {id,name} when the API learned the live theme, draftTheme null, files null.
--   APPLY/UNDO: APPLIED (failureCode null; draftTheme and files as written, baseTheme when the copy was made now), FAILED
--     (nothing was written; failureCode), or UNKNOWN (a write may have been saved; failureCode; the copy, when it was made).
--   A draft copy, once recorded, is only ever replaced by the same id.
CREATE FUNCTION hon.finish_shopify_theme_work(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b record; d hon.shopify_theme_drafts%ROWTYPE; x hon.shopify_theme_edits%ROWTYPE; v_outcome text; bt jsonb; dt jsonb; fl jsonb;
BEGIN
  SELECT * INTO b FROM hon.shopify_begin(p_subject,p_input,ARRAY['leaseToken','outcome','failureCode','baseTheme','draftTheme','files']);
  v_outcome:=CASE WHEN jsonb_typeof(p_input->'outcome')='string' THEN p_input->>'outcome' END;
  bt:=CASE WHEN jsonb_typeof(p_input->'baseTheme')='null' THEN NULL ELSE p_input->'baseTheme' END;
  dt:=CASE WHEN jsonb_typeof(p_input->'draftTheme')='null' THEN NULL ELSE p_input->'draftTheme' END;
  fl:=CASE WHEN jsonb_typeof(p_input->'files')='null' THEN NULL ELSE p_input->'files' END;
  IF (bt IS NOT NULL AND NOT hon.shopify_theme_name_ok(bt)) OR (dt IS NOT NULL AND NOT hon.shopify_theme_name_ok(dt))
    OR (fl IS NOT NULL AND NOT hon.shopify_theme_files_ok(fl))
    OR ((v_outcome IN ('DONE','APPLIED'))<>(jsonb_typeof(p_input->'failureCode')='null'))
    OR (v_outcome NOT IN ('DONE','APPLIED') AND (jsonb_typeof(p_input->'failureCode')<>'string' OR p_input->>'failureCode' !~ '^[A-Z_]{1,40}$')) THEN
    RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  d:=hon.shopify_theme_leased(b.school,b.actor,p_input->'leaseToken');
  IF d.lease_purpose='PREVIEW' THEN
    IF v_outcome IS NULL OR v_outcome NOT IN ('DONE','FAILED') OR dt IS NOT NULL OR fl IS NOT NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  ELSE
    IF v_outcome IS NULL OR v_outcome NOT IN ('APPLIED','FAILED','UNKNOWN')
      OR (v_outcome='APPLIED' AND (dt IS NULL OR fl IS NULL)) OR (v_outcome='FAILED' AND fl IS NOT NULL) THEN
      RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  END IF;
  -- The copy HON made is kept for good; a different copy is never swapped in silently.
  IF dt IS NOT NULL AND d.draft_theme_id IS NOT NULL AND (dt->>'id')::bigint<>d.draft_theme_id THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF dt IS NOT NULL AND coalesce(bt,CASE WHEN d.base_theme_id IS NULL THEN NULL ELSE '{}'::jsonb END) IS NULL THEN RAISE EXCEPTION 'SHOPIFY_INVALID' USING ERRCODE='22023'; END IF;
  IF d.lease_purpose<>'PREVIEW' THEN
    SELECT * INTO x FROM hon.shopify_theme_edits WHERE lease_token=d.lease_token AND status='APPLYING' FOR UPDATE;
    IF x.id IS NULL THEN RAISE EXCEPTION 'SHOPIFY_THEME_NOT_LEASED' USING ERRCODE='55000'; END IF;
    UPDATE hon.shopify_theme_edits SET status=v_outcome,failure_code=p_input->>'failureCode',files=fl,
      draft_theme_id=coalesce((dt->>'id')::bigint,d.draft_theme_id),finished_at=CASE WHEN v_outcome='UNKNOWN' THEN NULL ELSE clock_timestamp() END
      WHERE id=x.id RETURNING * INTO x;
    IF x.kind='UNDO' AND v_outcome='APPLIED' THEN UPDATE hon.shopify_theme_edits SET status='UNDONE' WHERE id=x.undo_of AND status='APPLIED'; END IF;
    PERFORM hon.shopify_evidence(b.org,b.school,b.actor,'commerce.shopify.theme_edit.'||lower(v_outcome),'SHOPIFY_THEME_EDIT',x.id,1,
      jsonb_build_object('kind',x.kind,'recipe',x.recipe,'failureCode',x.failure_code,
        'files',coalesce((SELECT jsonb_agg(e->'filename') FROM jsonb_array_elements(fl) e),'[]'::jsonb)));
  END IF;
  UPDATE hon.shopify_theme_drafts SET base_theme_id=coalesce((bt->>'id')::bigint,base_theme_id),base_theme_name=coalesce(bt->>'name',base_theme_name),
    draft_theme_id=coalesce((dt->>'id')::bigint,draft_theme_id),draft_theme_name=coalesce(dt->>'name',draft_theme_name),
    lease_token=NULL,lease_purpose=NULL,leased_by_principal_id=NULL,lease_expires_at=NULL,version=version+1,updated_at=clock_timestamp()
    WHERE connection_id=d.connection_id;
  PERFORM hon.shopify_recheck(p_subject,b.school,b.actor);
  RETURN jsonb_build_object('outcome',v_outcome,'edit',CASE WHEN x.id IS NULL THEN NULL ELSE hon.shopify_theme_edit_json(x,false) END);
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.read_shopify_theme_workspace(text,uuid)','hon.begin_shopify_theme_work(text,jsonb)',
    'hon.rotate_shopify_theme_credential(text,jsonb)','hon.finish_shopify_theme_work(text,jsonb)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['shopify_theme_drafts','shopify_theme_edits'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname IN ('guard_shopify_theme_edit','shopify_theme_on_end','shopify_theme_recipe_ok','shopify_theme_files_ok',
      'shopify_theme_name_ok','shopify_theme_edit_json','shopify_theme_locked','shopify_theme_leased') OR p.oid::regprocedure::text=ANY(entry)) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
