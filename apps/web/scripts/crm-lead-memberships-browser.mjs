/** Real mounted HON UI and signed synthetic sessions; deterministic localhost API fixtures, never a DB/provider proof. */
import assert from 'node:assert/strict';
import { verifyCrmLeadMemberships } from '@hon/contracts';
import { createDateFixture } from './membership-dates-browser.mjs';
import { loadMembershipBrowserCopy } from './school-membership-journey-browser.mjs';

export function createLeadMembershipRecoveryFixture({id,scope,origin,send,rejected}) {
  let mode='disabled', reads=[], finish=null, signalHeld, held;
  const records=[{id:90,name:'Synthetic Morgan Lee',state:'ACTIVE'}, {id:70,name:'Synthetic Kai Stone',state:'ACTIVE'}, {id:71,name:'Synthetic Mina Stone',state:'ACTIVE'}, {id:72,name:'Synthetic Former Student',state:'CANCELLED'}, {id:73,name:'Synthetic Expired Student',state:'EXPIRED'}, {id:74,name:'Synthetic Future Student',state:'ACTIVE',future:true}];
  const dates=records.map(record=>createDateFixture({id:n=>n===90?id(record.id):id(n),scope,origin,send,rejected,participantDisplayName:record.name,lifecycle:record.state,initialPeriod:record.future?{startDate:'2027-01-01',endDate:'2027-01-31',termStartedAt:'2027-01-01T08:00:00.000Z',termEndsAt:'2027-02-01T08:00:00.000Z'}:null}));
  const reset=value=>{mode=value;reads=[];finish=null;held=new Promise(done=>signalHeld=done);dates.forEach(f=>f.reset());};reset('disabled');
  const body=()=>verifyCrmLeadMemberships({leadId:id(3),truncated:false,memberships:mode==='empty'?[]:records.filter(r=>mode==='adult'?r.id===90:mode==='family'?[70,71].includes(r.id):true).map((r,index)=>({membershipId:id(r.id),studentProfileId:id(r.id+100),origin:r.id===90?'ADULT_REGISTRATION':'GUARDIAN_CHILD_REGISTRATION',state:r.state,version:2,createdAt:`2026-10-23T12:00:00.${String(index).padStart(6,'0')}Z`}))},id(3));
  async function handle(req,res,url) {
    if(mode==='disabled')return false;
    if(url.pathname===`/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads/${id(3)}/memberships`){
      assert.equal(req.method,'GET');assert.equal(url.search,'');assert.equal(req.headers['idempotency-key'],undefined);reads.push({path:url.pathname});
      if(['denied','missing','conflict','unavailable','session'].includes(mode)){const status={denied:403,missing:404,conflict:409,unavailable:503,session:401}[mode];rejected(res,status,'CRM_LEAD_MEMBERSHIPS_UNAVAILABLE');return true;}
      const payload=body();
      const complete=()=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify({data:payload,meta:{requestId:id(8),correlationId:id(8)}}));};
      if(mode==='held'){finish=complete;signalHeld();}else complete();return true;
    }
    for(const fixture of dates)if(await fixture.handle(req,res,url))return true;
    return false;
  }
  return {reset,handle,get reads(){return reads;},get dateReads(){return dates.flatMap(f=>f.reads);},get dateCommands(){return dates.flatMap(f=>f.commands);},date(n){return dates[records.findIndex(r=>r.id===n)];},waitUntilHeld:()=>held,release(){assert(finish);finish();},setMode(value){mode=value;}};
}

