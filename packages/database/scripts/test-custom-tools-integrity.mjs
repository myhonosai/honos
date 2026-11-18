/** AI Customizer CM-1 custom tools (0415): real signed HON sessions -> Nest/guards -> fixed runtime SQL -> marked disposable PostgreSQL.
 *  No provider, payment, message or AI. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point; the sign-up program is opened
 *  to TEST_MODE by this proof's owner connection only, and the owner connection stands in for paid access with an ACTIVE entitlement. */
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
const {CustomToolController}=require('./dist/custom-tools/custom-tool.controller.js');
const {CustomToolService}=require('./dist/custom-tools/custom-tool.service.js');
const guards=require('./dist/custom-tools/custom-tool.guard.js');
const {SIGNUP_CONFIRMATION,CUSTOM_TOOL_SAVE_COMMAND,CUSTOM_TOOL_CHANGE_COMMAND,CUSTOM_TOOL_RECORD_COMMAND,customToolDefinitionProblems}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'custom-tools-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS CUSTOM TOOLS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const person=label=>({externalSubject:'oidc:custom-tools:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 const w={...p,org:r.organizationId,school:r.schoolId};
 w.principal=(await q('SELECT g.principal_id p FROM hon.hon_os_school_registrations s JOIN hon.principal_role_grants g ON g.id=s.owner_grant_id WHERE s.organization_id=$1',[w.org]))[0].p;
 await q("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day') ON CONFLICT(organization_id) DO UPDATE SET status='ACTIVE',tier='COMPLETE'",[w.org]);
 return w;}
async function student(w,given,family){const p=K(),s=K();
 await q('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)',[p,w.org,w.school,given,family]);
 await q('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)',[s,w.org,w.school,p]);return s;}
// A staff member holding custom_tool.use through a school role of their own (never OWNER).
async function staff(w,label,role){const p=person(label),u=K(),pr=K();
 await q('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)',[u,p.externalSubject,p.email,'Coach '+label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[pr,u,'Coach '+label]);
 const grant=(await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval \'1 hour\') RETURNING id',[w.org,w.school,pr,role,w.principal]))[0].id;
 return {...p,org:w.org,school:w.school,principal:pr,grant};}
const base=w=>`organizations/${w.org}/schools/${w.school}/custom-tools`;
const save=(w,body,key=K(),extra={})=>send(base(w)+'/drafts',{identity:w,method:'POST',key,command:CUSTOM_TOOL_SAVE_COMMAND,body,...extra});
const change=(w,id,body,key=K(),extra={})=>send(base(w)+'/'+id+'/changes',{identity:w,method:'POST',key,command:CUSTOM_TOOL_CHANGE_COMMAND,body,...extra});
const write=(w,id,body,key=K(),extra={})=>send(base(w)+'/'+id+'/records',{identity:w,method:'POST',key,command:CUSTOM_TOOL_RECORD_COMMAND,body,...extra});
const records=(w,id,qs)=>send(base(w)+'/'+id+'/records?'+new URLSearchParams(qs),{identity:w});
const L=en=>({en});
// "Build me a Demo Team Management system": members, practices with attendance and points, a dashboard, coach access.
const demoTeam=(coachRole)=>({schemaVersion:1,name:{en:'Demo Team',ko:'데모 팀',es:'Equipo de demostración'},description:L('Demo team members, practices and points'),icon:'trophy',
 entities:[
  {key:'member',label:L('Team member'),fields:[{key:'student',label:L('Student'),type:'STUDENT_REF',required:true},{key:'position',label:L('Position'),type:'CHOICE',choices:[{key:'lead',label:L('Lead')},{key:'performer',label:L('Performer')}]},
   {key:'joined',label:L('Joined'),type:'DATE'},{key:'notes',label:L('Notes'),type:'LONG_TEXT',maxLength:500}]},
  {key:'practice',label:L('Practice result'),fields:[{key:'member',label:L('Member'),type:'RECORD_REF',entity:'member',required:true},{key:'student',label:L('Student'),type:'STUDENT_REF',required:true},
   {key:'points',label:L('Points'),type:'INTEGER',min:0,max:100,required:true},{key:'attended',label:L('Attended'),type:'BOOLEAN'}]}],
 views:[{key:'members',label:L('Members'),type:'TABLE',entity:'member',columns:['student','position','joined'],sort:{field:'joined',direction:'DESC'}},
  {key:'add_member',label:L('Add member'),type:'FORM',entity:'member',fields:['student','position','joined','notes']},
  {key:'log',label:L('Log practice'),type:'FORM',entity:'practice',fields:['member','student','points','attended']},
  {key:'board',label:L('Leaderboard'),type:'DASHBOARD',entity:'practice',cards:[{key:'practices',label:L('Practices logged'),kind:'COUNT'},{key:'total',label:L('Total points'),kind:'SUM',field:'points'},
   {key:'avg',label:L('Average points'),kind:'AVERAGE',field:'points'},{key:'top',label:L('Top students'),kind:'LEADERBOARD',field:'points',groupBy:'student'}]}],
 navigation:['members','board','log'],access:coachRole?[{roleId:coachRole,capabilities:['VIEW','CREATE']}]:[]});
