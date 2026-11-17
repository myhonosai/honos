BEGIN;

-- School demo data (0459, coordinator-allocated 2026-11-17).
-- Owner request (David, 2026-11-17): fill a school with fake contacts to try HON, then remove all of it with one action
-- before importing real data; a Settings button for every school that wants to try HON before trusting it with a real
-- import. Owner chose "everything at once": contacts, leads, classes, memberships, invoices and attendance.
-- Verified 2026-11-17 on main 51c1404: no seed or demo tooling for schools and no way to delete a contact.
-- Spec and plan: /mnt/project-files/sample-data/ (docs/architecture/SCHOOL_DEMO_DATA.md in the repository).
--   D1  Every row the load writes is registered in a demo set. Removal deletes only registered rows of that set (and
--       rows that staff added to demo people while trying HON), in one transaction, so it can never touch a real record.
--   D2  Load writes no outbox event, so no automation, AI, welcome or notification starts from demo rows.
--   D3  Demo people are never contacted and demo accounts never pay through a provider: inserts of outbound messages,
--       family app invitations and school-pay customers, payment method setups, autopay plans and charge attempts for a
--       demo person, family or billing account are refused in the database.
--   D4  Append-only guards let a row go only when it is registered in a set that is being removed in the current
--       transaction (hon.demo_data_removal_allows). Nothing else about those guards changes.
--   D5  If something real points at a demo record (a real student in a demo class, a real lead in the demo pipeline),
--       removal stops with DEMO_DATA_IN_USE and the table names, so staff can move it first.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'School demo data requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.membership_local_day_start(date,text)') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL
    OR to_regclass('hon.crm_pipeline_stages') IS NULL OR to_regclass('hon.communication_messages') IS NULL OR to_regclass('hon.school_pay_charge_attempts') IS NULL THEN
    RAISE EXCEPTION '0459 requires the membership, pipeline, communication and school-pay migrations'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('school.demo_data.manage','Load demo contacts, classes, memberships and attendance into the school to try HON, and remove them again',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='school.demo_data.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school.demo_data.manage already exists with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'school.demo_data.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' ON CONFLICT DO NOTHING;

-- ---------- D1: the registry ----------
CREATE TABLE hon.school_demo_data_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('LOADED','REMOVING','REMOVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 3),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts)='object'),
  removed_counts jsonb CHECK (removed_counts IS NULL OR jsonb_typeof(removed_counts)='object'),
  removing_xact text CHECK (removing_xact IS NULL OR removing_xact ~ '^[0-9]{1,20}$'),
  loaded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  loaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_by_principal_id uuid REFERENCES hon.principals(id),
  removed_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((status='REMOVING')=(removing_xact IS NOT NULL)),
  CHECK ((status='REMOVED')=(removed_at IS NOT NULL AND removed_by_principal_id IS NOT NULL AND removed_counts IS NOT NULL))
);
-- One demo set at a time per school.
CREATE UNIQUE INDEX school_demo_data_sets_one_active ON hon.school_demo_data_sets(school_id) WHERE status<>'REMOVED';
CREATE INDEX school_demo_data_sets_scope_idx ON hon.school_demo_data_sets(organization_id,school_id,loaded_at DESC);
CREATE TABLE hon.school_demo_data_rows (
  table_name text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  row_id uuid NOT NULL,
  -- The row's own uuid key: id, or the single uuid primary key of a one-to-one side table such as crm_lead_attributions.
  key_column text NOT NULL DEFAULT 'id' CHECK (key_column ~ '^[a-z][a-z0-9_]{0,62}$'),
  set_id uuid NOT NULL REFERENCES hon.school_demo_data_sets(id),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('LOADED','DEPENDENT')),
  PRIMARY KEY (table_name,row_id)
);
CREATE INDEX school_demo_data_rows_set_idx ON hon.school_demo_data_rows(set_id,table_name);
ALTER TABLE hon.school_demo_data_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_demo_data_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_demo_data_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_demo_data_rows FORCE ROW LEVEL SECURITY;

-- Sets never change scope, loader or load time and move only LOADED -> REMOVING -> REMOVED (REMOVING only inside the
-- removing transaction). Neither table can be truncated; sets are never deleted.
CREATE FUNCTION hon.guard_school_demo_data() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'DEMO_DATA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='school_demo_data_sets' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'DEMO_DATA_IMMUTABLE' USING ERRCODE='42501'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.status<>'LOADED' OR NEW.version<>1 OR NEW.counts<>'{}'::jsonb THEN RAISE EXCEPTION 'DEMO_DATA_IMMUTABLE' USING ERRCODE='42501'; END IF;
      RETURN NEW;
    END IF;
    -- The one counts write of the load: LOADED, version 1, from the empty object.
    IF OLD.status='LOADED' AND NEW.status='LOADED' AND OLD.counts='{}'::jsonb AND NEW.counts<>'{}'::jsonb AND NEW.version=1 AND OLD.version=1
      AND (to_jsonb(NEW)-'counts')=(to_jsonb(OLD)-'counts') THEN RETURN NEW; END IF;
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.counts,NEW.loaded_by_principal_id,NEW.loaded_at)
        IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.counts,OLD.loaded_by_principal_id,OLD.loaded_at)
      OR NOT ((OLD.status='LOADED' AND NEW.status='REMOVING') OR (OLD.status='REMOVING' AND NEW.status='REMOVED'))
      OR NEW.version<>OLD.version+1
      -- REMOVING names the transaction doing the removal; only that transaction can finish it.
      OR (NEW.status='REMOVING' AND NEW.removing_xact IS DISTINCT FROM pg_current_xact_id()::text)
      OR (OLD.status='REMOVING' AND OLD.removing_xact IS DISTINCT FROM pg_current_xact_id()::text) THEN
      RAISE EXCEPTION 'DEMO_DATA_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'DEMO_DATA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM hon.school_demo_data_sets s WHERE s.id=OLD.set_id AND s.status='REMOVING'
      AND s.removing_xact=pg_current_xact_id_if_assigned()::text) THEN RAISE EXCEPTION 'DEMO_DATA_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.school_demo_data_sets s WHERE s.id=NEW.set_id AND s.organization_id=NEW.organization_id AND s.school_id=NEW.school_id
    AND (s.status='LOADED' OR (s.status='REMOVING' AND NEW.origin='DEPENDENT'))) THEN RAISE EXCEPTION 'DEMO_DATA_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_demo_data_sets FOR EACH ROW EXECUTE FUNCTION hon.guard_school_demo_data();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_demo_data_sets FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_demo_data();
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_demo_data_rows FOR EACH ROW EXECUTE FUNCTION hon.guard_school_demo_data();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_demo_data_rows FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_demo_data();

