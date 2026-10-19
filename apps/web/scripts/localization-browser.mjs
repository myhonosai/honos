/** Exercises only the real UI with deterministic signed localhost principals. No real provider or DB. */
import assert from 'node:assert/strict';
import { issueSession,HON_SESSION_COOKIE } from '@hon/auth';
import { DEFAULT_LOCALE,translate,formatLocaleMoney } from '@hon/design-system';
export async function verifyLocalization(e) {
 const {check,context,open,ready,scan,capture,overflow,reset,setFixture,setReadMode,report,origin,session,commandCount}=e;
 const tx=(lang,key,params)=>translate(lang,key,params);
 const utility=p=>p.locator('[data-locale-utility]');
 const choose=async(p,lang)=>{await utility(p).getByRole('combobox').selectOption(lang);await p.waitForFunction(l=>document.documentElement.lang===l,lang);};
 const controls=(p)=>p.locator('main');
 report.localization={languages:['en','ko','es'],persistence:'ACCOUNT_SEPARATED_BROWSER_COOKIE_ONLY',crossDeviceSync:false,schoolDefault:false,customerContentTranslated:false};
 for(const lang of ['en','ko','es'])for(const [size,viewport]of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  await check(`${lang}/${size}: real translated settings, independent formatting, persistence and keyboard`,async()=>{
   reset();const ctx=await context(viewport);try{
    const p=await open(ctx,'/settings/language-region');await choose(p,lang);
    const main=controls(p);await main.getByRole('heading',{name:tx(lang,'Language & Region'),exact:true}).waitFor();
    for(const native of ['English','한국어','Español'])assert(await main.getByRole('option',{name:native,exact:true}).count()>0);
    await main.getByRole('button',{name:tx(lang,'Classic'),exact:true}).click();
    await main.getByLabel(tx(lang,'Number and date region'),{exact:true}).selectOption('ko-KR');
    await main.getByLabel(tx(lang,'Currency formatting'),{exact:true}).selectOption('code');
    await main.getByLabel(tx(lang,'Display timezone'),{exact:true}).selectOption('Asia/Seoul');
    await main.getByRole('combobox',{name:tx(lang,'Display language'),exact:true}).selectOption(lang==='en'?'es':'en');
    const next=lang==='en'?'es':'en';await p.waitForFunction(l=>document.documentElement.lang===l,next);
    assert.equal(await main.getByRole('button',{name:tx(next,'Classic'),exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await p.locator('#settings-region').inputValue(),'ko-KR');assert.equal(await p.locator('#settings-currency').inputValue(),'code');assert.equal(await p.locator('#settings-timezone').inputValue(),'Asia/Seoul');
    await choose(p,lang);await p.reload();await main.getByRole('heading',{name:tx(lang,'Language & Region'),exact:true}).waitFor();
    assert.equal(await p.locator('#settings-timezone').inputValue(),'Asia/Seoul');
    await main.getByLabel(tx(lang,'Number and date region'),{exact:true}).selectOption('auto');await main.getByLabel(tx(lang,'Currency formatting'),{exact:true}).selectOption('symbol');await main.getByLabel(tx(lang,'Display timezone'),{exact:true}).selectOption('UTC');
    const select=main.getByRole('combobox',{name:tx(lang,'Display language'),exact:true});await select.focus();assert(await select.evaluate(el=>el===document.activeElement));await p.keyboard.press('Tab');
    await main.getByText(tx(lang,'Saved for this account in this browser.'),{exact:true}).waitFor();
    await overflow(p);await scan(p,`${lang}-${size}-settings`);await capture(p,`${lang}-${size}-settings`);
    const preference=(await ctx.cookies()).filter(c=>c.name.startsWith('hon_locale_v1_'));assert.equal(preference.length,1);assert(!preference[0].name.includes('school-owner'));assert.equal(preference[0].sameSite,'Lax');assert(preference[0].expires>Date.now()/1000+86400);assert(!decodeURIComponent(preference[0].value).includes('interfaceTheme'));
   }finally{await ctx.close();}
  });
  await check(`${lang}/${size}: translated Core/Complete review, HON, confirmation and verified payment without access grant`,async()=>{
   reset();const ctx=await context(viewport);try{
    const p=await open(ctx);await ready(p);await p.getByRole('button',{name:'Classic',exact:true}).click();await choose(p,lang);
    assert.equal(await p.locator('main[data-view]').getAttribute('data-view'),'classic');
    await p.getByRole('heading',{name:tx(lang,'Built for the way you run your school.'),exact:true}).waitFor();
    assert.equal(await p.getByText(tx(lang,'Scheduling, memberships & curriculum'),{exact:true}).count(),1);
    const notice=p.getByRole('note');if(size==='desktop'){const strong=await notice.locator('strong').boundingBox(),body=await notice.locator('span').first().boundingBox();assert(strong.x+strong.width<=body.x,'Translated notice label must not overlap its body');}
    if(size==='mobile')assert((await p.getByRole('button',{name:tx(lang,'HON plan guide'),exact:true}).boundingBox()).width<120,'Mobile HON guide must stay compact');
    for(const tier of ['Core','Complete'])assert(await p.getByRole('heading',{name:'HON '+tier,exact:true}).isVisible());
    const plan=p.getByRole('group',{name:tx(lang,'Compare and select a HON plan')});assert(await plan.getByText(formatLocaleMoney({...DEFAULT_LOCALE,language:lang},14900,'USD'),{exact:true}).count()>0);
    await p.getByRole('button',{name:tx(lang,'Review selection →'),exact:true}).click();
    const start=p.getByRole('button',{name:tx(lang,'Start secure test checkout'),exact:true});assert(await start.isDisabled());
    await p.getByRole('checkbox').check();const before=report.commandCount;await choose(p,lang==='ko'?'es':'ko');await choose(p,lang);assert(await p.getByRole('checkbox').isChecked());assert.equal(report.commandCount,before);assert.equal(await p.locator('main[data-view]').getAttribute('data-view'),'classic');
    for(const mode of ['Big Button','Modern','Classic']){await p.getByRole('button',{name:tx(lang,mode),exact:true}).click();await overflow(p);}
    const guide=p.getByRole('button',{name:tx(lang,'HON plan guide'),exact:true});await guide.click();await p.getByRole('button',{name:tx(lang,'Does payment activate access?'),exact:true}).click();assert(await p.getByText(tx(lang,'A return from checkout is not proof of payment. HON reloads backend payment evidence, and account activation is confirmed separately. Verified test payment can still show Pending Account Activation. This page never grants or changes features.'),{exact:true}).isVisible());await p.keyboard.press('Escape');
    await p.getByRole('button',{name:tx(lang,'Modern'),exact:true}).click();await p.getByText(tx(lang,'Scheduling, memberships & curriculum'),{exact:true}).waitFor({state:'visible'});await scan(p,`${lang}-${size}-review`);await capture(p,`${lang}-${size}-subscription`);
    await start.click();await p.getByText(tx(lang,'Checkout open — payment pending'),{exact:true}).waitFor();assert.equal(report.commandCount-before,1);
    setFixture({state:'paid'});await p.goto(`${origin}/schools/not-authority/hon-plan?result=success&language=fr`);
    await p.getByRole('heading',{name:tx(lang,'Pending Account Activation'),exact:true}).waitFor();assert.equal(await p.locator('html').getAttribute('lang'),lang);
    await overflow(p);await scan(p,`${lang}-${size}-paid`);await capture(p,`${lang}-${size}-paid`,false);
    const changed=(await ctx.cookies()).find(c=>c.name.startsWith('hon_locale_v1_'));
    const fresh=await context(viewport);try{await fresh.addCookies([changed]);await fresh.addCookies([{name:HON_SESSION_COOKIE,value:issueSession({externalSubject:'school-owner-synthetic'},session,Math.floor(Date.now()/1000)-60),url:origin,httpOnly:true,sameSite:'Lax'}]);const again=await open(fresh);assert.equal(await again.locator('html').getAttribute('lang'),lang);}finally{await fresh.close();}
   }finally{await ctx.close();}
  });
  await check(`${lang}/${size}: authorized HQ navigation and appearance independence`,async()=>{
   reset();const ctx=await context(viewport,'hq-localization-synthetic');try{
    const p=await open(ctx,'/hq');await p.getByRole('heading',{name:'Your company. In command.',exact:true}).waitFor();await p.locator('[data-hq-conversation-dock]').waitFor({state:'attached'});await choose(p,lang);
    await p.getByRole('heading',{name:tx(lang,'Your company. In command.'),exact:true}).waitFor();assert(await p.getByRole('heading',{name:tx(lang,'Organizations'),exact:true}).isVisible());
    await p.getByRole('group',{name:tx(lang,'Platform view')}).getByRole('button',{name:tx(lang,'Big Button'),exact:true}).click();await p.getByRole('group',{name:tx(lang,'AI portrait style')}).getByRole('button',{name:tx(lang,'Chibi'),exact:true}).click();
    await choose(p,lang==='es'?'ko':'es');await choose(p,lang);assert.equal(await p.locator('[data-art]').getAttribute('data-art'),'chibi');assert.equal(await p.locator('[data-art]').getAttribute('data-view'),'big-button');
    await p.getByRole('button',{name:tx(lang,'Expand HON conversation'),exact:true}).click();await p.getByRole('heading',{name:tx(lang,'How can HON help here?'),exact:true}).waitFor();assert(await p.getByText(tx(lang,'HQ conversation is not connected yet. Your company tools remain available.'),{exact:true}).isVisible());
    await p.keyboard.press('Escape');await p.getByRole('group',{name:tx(lang,'Platform view')}).getByRole('button',{name:tx(lang,'Modern'),exact:true}).click();await p.getByRole('group',{name:tx(lang,'AI portrait style')}).getByRole('button',{name:tx(lang,'Realistic'),exact:true}).click();
    if(size==='mobile'){for(const width of [320,390]){await p.setViewportSize({width,height:844});for(const label of ['Platform view','AI portrait style']){const group=p.getByRole('group',{name:tx(lang,label)}),caption=group.locator(':scope > span'),box=await caption.boundingBox(),first=await group.getByRole('button').first().boundingBox();assert(box.x+box.width<=first.x,'Appearance label must not overlap its choices');assert(await caption.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Appearance label must wrap inside its column');}await overflow(p);}}
    await overflow(p);await scan(p,`${lang}-${size}-hq`);await capture(p,`${lang}-${size}-hq`,false);
   }finally{await ctx.close();}
  });
 }
 await check('Changing language never grants a school purchaser HQ authority',async()=>{reset();const ctx=await context();try{const p=await open(ctx,'/settings/language-region');await choose(p,'ko');await p.goto(origin+'/hq');await p.getByText(tx('ko','HQ access denied'),{exact:true}).waitFor();assert.equal(await p.getByRole('heading',{name:tx('ko','Your executive team')}).count(),0);assert.equal(commandCount(),0);}finally{await ctx.close();}});
 await check('Per-user browser preferences are isolated; another device has English default',async()=>{
  reset();const ctx=await context();try{const p=await open(ctx,'/settings/language-region');await choose(p,'ko');
   await ctx.addCookies([{name:HON_SESSION_COOKIE,value:issueSession({externalSubject:'second-preference-user-synthetic'},session),url:origin,httpOnly:true,sameSite:'Lax'}]);await p.goto(origin+'/settings/language-region');assert.equal(await p.locator('html').getAttribute('lang'),'en');await choose(p,'es');
   await ctx.addCookies([{name:HON_SESSION_COOKIE,value:issueSession({externalSubject:'school-owner-synthetic'},session),url:origin,httpOnly:true,sameSite:'Lax'}]);await p.goto(origin+'/settings/language-region');assert.equal(await p.locator('html').getAttribute('lang'),'ko');assert.equal((await ctx.cookies()).filter(c=>c.name.startsWith('hon_locale_v1_')).length,2);
   const another=await context();try{const other=await open(another,'/settings/language-region');assert.equal(await other.locator('html').getAttribute('lang'),'en');}finally{await another.close();}
  }finally{await ctx.close();}
 });
 await check('Malformed or authority-shaped locale cookie falls back to English without authorizing billing',async()=>{
  reset();const ctx=await context();try{const p=await open(ctx,'/settings/language-region');await choose(p,'ko');const cookie=(await ctx.cookies()).find(c=>c.name.startsWith('hon_locale_v1_'));await ctx.addCookies([{...cookie,value:encodeURIComponent(JSON.stringify({...DEFAULT_LOCALE,language:'ko',role:'OWNER',schoolId:'foreign'}))}]);await p.reload();assert.equal(await p.locator('html').getAttribute('lang'),'en');setReadMode('403');await p.goto(origin+'/staff/subscription');await p.getByRole('main').getByRole('alert').waitFor();assert(await p.getByRole('button',{name:'Review selection →',exact:true}).isDisabled());}finally{await ctx.close();}
 });
 for(const lang of ['ko','es'])await check(`${lang}: translated independent permission denial and no purchase`,async()=>{reset();const ctx=await context();try{const p=await open(ctx,'/settings/language-region');await choose(p,lang);setReadMode('403');await p.goto(origin+'/staff/subscription');await p.getByRole('main').getByRole('alert').filter({hasText:tx(lang,'School billing permission was denied. No purchase or account access is assumed.')}).waitFor();assert(await p.getByRole('button',{name:tx(lang,'Review selection →'),exact:true}).isDisabled());assert.equal(commandCount(),0);}finally{await ctx.close();}});
 await check('Blocked browser preference writes apply immediately without claiming persistence',async()=>{reset();const ctx=await context();try{await ctx.addInitScript(()=>{const descriptor=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');Object.defineProperty(document,'cookie',{get(){return descriptor.get.call(document)},set(value){if(!String(value).startsWith('hon_locale_v1_'))descriptor.set.call(document,value)}})});const p=await open(ctx,'/settings/language-region');await choose(p,'ko');await p.getByRole('main').getByText(tx('ko','Applied now, but this browser could not save your preference.'),{exact:true}).waitFor();await p.reload();assert.equal(await p.locator('html').getAttribute('lang'),'en');assert.equal(commandCount(),0);}finally{await ctx.close();}});
 await check('Narrow Korean/Spanish settings and 200% zoom have no horizontal overflow',async()=>{for(const lang of ['ko','es']){reset();const ctx=await context({width:320,height:844});try{const p=await open(ctx,'/settings/language-region');await choose(p,lang);await overflow(p);await p.setViewportSize({width:1280,height:1000});await p.locator('body').evaluate(el=>{el.style.zoom='2'});await overflow(p);}finally{await ctx.close();}}});
 await check('Family identity can change only its own local display setting without school billing access',async()=>{reset();const ctx=await context(undefined,'family-synthetic');try{const p=await open(ctx,'/settings/language-region');await choose(p,'ko');await p.goto(origin+'/staff/subscription');await p.getByRole('main').getByRole('alert').waitFor();assert.equal(commandCount(),0);}finally{await ctx.close();}});
 for(const [label,subject,token]of [['unsigned',null,undefined],['tampered','school-owner-synthetic','invalid'],['expired','school-owner-synthetic',issueSession({externalSubject:'school-owner-synthetic'},session,1)]])await check(`${label}: shared settings retains signed-session gate`,async()=>{const ctx=await context(undefined,subject,token);try{const p=await ctx.newPage();await p.goto(origin+'/settings/language-region');await p.waitForURL(origin+'/auth/login');}finally{await ctx.close();}});
}
