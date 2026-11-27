const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {CrmPipelineBoardService}=require('../dist/crm-pipeline-board/crm-pipeline-board.service.js');
const {CrmPipelineBoardReadHumanUiGuard,CrmLeadStageMoveHumanUiGuard,CrmPipelineStagesSaveHumanUiGuard}=require('../dist/crm-pipeline-board/crm-pipeline-board-human-ui.guard.js');
const c=require('@hon/contracts');
// 0417: the lead pipeline board.
const ids={pipe:randomUUID(),lead:randomUUID(),won:randomUUID(),person:randomUUID(),lead2:randomUUID(),org:randomUUID(),school:randomUUID()};
const stage=(id,name,position,terminalStatus=null,openCount=0)=>({id,name,position,color:'BLUE',hidden:false,terminalStatus,openCount});
const card={id:randomUUID(),version:1,status:'OPEN',stageId:ids.lead,personId:ids.person,givenName:'Ava',familyName:'Synthetic',email:null,phoneE164:null,
 programInterestCode:'Kids',sourceCode:'website',createdAt:'2026-11-16T10:00:00.000Z',closedAt:null,nextTrialAt:null,lastTrialAt:null,textOptedOut:false};
const board={pipelines:[{id:ids.pipe,name:'New students',version:1}],pipeline:{id:ids.pipe,name:'New students',version:1},
 stages:[stage(ids.lead,'Lead',1,null,1),stage(ids.won,'Enrolled',2,'WON')],totals:{open:1,won:0,lost:0},status:'OPEN',leads:[card],truncated:false,limit:500};
const ctx=(over={})=>({organizationId:ids.org,schoolId:ids.school,principalId:randomUUID(),principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),externalSubject:'oidc:owner',idempotencyKey:'',...over});
function db(rows,calls=[]){const run=async(_c,f)=>f({query:async(sql,args)=>{calls.push([sql,args]);return /hon\.(read_crm_pipeline_board|move_crm_lead_stage|save_crm_pipeline_stages)/.test(sql)?{rows}:{rows:[]};}});
 return {withTenantReadOnlyTransaction:run,withTenantTransaction:run};}
