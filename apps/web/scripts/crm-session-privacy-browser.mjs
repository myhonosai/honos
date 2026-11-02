/** Mounted production React + actual language HTTP transport; synthetic API only. */
import assert from 'node:assert/strict';

export async function runCrmSessionPrivacyBrowserChecks({fixture,reset,open,visual,check}) {
  async function pending(read=false) {
    for(let i=0;i<100;i++){if(read?fixture.readPending:fixture.pending)return;await new Promise(done=>setTimeout(done,25));}
    throw Error('Synthetic request gate was not reached');
  }
  async function language(page,outcome) {
    await page.waitForFunction(()=>document.querySelector('[data-locale-utility] select')?.disabled===false);
    const methods=[];
    await page.route('**/api/v1/me/language-preference',async route=>{
      const method=route.request().method();methods.push(method);
      const denied=outcome==='read-401'&&method==='GET'?401:outcome==='save-401'?401:outcome==='save-403'?403:200;
      const preference={language:'ko',version:2,updatedAt:'2026-10-20T09:00:00.000Z'};
      const data=method==='POST'?{preference,replayed:false}:{preference,schoolDefault:null,effective:{language:'ko',source:'PERSONAL'},supportedLanguages:['en','ko','es']};
      await route.fulfill({status:denied,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'},body:JSON.stringify(denied===200?{data}:{code:'SYNTHETIC_DENIAL'})});
    });
    // This invokes LocaleProvider -> updateMyLanguage -> optional loadMyLanguage.
    // No direct dispatch of the shared event or replacement browser handler.
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/me/language-preference'&&r.request().method()===(outcome==='read-401'||outcome==='success'?'GET':'POST'));
    await page.locator('[data-locale-utility] select').selectOption('ko');await response;
    await page.waitForFunction(()=>document.querySelector('[data-locale-utility] select')?.disabled===false);
    assert.deepEqual(methods,outcome==='read-401'||outcome==='success'?['POST','GET']:['POST']);
  }
  async function concealed(page) {
    const heading=page.getByRole('heading',{name:'CRM information hidden',exact:true});await heading.waitFor();
    assert(await heading.evaluate(e=>e===document.activeElement),'Privacy heading receives keyboard focus');
    assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));
    assert.equal(await page.getByRole('button',{name:'Prepare CRM-only close',exact:true}).count(),0);
  }
  for(const [size,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
    await check(`${size}: actual language-save 401 conceals an unsettled close, then explicit restoration preserves the exact retry`,async()=>{
      reset('close-unknown');const {context,page}=await open(viewport);
      try {
        const marker=await page.evaluate(()=>({origin:performance.timeOrigin,href:location.href}));
        await page.getByRole('button',{name:'Load CRM leads',exact:true}).click();
        await page.getByRole('button',{name:'Prepare CRM-only close',exact:true}).click();
        const panel=page.getByRole('region',{name:'Close selected CRM lead',exact:true});
        await panel.getByLabel('CRM close choice').selectOption('WON');
        await panel.getByLabel('Optional internal close note',{exact:true}).fill('Synthetic private close note');
        await panel.getByRole('checkbox',{name:/explicitly confirm/}).check();
        await panel.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
        await pending();assert.equal(fixture.commands.length,1);
        await language(page,'save-401');await concealed(page);
        assert(await page.getByRole('button',{name:'Verify access and resume',exact:true}).isDisabled());
        assert(await page.getByRole('button',{name:'Discard local view',exact:true}).isDisabled());
        fixture.release();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Verify access and resume')?.disabled);
        await visual(page,`${size}-crm-session-invalidated-private-command`);
        const reads=fixture.reads.length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(fixture.reads.length,reads);assert.equal(fixture.commands.length,1);
        await page.getByRole('button',{name:'Verify access and resume',exact:true}).focus();await page.keyboard.press('Enter');
        const retry=page.getByRole('button',{name:'Retry exact retained close request',exact:true});await retry.waitFor();assert.equal(fixture.commands.length,1);
        await retry.focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Returned CRM-only close receipt',exact:true}).waitFor();
        assert.equal(fixture.commands.length,2);assert.deepEqual(fixture.commands[0],fixture.commands[1]);
        assert.deepEqual(await page.evaluate(()=>({origin:performance.timeOrigin,href:location.href})),marker,'No document reload is needed');
        await visual(page,`${size}-crm-session-restored-exact-retry`);
      } finally {await context.close();}
    });
    await check(`${size}: actual language GET 401 rejects a pending lead-list success and requires an explicit new read`,async()=>{
      reset('close-success');const {context,page}=await open(viewport);
      try {
        fixture.holdRead=true;await page.getByRole('button',{name:'Load CRM leads',exact:true}).click();await pending(true);
        await language(page,'read-401');
        const completed=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/crm/leads'));
        fixture.releaseRead();await completed;await page.waitForTimeout(100);
        assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));
        await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(fixture.reads.length,1);assert.equal(fixture.commands.length,0);
        await page.getByRole('button',{name:'Load CRM leads',exact:true}).click();await page.getByText('Ari Stone',{exact:true}).waitFor();assert.equal(fixture.reads.length,2);
        await visual(page,`${size}-crm-session-fresh-explicit-read`);
      } finally {await context.close();}
    });
    for(const outcome of ['save-403','success'])await check(`${size}: language ${outcome} never invalidates or rereads the loaded CRM`,async()=>{
      reset('close-success');const {context,page}=await open(viewport);
      try {
        await page.getByRole('button',{name:'Load CRM leads',exact:true}).click();await page.getByText('Ari Stone',{exact:true}).waitFor();
        await language(page,outcome);assert.equal(await page.getByRole('heading',{name:'CRM information hidden',exact:true}).count(),0);
        await page.getByText('Ari Stone',{exact:true}).waitFor();assert.equal(fixture.reads.length,1);assert.equal(fixture.commands.length,0);
      } finally {await context.close();}
    });
  }
}
