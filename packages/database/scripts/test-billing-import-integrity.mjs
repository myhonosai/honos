/** Membership and opening-balance import (0334): real signed HON sessions -> Nest/guards -> fixed runtime SQL -> marked disposable
 *  PostgreSQL. No provider, processor, charge, message or AI. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point; the sign-up
 *  program is opened to TEST_MODE by this proof's owner connection only, and paid access is stood in by the owner connection. Synthetic names only. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {BillingImportController}=require('./dist/migration/billing-import.controller.js');
const {BillingImportService}=require('./dist/migration/billing-import.service.js');
const guards=require('./dist/migration/billing-import-human-ui.guard.js');
const {SIGNUP_CONFIRMATION,verifyBillingImportDetail}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'billing-import-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS BILLING '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body).slice(0,600));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const refused=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body).slice(0,600));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));assert(!('data' in r.body));};
const person=label=>({externalSubject:'oidc:billing:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const base=w=>`organizations/${w.org}/schools/${w.school}/billing-imports`;
const csvOf=rows=>rows.map(r=>r.map(c=>/[",\n]/.test(c)?'"'+c.replaceAll('"','""')+'"':c).join(',')).join('\n')+'\n';
const stage=(w,rows,mapping,extra={})=>send(base(w),{identity:w,method:'POST',command:'billing.import.stage',body:{csv:csvOf(rows),mapping},...extra});
const detail=async(w,id)=>verifyBillingImportDetail(ok(await send(base(w)+'/'+id,{identity:w})),id);
const decide=(w,id,v,decisions,extra={})=>send(base(w)+'/'+id+'/decisions',{identity:w,method:'POST',command:'billing.import.decide',body:{expectedVersion:v,decisions},...extra});
const finalize=(w,id,v,selectedIndices,extra={})=>send(base(w)+'/'+id+'/finalize',{identity:w,method:'POST',command:'billing.import.finalize',body:{expectedVersion:v,selectedIndices},...extra});
const setAccess=(w,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[w.org,status]);
const live=async w=>(await q(`SELECT (SELECT count(*) FROM hon.class_sessions WHERE organization_id=$1) s,(SELECT count(*) FROM hon.class_bookings WHERE organization_id=$1) b,
 (SELECT count(*) FROM hon.attendance_records WHERE organization_id=$1) a`,[w.org]))[0];

const person0=async(w,given,family)=>(await q("INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id",[w.org,w.school,given,family]))[0].id;
// A student in their own family, with the given guardians (each {given,family,contact}) in the same family.
async function student(w,given,family,birth,guardians=[]){
 const fam=(await q("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,$3) RETURNING id",[w.org,w.school,family+' family']))[0].id;
 const p=await person0(w,given,family);
 await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'STUDENT',false)",[w.org,w.school,fam,p]);
 const gs=[];for(const g of guardians){const id=g.id??await person0(w,g.given,g.family);gs.push(id);
  await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'GUARDIAN',$5)",[w.org,w.school,fam,id,!!g.contact]);}
 const profile=(await q("INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5) RETURNING id",[w.org,w.school,p,fam,birth]))[0].id;
 return {profile,person:p,guardians:gs,family:fam};
}
const quiet=async w=>(await q(`SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=$1) pa,(SELECT count(*) FROM hon.communication_messages WHERE organization_id=$1) cm,
 (SELECT count(*) FROM hon.school_pay_autopay_plans WHERE organization_id=$1) ap,(SELECT count(*) FROM hon.school_pay_autopay_cycles WHERE organization_id=$1) ac,
 (SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type IN ('billing.membership.activated','billing.invoice.issued')) ev`,[w.org]))[0];
const addDays=(day,n)=>{const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['billing_import_batches','billing_import_rows','billing_import_requests']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['stage_billing_import','decide_billing_import','finalize_billing_import','read_billing_imports','read_billing_import'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%billing_import%'");
 assert.equal(fns.length,25);
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 pass('forced deny-all RLS on three new tables; runtime executes exactly five entry points');

 const module=await Test.createTestingModule({controllers:[BillingImportController],providers:[BillingImportService,...Object.values(guards),HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 await setAccess(a,'ACTIVE');await setAccess(b,'ACTIVE');
 const today=(await q("SELECT to_char(hon.membership_local_date(clock_timestamp(),'America/Chicago'),'YYYY-MM-DD') d"))[0].d;
 const ownerPrincipal=(await q("SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1",[a.externalSubject]))[0].id;
 const before=await quiet(a);

 // 2. Stage: every cell revalidated, students and payers matched exactly, amounts in minor units, stated defaults.
 const kid=await student(a,'Mina','Park','2016-04-02',[{given:'Sora',family:'Park'}]);
 const sib=await student(a,'Jae','Park','2018-09-09',[{id:kid.guardians[0]}]);
 const adult=await student(a,'Dana','Reyes','1990-01-01');
 const two=await student(a,'Ari','Cho','2015-02-02',[{given:'Min',family:'Cho'},{given:'Hana',family:'Cho'}]);
 const contact=await student(a,'Bo','Kim','2014-03-03',[{given:'Eun',family:'Kim'},{given:'Ji',family:'Kim',contact:true}]);
 const lonelyMinor=await student(a,'Tae','Yoon','2017-07-07');
 const nextCharge=addDays(today,3),later=addDays(today,40);
 await q(`WITH p AS (INSERT INTO hon.membership_plans(organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,'BLACK_BELT_CLUB',1,$3) RETURNING id)
   INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,availability,currency,price_minor,billing_frequency,term_kind,actor_principal_id)
   SELECT id,1,$1,$2,'Black Belt Club','AVAILABLE','USD',19900,'MONTHLY','OPEN_ENDED',$3 FROM p`,[a.org,a.school,ownerPrincipal]);
 const head=['First','Last','Born','Payer first','Payer last','Plan','Price','Every','Start','End','Next bill','Owes','Owed by','Notes'];
 const map={First:'studentGivenName',Last:'studentFamilyName',Born:'birthDate','Payer first':'payerGivenName','Payer last':'payerFamilyName',Plan:'planName',
  Price:'amount',Every:'frequency',Start:'startedOn',End:'endsOn','Next bill':'nextChargeOn',Owes:'balanceOwed','Owed by':'balanceDueOn',Notes:'ignore'};
 const rows=[head,
  ['mina','PARK','','','','black belt club','$149.00','Monthly','2025-09-01','',nextCharge,'75.50','','private note'],
  ['Jae','Park','','','','Little Ninjas 2x/wk','1,250','per month','2025-10-01',addDays(today,365),later,'','',''],
  ['Dana','Reyes','','','','Adult BJJ','39','weekly','2024-01-15','',nextCharge,'0','',''],
  ['Ari','Cho','','Hana','Cho','Kids','120','annual','2025-01-01','',later,'200',addDays(today,10),''],
  ['Bo','Kim','','','','Kids','99.9','Monthly','2025-01-01','',nextCharge,'','',''],
  ['Ari','Cho','','','','Kids','120','Monthly','2025-01-01','',nextCharge,'','',''],
  ['Tae','Yoon','','','','Kids','99','Monthly','2025-01-01','',nextCharge,'','',''],
  ['Nobody','Here','','','','Kids','abc','fortnightly','2025-01-01','2020-01-01',addDays(today,-1),'-5','',''],
  ['=cmd','Park','','','','Kids','10','Monthly','2025-01-01','',nextCharge,'','',''],
  ['Mina','Park','','Dana','Reyes','Kids','10','Monthly','2025-01-01','',nextCharge,'','','']];
 const key=K();let r=await stage(a,rows,map,{key});let batch=ok(r);
 assert.equal(batch.kind,'MEMBERSHIPS');assert.equal(batch.rowCount,10);assert.equal(batch.validCount,5);assert.equal(batch.schoolTimezone,'America/Chicago');assert.equal(r.body.meta.replayed,false);
 r=await stage(a,rows,map,{key});assert.deepEqual(ok(r),batch);assert.equal(r.body.meta.replayed,true);
 refused(await stage(a,rows.slice(0,3),map,{key}),409,'IDEMPOTENCY_KEY_REUSED');
 let d=await detail(a,batch.id);
 assert.deepEqual(d.rows[0].normalized,{studentGivenName:'mina',studentFamilyName:'PARK',birthDate:'',payerGivenName:'',payerFamilyName:'',planName:'black belt club',
  amount:'$149.00',currency:'USD',frequency:'MONTHLY',startedOn:'2025-09-01',endsOn:'',nextChargeOn:nextCharge,balanceOwed:'75.50',balanceDueOn:today,
  amountMinor:'14900',balanceMinor:'7550',planCode:'BLACK_BELT_CLUB',planMatched:true});
 assert.equal(d.rows[0].raw.at(-1),'');
 assert.deepEqual([d.rows[0].matchedStudentProfileId,d.rows[0].payerPersonId,d.rows[0].payerName],[kid.profile,kid.guardians[0],'Sora Park']);
 assert.deepEqual([d.rows[1].normalized.amountMinor,d.rows[1].normalized.planCode,d.rows[1].normalized.planMatched,d.rows[1].payerPersonId],['125000','LITTLE_NINJAS_2X_WK',false,kid.guardians[0]]);
 assert.deepEqual([d.rows[2].payerPersonId,d.rows[2].normalized.balanceMinor,d.rows[2].normalized.frequency],[adult.person,'0','WEEKLY']);
 assert.deepEqual([d.rows[3].payerPersonId,d.rows[3].normalized.frequency],[two.guardians[1],'ANNUAL']);
 assert.deepEqual([d.rows[4].payerPersonId,d.rows[4].normalized.amountMinor],[contact.guardians[1],'9990']);
 assert.deepEqual(d.rows.slice(5).map(x=>x.errors.sort()),[['payer:CHOOSE_PAYER','row:REPEATED_IN_FILE'],['payer:NO_GUARDIAN'],
  ['amount:USE_A_PRICE','balanceOwed:FORMULA_INJECTION','balanceOwed:USE_AN_AMOUNT','endsOn:ALREADY_ENDED','endsOn:BEFORE_START','frequency:USE_WEEKLY_MONTHLY_OR_ANNUAL','nextChargeOn:AFTER_END','nextChargeOn:OUT_OF_RANGE','student:NOT_FOUND'],
  ['studentGivenName:FORMULA_INJECTION','student:NOT_FOUND'],['payer:NOT_IN_FAMILY','row:REPEATED_IN_FILE']].map(x=>x.sort()));
 assert(d.rows.slice(5).every(x=>x.matchedStudentProfileId===null&&x.payerPersonId===null));
 refused(await stage(a,[['First','Last'],['A','B']],{First:'studentGivenName',Last:'studentFamilyName'}),400,'BILLING_IMPORT_INVALID');
 refused(await stage(a,[['First','Last','Plan','Price','Every','Start','Next'],['A','B','P','1','monthly','2025-01-01',today]],
  {First:'studentGivenName',Last:'studentFamilyName',Plan:'planName',Price:'amount',Every:'frequency',Start:'startedOn',Next:'className'}),400,'BILLING_IMPORT_INVALID');
 const nothing=await q("SELECT (SELECT count(*) FROM hon.memberships WHERE organization_id=$1) m,(SELECT count(*) FROM hon.invoices WHERE organization_id=$1) i,(SELECT count(*) FROM hon.billing_accounts WHERE organization_id=$1) b",[a.org]);
 assert.deepEqual(nothing[0],{m:'0',i:'0',b:'0'});
 // Currencies: only codes the parser knows are accepted. JPY is whole units; VND (zero-decimal), KWD (three-decimal) and an unknown
 // code are refused, never stored at the wrong scale; an existing account in an unsupported currency is refused the same way.
 const g=await register('gamma');await setAccess(g,'ACTIVE');
 const moss=await student(g,'Lee','Moss','1985-05-05');
 await q("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,'VND','CANONICAL')",[g.org,g.school,moss.person]);
 const cmap={...map,Cur:'currency'},chead=[...head,'Cur'];
 const cb=ok(await stage(g,[chead,
  ['Nobody','One','','','','Kids','5000','Monthly','2025-01-01','',nextCharge,'1200','','','jpy'],
  ['Nobody','Two','','','','Kids','5000.50','Monthly','2025-01-01','',nextCharge,'','','','JPY'],
  ['Nobody','Three','','','','Kids','500000','Monthly','2025-01-01','',nextCharge,'','','','VND'],
  ['Nobody','Four','','','','Kids','10','Monthly','2025-01-01','',nextCharge,'','','','KWD'],
  ['Nobody','Five','','','','Kids','10','Monthly','2025-01-01','',nextCharge,'','','','ABC'],
  ['Lee','Moss','','','','Kids','10','Monthly','2025-01-01','',nextCharge,'','','','']],cmap));
 const cd=await detail(g,cb.id);
 assert.deepEqual([cd.rows[0].normalized.currency,cd.rows[0].normalized.amountMinor,cd.rows[0].normalized.balanceMinor],['JPY','5000','1200']);
 assert(cd.rows[1].errors.includes('amount:USE_A_PRICE'));
 for(const i of [2,3,4,5]){assert(cd.rows[i].errors.includes('currency:UNSUPPORTED'),JSON.stringify(cd.rows[i].errors));assert.equal(cd.rows[i].normalized.amountMinor,'');}
 assert.deepEqual(cd.rows[5].errors,['currency:UNSUPPORTED']);
 assert.equal((await q("SELECT hon.billing_import_money('500000','VND') v"))[0].v,null);
 pass('staging revalidates every cell in the database, matches students and payers exactly (named guardian, only guardian, billing contact, adult student), converts amounts to minor units in supported currencies only, matches catalog plans, and refuses unknown students, unclear or minor payers, past charges, ended terms, formulas and repeats while creating no record');

 // 3. Decide and finalize: ACTIVE memberships with 0177 evidence, ACTIVE schedules, ISSUED balances, one account per payer.
 refused(await decide(a,batch.id,1,[{index:6,choice:'IMPORT'}]),400,'BILLING_IMPORT_ROW_NOT_IMPORTABLE');
 batch=ok(await decide(a,batch.id,1,[1,2,3,4,5].map(index=>({index,choice:'IMPORT'}))));
 refused(await finalize(a,batch.id,2,[1,2,3,4,5]),409,'BILLING_IMPORT_SELECTION_REQUIRED');
 batch=ok(await decide(a,batch.id,2,[6,7,8,9,10].map(index=>({index,choice:'SKIP'}))));
 refused(await finalize(a,batch.id,3,[1,2,3]),409,'BILLING_IMPORT_SELECTION_REQUIRED');refused(await finalize(a,batch.id,2,[1,2,3,4,5]),409,'VERSION_CONFLICT');
 const fk=K();batch=ok(await finalize(a,batch.id,3,[1,2,3,4,5],{key:fk}));
 assert.deepEqual([batch.status,batch.importedCount,batch.balanceCount],['FINALIZED',5,2]);
 r=await finalize(a,batch.id,3,[1,2,3,4,5],{key:fk});assert.equal(r.body.meta.replayed,true);assert.deepEqual(ok(r),batch);
 d=await detail(a,batch.id);
 const made=await q(`SELECT m.id,m.state::text,m.version,m.plan_code,m.participant_person_id p,b.responsible_person_id payer,b.currency::text cur,b.account_classification cls,
   to_char(m.term_started_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI') s,to_char(m.term_ends_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI') e,
   s.frequency,s.amount_minor,s.status sst,to_char(s.next_charge_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI') nx,s.auto_renew,
   d.decision_basis,d.membership_source,d.reason_code,d.authorizing_permission,d.actor_principal_id actor,p.period_version,p.change_kind,p.date_source,p.start_date::text sd,p.end_date::text ed,
   i.status::text ist,i.total_minor,to_char(i.due_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI:SS') due
  FROM hon.memberships m JOIN hon.billing_accounts b ON b.id=m.billing_account_id JOIN hon.membership_payment_schedules s ON s.membership_id=m.id
   JOIN hon.membership_activation_decisions d ON d.membership_id=m.id JOIN hon.membership_effective_periods p ON p.membership_id=m.id
   LEFT JOIN hon.invoices i ON i.membership_id=m.id WHERE m.organization_id=$1 ORDER BY (SELECT r.row_index FROM hon.billing_import_rows r WHERE r.membership_id=m.id)`,[a.org]);
 assert.equal(made.length,5);
 assert(made.every(m=>m.state==='ACTIVE'&&m.version===2&&m.sst==='ACTIVE'&&m.decision_basis==='STAFF_ACTIVATION_PRE_POLICY'&&m.membership_source==='GENERIC_LEGACY'
  &&m.reason_code==='LEGACY_MEMBERSHIP'&&m.authorizing_permission==='billing.membership.activate'&&m.actor===ownerPrincipal&&m.period_version===1&&m.change_kind==='INITIAL'
  &&m.date_source==='SUGGESTED'&&m.cur==='USD'&&m.cls==='CANONICAL'));
 assert.deepEqual(made.map(m=>[m.p,m.payer,m.plan_code,m.frequency,m.amount_minor,m.s,m.nx]),[
  [kid.person,kid.guardians[0],'BLACK_BELT_CLUB','MONTHLY',14900,'2025-09-01 00:00',nextCharge+' 00:00'],
  [sib.person,kid.guardians[0],'LITTLE_NINJAS_2X_WK','MONTHLY',125000,'2025-10-01 00:00',later+' 00:00'],
  [adult.person,adult.person,'ADULT_BJJ','WEEKLY',3900,'2024-01-15 00:00',nextCharge+' 00:00'],
  [two.person,two.guardians[1],'KIDS','ANNUAL',12000,'2025-01-01 00:00',later+' 00:00'],
  [contact.person,contact.guardians[1],'KIDS','MONTHLY',9990,'2025-01-01 00:00',nextCharge+' 00:00']]);
 assert.deepEqual([made[1].e,made[1].ed,made[1].auto_renew,made[0].e,made[0].auto_renew],[addDays(today,366)+' 00:00',addDays(today,365),false,null,true]);
 assert.deepEqual(made.map(m=>[m.ist,m.total_minor]),[['ISSUED',7550],[null,null],[null,null],['ISSUED',20000],[null,null]]);
 assert.equal(made[0].due,today+' 23:59:59');assert.equal(made[3].due,addDays(today,10)+' 23:59:59');
 assert.equal((await q("SELECT count(*) n FROM hon.billing_accounts WHERE organization_id=$1",[a.org]))[0].n,'4');
 assert.equal(d.rows[0].created.billingAccountId,d.rows[1].created.billingAccountId);
 assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE organization_id=$1 AND action_code='billing.import.row_applied'",[a.org]))[0].n,'5');
 const evidence=await q("SELECT next_state::text s FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'billing.import.%' UNION ALL SELECT payload::text FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'billing.import.%'",[a.org]);
 assert(evidence.every(e=>!/Park|Reyes|Cho|Kim|Ninjas|BLACK_BELT|: ?(14900|7550)\b|amount|2025-09-01/i.test(e.s)),'identifier-only audit and outbox');
 // The imported terms are exactly what the 0322 autopay cycle would bill; nothing was charged, enrolled or sent.
 const due=await admin.query('BEGIN').then(async()=>{try{
  await admin.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true)",[a.org,a.school]);
  return (await admin.query("SELECT membership_id,amount_minor,discount_minor FROM hon.school_pay_autopay_due($1,$2::date,'America/Chicago',hon.school_pay_current_discount_rule()) ORDER BY amount_minor",[d.rows[0].created.billingAccountId,nextCharge])).rows;
 }finally{await admin.query('ROLLBACK');}});
 assert.deepEqual(due.map(x=>[x.membership_id,x.amount_minor,x.discount_minor]),[[made[0].id,14900,0]]);
 assert.deepEqual(await quiet(a),before);
 pass('finalize confirms each chosen row as an ACTIVE membership with its 0177 decision and INITIAL period, an ACTIVE schedule with the imported terms, an ISSUED invoice for a balance above zero, one canonical account per payer shared by siblings, identifier-only evidence, and the autopay cycle sees exactly the due line, while no charge, autopay enrollment, message or activation event happens');

 // 4. Re-import and races: a student with a membership is refused; two finalizes of one new student import once.
 d=await detail(a,ok(await stage(a,rows.slice(0,2),map)).id);assert.deepEqual(d.rows[0].errors,['student:HAS_MEMBERSHIP']);
 const fresh=await student(a,'Noa','Lim','1995-05-05');
 const newRows=[head,['Noa','Lim','','','','Adult','50','monthly','2025-01-01','',nextCharge,'','','']];
 const [x1,x2]=[ok(await stage(a,newRows,map)),ok(await stage(a,newRows,map))];
 for(const x of [x1,x2])assert.equal(x.validCount,1);
 const y1=ok(await decide(a,x1.id,1,[{index:1,choice:'IMPORT'}])),y2=ok(await decide(a,x2.id,1,[{index:1,choice:'IMPORT'}]));
 const racing=await Promise.all([finalize(a,x1.id,y1.version,[1]),finalize(a,x2.id,y2.version,[1])]);
 assert.deepEqual(racing.map(x=>x.status).sort(),[200,409]);assert.equal(racing.find(x=>x.status===409).body.code,'BILLING_IMPORT_STALE');
 assert.equal((await q("SELECT count(*) n FROM hon.memberships m WHERE m.participant_person_id=$1",[fresh.person]))[0].n,'1');
 // A payer who changed after staging stops the finalize with nothing written.
 const moved=await student(a,'Iva','Seo','2016-06-06',[{given:'Yul',family:'Seo'}]);
 const mv=ok(await stage(a,[head,['Iva','Seo','','','','Kids','80','monthly','2025-01-01','',nextCharge,'','','']],map));
 await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'GUARDIAN',false)",[a.org,a.school,moved.family,await person0(a,'Lia','Seo')]);
 const mv2=ok(await decide(a,mv.id,1,[{index:1,choice:'IMPORT'}]));
 refused(await finalize(a,mv.id,mv2.version,[1]),409,'BILLING_IMPORT_STALE');
 assert.equal((await q("SELECT count(*) n FROM hon.memberships m WHERE m.participant_person_id=$1",[moved.person]))[0].n,'0');
 pass('a student who already has a membership is flagged on re-import, two concurrent finalizes of one student import once (the other is STALE), and a payer that changed after staging stops the finalize with nothing written');

 // 5. Authority: all three permissions; other schools, delegation, a wrong command and lost access are refused.
 const bStudent=await student(b,'Mina','Park','1980-01-01');
 const bBatch=ok(await stage(b,rows.slice(0,2),map));
 assert.equal((await detail(b,bBatch.id)).rows[0].matchedStudentProfileId,bStudent.profile);
 refused(await send(base(a)+'/'+bBatch.id,{identity:a}),404,'BILLING_IMPORT_NOT_FOUND');
 refused(await decide(a,bBatch.id,1,[{index:1,choice:'SKIP'}]),404,'BILLING_IMPORT_NOT_FOUND');
 refused(await send(base(a),{identity:b}),403);
 refused(await send(base(a),{identity:a,headers:{'x-hon-delegated-by-principal-id':K()}}),403);
 refused(await stage(a,rows.slice(0,2),map,{command:'history.import.stage'}),403);
 refused(await send(base(a),{identity:person('stranger')}),403);
 await q("DELETE FROM hon.role_permissions WHERE organization_id=$1 AND permission_code='billing.invoice.issue'",[b.org]);
 refused(await stage(b,rows.slice(0,2),map),403,'BILLING_IMPORT_FORBIDDEN');refused(await send(base(b),{identity:b}),403,'BILLING_IMPORT_FORBIDDEN');
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT r.id,r.organization_id,'billing.invoice.issue' FROM hon.roles r WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role",[b.org]);
 await q("DELETE FROM hon.role_permissions WHERE organization_id=$1 AND permission_code='billing.membership.activate'",[b.org]);
 refused(await send(base(b),{identity:b}),403,'BILLING_IMPORT_FORBIDDEN');
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT r.id,r.organization_id,'billing.membership.activate' FROM hon.roles r WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role",[b.org]);
 ok(await send(base(b),{identity:b}));
 // A family role anywhere disqualifies a staff member, as in the 0322 and 0330 actors.
 const bPrincipal=(await q("SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1",[b.externalSubject]))[0].id;
 const famRole=(await q("INSERT INTO hon.roles(organization_id,code,name) VALUES($1,'GUARDIAN','Guardian') RETURNING id",[b.org]))[0].id;
 await q("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)",[b.org,b.school,bPrincipal,famRole]);
 refused(await send(base(b),{identity:b}),403,'BILLING_IMPORT_FORBIDDEN');
 await setAccess(b,'SUSPENDED');
 refused(await send(base(b),{identity:b}),403,'BILLING_IMPORT_FORBIDDEN');refused(await decide(b,bBatch.id,1,[{index:1,choice:'IMPORT'}]),403,'BILLING_IMPORT_FORBIDDEN');
 assert.equal((await q("SELECT count(*) n FROM hon.billing_import_batches WHERE organization_id=$1",[b.org]))[0].n,'1');
 assert.equal((await q("SELECT count(*) n FROM hon.memberships WHERE organization_id=$1",[b.org]))[0].n,'0');
 pass('import needs students.import, billing.membership.activate and billing.invoice.issue; batches of another school are not found; another school, delegation, a wrong browser command, a stranger, a family role and suspended access are refused with nothing written');

 // 6. Evidence rows cannot be changed or removed outside the entry points; imported memberships stay guarded.
 await assert.rejects(()=>q('DELETE FROM hon.billing_import_batches WHERE organization_id=$1',[a.org]),/BILLING_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q("UPDATE hon.billing_import_rows SET choice='SKIP' WHERE organization_id=$1 AND membership_id IS NOT NULL",[a.org]),/BILLING_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q("UPDATE hon.billing_import_rows SET normalized='{}' WHERE organization_id=$1 AND membership_id IS NULL",[a.org]),/BILLING_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q('UPDATE hon.billing_import_requests SET response=$2 WHERE organization_id=$1',[a.org,'{}']),/BILLING_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q('TRUNCATE hon.billing_import_rows'),/BILLING_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q("UPDATE hon.memberships SET plan_code='X' WHERE id=$1",[made[0].id]),/MEMBERSHIP_STATE_TRANSITION_DENIED/);
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.billing_import_rows'),e=>e.code==='42501');
 pass('batches, rows and requests refuse delete, truncate and rewrites; an imported membership is guarded like any confirmed one; the runtime role cannot read the tables');
 console.log('PASS: membership and opening-balance import (0334), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