-- Is this row demo data (registered in a set that is not removed)?
CREATE FUNCTION hon.demo_data_is_demo(p_table text,p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT p_id IS NOT NULL AND EXISTS(SELECT 1 FROM hon.school_demo_data_rows r WHERE r.table_name=p_table AND r.row_id=p_id)
$$;
-- D4: true only for a row registered in a set that the current transaction is removing.
CREATE FUNCTION hon.demo_data_removal_allows(p_table text,p_row jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(p_row)='object' AND pg_current_xact_id_if_assigned() IS NOT NULL
    AND EXISTS(SELECT 1 FROM hon.school_demo_data_rows r JOIN hon.school_demo_data_sets s ON s.id=r.set_id
      WHERE r.table_name=p_table AND r.row_id::text=p_row->>r.key_column AND s.status='REMOVING'
        AND s.removing_xact=pg_current_xact_id_if_assigned()::text),false)
$$;

-- D4: each append-only guard on a table that can point at demo rows lets exactly those rows go during removal. The
-- original body is kept byte for byte after the one added line; every function is checked to have one top-level BEGIN.
DO $$ DECLARE f regprocedure; src text; def text; pos integer; patched text; n integer:=0;
  bypass text:=E'\n  IF TG_OP=''DELETE'' AND hon.demo_data_removal_allows(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF; -- 0459 demo data removal\n';
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.guard_achievement_history()','hon.guard_attendance_card()','hon.guard_automation_run()',
    'hon.guard_automation_workflow_history()','hon.guard_billing_import()','hon.guard_campaign_history()','hon.guard_chad_follow_up()',
    'hon.guard_class_series()','hon.guard_classpass_booking()','hon.guard_crm_adult_membership_draft_source()',
    'hon.guard_crm_guardian_child_enrollment_history()','hon.guard_crm_lead_close_history()','hon.guard_crm_lead_registration_history()',
    'hon.guard_curriculum_history()','hon.guard_document_immutability()','hon.guard_family_message_thread()','hon.guard_follow_up_history()',
    'hon.guard_history_import()','hon.guard_instructor_qualification_history()','hon.guard_invoice_payment_record()',
    'hon.guard_lead_import_evidence()','hon.guard_membership_activation_evidence()','hon.guard_membership_pause()',
    'hon.guard_membership_plan_selection()','hon.guard_membership_plan_version()','hon.guard_public_form_record()','hon.guard_renewal_history()',
    'hon.guard_school_account_evidence()','hon.guard_school_conversation()','hon.guard_school_family_access_invitation()',
    'hon.guard_school_pay_autopay_plan()','hon.guard_school_pay_charge_attempt()','hon.guard_school_pay_method()',
    'hon.guard_school_pay_method_setup()','hon.guard_student_import()','hon.guard_teaching_studio_history()',
    'hon.guard_testing_certificate_history()','hon.guard_testing_certificate_promotion_delete()','hon.guard_testing_registration_interest()',
    'hon.guard_testing_scorecard_history()','hon.guard_testing_scorecard_root()','hon.guard_walkin_kiosk()']::regprocedure[] LOOP
    SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=f AND l.lanname='plpgsql' AND p.prorettype='trigger'::regtype;
    IF src IS NULL OR (SELECT count(*) FROM regexp_matches(src,'\mBEGIN\M','gi'))<>1 OR position('$function$' IN src)>0 THEN
      RAISE EXCEPTION '0459 cannot patch guard %',f; END IF;
    pos:=regexp_instr(src,'\mBEGIN\M',1,1,1,'i');
    patched:=substr(src,1,pos-1)||bypass||substr(src,pos);
    def:=pg_get_functiondef(f);
    IF position('$function$'||src||'$function$' IN def)=0 THEN RAISE EXCEPTION '0459 cannot patch guard %',f; END IF;
    EXECUTE replace(def,'$function$'||src||'$function$','$function$'||patched||'$function$');
    n:=n+1;
  END LOOP;
  IF n<>42 THEN RAISE EXCEPTION '0459 patched % guards, expected 42',n; END IF;
END $$;

-- ---------- D3: never contact or charge demo people ----------
-- TG_ARGV: column, the registered table that column points at, and the refusal code.
CREATE FUNCTION hon.refuse_demo_data_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v text:=to_jsonb(NEW)->>TG_ARGV[0];
BEGIN
  IF v IS NOT NULL AND hon.demo_data_is_demo(TG_ARGV[1],v::uuid) THEN RAISE EXCEPTION '%',TG_ARGV[2] USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER demo_data_refuse BEFORE INSERT ON hon.communication_messages FOR EACH ROW
  EXECUTE FUNCTION hon.refuse_demo_data_target('recipient_person_id','people','DEMO_CONTACT_NOT_CONTACTABLE');
CREATE TRIGGER demo_data_refuse BEFORE INSERT ON hon.school_family_access_invitations FOR EACH ROW
  EXECUTE FUNCTION hon.refuse_demo_data_target('family_id','families','DEMO_CONTACT_NOT_CONTACTABLE');
CREATE TRIGGER demo_data_refuse BEFORE INSERT ON hon.school_pay_customers FOR EACH ROW
  EXECUTE FUNCTION hon.refuse_demo_data_target('billing_account_id','billing_accounts','DEMO_ACCOUNT_NOT_PAYABLE');
CREATE TRIGGER demo_data_refuse BEFORE INSERT ON hon.school_pay_method_setups FOR EACH ROW
  EXECUTE FUNCTION hon.refuse_demo_data_target('billing_account_id','billing_accounts','DEMO_ACCOUNT_NOT_PAYABLE');