const evidence=async w=>(await q("SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'custom_tool.%') a,(SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'custom_tool.%') o",[w.org]))[0];

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 const tables=['custom_tools','custom_tool_versions','custom_tool_records','custom_tool_record_events','custom_tool_commands'];
 for(const t of tables){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['read_custom_tools','read_custom_tool','save_custom_tool_draft','change_custom_tool','read_custom_tool_records','read_custom_tool_dashboard','write_custom_tool_record','read_custom_tool_link_options'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE 'custom_tool%' OR p.proname LIKE '%custom_tool%')");
 assert(fns.length>=30,String(fns.length));
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 assert.equal(fns.filter(f=>entry.includes(f.proname)).length,8);
 pass('forced deny-all RLS on five new tables; runtime executes exactly eight entry points');

 const module=await Test.createTestingModule({controllers:[CustomToolController],providers:[CustomToolService,guards.CustomToolReadHumanUiGuard,guards.CustomToolSaveHumanUiGuard,guards.CustomToolChangeHumanUiGuard,guards.CustomToolRecordHumanUiGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const w of [a,b])assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code IN ('custom_tool.design','custom_tool.use')",[w.org]))[0].n,'2');
 const coachRole=(await q("INSERT INTO hon.roles(organization_id,code,name) VALUES($1,'DEMO_COACH','Demo team coach') RETURNING id",[a.org]))[0].id;
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'custom_tool.use')",[coachRole,a.org]);
 const plainRole=(await q("INSERT INTO hon.roles(organization_id,code,name) VALUES($1,'FRONT_DESK','Front desk') RETURNING id",[a.org]))[0].id;
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'custom_tool.use')",[plainRole,a.org]);
 const parentRole=(await q("INSERT INTO hon.roles(organization_id,code,name) VALUES($1,'PARENT_HELPER','Parent helper') RETURNING id",[a.org]))[0].id;
 const coach=await staff(a,'coach',coachRole),desk=await staff(a,'desk',plainRole);
 const mia=await student(a,'Mia','Synthetic'),leo=await student(a,'Leo','Synthetic'),other=await student(b,'Bea','Synthetic');

 // 2. The owner designs the Demo Team tool: closed validation, exact replay, refused key reuse, then publish.
 assert.deepEqual(ok(await send(base(a),{identity:a})),{canDesign:true,tools:[]});
 const def=demoTeam(coachRole);assert.deepEqual(customToolDefinitionProblems(def),[]);
 const broken=[
  [{...def,entities:[{...def.entities[0],fields:[{key:'student',label:L('Student'),type:'SQL'}]}]},'entities[0].fields[0]'],
  [{...def,views:[{...def.views[0],columns:['nope']},...def.views.slice(1)]},'views[0]'],
  [{...def,navigation:['ghost']},'navigation'],
  [{...def,access:[{roleId:parentRole,capabilities:['VIEW']}]},'access'],
  [{...def,access:[{roleId:coachRole,capabilities:['CREATE']}]},'access'],
  [{...def,script:'DROP TABLE hon.people'},'definition'],
  [{...def,views:[...def.views.slice(0,3),{...def.views[3],cards:[{key:'x',label:L('X'),kind:'SUM',field:'attended'}]}]},'views[3].cards'],
 ];
 for(const [bad,path] of broken){
  // The parent role is a shape the browser cannot judge; the database refuses it.
  const r=await save(a,{toolId:null,toolKey:'demo_team',expectedRevision:0,definition:bad});assert.equal(r.status,400,JSON.stringify([path,r.body]));
  assert.equal(r.body.code,'CUSTOM_TOOL_DEFINITION_INVALID');
 }
 // The runtime role cannot call the validator's helpers directly.
 const sqlBad=await restricted.query("SELECT hon.custom_tool_shape('{}'::jsonb,ARRAY['a'],'{}')").then(()=>'reached',e=>e.message);
 assert.match(sqlBad,/permission denied/);
 assert.equal((await q('SELECT count(*) n FROM hon.custom_tools WHERE organization_id=$1',[a.org]))[0].n,'0');
 const key=K();let r=await save(a,{toolId:null,toolKey:'demo_team',expectedRevision:0,definition:def},key);let d=ok(r);
 assert.equal(r.body.meta.replayed,false);assert.equal(d.tool.toolKey,'demo_team');assert.equal(d.tool.draftVersion,1);assert.equal(d.tool.publishedVersion,null);
 assert.equal(d.version.status,'DRAFT');assert.equal(d.version.origin,'NEW');assert.deepEqual(d.version.definition,def);
 assert(d.roles.some(x=>x.roleId===coachRole)&&d.roles.some(x=>x.roleId===plainRole)&&!d.roles.some(x=>x.roleId===parentRole));
 r=await save(a,{toolId:null,toolKey:'demo_team',expectedRevision:0,definition:def},key);assert.deepEqual(ok(r),d);assert.equal(r.body.meta.replayed,true);
 r=await save(a,{toolId:null,toolKey:'demo_team_two',expectedRevision:0,definition:def},key);assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');
 r=await save(a,{toolId:null,toolKey:'demo_team',expectedRevision:0,definition:def});assert.equal(r.status,409);assert.equal(r.body.code,'CUSTOM_TOOL_KEY_TAKEN');
 const tool=d.tool.toolId;
 // Nothing is live before publishing: staff see no tool and live records refuse.
 assert.deepEqual(ok(await send(base(coach),{identity:coach})).tools,[]);
 r=await records(a,tool,{entity:'member'});assert.equal(r.status,404);
 r=await change(a,tool,{operation:'PUBLISH',expectedRevision:d.tool.revision,version:1});d=ok(r);
 assert.equal(d.tool.publishedVersion,1);assert.equal(d.tool.draftVersion,null);assert.equal(d.version.status,'PUBLISHED');assert(d.version.publishedAt);
 assert.deepEqual(d.tool.navigation.map(n=>[n.viewKey,n.type]),[['members','TABLE'],['board','DASHBOARD'],['log','FORM']]);
 pass('the owner designs the Demo Team tool; broken designs, a parent role and an extra script key are refused; exact replay, key reuse and a taken key refused; nothing is live until it is published');

 // 3. Live records: links to this school's students and records, validation, versions, archive, dashboard.
 const member=async(st,extra={},w=a)=>ok(await write(w,tool,{operation:'CREATE',recordId:null,entity:'member',expectedVersion:0,preview:false,data:{student:st,position:'lead',joined:'2026-11-01',...extra}}));
 const m1=await member(mia,{notes:'Front row.\nStrong kicks.'}),m2=await member(leo,{position:'performer'});
 assert.equal(m1.version,1);assert.equal(m1.data.notes,'Front row.\nStrong kicks.');
 for(const [data,field] of [[{student:other},'student'],[{student:mia,position:'boss'},'position'],[{student:mia,joined:'2026-02-30'},'joined'],[{student:mia,ghost:1},'ghost'],
   [{position:'lead'},'student'],[{student:mia,notes:'x'.repeat(501)},'notes'],[{student:'not-a-uuid'},'student']]){
  r=await write(a,tool,{operation:'CREATE',recordId:null,entity:'member',expectedVersion:0,preview:false,data});assert.equal(r.status,400,JSON.stringify([field,r.body]));
  if(r.body.code==='CUSTOM_TOOL_RECORD_INVALID')assert.equal(r.body.field,field);
 }
 const practice=(m,st,points)=>write(a,tool,{operation:'CREATE',recordId:null,entity:'practice',expectedVersion:0,preview:false,data:{member:m,student:st,points,attended:true}});
 ok(await practice(m1.recordId,mia,40));ok(await practice(m1.recordId,mia,35));ok(await practice(m2.recordId,leo,50));
 r=await practice(m1.recordId,mia,101);assert.equal(r.status,400);r=await practice(K(),mia,10);assert.equal(r.status,400);r=await practice(m1.recordId,mia,2.5);assert.equal(r.status,400);
 let list=ok(await records(a,tool,{entity:'member'}));
 assert.equal(list.total,2);assert.equal(list.refs.students[mia],'Mia Synthetic');assert.deepEqual(list.capabilities,['VIEW','CREATE','EDIT','ARCHIVE']);
 const pl=ok(await records(a,tool,{entity:'practice'}));assert.equal(pl.refs.records[m1.recordId],'lead');
 r=await write(a,tool,{operation:'UPDATE',recordId:m2.recordId,entity:'member',expectedVersion:1,preview:false,data:{student:leo,position:'lead',joined:'2026-11-02'}});const m2b=ok(r);assert.equal(m2b.version,2);
 r=await write(a,tool,{operation:'UPDATE',recordId:m2.recordId,entity:'member',expectedVersion:1,preview:false,data:{student:leo}});assert.equal(r.status,409);assert.equal(r.body.code,'CUSTOM_TOOL_VERSION_CONFLICT');
 r=await write(a,tool,{operation:'ARCHIVE',recordId:m2.recordId,entity:'member',expectedVersion:2,preview:false,data:null});assert.equal(ok(r).version,3);assert(ok(r).archivedAt);
 assert.equal(ok(await records(a,tool,{entity:'member'})).total,1);assert.equal(ok(await records(a,tool,{entity:'member',archived:'true'})).total,1);
 r=await write(a,tool,{operation:'UPDATE',recordId:m2.recordId,entity:'member',expectedVersion:3,preview:false,data:{student:leo}});assert.equal(r.status,409);assert.equal(r.body.code,'CUSTOM_TOOL_STATE');
 ok(await write(a,tool,{operation:'RESTORE',recordId:m2.recordId,entity:'member',expectedVersion:3,preview:false,data:null}));
 const board=ok(await send(base(a)+'/'+tool+'/dashboards/board',{identity:a}));
 const card=k=>board.cards.find(c=>c.key===k);
 assert.equal(card('practices').value,3);assert.equal(card('total').value,125);assert.equal(card('avg').value,41.67);
 assert.deepEqual(card('top').rows,[{key:mia,value:75,label:'Mia Synthetic'},{key:leo,value:50,label:'Leo Synthetic'}]);
 assert.deepEqual((await q('SELECT kind FROM hon.custom_tool_record_events WHERE record_id=$1 ORDER BY seq',[m2.recordId])).map(x=>x.kind),['CREATED','UPDATED','ARCHIVED','RESTORED']);
 const outbox=(await q("SELECT event_type,payload::text p FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'custom_tool.record.%'",[a.org]));
 assert.equal(outbox.length,8);assert(outbox.every(o=>!/Mia|Strong kicks|Front row/.test(o.p)),'identifier-only outbox');
 assert(outbox.some(o=>o.event_type==='custom_tool.record.created'&&JSON.parse(o.p).toolKey==='demo_team'));
 const opts=ok(await send(base(a)+'/'+tool+'/link-options?kind=STUDENT&search=mi',{identity:a}));assert.deepEqual(opts.options,[{id:mia,label:'Mia Synthetic'}]);
 pass('live records link only to this school\'s students and records; types, choices, dates, ranges, required and unknown fields are checked; versions, archive and restore; dashboard counts, sums, averages and a named leaderboard; identifier-only outbox events for Automation');

 // 4. Each tool's own access rules: the coach may view and add, front desk staff see nothing, nobody inherits design.
 let ct=ok(await send(base(coach),{identity:coach}));assert.equal(ct.canDesign,false);assert.equal(ct.tools.length,1);assert.deepEqual(ct.tools[0].capabilities,['CREATE','VIEW']);
 assert.equal(ct.tools[0].draftVersion,null);
 const cv=ok(await send(base(coach)+'/'+tool,{identity:coach}));assert.deepEqual(cv.versions,[]);assert.deepEqual(cv.roles,[]);assert.equal(cv.version.versionNo,1);
 r=await send(base(coach)+'/'+tool+'?version=1',{identity:coach});assert.equal(r.status,200);
 assert.equal(ok(await records(coach,tool,{entity:'member'})).total,2);
 ok(await write(coach,tool,{operation:'CREATE',recordId:null,entity:'practice',expectedVersion:0,preview:false,data:{member:m1.recordId,student:mia,points:5}}));
 r=await write(coach,tool,{operation:'UPDATE',recordId:m1.recordId,entity:'member',expectedVersion:1,preview:false,data:{student:mia}});assert.equal(r.status,403);
 r=await write(coach,tool,{operation:'ARCHIVE',recordId:m1.recordId,entity:'member',expectedVersion:1,preview:false,data:null});assert.equal(r.status,403);
 r=await save(coach,{toolId:tool,toolKey:null,expectedRevision:d.tool.revision,definition:def});assert.equal(r.status,403);
 r=await change(coach,tool,{operation:'ARCHIVE',expectedRevision:d.tool.revision,version:null});assert.equal(r.status,403);
 r=await records(coach,tool,{entity:'member',preview:'true'});assert.equal(r.status,404);
 assert.deepEqual(ok(await send(base(desk),{identity:desk})).tools,[]);
 r=await records(desk,tool,{entity:'member'});assert.equal(r.status,404);r=await send(base(desk)+'/'+tool,{identity:desk});assert.equal(r.status,404);
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[coach.grant,a.principal]);
 r=await send(base(coach),{identity:coach});assert.equal(r.status,403);
 pass('each tool\'s access rules: a coach role views and adds but cannot edit, archive, design or preview; a role without a rule sees nothing; a revoked grant is refused');

 // 5. Change and restore. A field keeps its type; preview records stay out of live data; removed fields keep their values.
 d=ok(await send(base(a)+'/'+tool,{identity:a}));
 const v2def=structuredClone(def);v2def.entities[0].fields.push({key:'rank',label:L('Belt rank'),type:'CHOICE',choices:[{key:'white',label:L('White')},{key:'black',label:L('Black')}]});
 v2def.views[0].columns.push('rank');
 const retype=structuredClone(v2def);retype.entities[1].fields[2]={key:'points',label:L('Points'),type:'TEXT'};retype.views[3].cards=[{key:'practices',label:L('Practices logged'),kind:'COUNT'}];
 r=await save(a,{toolId:tool,toolKey:null,expectedRevision:d.tool.revision,definition:retype});assert.equal(r.status,400);assert.match(r.body.path,/a field keeps its type/);
 r=await save(a,{toolId:tool,toolKey:null,expectedRevision:d.tool.revision-1,definition:v2def});assert.equal(r.status,409);assert.equal(r.body.code,'CUSTOM_TOOL_VERSION_CONFLICT');
 d=ok(await save(a,{toolId:tool,toolKey:null,expectedRevision:d.tool.revision,definition:v2def}));assert.equal(d.tool.draftVersion,2);assert.equal(d.version.origin,'EDIT');assert.equal(d.tool.publishedVersion,1);
 // The designer tries the draft with preview records; live readers never see them and the live definition is unchanged.
 const pv=ok(await write(a,tool,{operation:'CREATE',recordId:null,entity:'member',expectedVersion:0,preview:true,data:{student:mia,rank:'black'}}));assert.equal(pv.preview,true);
 r=await write(a,tool,{operation:'CREATE',recordId:null,entity:'member',expectedVersion:0,preview:false,data:{student:mia,rank:'black'}});assert.equal(r.status,400);assert.equal(r.body.field,'rank');
 assert.equal(ok(await records(a,tool,{entity:'member',preview:'true'})).total,1);assert.equal(ok(await records(a,tool,{entity:'member'})).total,2);
 d=ok(await change(a,tool,{operation:'PUBLISH',expectedRevision:d.tool.revision,version:2}));assert.equal(d.tool.publishedVersion,2);
 assert.deepEqual(d.versions.map(v=>[v.versionNo,v.status]),[[2,'PUBLISHED'],[1,'SUPERSEDED']]);
 r=await records(a,tool,{entity:'member',preview:'true'});assert.equal(r.status,404);
 // v3 takes the notes field out: its values are hidden, kept, and survive an edit.
 const v3def=structuredClone(v2def);v3def.entities[0].fields=v3def.entities[0].fields.filter(f=>f.key!=='notes');v3def.views[1].fields=v3def.views[1].fields.filter(f=>f!=='notes');
 d=ok(await save(a,{toolId:tool,toolKey:null,expectedRevision:d.tool.revision,definition:v3def}));d=ok(await change(a,tool,{operation:'PUBLISH',expectedRevision:d.tool.revision,version:3}));
 let mine=ok(await records(a,tool,{entity:'member'})).records.find(x=>x.recordId===m1.recordId);assert.equal(mine.data.notes,undefined);
 ok(await write(a,tool,{operation:'UPDATE',recordId:m1.recordId,entity:'member',expectedVersion:1,preview:false,data:{student:mia,position:'lead',joined:'2026-11-01',rank:'black'}}));
 assert.equal((await q('SELECT data->>\'notes\' n FROM hon.custom_tool_records WHERE id=$1',[m1.recordId]))[0].n,'Front row.\nStrong kicks.');
 // An open draft blocks restore; discard it, then restore v1 into a new draft and publish it: notes come back.
 d=ok(await save(a,{toolId:tool,toolKey:null,expectedRevision:d.tool.revision,definition:v3def}));assert.equal(d.tool.draftVersion,4);
 r=await change(a,tool,{operation:'RESTORE',expectedRevision:d.tool.revision,version:1});assert.equal(r.status,409);assert.equal(r.body.code,'CUSTOM_TOOL_DRAFT_OPEN');
 d=ok(await change(a,tool,{operation:'DISCARD_DRAFT',expectedRevision:d.tool.revision,version:4}));assert.equal(d.tool.draftVersion,null);
 d=ok(await change(a,tool,{operation:'RESTORE',expectedRevision:d.tool.revision,version:1}));assert.equal(d.tool.draftVersion,5);assert.equal(d.version.origin,'RESTORE');assert.equal(d.version.restoredFrom,1);
 assert.deepEqual(d.version.definition,def);
 d=ok(await change(a,tool,{operation:'PUBLISH',expectedRevision:d.tool.revision,version:5}));
 mine=ok(await records(a,tool,{entity:'member'})).records.find(x=>x.recordId===m1.recordId);assert.equal(mine.data.notes,'Front row.\nStrong kicks.');assert.equal(mine.data.rank,undefined);
 assert.deepEqual(d.versions.map(v=>[v.versionNo,v.status,v.origin]),[[5,'PUBLISHED','RESTORE'],[4,'DISCARDED','EDIT'],[3,'SUPERSEDED','EDIT'],[2,'SUPERSEDED','EDIT'],[1,'SUPERSEDED','NEW']]);
 // Archive hides the tool from staff and stops live writes; unarchive brings it back.
 d=ok(await change(a,tool,{operation:'ARCHIVE',expectedRevision:d.tool.revision,version:null}));
 r=await write(a,tool,{operation:'CREATE',recordId:null,entity:'member',expectedVersion:0,preview:false,data:{student:mia}});assert.equal(r.status,404);
 d=ok(await change(a,tool,{operation:'UNARCHIVE',expectedRevision:d.tool.revision,version:null}));assert.equal(d.tool.status,'ACTIVE');
 const ev=await evidence(a);assert(Number(ev.a)>=20&&Number(ev.a)===Number(ev.o),JSON.stringify(ev));
 pass('changes open a new draft; a field cannot change type; preview records stay out of live data; a removed field\'s values are kept; restore needs no open draft, copies an earlier version and brings its fields back; archive hides the tool');

 // 6. School isolation, delegation, browser commands, entitlement.
 r=await send(base(b)+'/'+tool,{identity:b});assert.equal(r.status,404);
 r=await records(b,tool,{entity:'member'});assert.equal(r.status,404);
 r=await send(`organizations/${a.org}/schools/${a.school}/custom-tools`,{identity:b});assert.equal(r.status,403);
 const bt=ok(await save(b,{toolId:null,toolKey:'demo_team',expectedRevision:0,definition:demoTeam(null)}));
 ok(await change(b,bt.tool.toolId,{operation:'PUBLISH',expectedRevision:bt.tool.revision,version:1}));
 r=await write(b,bt.tool.toolId,{operation:'CREATE',recordId:null,entity:'member',expectedVersion:0,preview:false,data:{student:mia}});assert.equal(r.status,400);
 r=await save(b,{toolId:null,toolKey:'other',expectedRevision:0,definition:demoTeam(coachRole)});assert.equal(r.status,400);
 r=await send(base(a),{identity:a,headers:{'x-hon-delegated-by-principal-id':K()}});assert.equal(r.status,403);
 r=await save(a,{toolId:null,toolKey:'x_tool',expectedRevision:0,definition:def},K(),{command:CUSTOM_TOOL_RECORD_COMMAND});assert.equal(r.status,403);
 r=await send(base(a),{identity:person('stranger')});assert.equal(r.status,403);
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[a.org]);
 r=await send(base(a),{identity:a});assert.equal(r.status,403);
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[a.org]);
 assert.equal(ok(await send(base(a),{identity:a})).tools.length,1);
 pass('another school cannot read, write or link this school\'s tool, students or roles; delegation, wrong browser command, unknown person and a suspended entitlement are refused');

 // 7. Concurrency: one tool per key, one winner per record version, no lost publish.
 let rs=await Promise.all(Array.from({length:6},()=>save(a,{toolId:null,toolKey:'race_tool',expectedRevision:0,definition:def})));
 assert.equal(rs.filter(x=>x.status===200).length,1);assert(rs.filter(x=>x.status!==200).every(x=>x.status===409),JSON.stringify(rs.map(x=>x.body.code)));
 const cur=ok(await records(a,tool,{entity:'member'})).records.find(x=>x.recordId===m1.recordId);
 rs=await Promise.all(Array.from({length:5},(_,i)=>write(a,tool,{operation:'UPDATE',recordId:m1.recordId,entity:'member',expectedVersion:cur.version,preview:false,data:{student:mia,position:i%2?'lead':'performer'}})));
 assert.equal(rs.filter(x=>x.status===200).length,1);assert(rs.filter(x=>x.status!==200).every(x=>x.status===409),JSON.stringify(rs.map(x=>x.body.code)));
 d=ok(await send(base(a)+'/'+tool,{identity:a}));d=ok(await save(a,{toolId:tool,toolKey:null,expectedRevision:d.tool.revision,definition:v2def}));
 rs=await Promise.all([change(a,tool,{operation:'PUBLISH',expectedRevision:d.tool.revision,version:d.tool.draftVersion}),change(a,tool,{operation:'DISCARD_DRAFT',expectedRevision:d.tool.revision,version:d.tool.draftVersion}),
   ...Array.from({length:4},()=>write(a,tool,{operation:'CREATE',recordId:null,entity:'member',expectedVersion:0,preview:false,data:{student:leo,rank:'white'}}))]);
 assert.equal(rs.slice(0,2).filter(x=>x.status===200).length,1);
 const published=(await q('SELECT published_version p FROM hon.custom_tools WHERE id=$1',[tool]))[0].p;
 // A record write either ran before the publish (and the old definition refused rank) or after it (and v6 accepted it).
 for(const x of rs.slice(2))assert(x.status===200||(x.status===400&&x.body.field==='rank'),JSON.stringify(x.body));
 if(rs[1].status===200)assert(rs.slice(2).every(x=>x.status===400));
 assert.equal((await q("SELECT count(*) n FROM hon.custom_tool_versions WHERE tool_id=$1 AND status='PUBLISHED'",[tool]))[0].n,'1');assert(published>=5);
 pass('concurrent saves of one tool key give one tool; concurrent edits of one record version give one winner; publish and discard of one draft give one result; record writes see one definition');

 // 8. Evidence guard.
 await assert.rejects(q("UPDATE hon.custom_tool_versions SET definition='{}' WHERE tool_id=$1 AND version_no=1",[tool]),/CUSTOM_TOOL_IMMUTABLE/);
 await assert.rejects(q('DELETE FROM hon.custom_tool_records WHERE id=$1',[m1.recordId]),/CUSTOM_TOOL_IMMUTABLE/);
 await assert.rejects(q('UPDATE hon.custom_tools SET school_id=$2 WHERE id=$1',[tool,b.school]),/CUSTOM_TOOL_IMMUTABLE/);
 await assert.rejects(q("UPDATE hon.custom_tool_record_events SET kind='UPDATED' WHERE record_id=$1",[m1.recordId]),/CUSTOM_TOOL_IMMUTABLE/);
 await assert.rejects(q('TRUNCATE hon.custom_tool_commands CASCADE'),/CUSTOM_TOOL_IMMUTABLE|cannot truncate/);
 pass('published versions, record history, tool ownership and command receipts cannot be edited, deleted or truncated');
 console.log('PASS: custom tools (0415), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
