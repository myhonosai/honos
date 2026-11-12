BEGIN;

-- A3 Creative Studio photo avatars (0305, allocated by the coordinator). Provider-free: nothing here calls a provider,
-- charges a card, changes trial funding or activates a program. The photo never leaves this database.
--
-- Owner decision (David, 2026-11-12): an ADULT STAFF member may make an avatar from THEIR OWN photo, with signed
-- likeness consent and a delete option. Never students, children or anybody else.
--
--   * Own photo only: the uploader, the consent signer and the person in the photo are one signed-in principal. There is
--     no subject field; nobody can upload, or make a photo avatar, for someone else.
--   * Staff only: uploading and making the avatar need the CS1 school actor (hon.require_saas_school_actor), which refuses
--     parent, guardian, student and family principals. Every later use (an avatar video) needs the person to still be an
--     eligible staff member of that school; leaving the school withdraws the likeness.
--   * Consent is a permanent record (who, when, wording version, three attestations, typed name, photo hash). It never
--     holds the image, so it outlives deletion as proof.
--   * Erasure is real: the bytes live only in hon.creative_avatar_photos and delete removes that row. The person in the
--     photo can always delete it (no entitlement or staff check); a live school owner can delete it on their behalf.
--   * A withdrawn likeness (deleted, replaced, or the person no longer staff) hides the photo avatar, its videos and their
--     generations from every school read, and refuses new videos. HQ ledger evidence is unchanged.
--
-- The photo avatar itself is an ordinary A1 avatar (avatar.create at the HQ rate, school wallet, every CS1 rule) made by
-- the unchanged hon.create_creative_avatar, plus an immutable link to the consent.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON Creative Studio photo avatars require a trusted migration owner';
  END IF;
  IF to_regclass('hon.creative_avatar_videos') IS NULL OR to_regprocedure('hon.create_creative_avatar(text,uuid,jsonb,jsonb,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.school_owner_grant_rows(uuid,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'HON Creative Studio photo avatars require avatars (0276), avatar videos (0277) and school ownership (0223)';
  END IF;
END $$;

-- The typed signature: 2..80 printable characters, trimmed, no control, line-break or bidi-override characters.
CREATE FUNCTION hon.creative_photo_signature_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 2 AND 80 AND btrim(p) = p
    AND p !~ E'[\\x01-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]'
$$;

-- The image must really be the declared type (magic bytes) and at most 1 MiB.
CREATE FUNCTION hon.creative_photo_bytes_ok(p_type text, b bytea) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT b IS NOT NULL AND octet_length(b) BETWEEN 64 AND 1048576 AND CASE p_type
    WHEN 'image/jpeg' THEN substring(b FROM 1 FOR 3) = '\xffd8ff'::bytea
    WHEN 'image/png' THEN substring(b FROM 1 FOR 8) = '\x89504e470d0a1a0a'::bytea
    WHEN 'image/webp' THEN substring(b FROM 1 FOR 4) = '\x52494646'::bytea AND substring(b FROM 9 FOR 4) = '\x57454250'::bytea
    ELSE false END
$$;

-- Permanent consent record: never holds the image.
CREATE TABLE hon.creative_avatar_photo_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  subject_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  consent_version text NOT NULL CHECK (consent_version = 'HON-LIKENESS-2026-11-12'),
  attests_own_likeness boolean NOT NULL CHECK (attests_own_likeness),
  attests_adult boolean NOT NULL CHECK (attests_adult),
  attests_marketing_use boolean NOT NULL CHECK (attests_marketing_use),
  signature_name text NOT NULL CHECK (hon.creative_photo_signature_ok(signature_name)),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 64 AND 1048576),
  photo_sha256 text NOT NULL CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (subject_principal_id, idempotency_key),
  UNIQUE (id, school_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.saas_creative_wallets(school_id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX creative_avatar_photo_consents_school ON hon.creative_avatar_photo_consents (school_id, created_at DESC, id DESC);
CREATE INDEX creative_avatar_photo_consents_subject ON hon.creative_avatar_photo_consents (school_id, subject_principal_id);
CREATE TRIGGER creative_avatar_photo_consent_immutable BEFORE UPDATE OR DELETE ON hon.creative_avatar_photo_consents FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER creative_avatar_photo_consent_no_truncate BEFORE TRUNCATE ON hon.creative_avatar_photo_consents FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- The image bytes, and nothing else that identifies a face. One live photo per person per school. Rows may be DELETED
-- (erasure) but never changed.
CREATE TABLE hon.creative_avatar_photos (
  consent_id uuid PRIMARY KEY,
  school_id uuid NOT NULL,
  subject_principal_id uuid NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes bytea NOT NULL CHECK (hon.creative_photo_bytes_ok(content_type, bytes)),
  created_at timestamptz NOT NULL,
  UNIQUE (school_id, subject_principal_id),
  FOREIGN KEY (consent_id, school_id) REFERENCES hon.creative_avatar_photo_consents(id, school_id) ON DELETE RESTRICT
);
CREATE FUNCTION hon.guard_creative_avatar_photo() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  RAISE EXCEPTION 'CREATIVE_AVATAR_PHOTO_IMMUTABLE' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER creative_avatar_photo_no_update BEFORE UPDATE ON hon.creative_avatar_photos FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_avatar_photo();
CREATE TRIGGER creative_avatar_photo_no_truncate BEFORE TRUNCATE ON hon.creative_avatar_photos FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_avatar_photo();

-- Why a photo stopped being usable. Written in the same transaction that erases the bytes.
CREATE TABLE hon.creative_avatar_photo_withdrawals (
  consent_id uuid PRIMARY KEY,
  school_id uuid NOT NULL,
  withdrawn_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN ('DELETED_BY_SUBJECT','DELETED_BY_OWNER','REPLACED')),
  withdrawn_at timestamptz NOT NULL,
  FOREIGN KEY (consent_id, school_id) REFERENCES hon.creative_avatar_photo_consents(id, school_id) ON DELETE RESTRICT
);
CREATE TRIGGER creative_avatar_photo_withdrawal_immutable BEFORE UPDATE OR DELETE ON hon.creative_avatar_photo_withdrawals FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER creative_avatar_photo_withdrawal_no_truncate BEFORE TRUNCATE ON hon.creative_avatar_photo_withdrawals FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- Which A1 avatar was made from which consented photo (immutable), with the photo-avatar request's own idempotency.
CREATE TABLE hon.creative_avatar_photo_links (
  avatar_id uuid PRIMARY KEY,
  school_id uuid NOT NULL,
  consent_id uuid NOT NULL,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (created_by_principal_id, idempotency_key),
  FOREIGN KEY (avatar_id, school_id) REFERENCES hon.creative_avatars(id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (consent_id, school_id) REFERENCES hon.creative_avatar_photo_consents(id, school_id) ON DELETE RESTRICT
);
CREATE INDEX creative_avatar_photo_links_consent ON hon.creative_avatar_photo_links (consent_id);
CREATE TRIGGER creative_avatar_photo_link_immutable BEFORE UPDATE OR DELETE ON hon.creative_avatar_photo_links FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER creative_avatar_photo_link_no_truncate BEFORE TRUNCATE ON hon.creative_avatar_photo_links FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- The signed-in person, whatever their school standing (so they can always see and delete their own photo).
CREATE FUNCTION hon.creative_photo_principal(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE pid uuid;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO pid FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
    WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER'
      AND (SELECT count(*) FROM hon.principals x WHERE x.user_id = u.id AND x.is_active) = 1;
  IF pid IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN pid;
END $$;

-- Is the person in the photo still an eligible staff member of that school, with no family access?
CREATE FUNCTION hon.creative_photo_subject_live(p_principal uuid, p_org uuid, p_school uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT hon.staff_member_eligible(p_principal, p_org, p_school)
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p_principal
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      WHERE g.principal_id = p_principal AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;

-- A consented likeness is usable only while its photo is present, not withdrawn, and the person is still staff.
CREATE FUNCTION hon.creative_photo_consent_live(p_consent uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.creative_avatar_photo_consents c
    JOIN hon.creative_avatar_photos ph ON ph.consent_id = c.id AND ph.school_id = c.school_id
    WHERE c.id = p_consent
      AND NOT EXISTS (SELECT 1 FROM hon.creative_avatar_photo_withdrawals w WHERE w.consent_id = c.id)
      AND hon.creative_photo_subject_live(c.subject_principal_id, c.organization_id, c.school_id))
$$;

CREATE FUNCTION hon.creative_avatar_withdrawn(p_avatar uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.creative_avatar_photo_links l WHERE l.avatar_id = p_avatar AND NOT hon.creative_photo_consent_live(l.consent_id))
$$;

-- A generation that shows a withdrawn likeness: the photo avatar's own creation or one of its videos.
CREATE FUNCTION hon.creative_generation_withdrawn(p_generation uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.creative_avatars a WHERE a.generation_id = p_generation AND hon.creative_avatar_withdrawn(a.id))
    OR EXISTS (SELECT 1 FROM hon.creative_avatar_videos v WHERE v.generation_id = p_generation AND hon.creative_avatar_withdrawn(v.avatar_id))
$$;

-- School view of one consent (never the image). status: ACTIVE, WITHDRAWN (deleted or replaced) or INACTIVE (the person
-- is no longer staff of the school; the photo stays stored until it is deleted).
CREATE FUNCTION hon.creative_photo_consent_json(c hon.creative_avatar_photo_consents, p_viewer uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('consentId', c.id, 'schoolId', c.school_id, 'mine', c.subject_principal_id = p_viewer,
    'signatureName', c.signature_name, 'consentVersion', c.consent_version, 'contentType', c.content_type, 'byteSize', c.byte_size,
    'status', CASE WHEN w.consent_id IS NOT NULL OR ph.consent_id IS NULL THEN 'WITHDRAWN'
      WHEN NOT hon.creative_photo_subject_live(c.subject_principal_id, c.organization_id, c.school_id) THEN 'INACTIVE' ELSE 'ACTIVE' END,
    'withdrawnReason', w.reason, 'withdrawnAt', hon.saas_ts(w.withdrawn_at),
    'avatarIds', coalesce((SELECT jsonb_agg(l.avatar_id ORDER BY l.created_at, l.avatar_id) FROM hon.creative_avatar_photo_links l WHERE l.consent_id = c.id), '[]'::jsonb),
    'createdAt', hon.saas_ts(c.created_at))
  FROM (SELECT 1) one
  LEFT JOIN hon.creative_avatar_photo_withdrawals w ON w.consent_id = c.id
  LEFT JOIN hon.creative_avatar_photos ph ON ph.consent_id = c.id AND ph.school_id = c.school_id
$$;

CREATE FUNCTION hon.creative_photo_fingerprint(p_school uuid, p jsonb, p_sha text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('schoolId', p_school, 'consentVersion', p->'consentVersion', 'ownLikeness', p->'ownLikeness',
    'adult', p->'adult', 'marketingUse', p->'marketingUse', 'signatureName', p->'signatureName', 'contentType', p->'contentType', 'photoSha256', p_sha)::text, 'UTF8')), 'hex')
$$;

-- UPLOAD: the signed-in staff member's own photo with their signed consent. Replacing erases the previous photo.
CREATE FUNCTION hon.upload_creative_avatar_photo(p_subject text, p_school uuid, p jsonb, p_photo text, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; b bytea; sha text; fp text; existing hon.creative_avatar_photo_consents%ROWTYPE; old hon.creative_avatar_photos%ROWTYPE;
  made hon.creative_avatar_photo_consents%ROWTYPE; again record; at timestamptz;
BEGIN
  IF p_key IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['adult','consentVersion','contentType','marketingUse','ownLikeness','signatureName']
    OR p->'consentVersion' IS DISTINCT FROM '"HON-LIKENESS-2026-11-12"'::jsonb
    OR p->'ownLikeness' IS DISTINCT FROM 'true'::jsonb OR p->'adult' IS DISTINCT FROM 'true'::jsonb OR p->'marketingUse' IS DISTINCT FROM 'true'::jsonb
    OR coalesce(jsonb_typeof(p->'signatureName'), '') <> 'string' OR NOT hon.creative_photo_signature_ok(p->>'signatureName')
    OR coalesce(jsonb_typeof(p->'contentType'), '') <> 'string' OR (p->>'contentType') NOT IN ('image/jpeg','image/png','image/webp')
    OR p_photo IS NULL OR length(p_photo) > 1400000 OR p_photo !~ '^[A-Za-z0-9+/]+={0,2}$' OR length(p_photo) % 4 <> 0 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  b := decode(p_photo, 'base64');
  IF NOT hon.creative_photo_bytes_ok(p->>'contentType', b) THEN RAISE EXCEPTION 'CREATIVE_AVATAR_PHOTO_INVALID' USING ERRCODE = '22023'; END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  sha := encode(sha256(b), 'hex');
  fp := hon.creative_photo_fingerprint(scope.school_id, p, sha);
  -- One writer per person per school: replace, delete and create-from-photo all take this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.creative.photo:' || scope.school_id::text || ':' || scope.principal_id::text, 0));
  SELECT * INTO existing FROM hon.creative_avatar_photo_consents WHERE subject_principal_id = scope.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fp OR existing.school_id <> scope.school_id THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('photo', hon.creative_photo_consent_json(existing, scope.principal_id), 'replayed', true);
  END IF;
  at := clock_timestamp();
  SELECT * INTO old FROM hon.creative_avatar_photos WHERE school_id = scope.school_id AND subject_principal_id = scope.principal_id;
  IF FOUND THEN
    PERFORM 1 FROM hon.creative_avatar_photo_consents WHERE id = old.consent_id FOR UPDATE;
    DELETE FROM hon.creative_avatar_photos WHERE consent_id = old.consent_id;
    INSERT INTO hon.creative_avatar_photo_withdrawals(consent_id, school_id, withdrawn_by_principal_id, reason, withdrawn_at)
      VALUES (old.consent_id, old.school_id, scope.principal_id, 'REPLACED', at);
  END IF;
  INSERT INTO hon.creative_avatar_photo_consents(school_id, organization_id, subject_principal_id, idempotency_key, request_fingerprint, consent_version,
      attests_own_likeness, attests_adult, attests_marketing_use, signature_name, content_type, byte_size, photo_sha256, created_at)
    VALUES (scope.school_id, scope.organization_id, scope.principal_id, p_key, fp, p->>'consentVersion', true, true, true,
      p->>'signatureName', p->>'contentType', octet_length(b), sha, at)
    RETURNING * INTO made;
  INSERT INTO hon.creative_avatar_photos(consent_id, school_id, subject_principal_id, content_type, bytes, created_at)
    VALUES (made.id, made.school_id, made.subject_principal_id, made.content_type, b, at);
  -- Finality: the person must still be this school's staff actor after the writes.
  SELECT * INTO again FROM hon.require_saas_school_actor(p_subject, scope.school_id) LIMIT 1;
  IF again.principal_id IS DISTINCT FROM scope.principal_id OR again.school_id IS DISTINCT FROM scope.school_id THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('photo', hon.creative_photo_consent_json(made, scope.principal_id), 'replayed', false);
END $$;

-- READ: your own consents at this school (any standing, so you can always find and delete yours); a live school owner
-- also sees every staff member's consent, so they can honour a deletion request. Newest 50. Never the image.
CREATE FUNCTION hon.read_creative_avatar_photos(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE me uuid; owner boolean; list jsonb;
BEGIN
  me := hon.creative_photo_principal(p_subject);
  IF p_school IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  owner := EXISTS (SELECT 1 FROM hon.school_owner_grant_rows(p_school, clock_timestamp()) o WHERE o.o_principal = me AND o.o_live AND NOT o.o_hq);
  SELECT coalesce(jsonb_agg(hon.creative_photo_consent_json(c, me) ORDER BY c.created_at DESC, c.id DESC), '[]'::jsonb) INTO list
    FROM (SELECT * FROM hon.creative_avatar_photo_consents WHERE school_id = p_school AND (subject_principal_id = me OR owner)
      ORDER BY created_at DESC, id DESC LIMIT 50) c;
  RETURN jsonb_build_object('photos', list, 'canManageAll', owner, 'limit', 50);
END $$;

-- READ the image: only the person in it, only while it is stored.
CREATE FUNCTION hon.read_creative_avatar_photo_image(p_subject text, p_school uuid, p_consent uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE me uuid; ph hon.creative_avatar_photos%ROWTYPE;
BEGIN
  me := hon.creative_photo_principal(p_subject);
  SELECT * INTO ph FROM hon.creative_avatar_photos WHERE consent_id = p_consent AND school_id = p_school AND subject_principal_id = me;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('consentId', ph.consent_id, 'contentType', ph.content_type, 'photo', translate(encode(ph.bytes, 'base64'), E'\n', ''));
END $$;

-- DELETE: erase the bytes now and withdraw the likeness. The person in the photo can always do this; a live school owner
-- can do it for them. Repeating it answers the withdrawn state.
CREATE FUNCTION hon.delete_creative_avatar_photo(p_subject text, p_school uuid, p_consent uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE me uuid; c hon.creative_avatar_photo_consents%ROWTYPE; reason text;
BEGIN
  me := hon.creative_photo_principal(p_subject);
  SELECT * INTO c FROM hon.creative_avatar_photo_consents WHERE id = p_consent AND school_id = p_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF c.subject_principal_id = me THEN reason := 'DELETED_BY_SUBJECT';
  ELSIF EXISTS (SELECT 1 FROM hon.school_owner_grant_rows(c.school_id, clock_timestamp()) o WHERE o.o_principal = me AND o.o_live AND NOT o.o_hq) THEN
    reason := 'DELETED_BY_OWNER';
  ELSE RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.creative.photo:' || c.school_id::text || ':' || c.subject_principal_id::text, 0));
  -- Waits for any in-flight photo avatar or video request that holds this likeness (FOR SHARE) to commit first.
  PERFORM 1 FROM hon.creative_avatar_photo_consents WHERE id = c.id FOR UPDATE;
  DELETE FROM hon.creative_avatar_photos WHERE consent_id = c.id;
  INSERT INTO hon.creative_avatar_photo_withdrawals(consent_id, school_id, withdrawn_by_principal_id, reason, withdrawn_at)
    VALUES (c.id, c.school_id, me, reason, clock_timestamp())
    ON CONFLICT (consent_id) DO NOTHING;
  RETURN jsonb_build_object('photo', hon.creative_photo_consent_json(c, me));
END $$;

CREATE FUNCTION hon.creative_photo_avatar_fingerprint(p_school uuid, p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('schoolId', p_school, 'consentId', p->'consentId', 'name', p->'name', 'style', p->'style')::text, 'UTF8')), 'hex')
$$;

-- CREATE an avatar from your own live photo: one ordinary A1 avatar (avatar.create at the HQ rate, school wallet, every
-- CS1 rule), linked to the consent. Only the person in the photo can do this.
CREATE FUNCTION hon.create_creative_photo_avatar(p_subject text, p_school uuid, p jsonb, p_provider jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; fp text; link hon.creative_avatar_photo_links%ROWTYPE; c hon.creative_avatar_photo_consents%ROWTYPE; receipt jsonb;
  av hon.creative_avatars%ROWTYPE;
BEGIN
  IF p_key IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['consentId','name','style']
    OR coalesce(jsonb_typeof(p->'consentId'), '') <> 'string' OR (p->>'consentId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR coalesce(jsonb_typeof(p->'name'), '') <> 'string' OR NOT hon.creative_avatar_name_ok(p->>'name')
    OR coalesce(jsonb_typeof(p->'style'), '') <> 'string' OR (p->>'style') NOT IN ('REALISTIC','ILLUSTRATED','CHIBI') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  fp := hon.creative_photo_avatar_fingerprint(scope.school_id, p);
  SELECT * INTO link FROM hon.creative_avatar_photo_links WHERE created_by_principal_id = scope.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF link.request_fingerprint <> fp OR link.school_id <> scope.school_id THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    SELECT * INTO av FROM hon.creative_avatars WHERE id = link.avatar_id AND school_id = link.school_id;
    RETURN jsonb_build_object('avatar', hon.creative_avatar_json(av), 'balance', hon.saas_creative_balance_json(av.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  -- Your own photo only; anybody else's consent is simply not found.
  SELECT * INTO c FROM hon.creative_avatar_photo_consents WHERE id = (p->>'consentId')::uuid AND school_id = scope.school_id AND subject_principal_id = scope.principal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.creative.photo:' || c.school_id::text || ':' || c.subject_principal_id::text, 0));
  PERFORM 1 FROM hon.creative_avatar_photo_consents WHERE id = c.id FOR SHARE;
  IF NOT hon.creative_photo_consent_live(c.id) THEN RAISE EXCEPTION 'CREATIVE_AVATAR_WITHDRAWN' USING ERRCODE = '23514'; END IF;
  receipt := hon.create_creative_avatar(p_subject, scope.school_id,
    jsonb_build_object('name', p->'name', 'style', p->'style', 'description', 'An avatar of the staff member, made from their own consented photo.'),
    p_provider, md5('creative.avatar.photo:' || p_key::text)::uuid, p_request, p_correlation);
  SELECT * INTO av FROM hon.creative_avatars WHERE id = (receipt#>>'{avatar,avatarId}')::uuid AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_CREATIVE_LEDGER_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF (receipt->>'replayed')::boolean THEN
    SELECT * INTO link FROM hon.creative_avatar_photo_links WHERE created_by_principal_id = scope.principal_id AND idempotency_key = p_key;
    IF NOT FOUND OR link.request_fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('avatar', hon.creative_avatar_json(av), 'balance', hon.saas_creative_balance_json(av.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  INSERT INTO hon.creative_avatar_photo_links(avatar_id, school_id, consent_id, created_by_principal_id, idempotency_key, request_fingerprint, created_at)
    VALUES (av.id, av.school_id, c.id, scope.principal_id, p_key, fp, av.created_at);
  -- Finality after the writes (create_creative_avatar already re-checked authority, spend and eligibility): the likeness
  -- is still live under the lock.
  IF NOT hon.creative_photo_consent_live(c.id) THEN RAISE EXCEPTION 'CREATIVE_AVATAR_WITHDRAWN' USING ERRCODE = '23514'; END IF;
  RETURN jsonb_build_object('avatar', hon.creative_avatar_json(av), 'balance', receipt->'balance', 'replayed', false);
END $$;

-- ---------- Withdrawn likenesses disappear from the school reads and cannot be used for new videos ----------

-- Replaces the 0277 body (same signature, owner and ACL): a photo avatar's likeness must be live, under a share lock
-- that a deletion waits for, before anything is reserved and again after the writes.
CREATE OR REPLACE FUNCTION hon.create_creative_avatar_video(p_subject text, p_school uuid, p jsonb, p_provider jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; fp text; existing hon.creative_avatar_videos%ROWTYPE; av hon.creative_avatars%ROWTYPE; receipt jsonb; g hon.creative_generations%ROWTYPE;
  made hon.creative_avatar_videos%ROWTYPE; again record; at timestamptz; why text; e jsonb; consent uuid;
BEGIN
  IF p_key IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['avatarId','format','script','seconds']
    OR coalesce(jsonb_typeof(p->'avatarId'), '') <> 'string' OR (p->>'avatarId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR coalesce(jsonb_typeof(p->'seconds'), '') <> 'number' OR (p->>'seconds') !~ '^[1-9][0-9]?$' OR (p->>'seconds')::integer NOT BETWEEN 5 AND 60
    OR coalesce(jsonb_typeof(p->'format'), '') <> 'string' OR (p->>'format') NOT IN ('SQUARE','PORTRAIT','LANDSCAPE')
    OR coalesce(jsonb_typeof(p->'script'), '') <> 'string' OR NOT hon.creative_prompt_ok(p->>'script') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  fp := hon.creative_avatar_video_fingerprint(scope.school_id, p);
  SELECT * INTO existing FROM hon.creative_avatar_videos WHERE created_by_principal_id = scope.principal_id AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fp OR existing.school_id <> scope.school_id THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('video', hon.creative_avatar_video_json(existing), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  SELECT * INTO av FROM hon.creative_avatars WHERE id = (p->>'avatarId')::uuid AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT l.consent_id INTO consent FROM hon.creative_avatar_photo_links l WHERE l.avatar_id = av.id;
  IF consent IS NOT NULL THEN
    PERFORM 1 FROM hon.creative_avatar_photo_consents WHERE id = consent FOR SHARE;
    IF NOT hon.creative_photo_consent_live(consent) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.creative_generations cg WHERE cg.id = av.generation_id AND cg.school_id = av.school_id
      AND hon.creative_generation_json(cg)->>'status' = 'SUCCEEDED') THEN
    RAISE EXCEPTION 'CREATIVE_AVATAR_NOT_READY' USING ERRCODE = '23514';
  END IF;
  receipt := hon.create_creative_generation(p_subject, scope.school_id,
    jsonb_build_object('operationCode', 'avatar.video', 'units', p->'seconds', 'format', p->'format', 'prompt', p->'script'),
    p_provider, md5('creative.avatar.video:' || p_key::text)::uuid, p_request, p_correlation);
  IF (receipt->>'replayed')::boolean THEN
    SELECT * INTO existing FROM hon.creative_avatar_videos WHERE created_by_principal_id = scope.principal_id AND idempotency_key = p_key;
    IF NOT FOUND OR existing.request_fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('video', hon.creative_avatar_video_json(existing), 'balance', hon.saas_creative_balance_json(existing.school_id, clock_timestamp()), 'replayed', true);
  END IF;
  SELECT * INTO g FROM hon.creative_generations WHERE id = (receipt#>>'{generation,generationId}')::uuid AND school_id = scope.school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_CREATIVE_LEDGER_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF g.media_kind <> 'VIDEO' OR g.units <> (p->>'seconds')::integer OR g.operation_code <> 'avatar.video' THEN
    RAISE EXCEPTION 'CREATIVE_AVATAR_RATE_INVALID' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.creative_avatar_videos(school_id, organization_id, avatar_id, created_by_principal_id, idempotency_key, request_fingerprint, script, seconds, format, generation_id, created_at)
    VALUES (g.school_id, g.organization_id, av.id, scope.principal_id, p_key, fp, p->>'script', (p->>'seconds')::integer, p->>'format', g.id, g.created_at)
    RETURNING * INTO made;
  at := clock_timestamp();
  SELECT * INTO again FROM hon.require_saas_school_actor(p_subject, scope.school_id) LIMIT 1;
  IF again.principal_id IS DISTINCT FROM scope.principal_id OR again.school_id IS DISTINCT FROM scope.school_id THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  why := hon.ai_spend_allowed(scope.organization_id, at, 'CREATIVE_MEDIA');
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || why USING ERRCODE = '23514'; END IF;
  e := hon.saas_creative_eligibility(scope.school_id, at);
  IF NOT (e->>'eligible')::boolean THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514'; END IF;
  IF consent IS NOT NULL AND NOT hon.creative_photo_consent_live(consent) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('video', hon.creative_avatar_video_json(made), 'balance', receipt->'balance', 'replayed', false);
END $$;

-- Replaces the 0276/0277/0216 school reads (same signatures, owner and ACL): withdrawn likenesses are filtered out
-- before ordering and the limit; a single read of one answers "not available".
CREATE OR REPLACE FUNCTION hon.read_creative_avatars(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; list jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(hon.creative_avatar_json(a) ORDER BY a.created_at DESC, a.id DESC), '[]'::jsonb) INTO list
    FROM (SELECT * FROM hon.creative_avatars x WHERE x.school_id = scope.school_id AND NOT hon.creative_avatar_withdrawn(x.id)
      ORDER BY created_at DESC, id DESC LIMIT 50) a;
  RETURN jsonb_build_object('avatars', list, 'limit', 50);
END $$;

CREATE OR REPLACE FUNCTION hon.read_creative_avatar(p_subject text, p_school uuid, p_avatar uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; a hon.creative_avatars%ROWTYPE;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO a FROM hon.creative_avatars WHERE id = p_avatar AND school_id = scope.school_id;
  IF NOT FOUND OR hon.creative_avatar_withdrawn(a.id) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.creative_avatar_json(a);
END $$;

CREATE OR REPLACE FUNCTION hon.read_creative_avatar_videos(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; list jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(hon.creative_avatar_video_json(v) ORDER BY v.created_at DESC, v.id DESC), '[]'::jsonb) INTO list
    FROM (SELECT * FROM hon.creative_avatar_videos x WHERE x.school_id = scope.school_id AND NOT hon.creative_avatar_withdrawn(x.avatar_id)
      ORDER BY created_at DESC, id DESC LIMIT 50) v;
  RETURN jsonb_build_object('videos', list, 'limit', 50);
END $$;

CREATE OR REPLACE FUNCTION hon.read_creative_avatar_video(p_subject text, p_school uuid, p_video uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; v hon.creative_avatar_videos%ROWTYPE;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO v FROM hon.creative_avatar_videos WHERE id = p_video AND school_id = scope.school_id;
  IF NOT FOUND OR hon.creative_avatar_withdrawn(v.avatar_id) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.creative_avatar_video_json(v);
END $$;

CREATE OR REPLACE FUNCTION hon.read_creative_generations(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; list jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(hon.creative_generation_json(g) ORDER BY g.created_at DESC, g.id DESC), '[]'::jsonb) INTO list
    FROM (SELECT * FROM hon.creative_generations x WHERE x.school_id = scope.school_id AND NOT hon.creative_generation_withdrawn(x.id)
      ORDER BY created_at DESC, id DESC LIMIT 50) g;
  RETURN jsonb_build_object('generations', list, 'limit', 50);
END $$;

CREATE OR REPLACE FUNCTION hon.read_creative_generation(p_subject text, p_school uuid, p_generation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; g hon.creative_generations%ROWTYPE;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO g FROM hon.creative_generations WHERE id = p_generation AND school_id = scope.school_id;
  IF NOT FOUND OR hon.creative_generation_withdrawn(g.id) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.creative_generation_json(g);
END $$;

-- ---------- ACL: four private deny-all tables; five new runtime entry points ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['creative_avatar_photo_consents','creative_avatar_photos','creative_avatar_photo_withdrawals','creative_avatar_photo_links'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE', t, r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE', col, t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I CASCADE', col, t, r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace
      AND p.proname IN ('creative_photo_signature_ok','creative_photo_bytes_ok','guard_creative_avatar_photo','creative_photo_principal',
        'creative_photo_subject_live','creative_photo_consent_live','creative_avatar_withdrawn','creative_generation_withdrawn',
        'creative_photo_consent_json','creative_photo_fingerprint','upload_creative_avatar_photo','read_creative_avatar_photos',
        'read_creative_avatar_photo_image','delete_creative_avatar_photo','creative_photo_avatar_fingerprint','create_creative_photo_avatar') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.upload_creative_avatar_photo(text,uuid,jsonb,text,uuid), hon.read_creative_avatar_photos(text,uuid),
      hon.read_creative_avatar_photo_image(text,uuid,uuid), hon.delete_creative_avatar_photo(text,uuid,uuid),
      hon.create_creative_photo_avatar(text,uuid,jsonb,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
