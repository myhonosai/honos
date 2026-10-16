BEGIN;
-- 0120 emitted a harmless trailing space when a redacted family name is blank.
-- Repair the safe parent projection without altering its authority, field, cap or ACL boundary.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Parent ClassPass projection repair requires trusted migration owner';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION hon.read_parent_classpass_view(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE scope record; scope_count integer; children jsonb;
BEGIN
 IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject THEN
  RAISE EXCEPTION 'PARENT_CLASSPASS_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 SELECT count(*) INTO scope_count FROM hon.resolve_parent_journey_scopes(p_subject);
 IF scope_count<>1 THEN RAISE EXCEPTION 'PARENT_CLASSPASS_SCOPE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 SELECT * INTO scope FROM hon.resolve_parent_journey_scopes(p_subject);
 IF scope.access_level NOT IN('PRIMARY_GUARDIAN'::hon.family_access_level,'SECONDARY_GUARDIAN'::hon.family_access_level) THEN
  RAISE EXCEPTION 'PARENT_CLASSPASS_GUARDIAN_REQUIRED' USING ERRCODE='42501';
 END IF;
 -- Existing family STUDENT membership plus ACTIVE profile, never a school roster
 -- or primary_family_id guess. No identifiers cross this read boundary.
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.student_id),'[]'::jsonb) INTO children FROM (
  SELECT student.id student_id,jsonb_build_object(
   'displayName',btrim(concat_ws(' ',person.given_name,person.family_name)),
   'passes',jsonb_build_object('items',CASE WHEN jsonb_array_length(passes.items)>20 THEN passes.items-20 ELSE passes.items END,'limited',jsonb_array_length(passes.items)>20)
  ) item
  FROM hon.family_members member JOIN hon.student_profiles student
   ON student.person_id=member.person_id AND student.organization_id=member.organization_id AND student.school_id=member.school_id AND student.status='ACTIVE'
  JOIN hon.people person ON person.id=student.person_id AND person.organization_id=student.organization_id AND person.school_id=student.school_id
  CROSS JOIN LATERAL (
   SELECT coalesce(jsonb_agg(y.item ORDER BY y.issued_at DESC,y.pass_id),'[]'::jsonb) items FROM (
    SELECT pass.id pass_id,pass.issued_at,jsonb_build_object(
     'productDisplayName',pass.product_name,'remainingUses',pass.remaining_uses,
     'expiresAt',to_char(pass.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'status',CASE WHEN pass.status='REVERSED' THEN 'REVERSED' WHEN pass.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE pass.status END,
     'bookings',jsonb_build_object('items',CASE WHEN jsonb_array_length(bookings.items)>10 THEN bookings.items-10 ELSE bookings.items END,'limited',jsonb_array_length(bookings.items)>10)
    ) item FROM hon.classpass_passes pass
    CROSS JOIN LATERAL (
     SELECT coalesce(jsonb_agg(z.item ORDER BY z.starts_at DESC,z.booking_id),'[]'::jsonb) items FROM (
      SELECT booking.id booking_id,session.starts_at,jsonb_build_object(
       'startsAt',to_char(session.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       'bookingStatus',booking.status::text,
       'redemptionOutcome',CASE WHEN EXISTS(SELECT 1 FROM hon.classpass_ledger reversal JOIN hon.classpass_ledger debit ON debit.id=reversal.reverses_ledger_id AND debit.organization_id=reversal.organization_id AND debit.school_id=reversal.school_id AND debit.pass_id=reversal.pass_id WHERE debit.pass_id=pass.id AND debit.organization_id=pass.organization_id AND debit.school_id=pass.school_id AND debit.class_booking_id=booking.id AND debit.kind='REDEMPTION' AND reversal.kind='REDEMPTION_REVERSAL') THEN 'REVERSED'
        WHEN EXISTS(SELECT 1 FROM hon.classpass_ledger debit WHERE debit.pass_id=pass.id AND debit.organization_id=pass.organization_id AND debit.school_id=pass.school_id AND debit.class_booking_id=booking.id AND debit.kind='REDEMPTION') THEN 'REDEEMED' ELSE 'NOT_REDEEMED' END,
       'attendanceState',coalesce((SELECT attendance.status::text FROM hon.attendance_records attendance WHERE attendance.organization_id=booking.organization_id AND attendance.school_id=booking.school_id AND attendance.class_session_id=booking.class_session_id AND attendance.student_profile_id=booking.student_profile_id),'NOT_RECORDED')
      ) item FROM hon.class_bookings booking JOIN hon.class_sessions session
       ON session.id=booking.class_session_id AND session.organization_id=booking.organization_id AND session.school_id=booking.school_id
      WHERE booking.classpass_id=pass.id AND booking.booking_kind='CLASS_PASS' AND booking.organization_id=pass.organization_id AND booking.school_id=pass.school_id AND booking.student_profile_id=student.id
      ORDER BY session.starts_at DESC,booking.id LIMIT 11
     ) z
    ) bookings
    WHERE pass.student_profile_id=student.id AND pass.organization_id=scope.organization_id AND pass.school_id=scope.school_id
    ORDER BY pass.issued_at DESC,pass.id LIMIT 21
   ) y
  ) passes
  WHERE member.family_id=scope.family_id AND member.organization_id=scope.organization_id AND member.school_id=scope.school_id AND member.member_role='STUDENT'
  ORDER BY student.id LIMIT 21
 ) x;
 RETURN jsonb_build_object('generatedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'accessLevel',scope.access_level::text,'paymentProviderOutcome','UNAVAILABLE',
  'children',jsonb_build_object('items',CASE WHEN jsonb_array_length(children)>20 THEN children-20 ELSE children END,'limited',jsonb_array_length(children)>20));
END $$;
REVOKE ALL ON FUNCTION hon.read_parent_classpass_view(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_parent_classpass_view(text) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.read_parent_classpass_view(text) TO hon_runtime; END IF;
END $$;
COMMIT;
