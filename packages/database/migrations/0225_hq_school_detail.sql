BEGIN;

-- C-HQ-3 HQ school detail (number 0225 proposed; the owner allocates the final number). One read-only HQ projection of one
-- school: the school, its organization's access standing exactly as the B-HQ-1 overview row shows it (0219), the
-- ownership summary (0223: owners, primary, HQ seats), owner/staff/family invitation counts, and people counts. It
-- returns no person names, emails, birth dates or tokens, writes nothing, takes no lock and changes no command.
-- Readers: an HQ owner, or an HQ operator with hq.billing.manage (the reader rule of every SaaS HQ read).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ school detail requires a trusted migration owner';
  END IF;
END $$;

-- Counts of one invitation table's rows at one school by derived status. Internal helper: never granted.
CREATE FUNCTION hon.hq_school_invitation_counts(p_kind text, p_school uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE r jsonb;
BEGIN
  WITH rows AS (
    SELECT status, expires_at FROM hon.school_owner_invitations WHERE p_kind = 'OWNER' AND school_id = p_school
    UNION ALL SELECT status, expires_at FROM hon.school_staff_invitations WHERE p_kind = 'STAFF' AND school_id = p_school
    UNION ALL SELECT status, expires_at FROM hon.school_family_access_invitations WHERE p_kind = 'FAMILY' AND school_id = p_school
  )
  SELECT jsonb_build_object(
    'pending', count(*) FILTER (WHERE status = 'PENDING' AND expires_at > p_at),
    'expired', count(*) FILTER (WHERE status = 'PENDING' AND expires_at <= p_at),
    'accepted', count(*) FILTER (WHERE status = 'ACCEPTED'),
    'revoked', count(*) FILTER (WHERE status = 'REVOKED'),
    'ended', count(*) FILTER (WHERE status = 'ENDED'))
  INTO r FROM rows;
  RETURN r;
END $$;

CREATE FUNCTION hon.read_hq_school_detail_from_hq(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; is_owner boolean; s hon.schools%ROWTYPE; ready boolean; at timestamptz := clock_timestamp();
  prim uuid; owners integer; hq_seats integer; result jsonb;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, false);
  IF p_school IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO s FROM hon.schools WHERE id = p_school;
  IF s.id IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  is_owner := EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = actor AND g.hq_role = 'HON_HQ_OWNER'
    AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()));
  ready := (hon.saas_exception_policy_ready()).id IS NOT NULL;
  prim := hon.school_live_primary_grant(p_school, at);
  SELECT count(*) FILTER (WHERE w.o_live AND NOT w.o_hq), count(*) FILTER (WHERE w.o_hq)
    INTO owners, hq_seats FROM hon.school_owner_grant_rows(p_school, at) w;

  result := jsonb_build_object(
    'school', jsonb_build_object('schoolId', s.id, 'schoolDisplayName', left(s.name, 300), 'slug', s.slug, 'timezone', s.timezone,
      'schoolStatus', s.status::text, 'createdAt', hon.saas_ts(s.created_at)),
    'organization', hon.saas_access_overview_row(s.organization_id, ready, at),
    'exceptionPolicyReady', ready,
    'ownership', jsonb_build_object('ownerCount', owners, 'primaryOwnerGrantId', prim, 'primaryNeeded', owners > 0 AND prim IS NULL,
      'hqSeatCount', hq_seats),
    'invitations', jsonb_build_object(
      'owner', hon.hq_school_invitation_counts('OWNER', p_school, at),
      'staff', hon.hq_school_invitation_counts('STAFF', p_school, at),
      'family', hon.hq_school_invitation_counts('FAMILY', p_school, at)),
    'people', jsonb_build_object(
      -- Distinct non-HQ principals with a started, unended, unrevoked role grant at this school (owners included).
      'staffWithAccess', (SELECT count(DISTINCT g.principal_id) FROM hon.principal_role_grants g
        WHERE g.school_id = p_school AND g.revoked_at IS NULL AND g.effective_from <= at AND (g.effective_until IS NULL OR g.effective_until > at)
          AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = g.principal_id)),
      'familyMembersWithAccess', (SELECT count(DISTINCT f.principal_id) FROM hon.family_access_grants f
        WHERE f.school_id = p_school AND f.effective_from <= at AND (f.effective_until IS NULL OR f.effective_until > at)),
      'activeStudents', (SELECT count(*) FROM hon.student_profiles WHERE school_id = p_school AND status = 'ACTIVE')),
    'viewer', jsonb_build_object('canGrantAndRevokeExceptions', is_owner, 'canManageOwnership', is_owner),
    'asOf', hon.saas_ts(at));
  -- Decide authority after the read (0206 rule): a reader revoked meanwhile gets nothing.
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hq_school_invitation_counts(text,uuid,timestamptz)','read_hq_school_detail_from_hq(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_school_detail_from_hq(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
