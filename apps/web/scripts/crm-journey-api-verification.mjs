/** Real signed-session HTTP -> existing controllers/services -> guarded disposable PostgreSQL. No auth substitution. */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {issueSession,HON_SESSION_COOKIE,SESSION_SECONDS} from '@hon/auth';
import {requireFlexibleBillingAccountsLocalUrls,flexibleBillingAccountsFixture} from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';
assert.equal(process.env.HON_CRM_JOURNEY_API_TEST,'1');
await requireFlexibleBillingAccountsLocalUrls();
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'), apiRequire=createRequire(resolve(repo,'apps/api/package.json')), webRequire=createRequire(resolve(repo,'apps/web/package.json')), dbRequire=createRequire(resolve(repo,'packages/database/package.json'));
apiRequire('reflect-metadata');
const {Test}=apiRequire('@nestjs/testing'),{ValidationPipe}=apiRequire('@nestjs/common'),pg=dbRequire('pg');
const load=p=>import(pathToFileURL(resolve(repo,'apps/api/dist',p)).href);
const {RuntimeDatabaseService}=await load('foundation/runtime-database.service.js');
const classes={};
for(const file of ['foundation/hon-identity.guard.js','foundation/hon-identity.service.js','crm/lead.controller.js','crm/lead.service.js','crm/lead-create-human-ui.guard.js','crm/lead-close.controller.js','crm/lead-close.service.js','crm/lead-close.dto.js','crm/follow-up.controller.js','crm/follow-up.service.js','crm/follow-up.dto.js','crm/trial-appointment.controller.js','crm/trial-appointment.service.js','crm/trial-appointment-outcome.controller.js','crm/trial-appointment-outcome.service.js','crm/lead-registration.controller.js','crm/lead-registration.service.js','crm/lead-registration.dto.js','crm/guardian-child-enrollment.controller.js','crm/guardian-child-enrollment.service.js','crm/guardian-child-enrollment.dto.js','billing/crm-adult-membership-draft.dto.js'])Object.assign(classes,await load(file));
const database=new RuntimeDatabaseService(), owner=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false});
const session={mode:'OIDC',audience:'hon-crm-journey-disposable',secret:randomBytes(32).toString('hex')};
process.env.HON_AUTH_MODE=session.mode;process.env.HON_SESSION_AUDIENCE=session.audience;process.env.HON_SESSION_JWT_SECRET=session.secret;
let app,actor,expired=false,loseClose=false;const originalFetch=globalThis.fetch;const checks=[];
try{
 await owner.connect();const sql=(q,v=[])=>owner.query(q,v);
 assert.deepEqual((await sql("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0],{owner:flexibleBillingAccountsFixture.owner,marker:'HON disposable flexible billing accounts validation'});
 async function school(){const organizationId=randomUUID(),schoolId=randomUUID(),role=randomUUID(),user=randomUUID(),principal=randomUUID(),grant=randomUUID(),subject=`journey-${randomUUID()}`,pipeline=randomUUID(),stage=randomUUID();
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic journey org','Synthetic journey org')",[organizationId]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic journey school',$3)",[schoolId,organizationId,`synthetic-${schoolId}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')",[organizationId]);
  await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'JOURNEY_FRONT_DESK','Synthetic direct-human role')",[role,organizationId]);
  for(const permission of ['crm.lead.read','crm.lead.close','crm.lead.register','student.profile.manage','crm.follow_up.self_manage','crm.trial.schedule','crm.trial.manage'])await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,organizationId,permission]);
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic staff')",[user,subject,`${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Synthetic staff')",[principal,user]);
  await sql('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',[grant,organizationId,schoolId,principal,role]);
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic pipeline')",[pipeline,organizationId,schoolId]);
  for(const [name,position,terminal]of [['Open',1,null],['Won',2,'WON'],['Lost',3,'LOST']])await sql('INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,$5,$6,$7)',[position===1?stage:randomUUID(),organizationId,schoolId,pipeline,name,position,terminal]);
  return {organizationId,schoolId,principal,grant,subject,role,pipeline,stage};
 }
 const A=await school(),B=await school();
 async function lead(s,first){const person=randomUUID(),id=randomUUID();await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)',[person,s.organizationId,s.schoolId,first,`Synthetic-${id}`]);await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'OPEN')",[id,s.organizationId,s.schoolId,person,s.pipeline,s.stage]);return id;}
 const leadA=await lead(A,'Adult'),leadFamily=await lead(A,'Guardian');await lead(B,'Foreign');actor=A;
 const controllerNames=['LeadController','LeadCloseController','FollowUpController','TrialAppointmentController','TrialAppointmentOutcomeController','LeadRegistrationController','GuardianChildEnrollmentController'];
 const providerNames=['HonIdentityGuard','HonIdentityService','LeadService','LeadCloseService','LeadCloseHumanUiGuard','LeadCreateHumanUiGuard','FollowUpService','FollowUpHumanUiGuard','TrialAppointmentService','TrialAppointmentOutcomeService','LeadRegistrationService','LeadRegistrationHumanUiGuard','GuardianChildEnrollmentService','CrmAdultMembershipNoStoreGuard','CrmGuardianChildEnrollmentReadHumanUiGuard','CrmGuardianChildPayerDesignationHumanUiGuard','CrmGuardianChildAdditionHumanUiGuard'];
 for(const n of [...controllerNames,...providerNames])assert(classes[n],`Missing real class ${n}`);
 const module=await Test.createTestingModule({controllers:controllerNames.map(n=>classes[n]),providers:[...providerNames.map(n=>classes[n]),{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));await app.listen(0,'127.0.0.1');const origin=`http://127.0.0.1:${app.getHttpServer().address().port}`;process.env.HON_PUBLIC_ORIGIN=origin;
 const ts=webRequire('typescript'),cache=new Map();
 async function compile(file){if(cache.has(file))return cache.get(file);let code=ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  for(const match of [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)]){const spec=match[1];let url;if(spec.startsWith('.'))url=await compile(resolve(dirname(file),spec+'.ts'));else url=pathToFileURL(webRequire.resolve(spec)).href;code=code.replace(match[0],`from ${JSON.stringify(url)}`);}
  const url='data:text/javascript;base64,'+Buffer.from(code).toString('base64');cache.set(file,url);return url;
 }
 const transport=await import(await compile(resolve(repo,'apps/web/src/components/crm-journey/http.ts')));
 globalThis.fetch=async(path,options)=>{assert.match(path,/^\/api\/v1\/(?:staff\/crm\/follow-ups(?:\?queue=mine&status=ALL)?|organizations\/[a-f0-9-]+\/schools\/[a-f0-9-]+\/crm\/(?:leads(?:\?limit=50|\/[a-f0-9-]+\/(?:trials|close|register|guardian-child-enrollment))|appointments\/[a-f0-9-]+\/outcome))$/);
  const headers=new Headers(options.headers);headers.set('Origin',origin);headers.set('Sec-Fetch-Site','same-origin');headers.set('Sec-Fetch-Mode','same-origin');headers.set('Sec-Fetch-Dest','empty');
  if(actor)headers.set('Cookie',`${HON_SESSION_COOKIE}=${issueSession({externalSubject:actor.subject},session,Math.floor(Date.now()/1000)-(expired?SESSION_SECONDS+1:0))}`);
  const result=await originalFetch(origin+path.slice(4),{...options,headers});if(loseClose&&path.endsWith('/close')&&result.status===200){loseClose=false;throw new DOMException('Synthetic lost response after real commit','TimeoutError');}return result;
 };
 const signal=()=>AbortSignal.timeout(15_000),scope={organizationId:A.organizationId,schoolId:A.schoolId};
 const tables=['crm_leads','crm_appointments','crm_follow_ups','crm_follow_up_versions','crm_follow_up_requests','crm_lead_close_requests','crm_lead_registration_conversions','people','families','family_members','student_profiles','billing_accounts','memberships','membership_payment_schedules','invoices','payment_attempts','communication_messages','action_requests','ai_usage_ledger','audit_events','outbox_events','idempotency_records'];
 async function snapshot(){const out={};for(const t of tables)out[t]=(await sql(`SELECT count(*)::int n,md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) h FROM hon.${t} x`)).rows[0];return out;}
 async function deny(fn,kind){const before=await snapshot();await assert.rejects(fn,e=>e instanceof transport.JourneyError&&e.kind===kind);assert.deepEqual(await snapshot(),before);}
 const beforeRead=await snapshot();const rows=await transport.readLeads(scope,signal());assert.equal(rows.length,2);assert.deepEqual(await snapshot(),beforeRead);let selected=rows.find(r=>r.id===leadA);checks.push('bounded protected lead read without side effects');
 actor=B;await deny(()=>transport.readLeads(scope,signal()),'DENIED');const bScope={organizationId:B.organizationId,schoolId:B.schoolId};await deny(()=>transport.readQueue(scope,signal()),'DENIED');assert.equal((await transport.readLeads(bScope,signal())).length,1);actor=A;checks.push('two independently authorized organizations, foreign read and follow-up-scope denial');
 actor=null;await deny(()=>transport.readLeads(scope,signal()),'SESSION');actor=A;expired=true;await deny(()=>transport.readLeads(scope,signal()),'SESSION');expired=false;checks.push('missing and actually expired signed sessions deny without effects');
 const q=await transport.readQueue(scope,signal());assert.equal(q.principalId,A.principal);const follow=transport.prepareCommand('FOLLOW_UP',scope,selected,{expectedVersion:0,leadId:leadA,assigneeId:q.principalId,subject:'Synthetic internal planning',note:'No outbound contact',dueAt:null,priority:'NORMAL'},randomUUID());
 const [f1,f2]=await Promise.all([transport.sendCommand(follow,signal()),transport.sendCommand(follow,signal())]);assert.equal(f1.record.followUpId,f2.record.followUpId);assert.equal((await sql('SELECT count(*)::int n FROM hon.crm_follow_ups WHERE lead_id=$1',[leadA])).rows[0].n,1);checks.push('concurrent exact self-follow-up replay creates one record');
 const startsAt=new Date(Date.now()+86400000).toISOString(),endsAt=new Date(Date.now()+90000000).toISOString();const schedule=transport.prepareCommand('SCHEDULE',scope,selected,{startsAt,endsAt},randomUUID());const [a1,a2]=await Promise.all([transport.sendCommand(schedule,signal()),transport.sendCommand(schedule,signal())]);assert.equal(a1.record.id,a2.record.id);assert.equal((await sql('SELECT count(*)::int n FROM hon.crm_appointments WHERE crm_lead_id=$1',[leadA])).rows[0].n,1);checks.push('concurrent exact trial scheduling creates one appointment');
 const outcome=transport.prepareCommand('OUTCOME',scope,selected,{status:'COMPLETED',expectedVersion:1},randomUUID(),a1.record);const [o1,o2]=await Promise.all([transport.sendCommand(outcome,signal()),transport.sendCommand(outcome,signal())]);assert.equal(o1.record.version,2);assert.equal(o2.record.version,2);checks.push('concurrent terminal outcome replay advances exactly once');
 await deny(()=>transport.sendCommand({...outcome,key:randomUUID()},signal()),'REJECTED');checks.push('stale outcome version rolls back all evidence and claims');
 const c=transport.prepareCommand('CLOSE',scope,selected,{status:'WON',expectedVersion:selected.version},randomUUID());loseClose=true;await assert.rejects(()=>transport.sendCommand(c,signal()),e=>e.kind==='UNKNOWN');const saved=await snapshot();await transport.sendCommand(c,signal());assert.deepEqual(await snapshot(),saved);assert.equal((await transport.readLeads(scope,signal())).find(r=>r.id===leadA).status,'WON');checks.push('lost close result reconciles by exact key without duplicate effects');
 selected=(await transport.readLeads(scope,signal())).find(r=>r.id===leadA);const noFinancial=await snapshot();assert.equal(await transport.readRegistration(scope,selected,signal()),'NOT_REGISTERED');const register=transport.prepareCommand('REGISTER',scope,selected,{registrationPath:'ADULT',birthDate:'1990-01-02',confirmation:transport.CRM_LEAD_REGISTRATION_CONFIRMATION},randomUUID());const r=await transport.sendCommand(register,signal());assert.equal(r.record.outcome,'REGISTERED');const after=await snapshot();await transport.sendCommand(register,signal());assert.deepEqual(await snapshot(),after);assert.equal(await transport.readRegistration(scope,selected,signal()),'EXISTING_RECORD');checks.push('adult registration, recovery and exact replay without billing');
 const guardian=(await transport.readLeads(scope,signal())).find(r=>r.id===leadFamily);assert.equal(await transport.readRegistration(scope,guardian,signal()),'NOT_REGISTERED');const family=transport.prepareCommand('REGISTER',scope,guardian,{registrationPath:'GUARDIAN_CHILD',childGivenName:'SyntheticChild',childFamilyName:`Family-${randomUUID()}`,childBirthDate:'2018-01-02',confirmation:transport.CRM_LEAD_REGISTRATION_CONFIRMATION},randomUUID());const child=await transport.sendCommand(family,signal());assert.equal(child.record.outcome,'REGISTERED');assert.notEqual(child.record.studentProfileId,r.record.studentProfileId);checks.push('guardian and child registration stays separate from adult and payer authority');
 for(const t of ['billing_accounts','memberships','membership_payment_schedules','invoices','payment_attempts','communication_messages','action_requests','ai_usage_ledger'])assert.deepEqual((await snapshot())[t],noFinancial[t],t);checks.push('zero billing, membership, payment, communication, AI or provider business effects');
 const waitBefore=await snapshot();await sql('BEGIN');let waiting;
 try{
  await sql("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='crm.follow_up.self_manage'",[A.role]);
  waiting=transport.sendCommand({...follow,key:randomUUID()},signal());const denied=assert.rejects(waiting,e=>e.kind==='DENIED');
  let blocked=false;for(let i=0;i<100;i++){const r=await sql('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) waiting');if(r.rows[0].waiting){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}
  assert(blocked,'Expected real authorization lock wait');await sql('COMMIT');await denied;
 }catch(e){await sql('ROLLBACK');await waiting?.catch(()=>{});throw e;}
 assert.deepEqual(await snapshot(),waitBefore);checks.push('real HTTP command waits on permission lock, then denies revoked authority with full rollback');
 await sql("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'crm.follow_up.self_manage')",[A.role,A.organizationId]);
 actor=B;await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1",[B.organizationId]);await deny(()=>transport.readLeads(bScope,signal()),'DENIED');actor=A;checks.push('expired organization entitlement denies a genuine signed-school read');
 await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[A.grant]);await deny(()=>transport.readLeads(scope,signal()),'DENIED');await deny(()=>transport.sendCommand(follow,signal()),'DENIED');checks.push('live grant revocation denies reads and exact replay without new claims');
 console.log(`PASS CRM journey signed-session API/disposable PostgreSQL: ${checks.length} security groups`);for(const check of checks)console.log(`PASS ${check}`);
}finally{globalThis.fetch=originalFetch;if(app)await app.close();else await database.onModuleDestroy();await owner.end();}
