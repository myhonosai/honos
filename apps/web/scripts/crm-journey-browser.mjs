/** Mounted Next/React and signed HON sessions with synthetic API fixtures. Not real database authority proof. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {issueSession,verifySession,cookieValue,HON_SESSION_COOKIE} from '@hon/auth';
assert(process.env.GITHUB_ACTIONS==='true'||process.env.HON_CRM_JOURNEY_BROWSER_LOCAL==='1');
for(const k of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL','ZERNIO_API_KEY','STRIPE_SECRET_KEY','OPENAI_API_KEY'])assert(!process.env[k]);
const root=resolve('.'),req=createRequire(join(root,'package.json')),tools=createRequire(join(process.env.HON_CRM_JOURNEY_TOOLS,'runner.cjs'));
const {chromium}=tools('playwright-core'),{transform}=tools('esbuild');
const compiled=await transform(await readFile(join(root,'src/components/crm-journey/catalog.ts'),'utf8'),{loader:'ts',format:'esm'});
const {journeyText:t}=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
const axe=await readFile(tools.resolve('axe-core/axe.min.js'),'utf8'),results=process.env.HON_CRM_JOURNEY_RESULTS;await mkdir(results,{recursive:true});
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),schoolId:id(2)},session={mode:'OIDC',audience:'crm-journey-synthetic-browser',secret:randomBytes(32).toString('hex')};
const lead=()=>({id:id(3),primaryPersonId:id(4),pipelineStageId:id(5),version:state.closed?2:1,status:state.closed?'WON':'OPEN',givenName:'Synthetic',familyName:'Rivera',email:'synthetic@example.test',createdAt:'2026-10-30T12:00:00.000Z'});
const report={sourceSha:process.env.HON_CRM_JOURNEY_SHA,syntheticBrowserOnly:true,realApiDatabaseVerification:false,blockedExternalRequests:0,blockedOrigins:[],externalProviderExecutions:0,screenshots:[],accessibility:[],checks:[]};
const state={language:'en',reads:0,commands:0,closed:false,registered:false,deny:false,hold:false,settle:null,keys:new Map()};
const api=createServer(async(r,s)=>{
 const send=(status,data,meta=true)=>{if(s.destroyed)return;s.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});s.end(JSON.stringify(status>=400?{code:'SYNTHETIC_DENIED'}:{data,...(meta?{meta:{requestId:id(9),correlationId:id(9),replayed:false}}:{})}));};
 try{verifySession(cookieValue(r.headers.cookie,HON_SESSION_COOKIE)??'',session);}catch{send(401);return;}
 if(r.url==='/v1/me/language-preference'){assert.equal(r.method,'GET');send(200,{preference:{language:state.language,version:1,updatedAt:'2026-10-30T12:00:00.000Z'},schoolDefault:null,effective:{language:state.language,source:'PERSONAL'},supportedLanguages:['en','ko','es']},false);return;}
 if(r.url==='/v1/staff/current-reporting-school'){send(200,{state:'RESOLVED',...scope},false);return;}
 state.reads+=r.method==='GET'?1:0;
 if(state.deny){send(403);return;}
 if(r.method==='GET'&&r.url===`/v1/organizations/${id(1)}/schools/${id(2)}/crm/leads?limit=50`){send(200,[lead()]);return;}
 if(r.method==='GET'&&r.url==='/v1/staff/crm/follow-ups?queue=mine&status=ALL'){send(200,{schoolId:id(2),principalId:id(6),canManage:false,humanOnly:true,queue:'mine',status:'ALL',items:[],nextAfter:null});return;}
 let raw='';for await(const c of r)raw+=c;const body=raw?JSON.parse(raw):null;
 if(r.url?.endsWith('/guardian-child-enrollment')){assert.equal(raw,'{}');assert.equal(r.headers['idempotency-key'],undefined);send(200,{leadId:id(3),workflowState:state.registered?'ADULT_REGISTRATION':'NOT_REGISTERED'});return;}
 if(r.method!=='POST'){send(404);return;}
 const key=r.headers['idempotency-key'];assert(key);const fingerprint=JSON.stringify({path:r.url,body});
 if(state.keys.has(key)){const saved=state.keys.get(key);assert.equal(saved.fingerprint,fingerprint);send(200,saved.data);return;}
 state.commands++;
 const now=new Date().toISOString();let data;
 if(r.url==='/v1/staff/crm/follow-ups')data={...body,followUpId:id(10),schoolId:id(2),version:1,status:'OPEN',recordedAt:now,completedAt:null,cancelledAt:null,humanOnly:true};
 else if(r.url?.endsWith('/trials'))data={id:id(8),crmLeadId:id(3),appointmentType:'TRIAL',status:'SCHEDULED',startsAt:body.startsAt,endsAt:body.endsAt,createdByPrincipalId:id(6),version:1,createdAt:now,updatedAt:now,...(body.location?{location:body.location}:{}),...(body.notes?{notes:body.notes}:{})};
 else if(r.url?.endsWith('/outcome')){const a=[...state.keys.values()].find(x=>x.data.appointmentType==='TRIAL')?.data;assert(a);data={...a,status:body.status,version:2,updatedAt:now};}
 else if(r.url?.endsWith('/close')){state.closed=true;data={...scope,leadId:id(3),status:body.status,priorVersion:body.expectedVersion,version:body.expectedVersion+1,closedAt:now,closeNote:body.closeNote??null,crmOnly:true};}
 else if(r.url?.endsWith('/register')){state.registered=true;data={outcome:'REGISTERED',leadId:id(3),sourceContactPersonId:id(4),registrationPath:body.registrationPath,studentProfileId:id(11),familyId:body.registrationPath==='ADULT'?null:id(12),recordedAt:now};}
 else{state.commands--;send(404);return;}
 if(r.url==='/v1/staff/crm/follow-ups')delete data.expectedVersion;
 state.keys.set(key,{fingerprint,data});
 if(state.hold){state.settle=()=>send(503);return;}send(200,data);
});
const origin='http://127.0.0.1:3100';let app,browser,log='';
async function open(lang,width){state.language=lang;const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();report.blockedExternalRequests++;const host=new URL(route.request().url()).origin;if(!report.blockedOrigins.includes(host))report.blockedOrigins.push(host);return route.abort();});
 await context.addCookies([{name:HON_SESSION_COOKIE,value:issueSession({externalSubject:'oidc:synthetic:journey'},session),url:origin,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();await page.goto(origin+`/staff/crm/journey?${new URLSearchParams({...scope,leadId:id(3)})}`);await page.waitForFunction(lang=>document.documentElement.lang===lang,lang);return{context,page};
}
const test=(p,n)=>p.getByTestId(n);
async function load(p){await test(p,'load').click();await p.getByText('Synthetic Rivera',{exact:true}).waitFor();}
async function refresh(p){await test(p,'refresh').click();await test(p,'refresh').waitFor({state:'visible'});await p.waitForFunction(()=>!document.querySelector('[data-testid=refresh]').disabled);}
async function confirm(p,button){const count=await p.getByTestId('receipt').count();await test(p,'confirm').check();await test(p,button).click();await p.waitForFunction(n=>document.querySelectorAll('[data-testid=receipt]').length===n+1,count);await p.waitForFunction(()=>!document.querySelector('[data-testid=refresh]').disabled);}
async function capture(p,name){await p.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();window.scrollTo(0,0);});assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow');await p.addScriptTag({content:axe});const scan=await p.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));report.accessibility.push({name,violations:scan.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))});await p.screenshot({path:join(results,name+'.png'),fullPage:true});report.screenshots.push(name+'.png');assert.equal(scan.violations.length,0,JSON.stringify(report.accessibility.at(-1)));}
try{
 await new Promise((done,reject)=>{api.once('error',reject);api.listen(3001,'127.0.0.1',done);});
 app=spawn(process.execPath,[req.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3100'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'production',HON_DEPLOYMENT_ENVIRONMENT:'preview',NEXT_TELEMETRY_DISABLED:'1',HON_AUTH_MODE:'OIDC',HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret},stdio:['ignore','pipe','pipe']});app.stdout.on('data',b=>log=(log+b).slice(-10000));app.stderr.on('data',b=>log=(log+b).slice(-10000));
 let ready=false;for(let i=0;i<100;i++){try{await fetch(origin,{redirect:'manual'});ready=true;break;}catch{}await new Promise(r=>setTimeout(r,200));}assert(ready,'Application did not start');
 browser=await chromium.launch({executablePath:process.env.HON_CRM_JOURNEY_CHROME,headless:true,args:['--no-sandbox']});
 for(const lang of ['en','ko','es'])for(const width of [390,834,1440]){
  state.closed=false;state.registered=false;state.keys.clear();const{context,page}=await open(lang,width);const before=state.reads;await page.waitForTimeout(100);assert.equal(state.reads,before);
  await test(page,'load').focus();assert(await test(page,'load').evaluate(e=>e===document.activeElement));await load(page);assert.equal(state.reads,before+1);
  for(const mode of ['modern','classic','big'])await test(page,'mode').selectOption(mode);assert.equal(state.reads,before+1);await test(page,'mode').selectOption(width===390?'big':width===834?'classic':'modern');
  await test(page,'step-follow').click();await test(page,'verify-follow').click();await test(page,'subject').waitFor();await test(page,'subject').fill('Synthetic internal follow-up');await test(page,'note').fill('Synthetic private planning. No contact sent.');await confirm(page,'save-follow');await refresh(page);
  await test(page,'step-trial').click();const starts=new Date(Date.now()+86400000).toISOString().slice(0,16),ends=new Date(Date.now()+90000000).toISOString().slice(0,16);await test(page,'start').fill(starts);await test(page,'end').fill(ends);await confirm(page,'save-trial');await refresh(page);
  await test(page,'step-outcome').click();await test(page,'outcome').selectOption('COMPLETED');await confirm(page,'save-outcome');await refresh(page);
  await test(page,'step-close').click();await confirm(page,'save-close');await refresh(page);
  await test(page,'step-register').click();await test(page,'verify-registration').click();await test(page,'registration-path').waitFor();
  if(width===390){await test(page,'registration-path').selectOption('GUARDIAN_CHILD');await test(page,'child-given').fill('Synthetic child');await test(page,'child-family').fill('Rivera');await test(page,'birth').fill('2018-01-02');}else await test(page,'birth').fill('1990-01-02');
  await confirm(page,'save-registration');await test(page,'step-history').click();assert.equal(state.commands>=5,true);
  await capture(page,`${lang}-${width}-connected-journey`);
  const reads=state.reads;await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await page.getByText('Synthetic Rivera',{exact:true}).isVisible(),false);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(state.reads,reads);await test(page,'restore').click();await page.getByText('Synthetic Rivera',{exact:true}).waitFor();assert.equal(await test(page,'receipt').count(),0);
  report.checks.push(`${lang}/${width}: five real-contract fixture commands, explicit refresh, adult/family registration, three modes, keyboard, privacy, no automatic read/retry`);await context.close();
 }
 // Unknown close behind a shield: server fixture commits, returns503; exact retry returns original evidence.
 state.closed=false;state.registered=false;state.keys.clear();let{context,page}=await open('en',390);await load(page);await test(page,'step-close').click();await test(page,'confirm').check();state.hold=true;const n=state.commands;await test(page,'save-close').dblclick();for(let i=0;!state.settle&&i<100;i++)await page.waitForTimeout(20);assert(state.settle);assert.equal(state.commands,n+1);
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert(await test(page,'restore').isDisabled());assert(await test(page,'shield-discard').isDisabled());state.hold=false;state.settle();state.settle=null;await page.waitForFunction(()=>!document.querySelector('[data-testid=restore]').disabled);
 await test(page,'restore').click();await test(page,'retry').waitFor();const savedKey=[...state.keys.keys()][0];await test(page,'retry').dblclick();await test(page,'receipt').waitFor();assert.equal(state.commands,n+1);assert.deepEqual([...state.keys.keys()],[savedKey]);report.checks.push('unknown close settles behind shield, busy clears, exact-key explicit retry without page reload or duplicate effect');
 await test(page,'refresh').click();state.deny=true;await test(page,'refresh').click();await page.getByText(t('en','denied'),{exact:true}).waitFor();assert.equal(await page.getByText('Synthetic Rivera',{exact:true}).count(),0);state.deny=false;report.checks.push('live fixture permission denial clears facts');await context.close();
 ({context,page}=await open('ko',834));await load(page);await page.evaluate(()=>window.dispatchEvent(new Event('hon:session-invalidated')));assert.equal(await page.getByText('Synthetic Rivera',{exact:true}).count(),0);await page.getByText(t('ko','reauth'),{exact:true}).first().waitFor();report.checks.push('shared session invalidation clears mounted Korean view');await context.close();
 console.log(`PASS connected CRM browser: ${report.checks.length} groups, ${report.accessibility.length} zero-violation axe scans, ${report.screenshots.length} screenshots; synthetic API only`);
}catch(e){report.failure={name:e.name,message:e.message};if(browser){for(const context of browser.contexts())for(const p of context.pages())await p.screenshot({path:join(results,'failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;console.error(e);}
finally{await writeFile(join(results,'crm-journey-browser-report.json'),JSON.stringify(report,null,2));await writeFile(join(results,'next.log'),log);await browser?.close();app?.kill('SIGTERM');await new Promise(r=>api.close(r));}