export async function runLeadMembershipRecoveryBrowserChecks({fixture,open,visual,check,origin,scope,id,setLanguage,report,restoreSession}) {
  const {membershipRecoveryText:t}=await loadMembershipBrowserCopy('crm-lead-memberships-copy');
  const {dateText}=await loadMembershipBrowserCopy('membership-dates-copy');
  const url=`${origin}/staff/crm/lead-memberships?${new URLSearchParams({...scope,leadId:id(3)})}`;
  async function go(page){await page.goto(url);await page.waitForFunction(()=>document.activeElement?.tagName==='H1'&&document.activeElement.closest('[data-membership-recovery]'));}
  const modes=[['modern',{width:1440,height:1000}],['classic',{width:834,height:1000}],['big',{width:390,height:844}]];
  for(const language of ['en','ko','es'])for(const[mode,viewport]of modes)await check(`membership recovery: ${language}/${mode} adult reload, authorized dates, private return and school operations`,async()=>{
    fixture.reset('adult');setLanguage(language);const{context,page}=await open(viewport);
    try{
      await go(page);await page.waitForFunction(l=>document.documentElement.lang===l,language);
      let root=page.locator('[data-membership-recovery]');await root.getByRole('heading',{name:t(language,'title'),exact:true}).waitFor();assert.equal(fixture.reads.length,0);
      await root.getByRole('combobox').selectOption(mode);assert.equal(fixture.reads.length,0);
      await root.getByRole('button',{name:t(language,'load'),exact:true}).focus();await page.keyboard.press('Enter');await root.locator('ol li').waitFor();assert.equal(fixture.reads.length,1);
      await visual(page,`membership-recovery-${language}-${mode}-adult-list`);assert.equal(report.accessibility.at(-1).violations.length,0);
      await page.reload();await page.locator('[data-membership-recovery]').getByRole('heading',{name:t(language,'title'),exact:true}).waitFor();assert.equal(fixture.reads.length,1,'Reload does not read automatically or trust cached membership IDs');
      root=page.locator('[data-membership-recovery]');await root.getByRole('combobox').selectOption(mode);await root.getByRole('button',{name:t(language,'load'),exact:true}).click();await root.locator('ol li').waitFor();assert.equal(fixture.reads.length,2);
      await root.getByRole('button',{name:t(language,'dates')+' · 1',exact:true}).focus();await page.keyboard.press('Enter');
      const detail=page.locator('[data-membership-dates]');await detail.getByRole('heading',{name:dateText(language,'Membership dates and history'),exact:true}).waitFor();assert.equal(fixture.dateReads.length,0);
      assert.equal(await detail.getByRole('combobox').inputValue(),mode);assert(!page.url().includes(id(90)));
      await detail.getByRole('button',{name:dateText(language,'Load membership dates'),exact:true}).click();await detail.getByRole('heading',{name:dateText(language,'Verified current membership'),exact:true}).waitFor();
      assert.equal(await detail.getByRole('link',{name:dateText(language,'Class bookings'),exact:true}).getAttribute('href'),'/staff/schedule/bookings');assert.equal(await detail.getByRole('link',{name:dateText(language,'Attendance'),exact:true}).getAttribute('href'),'/staff/attendance');
      await visual(page,`membership-recovery-${language}-${mode}-date-history`);assert.equal(report.accessibility.at(-1).violations.length,0);
      await detail.getByRole('button',{name:t(language,'back'),exact:true}).click();root=page.locator('[data-membership-recovery]');await root.getByRole('heading',{name:t(language,'title'),exact:true}).waitFor();assert.equal(await root.locator('ol li').count(),0,'A prior observation is not restored from memory');
      assert.equal(await root.getByRole('link',{name:t(language,'crm'),exact:true}).getAttribute('href'),`/staff/crm/journey?${new URLSearchParams({...scope,leadId:id(3)})}`);assert.equal(fixture.dateCommands.length,0);
    }finally{await context.close();setLanguage('en');}
  });
  await check('membership recovery: multiple children are independently selected; cancelled and expired records stay read-only',async()=>{
    fixture.reset('family');setLanguage('en');const{context,page}=await open(modes[2][1]);
    try{
      await go(page);let root=page.locator('[data-membership-recovery]');await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.locator('ol li').first().waitFor();assert.equal(await root.locator('ol li').count(),2);
      await root.getByRole('button',{name:t('en','dates')+' · 2',exact:true}).click();let detail=page.locator('[data-membership-dates]');assert.equal(await detail.getByLabel('Already-known membership ID',{exact:true}).inputValue(),id(71));
      await detail.getByRole('button',{name:'Load membership dates',exact:true}).click();await detail.getByRole('heading',{name:'Verified current membership',exact:true}).waitFor();assert((await detail.innerText()).includes('Synthetic Mina Stone'));
      await detail.getByRole('button',{name:t('en','back'),exact:true}).click();fixture.setMode('all');root=page.locator('[data-membership-recovery]');await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.locator('ol li').first().waitFor();
      await root.getByRole('button',{name:t('en','dates')+' · 4',exact:true}).click();detail=page.locator('[data-membership-dates]');await detail.getByRole('button',{name:'Load membership dates',exact:true}).click();await detail.getByRole('heading',{name:'Verified current membership',exact:true}).waitFor();assert((await detail.innerText()).includes('CANCELLED'));assert.equal(await detail.getByRole('button',{name:'Extend',exact:true}).count(),0);assert.equal(fixture.dateCommands.length,0);await visual(page,'membership-recovery-mobile-cancelled-read-only');
      for(const [index,state] of [[5,'EXPIRED'],[6,'SCHEDULED']]){
        await detail.getByRole('button',{name:t('en','back'),exact:true}).click();root=page.locator('[data-membership-recovery]');await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.locator('ol li').first().waitFor();
        await root.getByRole('button',{name:t('en','dates')+' · '+index,exact:true}).click();detail=page.locator('[data-membership-dates]');await detail.getByRole('button',{name:'Load membership dates',exact:true}).click();await detail.getByRole('heading',{name:'Verified current membership',exact:true}).waitFor();assert((await detail.innerText()).includes(state));if(state==='EXPIRED')assert.equal(await detail.getByRole('button',{name:'Extend',exact:true}).count(),0);assert.equal(fixture.dateCommands.length,0);await visual(page,'membership-recovery-mobile-'+state.toLowerCase());
      }

    }finally{await context.close();}
  });
  await check('membership recovery: unknown date command survives parent concealment, settles and retries exactly without reload',async()=>{
    fixture.reset('adult');const{context,page}=await open(modes[2][1]);try{
      await go(page);const root=page.locator('[data-membership-recovery]');await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.locator('ol li').waitFor();await root.getByRole('button',{name:t('en','dates')+' · 1',exact:true}).click();
      const detail=page.locator('[data-membership-dates]');await detail.getByRole('button',{name:'Load membership dates',exact:true}).click();await detail.getByRole('button',{name:'Extend',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-membership-dates] input[type=date]')[1]?.value==='2026-11-30');
      await detail.getByLabel('Reason category',{exact:true}).selectOption('MEMBER_REQUESTED');await detail.getByLabel('Reason for this change (10–500 characters)',{exact:true}).fill('Staff verified this requested synthetic extension.');await detail.getByRole('button',{name:'Review final date confirmation',exact:true}).click();await detail.getByRole('checkbox',{name:'I confirm this exact date change. No payment, invoice, refund, credit, schedule or agreement change is authorized.',exact:true}).check();
      const df=fixture.date(90);df.setMode('hold-unknown');await detail.getByRole('button',{name:'Confirm membership date change',exact:true}).click();await df.waitUntilHeld();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
      await detail.getByRole('heading',{name:'Membership information hidden',exact:true}).waitFor();assert(await detail.getByRole('button',{name:t('en','back'),exact:true}).isDisabled());assert(await detail.getByRole('button',{name:'Verify access and resume',exact:true}).isDisabled());df.release();
      await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='Verify access and resume')?.disabled);await detail.getByRole('button',{name:'Verify access and resume',exact:true}).click();await detail.getByRole('button',{name:'Retry exact retained date change',exact:true}).waitFor();assert.equal(df.commands.length,1);await detail.getByRole('button',{name:'Retry exact retained date change',exact:true}).click();await detail.getByText('Verified idempotent replay.',{exact:false}).waitFor();assert.equal(df.commands.length,2);assert.deepEqual(df.commands[0],df.commands[1]);await visual(page,'membership-recovery-mobile-exact-retry-after-shield');
    }finally{await context.close();}
  });
  for(const[mode,key]of[['denied','DENIED'],['missing','NOT_FOUND'],['conflict','CONFLICT'],['unavailable','UNAVAILABLE'],['session','SESSION'],['empty','empty']])await check(`membership recovery: ${mode} is distinct from empty and never leaks prior records`,async()=>{
    fixture.reset(mode);const{context,page}=await open(modes[0][1]);try{await go(page);const root=page.locator('[data-membership-recovery]');await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.getByText(t('en',key),{exact:true}).waitFor();assert.equal(await root.locator('ol li').count(),0);assert.equal(fixture.reads.length,1);if(mode!=='empty')assert.equal(await root.getByText(t('en','empty'),{exact:true}).count(),0);await visual(page,`membership-recovery-${mode}`);}finally{await context.close();}
  });
  await check('membership recovery: expired signed session redirects; new session explicitly discovers durable records; another school is denied',async()=>{
    fixture.reset('adult');const{context,page}=await open(modes[2][1]);try{
      await go(page);let root=page.locator('[data-membership-recovery]');await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.locator('ol li').waitFor();
      await context.clearCookies();await page.reload();await page.waitForURL(origin+'/auth/login');assert(!(await page.locator('body').innerText()).includes(id(90)));await restoreSession(context);await go(page);assert.equal(fixture.reads.length,1);root=page.locator('[data-membership-recovery]');await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.locator('ol li').waitFor();assert.equal(fixture.reads.length,2);
      assert(await page.evaluate(m=>!JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(m),id(90)));
      await page.goto(origin+'/staff/crm/lead-memberships?'+new URLSearchParams({...scope,schoolId:id(999),leadId:id(3)}));root=page.locator('[data-membership-recovery]');await root.getByRole('heading',{name:t('en','title'),exact:true}).waitFor();await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.getByText(t('en','DENIED'),{exact:true}).waitFor();assert.equal(await root.locator('ol li').count(),0);
    }finally{await context.close();}
  });
  for(const event of ['blur','pagehide','hon:session-invalidated','hon:school-context-changed'])await check(`membership recovery: ${event} denies pending/late restoration and requires a fresh explicit read`,async()=>{
    fixture.reset('adult');const{context,page}=await open(modes[2][1]);try{await go(page);const root=page.locator('[data-membership-recovery]');await root.getByRole('button',{name:t('en','load'),exact:true}).click();await root.locator('ol li').waitFor();
      fixture.setMode('held');await root.getByRole('button',{name:t('en','refresh'),exact:true}).click();await fixture.waitUntilHeld();await page.evaluate(e=>window.dispatchEvent(new Event(e)),event);assert.equal(await root.locator('ol li').count(),0);fixture.release();await page.waitForTimeout(100);assert.equal(await root.locator('ol li').count(),0);const count=fixture.reads.length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(fixture.reads.length,count);
      fixture.setMode('adult');await root.getByRole('button',{name:t('en','verify'),exact:true}).click();await root.locator('ol li').waitFor();assert.equal(fixture.reads.length,count+1);await visual(page,`membership-recovery-mobile-${event.replaceAll(':','-')}-restored`);
    }finally{await context.close();}
  });
}
