/** Production-built UI verification with explicitly synthetic, localhost close fixtures. */
import assert from 'node:assert/strict';
import { validateCloseCrmLeadInput } from '@hon/contracts';
export function createCloseFixture({id,scope,date,origin,send,rejected}) {
  const root=`/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads`;
  let mode,record,commands,reads,keys,release,readRelease,denyRead,denyClose,hideLead,holdRead;
  function reset(value){mode=value;record={id:id(3),primaryPersonId:id(4),pipelineStageId:id(8),givenName:'Ari',familyName:'Stone',status:'OPEN',version:1,createdAt:date};commands=[];reads=[];keys=new Map();release=null;readRelease=null;denyRead=denyClose=hideLead=holdRead=false;}
  async function handle(req,res,url){
    if(!mode?.startsWith('close-'))return false;
    if(req.method==='GET'&&url.pathname===root){reads.push(url.search);if(holdRead){holdRead=false;await new Promise(done=>{readRelease=done;});}if(denyRead)rejected(res,403,'STAFF_SCOPE_DENIED');else send(res,200,hideLead||url.searchParams.has('status')&&url.searchParams.get('status')!==record.status?[]:[record]);return true;}
    if(url.pathname!==root+'/'+id(3)+'/close')return false;
    assert.equal(req.method,'POST');assert.equal(url.search,'');assert.equal(req.headers.origin,origin);assert.equal(req.headers['sec-fetch-site'],'same-origin');assert.equal(req.headers['x-hon-human-command'],'crm-lead-close');
    let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<4000);}const input=JSON.parse(raw);validateCloseCrmLeadInput(input);const key=req.headers['idempotency-key'];assert.match(key,/^[a-f0-9-]{36}$/);
    commands.push({key,raw,path:url.pathname});if(denyClose){rejected(res,403,'STAFF_SCOPE_DENIED');return true;}
    if(keys.has(key)){const old=keys.get(key);assert.equal(raw,old.raw);send(res,200,old.receipt,true);return true;}
    await new Promise(done=>{release=done;});
    if(mode==='close-rejected'){rejected(res,409,'CRM_LEAD_VERSION_CONFLICT');return true;}
    assert.equal(record.status,'OPEN');assert.equal(input.expectedVersion,record.version);
    const receipt={organizationId:scope.organizationId,schoolId:scope.schoolId,leadId:id(3),status:input.status,priorVersion:1,version:2,closedAt:date,closeNote:input.closeNote??null,crmOnly:true};keys.set(key,{raw,receipt});record={...record,status:input.status,version:2};
    if(mode==='close-network'){res.destroy();return true;}if(mode==='close-unknown'){send(res,503,{});return true;}send(res,200,receipt);return true;
  }
  return {reset,handle,get commands(){return commands;},get reads(){return reads;},get pending(){return Boolean(release);},get readPending(){return Boolean(readRelease);},
    release(){const done=release;release=null;assert(done);done();},releaseRead(){const done=readRelease;readRelease=null;assert(done);done();},
    set denyRead(v){denyRead=v;},set denyClose(v){denyClose=v;},set hideLead(v){hideLead=v;},set holdRead(v){holdRead=v;}};
}
export async function runCloseBrowserChecks({fixture,reset,open,visual,check,replaceActor,captureFailure}) {
  async function pending(page,read=false){for(let i=0;i<100;i++){if(read?fixture.readPending:fixture.pending)return;await page.waitForTimeout(50);}throw Error('Synthetic close gate was not reached');}
  async function begin(page,status){try{await page.getByRole('button',{name:'Load CRM leads',exact:true}).click();await page.getByRole('button',{name:'Prepare CRM-only close',exact:true}).click();const section=page.getByRole('region',{name:'Close selected CRM lead',exact:true});await section.getByLabel('CRM close choice',{exact:true}).selectOption(status);await section.getByLabel('Optional internal close note',{exact:true}).fill('Synthetic private close note');await section.getByRole('checkbox',{name:/explicitly confirm/}).check();await section.locator('form').evaluate(form=>{for(let i=0;i<2;i++)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await pending(page);assert.equal(fixture.commands.length,1);}catch(e){await captureFailure(page).catch(()=>{});throw e;}}
  async function blur(page){await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('heading',{name:'CRM information hidden',exact:true}).waitFor();assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));assert(!(await page.getByRole('main').innerText()).includes('Synthetic private close note'));}
  async function settled(page){await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Verify access and resume')?.disabled);}
  async function restore(page){await page.getByRole('button',{name:'Verify access and resume',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Close CRM lead only',exact:true}).waitFor();assert.equal(await page.getByLabel('Status filter',{exact:true}).inputValue(),'');assert(!fixture.reads.at(-1).includes('status='));}
  for(const [size,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
    for(const status of ['WON','LOST'])for(const outcome of ['success','unknown','rejected','network'])await check(`${size}: ${status} close ${outcome} settles concealed and restores without reload`,async()=>{
      reset('close-'+outcome);const {context,page}=await open(viewport);let navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
      try{await begin(page,status);await blur(page);assert(await page.getByRole('button',{name:'Verify access and resume',exact:true}).isDisabled());assert(await page.getByRole('button',{name:'Discard local view',exact:true}).isDisabled());await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(fixture.commands.length,1);
        if(outcome==='unknown')await visual(page,`${size}-${status.toLowerCase()}-close-in-flight-hidden`);
        fixture.release();await settled(page);assert(await page.getByRole('button',{name:'Discard local view',exact:true}).isDisabled()); // acknowledgement still required
        await blur(page);await restore(page);assert.equal(fixture.commands.length,1);
        const section=page.getByRole('region',{name:'Close selected CRM lead',exact:true});
        if(outcome==='unknown'||outcome==='network'){await section.getByRole('button',{name:'Retry exact retained close request',exact:true}).waitFor();await visual(page,`${size}-${status.toLowerCase()}-close-${outcome}-restored`);const retry=section.getByRole('button',{name:'Retry exact retained close request',exact:true});await retry.focus();await page.keyboard.press('Enter');await section.getByRole('heading',{name:'Returned CRM-only close receipt',exact:true}).waitFor();assert.equal(fixture.commands.length,2);assert.deepEqual(fixture.commands[0],fixture.commands[1]);assert((await section.innerText()).includes('replayed receipt'));}
        else if(outcome==='success'){await section.getByRole('heading',{name:'Returned CRM-only close receipt',exact:true}).waitFor();assert.equal(await section.getByRole('button',{name:'Retry exact retained close request',exact:true}).count(),0);}
        else{await section.getByRole('alert').waitFor();assert.equal(await section.getByRole('button',{name:'Retry exact retained close request',exact:true}).count(),0);}
        assert.equal(navigations,0,'Settled close must recover in the same document');assert(await page.getByRole('button',{name:'Load CRM leads',exact:true}).isDisabled());
        const stored=await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]));assert(!stored.includes(fixture.commands[0].key));assert(!stored.includes('Synthetic private close note'));
      }finally{await context.close();}
    });
    await check(`${size}: settled close can be deliberately abandoned and repeated blur invalidates restoration`,async()=>{
      reset('close-unknown');const {context,page}=await open(viewport);try{await begin(page,'WON');await blur(page);fixture.release();await settled(page);fixture.holdRead=true;await page.getByRole('button',{name:'Verify access and resume',exact:true}).click();await pending(page,true);await blur(page);fixture.releaseRead();await page.waitForTimeout(100);assert.equal(await page.getByRole('heading',{name:'Close CRM lead only',exact:true}).count(),0);await restore(page);const discard=page.getByRole('button',{name:'Discard close retry',exact:true});assert(await discard.isDisabled());await page.getByRole('checkbox',{name:'I understand and deliberately abandon local recovery.',exact:true}).check();await discard.click();await page.getByRole('heading',{name:'Close CRM lead only',exact:true}).waitFor({state:'detached'});assert.equal(fixture.commands.length,1);assert.equal(fixture.reads.length,3);await visual(page,`${size}-close-deliberately-abandoned`);}finally{await context.close();}
    });
  }
  for(const reason of ['expired','changed-user','revoked','missing','close-permission-revoked','school-switch'])await check(`close privacy: ${reason} never bypasses current authority`,async()=>{
    reset('close-unknown');const {context,page}=await open({width:390,height:844});try{await begin(page,'LOST');await blur(page);fixture.release();await settled(page);
      if(reason==='expired')await context.clearCookies();if(reason==='changed-user')await replaceActor(context);if(reason==='revoked')fixture.denyRead=true;if(reason==='missing')fixture.hideLead=true;
      if(reason==='school-switch'){await page.getByRole('checkbox',{name:'I understand and deliberately abandon local recovery.',exact:true}).check();await page.getByRole('button',{name:'Discard local view',exact:true}).click();await page.getByLabel('School UUID',{exact:true}).fill('00000000-0000-4000-8000-000000000099');assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));}
      else if(reason==='close-permission-revoked'){await restore(page);fixture.denyClose=true;await page.getByRole('button',{name:'Retry exact retained close request',exact:true}).click();await page.getByRole('main').getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'Retry exact retained close request',exact:true}).count(),0);assert.equal(fixture.commands.length,2);}
      else{await page.getByRole('button',{name:'Verify access and resume',exact:true}).click();await page.getByRole('main').getByRole('alert').waitFor();assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));}
      if(reason!=='close-permission-revoked')assert.equal(fixture.commands.length,1);
    }finally{await context.close();}
  });
}
