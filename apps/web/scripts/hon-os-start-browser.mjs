/** Mounted production Next/React for /account/start with a signed synthetic session and a contract-checked API fixture.
 *  Not API-to-database evidence (the sign-up and trial database proofs cover that). No provider, payment or AI call. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {issueSession,verifySession,cookieValue,HON_SESSION_COOKIE} from '@hon/auth';
import {SIGNUP_HUMAN_COMMAND,TRIAL_HUMAN_COMMAND,validateSignupInput,validateTrialStartInput,validateSignupStatus,validateTrialStatus,validateSignupRegistration,validateHonOsTrial} from '@hon/contracts';
assert(process.env.GITHUB_ACTIONS==='true'||process.env.HON_P0_BROWSER_LOCAL==='1');
for(const k of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL','ZERNIO_API_KEY','STRIPE_SECRET_KEY','OPENAI_API_KEY'])assert(!process.env[k]);
const root=resolve('.'),req=createRequire(join(root,'package.json')),tools=createRequire(join(process.env.HON_HQ_BROWSER_TOOLS,'runner.cjs'));
const {chromium}=tools('playwright-core'),axe=await readFile(tools.resolve('axe-core/axe.min.js'),'utf8'),results=join(process.env.HON_HQ_BROWSER_RESULTS,'hon-os-start');
await mkdir(results,{recursive:true});
const report={sourceSha:process.env.HON_HQ_SOURCE_SHA,syntheticBrowserOnly:true,realProviderCalls:0,checks:[],screenshots:[],accessibility:[]};
const session={mode:'OIDC',audience:'p0-browser',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true},subject='oidc:p0-browser:new-owner';
const ids={registrationId:randomUUID(),organizationId:randomUUID(),schoolId:randomUUID(),campaignId:randomUUID(),enrollmentId:randomUUID(),termsVersionId:randomUUID()};
const terms={termsVersionId:ids.termsVersionId,version:1,status:'TEST_ONLY_DRAFT',title:'HON OS test sign-up terms',documentDigest:'a'.repeat(64)};
const offer={campaignId:ids.campaignId,name:'Synthetic founding schools trial',durationDays:14,automaticCharge:false,paymentMethodRequired:false,aiIncluded:true,aiCredits:{credits:100,dailyCap:20,perRequestCap:10,expiryDays:7}};
// The fixture is the server: every response it sends passes the same closed contract validators the API uses.
const state={signup:'CLOSED',trial:'CLOSED',registration:null,enrollment:null,posts:[],dropNext:false};
function signupView(){return validateSignupStatus({signupStatus:state.signup,terms:state.signup==='TEST_MODE'?terms:null,eligibility:state.registration?'ALREADY_REGISTERED':'ELIGIBLE',registration:state.registration});}
function trialView(){return validateTrialStatus({trialStatus:state.trial,schoolId:state.registration?.schoolId??null,available:state.trial==='TEST_MODE'&&!state.enrollment&&state.registration?offer:null,trial:state.enrollment});}
const api=createServer(async(r,s)=>{
 const send=(status,body)=>{s.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});s.end(JSON.stringify(body));};
 let who;try{who=verifySession(cookieValue(r.headers.cookie,HON_SESSION_COOKIE)??'',session).externalSubject;}catch{send(401,{code:'SIGN_IN_REQUIRED'});return;}
 assert.equal(who,subject);
 if(r.url==='/v1/me/language-preference'){send(200,{data:{preference:{language:'en',version:1,updatedAt:'2026-10-28T00:00:00.000Z'},schoolDefault:null,effective:{language:'en',source:'PERSONAL'},supportedLanguages:['en','ko','es']}});return;}
 if(r.method==='GET'&&r.url==='/v1/account/sign-up'){send(200,{data:signupView()});return;}
 if(r.method==='GET'&&r.url==='/v1/account/trial'){send(200,{data:trialView()});return;}
 if(r.method==='POST'&&(r.url==='/v1/account/sign-up'||r.url==='/v1/account/trial')){
  let body='';for await(const c of r)body+=c;const signup=r.url==='/v1/account/sign-up';
  state.posts.push({path:r.url,body,key:r.headers['idempotency-key'],command:r.headers['x-hon-human-command']});
  assert.equal(r.headers['x-hon-human-command'],signup?SIGNUP_HUMAN_COMMAND:TRIAL_HUMAN_COMMAND);assert.equal(r.headers['sec-fetch-site'],'same-origin');assert.match(r.headers['idempotency-key']??'',/^[0-9a-f-]{36}$/);
  if(signup){const input=validateSignupInput(JSON.parse(body));assert.equal(input.termsVersionId,ids.termsVersionId);
   if(state.signup!=='TEST_MODE'){send(409,{code:'SIGNUP_CLOSED',outcome:'NOT_SUBMITTED'});return;}
   state.registration??=validateSignupRegistration({registrationId:ids.registrationId,organizationId:ids.organizationId,schoolId:ids.schoolId,schoolName:input.schoolName,timezone:input.timezone,registeredAt:new Date().toISOString(),lifecycle:'REGISTERED',accessGranted:false,billingActivated:false,aiCreditsGranted:false});
   // A lost response after commit: the browser must keep the exact request and the replay returns the same receipt.
   if(state.dropNext){state.dropNext=false;s.destroy();return;}
   send(200,{data:state.registration});return;}
  const input=validateTrialStartInput(JSON.parse(body));assert.deepEqual({schoolId:input.schoolId,campaignId:input.campaignId},{schoolId:ids.schoolId,campaignId:ids.campaignId});
  const start=new Date(),ms=86400000;
  state.enrollment??=validateHonOsTrial({enrollmentId:ids.enrollmentId,organizationId:ids.organizationId,schoolId:ids.schoolId,campaignId:ids.campaignId,durationDays:14,startsAt:start.toISOString(),endsAt:new Date(+start+14*ms).toISOString(),status:'TRIAL_ACTIVE',automaticCharge:false,paymentMethodRequired:false,aiIncluded:true,aiCredits:{credits:100,dailyCap:20,perRequestCap:10,expiresAt:new Date(+start+7*ms).toISOString(),used:0},creativeCreditsIncluded:false});
  send(200,{data:state.enrollment});return;
 }
 send(404,{code:'NOT_FOUND'});
});
let app,browser;const origin='http://127.0.0.1:3100';
async function open(size){const context=await browser.newContext({viewport:size,reducedMotion:'reduce',serviceWorkers:'block'});await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await context.addCookies([{name:HON_SESSION_COOKIE,value:issueSession({externalSubject:subject,email:'synthetic-new-owner@example.invalid',emailVerified:true},session),url:origin,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();await page.goto(origin+'/account/start');return {context,page};}
async function capture(page,name){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' scrolls sideways');await page.addScriptTag({content:axe});const a=await page.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));report.accessibility.push({name,violations:a.violations.map(v=>({id:v.id,impact:v.impact}))});assert.equal(a.violations.length,0,JSON.stringify(a.violations.map(v=>v.id)));await page.screenshot({path:join(results,name+'.png'),fullPage:true});report.screenshots.push(name+'.png');}
const check=page=>page.getByRole('button',{name:/^(Check my account|Check again)$/}).click();
try{
 await new Promise(done=>api.listen(3001,'127.0.0.1',done));
 app=spawn(process.execPath,[req.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3100'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',HON_DEPLOYMENT_ENVIRONMENT:'preview',NEXT_TELEMETRY_DISABLED:'1',HON_AUTH_MODE:'OIDC',HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_PUBLIC_ORIGIN:origin},stdio:'ignore'});
 let ready=false;for(let n=0;n<80;n++){try{await fetch(origin);ready=true;break;}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready);
 browser=await chromium.launch({executablePath:process.env.HON_HQ_CHROME_BIN,headless:true,args:['--no-sandbox']});
 // The public entry points lead here.
 {const context=await browser.newContext();const page=await context.newPage();await page.goto(origin+'/');assert.equal(await page.getByRole('link',{name:'Start a new school'}).getAttribute('href'),'/account/start');await context.close();}
 for(const [size,viewport]of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  Object.assign(state,{signup:'CLOSED',trial:'CLOSED',registration:null,enrollment:null});const posts=state.posts.length;
  let {page,context}=await open(viewport);
  await page.getByText('Check your account to begin.').waitFor();assert.equal(state.posts.length,posts,'no automatic command');
  // As shipped: both programs CLOSED. The page says so and offers nothing to submit.
  await check(page);await page.getByText('Self-serve sign-up is not open yet. Nothing has been created.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('textbox').count(),0);assert.equal(await page.getByRole('button',{name:'Create my school account'}).count(),0);await capture(page,size+'-closed');
  // Sign-up open (test mode only in this fixture): the owner creates their school; a lost response is retried with the same key and body.
  state.signup='TEST_MODE';await check(page);await page.getByLabel('Your name').fill('Synthetic Owner');await page.getByLabel('School name').fill('Synthetic Dojo');await page.getByLabel('Legal business name').fill('Synthetic Dojo LLC');
  await page.getByLabel('School time zone').fill('America/New_York');assert(await page.getByRole('button',{name:'Create my school account'}).isDisabled());await page.getByRole('checkbox').check();
  await capture(page,size+'-sign-up-form');
  state.dropNext=true;await page.getByRole('button',{name:'Create my school account'}).click();await page.getByText('The outcome is unknown.',{exact:false}).waitFor();
  await page.waitForTimeout(150);assert.equal(state.posts.length,posts+1,'never resent automatically');
  await page.getByRole('button',{name:'Retry exact request'}).click();await page.getByText('Your school account is created.',{exact:false}).waitFor();
  assert.equal(state.posts[posts].body,state.posts[posts+1].body);assert.equal(state.posts[posts].key,state.posts[posts+1].key);
  // Trials still CLOSED: the account is kept and the owner is told to come back.
  await page.getByText('Free trials are not open yet.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Start free trial'}).count(),0);await capture(page,size+'-registered-trial-closed');
  // Trial open: the HQ offer with its AI credit; starting it needs an explicit confirmation and leads to Founder Setup.
  state.trial='TEST_MODE';await check(page);await page.getByText('Includes the AI team with 100 trial credits',{exact:false}).waitFor();
  assert(await page.getByRole('button',{name:'Start free trial'}).isDisabled());await page.getByRole('checkbox').check();await capture(page,size+'-trial-offer');
  await page.getByRole('button',{name:'Start free trial'}).click();await page.getByText('Your free trial is on.',{exact:false}).waitFor();
  const trialPost=JSON.parse(state.posts.at(-1).body);assert.deepEqual(Object.keys(trialPost).sort(),['campaignId','confirmation','schoolId']);
  await page.getByRole('link',{name:'Continue to Founder Setup →'}).focus();assert(await page.getByRole('link',{name:'Continue to Founder Setup →'}).evaluate(e=>e.getAttribute('href')==='/staff/founder-setup'&&e===document.activeElement));
  await capture(page,size+'-trial-started');
  await page.evaluate(()=>window.dispatchEvent(new Event('hon:session-invalidated')));assert.equal(await page.getByText('Synthetic Dojo').count(),0);
  report.checks.push(size+': closed state, explicit sign-up with lost-response exact retry, trial closed, trial offer with AI credit, explicit start, Founder Setup link, invalidation, keyboard and axe');await context.close();
 }
 console.log('PASS mounted HON OS start browser: '+report.checks.length+' desktop/mobile scenario groups, '+report.accessibility.length+' axe scans');
}finally{await browser?.close();app?.kill('SIGTERM');await new Promise(done=>api.close(done));await writeFile(join(results,'browser-report.json'),JSON.stringify(report,null,2)+'\n');}
