/** Mounted production UI with synthetic localhost responses. Not API/database or provider evidence. */
import assert from 'node:assert/strict';
import { ATTENDANCE_CATEGORIES, ATTENDANCE_STATUSES, CLASS_BOOKING_KINDS } from '@hon/contracts';
import { loadMembershipBrowserCopy } from './school-membership-journey-browser.mjs';
export function createStudentOperationsFixture({id,scope,rejected}) {
 const root=`/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/schedule/sessions`,stamp='2026-11-03T12:00:00.000Z';
 const sessions=[{sessionId:id(601),name:'Synthetic Junior Class',startsAt:stamp,endsAt:'2026-11-03T13:00:00.000Z',roomName:'North Hall',capacity:20,bookingPolicy:'OPTIONAL_BOOKING',status:'SCHEDULED',createdAt:stamp},{sessionId:id(602),name:'Synthetic Cancelled Class',startsAt:'2026-11-04T12:00:00.000Z',endsAt:'2026-11-04T13:00:00.000Z',roomName:null,capacity:15,bookingPolicy:'REQUIRED_BOOKING',status:'CANCELLED',createdAt:stamp}];
 let mode='disabled',commands=[],reads=[],keys=new Map(),bookings=new Map(),attendance=new Map(),release=null,held,signalHeld,conflictAttendance=false;
 const reset=(m='ready')=>{mode=m;commands=[];reads=[];keys=new Map();bookings=new Map();attendance=new Map();release=null;conflictAttendance=false;held=new Promise(r=>signalHeld=r);};
 const send=(res,status,data,mutation=false,replayed=false)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify({data,meta:{requestId:id(8),correlationId:id(8),...(mutation?{replayed}:{})}}));};
 async function handle(req,res,url){
  if(mode==='disabled'||!url.pathname.startsWith(root))return false;
  if(mode==='denied'){rejected(res,403,'FORBIDDEN');return true;}
  if(url.pathname===root){assert.equal(req.method,'GET');assert.equal(url.search,'');reads.push(url.pathname);send(res,200,sessions);return true;}
  const match=url.pathname.match(new RegExp('^'+root+'/([a-f0-9-]+)/(bookings|attendance)$'));if(!match)return false;
  assert(sessions.some(s=>s.sessionId===match[1]));const session=sessions.find(s=>s.sessionId===match[1]);
  if(req.method==='GET'){assert.equal(match[2],'attendance');const student=url.searchParams.get('studentProfileId');assert([id(190),id(170),id(171)].includes(student));reads.push(url.pathname+url.search);send(res,200,attendance.get(student+match[1])??null);return true;}
  assert.equal(req.method,'POST');let raw='';for await(const part of req){raw+=part;assert(raw.length<4000);}const input=JSON.parse(raw),key=req.headers['idempotency-key'];assert(key);assert([id(190),id(170),id(171)].includes(input.studentProfileId));commands.push({path:url.pathname,key,body:raw});
  if(keys.has(key)){const prior=keys.get(key);assert.equal(prior.raw,raw);assert.equal(prior.path,url.pathname);send(res,200,prior.data,true,true);return true;}
  if(session.status==='CANCELLED'){rejected(res,409,'SESSION_CANCELLED');return true;}
  const pair=input.studentProfileId+match[1];let data;
  if(match[2]==='bookings'){
   assert.deepEqual(Object.keys(input).sort(),['bookingKind','studentProfileId']);assert(CLASS_BOOKING_KINDS.includes(input.bookingKind));
   if(bookings.has(pair)){data=bookings.get(pair);if(data.bookingKind!==input.bookingKind){rejected(res,409,'BOOKING_KIND_CONFLICT');return true;}}
   else{data={id:id(610+bookings.size),classSessionId:match[1],studentProfileId:input.studentProfileId,bookingKind:input.bookingKind,status:'BOOKED',source:'STAFF',bookedAt:stamp,version:1,createdAt:stamp,updatedAt:stamp,sessionCapacity:20,bookingPolicy:'OPTIONAL_BOOKING',activeSeatCount:1};bookings.set(pair,data);}
  }else{
   if(conflictAttendance){conflictAttendance=false;rejected(res,409,'VERSION_CONFLICT');return true;}
   assert(ATTENDANCE_STATUSES.includes(input.status));assert(ATTENDANCE_CATEGORIES.includes(input.category));const current=attendance.get(pair);
   if(current&&input.expectedVersion!==current.version){rejected(res,409,'VERSION_CONFLICT');return true;}
   data={id:current?.id??id(650+attendance.size),classSessionId:match[1],studentProfileId:input.studentProfileId,status:input.status,category:input.category,progressionPolicyVersion:0,progressionEnabled:false,progressionWeightMilli:0,progressionCreditMilli:0,recordedAt:stamp,version:(current?.version??0)+1,createdAt:stamp,updatedAt:stamp,note:input.note};attendance.set(pair,data);
  }
  keys.set(key,{raw,path:url.pathname,data});
  if(mode==='held-unknown'){release=()=>{mode='ready';rejected(res,503,'UNKNOWN');};signalHeld();return true;}
  send(res,201,data,true);return true;
 }
 return{handle,reset,get commands(){return commands;},get reads(){return reads;},waitUntilHeld:()=>held,release(){assert(release);release();},deny(){mode='denied';},conflictNextAttendance(){conflictAttendance=true;}};
}
export async function runStudentOperationsBrowserChecks({fixture,recoveryFixture,open,visual,check,origin,scope,id,setLanguage,report}) {
 const{operationsText:t}=await loadMembershipBrowserCopy('connected-student-operations-copy');
 const{membershipRecoveryText:r}=await loadMembershipBrowserCopy('crm-lead-memberships-copy');
 const modes=[['modern',{width:1440,height:1000}],['classic',{width:834,height:1000}],['big',{width:390,height:844}]];
 async function start(page,language='en',mode='modern',child=1){await page.goto(`${origin}/staff/crm/lead-memberships?${new URLSearchParams({...scope,leadId:id(3)})}`);const root=page.locator('[data-membership-recovery]');await root.getByRole('heading',{name:r(language,'title'),exact:true}).waitFor();await root.getByRole('combobox').selectOption(mode);await root.getByRole('button',{name:r(language,'load'),exact:true}).click();await root.getByRole('button',{name:t(language,'title')+' · '+child,exact:true}).focus();await page.keyboard.press('Enter');const ops=page.locator('[data-student-operations]');await ops.getByRole('heading',{name:t(language,'title'),exact:true}).waitFor();return ops;}
 async function choose(ops,language){await ops.getByRole('button',{name:t(language,'load'),exact:true}).click();await ops.getByRole('button',{name:t(language,'choose')+' · Synthetic Junior Class',exact:true}).click();}
 // Test-only access to the mounted React handler reproduces a retained closure even after the DOM button changes.
 async function retainAttendanceSubmit(ops){await ops.getByRole('button',{name:t('en','save'),exact:true}).evaluate(button=>{const key=Object.keys(button).find(k=>k.startsWith('__reactProps$'));if(!key||typeof button[key].onClick!=='function')throw Error('Mounted React attendance handler unavailable');window.__honRetainedAttendanceSubmit=button[key].onClick;});}
 async function invokeRetained(page){await page.evaluate(()=>{window.__honRetainedAttendanceSubmit();window.__honRetainedAttendanceSubmit();});await page.waitForTimeout(250);}
 for(const language of ['en','ko','es'])for(const[mode,viewport]of modes)await check(`connected booking/attendance ${language}/${mode}: child, class, booking, attendance, private return`,async()=>{
  recoveryFixture.reset('family');fixture.reset();setLanguage(language);const{context,page}=await open(viewport);try{
   const ops=await start(page,language,mode,2);assert.equal(fixture.reads.length,0);assert.equal(fixture.commands.length,0);assert(!page.url().includes(id(171)));
   await ops.getByRole('combobox').first().selectOption(mode);assert.equal(fixture.reads.length,0);
   await ops.getByRole('button',{name:t(language,'load'),exact:true}).focus();await page.keyboard.press('Enter');await ops.getByRole('button',{name:t(language,'choose')+' · Synthetic Junior Class',exact:true}).waitFor();await visual(page,`connected-operations-${language}-${mode}-classes`);
   await ops.getByRole('button',{name:t(language,'choose')+' · Synthetic Junior Class',exact:true}).click();await ops.getByLabel(t(language,'kind'),{exact:true}).selectOption('REGULAR');await ops.getByLabel(t(language,'bookingConfirm'),{exact:true}).check();await ops.getByRole('button',{name:t(language,'book'),exact:true}).click();await ops.getByRole('heading',{name:t(language,'bookingReceipt'),exact:true}).waitFor();assert.equal(fixture.commands.length,1);assert.equal(JSON.parse(fixture.commands[0].body).studentProfileId,id(171));
   await ops.getByRole('button',{name:t(language,'readAttendance'),exact:true}).click();await ops.getByText(t(language,'noRecord'),{exact:true}).waitFor();assert.equal(fixture.commands.length,1);
   await ops.getByLabel(t(language,'attendanceConfirm'),{exact:true}).check();await ops.getByRole('button',{name:t(language,'save'),exact:true}).click();await ops.getByRole('status').filter({hasText:t(language,'saved')}).waitFor();assert.equal(fixture.commands.length,2);await visual(page,`connected-operations-${language}-${mode}-attendance`);assert.equal(report.accessibility.at(-1).violations.length,0);
   assert(await page.evaluate(s=>!JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(s),id(171)));await ops.getByRole('button',{name:t(language,'back'),exact:true}).click();await page.locator('[data-membership-recovery] h1').waitFor();assert.equal(await page.locator('[data-membership-recovery] ol li').count(),0);
  }finally{await context.close();}
 });
 for(const outcome of ['SUCCESS','CONFLICT'])await check(`connected attendance: mounted retained submit after ${outcome} is inert; fresh read and confirmation permits the next version`,async()=>{
  recoveryFixture.reset('adult');fixture.reset();setLanguage('en');const{context,page}=await open(modes[0][1]);try{
   const ops=await start(page);await choose(ops,'en');await ops.getByRole('button',{name:t('en','readAttendance'),exact:true}).click();await ops.getByLabel(t('en','attendanceConfirm'),{exact:true}).check();await ops.getByRole('button',{name:t('en','save'),exact:true}).click();await ops.getByRole('status').filter({hasText:t('en','saved')}).waitFor();assert.equal(fixture.commands.length,1);
   await ops.getByRole('button',{name:t('en','readAttendance'),exact:true}).click();await ops.getByLabel(t('en','attendanceConfirm'),{exact:true}).check();await retainAttendanceSubmit(ops);if(outcome==='CONFLICT')fixture.conflictNextAttendance();
   await ops.getByRole('button',{name:t('en','save'),exact:true}).click();await(outcome==='SUCCESS'?ops.getByRole('status').filter({hasText:t('en','saved')}):ops.getByRole('alert').filter({hasText:t('en','CONFLICT')})).waitFor();assert.equal(fixture.commands.length,2);assert.equal(JSON.parse(fixture.commands[1].body).expectedVersion,1);
   await invokeRetained(page);assert.equal(fixture.commands.length,2);assert(await ops.getByLabel(t('en','attendanceConfirm'),{exact:true}).isDisabled());
   await ops.getByRole('button',{name:t('en','readAttendance'),exact:true}).click();await ops.getByLabel(t('en','attendanceConfirm'),{exact:true}).check();await invokeRetained(page);assert.equal(fixture.commands.length,2);
   await ops.getByRole('button',{name:t('en','save'),exact:true}).click();await ops.getByRole('status').filter({hasText:t('en','saved')}).waitFor();assert.equal(fixture.commands.length,3);assert.equal(JSON.parse(fixture.commands[2].body).expectedVersion,outcome==='SUCCESS'?2:1);assert.notEqual(fixture.commands[1].key,fixture.commands[2].key);await visual(page,`connected-attendance-retained-${outcome.toLowerCase()}`);
  }finally{await context.close();}
 });
 await check('connected attendance: mounted unknown outcome retains exact retry across privacy restoration and retires the old submit',async()=>{
  recoveryFixture.reset('adult');fixture.reset('held-unknown');setLanguage('en');const{context,page}=await open(modes[2][1]);try{
   const ops=await start(page);await choose(ops,'en');await ops.getByRole('button',{name:t('en','readAttendance'),exact:true}).click();await ops.getByLabel(t('en','attendanceConfirm'),{exact:true}).check();await retainAttendanceSubmit(ops);await ops.getByRole('button',{name:t('en','save'),exact:true}).click();await fixture.waitUntilHeld();
   await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert(await ops.getByRole('button',{name:t('en','abandon'),exact:true}).isDisabled());fixture.release();await ops.getByRole('button',{name:t('en','verify'),exact:true}).waitFor();await ops.getByRole('button',{name:t('en','verify'),exact:true}).click();await ops.getByRole('button',{name:t('en','retry'),exact:true}).waitFor({state:'visible'});
   await invokeRetained(page);assert.equal(fixture.commands.length,1);await ops.getByRole('button',{name:t('en','retry'),exact:true}).click();await ops.getByRole('status').filter({hasText:t('en','saved')}).waitFor();assert.equal(fixture.commands.length,2);assert.deepEqual(fixture.commands[0],fixture.commands[1]);await invokeRetained(page);assert.equal(fixture.commands.length,2);await visual(page,'connected-attendance-mobile-unknown-exact-retry');
  }finally{await context.close();}
 });
 await check('connected booking: actual mounted blur while pending, unknown settlement, access restoration, exact-key retry without reload',async()=>{
  recoveryFixture.reset('adult');fixture.reset('held-unknown');setLanguage('en');const{context,page}=await open(modes[2][1]);try{const ops=await start(page);await choose(ops,'en');await ops.getByLabel(t('en','kind'),{exact:true}).selectOption('REGULAR');await ops.getByLabel(t('en','bookingConfirm'),{exact:true}).check();await ops.getByRole('button',{name:t('en','book'),exact:true}).click();await fixture.waitUntilHeld();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await ops.getByRole('heading',{name:t('en','hidden'),exact:true}).waitFor();assert(await ops.getByRole('button',{name:t('en','abandon'),exact:true}).isDisabled());fixture.release();await page.waitForFunction(()=>![...document.querySelectorAll('[data-student-operations] button')].find(b=>b.textContent==='Verify access and resume')?.disabled);await ops.getByRole('button',{name:t('en','verify'),exact:true}).click();await ops.getByRole('button',{name:t('en','retry'),exact:true}).waitFor({state:'visible'});assert.equal(fixture.commands.length,1);await ops.getByRole('button',{name:t('en','retry'),exact:true}).click();await ops.getByRole('heading',{name:t('en','bookingReceipt'),exact:true}).waitFor();assert.equal(fixture.commands.length,2);assert.deepEqual(fixture.commands[0],fixture.commands[1]);await visual(page,'connected-operations-mobile-exact-retry');}finally{await context.close();}
 });
 await check('connected booking: revoked permission stays concealed; school change cannot restore previous student',async()=>{recoveryFixture.reset('adult');fixture.reset();setLanguage('en');const{context,page}=await open(modes[2][1]);try{const ops=await start(page);await choose(ops,'en');await page.evaluate(()=>window.dispatchEvent(new Event('blur')));fixture.deny();await ops.getByRole('button',{name:t('en','verify'),exact:true}).click();await ops.getByRole('alert').filter({hasText:t('en','DENIED')}).waitFor();assert.equal(await ops.getByText(id(190),{exact:true}).count(),0);await page.evaluate(()=>window.dispatchEvent(new Event('hon:school-context-changed')));assert(await ops.getByRole('button',{name:t('en','verify'),exact:true}).isDisabled());assert.equal(fixture.commands.length,0);}finally{await context.close();}});
 fixture.reset('disabled');recoveryFixture.reset('disabled');setLanguage('en');
}
