const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {CurriculumLibraryService}=require('../dist/curriculum/library.service.js');
const {validateLibraryInput}=require('../dist/curriculum/library.dto.js');
const {CurriculumLibraryHumanUiGuard,rejectParentLibraryInputs}=require('../dist/curriculum/library.controller.js');
const {isSafeCurriculumResourceUrl,verifyParentCurriculumLibrary}=require('@hon/contracts');
const c=()=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),requestId:randomUUID(),correlationId:randomUUID(),externalSubject:'synthetic-human',principalType:'HUMAN_USER',source:'HUMAN_UI',idempotencyKey:randomUUID()});
const input=()=>({expectedVersion:0,curriculumId:randomUUID(),rankId:null,kind:'VIDEO',url:'https://www.youtube.com/watch?v=basics',title:'Basics',description:'Optional reference.',audience:'PARENT'});
test('closed fixed URL contracts reject injection, host ambiguity, IP and unsafe URL forms',()=>{
 validateLibraryInput('CREATE',input());
 for(const patch of [{url:'http://youtube.com/'},{url:'https://user@youtube.com/'},{url:'https://[::1]/'},{url:'https://127.0.0.1/'},{url:'https://youtube.com/#x'},{url:'https://youtube.com/a b'},{url:'https://foo.local/'},{url:'https://foo.internal/'},{url:'https://youtube.com/%20'},{url:'https://youtube.com:443/'},{url:'https://youtube.com./'},{kind:'EMBED'},{title:'<b>Bad</b>'},{description:'bad\ntext'},{actorPrincipalId:randomUUID()}]) assert.throws(()=>validateLibraryInput('CREATE',{...input(),...patch}),e=>e.getStatus()===400);
 assert.equal(isSafeCurriculumResourceUrl('https://youtube.com/watch?v=x&list=y'),true);
 assert.throws(()=>verifyParentCurriculumLibrary({resources:[{title:'A',description:'',kind:'LINK',url:'https://vimeo.com/a',curriculumName:'C',rankName:null,childDisplayName:'Child',id:randomUUID()}]}));
});
test('service rejects every non-direct-human context before database access',async()=>{
 let calls=0;const service=new CurriculumLibraryService({withTenantTransaction:()=>{calls++;throw new Error('unexpected');}});
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{principalType:'SYSTEM_SERVICE'},{source:'AI'},{source:'PUBLIC_API'},{source:'AUTOMATION'},{source:'INTEGRATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])await assert.rejects(()=>service.create({...c(),...patch},input()),e=>e.getStatus()===403);
 await assert.rejects(()=>service.create({...c(),idempotencyKey:''},input()),e=>e.getStatus()===400);assert.equal(calls,0);
});
test('selector-free parent endpoint rejects all inputs and action headers',()=>{
 const req={method:'GET',headers:{},originalUrl:'/v1/parent/curriculum-library'};rejectParentLibraryInputs(req,{});
 for(const patch of [{originalUrl:req.originalUrl+'?'},{body:{}},{body:{familyId:randomUUID()}}])assert.throws(()=>rejectParentLibraryInputs({...req,...patch},{}),e=>e.getStatus()===400);
 for(const headers of [{'x-hon-source':'AI'},{'x-hon-action-request-id':randomUUID()},{'sec-fetch-site':'cross-site'}])assert.throws(()=>rejectParentLibraryInputs({...req,headers},{}),e=>e.getStatus()===403);
 assert.throws(()=>rejectParentLibraryInputs(req,{schoolId:randomUUID()}),e=>e.getStatus()===400);
});
test('human UI guard requires the configured same-origin fixed command and rejects delegated headers',()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://school.example';
 const guard=new CurriculumLibraryHumanUiGuard();const run=r=>guard.canActivate({switchToHttp:()=>({getRequest:()=>r})});
 try {const req={method:'POST',headers:{origin:'https://school.example','x-hon-human-command':'curriculum-library','content-type':'application/json'},query:{},originalUrl:'/v1/staff/schools/id/curriculum-library'};
  assert.equal(run(req),true);for(const patch of [{'x-hon-action-request-id':randomUUID()},{'x-hon-delegated-by-principal-id':randomUUID()},{'x-hon-source':'AI'},{origin:'https://other.example'},{'x-hon-human-command':'curriculum-progress'}])assert.throws(()=>run({...req,headers:{...req.headers,...patch}}));
 }finally{if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('source boundary has only dedicated functions and no remote network/provider/resource content execution',()=>{
 const service=readFileSync('src/curriculum/library.service.ts','utf8');
 assert.match(service,/hon\.read_staff_curriculum_library/);assert.match(service,/hon\.mutate_curriculum_resource/);assert.match(service,/hon\.read_parent_curriculum_library/);
 assert.doesNotMatch(service,/fetch\(|https?\.request|dns\.|invokeLLM|sendMessage|executeAction|FROM hon\./);
 const sql=readFileSync('../../packages/database/migrations/0132_private_curriculum_resource_library.sql','utf8');
 assert.match(sql,/CHECK\(state='INERT'\)/);assert.doesNotMatch(sql,/INSERT INTO hon\.(outbox_events|action_requests|work_items|communication_messages|ai_invocation_plans)/);
 assert.match(sql,/hon\.lock_curriculum_resource_actor/);assert.match(sql,/FOR SHARE/);
});
