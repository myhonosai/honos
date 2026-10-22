/** Synthetic localhost fixtures for the actual Next browser. This is not API/database verification. */
import assert from 'node:assert/strict';
import { validateRegisterCrmLeadInput, validateCreateBillingAccountInput, validateCrmGuardianChildEnrollmentReadInput,
  validateCrmGuardianChildPayerDesignationInput, validateCrmGuardianChildAdditionInput, validateCrmGuardianChildMembershipDraftFromPlanInput,
  verifyCrmGuardianChildEnrollment, verifyCrmGuardianChildMembershipDraftFromPlan } from '@hon/contracts';

export function createFamilyFixture({ id, scope, date, origin, send, rejected, plans }) {
  const prefix = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`, leadRoot = `${prefix}/crm/leads/${id(3)}`;
  let mode, registered, accounted, designated, children, keys, commands, reads;
  const child = (n, name, state = 'READY_FOR_DRAFT') => ({ studentProfileId: id(50+n), displayName: name, origin: n ? 'ADDITIONAL_CHILD' : 'CRM_REGISTRATION', workflowState: state });
  const registration = () => ({ outcome:'REGISTERED',leadId:id(3),sourceContactPersonId:id(4),registrationPath:'GUARDIAN_CHILD',studentProfileId:id(50),familyId:id(49),recordedAt:date });
  const payer = {state:'PAYER_DESIGNATED',guardianDisplayName:'Ari Stone',currency:'USD',recordedAt:date};
  function reset(value) {
    mode=value; keys=new Map(); commands=[]; reads=[]; registered=false; accounted=false; designated=false; children=[];
    if (value.startsWith('family-state-')) {
      const state=value.slice('family-state-'.length); registered=!['NOT_REGISTERED','NEEDS_STAFF_REVIEW','ADULT_REGISTRATION'].includes(state); accounted=['PAYER_DESIGNATION_REQUIRED','PAYER_DESIGNATED'].includes(state); designated=state==='PAYER_DESIGNATED';
      if(registered) children=[child(0,'Kai Stone')];
    }
  }
  function data() {
    let workflowState = !registered ? 'NOT_REGISTERED' : !accounted ? 'BILLING_ACCOUNT_REQUIRED' : !designated ? 'PAYER_DESIGNATION_REQUIRED' : 'PAYER_DESIGNATED';
    if(['family-state-NEEDS_STAFF_REVIEW','family-state-ADULT_REGISTRATION'].includes(mode)) workflowState=mode.slice('family-state-'.length);
    const result = !registered ? {leadId:id(3),workflowState} : {leadId:id(3),workflowState,historicalRegistrationReceipt:registration(),guardian:{displayName:'Ari Stone'},
      ...(accounted ? {billingAccount:{classification:'CANONICAL',currency:'USD'}} : {}),...(designated ? {payerDesignation:payer} : {}),
      children:children.map(c=>({...c,workflowState:designated ? c.workflowState : 'AWAITING_PAYER_DESIGNATION'}))};
    verifyCrmGuardianChildEnrollment(result,id(3)); return result;
  }
  async function handle(req,res,url) {
    if(!mode?.startsWith('family-')) return false;
    const step = url.pathname===leadRoot+'/guardian-child-enrollment' ? 'read' : url.pathname===leadRoot+'/register' ? 'register'
      : url.pathname===prefix+'/billing/accounts' ? 'account' : url.pathname===leadRoot+'/guardian-child-enrollment/payer-designation' ? 'payer'
      : url.pathname===leadRoot+'/guardian-child-enrollment/children' ? 'child' : url.pathname===prefix+'/billing/crm-guardian-child-membership-drafts/from-plan' ? 'draft' : null;
    if(!step) return false;
    const marker={read:'crm-guardian-child-enrollment-read',register:'crm-lead-register',account:'billing.account.create',payer:'crm-guardian-child-payer-designation',child:'crm-guardian-child-addition',draft:'crm-guardian-child-membership-draft-from-plan'}[step];
    assert.equal(req.method,'POST'); assert.equal(url.search,''); assert.equal(req.headers.origin,origin); assert.equal(req.headers['sec-fetch-site'],'same-origin'); assert.equal(req.headers['sec-fetch-mode'],'same-origin'); assert.equal(req.headers['sec-fetch-dest'],'empty'); assert.equal(req.headers['x-hon-human-command'],marker);
    let raw=''; for await(const chunk of req){raw+=chunk;assert(raw.length<4000);} const input=JSON.parse(raw),key=req.headers['idempotency-key'];
    if(mode==='family-denied'){rejected(res,403,'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN');return true;}
    if(step==='read') {
      validateCrmGuardianChildEnrollmentReadInput(input); assert.equal(key,undefined); reads.push(raw);
      if(mode==='family-slow')await new Promise(done=>setTimeout(done,500));
      if(mode==='family-missing'){rejected(res,404,'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE');return true;}
      if(mode==='family-read-error'){send(res,503,{});return true;}
      send(res,200,data());return true;
    }
    assert.match(key,/^[a-f0-9-]{36}$/); commands.push({step,key,raw});
    if(keys.has(key)){const old=keys.get(key);assert.equal(old.step,step);assert.equal(old.raw,raw);send(res,200,old.result,true);return true;}
    let result;
    if(step==='register') {validateRegisterCrmLeadInput(input);assert.equal(input.registrationPath,'GUARDIAN_CHILD');assert(!registered);registered=true;children=[child(0,`${input.childGivenName} ${input.childFamilyName}`)];result=registration();}
    if(step==='account') {validateCreateBillingAccountInput(input);assert.equal(input.responsiblePersonId,id(4));assert.equal(input.currency,'USD');assert(registered);accounted=true;result={id:id(46),responsiblePersonId:id(4),currency:'USD',classification:'CANONICAL',reused:true,version:1,createdAt:date};}
    if(step==='payer') {validateCrmGuardianChildPayerDesignationInput(input);assert(accounted);if(mode==='family-payer-failed'){rejected(res,409,'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT');return true;}designated=true;result=payer;}
    if(step==='child') {validateCrmGuardianChildAdditionInput(input);assert(designated);if(mode==='family-duplicate'){send(res,200,{outcome:'NEEDS_STAFF_REVIEW'});return true;}assert(children.length<10);const c=child(children.length,`${input.childGivenName} ${input.childFamilyName}`);children.push(c);result={outcome:'CHILD_ADDED',leadId:id(3),studentProfileId:c.studentProfileId,childDisplayName:c.displayName,recordedAt:date};}
    if(step==='draft') {
      validateCrmGuardianChildMembershipDraftFromPlanInput(input);assert(designated);const c=children.find(c=>c.studentProfileId===input.studentProfileId);assert(c);assert.equal(c.workflowState,'READY_FOR_DRAFT');
      if(mode==='family-stale'){rejected(res,409,'MEMBERSHIP_PLAN_VERSION_STALE');return true;}
      const p=plans().find(p=>p.planId===input.membershipPlanId&&p.version===input.membershipPlanVersion&&p.availability==='AVAILABLE');assert(p);assert.equal(p.currency,'USD');
      const {programName,...plan}=p;const receipt={membershipId:id(70+children.indexOf(c)),state:'DRAFT',planCode:p.planCode,termStartedAt:null,termEndsAt:null,recordedAt:date};result={receipt,plan};verifyCrmGuardianChildMembershipDraftFromPlan(result,input);c.workflowState='CURRENT_DRAFT';c.currentMembershipDraft={state:'RECORDED_DRAFT',...result};
    }
    keys.set(key,{step,raw,result});
    if(mode==='family-slow-payer'&&step==='payer')await new Promise(done=>setTimeout(done,700));
    if((mode==='family-unknown-payer'&&step==='payer')||(mode==='family-unknown-draft'&&step==='draft')){mode='family-ready';send(res,503,{});return true;}
    send(res,step==='account'?201:200,result);return true;
  }
  return {reset,handle,data,get commands(){return commands;},get reads(){return reads;},get children(){return children;},set mode(value){mode=value;},
    seedChildren(count=1){registered=accounted=designated=true;children=Array.from({length:count},(_,i)=>child(i,i?'Mina Stone':'Kai Stone'));}};
}

export async function runFamilyBrowserChecks({ fixture, reset, open, visual, check, id, origin, replaceActor }) {
  async function begin(page){await page.getByLabel('Status filter').selectOption('WON');await page.getByRole('button',{name:'Load CRM leads',exact:true}).click();assert.equal(fixture.reads.length,0);await page.getByRole('button',{name:'Set up / resume family',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Family setup for Ari Stone',exact:true}).waitFor();}
  async function confirm(page,label){await page.getByRole('checkbox').check();await page.getByRole('button',{name:label,exact:true}).click();}
  async function fields(page,given='Kai'){await page.getByLabel('Child given name',{exact:true}).fill(given);await page.getByLabel('Child family name',{exact:true}).fill('Stone');await page.getByLabel('Child date of birth',{exact:true}).fill(given==='Kai'?'2016-02-03':'2018-04-05');}
  for(const [size,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
    await check(`${size}: connected guardian, explicit payer, two separate children and plan-bound DRAFTs`,async()=>{
      reset('family-ready');const {context,page}=await open(viewport);
      try {
        await begin(page);await visual(page,`${size}-family-registration`);await fields(page);assert(await page.getByRole('button',{name:'Register family',exact:true}).isDisabled());await confirm(page,'Register family');
        await page.getByRole('heading',{name:/Create or reuse the guardian/}).waitFor();await confirm(page,'Create or reuse guardian account');
        await page.getByRole('heading',{name:/Confirm guardian payer/}).waitFor();assert(await page.getByRole('button',{name:'Designate guardian payer',exact:true}).isDisabled());await visual(page,`${size}-guardian-payer-review`);await confirm(page,'Designate guardian payer');
        await page.getByRole('heading',{name:'Add another child',exact:true}).waitFor();await fields(page,'Mina');await confirm(page,'Add child');
        await page.getByRole('button',{name:/Mina Stone/}).waitFor();assert.equal(fixture.children.length,2);assert.notEqual(fixture.children[0].studentProfileId,fixture.children[1].studentProfileId);await visual(page,`${size}-family-two-children`);
        for(const name of ['Kai','Mina']) {
          await page.getByRole('button',{name:new RegExp(`${name} Stone`)}).click();await page.getByRole('button',{name:'Load available membership plans',exact:true}).click();await page.getByLabel('Available membership plan',{exact:true}).selectOption(id(34));await page.getByRole('button',{name:'Review membership DRAFT',exact:true}).click();
          await visual(page,`${size}-${name.toLowerCase()}-plan-review`);await page.getByRole('checkbox',{name:new RegExp(`DRAFT for ${name} Stone`)}).check();await page.getByRole('button',{name:'Create DRAFT from selected plan',exact:true}).click();
          await page.getByRole('heading',{name:`Historical DRAFT creation receipt for ${name} Stone`,exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Verified current DRAFT',exact:true}).count(),0);await page.getByRole('button',{name:'Check current membership status',exact:true}).click();await page.getByRole('heading',{name:'Verified current DRAFT',exact:true}).waitFor();
        }
        const drafts=fixture.commands.filter(c=>c.step==='draft');assert.equal(drafts.length,2);assert.notEqual(JSON.parse(drafts[0].raw).studentProfileId,JSON.parse(drafts[1].raw).studentProfileId);assert.equal(new Set(fixture.commands.map(c=>c.key)).size,6);await visual(page,`${size}-family-current-drafts`);
        const count=fixture.commands.length;await page.reload();await beginAfterReload(page);assert.equal(fixture.commands.length,count);
        const stored=await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]));for(const c of fixture.commands)assert(!stored.includes(c.key));for(const n of [4,49,50,51,70,71])assert(!stored.includes(id(n)));
      }finally{await context.close();}
    });
    for(const state of ['NOT_REGISTERED','NEEDS_STAFF_REVIEW','ADULT_REGISTRATION','BILLING_ACCOUNT_REQUIRED','PAYER_DESIGNATION_REQUIRED','PAYER_DESIGNATED'])await check(`${size}: family recovery ${state}`,async()=>{
      reset('family-state-'+state);const {context,page}=await open(viewport);try{await begin(page);assert.equal(fixture.commands.length,0);if(state==='NEEDS_STAFF_REVIEW'){assert.equal(await page.getByRole('button',{name:'Register family',exact:true}).count(),0);assert((await page.getByRole('main').innerText()).includes('Existing records are preserved'));}if(state==='ADULT_REGISTRATION')await page.getByRole('button',{name:'Open adult Resume Setup',exact:true}).waitFor();await visual(page,`${size}-family-state-${state.toLowerCase()}`);}finally{await context.close();}
    });
  }
  async function beginAfterReload(page){const reads=fixture.reads.length;await page.getByLabel('Status filter').selectOption('WON');await page.getByRole('button',{name:'Load CRM leads',exact:true}).click();assert.equal(fixture.reads.length,reads);await page.getByRole('button',{name:'Set up / resume family',exact:true}).click();await page.getByRole('heading',{name:'Family setup for Ari Stone',exact:true}).waitFor();}
  for(const state of ['AWAITING_PAYER_DESIGNATION','READY_FOR_DRAFT','CURRENT_DRAFT','CURRENT_DRAFT_BY_OTHER_STAFF','NEEDS_STAFF_REVIEW'])await check(`mobile: child state ${state} preserves privacy`,async()=>{
    reset('family-ready');fixture.seedChildren();fixture.children[0].workflowState=state;
    if(state==='AWAITING_PAYER_DESIGNATION'){reset('family-state-PAYER_DESIGNATION_REQUIRED');}
    if(state==='CURRENT_DRAFT'||state==='CURRENT_DRAFT_BY_OTHER_STAFF') {
      const p={planId:id(34),planCode:'JUNIOR',version:1,displayName:'Junior Monthly',description:null,programId:null,availability:'AVAILABLE',currency:'USD',priceMinor:9900,billingFrequency:'MONTHLY',termKind:'OPEN_ENDED',termMonths:null,publishedAt:'2026-10-20T09:00:00.000Z'};
      fixture.children[0].currentMembershipDraft=state==='CURRENT_DRAFT'?{state:'RECORDED_DRAFT',plan:p,receipt:{membershipId:id(70),state:'DRAFT',planCode:'JUNIOR',termStartedAt:null,termEndsAt:null,recordedAt:p.publishedAt}}:{state:'RECORDED_DRAFT'};
    }
    const {context,page}=await open({width:390,height:844});try{await begin(page);await page.getByRole('button',{name:/Kai Stone/}).click();if(state==='CURRENT_DRAFT_BY_OTHER_STAFF'){const body=await page.getByRole('main').innerText();assert(!body.includes(id(70)));assert(!body.includes('Junior Monthly'));assert.equal(await page.getByRole('button',{name:'Load available membership plans',exact:true}).count(),0);}await visual(page,`mobile-child-state-${state.toLowerCase()}`);}finally{await context.close();}
  });
  for(const scenario of ['family-unknown-payer','family-payer-failed','family-duplicate','family-stale','family-denied','family-missing','family-read-error','family-slow','family-cap'])await check(`${scenario}: truthful retry, bounds, stale state and access`,async()=>{
    reset(scenario);if(['family-unknown-payer','family-payer-failed'].includes(scenario))fixture.reset('family-state-PAYER_DESIGNATION_REQUIRED');else if(['family-duplicate','family-stale','family-cap'].includes(scenario))fixture.seedChildren(scenario==='family-cap'?10:1);fixture.mode=scenario;
    const {context,page}=await open({width:390,height:844});try{
      await page.getByRole('button',{name:'Load CRM leads',exact:true}).click();await page.getByRole('button',{name:'Set up / resume family',exact:true}).click();
      if(['family-denied','family-missing','family-read-error'].includes(scenario)){await page.getByRole('main').getByRole('alert').waitFor();if(scenario==='family-denied')assert.equal(await page.getByLabel('School UUID',{exact:true}).inputValue(),'');assert.equal(fixture.commands.length,0);}
      else if(scenario==='family-slow'){await page.getByRole('button',{name:'Close family setup',exact:true}).click();await page.waitForTimeout(650);assert.equal(await page.getByRole('heading',{name:'Family setup for Ari Stone',exact:true}).count(),0);}
      else{
        await page.getByRole('heading',{name:'Family setup for Ari Stone',exact:true}).waitFor();
        if(scenario==='family-cap'){assert.equal(await page.getByRole('button',{name:'Add child',exact:true}).count(),0);assert((await page.getByRole('main').innerText()).includes('maximum of 10 children'));}
        if(scenario==='family-duplicate'){await fields(page);await confirm(page,'Add child');await page.getByText(/no child was created or merged/).waitFor();assert.equal(fixture.children.length,1);}
        if(scenario==='family-unknown-payer'||scenario==='family-payer-failed'){await confirm(page,'Designate guardian payer');if(scenario==='family-unknown-payer'){await page.getByRole('button',{name:'Retry exact family request',exact:true}).waitFor();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('heading',{name:'CRM information hidden',exact:true}).waitFor();assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));const commands=fixture.commands.length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(fixture.commands.length,commands);await page.getByRole('button',{name:'Verify access and resume',exact:true}).click();await page.getByRole('button',{name:'Retry exact family request',exact:true}).click();await page.getByRole('heading',{name:'Add another child',exact:true}).waitFor();assert.deepEqual(fixture.commands[0],fixture.commands[1]);}else{await page.getByRole('main').getByRole('alert').waitFor();await page.getByRole('button',{name:'Designate guardian payer',exact:true}).waitFor({state:'detached'});assert.equal(await page.getByRole('button',{name:'Designate guardian payer',exact:true}).count(),0);}}
        if(scenario==='family-stale'){await page.getByRole('button',{name:/Kai Stone/}).click();await page.getByRole('button',{name:'Load available membership plans',exact:true}).click();await page.getByLabel('Available membership plan',{exact:true}).selectOption(id(34));await page.getByRole('button',{name:'Review membership DRAFT',exact:true}).click();await page.getByRole('checkbox',{name:/DRAFT for Kai Stone/}).check();await page.getByRole('button',{name:'Create DRAFT from selected plan',exact:true}).click();await page.getByRole('main').getByRole('alert').waitFor();await page.getByRole('button',{name:'Create DRAFT from selected plan',exact:true}).waitFor({state:'detached'});assert.equal(await page.getByRole('button',{name:'Create DRAFT from selected plan',exact:true}).count(),0);assert.equal(fixture.children[0].workflowState,'READY_FOR_DRAFT');}
      }
    }finally{await context.close();}
  });
  await check('family: navigation/session loss restores progress without repeating commands',async()=>{
    reset('family-ready');fixture.seedChildren(2);const {context,page}=await open({width:390,height:844});try{await begin(page);await page.goto(origin+'/staff/search');await page.goto(origin+'/staff/crm/leads?organizationId='+id(1)+'&schoolId='+id(2));await beginAfterReload(page);assert.equal(fixture.children.length,2);await context.clearCookies();await page.getByRole('button',{name:'Refresh family setup',exact:true}).click();await page.getByRole('main').getByRole('alert').waitFor();assert.equal(await page.getByRole('heading',{name:'Family setup for Ari Stone',exact:true}).count(),0);assert.equal(fixture.commands.length,0);}finally{await context.close();}
  });
  for (const [size,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
    await check(`${size}: privacy shield hides all CRM information and never restores on focus alone`,async()=>{
      reset('family-ready');fixture.seedChildren(2);const {context,page}=await open(viewport);try{
        await begin(page);await page.getByRole('button',{name:/Kai Stone/}).click();await visual(page,`${size}-family-privacy-before`);
        const count=fixture.commands.length,reads=fixture.reads.length;
        await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('heading',{name:'CRM information hidden',exact:true}).waitFor();
        assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));assert(!(await page.getByRole('main').innerText()).includes('Kai Stone'));
        assert(await page.locator('[aria-hidden="true"][inert]').evaluate(e=>e.hidden&&getComputedStyle(e).display==='none'));
        await visual(page,`${size}-family-privacy-hidden`);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(fixture.commands.length,count);assert.equal(fixture.reads.length,reads);
        await page.getByRole('button',{name:'Verify access and resume',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Family setup for Ari Stone',exact:true}).waitFor();
        assert(fixture.reads.length>reads);assert.equal(fixture.commands.length,count);await visual(page,`${size}-family-privacy-restored`);
        const heading=await page.getByRole('heading',{name:'Family setup for Ari Stone',exact:true}).boundingBox();assert(heading.y<viewport.height,'Family panel is reachable in one viewport after revalidation');
      }finally{await context.close();}
    });
    await check(`${size}: uncertain child DRAFT retains its exact request through privacy verification`,async()=>{
      reset('family-unknown-draft');fixture.seedChildren();const {context,page}=await open(viewport);try{
        await begin(page);await page.getByRole('button',{name:/Kai Stone/}).click();await page.getByRole('button',{name:'Load available membership plans',exact:true}).click();await page.getByLabel('Available membership plan',{exact:true}).selectOption(id(34));await page.getByRole('button',{name:'Review membership DRAFT',exact:true}).click();await page.getByRole('checkbox',{name:/DRAFT for Kai Stone/}).check();await page.getByRole('button',{name:'Create DRAFT from selected plan',exact:true}).click();
        await page.getByRole('button',{name:'Retry exact family request',exact:true}).waitFor();assert.equal(fixture.commands.length,1);
        await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('button',{name:'Verify access and resume',exact:true}).click();await page.getByRole('button',{name:'Retry exact family request',exact:true}).waitFor();assert.equal(fixture.commands.length,1);
        await visual(page,`${size}-family-exact-retry`);await page.getByRole('button',{name:'Retry exact family request',exact:true}).click();await page.getByRole('heading',{name:'Historical DRAFT creation receipt for Kai Stone',exact:true}).waitFor();assert.deepEqual(fixture.commands[0],fixture.commands[1]);
        await page.getByRole('button',{name:'Check current membership status',exact:true}).click();await page.getByRole('heading',{name:'Verified current DRAFT',exact:true}).waitFor();assert.equal(fixture.commands.length,2);assert.equal(fixture.children.length,1);
        await visual(page,`${size}-family-verified-after-retry`);
      }finally{await context.close();}
    });
  }
  for(const scenario of ['expired','changed-user','revoked','scope-change','slow-command'])await check(`privacy restoration: ${scenario} never reveals unauthorized data`,async()=>{
    reset('family-state-PAYER_DESIGNATION_REQUIRED');const {context,page}=await open({width:390,height:844});try{
      await begin(page);
      if(scenario==='slow-command'){fixture.mode='family-slow-payer';await confirm(page,'Designate guardian payer');}
      await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('heading',{name:'CRM information hidden',exact:true}).waitFor();
      if(scenario==='expired')await context.clearCookies();
      if(scenario==='changed-user')await replaceActor(context);
      if(scenario==='revoked')fixture.mode='family-denied';
      if(scenario==='scope-change'){await page.getByRole('button',{name:'Discard local view',exact:true}).click();await page.getByLabel('School UUID',{exact:true}).fill(id(99));assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));assert.equal(fixture.commands.length,0);return;}
      const button=page.getByRole('button',{name:'Verify access and resume',exact:true});await button.waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Verify access and resume')?.disabled);
      await button.click();
      if(scenario==='slow-command'){await page.getByRole('heading',{name:'Family setup for Ari Stone',exact:true}).waitFor();assert.equal(fixture.commands.length,1);}
      else{await page.getByRole('main').getByRole('alert').waitFor();assert(!(await page.getByRole('main').innerText()).includes('Ari Stone'));assert.equal(await page.getByLabel('School UUID',{exact:true}).inputValue(),'');assert.equal(fixture.commands.length,0);}
    }finally{await context.close();}
  });

}
