BEGIN;

-- Attendance card photos: U.S.-only policy (0413, coordinator-allocated 2026-11-16, owner David 2026-11-16 21:44Z).
--
-- * HON OS serves U.S. schools first. The 0394 place-based photo consent logic (EU GDPR, UK GDPR, South Korea PIPA and
--   unreviewed places, read from the 0392 school location) no longer applies to attendance cards. A student's photo
--   prints on the school's internal attendance card by default; no separate parent consent step is needed for that.
-- * A school may turn on its own "parent photo approval" policy (photo_approval_required, default off). While it is on, a
--   card prints the photo only after staff record the parent's (or adult student's) approval through the unchanged
--   hon.set_student_photo_consent; otherwise the card prints initials. Turning it off again keeps every recorded approval.
-- * hon.student_photo_consent_rules (0394) stays in place, immutable and unused by cards: rows are history, not policy.
--   0392 locations and the face check-in rules are not touched.
-- * Internal attendance use only: nothing here authorizes marketing or public use of a photo. Photos are still uploaded
--   by staff only (0390, people.update), private to the school, and hard-deleted on removal.
-- * Not legally approved. The compliance assessment stays pending U.S. legal review.
-- CREATE OR REPLACE keeps each function's owner, SECURITY DEFINER setting and grants (0394 and infra 010/011 unchanged).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.configure_attendance_cards(text,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.attendance_photo_consent_rule(uuid,uuid)') IS NULL OR to_regclass('hon.attendance_card_settings') IS NULL THEN
    RAISE EXCEPTION '0413 requires 0394'; END IF;
END $$;

ALTER TABLE hon.attendance_card_settings ADD COLUMN photo_approval_required boolean NOT NULL DEFAULT false;
COMMENT ON TABLE hon.student_photo_consent_rules IS
  'Superseded by 0413 (U.S.-only card photo policy): history only, no longer read by attendance cards.';

-- Whether this school asks for parent approval before a card prints a student's photo: only the school's own setting.
CREATE OR REPLACE FUNCTION hon.attendance_photo_consent_rule(p_org uuid,p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN coalesce(s.photo_approval_required,false) THEN jsonb_build_object('required',true,'profile',NULL,'reason','SCHOOL_POLICY')
    ELSE jsonb_build_object('required',false,'profile',NULL,'reason','OFF') END
  FROM (SELECT p_school sid) q LEFT JOIN hon.attendance_card_settings s ON s.school_id=q.sid AND s.organization_id=p_org
$$;

CREATE OR REPLACE FUNCTION hon.attendance_card_settings_json(p_org uuid,p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('codeType',coalesce(s.code_type,'QR'),'showPhoto',coalesce(s.show_photo,true),'showLogo',coalesce(s.show_logo,true),
    'design',coalesce(s.design,'CLASSIC'),'photoApprovalRequired',coalesce(s.photo_approval_required,false),
    'version',coalesce(s.version,0),'updatedAt',hon.saas_ts(s.updated_at),
    'schoolName',sc.name,'logoUrl',b.logo_url,'accentColor',b.accent_color,'photoConsent',hon.attendance_photo_consent_rule(p_org,p_school))
  FROM hon.schools sc LEFT JOIN hon.attendance_card_settings s ON s.school_id=sc.id AND s.organization_id=sc.organization_id
    LEFT JOIN hon.school_page_branding b ON b.school_id=sc.id AND b.organization_id=sc.organization_id
  WHERE sc.id=p_school AND sc.organization_id=p_org
$$;

-- Settings input is now exactly {codeType, design, expectedVersion, photoApprovalRequired, showLogo, showPhoto}.
CREATE OR REPLACE FUNCTION hon.configure_attendance_cards(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); cur hon.attendance_card_settings%ROWTYPE; nxt hon.attendance_card_settings%ROWTYPE;
BEGIN
  SELECT * INTO s FROM hon.attendance_card_begin(p_subject,'settings',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['codeType','design','expectedVersion','photoApprovalRequired','showLogo','showPhoto']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p_input->'codeType') IS DISTINCT FROM 'string' OR p_input->>'codeType' NOT IN ('BARCODE','QR')
    OR jsonb_typeof(p_input->'design') IS DISTINCT FROM 'string' OR p_input->>'design' NOT IN ('CLASSIC','BOLD','MINIMAL')
    OR jsonb_typeof(p_input->'showPhoto') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'showLogo') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_input->'photoApprovalRequired') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'ATTENDANCE_CARDS_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('attendance-card-settings:'||school::text,0));
  SELECT * INTO cur FROM hon.attendance_card_settings WHERE school_id=school AND organization_id=org FOR UPDATE;
  IF coalesce(cur.version,0)<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF cur.school_id IS NULL THEN
    INSERT INTO hon.attendance_card_settings(school_id,organization_id,code_type,show_photo,show_logo,design,photo_approval_required,updated_by_principal_id)
      VALUES(school,org,p_input->>'codeType',(p_input->>'showPhoto')::boolean,(p_input->>'showLogo')::boolean,p_input->>'design',
        (p_input->>'photoApprovalRequired')::boolean,s.actor) RETURNING * INTO nxt;
  ELSE
    UPDATE hon.attendance_card_settings SET code_type=p_input->>'codeType',show_photo=(p_input->>'showPhoto')::boolean,show_logo=(p_input->>'showLogo')::boolean,
      design=p_input->>'design',photo_approval_required=(p_input->>'photoApprovalRequired')::boolean,version=version+1,updated_by_principal_id=s.actor,
      updated_at=clock_timestamp() WHERE school_id=school RETURNING * INTO nxt;
  END IF;
  RETURN hon.attendance_card_finish(p_subject,s.actor,'settings','ATTENDANCE_CARD_SETTINGS',school,
    jsonb_build_object('codeType',nxt.code_type,'showPhoto',nxt.show_photo,'showLogo',nxt.show_logo,'design',nxt.design,
      'photoApprovalRequired',nxt.photo_approval_required,'version',nxt.version),
    p_key,p_request,p_correlation,hon.attendance_card_settings_json(org,school));
END $$;

DO $$ BEGIN
  IF hon.attendance_photo_consent_rule(gen_random_uuid(),gen_random_uuid())->>'required'<>'false' THEN
    RAISE EXCEPTION '0413 default must not require photo approval'; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid='hon.configure_attendance_cards(text,jsonb,text,uuid,uuid)'::regprocedure)
    OR (SELECT prosecdef FROM pg_proc WHERE oid='hon.attendance_photo_consent_rule(uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION '0413 changed a function security setting'; END IF;
END $$;

COMMIT;
