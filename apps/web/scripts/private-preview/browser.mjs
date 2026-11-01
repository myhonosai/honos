/** Mounted owner launcher + actual app, synthetic localhost API. Not a GitHub Private gateway proof. */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve,join } from 'node:path';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
const root=resolve('.'),web=join(root,'apps/web'),tools=createRequire(join(process.env.HON_PREVIEW_TOOLS,'runner.cjs'));
const {chromium}=tools('playwright-core'),{transform}=tools('esbuild'),out=process.env.HON_PREVIEW_RESULTS;
assert(process.env.GITHUB_ACTIONS==='true'||process.env.HON_PRIVATE_PREVIEW_BROWSER_LOCAL==='1');await mkdir(out,{recursive:true});
const compiled=await transform(await readFile(join(web,'src/components/founder-setup/catalog.ts'),'utf8'),{loader:'ts',format:'esm'});
const {founderText:t}=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
const axe=await readFile(tools.resolve('axe-core/axe.min.js'),'utf8'),origin='http://127.0.0.1:3000';
const report={sourceSha:process.env.HON_PREVIEW_SHA,actualNextApplication:true,syntheticApi:true,realDatabaseOrIamProof:false,codespacesGatewayVerified:false,checks:[],screenshots:[],accessibility:[],pageErrors:[],mutationOrigins:[],blockedExternalRequests:0};
let app,browser,code,stdout='';
const bodyHeaders={'Origin':origin,'Content-Type':'application/json'};
async function capture(page,name){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Wrapper horizontal overflow');await page.screenshot({path:join(out,name+'.png'),fullPage:true});report.screenshots.push(name+'.png');}
async function scan(frame,name){await frame.addScriptTag({content:axe});const r=await frame.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));report.accessibility.push({name,violations:r.violations.map(v=>({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)}))});assert.equal(r.violations.length,0,JSON.stringify(report.accessibility.at(-1)));}
async function frame(page){const el=await page.locator('iframe[name=hon-preview]').elementHandle();assert(el);const f=await el.contentFrame();assert(f,'Actual application frame must attach');await f.waitForLoadState('domcontentloaded');return f;}
async function navigate(page,label){const link=page.getByRole('navigation',{name:'Preview surfaces'}).getByRole('link',{name:label,exact:true}),href=await link.getAttribute('href'),f=await frame(page);await Promise.all([f.waitForURL(new URL(href,origin).href),link.click()]);await f.waitForLoadState('domcontentloaded');await f.locator('body').waitFor();return f;}
async function unlock(page){await page.goto(origin);await page.getByLabel('Temporary preview code').fill(code);const sent=page.waitForRequest(r=>new URL(r.url()).pathname==='/__preview/unlock'&&r.method()==='POST');await page.getByRole('button',{name:'Open private preview'}).click();const h=await(await sent).allHeaders();report.unlockOrigin={origin:h.origin,fetchSite:h['sec-fetch-site']};await page.locator('iframe').waitFor();await(await frame(page)).locator('[data-founder-plane=school]').waitFor();}
async function switchProfile(page,p){await page.getByLabel('Preview identity').selectOption(p);await page.getByRole('button',{name:'Reset private view & switch'}).click();await page.locator('iframe').waitFor();await(await frame(page)).locator('body').waitFor();}
async function confirm(f,name){const count=await f.getByTestId('receipt').count();await f.getByTestId('confirm').check();await f.getByTestId(name).click();await f.waitForFunction(n=>document.querySelectorAll('[data-testid=receipt]').length===n+1,count);}
async function refresh(f){await f.getByTestId('refresh').click();await f.waitForFunction(()=>!document.querySelector('[data-testid=refresh]').disabled);}
try {
 app=spawn(process.execPath,['apps/web/scripts/private-preview/start.mjs'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,HON_PRIVATE_PREVIEW_LOCAL:'1'},stdio:['ignore','pipe','pipe']});
 app.stdout.on('data',b=>{stdout=(stdout+b).slice(-10000);code=/Temporary preview access code \(keep in your terminal\): ([A-Za-z0-9_-]+)/.exec(stdout)?.[1];});
 let startupError='';app.stderr.on('data',b=>startupError=(startupError+b).slice(-500));
 for(let i=0;i<150&&!code&&app.exitCode===null;i++)await new Promise(r=>setTimeout(r,200));assert(code,'Guarded launcher failed: '+startupError);
 assert.equal((await fetch(origin+'/api/v1/hq/overview')).status,401);assert.equal((await fetch(origin+'/staff/founder-setup')).status,401);
 assert.equal((await fetch('http://127.0.0.1:3001/v1/hq/overview')).status,401);
 assert.equal((await fetch('http://127.0.0.1:3001/v1/hq/overview',{headers:{Cookie:'hon_session=forged'}})).status,401);
 assert.equal((await fetch(origin+'/__preview/unlock',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code})})).status,403);
 report.checks.push('Anonymous local requests cannot render protected app or API; separate owner GitHub signed-out test still required');
 browser=await chromium.launch({executablePath:process.env.HON_PREVIEW_CHROME,headless:true,args:['--no-sandbox']});
 for(const width of [390,834,1440]) {
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route(url=>url.origin!==origin,route=>{report.blockedExternalRequests++;return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await unlock(page);
  assert.equal((await context.request.post(origin+'/__preview/switch',{headers:{Origin:origin},form:{profile:'hq',csrf:'forged'}})).status(),403);
  for(const language of ['en','ko','es']) {
   let f=await frame(page);const utility=f.locator('[data-locale-utility] select');await utility.waitFor();await utility.selectOption(language);await f.waitForFunction(lang=>document.documentElement.lang===lang,language);
   const guide=f.locator('[data-founder-plane=school]');
   for(const mode of ['modern','classic','big-button']) {
    await guide.getByRole('button',{name:t(language,mode),exact:true}).click();
    for(let n=0;n<8;n++){await guide.getByRole('navigation',{name:t(language,'steps')}).getByRole('button',{name:new RegExp(t(language,`step${n}Title`).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).focus();await page.keyboard.press('Enter');await f.waitForFunction(title=>document.querySelector('[data-founder-stage-status]')?.textContent.includes(title),t(language,`step${n}Title`));}
   }
   await guide.getByRole('button',{name:t(language,'load'),exact:true}).click();await f.getByText('SYNTHETIC Sunrise Taekwondo',{exact:true}).first().waitFor();await capture(page,`${language}-${width}-founder`);await scan(f,`${language}-${width}-founder`);
   f=await navigate(page,'Connected CRM journey');await f.getByTestId('load').click();await f.getByTestId('lead-select').waitFor();await f.getByTestId('mode').selectOption(width===390?'big':width===834?'classic':'modern');await capture(page,`${language}-${width}-crm`);await scan(f,`${language}-${width}-crm`);
   // Presentation/language navigation never changes fixture authority; fresh read remains explicit.
   f=await navigate(page,'Founder Setup');await f.locator('[data-founder-plane=school]').waitFor();
   report.checks.push(`${language}/${width}: actual Founder eight stages x three modes, native keyboard/live status, explicit synthetic read, actual CRM journey, no horizontal overflow`);
  }
  let f=await navigate(page,'Owner dashboard');await f.locator('[data-interface-theme]').waitFor();await f.getByText('Current verified school',{exact:true}).waitFor();await capture(page,`${width}-owner-dashboard`);
  f=await navigate(page,'HON team');await f.getByRole('heading').first().waitFor();await capture(page,`${width}-hon-team`);
  const cookies=await context.cookies(),oldCookie=cookies.map(c=>`${c.name}=${c.value}`).join('; ');
  // Hold a consequential body open across the actual role switch. It must be rejected,
  // not rebound to the new profile, even for a selector-free endpoint.
  let finishBody;const pending=new Promise((done,reject)=>{const r=httpRequest(origin+'/api/v1/staff/crm/follow-ups',{method:'POST',headers:{...bodyHeaders,Cookie:oldCookie,'Transfer-Encoding':'chunked','X-HON-Human-Command':'crm-follow-ups','Idempotency-Key':'00000000-0000-4000-8000-000000000850'}},s=>{s.resume();s.on('end',()=>done(s.statusCode));});r.on('error',reject);r.write('{');finishBody=()=>r.end('"expectedVersion":0,"leadId":"00000000-0000-4000-8000-000000000010","assigneeId":"00000000-0000-4000-8000-000000000900","subject":"Synthetic late command","note":"","dueAt":null,"priority":"NORMAL"}');});
  await switchProfile(page,'schoolB');finishBody();assert.equal(await pending,401);f=await frame(page);await f.locator('[data-founder-plane=school]').waitFor();
  // A stale browser request retains the old immutable cookie, never the newly selected school's token.
  assert.equal((await fetch(origin+'/api/v1/owner-launch',{headers:{Cookie:oldCookie}})).status,401);
  assert.equal((await context.request.get(origin+'/api/v1/organizations/00000000-0000-4000-8000-000000000001/schools/00000000-0000-4000-8000-000000000002/crm/leads?limit=50')).status(),403);
  const currentLanguage=await f.evaluate(()=>document.documentElement.lang);await f.locator('[data-founder-plane=school]').getByRole('button',{name:t(currentLanguage,'load'),exact:true}).click();
  await f.getByText('SYNTHETIC Riverside Martial Arts',{exact:true}).first().waitFor();assert.equal(await f.getByText('SYNTHETIC Sunrise Taekwondo',{exact:true}).count(),0);
  assert.equal((await context.request.get(origin+'/api/v1/hq/overview')).status(),403);
  await switchProfile(page,'hq');await(await frame(page)).locator('main').first().waitFor();await capture(page,`${width}-hq-dashboard`);
  f=await navigate(page,'Founder readiness');await f.locator('[data-founder-plane=hq]').waitFor();await capture(page,`${width}-hq-founder`);await scan(f,`${width}-hq-founder`);
  f=await navigate(page,'School directory');await f.getByRole('heading').first().waitFor();await capture(page,`${width}-hq-directory`);
  assert.equal((await context.request.get(origin+'/api/v1/owner-launch')).status(),403);
  assert.equal((await context.request.post(origin+'/api/v1/hq/saas/offers',{headers:bodyHeaders,data:{}})).status(),403);
  report.checks.push(`${width}: signed fixture identities, School A/B isolation, old session revocation, separate HQ authority, real HQ navigation, financial write refused`);
  await page.getByRole('button',{name:'Lock preview and clear this view'}).click();await page.getByLabel('Temporary preview code').waitFor();assert.equal((await context.request.get(origin+'/api/v1/hq/schools')).status(),401);await context.close();
 }
 // Execute one complete connected journey through the persistent gateway, not a scripted mock response interceptor.
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});await context.route(url=>url.origin!==origin,r=>{report.blockedExternalRequests++;return r.abort();});const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('request',async r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/v1/')){const h=await r.allHeaders();report.mutationOrigins.push({path:new URL(r.url()).pathname,origin:h.origin,fetchSite:h['sec-fetch-site']});}});await unlock(page);
 let f=await navigate(page,'Connected CRM journey');await f.getByTestId('load').click();await f.getByTestId('lead-select').waitFor();
 await f.getByTestId('step-follow').click();await f.getByTestId('verify-follow').click();await f.getByTestId('subject').fill('Synthetic owner walkthrough');await confirm(f,'save-follow');await refresh(f);
 await f.getByTestId('step-trial').click();await f.getByTestId('start').fill(new Date(Date.now()+86400000).toISOString().slice(0,16));await f.getByTestId('end').fill(new Date(Date.now()+90000000).toISOString().slice(0,16));await confirm(f,'save-trial');await refresh(f);
 await f.getByTestId('step-outcome').click();await f.getByTestId('outcome').selectOption('COMPLETED');await confirm(f,'save-outcome');await refresh(f);
 await f.getByTestId('step-close').click();await confirm(f,'save-close');await refresh(f);
 await f.getByTestId('step-register').click();await f.getByTestId('verify-registration').click();await f.getByTestId('registration-path').selectOption('ADULT');await f.getByTestId('birth').fill('1990-01-02');await confirm(f,'save-registration');await capture(page,'complete-synthetic-journey');
 await page.getByRole('link',{name:'Founder Setup',exact:true}).click();await(await frame(page)).locator('[data-founder-plane=school]').waitFor();
 await page.getByRole('button',{name:'Reset private view & switch'}).focus();await page.keyboard.press('Tab');assert(await page.evaluate(()=>Boolean(document.activeElement?.matches(':focus-visible'))));
 report.checks.push('Five explicitly confirmed synthetic journey commands through actual Next transports; refresh barriers and real frontend receipts; no membership/payment/provider effect');
 await context.close();assert.deepEqual(report.pageErrors,[]);console.log(`PASS owner preview: ${report.checks.length} groups, ${report.accessibility.length} zero-violation axe scans, ${report.screenshots.length} screenshots; no Codespaces gateway claim`);
}catch(e){report.failure={name:e.name,message:e.message};console.error(e);process.exitCode=1;if(browser)for(const c of browser.contexts())for(const p of c.pages())await p.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await writeFile(join(out,'owner-preview-report.json'),JSON.stringify(report,null,2));await browser?.close();app?.kill('SIGTERM');}
