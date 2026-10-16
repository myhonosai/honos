BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'ClassPass guard repair requires trusted migration owner';
 END IF;
END $$;
-- 0117 returned NEW on generic BEFORE DELETE, silently suppressing deletion and
-- breaking generic fixture cleanup. CLASS_PASS deletion remains forbidden.
CREATE OR REPLACE FUNCTION hon.guard_classpass_booking() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF (TG_OP<>'DELETE' AND NEW.booking_kind='CLASS_PASS') OR (TG_OP<>'INSERT' AND OLD.booking_kind='CLASS_PASS') THEN
  IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid)'::regprocedure)
   OR current_setting('app.hon_classpass_write',true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'CLASSPASS_FUNCTION_REQUIRED' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['status','cancelled_at','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancelled_at','version','updated_at']) OR NEW.version<>OLD.version+1)) THEN
   RAISE EXCEPTION 'CLASSPASS_BOOKING_IMMUTABLE' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hon.guard_classpass_booking() FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_classpass_booking() FROM %I',r);
 END LOOP;
END $$;
COMMIT;
