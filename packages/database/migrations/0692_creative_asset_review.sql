BEGIN;

-- C4 (0692): human approval of creative assets. docs/architecture/CREATIVE_AI_IMAGE_VIDEO_PROVIDERS.md §6 / §13.
-- Provider-free: nothing here calls a provider, a storage service or an AI model, and no program is activated.
--
-- Every asset starts PENDING_REVIEW (no review row). A direct human of the asset's exact school who is a creative
-- actor (the 0216 actor: ai.premium.request) AND holds marketing.social.manage records APPROVED or REJECTED. The
-- requester may approve their own asset when they hold both (owner decision §10.3, proposed yes). The AI team can never
-- review: the SaaS actor refuses every delegated, action-request or session context (0154 saas_refuse_context).
-- Decisions are append-only evidence (who and when). An approval can later be withdrawn by a rejection; a rejection is
-- final. While an asset is not APPROVED, only its requester and reviewers may view it; once APPROVED, the school's
-- creative staff may. Only the requester or a reviewer may delete an asset. Later slices (C5 posts and ads, avatar looks) accept only APPROVED assets and re-check at use.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON creative asset review requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.creative_school_object(text,uuid,uuid,boolean)') IS NULL
    OR to_regclass('hon.creative_stored_objects') IS NULL
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code = 'marketing.social.manage' AND is_staff_assignable) THEN
    RAISE EXCEPTION 'HON creative asset review requires creative media storage (0691) and school social permissions (0347)';
  END IF;
END $$;

CREATE TABLE hon.creative_asset_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES hon.creative_generation_assets(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reviewed_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL,
  -- At most one approval and one rejection per asset; a rejection is final, so nothing follows it.
  UNIQUE (asset_id, decision)
);
CREATE INDEX creative_asset_reviews_school ON hon.creative_asset_reviews (school_id, asset_id);

CREATE FUNCTION hon.guard_creative_asset_review() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  RAISE EXCEPTION 'creative asset reviews are append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER creative_asset_review_guarded BEFORE UPDATE OR DELETE ON hon.creative_asset_reviews FOR EACH ROW EXECUTE FUNCTION hon.guard_creative_asset_review();
CREATE TRIGGER creative_asset_review_no_truncate BEFORE TRUNCATE ON hon.creative_asset_reviews FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_creative_asset_review();

-- ---------- private helpers ----------
CREATE FUNCTION hon.creative_asset_review_status(p_asset uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM hon.creative_asset_reviews r WHERE r.asset_id = p_asset AND r.decision = 'REJECTED') THEN 'REJECTED'
    WHEN EXISTS (SELECT 1 FROM hon.creative_asset_reviews r WHERE r.asset_id = p_asset AND r.decision = 'APPROVED') THEN 'APPROVED'
    ELSE 'PENDING_REVIEW' END
$$;

