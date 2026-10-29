/** Mounted production Next/React with synthetic signed sessions/API fixtures; not API-to-database evidence. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {issueSession,verifySession,cookieValue,HON_SESSION_COOKIE} from '@hon/auth';
import {HQ_OVERVIEW_UNAVAILABLE_REASONS,validateOwnerInvitationInput} from '@hon/contracts';
assert(process.env.GITHUB_ACTIONS==='true'||process.env.HON_P0_BROWSER_LOCAL==='1');
for(const k of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL','ZERNIO_API_KEY','STRIPE_SECRET_KEY','OPENAI_API_KEY'])assert(!process.env[k]);
const root=resolve('.'),req=createRequire(join(root,'package.json')),tools=createRequire(join(process.env.HON_HQ_BROWSER_TOOLS,'runner.cjs'));
const {chromium}=tools('playwright-core'),axe=await readFile(tools.resolve('axe-core/axe.min.js'),'utf8'),results=process.env.HON_HQ_BROWSER_RESULTS;
await mkdir(results,{recursive:true});
const report={sourceSha:process.env.HON_HQ_SOURCE_SHA,syntheticBrowserOnly:true,realProviderCalls:0,checks:[],screenshots:[],accessibility:[]};
const session={mode:'OIDC',audience:'p0-browser',secret:randomBytes(32).toString('hex')},ids={invitationId:randomUUID(),organizationId:randomUUID(),schoolId:randomUUID()};
const account={...ids,accountStatus:'OWNER_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false};
const inv={...ids,email:'synthetic-owner@example.invalid',expiresAt:'2026-11-01T12:00:00.000Z',status:'PENDING'};
const directory={schools:[{schoolId:ids.schoolId,organizationDisplayName:'Synthetic Approved Organization',schoolDisplayName:'Synthetic Approved School',organizationOperationalStatus:'ACTIVE',schoolOperationalStatus:'ACTIVE',entitlementTier:null,createdAt:'2026-10-28T12:00:00.000Z'}]};
const state={posts:[],hold:false,settle:null,status:200,reads:0};
const overview={asOf:'2026-10-28T12:00:00.000Z',callerHqRole:'OWNER',organizationCount:0,schoolCount:0,onboarding:{availability:'AVAILABLE',requestCount:0,inProgressRequestCount:0,completedRequestCount:0},configuredProviderStates:{disabled:0,configured:0,healthy:0,degraded:0,unavailable:0},taskProfileCount:0,financialMetrics:{availability:'UNAVAILABLE',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics},aiUsage:{availability:'UNAVAILABLE',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage},durableHqWork:{availability:'UNAVAILABLE',state:'NO_RECORDED_WORK',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork}};
const api=createServer(async(r,s)=>{
 const send=(status,data)=>{s.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});s.end(JSON.stringify(status===200?{data}:{code:'SYNTHETIC_DENIED'}));};
 try{verifySession(cookieValue(r.headers.cookie,HON_SESSION_COOKIE)??'',session);}catch{send(401);return;}
 if(r.url==='/v1/hq/session'){send(state.status,{principalId:ids.invitationId,hqRole:'HON_HQ_OWNER'});return;}
 if(r.url==='/v1/hq/overview'){send(200,{overview});return;}
 if(r.url==='/v1/me/language-preference'){send(200,{preference:{language:'en',version:1,updatedAt:'2026-10-28T00:00:00.000Z'},schoolDefault:null,effective:{language:'en',source:'PERSONAL'},supportedLanguages:['en','ko','es']});return;}
 if(r.url==='/v1/hq/schools'){++state.reads;send(state.status,{directory});return;}
 if(r.method==='GET'&&r.url.endsWith('/owner-invitations')){++state.reads;send(state.status,[inv]);return;}
 if(r.method==='POST'){
  let body='';for await(const c of r)body+=c;
  state.posts.push({path:r.url,body,key:r.headers['idempotency-key']});
  if(r.url==='/v1/hq/school-owner-invitations'){
   try{const input=validateOwnerInvitationInput(JSON.parse(body));assert.equal(input.schoolId,ids.schoolId);assert(!Object.hasOwn(input,'organizationId'));}
   catch{send(400);return;}
  }
  const result=r.url.endsWith('/accept')?account:inv;
  if(state.hold){state.settle=()=>send(state.status,result);return;}send(state.status,result);return;
 }
 send(404);
});
let app,browser;const origin='http://127.0.0.1:3100';
async function open(hq,size){const context=await browser.newContext({viewport:size,reducedMotion:'reduce',serviceWorkers:'block'});await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await context.addCookies([{name:HON_SESSION_COOKIE,value:issueSession({externalSubject:'oidc:p0-browser:owner',email:'synthetic-owner@example.invalid',emailVerified:true},session),url:origin,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();await page.goto(origin+(hq?'/hq/school-owner-invitations':'/account/owner-invitation'));await page.getByRole('button',{name:'Verify access',exact:true}).click();await page.getByText('Access verified.',{exact:false}).waitFor();return {context,page};}
async function capture(page,name){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.addScriptTag({content:axe});const a=await page.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));report.accessibility.push({name,violations:a.violations.map(v=>({id:v.id,impact:v.impact}))});assert.equal(a.violations.length,0,JSON.stringify(a.violations.map(v=>v.id)));await page.screenshot({path:join(results,name+'.png'),fullPage:true});report.screenshots.push(name+'.png');}
try{
 await new Promise(done=>api.listen(3001,'127.0.0.1',done));
 app=spawn(process.execPath,[req.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3100'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',HON_AUTH_MODE:'OIDC',HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret},stdio:'ignore'});
 let ready=false;for(let n=0;n<80;n++){try{await fetch(origin);ready=true;break;}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready);
 browser=await chromium.launch({executablePath:process.env.HON_HQ_CHROME_BIN,headless:true,args:['--no-sandbox']});
 for(const [size,viewport]of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  let {page,context}=await open(true,viewport);
  await page.getByRole('button',{name:'Load approved schools'}).click();await page.getByLabel('Approved school').selectOption(ids.schoolId);await page.getByLabel('Owner email',{exact:true}).fill(inv.email);await page.getByRole('button',{name:'Generate private token'}).click();
  const beforeInvite=state.posts.length;page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Record owner invitation'}).click();await page.getByText('Invitation recorded.',{exact:false}).waitFor();assert.equal(state.posts.length,beforeInvite+1);assert.deepEqual(Object.keys(JSON.parse(state.posts[beforeInvite].body)).sort(),['email','schoolId','token','ttlHours']);await capture(page,size+'-hq-owner-invitation');await context.close();
  ({page,context}=await open(false,viewport));await page.getByLabel('Invitation ID',{exact:true}).fill(ids.invitationId);await page.getByLabel('Private invitation token',{exact:true}).fill('A'.repeat(43));await page.getByRole('checkbox').check();
  state.hold=true;const before=state.posts.length;await page.getByRole('button',{name:'Accept invitation',exact:true}).click();await page.waitForTimeout(100);assert.equal(state.posts.length,before+1);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByText('Private account information is concealed.',{exact:false}).waitFor();assert(await page.getByRole('button',{name:'Verify access',exact:true}).isDisabled());assert.equal(await page.getByRole('textbox').count(),0);
  state.settle();state.hold=false;await page.getByRole('button',{name:'Verify access',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Verify access').disabled);
  const url=page.url();await page.getByRole('button',{name:'Verify access',exact:true}).click();await page.getByRole('button',{name:'Retry exact request'}).click();await page.getByText('School-owner account bound.',{exact:false}).waitFor();assert.equal(page.url(),url);assert.equal(state.posts[before].body,state.posts[before+1].body);assert.equal(state.posts[before].key,state.posts[before+1].key);
  await page.getByRole('link',{name:'Open staff workspace'}).focus();assert(await page.getByRole('link',{name:'Open staff workspace'}).evaluate(e=>e===document.activeElement));await capture(page,size+'-owner-account-receipt');
  await page.evaluate(()=>window.dispatchEvent(new Event('hon:session-invalidated')));assert.equal(await page.getByText('School-owner account bound.',{exact:false}).count(),0);report.checks.push(size+': HQ explicit invitation, owner acceptance, privacy while pending, no reload recovery, exact-key retry, keyboard and axe');await context.close();
 }
 console.log('PASS mounted P0-1 browser: '+report.checks.length+' desktop/mobile scenario groups, '+report.accessibility.length+' axe scans');
}finally{await browser?.close();app?.kill('SIGTERM');await new Promise(done=>api.close(done));await writeFile(join(results,'browser-report.json'),JSON.stringify(report,null,2)+'\n');}
