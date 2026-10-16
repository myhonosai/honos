BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Registration requires trusted migration owner'; END IF;
END $$;

-- The dashboard must bind this private confirmation to the exact verified
-- operations-report school. Keep the existing selector-free receipt authority
-- link, but include no extra source data.
CREATE OR REPLACE FUNCTION hon.read_owner_launch_saved_students(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 WITH own_receipts AS (
  SELECT r.id AS registration_id,r.student_profile_id,r.created_at,'NEW_ADULT_NO_GUARDIAN'::text AS registration_kind
  FROM hon.student_registration_receipts r
  WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
  UNION ALL
  SELECT r.id AS registration_id,r.student_profile_id,r.created_at,'NEW_CHILD_WITH_NEW_GUARDIAN'::text AS registration_kind
  FROM hon.guardian_child_registration_receipts r
  WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
 ), current_students AS (
  SELECT r.registration_id,r.student_profile_id,
   left(btrim(regexp_replace(concat_ws(' ',p.given_name,p.family_name),'[[:cntrl:]<>]','','g')),160) AS display_name,
   r.created_at,r.registration_kind
  FROM own_receipts r
  JOIN hon.student_profiles s ON s.id=r.student_profile_id AND s.organization_id=org AND s.school_id=school
  JOIN hon.people p ON p.id=s.person_id AND p.organization_id=org AND p.school_id=school
  WHERE nullif(btrim(regexp_replace(concat_ws(' ',p.given_name,p.family_name),'[[:cntrl:]<>]','','g')),'') IS NOT NULL
 ), bounded AS (
  SELECT * FROM current_students ORDER BY created_at DESC,registration_id DESC LIMIT 5
 ), payload AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
   'registrationId',registration_id,'studentProfileId',student_profile_id,'displayName',display_name,
   'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'registrationKind',registration_kind,'status','REGISTERED_NO_BOOKING'
  ) ORDER BY created_at DESC,registration_id DESC),'[]'::jsonb) AS registrations FROM bounded
 )
 SELECT jsonb_build_object(
  'organizationId',org,'schoolId',school,
  'state',CASE WHEN jsonb_array_length(registrations)=0 THEN 'NO_RECORDED_REGISTRATIONS' ELSE 'RECORDED_REGISTRATIONS' END,
  'registrations',registrations
 ) INTO result FROM payload;
 PERFORM hon.require_owner_launch_actor(p_subject);
 RETURN result;
END $$;

COMMIT;
