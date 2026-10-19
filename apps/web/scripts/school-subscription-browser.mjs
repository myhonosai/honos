/** Real Next UI + deterministic authenticated localhost B5/B3 fixtures; never real Stripe evidence. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { SAAS_COMMANDS } from '@hon/contracts';
import { checkoutId, schoolContext, schoolPlanFixture, schoolCreditsFixture, schoolCheckoutReceipt } from './fixtures/school-checkout.mjs';

assert(process.env.GITHUB_ACTIONS === 'true' || process.env.HON_SUBSCRIPTION_LOCAL === '1');
for (const key of ['DATABASE_URL','SUPABASE_SERVICE_ROLE_KEY','STRIPE_TEST_SECRET_KEY','STRIPE_TEST_WEBHOOK_SECRET','STRIPE_SECRET_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY']) assert(!process.env[key], 'Refusing inherited database/provider credentials.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),tools=process.env.HON_SUBSCRIPTION_TOOLS,results=process.env.HON_SUBSCRIPTION_RESULTS,chrome=process.env.HON_SUBSCRIPTION_CHROME;
assert(tools&&results&&chrome);const requireTools=createRequire(join(tools,'runner.cjs')),requireWeb=createRequire(join(root,'package.json'));
const {chromium}=requireTools('playwright-core'),axe=await readFile(requireTools.resolve('axe-core/axe.min.js'),'utf8');await mkdir(results,{recursive:true});
const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const origin=`http://127.0.0.1:${port}`;
const session={mode:'OIDC',audience:'hon-school-checkout-local',secret:randomBytes(32).toString('hex')};
const report={sourceSha:process.env.HON_SUBSCRIPTION_SOURCE_SHA??'local',syntheticFixturesOnly:true,realStripeSandboxVerified:false,productionDataUsed:false,checks:[],failures:[],screenshots:[],accessibility:[],apiRequests:[],commandCount:0,externalHostsBlocked:[],pageErrors:[],unexpectedRequests:[]};
let fixture,readMode,contextMode,commandMode,creditMode,creditDelay,keys,commands;
function reset(options={}){fixture={tier:'CORE',state:'ready',provider:'STRIPE_SIMULATED',kind:'REGULAR_MONTHLY',stock:4,...options};readMode='ready';contextMode='ready';commandMode='ready';creditMode='ready';creditDelay=0;keys=[];commands=[];}
reset();
const planPath=`/v1/schools/${schoolContext.schoolId}/hon-plan`,creditPath=`/v1/schools/${schoolContext.schoolId}/ai-credits`;
function send(response,status,data,delay=0){const body=JSON.stringify(data);const finish=()=>{if(!response.destroyed){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});response.end(body);}};if(delay)setTimeout(finish,delay);else finish();}
const api=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1:3001');report.apiRequests.push({method:req.method,path:url.pathname});
  let actor;try{actor=verifySession(cookieValue(req.headers.cookie,HON_SESSION_COOKIE)??'',session).externalSubject;}catch{send(res,401,{private:'never-echo-private'});return;}
  if(!['school-owner-synthetic','staff-without-purchase-synthetic'].includes(actor)){send(res,403,{private:'never-echo-private'});return;}
  if(url.search){send(res,400,{});return;}
  if(req.method==='GET'&&url.pathname==='/v1/staff/current-reporting-school'){
    if(contextMode==='denied'){send(res,403,{});return;}send(res,200,{data:contextMode==='ambiguous'?{state:'MANUAL_ENTRY_REQUIRED'}:schoolContext});return;
  }
  if(actor!=='school-owner-synthetic'){send(res,403,{private:'never-echo-private'});return;}
  if(req.method==='GET'&&url.pathname===planPath){
    if(['401','403','503'].includes(readMode)){send(res,Number(readMode),{private:'never-echo-private'});return;}
    const plan=schoolPlanFixture(fixture);
    if(readMode==='tier-mismatch'){plan.entitlementTier='COMPLETE';plan.offers=[];}if(readMode==='scope')plan.schoolId=checkoutId(999);if(readMode==='malformed')plan.privateEmail='never-echo-private';if(readMode==='disabled-open')plan.payments={status:'DISABLED',mode:null};
    send(res,200,{data:plan});return;
  }
  if(req.method==='GET'&&url.pathname===creditPath){
    if(creditMode==='denied'){send(res,403,{});return;}const c=schoolCreditsFixture(schoolPlanFixture(fixture),['inactive','absent','expired','empty'].includes(creditMode)?creditMode:'ready');if(creditMode==='plan-drift'){c.planCode='COMPLETE';c.currentAllowance=null;}if(creditMode==='scope'&&c.currentAllowance)c.currentAllowance.subscriptionId=checkoutId(999);send(res,200,{data:c},creditDelay);return;
  }
  if(req.method==='POST'&&url.pathname===`${planPath}/checkout`){
    report.commandCount++;
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>512){send(res,400,{});return;}}
    let input;try{input=JSON.parse(raw);}catch{send(res,400,{});return;}
    const key=req.headers['idempotency-key'];
    if(req.headers.origin!==origin||req.headers['sec-fetch-mode']!=='same-origin'||req.headers['sec-fetch-site']!=='same-origin'||req.headers['sec-fetch-dest']!=='empty'||req.headers['x-hon-human-command']!==SAAS_COMMANDS.startCheckout||!/^application\/json/.test(req.headers['content-type']??'')||typeof key!=='string'||!/^[0-9a-f-]{36}$/.test(key)||Object.keys(input).join(',')!=='offerId') {send(res,403,{code:'HUMAN_UI_REQUIRED'});return;}
    const o=schoolPlanFixture(fixture).offers.find(o=>o.offerId===input.offerId);if(!o){send(res,400,{});return;}
    keys.push(key);commands.push(input);fixture.kind=o.offerKind;
    if(commandMode==='denied'){send(res,403,{});return;}
    if(commandMode==='unknown'||commandMode==='provider-off'){fixture.state='created';send(res,commandMode==='unknown'?409:503,{code:commandMode==='unknown'?'SAAS_OUTCOME_UNKNOWN':'SAAS_PAYMENTS_NOT_CONFIGURED',private:'never-echo-private'});return;}
    fixture.state='open';const receipt=schoolCheckoutReceipt(fixture);send(res,200,{data:receipt},80);return;
  }
  report.unexpectedRequests.push({method:req.method,path:url.pathname});send(res,404,{});
});
await new Promise((done,reject)=>{api.once('error',reject);api.listen(3001,'127.0.0.1',done);});
const app=spawn(process.execPath,[requireWeb.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',HON_API_BASE_URL:'http://127.0.0.1:3001',HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret},stdio:['ignore','pipe','pipe']});
app.stdout.on('data',()=>{});app.stderr.on('data',()=>{});
const delay=ms=>new Promise(done=>setTimeout(done,ms));let browser;
async function check(name,operation){try{await operation();report.checks.push(name);console.log(`PASS ${name}`);}catch(e){report.failures.push({name,message:String(e.message).slice(0,1600)});console.log(`FAIL ${name}: ${String(e.message).slice(0,1600)}`);}}
async function context(viewport={width:390,height:844},subject='school-owner-synthetic',token){
  const ctx=await browser.newContext({viewport,reducedMotion:'reduce'});
  await ctx.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin){await route.continue();return;}report.externalHostsBlocked.push(u.hostname);
    if(u.hostname==='checkout.stripe.com'&&u.pathname==='/c/pay/cs_test_synthetic'){await route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en"><title>Deterministic hosted fixture</title><body><h1>Deterministic hosted-checkout stand-in</h1><p>No card data or real provider connection.</p><a href="${origin}/schools/${schoolContext.schoolId}/hon-plan?result=success&checkout=untrusted">Return to HON</a></body></html>`});return;}await route.abort();});
  if(subject!==null)await ctx.addCookies([{name:HON_SESSION_COOKIE,value:token??issueSession({externalSubject:subject},session),url:origin,httpOnly:true,sameSite:'Lax'}]);
  ctx.on('page',p=>{p.setDefaultTimeout(8000);p.on('pageerror',e=>report.pageErrors.push(String(e.message).slice(0,600)));});return ctx;
}
async function open(ctx,path='/staff/subscription'){const p=await ctx.newPage();await p.goto(origin+path);await p.getByRole('heading',{level:1}).waitFor();return p;}
async function ready(page){await page.getByRole('heading',{name:'Your HON subscription',exact:true}).waitFor();await page.getByRole('button',{name:'Refresh payment status'}).waitFor();}
async function review(page,retry=false){await page.getByRole('button',{name:'Review selection'}).click();await page.getByRole('checkbox').check();return page.getByRole('button',{name:retry?'Retry same test checkout':'Start secure test checkout',exact:true});}
async function overflow(p){assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.body.scrollWidth<=innerWidth+1),'No horizontal overflow');}
async function scan(p,label){await p.addScriptTag({content:axe});const a=await p.evaluate(async()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}));report.accessibility.push({label,violations:a.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),incompleteCount:a.incomplete.length});assert.equal(a.violations.length,0,`${label}: ${a.violations.map(v=>v.id).join(',')}`);}
async function capture(p,name,fullPage=true){await p.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);let label=document.getElementById('fixture-label');if(!label){label=document.createElement('div');label.id='fixture-label';label.textContent='SYNTHETIC AUTHORIZED FIXTURE · TEST MODE · NO REAL STRIPE VERIFICATION';label.style.cssText='position:relative;z-index:100;padding:7px;background:#19374b;color:#d4faff;font:10px system-ui;text-align:center';document.body.prepend(label);}});await p.screenshot({path:join(results,`${name}.png`),fullPage,animations:'disabled'});const jpg=await p.screenshot({type:'jpeg',quality:76,fullPage,animations:'disabled'});await writeFile(join(results,`${name}.jpg`),jpg);report.screenshots.push(`${name}.png`);const b=jpg.toString('base64'),n=Math.ceil(b.length/8000);for(let i=0;i<n;i++)console.log(`SCHOOL_REVIEW_IMAGE ${name} ${i+1}/${n} ${b.slice(i*8000,(i+1)*8000)}`);}
try{
  const probeCookie=`${HON_SESSION_COOKIE}=${issueSession({externalSubject:'school-owner-synthetic'},session)}`;let started=false;
  for(let i=0;i<60;i++){try{if((await fetch(`${origin}/staff/subscription`,{redirect:'manual',headers:{Cookie:probeCookie}})).status===200){started=true;break;}}catch{}await delay(500);}assert(started,'Actual Next server did not start');
  browser=await chromium.launch({executablePath:chrome,headless:true});
  for(const [name,viewport]of [['desktop',{width:1440,height:1000}],['tablet',{width:834,height:1112}],['mobile',{width:390,height:844}],['narrow',{width:320,height:800}]]){
    reset();const ctx=await context(viewport),p=await open(ctx);await ready(p);
    await check(`${name}: actual authenticated offers and informational plan distinction`,async()=>{assert(await p.getByText('Server-returned offer',{exact:false}).count()>0);await p.getByRole('button',{name:'Select HON Complete',exact:false}).click();assert(await p.getByRole('button',{name:'Review selection'}).isDisabled());await p.getByRole('button',{name:'Select HON Core',exact:false}).click();assert(await p.getByRole('button',{name:'Review selection'}).isEnabled());await overflow(p);await scan(p,`${name}-offers`);});
    if(['desktop','mobile'].includes(name))await capture(p,`${name}-offers`);
    await check(`${name}: all offer prices and presentation modes`,async()=>{for(const [label,prices]of [['Founder monthly',['$79','$149']],['Founder lifetime',['$1,896','$3,576']],['Regular monthly',['$149','$249']]]){await p.getByRole('radio',{name:new RegExp(`^${label}`)}).check();for(const price of prices)assert(await p.getByRole('group',{name:'Compare and select a HON plan'}).getByText(price,{exact:true}).isVisible());}for(const mode of ['Big Button','Classic','Modern']){await p.getByRole('button',{name:mode,exact:true}).click();await overflow(p);}});
    await check(`${name}: explicit confirmation, one POST on duplicate activation and simulator truth`,async()=>{await p.getByRole('radio',{name:/^Founder lifetime/}).check();await p.getByRole('button',{name:'Review selection'}).click();assert(await p.getByRole('button',{name:'Start secure test checkout',exact:true}).isDisabled());await p.getByRole('checkbox').check();await scan(p,`${name}-review`);if(['desktop','mobile'].includes(name))await capture(p,`${name}-review`);const before=commands.length;await p.getByRole('button',{name:'Start secure test checkout',exact:true}).evaluate(e=>{e.click();e.click();});await p.getByText('Checkout open — payment pending',{exact:true}).waitFor();assert.equal(commands.length-before,1);assert.equal(await p.getByRole('link',{name:/Continue on Stripe/}).count(),0);assert(await p.getByText(/Simulator session recorded/).isVisible());assert.equal(await p.getByRole('heading',{name:'Pending Account Activation'}).count(),0);await scan(p,`${name}-open`);});
    if(['desktop','mobile'].includes(name))await capture(p,`${name}-open`);
    await check(`${name}: authoritative verified payment/allowance and pending activation after return`,async()=>{fixture.state='paid';await p.goto(`${origin}/schools/${checkoutId(999)}/hon-plan?result=success&checkout=forged`);await p.getByRole('heading',{name:'Pending Account Activation',exact:true}).waitFor();await p.getByText('4,000',{exact:true}).waitFor();assert(await p.getByText('Simulator-verified test payment',{exact:true}).isVisible());await overflow(p);await scan(p,`${name}-paid`);assert(!report.apiRequests.some(r=>r.path.includes(checkoutId(999))));if(['desktop','mobile'].includes(name)){await p.evaluate(()=>window.scrollTo(0,0));assert(await p.getByRole('heading',{name:'Pending Account Activation',exact:true}).evaluate(e=>e.getBoundingClientRect().bottom<innerHeight-40),'Activation state must fit the initial desktop/mobile viewport');}});
    if(['desktop','mobile'].includes(name)){await capture(p,`${name}-paid`);await capture(p,`${name}-paid-viewport`,false);}
    await check(`${name}: HON keyboard controls and full capability comparison`,async()=>{const toggle=p.getByRole('button',{name:'HON plan guide',exact:true});await toggle.focus();await p.keyboard.press('Enter');const guide=p.getByRole('complementary',{name:'A little guidance?'});await guide.getByRole('button',{name:'Does payment activate access?'}).click();assert(await guide.getByText(/page never grants or changes features/).isVisible());await scan(p,`${name}-guide`);if(['desktop','mobile'].includes(name))await capture(p,`${name}-guide`,false);await p.keyboard.press('Escape');assert.equal(await guide.count(),0);assert(await toggle.evaluate(e=>e===document.activeElement));const summary=p.locator('summary').filter({hasText:'View full feature comparison'});await summary.focus();await p.keyboard.press('Enter');assert(await p.getByRole('table').isVisible());await overflow(p);});
    await ctx.close();
  }
  async function scenario(name,options,operation,subject='school-owner-synthetic'){await check(name,async()=>{reset(options);const ctx=await context(undefined,subject);try{await operation(ctx);}finally{await ctx.close();}});}
  await scenario('Stripe test link hands off and returns through real authenticated page; hosted provider is a deterministic stand-in',{provider:'STRIPE'},async ctx=>{const p=await open(ctx);await ready(p);await(await review(p)).click();const link=p.getByRole('link',{name:'Continue on Stripe test checkout'});await link.waitFor();const next=ctx.waitForEvent('page');await link.click();const hosted=await next;await hosted.getByRole('heading',{name:'Deterministic hosted-checkout stand-in'}).waitFor();fixture.state='paid';await hosted.getByRole('link',{name:'Return to HON'}).click();await hosted.getByRole('heading',{name:'Pending Account Activation'}).waitFor();assert(await hosted.getByText('Provider-verified test payment',{exact:true}).isVisible());});
  await scenario('Unknown outcome preserves identical offer and retry key, without automatic resubmission',{},async ctx=>{commandMode='unknown';const p=await open(ctx);await ready(p);await(await review(p)).click();await p.getByRole('main').getByRole('alert').filter({hasText:/unknown/}).waitFor();assert.equal(keys.length,1);await p.getByRole('button',{name:'Refresh payment status'}).click();await p.getByText('Checkout pending provider connection',{exact:true}).waitFor();commandMode='ready';await(await review(p,true)).click();await p.getByText('Checkout open — payment pending',{exact:true}).waitFor();assert.equal(keys.length,2);assert.equal(new Set(keys).size,1);assert.deepEqual(commands[0],commands[1]);});
  await scenario('Unavailable provider is honest and creates no paid/access claim',{},async ctx=>{commandMode='provider-off';const p=await open(ctx);await ready(p);await(await review(p)).click();await p.getByRole('main').getByRole('alert').filter({hasText:/not configured/}).waitFor();assert.equal(await p.getByRole('heading',{name:'Pending Account Activation'}).count(),0);assert.equal(await p.getByRole('link',{name:/Continue on Stripe/}).count(),0);});
  await scenario('Repriced offer requires new human review and never submits old terms',{},async ctx=>{const p=await open(ctx);await ready(p);const start=await review(p);fixture.price=14901;await start.click();await p.getByRole('main').getByRole('alert').filter({hasText:/changed/}).waitFor();assert.equal(commands.length,0);assert.equal(await p.getByRole('checkbox').count(),0);assert(await p.getByText('$149.01',{exact:true}).count()>0);});
  await scenario('Revoked authorization before command clears facts and refuses checkout',{},async ctx=>{const p=await open(ctx);await ready(p);const start=await review(p);contextMode='denied';await start.click();await p.getByRole('main').getByRole('alert').filter({hasText:/denied/}).waitFor();assert.equal(commands.length,0);assert.equal(await p.getByRole('heading',{name:'Your HON subscription',exact:true}).count(),0);});
  await scenario('Independent POST denial clears prior billing facts',{},async ctx=>{const p=await open(ctx);await ready(p);const start=await review(p);commandMode='denied';await start.click();await p.getByRole('main').getByRole('alert').filter({hasText:/denied/}).waitFor();assert.equal(await p.getByRole('heading',{name:'Your HON subscription',exact:true}).count(),0);});
  await scenario('Late credit response cannot restore stale subscription/balance after refresh',{state:'paid'},async ctx=>{creditDelay=500;const p=await open(ctx);await ready(p);fixture.state='ready';creditDelay=0;await p.getByRole('button',{name:'Refresh payment status'}).click();await p.getByText('No current subscription was returned by the authorized billing service.').waitFor();await delay(600);assert.equal(await p.getByText('4,000',{exact:true}).count(),0);});
  for(const state of ['disabled','empty'])await scenario(`${state}: unavailable purchasing`,{state},async ctx=>{const p=await open(ctx);await ready(p);assert(await p.getByRole('button',{name:'Review selection'}).isDisabled());assert.equal(commands.length,0);});
  await scenario('Sold-out founder offer cannot start checkout',{stock:0},async ctx=>{const p=await open(ctx);await ready(p);await p.getByRole('radio',{name:/^Founder monthly/}).check();assert(await p.getByRole('button',{name:'Review selection'}).isDisabled());});
  await scenario('Disabled program suppresses a previously opened Stripe hosted link',{state:'open',provider:'STRIPE'},async ctx=>{readMode='disabled-open';const p=await open(ctx);await ready(p);await p.getByText(/unavailable while payments are disabled/).waitFor();assert.equal(await p.getByRole('link',{name:/Continue on Stripe/}).count(),0);assert.equal(commands.length,0);});
  for(const state of ['failed','expired','canceled','review','disputed','past-due','refunded','attested'])await scenario(`${state}: backend status, no invented verified payment or activation`,{state},async ctx=>{const p=await open(ctx);await ready(p);assert.equal(await p.getByRole('heading',{name:'Pending Account Activation'}).count(),0);assert.equal(commands.length,0);if(['review','disputed','past-due','refunded','attested'].includes(state))assert(await p.getByRole('button',{name:'Review selection'}).isDisabled());});
  for(const mode of ['401','403','503','scope','malformed'])await scenario(`${mode}: unavailable/denied/invalid read clears private facts`,{},async ctx=>{readMode=mode;const p=await open(ctx);await p.getByRole('main').getByRole('alert').waitFor();assert(await p.getByRole('button',{name:'Review selection'}).isDisabled());assert(!(await p.locator('body').innerText()).includes('never-echo-private'));assert.equal(commands.length,0);});
  for(const mode of ['denied','scope'])await scenario(`${mode}: independent allowance permission/scope cannot replace billing facts`,{state:'paid'},async ctx=>{creditMode=mode;const p=await open(ctx);await ready(p);await p.getByText(mode==='denied'?/School billing permission was denied/:/could not verify the billing response/).waitFor();assert.equal(await p.getByText('4,000',{exact:true}).count(),0);});
  await scenario('Ambiguous current school fails closed without caller-supplied selectors',{},async ctx=>{contextMode='ambiguous';const before=report.apiRequests.length,p=await open(ctx);await p.getByRole('main').getByRole('alert').filter({hasText:/single current school/}).waitFor();assert(!report.apiRequests.slice(before).some(r=>r.path===planPath));});
  await scenario('Independent purchaser denial despite resolved reporting scope',{},async ctx=>{const p=await open(ctx);await p.getByRole('main').getByRole('alert').filter({hasText:/denied/}).waitFor();assert.equal(commands.length,0);},'staff-without-purchase-synthetic');
  for(const subject of ['family-synthetic','hq-synthetic','support-synthetic','foreign-school-synthetic'])await scenario(`${subject}: no authorized billing facts or checkout`,{},async ctx=>{const p=await open(ctx);await p.getByRole('main').getByRole('alert').waitFor();assert.equal(commands.length,0);assert.equal(await p.getByRole('heading',{name:'Your HON subscription',exact:true}).count(),0);},subject);
  for(const result of ['success','cancelled'])await scenario(`Forged ${result} return is not payment/cancel confirmation`,{state:'open'},async ctx=>{const p=await open(ctx,`/schools/${checkoutId(999)}/hon-plan?result=${result}&checkout=forged`);await p.getByText('Checkout open — payment pending',{exact:true}).waitFor();assert.equal(await p.getByRole('heading',{name:'Pending Account Activation'}).count(),0);assert.equal(commands.length,0);});
  for(const [label,subject,token]of [['unsigned',null,undefined],['tampered','school-owner-synthetic','invalid'],['expired','school-owner-synthetic',issueSession({externalSubject:'school-owner-synthetic'},session,1)]])await check(`${label}: both subscription and provider-return routes preserve the real session gate`,async()=>{const ctx=await context(undefined,subject,token);try{for(const path of ['/staff/subscription',`/schools/${schoolContext.schoolId}/hon-plan`]){const p=await ctx.newPage();await p.goto(origin+path);await p.waitForURL(`${origin}/auth/login`);await p.close();}}finally{await ctx.close();}});
  for (const [size,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
    await check(`${size}: paid suspended record stays suspended; refresh never implies reactivation`,async()=>{
      reset({state:'paid',service:'SUSPENDED'}); const ctx=await context(viewport);
      try { const p=await open(ctx,`/schools/${checkoutId(999)}/hon-plan?result=success&reactivate=true`); await ready(p);
        const access=p.getByRole('status',{name:'Account activation'}),credit=p.getByRole('status',{name:'AI allowance readiness'});
        await access.getByRole('heading',{name:'Subscription suspended',exact:true}).waitFor();
        await credit.getByText('Subscription suspended',{exact:true}).waitFor(); await p.getByText('4,000',{exact:true}).waitFor();
        assert.equal(await p.getByRole('heading',{name:'Pending Account Activation'}).count(),0);
        assert(await access.getByText(/Effective feature access: unavailable/).isVisible());
        await scan(p,`${size}-suspended`); await overflow(p); await capture(p,`${size}-suspended`,false);
        await p.getByText('Account readiness and next steps',{exact:true}).click();
        assert(await p.getByText(/payment does not activate features or clear a suspension/).isVisible());
        assert.equal(await p.getByRole('button',{name:/reactivate|activate|invoice|switch school/i}).count(),0);
        fixture.service='IN_SERVICE'; await p.getByRole('button',{name:'Refresh payment status'}).click();
        await access.getByRole('heading',{name:'Pending Account Activation'}).waitFor();
        await credit.getByText('Allowance recorded',{exact:true}).waitFor();
        assert.equal(await access.getByRole('heading',{name:'Subscription suspended'}).count(),0);
        assert.equal(commands.length,0); await overflow(p);
      } finally {await ctx.close();}
    });
  }
  for (const [mode,label] of [['inactive','Premium credit program inactive'],['absent','Allowance not issued'],['expired','Allowance expired'],['empty','No remaining ledger credits']]) {
    await scenario(`${mode}: exact allowance record without a spending or activation promise`,{state:'paid'},async ctx=>{
      creditMode=mode; const p=await open(ctx);await ready(p);
      await p.getByRole('status',{name:'AI allowance readiness'}).getByText(label,{exact:true}).waitFor();
      assert(await p.getByRole('heading',{name:'Pending Account Activation'}).isVisible());assert.equal(commands.length,0); await overflow(p);
    });
  }
  await scenario('Cross-plan credit response without allowance is rejected',{state:'paid'},async ctx=>{creditMode='plan-drift';const p=await open(ctx);await ready(p);await p.getByRole('status',{name:'AI allowance readiness'}).getByText('AI allowance status unavailable',{exact:true}).waitFor();assert.equal(await p.getByText('4,000',{exact:true}).count(),0);assert.equal(commands.length,0);});
  await scenario('Reported tier and purchased plan stay distinct on mismatch',{state:'paid'},async ctx=>{readMode='tier-mismatch';const p=await open(ctx);await ready(p);await p.getByText(/reported tier and subscription plan differ/).waitFor();assert.equal(await p.getByRole('button',{name:'Review selection'}).isEnabled(),false);assert.equal(commands.length,0);});
  await check('No unexpected API path, direct HQ/database/provider request or JavaScript error',async()=>{assert.deepEqual(report.unexpectedRequests,[]);assert.deepEqual(report.pageErrors,[]);assert(!report.apiRequests.some(r=>/hq|webhook|entitlement|refund/.test(r.path)));});
}catch(e){report.failures.push({name:'harness',message:String(e.message).slice(0,1600)});}
finally{if(browser)await browser.close();app.kill('SIGTERM');await Promise.race([new Promise(done=>app.once('exit',done)),delay(2000)]);if(app.exitCode===null)app.kill('SIGKILL');await new Promise(done=>api.close(done));report.externalHostsBlocked=[...new Set(report.externalHostsBlocked)];await writeFile(join(results,'report.json'),JSON.stringify(report,null,2));console.log(`SCHOOL_BROWSER_REPORT ${JSON.stringify(report)}`);}
if(report.failures.length)process.exitCode=1;
