BEGIN;

-- Pictures inside email blasts BL3b (0653, allocated by the coordinator 2026-11-22). Owner decisions (David): 2026-11-18
-- "Email pictures, video as a link"; 2026-11-22 "Allow media storage". Builds on 0621 (blasts) and 0628 (media library).
-- Spec: docs/architecture/SCHOOL_BLASTS.md (Pictures). Contract: @hon/contracts school-blasts.ts.
-- Rules:
--   P1  An email blast body may hold up to 10 picture lines. A picture line is a whole line {{picture:<assetId>}} (lower
--       case id) and nothing else. Texts never hold pictures. The body is still at most 3,500 characters and, with each
--       picture line counted as one character, the 0621 plain-text rules.
--   P2  Saving and sending a blast both check that every picture in its body is a READY picture of the same school
--       (BLAST_PICTURE_NOT_READY otherwise). A picture deleted after sending is left out of emails not yet delivered.
--   P3  The delivery worker reads a campaign email's pictures through hon.communication_email_pictures(delivery, lease):
--       only the lease holder of a SENDING email delivery, only for a CAMPAIGN message of an EMAIL blast, only READY
--       pictures of that school whose id is in the blast body. It answers each picture's link token, title and size; never
--       a storage key. Picture lines in a message that match none of them are dropped by the worker.
--   P4  The runtime gains nothing. save_school_blast and send_school_blast keep their signatures and grants; the worker
--       gains EXECUTE on the one picture lookup.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Blast pictures require a restricted runtime'; END IF;
  IF to_regprocedure('hon.send_school_blast(text,jsonb,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.resolve_school_media_link(text)') IS NULL
    OR to_regprocedure('hon.communication_email_subject(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '0653 requires 0621, 0628 and 0424'; END IF;
END $$;

-- The distinct picture ids of a body's picture lines.
CREATE FUNCTION hon.school_blast_picture_ids(p_body text) RETURNS uuid[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(array_agg(DISTINCT m[1]::uuid ORDER BY m[1]::uuid),'{}'::uuid[])
    FROM regexp_matches(coalesce(p_body,''),'^\{\{picture:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}$','gn') m
$$;
-- A blast body: SMS as in 0621; EMAIL up to 3,500 characters with at most 10 picture lines, each counted as one character
-- for the 0621 plain-text rules.
CREATE FUNCTION hon.school_blast_body_ok(v jsonb,chan text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE chan
    WHEN 'SMS' THEN hon.school_blast_text_ok(v,1,1000)
    WHEN 'EMAIL' THEN coalesce(jsonb_typeof(v)='string' AND length(v#>>'{}')<=3500
      AND (SELECT count(*) FROM regexp_matches(v#>>'{}','^\{\{picture:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\}$','gn'))<=10
      AND hon.school_blast_text_ok(to_jsonb(regexp_replace(v#>>'{}','^\{\{picture:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\}$','x','gn')),1,3500),false)
    ELSE false END
$$;
-- Every picture of a body is a READY picture of this school.
CREATE FUNCTION hon.school_blast_pictures_ready(org uuid,school uuid,p_body text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM unnest(hon.school_blast_picture_ids(p_body)) i WHERE NOT EXISTS(SELECT 1 FROM hon.school_media_assets a
      WHERE a.id=i AND a.organization_id=org AND a.school_id=school AND a.kind='IMAGE' AND a.state='READY')) THEN
    RAISE EXCEPTION 'BLAST_PICTURE_NOT_READY' USING ERRCODE='55000'; END IF;
END $$;

DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid='hon.school_blasts'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%school_blast_text_ok(to_jsonb(body)%';
  IF c IS NULL THEN RAISE EXCEPTION '0653: the 0621 body check is missing'; END IF;
  EXECUTE format('ALTER TABLE hon.school_blasts DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE hon.school_blasts ADD CONSTRAINT school_blasts_body_ok CHECK (hon.school_blast_body_ok(to_jsonb(body),channel));

-- The pictures of the campaign email a lease is sending (P3). NULL when the message is not a blast email with pictures.
CREATE FUNCTION hon.communication_email_pictures(p_delivery uuid,p_lease uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('assetId',a.id,'token',a.link_token,'title',a.title,'width',a.width,'height',a.height) ORDER BY a.id),'[]'::jsonb)
      FROM hon.school_media_assets a WHERE a.organization_id=b.organization_id AND a.school_id=b.school_id AND a.kind='IMAGE' AND a.state='READY'
        AND a.id=ANY(hon.school_blast_picture_ids(b.body)))
    FROM hon.communication_deliveries d
    JOIN hon.communication_messages m ON m.id=d.message_id AND m.organization_id=d.organization_id AND m.school_id=d.school_id
    JOIN hon.school_blasts b ON b.id=m.origin_id AND b.organization_id=m.organization_id AND b.school_id=m.school_id
   WHERE d.id=p_delivery AND p_lease IS NOT NULL AND d.lease_token=p_lease AND d.status='SENDING' AND d.channel='EMAIL'
     AND m.channel='EMAIL' AND m.origin_kind='CAMPAIGN' AND b.channel='EMAIL' AND b.status<>'DRAFT'
     AND cardinality(hon.school_blast_picture_ids(b.body))>0
$$;

-- Create or edit a DRAFT. Input {blastId|null, expectedVersion (0 for new), name, channel, subject|null, body, audience}.
CREATE OR REPLACE FUNCTION hon.save_school_blast(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; b hon.school_blasts%ROWTYPE;
  before jsonb; expected integer; chan text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['audience','blastId','body','channel','expectedVersion','name','subject']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT (jsonb_typeof(p->'blastId')='null' OR (jsonb_typeof(p->'blastId')='string' AND p->>'blastId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    OR (jsonb_typeof(p->'blastId')='null')<>((p->>'expectedVersion')::integer=0)
    OR NOT hon.school_blast_line_ok(p->'name',100)
    OR jsonb_typeof(p->'channel') IS DISTINCT FROM 'string' OR p->>'channel' NOT IN ('EMAIL','SMS')
    OR (p->>'channel'='EMAIL' AND NOT hon.school_blast_line_ok(p->'subject',150))
    OR (p->>'channel'='SMS' AND jsonb_typeof(p->'subject') IS DISTINCT FROM 'null')
    OR NOT hon.school_blast_body_ok(p->'body',p->>'channel')
    OR NOT hon.school_blast_audience_ok(p->'audience') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer; chan:=p->>'channel';
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.send');
  prior:=hon.school_blast_begin(subject,'school_blast.save',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('blast',prior,'replayed',true); END IF;
  PERFORM hon.school_blast_pictures_ready(org,school,p->>'body');
  IF jsonb_typeof(p->'blastId')='null' THEN
    INSERT INTO hon.school_blasts(organization_id,school_id,name,channel,subject,body,audience,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,p->>'name',chan,CASE chan WHEN 'EMAIL' THEN p->>'subject' END,p->>'body',p->'audience',actor,actor) RETURNING * INTO b;
  ELSE
    SELECT * INTO b FROM hon.school_blasts x WHERE x.id=(p->>'blastId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BLAST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF b.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF b.status<>'DRAFT' THEN RAISE EXCEPTION 'BLAST_NOT_DRAFT' USING ERRCODE='55000'; END IF;
    before:=jsonb_build_object('status',b.status,'version',b.version,'channel',b.channel);
    UPDATE hon.school_blasts SET name=p->>'name',channel=chan,subject=CASE chan WHEN 'EMAIL' THEN p->>'subject' END,body=p->>'body',audience=p->'audience',
        version=b.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=b.id RETURNING * INTO b;
  END IF;
  RETURN jsonb_build_object('blast',hon.school_blast_finish(subject,key,actor,'school_blast.saved',b,before,request,correlation),'replayed',false);
END $$;

-- Send now (sendAt null) or schedule (a future instant within 60 days). Input {blastId, expectedVersion, sendAt}.
CREATE OR REPLACE FUNCTION hon.send_school_blast(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; b hon.school_blasts%ROWTYPE;
  before jsonb; at timestamptz; school_name text; staff_name text; person hon.people%ROWTYPE; body text; subj text; msg uuid; reachable integer;
  ids uuid[]; outcomes text[]; i integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['blastId','expectedVersion','sendAt']
    OR jsonb_typeof(p->'blastId') IS DISTINCT FROM 'string' OR p->>'blastId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT (jsonb_typeof(p->'sendAt')='null' OR (jsonb_typeof(p->'sendAt')='string'
      AND p->>'sendAt' ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  BEGIN at:=(p->>'sendAt')::timestamptz; EXCEPTION WHEN others THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
  IF at IS NOT NULL AND (to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p->>'sendAt'
      OR at<=clock_timestamp()+interval '1 minute' OR at>clock_timestamp()+interval '60 days') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.send');
  prior:=hon.school_blast_begin(subject,'school_blast.send',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('blast',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_blast:'||school::text,0));
  SELECT * INTO b FROM hon.school_blasts x WHERE x.id=(p->>'blastId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLAST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF b.status<>'DRAFT' THEN RAISE EXCEPTION 'BLAST_NOT_DRAFT' USING ERRCODE='55000'; END IF;
  PERFORM hon.school_blast_pictures_ready(org,school,b.body);
  IF (SELECT count(*) FROM hon.school_blasts x WHERE x.organization_id=org AND x.school_id=school AND x.queued_at>clock_timestamp()-interval '24 hours')>=10 THEN
    RAISE EXCEPTION 'BLAST_DAILY_LIMIT' USING ERRCODE='55000'; END IF;
  SELECT coalesce(array_agg(x.person_id ORDER BY x.person_id),'{}'),coalesce(array_agg(x.outcome ORDER BY x.person_id),'{}'),count(*) FILTER (WHERE x.outcome='QUEUED')
    INTO ids,outcomes,reachable FROM hon.school_blast_resolve(org,school,b.channel,b.audience) x;
  IF reachable=0 THEN RAISE EXCEPTION 'BLAST_NO_RECIPIENTS' USING ERRCODE='55000'; END IF;
  IF reachable>2000 THEN RAISE EXCEPTION 'BLAST_AUDIENCE_TOO_LARGE' USING ERRCODE='55000'; END IF;
  before:=jsonb_build_object('status',b.status,'version',b.version,'channel',b.channel);
  UPDATE hon.school_blasts SET status='QUEUED',send_at=at,queued_at=clock_timestamp(),queued_by_principal_id=actor,recipient_count=reachable,
      version=b.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=b.id RETURNING * INTO b;
  SELECT s.name INTO school_name FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  staff_name:=hon.staff_shift_display_name(actor);
  FOR i IN 1..coalesce(array_length(ids,1),0) LOOP
    msg:=NULL;
    IF outcomes[i]='QUEUED' THEN
      SELECT * INTO person FROM hon.people x WHERE x.id=ids[i] AND x.organization_id=org AND x.school_id=school;
      body:=hon.school_blast_render(b.body,person.given_name,person.family_name,school_name,staff_name);
      subj:=CASE WHEN b.channel='EMAIL' THEN hon.school_blast_render(b.subject,person.given_name,person.family_name,school_name,staff_name) END;
      IF char_length(body)>4000 OR char_length(subj)>150 THEN RAISE EXCEPTION 'BLAST_TEXT_TOO_LONG' USING ERRCODE='22023'; END IF;
      INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,scheduled_at,created_by_principal_id,
          queued_by_principal_id,origin_kind,origin_id,email_subject)
        VALUES(org,school,ids[i],b.channel::hon.communication_message_channel,body,'QUEUED',at,actor,actor,'CAMPAIGN',b.id,
          CASE WHEN b.channel='EMAIL' THEN regexp_replace(btrim(subj),'[[:cntrl:]]',' ','g') END)
        RETURNING id INTO msg;
    END IF;
    INSERT INTO hon.school_blast_recipients(blast_id,organization_id,school_id,person_id,outcome,message_id) VALUES(b.id,org,school,ids[i],outcomes[i],msg);
  END LOOP;
  RETURN jsonb_build_object('blast',hon.school_blast_finish(subject,key,actor,'school_blast.queued',b,before,request,correlation),'replayed',false);
END $$;
DO $$ DECLARE r text; f text;
  helpers text[]:=ARRAY['hon.school_blast_picture_ids(text)','hon.school_blast_body_ok(jsonb,text)','hon.school_blast_pictures_ready(uuid,uuid,text)'];
  worker text:='hon.communication_email_pictures(uuid,uuid)';
BEGIN
  FOREACH f IN ARRAY helpers||worker LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_communication_worker',worker);
  END IF;
END $$;
COMMIT;
