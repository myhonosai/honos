/** Mounted production Next/React + real language/Zernio transports; synthetic signed API only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, validateMyLanguagePreferenceView } from '@hon/contracts';
import { translate } from '@hon/design-system';

assert.equal(process.env.GITHUB_ACTIONS,'true');
for(const key of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL','ZERNIO_API_KEY','HON_ZERNIO_VERIFICATION_APPROVED','STRIPE_SECRET_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY']) assert(!process.env[key], 'No provider/database credentials or activation gates');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),tools=process.env.HON_HQ_BROWSER_TOOLS,results=process.env.HON_HQ_BROWSER_RESULTS;
assert(tools&&results&&process.env.HON_HQ_CHROME_BIN);
const requireTools=createRequire(join(tools,'runner.cjs')),requireWeb=createRequire(join(root,'package.json'));
const {chromium}=requireTools('playwright-core'),axe=await readFile(requireTools.resolve('axe-core/axe.min.js'),'utf8'),{build}=requireTools('esbuild');
await mkdir(results,{recursive:true});
const report={sourceSha:process.env.HON_HQ_SOURCE_SHA,fixtureOnly:true,realProviderCalls:0,checks:[],failures:[],screenshots:[],accessibility:[],pageErrors:[]};
const session={mode:'OIDC',audience:'zernio-mounted-fixture',secret:randomBytes(32).toString('hex')};
const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
const origin=`http://127.0.0.1:${port}`;
const configuration={provider:'ZERNIO',credential:'PRESENT',secretStorage:'API_SERVER_ENVIRONMENT',verificationEnabled:false,externalActions:'DISABLED',schoolConnections:'NOT_CONFIGURED'};
const receipt={provider:'ZERNIO',status:'VALID',checkedAt:'2026-10-26T12:00:00.000Z',externalActions:'DISABLED'};
const states=new Map();
const overview={asOf:'2026-10-26T12:00:00.000Z',callerHqRole:'OWNER',organizationCount:0,schoolCount:0,
  onboarding:{availability:'AVAILABLE',requestCount:0,inProgressRequestCount:0,completedRequestCount:0},configuredProviderStates:{disabled:0,configured:0,healthy:0,degraded:0,unavailable:0},taskProfileCount:0,
  financialMetrics:{availability:'UNAVAILABLE',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics},aiUsage:{availability:'UNAVAILABLE',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage},durableHqWork:{availability:'UNAVAILABLE',state:'NO_RECORDED_WORK',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork}};
const api=createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify(status===200?{data}:{code:'SYNTHETIC_DENIAL'}));};
  let subject;try{subject=verifySession(cookieValue(req.headers.cookie,HON_SESSION_COOKIE)??'',session).externalSubject;}catch{send(401,null);return;}
  const s=states.get(subject);if(!s){send(403,null);return;}
  if(req.url==='/v1/identity/me'){send(200,{externalSubject:subject});return;}
  if(req.url==='/v1/hq/overview'){send(200,{overview});return;}
  if(req.url==='/v1/me/language-preference') {
    if(req.method==='POST'){send(s.languageStatus===200?403:s.languageStatus,null);return;}
    send(s.languageStatus,validateMyLanguagePreferenceView({preference:{language:s.language,version:1,updatedAt:'2026-10-26T12:00:00.000Z'},schoolDefault:null,effective:{language:s.language,source:'PERSONAL'},supportedLanguages:['en','ko','es']}));return;
  }
  if(req.url==='/v1/hq/integrations/zernio/configuration'){
    ++s.reads;const data={...configuration,verificationEnabled:s.enabled};if(s.hold){s.held.push(()=>send(s.configurationStatus,data));return;}send(s.configurationStatus,data);return;
  }
  if(req.url==='/v1/hq/integrations/zernio/verify'){
    ++s.verifies;let body='';for await(const chunk of req)body+=chunk;
    assert.equal(req.headers['x-hon-human-command'],'zernio-credential-verify');
    send(s.verifyStatus,{...receipt,status:s.providerStatus});return;
  }
  send(404,null);
});
await new Promise(done=>api.listen(3001,'127.0.0.1',done));
const app=spawn(process.execPath,[requireWeb.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,
  env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',HON_API_BASE_URL:'http://127.0.0.1:3001',HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret},stdio:['ignore','pipe','pipe']});
let log='',browser;app.stdout.on('data',d=>log+=d);app.stderr.on('data',d=>log+=d);
// Bundle the unchanged, real language transport and shared signal for execution in
// the same browser as the mounted workbench. No authorization/validator stubs.
const compiled=await build({entryPoints:[join(root,'src/components/localization/http.ts')],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022'});
const actualLanguage='data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64');
async function check(name,work){try{await work();report.checks.push(name);console.log('PASS '+name);}catch(error){report.failures.push({name,error:error.message});console.error('FAIL '+name+': '+error.stack);}}
let serial=0;
async function open(language='en',viewport={width:1440,height:1000}){
  const subject='zernio-browser-'+(++serial),s={language,languageStatus:200,configurationStatus:200,verifyStatus:200,providerStatus:'VALID',enabled:false,reads:0,verifies:0,hold:false,held:[]};states.set(subject,s);
  const context=await browser.newContext({viewport,reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await context.routeWebSocket('**/*',socket=>socket.close());
  await context.addCookies([{name:HON_SESSION_COOKIE,value:issueSession({externalSubject:subject},session),url:origin,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin+'/hq/integrations/zernio');
  await page.locator(`html[lang=${language}] [data-zernio-workbench]`).waitFor();await idle(page);await page.getByText(translate(language,'zernio.PRESENT'),{exact:true}).waitFor();
  return{page,context,s};
}
const idle=page=>page.waitForFunction(()=>document.querySelector('[data-zernio-workbench]')?.getAttribute('data-zernio-busy')==='false');
const shield=page=>page.getByRole('heading',{name:translate('en','zernio.concealed'),exact:true});
const restore=page=>page.getByRole('button',{name:translate('en','zernio.restore'),exact:true}).click();
async function concealed(page){await shield(page).waitFor();assert.equal(await page.getByText(translate('en','zernio.PRESENT'),{exact:true}).count(),0);assert.equal(await page.getByText(translate('en','zernio.VALID'),{exact:true}).count(),0);}
async function languageCall(page,save=false){return page.evaluate(async({module,save})=>{const http=await import(module);try{if(save)await http.updateMyLanguage({language:'ko',expectedVersion:1},crypto.randomUUID());else await http.loadMyLanguage();return 'success';}catch{return 'denied';}}, {module:actualLanguage,save});}
async function capture(page,name){
  await page.evaluate(()=>document.fonts.ready);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.addScriptTag({content:axe});
  const result=await page.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  const violations=result.violations.map(v=>({id:v.id,impact:v.impact}));report.accessibility.push({name,violations});assert.equal(violations.length,0,JSON.stringify(violations));
  await page.screenshot({path:join(results,name+'.png'),fullPage:true,animations:'disabled'});report.screenshots.push(name+'.png');
}
try{
  let ready=false;for(let i=0;i<100;i++){try{await fetch(origin);ready=true;break;}catch{}await new Promise(done=>setTimeout(done,250));}assert(ready,log.slice(-1200));
  browser=await chromium.launch({executablePath:process.env.HON_HQ_CHROME_BIN,headless:true});
  for(const language of ['en','ko','es'])for(const[size,viewport]of[['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])await check(`${language}/${size}: mounted translated page, disabled verification, keyboard and axe`,async()=>{
    const {page,context,s}=await open(language,viewport);try{
      assert.equal(s.verifies,0);assert(await page.getByRole('button',{name:translate(language,'zernio.verify'),exact:true}).isDisabled());
      await page.getByRole('button',{name:translate(language,'zernio.refresh'),exact:true}).focus();assert(await page.getByRole('button',{name:translate(language,'zernio.refresh'),exact:true}).evaluate(e=>e===document.activeElement));
      await capture(page,`${language}-${size}-zernio-configuration`);
      await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.getByRole('heading',{name:translate(language,'zernio.concealed'),exact:true}).waitFor();await idle(page);await capture(page,`${language}-${size}-zernio-concealed`);
    }finally{await context.close();}
  });
  for(const save of [false,true])await check(`real language ${save?'save':'GET'} 401 immediately conceals READY and requires explicit authorized restoration`,async()=>{
    const {page,context,s}=await open();try{
      const reads=s.reads;s.languageStatus=401;assert.equal(await languageCall(page,save),'denied');await concealed(page);await idle(page);assert.equal(s.reads,reads);
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(s.reads,reads);s.configurationStatus=401;await restore(page);await idle(page);await concealed(page);
      s.languageStatus=200;s.configurationStatus=200;assert.equal(await languageCall(page),'success');await concealed(page);const before=s.reads;await restore(page);await idle(page);assert.equal(s.reads,before+1);assert.equal(s.verifies,0);
      await page.getByText(translate('en','zernio.PRESENT'),{exact:true}).waitFor();
    }finally{await context.close();}
  });
  await check('LOADING + language 401 cancels/invalidate reads, ignores late successful response and settles without reload',async()=>{
    const {page,context,s}=await open();try{
      // Deliberately ignore AbortSignal at the fixture transport boundary to prove the epoch guard too.
      await page.evaluate(()=>{const original=window.fetch;window.fetch=(input,options)=>original(input,String(input).includes('/hq/integrations/zernio/configuration')?{...options,signal:undefined}:options);});
      s.hold=true;await page.getByRole('button',{name:translate('en','zernio.refresh'),exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-zernio-workbench]')?.getAttribute('data-zernio-busy')==='true');
      s.languageStatus=401;await languageCall(page);await concealed(page);assert(await page.getByRole('button',{name:translate('en','zernio.restore'),exact:true}).isDisabled());
      assert.equal(s.held.length,1);s.hold=false;s.held.splice(0).forEach(release=>release());await idle(page);await concealed(page);s.languageStatus=200;
      await restore(page);await idle(page);await page.getByText(translate('en','zernio.PRESENT'),{exact:true}).waitFor();assert.equal(s.verifies,0);
    }finally{s.held.splice(0).forEach(release=>release());await context.close();}
  });
  await check('own HON 401 clears mounted receipt and broadcasts; HON 403 remains local; provider rejection does not invalidate',async()=>{
    const {page,context,s}=await open();try{
      await page.evaluate(()=>{window.__invalidations=0;window.addEventListener('hon:session-invalidated',()=>++window.__invalidations);});
      s.languageStatus=403;await languageCall(page);await page.getByText(translate('en','zernio.PRESENT'),{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__invalidations),0);
      s.languageStatus=200;const reads=s.reads;await languageCall(page);assert.equal(s.reads,reads);
      s.enabled=true;await page.getByRole('button',{name:translate('en','zernio.refresh'),exact:true}).click();await idle(page);
      await page.locator('[data-zernio-workbench] input[type=checkbox]').check();await page.getByRole('button',{name:translate('en','zernio.verify'),exact:true}).click();await idle(page);await page.getByText(translate('en','zernio.VALID'),{exact:true}).waitFor();
      s.providerStatus='REJECTED';await page.locator('[data-zernio-workbench] input[type=checkbox]').check();await page.getByRole('button',{name:translate('en','zernio.verify'),exact:true}).click();await idle(page);await page.getByText(translate('en','zernio.REJECTED'),{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__invalidations),0);
      s.verifyStatus=401;await page.locator('[data-zernio-workbench] input[type=checkbox]').check();await page.getByRole('button',{name:translate('en','zernio.verify'),exact:true}).click();await idle(page);await concealed(page);assert.equal(await page.evaluate(()=>window.__invalidations),1);
      s.verifyStatus=200;await restore(page);await idle(page);s.configurationStatus=403;await page.getByRole('button',{name:translate('en','zernio.refresh'),exact:true}).click();await idle(page);assert.equal(await page.evaluate(()=>window.__invalidations),1);
      await page.locator('[data-zernio-workbench] [role=alert]').waitFor();await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await concealed(page);assert.equal(await page.locator('[data-zernio-workbench] [role=alert]').count(),0);
    }finally{await context.close();}
  });
  for(const event of ['blur','pagehide','hidden','hon:session-invalidated','hon:school-context-changed'])await check(`${event}: mounted privacy clearing and explicit restoration only`,async()=>{
    const {page,context,s}=await open();try{
      const reads=s.reads;await page.evaluate(event=>{if(event==='hidden'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));}else window.dispatchEvent(new Event(event));},event);
      await concealed(page);await idle(page);assert.equal(s.reads,reads);assert.equal(s.verifies,0);
      if(event==='hidden')await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'}));
      await restore(page);await idle(page);assert.equal(s.reads,reads+1);await page.getByText(translate('en','zernio.PRESENT'),{exact:true}).waitFor();
    }finally{await context.close();}
  });
  await check('unmount aborts pending view, late response cannot restore it, remount requires a new protected read',async()=>{
    const {page,context,s}=await open();try{
      s.hold=true;await page.getByRole('button',{name:translate('en','zernio.refresh'),exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[data-zernio-workbench]')?.getAttribute('data-zernio-busy')==='true');
      await page.locator('a[href="/settings/language-region"]').first().click();await page.waitForURL('**/settings/language-region');
      s.hold=false;s.held.splice(0).forEach(release=>release());assert.equal(await page.locator('[data-zernio-workbench]').count(),0);
      const before=s.reads;await page.goto(origin+'/hq/integrations/zernio');await page.getByText(translate('en','zernio.PRESENT'),{exact:true}).waitFor();await idle(page);assert.equal(s.reads,before+1);assert.equal(s.verifies,0);
    }finally{s.held.splice(0).forEach(release=>release());await context.close();}
  });
  assert.equal(report.pageErrors.length,0,JSON.stringify(report.pageErrors));assert.equal(report.failures.length,0,JSON.stringify(report.failures));
}finally{
  if(browser)await browser.close();app.kill('SIGTERM');await new Promise(done=>api.close(done));
  await writeFile(join(results,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.checks.length,failed:report.failures.length,accessibilityScans:report.accessibility.length,screenshots:report.screenshots.length}));
}