test('read calls only the 0417 board function with the session subject and verifies the answer',async()=>{
 const calls=[];const s=new CrmPipelineBoardService(db([{data:board}],calls));
 assert.equal((await s.read(ctx(),null,'OPEN')).leads[0].givenName,'Ava');
 assert(calls.some(([sql,args])=>sql.includes('hon.read_crm_pipeline_board($1,$2::uuid,$3)')&&args[0]==='oidc:owner'&&args[1]===null&&args[2]==='OPEN'));
 // A lead of another status, a lead in an unknown stage, or another pipeline than asked for is never shown.
 for(const lie of [{...board,leads:[{...card,status:'WON'}]},{...board,leads:[{...card,stageId:randomUUID()}]},{...board,limit:50},{...board,extra:1}])
  await assert.rejects(new CrmPipelineBoardService(db([{data:lie}])).read(ctx(),null,'OPEN'),e=>e.status===503);
 await assert.rejects(new CrmPipelineBoardService(db([{data:board}])).read(ctx(),randomUUID(),'OPEN'),e=>e.status===503);
});
test('move and save verify their receipts and never reach the database with bad input',async()=>{
 const receipt={organizationId:ids.org,schoolId:ids.school,leadId:card.id,pipelineId:ids.pipe,fromStageId:ids.lead,stageId:ids.lead2,priorVersion:1,version:2,movedAt:'2026-11-16T10:00:00.000Z'};
 const moved=await new CrmPipelineBoardService(db([{data:{receipt,replayed:false}}])).move(ctx({idempotencyKey:'k'}),card.id,{stageId:ids.lead2,expectedVersion:1});
 assert.equal(moved.receipt.version,2);
 await assert.rejects(new CrmPipelineBoardService(db([{data:{receipt:{...receipt,stageId:randomUUID()},replayed:false}}])).move(ctx({idempotencyKey:'k'}),card.id,{stageId:ids.lead2,expectedVersion:1}),e=>e.status===503);
 const saved={organizationId:ids.org,schoolId:ids.school,pipelineId:ids.pipe,priorVersion:1,version:2,stages:board.stages,moves:[],savedAt:'2026-11-16T10:00:00.000Z'};
 assert.equal((await new CrmPipelineBoardService(db([{data:{receipt:saved,replayed:true}}])).saveStages(ctx({idempotencyKey:'k'}),ids.pipe,{expectedVersion:1,stages:[{id:ids.lead,name:'Lead',color:'SKY',hidden:false}],moves:[]})).replayed,true);
 const calls=[];const s=new CrmPipelineBoardService(db([],calls));
 await assert.rejects(s.move(ctx(),card.id,{stageId:ids.lead2,expectedVersion:1}),e=>e.status===409);
 for(const bad of [{stageId:'x',expectedVersion:1},{stageId:ids.lead2,expectedVersion:0},{stageId:ids.lead2},{stageId:ids.lead2,expectedVersion:1,extra:1}])
  await assert.rejects(s.move(ctx({idempotencyKey:'k'}),card.id,bad),e=>e.status===400);
 const item=(over={})=>({id:ids.lead,name:'Lead',color:'BLUE',hidden:false,...over});
 for(const bad of [{expectedVersion:1,stages:[],moves:[]},{expectedVersion:1,stages:[item({hidden:true})],moves:[]},{expectedVersion:1,stages:[item(),item({id:null,name:'lead'})],moves:[]},
   {expectedVersion:1,stages:[item({color:'PINK'})],moves:[]},{expectedVersion:1,stages:[item({name:' Lead'})],moves:[]},{expectedVersion:1,stages:[item({id:null,hidden:true}),item({id:ids.won,name:'B'})],moves:[]},
   {expectedVersion:1,stages:Array.from({length:21},(_,i)=>item({id:null,name:`S${i}`})),moves:[]}])
  await assert.rejects(s.saveStages(ctx({idempotencyKey:'k'}),ids.pipe,bad),e=>e.status===400);
 assert.equal(calls.length,0);
});
test('only direct human commands; refusals map to closed codes without leaking database text',async()=>{
 const s=new CrmPipelineBoardService(db([]));
 for(const over of [{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])
  await assert.rejects(s.read(ctx(over),null,'OPEN'),e=>e.status===403);
 await assert.rejects(s.read(ctx({idempotencyKey:'x'}),null,'OPEN'),e=>e.status===409);
 for(const [code,message,status,closed] of [['42501','CRM_BOARD_FORBIDDEN',403,'CRM_BOARD_FORBIDDEN'],['40001','VERSION_CONFLICT',409,'VERSION_CONFLICT'],
   ['23505','IDEMPOTENCY_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED'],['22023','CRM_STAGE_NOT_ALLOWED',400,'CRM_STAGE_NOT_ALLOWED'],['22023','CRM_STAGE_MOVE_REQUIRED',400,'CRM_STAGE_MOVE_REQUIRED'],
   ['P0002','CRM_PIPELINE_UNAVAILABLE',404,'CRM_PIPELINE_UNAVAILABLE'],['55P03','SECRET',409,'CRM_BOARD_CONFLICT'],['XX000','SECRET SQL',503,'CRM_BOARD_UNAVAILABLE']]){
  const failing=new CrmPipelineBoardService({withTenantReadOnlyTransaction:async()=>{throw Object.assign(new Error(message),{code});}});
  await assert.rejects(failing.read(ctx(),null,'OPEN'),e=>e.status===status&&e.getResponse().code===closed&&!JSON.stringify(e.getResponse()).includes('SECRET'));
 }
});
test('the guards use their own command names and the contract rejects lookalikes',()=>{
 assert.equal(new CrmPipelineBoardReadHumanUiGuard().command,'crm.pipeline.board.read');
 assert.equal(new CrmLeadStageMoveHumanUiGuard().command,'crm.lead.stage.move');
 assert.equal(new CrmPipelineStagesSaveHumanUiGuard().command,'crm.pipeline.stages.save');
 assert.equal(c.crmStageNameOk('Appointment booked (FB)'),true);
 for(const bad of ['', ' x', 'x ', 'a​b', 'x'.repeat(61), 5]) assert.equal(c.crmStageNameOk(bad),false);
});