-- The live marketing.social.manage grant at the exact school (same grant rules as the 0156 SaaS actor).
CREATE FUNCTION hon.creative_reviewer_holds(p_principal uuid, p_org uuid, p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
    JOIN hon.role_permissions rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
    JOIN hon.permissions perm ON perm.code = rp.permission_code
    WHERE g.principal_id = p_principal AND g.organization_id = p_org AND g.school_id = p_school
      AND perm.code = 'marketing.social.manage' AND perm.is_staff_assignable
      AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (r.management_school_id IS NULL OR r.management_school_id = p_school)
      AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;

-- ---------- school commands and reads (hon_runtime) ----------
-- APPROVE or REJECT one stored, undeleted asset of the caller's exact school. Idempotent: the same decision again answers
-- with the recorded one. APPROVED after REJECTED is refused.
CREATE FUNCTION hon.review_creative_asset(p_subject text, p_school uuid, p_asset uuid, p_decision text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; obj hon.creative_stored_objects%ROWTYPE; current_status text; rec hon.creative_asset_reviews%ROWTYPE;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('APPROVED','REJECTED') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  obj := hon.creative_school_object(p_subject, p_school, p_asset, true); -- exact school, creative actor, row lock on the object
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  IF NOT hon.creative_reviewer_holds(scope.principal_id, scope.organization_id, scope.school_id) THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF obj.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  current_status := hon.creative_asset_review_status(obj.asset_id);
  IF current_status = 'REJECTED' AND p_decision = 'APPROVED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF current_status <> p_decision THEN
    INSERT INTO hon.creative_asset_reviews(asset_id, school_id, decision, reviewed_by_principal_id, reviewed_at)
      VALUES (obj.asset_id, obj.school_id, p_decision, scope.principal_id, clock_timestamp());
  END IF;
  SELECT * INTO rec FROM hon.creative_asset_reviews WHERE asset_id = obj.asset_id AND decision = p_decision;
  RETURN jsonb_build_object('assetId', obj.asset_id, 'review', p_decision, 'reviewedAt', hon.saas_ts(rec.reviewed_at),
    'reviewedBySelf', rec.reviewed_by_principal_id = scope.principal_id);
END $$;

-- A read grant (0691 replaced, same shape): an asset that is not APPROVED is visible only to its requester and to
-- reviewers of the school.
CREATE OR REPLACE FUNCTION hon.authorize_creative_asset_read(p_subject text, p_school uuid, p_asset uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE obj hon.creative_stored_objects%ROWTYPE; scope record; requester uuid;
BEGIN
  obj := hon.creative_school_object(p_subject, p_school, p_asset, false);
  IF obj.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF hon.creative_asset_review_status(obj.asset_id) <> 'APPROVED' THEN
    SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
    SELECT g.requested_by_principal_id INTO requester FROM hon.creative_generation_assets a
      JOIN hon.creative_generations g ON g.id = a.generation_id AND g.school_id = a.school_id WHERE a.id = obj.asset_id;
    IF requester IS DISTINCT FROM scope.principal_id AND NOT hon.creative_reviewer_holds(scope.principal_id, scope.organization_id, scope.school_id) THEN
      RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; -- not "forbidden": the asset is not listed for this person
    END IF;
  END IF;
  RETURN jsonb_build_object('assetId', obj.asset_id, 'storageKey', obj.storage_key, 'mediaType', obj.media_type, 'byteSize', obj.byte_size);
END $$;

-- DELETE (0691 replaced, same shape): only the asset's requester or a reviewer of the school may delete it.
CREATE OR REPLACE FUNCTION hon.delete_creative_asset(p_subject text, p_school uuid, p_asset uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE obj hon.creative_stored_objects%ROWTYPE; scope record; requester uuid;
BEGIN
  obj := hon.creative_school_object(p_subject, p_school, p_asset, true);
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT g.requested_by_principal_id INTO requester FROM hon.creative_generation_assets a
    JOIN hon.creative_generations g ON g.id = a.generation_id AND g.school_id = a.school_id WHERE a.id = obj.asset_id;
  IF requester IS DISTINCT FROM scope.principal_id AND NOT hon.creative_reviewer_holds(scope.principal_id, scope.organization_id, scope.school_id) THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF obj.deleted_at IS NULL THEN
    UPDATE hon.creative_stored_objects SET deleted_at = clock_timestamp(), deleted_by_principal_id = scope.principal_id WHERE id = obj.id RETURNING * INTO obj;
  END IF;
  RETURN jsonb_build_object('assetId', obj.asset_id, 'storageKey', CASE WHEN obj.removed_at IS NULL THEN obj.storage_key END,
    'deletedAt', hon.saas_ts(obj.deleted_at), 'removed', obj.removed_at IS NOT NULL);
END $$;

-- The review queue: the school's stored, undeleted assets waiting for review, oldest first (reviewers only).
CREATE FUNCTION hon.list_creative_review_queue(p_subject text, p_school uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  IF scope.principal_id IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT hon.creative_reviewer_holds(scope.principal_id, scope.organization_id, scope.school_id) THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Ordered by the millisecond the answer shows (saas_ts), then the id, so the order a client sees is strictly increasing.
  RETURN jsonb_build_object('limit', p_limit, 'assets', coalesce((SELECT jsonb_agg(q.item ORDER BY q.stored_ms, q.asset_id) FROM (
      SELECT date_trunc('milliseconds', o.stored_at) AS stored_ms, o.asset_id, jsonb_build_object('assetId', a.id, 'generationId', a.generation_id, 'ordinal', a.ordinal,
        'mediaType', a.media_type, 'width', a.width, 'height', a.height, 'durationSeconds', a.duration_seconds,
        'storedAt', hon.saas_ts(o.stored_at), 'requestedBySelf', g.requested_by_principal_id = scope.principal_id) AS item
      FROM hon.creative_stored_objects o JOIN hon.creative_generation_assets a ON a.id = o.asset_id AND a.school_id = o.school_id
      JOIN hon.creative_generations g ON g.id = a.generation_id AND g.school_id = a.school_id
      WHERE o.school_id = scope.school_id AND o.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hon.creative_asset_reviews r WHERE r.asset_id = a.id)
      ORDER BY date_trunc('milliseconds', o.stored_at), o.asset_id LIMIT p_limit) q), '[]'::jsonb));
END $$;

-- School view (0691 replaced): each listed asset carries its review status.
CREATE OR REPLACE FUNCTION hon.creative_generation_json(g hon.creative_generations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('generationId', g.id, 'schoolId', g.school_id, 'operationCode', g.operation_code, 'mediaKind', g.media_kind,
    'units', g.units, 'format', g.format, 'prompt', g.prompt,
    'status', CASE r.status
      WHEN 'RESERVED' THEN 'GENERATING'
      WHEN 'OUTCOME_UNKNOWN' THEN 'UNDER_REVIEW'
      WHEN 'FINALIZED' THEN CASE WHEN g.phase = 'RESULT_RECORDED' THEN 'SUCCEEDED' ELSE 'RESOLVED_CHARGED' END
      ELSE CASE WHEN g.phase IN ('PROVIDER_FAILED','NOT_SENT') THEN 'FAILED' ELSE 'RESOLVED_NOT_CHARGED' END END,
    'failureReason', CASE WHEN r.status = 'OUTCOME_UNKNOWN' THEN coalesce(g.failure_reason, 'PROVIDER_UNKNOWN')
      WHEN r.status = 'FINALIZED' AND g.phase = 'RESULT_RECORDED' THEN NULL ELSE g.failure_reason END,
    'reservedCredits', r.reserved_credits,
    'chargedCredits', CASE WHEN r.status = 'FINALIZED' THEN r.final_credits END,
    'createdAt', hon.saas_ts(g.created_at),
    'completedAt', CASE WHEN r.status = 'RESERVED' THEN NULL ELSE hon.saas_ts(coalesce(g.completed_at, r.settled_at)) END,
    'assets', CASE WHEN r.status = 'FINALIZED' AND g.phase = 'RESULT_RECORDED' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('assetId', a.id, 'ordinal', a.ordinal,
        'mediaType', a.media_type, 'width', a.width, 'height', a.height, 'durationSeconds', a.duration_seconds, 'origin', a.origin,
        'review', hon.creative_asset_review_status(a.id)) ORDER BY a.ordinal)
      FROM hon.creative_generation_assets a WHERE a.generation_id = g.id AND a.school_id = g.school_id
        AND NOT EXISTS (SELECT 1 FROM hon.creative_stored_objects o WHERE o.asset_id = a.id AND o.deleted_at IS NOT NULL)), '[]'::jsonb) ELSE '[]'::jsonb END)
  FROM hon.saas_creative_reservations r WHERE r.id = g.reservation_id AND r.school_id = g.school_id
$$;

-- ---------- ACL ----------
DO $$ DECLARE r text; col text; f text; BEGIN
  ALTER TABLE hon.creative_asset_reviews ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.creative_asset_reviews FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.creative_asset_reviews FROM PUBLIC CASCADE;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.creative_asset_reviews FROM %I CASCADE', r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = 'hon.creative_asset_reviews'::regclass AND attnum > 0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.creative_asset_reviews FROM PUBLIC CASCADE', col);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace
      AND p.proname IN ('guard_creative_asset_review','creative_asset_review_status','creative_reviewer_holds','review_creative_asset',
        'authorize_creative_asset_read','delete_creative_asset','list_creative_review_queue','creative_generation_json') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.authorize_creative_asset_read(text,uuid,uuid), hon.delete_creative_asset(text,uuid,uuid), hon.review_creative_asset(text,uuid,uuid,text),
      hon.list_creative_review_queue(text,uuid,integer) TO hon_runtime;
  END IF;
END $$;

COMMIT;