CREATE TRIGGER demo_data_refuse BEFORE INSERT ON hon.school_pay_autopay_plans FOR EACH ROW
  EXECUTE FUNCTION hon.refuse_demo_data_target('billing_account_id','billing_accounts','DEMO_ACCOUNT_NOT_PAYABLE');
CREATE TRIGGER demo_data_refuse BEFORE INSERT ON hon.school_pay_charge_attempts FOR EACH ROW
  EXECUTE FUNCTION hon.refuse_demo_data_target('billing_account_id','billing_accounts','DEMO_ACCOUNT_NOT_PAYABLE');

-- ---------- authority ----------
-- Live direct-human authority at the current school with school.demo_data.manage and the paid or trial access that
-- students need (a pre-trial school cannot hold students). Same identity rules as 0392.
CREATE FUNCTION hon.require_demo_data_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 2048 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'DEMO_DATA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code='school.demo_data.manage' AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'DEMO_DATA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- ---------- views ----------
CREATE FUNCTION hon.school_demo_data_view(p_org uuid,p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT jsonb_build_object('status','LOADED','setId',s.id,'version',s.version,'loadedAt',hon.saas_ts(s.loaded_at),'counts',s.counts)
      FROM hon.school_demo_data_sets s WHERE s.organization_id=p_org AND s.school_id=p_school AND s.status='LOADED'),
    jsonb_build_object('status','NONE','setId',NULL,'version',NULL,'loadedAt',NULL,'counts',NULL))
  ||jsonb_build_object('lastRemovedAt',(SELECT hon.saas_ts(max(s.removed_at)) FROM hon.school_demo_data_sets s
      WHERE s.organization_id=p_org AND s.school_id=p_school AND s.status='REMOVED'))
$$;

CREATE FUNCTION hon.demo_data_register(p_set uuid,p_org uuid,p_school uuid,p_table text,p_id uuid) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  INSERT INTO hon.school_demo_data_rows(table_name,row_id,set_id,organization_id,school_id,origin) VALUES(p_table,p_id,p_set,p_org,p_school,'LOADED') RETURNING row_id
$$;

