/** Actual Next app and signed synthetic sessions; presentation-only proof, no pricing backend simulation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, validateMyLanguagePreferenceView } from '@hon/contracts';
import { translate } from '@hon/design-system';
import {createOfferFixtures} from './fixtures/hq-offers.mjs';
import {SAAS_COMMANDS} from '@hon/contracts';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert(!process.env[key], 'No database/provider credentials allowed.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), tools = process.env.HON_HQ_BROWSER_TOOLS, results = process.env.HON_HQ_BROWSER_RESULTS;
assert(tools && results && process.env.HON_HQ_CHROME_BIN);
const requireTools = createRequire(join(tools, 'runner.cjs')), requireWeb = createRequire(join(root, 'package.json'));
const { chromium } = requireTools('playwright-core'), axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, fixtureOnly: true, pricingBackendConnected: 'SYNTHETIC_CONTRACT_FIXTURE', financialActions: false, checks: [], failures: [], screenshots: [], accessibility: [], requests: [], pageErrors: [], koreanFonts: [], hitTests: [] };
const session = { mode: 'OIDC', audience: 'hon-pricing-ux-synthetic', secret: randomBytes(32).toString('hex') };
const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise(done => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const overview = role => ({ asOf: '2026-10-23T12:00:00.000Z', callerHqRole: role, organizationCount: 0, schoolCount: 0, onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } });
const fixtures=new Map(),roles=new Map();
const commandMarkers={create:SAAS_COMMANDS.createOfferSetDraft,revise:SAAS_COMMANDS.reviseOfferSetDraft,discard:SAAS_COMMANDS.discardOfferSetDraft,publish:SAAS_COMMANDS.publishOfferSet,stop:SAAS_COMMANDS.stopOfferSales};
const api=createServer(async(req,res)=>{
  report.requests.push({method:req.method,path:req.url});
  const send=(status,data,error=false)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify(error?{code:data}:{data}));};
  try{
    let subject;try{subject=verifySession(cookieValue(req.headers.cookie,HON_SESSION_COOKIE)??'',session).externalSubject;}catch{send(401,'UNAUTHORIZED',true);return;}
    if(req.url==='/v1/identity/me'&&req.method==='GET'){send(200,{externalSubject:subject});return;}
    const language=subject.split('-').at(-1),lang=['en','ko','es'].includes(language)?language:'en';
    if(req.url==='/v1/me/language-preference'&&req.method==='GET'){send(200,validateMyLanguagePreferenceView({preference:{language:lang,version:1,updatedAt:'2026-10-23T12:00:00.000Z'},schoolDefault:null,effective:{language:lang,source:'PERSONAL'},supportedLanguages:['en','ko','es']}));return;}
    const role=roles.get(subject)??(/^pricing-owner-/.test(subject)?'owner':/^pricing-operator-/.test(subject)?'operator':'denied');
    if(role==='denied'){send(403,'SAAS_FORBIDDEN',true);return;}
    if(req.url==='/v1/hq/overview'&&req.method==='GET'){send(200,{overview:overview(role==='owner'?'OWNER':'OPERATOR')});return;}
    const f=fixtures.get(subject);if(!f){send(404,'SAAS_UNAVAILABLE',true);return;}
    if(req.method==='GET'){
      if(req.url==='/v1/hq/saas/offers')send(200,f.management());
      else if(/^\/v1\/hq\/saas\/offers\/sets\/[a-f0-9-]+$/.test(req.url))send(200,f.detail(req.url.split('/').at(-1)));
      else send(404,'SAAS_UNAVAILABLE',true);return;
    }
    if(role!=='owner'){send(403,'SAAS_FORBIDDEN',true);return;}
    let kind,target=null;
    if(req.url==='/v1/hq/saas/offers/sets')kind='create';
    else if(/^\/v1\/hq\/saas\/offers\/sets\/[a-f0-9-]+\/(revise|publish|discard)$/.test(req.url)){kind=req.url.split('/').at(-1);target=req.url.split('/').at(-2);}
    else if(/^\/v1\/hq\/saas\/offers\/[a-f0-9-]+\/stop-sales$/.test(req.url)){kind='stop';target=req.url.split('/').at(-2);}
    if(!kind||req.method!=='POST'){send(405,'INVALID_SAAS_INPUT',true);return;}
    if(req.headers['x-hon-human-command']!==commandMarkers[kind]||!req.headers['idempotency-key']){send(403,'HUMAN_UI_REQUIRED',true);return;}
    let text='';for await(const chunk of req){text+=chunk;if(text.length>100000)throw Error('oversized');}
    send(200,f.command(kind,target,JSON.parse(text),req.headers['idempotency-key'],subject));
  }catch(e){send(e.status??400,e.code??'INVALID_SAAS_INPUT',true);}
});
await new Promise(done=>api.listen(3001,'127.0.0.1',done));
const app=spawn(process.execPath,[requireWeb.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,
  env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',HON_API_BASE_URL:'http://127.0.0.1:3001',HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret},stdio:['ignore','pipe','pipe']});
let log='';app.stdout.on('data',d=>{log+=d;});app.stderr.on('data',d=>{log+=d;});let browser;
async function check(name,work){try{await work();report.checks.push(name);console.log('PASS '+name);}catch(e){report.failures.push({name,message:e.message});console.error('FAIL '+name+': '+e.stack);}}
const token=subject=>({name:HON_SESSION_COOKIE,value:issueSession({externalSubject:subject},session),url:origin,httpOnly:true,sameSite:'Lax'});
async function open(viewport,language='en',role='owner'){
  const subject=`pricing-${role}-${language}`;fixtures.set(subject,createOfferFixtures());roles.delete(subject);
  const context=await browser.newContext({viewport,reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await context.routeWebSocket('**/*',s=>s.close());
  if(role)await context.addCookies([token(subject)]);const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin+'/hq/pricing-offers');
  if(['owner','operator'].includes(role)){await page.locator(`html[lang=${language}] [data-pricing-design]`).waitFor();await page.getByRole('heading',{name:translate(language,'pricing.op.manage'),exact:true}).waitFor();await page.getByRole('button',{name:translate(language,'pricing.op.newSet'),exact:true}).waitFor();await idle(page);}
  return{context,page,subject,fixture:fixtures.get(subject)};
}
const idle=page=>page.waitForFunction(()=>document.querySelector('[data-pricing-design]')?.getAttribute('data-pricing-busy')==='false');
async function capture(page, name, { fullPage = true, resetScroll = true } = {}) {
  await page.evaluate(async reset => { await document.fonts.ready; if (reset) window.scrollTo(0, 0); }, resetScroll);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
  await page.addScriptTag({ content: axe });
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const violations = result.violations.map(v => ({ id: v.id, impact: v.impact })); report.accessibility.push({ name, violations }); assert.equal(violations.length, 0, JSON.stringify(violations));
  await page.screenshot({ path: join(results, name + '.png'), fullPage, animations: 'disabled' }); report.screenshots.push(name + '.png');
}
// A loaded CSS font name is not enough: inspect the font Chrome actually used for Hangul glyphs.
async function verifyKoreanFont(page, size) {
  await page.evaluate(() => document.fonts.ready);
  const heading = page.locator('[data-pricing-design] section h2').first();
  assert(/[가-힣]/u.test(await heading.innerText()), 'Actual translated heading must contain Hangul');
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-pricing-design] section h2' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    report.koreanFonts.push({ size, fonts });
    assert(fonts.some(font => /Noto Sans (CJK KR|KR)/i.test(font.familyName) && font.glyphCount > 0), 'Chrome must render real Korean glyphs with the provisioned fallback');
    console.log('KOREAN_FONT ' + JSON.stringify({ size, fonts }));
  } finally { await cdp.detach(); }
}
async function hitTest(page, locator, name) {
  const result = await locator.evaluate(element => {
    const r = element.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { visible: r.top >= 0 && r.bottom <= (window.visualViewport?.height ?? innerHeight), reachable: element.contains(document.elementFromPoint(x, y)), width: r.width, height: r.height };
  });
  report.hitTests.push({ name, ...result });
  assert(result.visible && result.reachable, `${name} obscured or outside the viewport: ${JSON.stringify(result)}`);
  assert(result.width >= 44 && result.height >= 44, `${name} touch target too small`);
}
try{
  let started=false;for(let i=0;i<100;i++){try{await fetch(origin);started=true;break;}catch{}await new Promise(done=>setTimeout(done,250));}assert(started,log.slice(-1200));
  browser=await chromium.launch({executablePath:process.env.HON_HQ_CHROME_BIN,headless:true});
  for(const language of ['en','ko','es'])for(const[size,viewport]of[['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])await check(`${language}/${size}: whole-set save, local preservation, digest publication, immutable history, sales stop, disabled checkout and axe`,async()=>{
    const {context,page,fixture}=await open(viewport,language);const tx=key=>translate(language,key),op=key=>tx('pricing.op.'+key),ui=page.locator('[data-pricing-design]');
    const button=key=>ui.getByRole('button',{name:op(key),exact:true});
    try{
      await page.getByRole('heading',{name:op('drafts'),exact:true}).waitFor();
      if(language==='ko')await verifyKoreanFont(page,size);
      if(size==='mobile')for(const key of ['overview','editor','preview','history'])await hitTest(page,ui.getByRole('button',{name:tx('pricing.'+key),exact:true}),`${language}/${size}/${key}/initial`);
      await capture(page,`${language}-${size}-offers-overview`);if(size==='mobile')await capture(page,`${language}-${size}-offers-overview-viewport`,{fullPage:false});
      await button('open').nth(1).click();const amount=page.getByLabel(op('price'),{exact:true});await amount.waitFor();await amount.fill('321.45');
      await page.locator('#offer-select').selectOption({index:1});await page.locator('#offer-select').selectOption({index:0});assert.equal(await amount.inputValue(),'321.45');
      await button('newSet').click();const dialog=page.getByRole('dialog');await dialog.waitFor();const continueButton=dialog.getByRole('button',{name:tx('pricing.continue-editing'),exact:true});
      assert(await continueButton.evaluate(e=>e===document.activeElement));await page.keyboard.press('Tab');assert(await dialog.evaluate(e=>e.contains(document.activeElement)));await page.keyboard.press('Shift+Tab');assert(await continueButton.evaluate(e=>e===document.activeElement));
      await capture(page,`${language}-${size}-offers-unsaved-dialog`,{resetScroll:false});await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await amount.inputValue(),'321.45');
      await button('newSet').click();await dialog.getByRole('button',{name:tx('pricing.save-local'),exact:true}).click();await ui.getByRole('heading',{name:op('localCopies'),exact:true}).waitFor();
      await ui.getByRole('button',{name:translate(language,'pricing.op.restoreLocal',{number:'1'}),exact:true}).click();await amount.waitFor();assert.equal(await amount.inputValue(),'321.45');
      await button('save').click();await ui.getByRole('heading',{name:op('receipt'),exact:true}).waitFor();await idle(page);assert.equal(fixture.detail(fixture.draftId).set.revision,2);assert.equal(fixture.detail(fixture.draftId).set.offers.length,6);
      await capture(page,`${language}-${size}-offers-saved-draft`);
      await button('review').click();const review=ui.locator('[data-publication-review]');await review.waitFor();await review.getByRole('checkbox').check();
      await capture(page,`${language}-${size}-offers-server-review`);await button('publish').click();await dialog.waitFor();assert.equal(fixture.management().published.setId,fixture.originalId,'No publication before explicit final confirmation');
      await dialog.getByRole('button',{name:op('confirm'),exact:true}).click();await idle(page);await page.waitForFunction(()=>document.querySelector('[data-publication-review]')===null);
      assert.equal(fixture.management().published.setId,fixture.draftId);assert.equal(fixture.detail(fixture.originalId).set.status,'RETIRED');assert(await amount.isDisabled());
      await capture(page,`${language}-${size}-offers-published-receipt`);
      await ui.getByRole('button',{name:tx('pricing.preview'),exact:true}).click();await ui.locator('[data-customer-pricing-preview]').waitFor();const preview=ui.locator('[data-customer-pricing-preview]');assert.equal(await preview.locator('article').count(),3);assert.equal(await preview.getByRole('button',{disabled:true}).count(),3);assert(!(await preview.innerText()).includes('183.00'));await capture(page,`${language}-${size}-offers-published-customer-preview`);
      await ui.getByRole('button',{name:tx('pricing.editor'),exact:true}).click();const annual=ui.getByRole('button',{name:op('stop')+' · '+tx('pricing.annual'),exact:true});await annual.click();await dialog.waitFor();await dialog.getByRole('combobox').selectOption('TERMS_REVIEW');await dialog.getByRole('button',{name:op('confirm'),exact:true}).click();await idle(page);assert(fixture.detail(fixture.draftId).set.offers.find(o=>o.offerKind==='REGULAR_ANNUAL').salesStop);await capture(page,`${language}-${size}-offers-sales-stopped`);
      await ui.getByRole('button',{name:tx('pricing.history'),exact:true}).click();await ui.getByText(op('historyNote'),{exact:true}).waitFor();await capture(page,`${language}-${size}-offers-history`);
      for(const mode of ['Big Button','Modern','Classic']){await page.getByRole('group',{name:tx('Platform view'),exact:true}).getByRole('button',{name:tx(mode),exact:true}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
      await page.reload();await ui.getByRole('heading',{name:op('drafts'),exact:true}).waitFor();assert.equal(fixture.management().published.setId,fixture.draftId,'Verified fixture backend survives page reload; no browser storage needed');
    }finally{await context.close();}
  });
  await check('Unknown save after server commit: concealment, settled busy state, exact explicit retry, duplicate prevention, session expiration',async()=>{
    const {context,page,subject,fixture}=await open({width:390,height:844});const ui=page.locator('[data-pricing-design]'),op=key=>translate('en','pricing.op.'+key);
    try{
      await ui.getByRole('button',{name:op('open'),exact:true}).nth(1).click();await page.getByLabel(op('price'),{exact:true}).fill('333.33');
      let released,arrived;const hold=new Promise(done=>{released=done;}),received=new Promise(done=>{arrived=done;});let originalBody,originalKey,calls=0;
      await page.route('**/api/v1/hq/saas/offers/sets/*/revise',async route=>{calls++;if(calls===1){originalBody=route.request().postData();originalKey=route.request().headers()['idempotency-key'];await route.fetch();arrived();await hold;await route.abort();}else{assert.equal(route.request().postData(),originalBody);assert.equal(route.request().headers()['idempotency-key'],originalKey);await route.continue();}});
      await ui.getByRole('button',{name:op('save'),exact:true}).dblclick();await received;await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.locator('[data-pricing-concealed]').waitFor();
      assert(await ui.getByRole('button',{name:op('verify'),exact:true}).isDisabled());assert.equal(await page.getByLabel(op('price'),{exact:true}).count(),0);released();await idle(page);
      assert.equal(calls,1);await capture(page,'privacy-mobile-unknown-result');await ui.getByRole('button',{name:op('verify'),exact:true}).click();await ui.getByRole('button',{name:op('retry'),exact:true}).waitFor();assert.equal(calls,1,'Restoration must not resend');
      await ui.getByRole('button',{name:op('retry'),exact:true}).click();await idle(page);await ui.getByRole('heading',{name:op('receipt'),exact:true}).waitFor();assert.equal(calls,2);assert.equal(fixture.mutations,1);await capture(page,'privacy-mobile-exact-retry-receipt');
      await context.clearCookies();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await ui.getByRole('button',{name:op('verify'),exact:true}).click();await ui.getByRole('link',{name:op('signin'),exact:true}).waitFor();assert.equal(await page.getByLabel(op('price'),{exact:true}).count(),0);await capture(page,'privacy-mobile-session-expired');
      await context.addCookies([token(subject)]);await ui.getByRole('button',{name:op('verify'),exact:true}).click();await page.getByLabel(op('price'),{exact:true}).waitFor();
    }finally{await context.close();}
  });
  await check('Operator read-only, school denied, signed-out redirect and narrow multilingual navigation',async()=>{
    const operator=await open({width:390,height:844},'ko','operator');try{const ui=operator.page.locator('[data-pricing-design]');assert(await ui.getByRole('button',{name:translate('ko','pricing.op.newSet'),exact:true}).isDisabled());await ui.getByRole('button',{name:translate('ko','pricing.op.open'),exact:true}).nth(1).click();await operator.page.getByLabel(translate('ko','pricing.op.price'),{exact:true}).waitFor();assert(await operator.page.getByLabel(translate('ko','pricing.op.price'),{exact:true}).isDisabled());await capture(operator.page,'ko-mobile-operator-read-only');}finally{await operator.context.close();}
    for(const width of [320,390]){const x=await open({width,height:740},'ko');try{for(const mode of ['Big Button','Modern','Classic']){await x.page.getByRole('group',{name:translate('ko','Platform view'),exact:true}).getByRole('button',{name:translate('ko',mode),exact:true}).click();for(const tab of ['overview','editor','preview','history']){const control=x.page.locator('[data-pricing-design]').getByRole('button',{name:translate('ko','pricing.'+tab),exact:true});await control.scrollIntoViewIfNeeded();await control.focus();await hitTest(x.page,control,`ko/${width}/${mode}/${tab}`);}}}finally{await x.context.close();}}
    const denied=await open({width:390,height:844},'en','school');try{await denied.page.getByText('HQ access denied',{exact:true}).waitFor();assert.equal(await denied.page.locator('[data-pricing-design]').count(),0);}finally{await denied.context.close();}
    const absent=await open({width:390,height:844},'en',null);try{assert(new URL(absent.page.url()).pathname.startsWith('/auth/'));}finally{await absent.context.close();}
  });
  assert(!report.requests.some(r=>/checkout|payments|credits|subscriptions/.test(r.path)),'No financial activation or unmerged purchase endpoint');
  assert.equal(report.pageErrors.length,0,JSON.stringify(report.pageErrors));assert.equal(report.failures.length,0,JSON.stringify(report.failures));
}catch(e){console.error(e.stack??e);process.exitCode=1;}
finally{await browser?.close();app.kill('SIGTERM');await new Promise(done=>api.close(done));await writeFile(join(results,'pricing-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks.length,screenshots:report.screenshots.length,axeScans:report.accessibility.length,failures:report.failures.length,jsErrors:report.pageErrors.length,pricingBackend:'SYNTHETIC_CONTRACT_FIXTURE'}));}
