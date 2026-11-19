/** School websites (WB2, 0361): real signed HON sessions -> Nest/guards -> fixed runtime SQL -> marked disposable PostgreSQL.
 *  No provider, payment, message, AI or domain. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point; the
 *  sign-up program is opened to TEST_MODE by this proof's owner connection only, and paid access is stood in by the owner
 *  connection. Synthetic names only. */
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
const {SchoolWebsiteController,PublishedSchoolWebsiteController}=require('./dist/website/school-website.controller.js');
const {SchoolWebsiteService}=require('./dist/website/school-website.service.js');
const guards=require('./dist/website/school-website-human-ui.guard.js');
const {publicSiteTransport}=require('./dist/website/public-site-transport.js');
const {SIGNUP_CONFIRMATION,verifySchoolWebsite,verifyPublishedSchoolWebsite,validateWebsiteDocument,WEBSITE_MAX_DOCUMENT_BYTES,WEBSITE_STARTER_ART,WEBSITE_TEMPLATES,WEBSITE_FONTS,websiteStarterArtUrl}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'school-website-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS WEBSITE '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body).slice(0,600));assert.equal(r.headers['cache-control'],'private, no-store');return r.body;};
const refused=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body).slice(0,600));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));assert(!('data' in r.body));};
const person=label=>({externalSubject:'oidc:website:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const base=w=>`organizations/${w.org}/schools/${w.school}/website`;
const read=async w=>ok(await send(base(w),{identity:w})).data;
const cmd=(w,op,body,extra={})=>send(base(w)+(op==='create'?'':'/'+(op==='save'?'draft':op)),{identity:w,method:'POST',command:'website.'+op,body,...extra});
const pub=slug=>send('public/sites/'+slug);
const setAccess=(w,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[w.org,status]);
const palette={primary:'#1f3a8a',accent:'#f59e0b',background:'#ffffff',surface:'#f3f4f6',text:'#111827'};
const hero=(heading,patch={})=>({id:'hero',type:'HERO',props:{heading,subheading:'Classes for ages 4 to adult.',ctaLabel:'Book a free class',ctaHref:'#trial',imageUrl:'',layout:'CENTER',...patch}});
const doc=(heading='Synthetic Dojo',extra={})=>({schemaVersion:1,theme:{template:'FAMILY_FRIENDLY',font:'FRIENDLY',logoUrl:'',palette},pages:[
 {slug:'home',kind:'HOME',title:'Home',inNav:true,seo:{title:'Synthetic Dojo',description:'Martial arts for families.'},campaignId:null,sections:[hero(heading),
  {id:'trial',type:'TRIAL_CTA',props:{heading:'Try a class',body:'Your first class is free.',ctaLabel:'Book now',ctaHref:'/programs'}},
  {id:'faq',type:'FAQ',props:{heading:'Questions',items:[{question:'What should my child wear?',answer:'Comfortable clothes.\nWe lend a uniform.'}]}},
  ...(extra.homeSections??[])]},
 {slug:'programs',kind:'PROGRAM',title:'Programs',inNav:true,seo:{title:'Programs',description:''},campaignId:null,sections:[
  {id:'list',type:'PROGRAMS',props:{heading:'Programs',intro:'',items:[{name:'Little Tigers',ages:'4-6',description:'Focus and fun.',imageUrl:'https://images.example.invalid/tigers.jpg'}]}}]},
 ...(extra.pages??[])]});

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['school_websites','school_website_versions','school_website_requests']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['read_school_website','mutate_school_website','read_published_school_website'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%school_website%' AND p.proname NOT LIKE '%website_ai%'");
 assert.equal(fns.length,16);
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);
 assert.deepEqual((await q("SELECT code FROM hon.permissions WHERE code LIKE 'website.%' ORDER BY code")).map(r=>r.code),['website.edit','website.publish','website.read']);
 pass('forced deny-all RLS on three new tables; runtime executes exactly three entry points; three website permissions');

 // 2. The database refuses every unsafe or malformed document, independently of the API.
 const good=doc();assert.equal((await q('SELECT hon.school_website_document_ok($1::jsonb) ok',[good]))[0].ok,true);
 const bad=[
  d=>{d.pages[0].sections[0].props.ctaHref='javascript:alert(1)';},
  d=>{d.pages[0].sections[0].props.imageUrl='data:image/png;base64,AAAA';},
  d=>{d.pages[0].sections[0].props.imageUrl='http://insecure.example.invalid/a.png';},
  d=>{d.pages[0].sections[0].props.html='<script>x</script>';},
  d=>{d.pages[0].sections[0].type='RAW_HTML';},
  d=>{d.pages[0].sections[0].props.heading='bad‮bidi';},
  d=>{d.pages[0].sections[0].props.heading='two\nlines';},
  d=>{d.pages[0].sections[0].props.layout='FULL';},
  d=>{d.theme.palette.primary='red';},
  d=>{d.theme.palette.extra='#000000';},
  d=>{d.theme.template='CUSTOM';},
  d=>{d.pages[0].slug='index';},
  d=>{d.pages[1].slug='home';},
  d=>{d.pages[1].kind='HOME';},
  d=>{d.pages[0].sections[1].props.ctaHref='/missing';},
  d=>{d.pages[0].sections.push({...d.pages[0].sections[0]});},
  d=>{d.pages[0].sections=[];},
  d=>{d.pages[0].campaignId=K();},
  d=>{d.pages[0].sections[2].props.items=Array.from({length:21},()=>({question:'q',answer:'a'}));},
  d=>{d.pages[0].sections[0].props.heading='x'.repeat(121);},
  d=>{d.pages.push(...Array.from({length:19},(_,i)=>({...structuredClone(d.pages[1]),slug:'p'+i})));},
  d=>{d.schemaVersion=2;},
  d=>{d.pages[0].sections.push({id:'v',type:'VIDEO',props:{provider:'YOUTUBE',videoId:'bad id!',title:''}});},
  d=>{d.pages[0].sections[0].props.heading='line\u2028separator';},
  d=>{d.pages[0].sections[0].props.subheading='paragraph\u2029separator';},
 ];
 for(const [i,change]of bad.entries()){const d=structuredClone(good);change(d);assert.equal((await q('SELECT hon.school_website_document_ok($1::jsonb) ok',[d]))[0].ok,false,'bad document '+i);
  assert.throws(()=>validateWebsiteDocument(d),/Invalid website/,'shared validator, bad document '+i);}
 // 0560 starter art: exactly the eleven shipped /site-art/ paths are images, in every image field, on both sides; any other
 // same-origin path, a query, a different extension or a path that only contains a starter name is refused.
 for(const name of WEBSITE_STARTER_ART){const d=structuredClone(good);const url=websiteStarterArtUrl(name);d.pages[0].sections[0].props.imageUrl=url;d.theme.logoUrl=url;
  assert.equal((await q('SELECT hon.school_website_document_ok($1::jsonb) ok',[d]))[0].ok,true,'starter art '+name);assert.doesNotThrow(()=>validateWebsiteDocument(d));}
 assert.equal(WEBSITE_STARTER_ART.length,11);
 // 0560 templates and fonts: every shared template and font is accepted by the database; an unknown one is refused by both.
 for(const template of WEBSITE_TEMPLATES)for(const font of WEBSITE_FONTS){const d=structuredClone(good);d.theme.template=template;d.theme.font=font;
  assert.equal((await q('SELECT hon.school_website_document_ok($1::jsonb) ok',[d]))[0].ok,true,'template '+template+' '+font);assert.doesNotThrow(()=>validateWebsiteDocument(d));}
 for(const [k,v]of [['template','NEON'],['template','bento'],['font','COMIC']]){const d=structuredClone(good);d.theme[k]=v;
  assert.equal((await q('SELECT hon.school_website_document_ok($1::jsonb) ok',[d]))[0].ok,false,k+' '+v);assert.throws(()=>validateWebsiteDocument(d),/Invalid website/);}
 for(const url of ['/site-art/other.webp','/site-art/hero-bold.png','/site-art/hero-bold.webp?x=1','/site-art/../hero-bold.webp','/x/site-art/hero-bold.webp','site-art/hero-bold.webp','/site-art/hero-bold.webp/','//site-art/hero-bold.webp']){
  const d=structuredClone(good);d.pages[0].sections[0].props.imageUrl=url;
  assert.equal((await q('SELECT hon.school_website_document_ok($1::jsonb) ok',[d]))[0].ok,false,'not starter art '+url);assert.throws(()=>validateWebsiteDocument(d),/Invalid website/,url);}
 // Only link fields are links: text that starts with '/' is just text, for the database and the shared validator alike.
 const slashText=structuredClone(good);slashText.pages[0].sections.push({id:'about',type:'TEXT',props:{heading:'/about us',body:'/ Classes start at 4 PM.'}});
 assert.equal((await q('SELECT hon.school_website_document_ok($1::jsonb) ok',[slashText]))[0].ok,true);assert.doesNotThrow(()=>validateWebsiteDocument(slashText));
 // The size limit is measured the same way on both sides (PostgreSQL's jsonb text), right at the boundary.
 const sized=n=>{const d=structuredClone(good);d.pages.push(...Array.from({length:8},(_,i)=>({slug:'faq-'+i,kind:'CUSTOM',title:'FAQ',inNav:false,seo:{title:'',description:''},campaignId:null,
  sections:Array.from({length:30},(_,j)=>({id:'f'+j,type:'FAQ',props:{heading:'',items:Array.from({length:20},()=>({question:'',answer:''}))}}))})));
  d.pages.push({slug:'pad',kind:'CUSTOM',title:'Pad',inNav:false,seo:{title:'',description:''},campaignId:null,
   sections:Array.from({length:30},(_,j)=>({id:'t'+j,type:'TEXT',props:{heading:'',body:'x'.repeat(Math.max(0,Math.min(4000,n-4000*j)))}}))});return d;};
 const base0=(await q('SELECT octet_length($1::jsonb::text) n',[sized(0)]))[0].n;const room=WEBSITE_MAX_DOCUMENT_BYTES-base0;assert(room>0&&room<30*4000,'boundary fixture '+room);
 assert(Buffer.byteLength(JSON.stringify(sized(room+1)))<WEBSITE_MAX_DOCUMENT_BYTES,'compact JSON would wrongly pass');
 for(const [n,expected]of [[room,true],[room+1,false]]){const d=sized(n);
  assert.equal((await q('SELECT hon.school_website_document_ok($1::jsonb) ok',[d]))[0].ok,expected,'database size '+n);
  if(expected)assert.doesNotThrow(()=>validateWebsiteDocument(d));else assert.throws(()=>validateWebsiteDocument(d),/document size/);}
 pass('database and shared rules refuse script links, data/http images, unknown fields and types, bidi/newline/line-separator characters, bad colours, page and link rules, limits; accept exactly the eleven 0560 starter-art paths and every shared template and font; agree on text starting with / and on the exact size boundary');

 const module=await Test.createTestingModule({controllers:[SchoolWebsiteController,PublishedSchoolWebsiteController],providers:[SchoolWebsiteService,...Object.values(guards),HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.use(publicSiteTransport());app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 await setAccess(a,'ACTIVE');await setAccess(b,'ACTIVE');
 const leadsBefore=(await q('SELECT count(*) n FROM hon.crm_leads'))[0].n;

 // 3. Read before create; create with exact replay, changed-input key reuse, one site per school, unique address.
 const empty=await read(a);assert.equal(empty.website,null);assert.deepEqual(empty.templates,[...WEBSITE_TEMPLATES]);
 const slugA='alpha-'+K().slice(0,8);const createKey=K();
 const created=ok(await cmd(a,'create',{publicSlug:slugA,name:'Alpha website',document:doc()},{key:createKey}));
 verifySchoolWebsite(created.data);assert.equal(created.meta.replayed,false);assert.equal(created.data.status,'DRAFT');assert.equal(created.data.draftRevision,1);assert.equal(created.data.publishedVersion,null);
 const replay=ok(await cmd(a,'create',{publicSlug:slugA,name:'Alpha website',document:doc()},{key:createKey}));
 assert.equal(replay.meta.replayed,true);assert.deepEqual(replay.data,created.data);
 refused(await cmd(a,'create',{publicSlug:slugA,name:'Changed',document:doc()},{key:createKey}),409,'IDEMPOTENCY_KEY_REUSED');
 refused(await cmd(a,'create',{publicSlug:'alpha-two-'+K().slice(0,6),name:'Second',document:doc()}),409,'SCHOOL_WEBSITE_EXISTS');
 refused(await cmd(b,'create',{publicSlug:slugA,name:'Copy',document:doc()}),409,'SCHOOL_WEBSITE_ADDRESS_TAKEN');
 for(const slug of ['admin','ab','-bad','bad-','Upper','a--b'])refused(await cmd(b,'create',{publicSlug:slug,name:'Bad',document:doc()}),400,'SCHOOL_WEBSITE_INVALID');
 refused(await cmd(b,'create',{publicSlug:'beta-x',name:'Bad',document:{...doc(),extra:true}}),400,'SCHOOL_WEBSITE_INVALID');
 assert.equal((await read(a)).website.id,created.data.id);
 pass('create from a document: exact replay, key reuse refused, one site per school, unique validated address');

 // 4. Draft saves need the current revision; references must belong to the school.
 refused(await cmd(a,'save',{expectedRevision:5,name:'Alpha website',document:doc('Stale')}),409,'VERSION_CONFLICT');
 const s1=ok(await cmd(a,'save',{expectedRevision:1,name:'Alpha website',document:doc('Alpha Martial Arts')}));assert.equal(s1.data.draftRevision,2);
 const foreignForm={id:'form',type:'LEAD_FORM',props:{heading:'Ask us',body:'',publicFormId:'ab'.repeat(24)}};
 refused(await cmd(a,'save',{expectedRevision:2,name:'Alpha website',document:doc('x',{homeSections:[foreignForm]})}),400,'SCHOOL_WEBSITE_REFERENCE_INVALID');
 const landing={slug:'summer',kind:'LANDING',title:'Summer camp',inNav:false,seo:{title:'Summer camp',description:''},campaignId:K(),sections:[hero('Summer camp')]};
 refused(await cmd(a,'save',{expectedRevision:2,name:'Alpha website',document:doc('x',{pages:[landing]})}),400,'SCHOOL_WEBSITE_REFERENCE_INVALID');
 // A booking type of this school (DRAFT, then ACTIVE, later ARCHIVED) is accepted in a draft; school B's is not.
 const typeOf=async w=>{const actor=(await q("SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1",[w.externalSubject]))[0].id;
  return (await q(`INSERT INTO hon.school_booking_types(organization_id,school_id,name,description,template,duration_minutes,spots_per_time,weekly_hours,horizon_days,notice_hours,audience,actor_principal_id)
   VALUES($1,$2,'Free evaluation','','OTHER',30,2,'[{"day":1,"start":"09:00","end":"10:00"}]'::jsonb,30,0,'OPEN',$3) RETURNING id,public_id`,[w.org,w.school,actor]))[0];};
 const typeA=await typeOf(a),typeB=await typeOf(b);
 const booking=pid=>({id:'book',type:'BOOKING',props:{heading:'Book a free evaluation',body:'',ctaLabel:'Pick a time',bookingPublicId:pid}});
 refused(await cmd(a,'save',{expectedRevision:2,name:'Alpha website',document:doc('x',{homeSections:[booking(typeB.public_id)]})}),400,'SCHOOL_WEBSITE_REFERENCE_INVALID');
 const s2=ok(await cmd(a,'save',{expectedRevision:2,name:'Alpha website',document:doc('Alpha Martial Arts',{homeSections:[booking(typeA.public_id)]})}));assert.equal(s2.data.draftRevision,3);
 pass('draft saves: optimistic revision, cross-school or unknown forms, booking types and campaigns refused');

 // 5. Publishing needs every reference live now; the public read is the published snapshot only.
 refused(await cmd(a,'publish',{expectedRevision:3,note:'First'}),409,'SCHOOL_WEBSITE_REFERENCE_NOT_LIVE');
 refused(await pub(slugA),404);
 await q("UPDATE hon.school_booking_types SET status='ACTIVE',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[typeA.id]);
 const p1=ok(await cmd(a,'publish',{expectedRevision:3,note:'First'}));
 assert.equal(p1.data.status,'PUBLISHED');assert.equal(p1.data.publishedVersion,1);assert.equal(p1.data.draftRevision,4);assert.equal(p1.data.versions[0].source,'PUBLISH');
 let live=await pub(slugA);assert.equal(live.status,200);assert.equal(live.headers['cache-control'],'no-store');
 const site=verifyPublishedSchoolWebsite(live.body.data,slugA);
 assert.equal(site.version,1);assert.equal(site.schoolName,'Synthetic alpha Dojo');assert.equal(site.document.pages[0].sections[0].props.heading,'Alpha Martial Arts');
 assert.deepEqual(Object.keys(live.body.data).sort(),['document','publicSlug','schoolName','version']);
 assert(!JSON.stringify(live.body).includes(a.org)&&!JSON.stringify(live.body).includes(a.school));
 for(const path of ['public/sites/'+slugA+'?x=1','public/sites/'+slugA.toUpperCase(),'public/sites/no'])assert.equal((await send(path)).status,400,path);
 assert.equal((await send('public/sites/'+slugA,{method:'POST',command:'website.read',body:{}})).status,400);
 refused(await pub('nobody-'+K().slice(0,8)),404);
 pass('publish refuses non-live references; published snapshot is public with no tenant ids; strict public transport');

 // 6. Draft edits stay private until published; rollback republishes an old version as a new one.
 const s3=ok(await cmd(a,'save',{expectedRevision:4,name:'Alpha website',document:doc('Changed headline',{homeSections:[booking(typeA.public_id)]})}));
 assert.equal(verifyPublishedSchoolWebsite((await pub(slugA)).body.data,slugA).document.pages[0].sections[0].props.heading,'Alpha Martial Arts');
 const p2=ok(await cmd(a,'publish',{expectedRevision:s3.data.draftRevision,note:'New headline'}));assert.equal(p2.data.publishedVersion,2);
 assert.equal(verifyPublishedSchoolWebsite((await pub(slugA)).body.data,slugA).document.pages[0].sections[0].props.heading,'Changed headline');
 refused(await cmd(a,'rollback',{expectedRevision:p2.data.draftRevision,version:9,note:''}),404,'SCHOOL_WEBSITE_NOT_FOUND');
 const r1=ok(await cmd(a,'rollback',{expectedRevision:p2.data.draftRevision,version:1,note:'Back to first'}));
 assert.equal(r1.data.publishedVersion,3);assert.equal(r1.data.versions[0].source,'ROLLBACK');assert.equal(r1.data.versions[0].rolledBackFrom,1);
 assert.equal(r1.data.draft.pages[0].sections[0].props.heading,'Alpha Martial Arts');
 const after=verifyPublishedSchoolWebsite((await pub(slugA)).body.data,slugA);assert.equal(after.version,3);assert.equal(after.document.pages[0].sections[0].props.heading,'Alpha Martial Arts');
 assert.deepEqual(r1.data.versions.map(v=>v.version),[3,2,1]);
 pass('draft edits stay private; publish makes version 2; rollback publishes version 1 again as version 3 and restores the draft');

 // 7. A booking type that stops being live is emptied in the public copy (never offered to a visitor), not removed from history.
 await q("UPDATE hon.school_booking_types SET status='ARCHIVED',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[typeA.id]);
 const emptied=verifyPublishedSchoolWebsite((await pub(slugA)).body.data,slugA);
 assert.equal(emptied.document.pages[0].sections.find(s=>s.type==='BOOKING').props.bookingPublicId,'');
 assert.equal((await q('SELECT document FROM hon.school_website_versions WHERE website_id=$1 AND version=3',[created.data.id]))[0].document.pages[0].sections.find(s=>s.type==='BOOKING').props.bookingPublicId,typeA.public_id);
 refused(await cmd(a,'publish',{expectedRevision:r1.data.draftRevision,note:''}),409,'SCHOOL_WEBSITE_REFERENCE_NOT_LIVE');
 pass('a booking page that is no longer live is emptied in the public copy; republishing it is refused; history unchanged');

 // 7b. A form is offered to visitors exactly when the public form intake (0075) would serve it. The 0073/0075 guard
 // triggers only allow those records through their own human command paths, so this fixture disables them inside one
 // transaction on the owner connection and rolls everything back.
 await q('BEGIN');
 try{
  for(const t of ['crm_pipelines','crm_pipeline_stages','marketing_campaigns','public_lead_forms'])await q(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const pl=(await q("INSERT INTO hon.crm_pipelines(organization_id,school_id,name) VALUES($1,$2,'Synthetic pipeline') RETURNING id",[a.org,a.school]))[0].id;
  const open=(await q("INSERT INTO hon.crm_pipeline_stages(organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,'New',1) RETURNING id",[a.org,a.school,pl]))[0].id;
  const won=(await q("INSERT INTO hon.crm_pipeline_stages(organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,'Won',2,'WON') RETURNING id",[a.org,a.school,pl]))[0].id;
  const camp=(await q("INSERT INTO hon.marketing_campaigns(organization_id,school_id,version,code,name,goal,offer_label,channel,status,starts_at,ends_at,planned_budget_minor,currency) VALUES($1,$2,1,'SYN-WEB','Synthetic','Leads','Free class','WEBSITE','ACTIVE',date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()+interval '30 days'),0,'USD') RETURNING id",[a.org,a.school]))[0].id;
  const form=(await q("INSERT INTO hon.public_lead_forms(organization_id,school_id,status,title,description,optional_fields,pipeline_id,pipeline_stage_id,campaign_id) VALUES($1,$2,'PUBLISHED','Ask us','','[]',$3,$4,$5) RETURNING id,public_id",[a.org,a.school,pl,open,camp]))[0];
  const withForm=doc('Form check',{homeSections:[{id:'ask',type:'LEAD_FORM',props:{heading:'Ask us',body:'',publicFormId:form.public_id}}]});
  const state=async()=>{const r=(await q('SELECT hon.school_website_form_live($1,$2,$3) live,hon.school_website_refs_ok($1,$2,$4::jsonb,true) publishable,hon.school_website_refs_ok($1,$2,$4::jsonb,false) saveable,hon.school_website_public_document($1,$2,$4::jsonb) pub',[a.org,a.school,form.public_id,withForm]))[0];
   return {live:r.live,publishable:r.publishable,saveable:r.saveable,shown:r.pub.pages[0].sections.find(x=>x.id==='ask').props.publicFormId};};
  const served=async()=>(await q('SELECT hon.read_published_form($1) f',[form.public_id]))[0].f!==null;
  assert.deepEqual(await state(),{live:true,publishable:true,saveable:true,shown:form.public_id});assert.equal(await served(),true);
  await q("UPDATE hon.marketing_campaigns SET status='PAUSED' WHERE id=$1",[camp]);
  assert.deepEqual(await state(),{live:false,publishable:false,saveable:true,shown:''});assert.equal(await served(),false);
  await q("UPDATE hon.marketing_campaigns SET status='ACTIVE' WHERE id=$1",[camp]);await q('UPDATE hon.public_lead_forms SET pipeline_stage_id=$2 WHERE id=$1',[form.id,won]);
  assert.deepEqual(await state(),{live:false,publishable:false,saveable:true,shown:''});assert.equal(await served(),false);
  await q('UPDATE hon.public_lead_forms SET pipeline_stage_id=$2,campaign_id=NULL WHERE id=$1',[form.id,open]);
  assert.deepEqual(await state(),{live:true,publishable:true,saveable:true,shown:form.public_id});
  await q("UPDATE hon.public_lead_forms SET status='DISABLED' WHERE id=$1",[form.id]);
  assert.deepEqual(await state(),{live:false,publishable:false,saveable:true,shown:''});
 }finally{await q('ROLLBACK');}
 pass('a lead form is shown and publishable exactly when the public form intake serves it (paused campaign, closed stage or disabled form hide it)');

 // 8. Isolation and authority: other schools, suspended subscriptions, missing permission, no HQ or family authority.
 assert.equal((await read(b)).website,null);
 refused(await send(base({...b,org:a.org,school:a.school}),{identity:b}),403);
 refused(await cmd({...b,org:a.org,school:a.school},'save',{expectedRevision:r1.data.draftRevision,name:'Hijack',document:doc('Hijack')}),403);
 await setAccess(a,'SUSPENDED');
 refused(await send(base(a),{identity:a}),403);refused(await pub(slugA),404);
 await setAccess(a,'ACTIVE');
 assert.equal((await pub(slugA)).status,200);
 const role=(await q("SELECT r.id FROM hon.roles r WHERE r.organization_id=$1 AND r.code='OWNER'",[a.org]))[0].id;
 await q("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='website.publish'",[role]);
 refused(await cmd(a,'unpublish',{expectedRevision:r1.data.draftRevision}),403);
 ok(await cmd(a,'save',{expectedRevision:r1.data.draftRevision,name:'Alpha website',document:doc('Edit still allowed')}));
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'website.publish')",[role,a.org]);
 for(const h of [{'x-hon-source':'AI_AGENT'},{'x-hon-delegated-by-principal-id':K()},{'sec-fetch-site':'cross-site'}])refused(await send(base(a),{identity:a,headers:h}),403);
 pass('exact-school isolation; suspended subscription hides the site and refuses staff; publish needs website.publish; no delegated or cross-site calls');

 // 9. Unpublish takes the site offline; evidence is immutable; audit and inert outbox only; no lead or message.
 const cur=(await read(a)).website;
 const u1=ok(await cmd(a,'unpublish',{expectedRevision:cur.draftRevision}));assert.equal(u1.data.status,'UNPUBLISHED');assert.equal(u1.data.publishedVersion,null);
 refused(await pub(slugA),404);
 refused(await cmd(a,'unpublish',{expectedRevision:u1.data.draftRevision}),409,'SCHOOL_WEBSITE_NOT_PUBLISHED');
 for(const sql of ["UPDATE hon.school_website_versions SET note='x' WHERE website_id=$1","DELETE FROM hon.school_website_versions WHERE website_id=$1",
  "DELETE FROM hon.school_websites WHERE id=$1","UPDATE hon.school_websites SET public_slug='stolen-name',draft_revision=draft_revision+1 WHERE id=$1",
  "UPDATE hon.school_websites SET name='skip',draft_revision=draft_revision+2 WHERE id=$1",
  "UPDATE hon.school_websites SET draft_document='{}'::jsonb,draft_revision=draft_revision+1 WHERE id=$1"]){
  await assert.rejects(q(sql,[created.data.id]),/SCHOOL_WEBSITE_IMMUTABLE|violates check constraint/,sql);
 }
 const audits=await q("SELECT action_code,next_state FROM hon.audit_events WHERE entity_type='SCHOOL_WEBSITE' AND entity_id=$1 ORDER BY occurred_at,id",[created.data.id]).catch(()=>q("SELECT action_code,next_state FROM hon.audit_events WHERE entity_type='SCHOOL_WEBSITE' AND entity_id=$1",[created.data.id]));
 assert.deepEqual([...new Set(audits.map(r=>r.action_code))].sort(),['website.create','website.publish','website.rollback','website.save','website.unpublish']);
 const events=await q("SELECT event_type,payload FROM hon.outbox_events WHERE aggregate_type='SCHOOL_WEBSITE' AND aggregate_id=$1",[created.data.id]);
 assert(events.length>=8&&events.every(e=>e.payload.internalOnly===true&&!JSON.stringify(e.payload).includes('pages')));
 assert.equal((await q('SELECT count(*) n FROM hon.crm_leads'))[0].n,leadsBefore);
 assert.equal((await q("SELECT count(*) n FROM hon.school_website_requests WHERE response IS NULL"))[0].n,'0');
 pass('unpublish takes the site offline; versions and identity immutable; identifier-only audit and inert outbox; no lead created');

 assert.equal(groups,10);
 console.log(`PASS: ${groups}/10 school website groups`);
}finally{
 // The shared fixture's sign-up program goes back to CLOSED for the proofs that follow (0241 expects it).
 await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});
 await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);
}