-- Demo attendance for completed demo class sessions: about seven in ten students of the class's program, a few late, only
-- while the student's age fitted the program that day. Every row is registered in the set. Grants nothing.
CREATE FUNCTION hon.school_demo_data_attendance(p_org uuid,p_school uuid,p_actor uuid,p_set uuid,tz text,students jsonb,progs uuid[],
    prog_min integer[],prog_max integer[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sess record; s jsonb; j integer; p integer; age_months integer; rid uuid; c_attendance integer:=0;
BEGIN
  FOR sess IN SELECT x.id,x.program_id,x.starts_at,x.ends_at FROM hon.class_sessions x JOIN hon.school_demo_data_rows r ON r.table_name='class_sessions' AND r.row_id=x.id
      WHERE r.set_id=p_set AND x.status='COMPLETED' ORDER BY x.starts_at LOOP
    FOR s IN SELECT x FROM jsonb_array_elements(students) x WHERE progs[(x->>'program')::integer]=sess.program_id LOOP
      j:=abs(hashtext(sess.id::text||(s->>'profile')))%100;
      CONTINUE WHEN j>=70;
      -- Only while the student's age fitted the program on that day (a birthday can fall inside the four weeks).
      age_months:=extract(year FROM age((sess.starts_at AT TIME ZONE tz)::date,(s->>'birth')::date))::integer*12
        +extract(month FROM age((sess.starts_at AT TIME ZONE tz)::date,(s->>'birth')::date))::integer;
      p:=(s->>'program')::integer;
      CONTINUE WHEN age_months<prog_min[p] OR age_months>coalesce(prog_max[p],2147483647);
      INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_by_principal_id,recorded_at,category,created_at)
          VALUES(p_org,p_school,sess.id,(s->>'profile')::uuid,CASE WHEN j<5 THEN 'LATE' ELSE 'PRESENT' END::hon.attendance_status,p_actor,sess.ends_at,'REGULAR_PARTICIPANT',sess.ends_at)
          RETURNING id INTO rid;
      PERFORM hon.demo_data_register(p_set,p_org,p_school,'attendance_records',rid);
      c_attendance:=c_attendance+1;
    END LOOP;
  END LOOP;

  RETURN c_attendance;
END $$;

-- ---------- load ----------
-- The demo school: 3 programs with weekly classes (4 weeks back, 2 ahead), 20 families with 30 children, 8 adult
-- students, a membership and monthly schedule per student with paid, open and two overdue invoices (cash or card
-- terminal, never a provider), attendance for past classes, and 15 open leads. Everything is fixed except the dates,
-- which follow the school's own calendar. Phones are in the fictional 555-0100..0199 range; emails are @example.com.
CREATE FUNCTION hon.school_demo_data_write(p_org uuid,p_school uuid,p_actor uuid,p_set uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE tz text; today date; now_at timestamptz:=clock_timestamp();
  surnames text[]:=ARRAY['Rivera','Chen','Patel','Johnson','Kim','Nguyen','Garcia','Okafor','Silva','Murphy','Cohen','Haddad','Novak','Tanaka','Brooks',
    'Moreau','Singh','Lopez','Walsh','Park'];
  guardians text[]:=ARRAY['Maria','Daniel','Priya','Marcus','Grace','Linh','Carlos','Ada','Rafael','Erin','Noah','Layla','Petra','Kenji','Tasha',
    'Claire','Arjun','Sofia','Liam','Joon'];
  kids text[]:=ARRAY['Mateo','Lily','Aarav','Zoe','Ethan','Mia','Leo','Ava','Kai','Nora','Lucas','Emma','Omar','Isla','Ben','Chloe','Ravi','Hana',
    'Max','Ruby','Theo','Aria','Sam','Elena','Finn','Maya','Jonah','Iris','Owen','Luna'];
  adults text[]:=ARRAY['Jordan Lee','Sam Ortiz','Alex Morgan','Taylor Reed','Chris Bennett','Jamie Fox','Morgan Hale','Riley Quinn'];
  leads text[]:=ARRAY['Hannah Price','Victor Alvarez','Dana Whitfield','Kofi Mensah','Yuki Sato','Bianca Russo','Tom Gallagher','Nadia Karim',
    'Ellis Grant','Rosa Delgado','Ian Fletcher','Mei Wong','Paul Becker','Amara Obi','Lena Fischer'];
  prog_names text[]:=ARRAY['Little Dragons','Kids Karate','Teens and Adults'];
  prog_desc text[]:=ARRAY['Ages 4 to 6: focus, balance and fun','Ages 7 to 12: belts, discipline and confidence','Ages 13 and up: fitness and self-defense'];
  prog_min integer[]:=ARRAY[48,84,156]; prog_max integer[]:=ARRAY[83,155,NULL];
  prog_price integer[]:=ARRAY[12900,14900,16900]; prog_code text[]:=ARRAY['DEMO_LITTLE_DRAGONS','DEMO_KIDS_KARATE','DEMO_TEENS_ADULTS'];
  prog_rule text[]:=ARRAY['FREQ=WEEKLY;BYDAY=MO,WE','FREQ=WEEKLY;BYDAY=MO,WE,FR','FREQ=WEEKLY;BYDAY=TU,TH,SA'];
  progs uuid[]:='{}'; templates uuid[]:='{}'; pid uuid; tid uuid; sid uuid; d date; i integer; j integer; k integer; p integer;
  fam uuid; guardian uuid; person uuid; profile uuid; acct uuid; m uuid; decision uuid; inv uuid; pay uuid; lead uuid;
  phone integer:=100; birth date; age_months integer; started date; due date; amount integer; facts jsonb; receipt jsonb;
  students jsonb:='[]'; s jsonb; rid uuid; sess record; pipeline uuid; stages uuid[]; status_text text;
  c_families integer:=0; c_students integer:=0; c_adults integer:=0; c_guardians integer:=0; c_leads integer:=0; c_sessions integer:=0;
  c_memberships integer:=0; c_invoices integer:=0; c_payments integer:=0; c_attendance integer:=0; c_overdue integer:=0;
BEGIN
  SELECT x.timezone INTO tz FROM hon.schools x WHERE x.id=p_school AND x.organization_id=p_org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz) THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=(now_at AT TIME ZONE tz)::date;

  -- Programs, weekly classes and their sessions.
  FOR p IN 1..3 LOOP
    INSERT INTO hon.programs(organization_id,school_id,name,description,minimum_age_months,maximum_age_months,status)
      VALUES(p_org,p_school,prog_names[p],prog_desc[p],prog_min[p],prog_max[p],'SCHEDULED') RETURNING id INTO pid;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'programs',pid); progs:=progs||pid;
    INSERT INTO hon.class_templates(organization_id,school_id,program_id,name,room_name,capacity,booking_policy,recurrence_rule,status)
      VALUES(p_org,p_school,pid,prog_names[p],CASE WHEN p=3 THEN 'Studio B' ELSE 'Main mat' END,20,'WALK_IN',prog_rule[p],'SCHEDULED') RETURNING id INTO tid;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'class_templates',tid); templates:=templates||tid;
  END LOOP;
  FOR d IN SELECT g::date FROM generate_series(today-28,today+14,interval '1 day') g LOOP
    FOR p IN 1..3 LOOP
      IF (p=1 AND extract(isodow FROM d) IN (1,3)) OR (p=2 AND extract(isodow FROM d) IN (1,3,5)) OR (p=3 AND extract(isodow FROM d) IN (2,4,6)) THEN
        INSERT INTO hon.class_sessions(organization_id,school_id,class_template_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status)
          VALUES(p_org,p_school,templates[p],progs[p],prog_names[p],CASE WHEN p=3 THEN 'Studio B' ELSE 'Main mat' END,
            (d+CASE WHEN p=1 THEN time '16:00' WHEN p=2 THEN time '17:00' WHEN extract(isodow FROM d)=6 THEN time '10:00' ELSE time '19:00' END) AT TIME ZONE tz,
            (d+CASE WHEN p=1 THEN time '16:45' WHEN p=2 THEN time '18:00' WHEN extract(isodow FROM d)=6 THEN time '11:00' ELSE time '20:00' END) AT TIME ZONE tz,
            20,'WALK_IN',CASE WHEN d<today THEN 'COMPLETED' ELSE 'SCHEDULED' END::hon.schedule_item_status) RETURNING id INTO sid;
        PERFORM hon.demo_data_register(p_set,p_org,p_school,'class_sessions',sid); c_sessions:=c_sessions+1;
      END IF;
    END LOOP;
  END LOOP;

  -- Families: a guardian with one or two children.
  k:=0;
  FOR i IN 1..20 LOOP
    INSERT INTO hon.families(organization_id,school_id,display_name) VALUES(p_org,p_school,surnames[i]||' family') RETURNING id INTO fam;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'families',fam); c_families:=c_families+1;
    INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164)
      VALUES(p_org,p_school,guardians[i],surnames[i],lower(guardians[i]||'.'||surnames[i])||'@example.com','+1201555'||lpad(phone::text,4,'0'))
      RETURNING id INTO guardian;
    phone:=phone+1;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'people',guardian); c_guardians:=c_guardians+1;
    INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact)
        VALUES(p_org,p_school,fam,guardian,'GUARDIAN',true) RETURNING id INTO rid;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'family_members',rid);
    INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification)
      VALUES(p_org,p_school,guardian,'USD','CANONICAL') RETURNING id INTO acct;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'billing_accounts',acct);
    FOR j IN 1..CASE WHEN i%2=0 THEN 2 ELSE 1 END LOOP
      k:=k+1;
      age_months:=48+((k*29)%120);  -- 4 to 13 years
      birth:=today-(age_months*30+(k*11)%28);
      INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES(p_org,p_school,kids[k],surnames[i]) RETURNING id INTO person;
      PERFORM hon.demo_data_register(p_set,p_org,p_school,'people',person);
      INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact)
          VALUES(p_org,p_school,fam,person,'STUDENT',false) RETURNING id INTO rid;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'family_members',rid);
      INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES(p_org,p_school,person,fam,birth) RETURNING id INTO profile;
      PERFORM hon.demo_data_register(p_set,p_org,p_school,'student_profiles',profile); c_students:=c_students+1;
      students:=students||jsonb_build_object('person',person,'profile',profile,'account',acct,'birth',birth,
        'program',CASE WHEN extract(year FROM age(today,birth))<7 THEN 1 WHEN extract(year FROM age(today,birth))<13 THEN 2 ELSE 3 END);
    END LOOP;
  END LOOP;
  -- Adult students, each in their own family and paying for themselves.
  FOR i IN 1..8 LOOP
    INSERT INTO hon.families(organization_id,school_id,display_name) VALUES(p_org,p_school,split_part(adults[i],' ',2)||' family') RETURNING id INTO fam;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'families',fam); c_families:=c_families+1;
    INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164)
      VALUES(p_org,p_school,split_part(adults[i],' ',1),split_part(adults[i],' ',2),lower(replace(adults[i],' ','.'))||'@example.com','+1201555'||lpad(phone::text,4,'0'))
      RETURNING id INTO person;
    phone:=phone+1;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'people',person);
    INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact)
        VALUES(p_org,p_school,fam,person,'STUDENT',true) RETURNING id INTO rid;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'family_members',rid);
    birth:=today-((24+(i*3)%22)*365+(i*41)%300);
    INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES(p_org,p_school,person,fam,birth) RETURNING id INTO profile;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'student_profiles',profile); c_students:=c_students+1; c_adults:=c_adults+1;
    INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification)
      VALUES(p_org,p_school,person,'USD','CANONICAL') RETURNING id INTO acct;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'billing_accounts',acct);
    students:=students||jsonb_build_object('person',person,'profile',profile,'account',acct,'birth',birth,'program',3);
  END LOOP;

  -- A membership per student, activated the way 0334 records a legacy membership, with a monthly schedule and invoices.
  i:=0;
  FOR s IN SELECT x FROM jsonb_array_elements(students) x LOOP
    i:=i+1; p:=(s->>'program')::integer; amount:=prog_price[p];
    started:=today-(45+(i*37)%320);
    INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at,created_at)
      VALUES(p_org,p_school,(s->>'account')::uuid,(s->>'person')::uuid,prog_code[p],'DRAFT',hon.membership_local_day_start(started,tz),NULL,
        hon.membership_local_day_start(started,tz)) RETURNING id INTO m;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'memberships',m); c_memberships:=c_memberships+1;
    decision:=gen_random_uuid();
    facts:=jsonb_build_object('source','GENERIC_LEGACY','origin','DEMO_DATA','demoSetId',p_set,'membershipId',m,'billingAccountId',s->>'account',
      'participantPersonId',s->>'person','planCode',prog_code[p],
      'requirementsNotEvaluated','["AGREEMENT","PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb);
    receipt:=jsonb_build_object('membershipId',m,'state','ACTIVE','version',2,'previousVersion',1,'decisionId',decision,
      'decisionBasis','STAFF_ACTIVATION_PRE_POLICY','membershipSource','GENERIC_LEGACY','origin','DEMO_DATA',
      'authorizingPermission','school.demo_data.manage','overridePermission',NULL,
      'effectivePeriod',jsonb_build_object('periodVersion',1,'startDate',to_char(started,'YYYY-MM-DD'),'endDate',NULL,'endDateInclusive',true,
        'schoolTimezone',tz,'dateSource','SUGGESTED','termStartedAt',hon.saas_ts(hon.membership_local_day_start(started,tz)),'termEndsAt',NULL),
      'acknowledgedWarnings','[]'::jsonb,'overridesUsed','[]'::jsonb,'followUps','[]'::jsonb,'adultVerification',NULL,
      'reasonCode','LEGACY_MEMBERSHIP','requirementsNotEvaluated',facts->'requirementsNotEvaluated','recordedAt',hon.saas_ts(now_at));
    INSERT INTO hon.membership_activation_decisions(id,organization_id,school_id,membership_id,prior_membership_version,next_membership_version,decision_basis,
        membership_source,actor_principal_id,authorizing_permission,override_permission,reason_code,reason_text,acknowledged_warnings,overrides,adult_verification,
        preview_digest,evaluated_facts,requirements_not_evaluated,idempotency_key,request_fingerprint,request_id,correlation_id,receipt,created_at)
      VALUES(decision,p_org,p_school,m,1,2,'STAFF_ACTIVATION_PRE_POLICY','GENERIC_LEGACY',p_actor,'billing.membership.activate',NULL,
        'LEGACY_MEMBERSHIP','Demo membership loaded to try HON.','[]'::jsonb,'[]'::jsonb,NULL,
        encode(sha256(convert_to(facts::text,'UTF8')),'hex'),facts,facts->'requirementsNotEvaluated',
        'demo-data:'||p_set::text||':'||i::text,encode(sha256(convert_to(facts::text,'UTF8')),'hex'),p_request,p_correlation,receipt,now_at);
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'membership_activation_decisions',decision);
    INSERT INTO hon.membership_effective_periods(organization_id,school_id,membership_id,period_version,change_kind,start_date,end_date,school_timezone,
          term_started_at,term_ends_at,date_source,suggested_start_date,suggested_end_date,suggestion_basis,adjustment_reason,actor_principal_id,
          authorizing_permission,decision_id,created_at)
        VALUES(p_org,p_school,m,1,'INITIAL',started,NULL,tz,hon.membership_local_day_start(started,tz),NULL,'SUGGESTED',started,NULL,
          jsonb_build_object('startBasis','IMPORTED','endBasis','OPEN_ENDED'),NULL,p_actor,'billing.membership.activate',decision,now_at) RETURNING id INTO rid;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'membership_effective_periods',rid);
    UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=m AND organization_id=p_org AND school_id=p_school AND state='DRAFT' AND version=1;
    IF NOT FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,next_charge_at,auto_renew,status)
        VALUES(p_org,p_school,m,'MONTHLY',amount,'USD',hon.membership_local_day_start(today+5,tz),true,'ACTIVE') RETURNING id INTO rid;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'membership_payment_schedules',rid);
    -- Invoices: 55 and 25 days ago (paid, except the last month of two members, which is overdue) and the one due in 5 days.
    FOR j IN 0..2 LOOP
      due:=CASE j WHEN 0 THEN today-55 WHEN 1 THEN today-25 ELSE today+5 END;
      CONTINUE WHEN due<started;
      INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,discount_minor,total_minor,due_at,created_at)
        VALUES(p_org,p_school,(s->>'account')::uuid,m,'ISSUED','USD',amount,0,amount,hon.membership_local_day_start(due+1,tz)-interval '1 second',
          hon.membership_local_day_start(due-7,tz)) RETURNING id INTO inv;
      PERFORM hon.demo_data_register(p_set,p_org,p_school,'invoices',inv); c_invoices:=c_invoices+1;
      IF j=0 OR (j=1 AND i NOT IN (5,17)) THEN
        INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,note,actor_principal_id)
          VALUES(p_org,p_school,inv,amount,'USD',due-(i%3),CASE WHEN i%2=0 THEN 'CASH' ELSE 'CARD_TERMINAL' END,'Demo payment',p_actor) RETURNING id INTO pay;
        PERFORM hon.demo_data_register(p_set,p_org,p_school,'invoice_payment_records',pay); c_payments:=c_payments+1;
        UPDATE hon.invoices SET status='PAID',version=version+1 WHERE id=inv;
      ELSIF j=1 THEN c_overdue:=c_overdue+1;
      END IF;
    END LOOP;
  END LOOP;

  -- Attendance for past classes, in its own helper (it never reads billing or plan state).
  c_attendance:=hon.school_demo_data_attendance(p_org,p_school,p_actor,p_set,tz,students,progs,prog_min,prog_max);

  -- Leads in the school's first pipeline (its open, visible stages), or a demo pipeline when it has none.
  SELECT x.id INTO pipeline FROM hon.crm_pipelines x WHERE x.organization_id=p_org AND x.school_id=p_school
    AND EXISTS(SELECT 1 FROM hon.crm_pipeline_stages t WHERE t.pipeline_id=x.id AND t.terminal_status IS NULL AND t.hidden_at IS NULL)
    ORDER BY x.created_at,x.id LIMIT 1;
  IF pipeline IS NULL THEN
    INSERT INTO hon.crm_pipelines(organization_id,school_id,name) VALUES(p_org,p_school,'Demo leads') RETURNING id INTO pipeline;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'crm_pipelines',pipeline);
    FOR j IN 1..4 LOOP
      INSERT INTO hon.crm_pipeline_stages(organization_id,school_id,pipeline_id,name,position,color)
          VALUES(p_org,p_school,pipeline,(ARRAY['New','Contacted','Trial booked','Trial done'])[j],j,(ARRAY['BLUE','SKY','VIOLET','GREEN'])[j]) RETURNING id INTO rid;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'crm_pipeline_stages',rid);
    END LOOP;
  END IF;
  SELECT array_agg(t.id ORDER BY t.position) INTO stages FROM hon.crm_pipeline_stages t
    WHERE t.pipeline_id=pipeline AND t.organization_id=p_org AND t.school_id=p_school AND t.terminal_status IS NULL AND t.hidden_at IS NULL;
  FOR i IN 1..15 LOOP
    INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164)
      VALUES(p_org,p_school,split_part(leads[i],' ',1),split_part(leads[i],' ',2),lower(replace(leads[i],' ','.'))||'@example.com','+1201555'||lpad(phone::text,4,'0'))
      RETURNING id INTO person;
    phone:=phone+1;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'people',person);
    INSERT INTO hon.crm_leads(organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code,program_interest_code,attribution,
        next_follow_up_at,created_at,updated_at)
      VALUES(p_org,p_school,person,pipeline,stages[1+(i-1)%cardinality(stages)],'OPEN',(ARRAY['WEBSITE','WALK_IN','REFERRAL','FACEBOOK','GOOGLE'])[1+i%5],
        prog_code[1+i%3],'{}'::jsonb,CASE WHEN i%3=0 THEN NULL ELSE now_at+make_interval(days=>i%6) END,now_at-make_interval(days=>(i*3)%21),now_at)
      RETURNING id INTO lead;
    PERFORM hon.demo_data_register(p_set,p_org,p_school,'crm_leads',lead); c_leads:=c_leads+1;
  END LOOP;
  IF phone>199 THEN RAISE EXCEPTION 'DEMO_DATA_PHONE_RANGE' USING ERRCODE='22023'; END IF;

  RETURN jsonb_build_object('families',c_families,'guardians',c_guardians,'students',c_students,'adultStudents',c_adults,'leads',c_leads,
    'programs',3,'classes',3,'classSessions',c_sessions,'memberships',c_memberships,'invoices',c_invoices,'payments',c_payments,
    'overdueInvoices',c_overdue,'attendance',c_attendance);
END $$;

-- Shared idempotent command envelope: closed args, live actor, a reserved key, the authority re-proved under SHARE locks.
CREATE FUNCTION hon.school_demo_data_begin(subject text,p_operation text,p jsonb,key text,request uuid,correlation uuid,OUT actor uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,key,request,correlation) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p)::text,'UTF8')),'hex');
  actor:=hon.require_demo_data_actor(subject);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,
    hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_demo_data_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'DEMO_DATA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    replay:=prior.response_body;
  END IF;
END $$;
CREATE FUNCTION hon.school_demo_data_finish(subject text,p_actor uuid,key text,result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND principal_id=p_actor AND idempotency_key=key;
  IF hon.require_demo_data_actor(subject) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'DEMO_DATA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

CREATE FUNCTION hon.read_school_demo_data(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor:=hon.require_demo_data_actor(subject);
  result:=hon.school_demo_data_view(hon.current_organization_id(),hon.current_school_id());
  IF hon.require_demo_data_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'DEMO_DATA_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Input: exactly {}. Loads the demo school once; a second load while a set is loaded is refused.
CREATE FUNCTION hon.load_school_demo_data(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; set_id uuid:=gen_random_uuid(); v_counts jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p<>'{}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.school_demo_data_begin(subject,'school.demo_data.load',p,key,request,correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  PERFORM 1 FROM hon.schools x WHERE x.id=school AND x.organization_id=org FOR NO KEY UPDATE;
  IF EXISTS(SELECT 1 FROM hon.school_demo_data_sets x WHERE x.organization_id=org AND x.school_id=school AND x.status<>'REMOVED') THEN
    RAISE EXCEPTION 'DEMO_DATA_ALREADY_LOADED' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_demo_data_sets(id,organization_id,school_id,status,counts,loaded_by_principal_id) VALUES(set_id,org,school,'LOADED','{}'::jsonb,s.actor);
  v_counts:=hon.school_demo_data_write(org,school,s.actor,set_id,request,correlation);
  -- The counts are written once, right after the load (the insert carried an empty object).
  UPDATE hon.school_demo_data_sets SET counts=v_counts WHERE id=set_id;
  -- Counts and ids only: no names, contacts or amounts. Deliberately no outbox event (D2).
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,s.actor,'HUMAN_UI','school.demo_data.load','SCHOOL_DEMO_DATA',set_id,NULL,jsonb_build_object('setId',set_id,'counts',v_counts),'SUCCEEDED',request,correlation);
  result:=hon.school_demo_data_view(org,school);
  RETURN hon.school_demo_data_finish(subject,s.actor,key,result);
END $$;

-- ---------- remove ----------
-- Tables whose rows are people or money for a person: a dependent that points at a real one of these is real data.
CREATE FUNCTION hon.demo_data_person_tables() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['people','student_profiles','families','family_members','crm_leads','billing_accounts','memberships','invoices']
$$;

-- D1/D5: registers every row that points at the set's rows through a foreign key, until nothing new is found. A
-- dependent goes too when it is in this school, has a uuid id and points only at demo people; anything else stops the
-- removal with DEMO_DATA_IN_USE and the table names.
CREATE FUNCTION hon.school_demo_data_collect(p_set uuid,p_org uuid,p_school uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE fk record; other record; r jsonb; added integer; total integer:=0; pass integer:=0; blocked text[]:='{}'; demo_ref boolean; real_ref boolean; v text;
  scoped boolean; key text;
BEGIN
  LOOP
    pass:=pass+1; added:=0;
    IF pass>25 THEN RAISE EXCEPTION 'DEMO_DATA_REMOVE_FAILED' USING ERRCODE='55000'; END IF;
    FOR fk IN SELECT DISTINCT c.conrelid AS child,cl.relname AS child_name,pr.relname AS parent_name,a.attname AS col
      FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_class pr ON pr.oid=c.confrelid
      CROSS JOIN LATERAL unnest(c.conkey,c.confkey) k(ck,pk)
      JOIN pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attnum=k.pk AND pa.attname='id'
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.ck
      WHERE c.contype='f' AND c.connamespace='hon'::regnamespace AND cl.relnamespace='hon'::regnamespace
        AND cl.relname NOT IN ('school_demo_data_rows','school_demo_data_sets')
        AND pr.relname IN (SELECT DISTINCT x.table_name FROM hon.school_demo_data_rows x WHERE x.set_id=p_set)
      ORDER BY 2,3,4 LOOP
      -- The child's own uuid key: id, else a one-column uuid primary key; without one it cannot be registered.
      SELECT coalesce((SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=fk.child AND a.attname='id' AND a.atttypid='uuid'::regtype AND NOT a.attisdropped),
          (SELECT a.attname::text FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
            WHERE i.indrelid=fk.child AND i.indisprimary AND i.indnatts=1 AND a.atttypid='uuid'::regtype)),
        (SELECT count(*) FROM pg_attribute WHERE attrelid=fk.child AND attname IN ('organization_id','school_id') AND NOT attisdropped)=2
        INTO key,scoped;
      FOR r IN EXECUTE format('SELECT to_jsonb(c) FROM hon.%I c WHERE c.%I IN (SELECT x.row_id FROM hon.school_demo_data_rows x WHERE x.set_id=$1 AND x.table_name=$2)',
          fk.child_name,fk.col) USING p_set,fk.parent_name LOOP
        IF key IS NOT NULL AND hon.demo_data_is_demo(fk.child_name,(r->>key)::uuid) THEN CONTINUE; END IF;
        IF key IS NULL OR NOT scoped OR (r->>'organization_id')::uuid IS DISTINCT FROM p_org OR (r->>'school_id')::uuid IS DISTINCT FROM p_school THEN
          blocked:=blocked||fk.child_name; CONTINUE; END IF;
        demo_ref:=false; real_ref:=false;
        FOR other IN SELECT DISTINCT pr.relname AS parent_name,a.attname AS col FROM pg_constraint c JOIN pg_class pr ON pr.oid=c.confrelid
            CROSS JOIN LATERAL unnest(c.conkey,c.confkey) k(ck,pk)
            JOIN pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attnum=k.pk AND pa.attname='id'
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.ck
            WHERE c.contype='f' AND c.conrelid=fk.child AND pr.relnamespace='hon'::regnamespace AND pr.relname=ANY(hon.demo_data_person_tables()) LOOP
          v:=r->>other.col;
          CONTINUE WHEN v IS NULL;
          IF hon.demo_data_is_demo(other.parent_name,v::uuid) THEN demo_ref:=true; ELSE real_ref:=true; END IF;
        END LOOP;
        IF real_ref OR NOT demo_ref THEN blocked:=blocked||fk.child_name; CONTINUE; END IF;
        INSERT INTO hon.school_demo_data_rows(table_name,row_id,key_column,set_id,organization_id,school_id,origin)
          VALUES(fk.child_name,(r->>key)::uuid,key,p_set,p_org,p_school,'DEPENDENT') ON CONFLICT DO NOTHING;
        added:=added+1;
      END LOOP;
    END LOOP;
    IF cardinality(blocked)>0 THEN
      RAISE EXCEPTION 'DEMO_DATA_IN_USE' USING ERRCODE='40001',
        DETAIL=(SELECT jsonb_build_object('tables',jsonb_agg(DISTINCT t ORDER BY t))::text FROM unnest(blocked) t);
    END IF;
    total:=total+added;
    EXIT WHEN added=0;
  END LOOP;
  RETURN total;
END $$;

-- Deletes every registered row, children first: each pass deletes what it can and a foreign key that still points at a
-- row waits for the next pass. A guard or other refusal stops the removal with the table name.
CREATE FUNCTION hon.school_demo_data_delete(p_set uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE t text; kc text; pass integer:=0; left_over integer; n integer; deleted jsonb:='{}'; progress boolean;
BEGIN
  LOOP
    pass:=pass+1; progress:=false;
    IF pass>40 THEN RAISE EXCEPTION 'DEMO_DATA_REMOVE_FAILED' USING ERRCODE='55000'; END IF;
    FOR t,kc IN SELECT x.table_name,x.key_column FROM hon.school_demo_data_rows x WHERE x.set_id=p_set GROUP BY x.table_name,x.key_column
        ORDER BY bool_or(x.origin='DEPENDENT') DESC,x.table_name LOOP
      BEGIN
        EXECUTE format('DELETE FROM hon.%I c WHERE c.%I IN (SELECT x.row_id FROM hon.school_demo_data_rows x WHERE x.set_id=$1 AND x.table_name=$2)',t,kc)
          USING p_set,t;
        GET DIAGNOSTICS n=ROW_COUNT;
        IF n>0 THEN progress:=true; deleted:=jsonb_set(deleted,ARRAY[t],to_jsonb(coalesce((deleted->>t)::integer,0)+n)); END IF;
      EXCEPTION WHEN foreign_key_violation THEN NULL;
        WHEN OTHERS THEN RAISE EXCEPTION 'DEMO_DATA_IN_USE' USING ERRCODE='40001',DETAIL=jsonb_build_object('tables',jsonb_build_array(t))::text;
      END;
    END LOOP;
    left_over:=0;
    FOR t,kc IN SELECT DISTINCT x.table_name,x.key_column FROM hon.school_demo_data_rows x WHERE x.set_id=p_set LOOP
      EXECUTE format('SELECT count(*) FROM hon.%I c WHERE c.%I IN (SELECT x.row_id FROM hon.school_demo_data_rows x WHERE x.set_id=$1 AND x.table_name=$2)',t,kc)
        INTO n USING p_set,t;
      left_over:=left_over+n;
    END LOOP;
    EXIT WHEN left_over=0;
    IF NOT progress THEN RAISE EXCEPTION 'DEMO_DATA_REMOVE_FAILED' USING ERRCODE='55000'; END IF;
  END LOOP;
  RETURN deleted;
END $$;

-- Input: exactly {setId, expectedVersion}. Removes the loaded set and what staff added to demo people, or nothing.
CREATE FUNCTION hon.remove_school_demo_data(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; d hon.school_demo_data_sets%ROWTYPE;
  dependents integer; deleted jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','setId']
    OR jsonb_typeof(p->'setId') IS DISTINCT FROM 'string' OR (p->>'setId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.school_demo_data_begin(subject,'school.demo_data.remove',p,key,request,correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  PERFORM 1 FROM hon.schools x WHERE x.id=school AND x.organization_id=org FOR NO KEY UPDATE;
  SELECT * INTO d FROM hon.school_demo_data_sets x WHERE x.id=(p->>'setId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND OR d.status<>'LOADED' THEN RAISE EXCEPTION 'DEMO_DATA_NOT_LOADED' USING ERRCODE='P0002'; END IF;
  IF d.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  UPDATE hon.school_demo_data_sets SET status='REMOVING',version=version+1,removing_xact=pg_current_xact_id()::text WHERE id=d.id;
  dependents:=hon.school_demo_data_collect(d.id,org,school);
  deleted:=hon.school_demo_data_delete(d.id);
  DELETE FROM hon.school_demo_data_rows x WHERE x.set_id=d.id;
  UPDATE hon.school_demo_data_sets SET status='REMOVED',version=version+1,removing_xact=NULL,removed_at=clock_timestamp(),removed_by_principal_id=s.actor,
    removed_counts=jsonb_build_object('dependents',dependents,'tables',deleted) WHERE id=d.id;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,s.actor,'HUMAN_UI','school.demo_data.remove','SCHOOL_DEMO_DATA',d.id,jsonb_build_object('setId',d.id,'counts',d.counts),
      jsonb_build_object('setId',d.id,'dependents',dependents,'tables',deleted),'SUCCEEDED',request,correlation);
  result:=hon.school_demo_data_view(org,school);
  RETURN hon.school_demo_data_finish(subject,s.actor,key,result);
END $$;

DO $$ DECLARE r text; t text; f text;
  entry text[]:=ARRAY['hon.read_school_demo_data(text)','hon.load_school_demo_data(text,jsonb,text,uuid,uuid)','hon.remove_school_demo_data(text,jsonb,text,uuid,uuid)'];
  -- Called from inside existing append-only guards, some of which run as the caller: the roles that can fire them may run it.
  shared text[]:=ARRAY['hon.demo_data_removal_allows(text,jsonb)'];
  helpers text[]:=ARRAY['hon.guard_school_demo_data()','hon.demo_data_is_demo(text,uuid)','hon.refuse_demo_data_target()','hon.require_demo_data_actor(text)',
    'hon.school_demo_data_view(uuid,uuid)','hon.demo_data_register(uuid,uuid,uuid,text,uuid)','hon.school_demo_data_write(uuid,uuid,uuid,uuid,uuid,uuid)',
    'hon.school_demo_data_begin(text,text,jsonb,text,uuid,uuid)','hon.school_demo_data_finish(text,uuid,text,jsonb)','hon.demo_data_person_tables()',
    'hon.school_demo_data_collect(uuid,uuid,uuid)','hon.school_demo_data_delete(uuid)',
    'hon.school_demo_data_attendance(uuid,uuid,uuid,uuid,text,jsonb,uuid[],integer[],integer[])'];
BEGIN
  FOREACH t IN ARRAY ARRAY['school_demo_data_sets','school_demo_data_rows'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY helpers||entry||shared LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry||shared LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    FOREACH f IN ARRAY shared LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f,r); END LOOP;
  END LOOP;
END $$;
COMMIT;
