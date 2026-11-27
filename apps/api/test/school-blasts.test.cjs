const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {SchoolBlastService}=require('../dist/school-blasts/school-blast.service.js');
const g=require('../dist/school-blasts/school-blast-human-ui.guard.js');
const c=require('@hon/contracts');
// 0621: school email and text blasts.
const blastId=randomUUID();
const zero=keys=>Object.fromEntries(keys.map(k=>[k,0]));
const blast=(over={})=>({blastId,name:'Open house',channel:'EMAIL',subject:'Hi {{first_name}}',body:'Hello {{first_name}}',audience:{groups:['ACTIVE_STUDENTS'],tags:[]},
 status:'DRAFT',version:1,sendAt:null,queuedAt:null,cancelledAt:null,recipientCount:null,outcomes:null,deliveries:null,
 createdAt:'2026-11-18T08:00:00.000Z',updatedAt:'2026-11-18T08:00:00.000Z',...over});
const queued=(over={})=>blast({status:'QUEUED',version:2,queuedAt:'2026-11-18T08:05:00.000Z',recipientCount:3,
 outcomes:{...zero(c.SCHOOL_BLAST_OUTCOMES),QUEUED:3,NO_CONSENT:1},deliveries:{...zero(c.SCHOOL_BLAST_DELIVERY_STATES),WAITING:3},...over});
const saveInput=(over={})=>({blastId:null,expectedVersion:0,name:'Open house',channel:'EMAIL',subject:'Hi {{first_name}}',body:'Hello {{first_name}}',
 audience:{groups:['ACTIVE_STUDENTS'],tags:[]},...over});
const ctx=(over={})=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),externalSubject:'oidc:owner',idempotencyKey:'',...over});
function db(rows,calls=[]){const q=async(sql,args)=>{calls.push([sql,args]);return /hon\.(read_school_blasts?|read_school_blast_audience|save_school_blast|send_school_blast|cancel_school_blast)\(/.test(sql)?{rows}:{rows:[]};};
 return {withTenantReadOnlyTransaction:async(_c,f)=>f({query:q}),withTenantTransaction:async(_c,f)=>f({query:q})};}
const k=ctx({idempotencyKey:'k1'});
const later=()=>new Date(Date.now()+3_600_000).toISOString();

test('reads and commands call only the 0621 functions with the session subject and verify the answer',async()=>{
 const calls=[];
 assert.equal((await new SchoolBlastService(db([{data:[{blastId,name:'Open house',channel:'EMAIL',status:'DRAFT',version:1,sendAt:null,queuedAt:null,recipientCount:null,updatedAt:'2026-11-18T08:00:00.000Z'}]}],calls)).list(ctx()))[0].blastId,blastId);
 assert(calls.some(([sql,args])=>sql.includes('hon.read_school_blasts($1)')&&args[0]==='oidc:owner'));
 assert.equal((await new SchoolBlastService(db([{data:blast()}])).get(ctx(),blastId)).status,'DRAFT');
 await assert.rejects(new SchoolBlastService(db([{data:blast({blastId:randomUUID()})}])).get(ctx(),blastId),e=>e.status===503,'the blast asked for');
 await assert.rejects(new SchoolBlastService(db([{data:blast({recipientCount:3})}])).get(ctx(),blastId),e=>e.status===503,'a draft has no recipients');
 await assert.rejects(new SchoolBlastService(db([{data:queued({recipientCount:4})}])).get(ctx(),blastId),e=>e.status===503,'queued count matches outcomes');
 await assert.rejects(new SchoolBlastService(db([{data:queued({deliveries:{...zero(c.SCHOOL_BLAST_DELIVERY_STATES),WAITING:2}})}])).get(ctx(),blastId),e=>e.status===503,'one delivery state per recipient');
 await assert.rejects(new SchoolBlastService(db([{data:{...blast(),email:'x@example.test'}}])).get(ctx(),blastId),e=>e.status===503,'no extra fields such as an address');
 const preview={blastId,version:1,channel:'EMAIL',matched:4,outcomes:{...zero(c.SCHOOL_BLAST_OUTCOMES),QUEUED:3,NO_CONSENT:1},sample:{firstName:'Ana',subject:'Hi Ana',body:'Hello Ana'}};
 assert.equal((await new SchoolBlastService(db([{data:preview}])).audience(ctx(),blastId)).matched,4);
 await assert.rejects(new SchoolBlastService(db([{data:{...preview,matched:5}}])).audience(ctx(),blastId),e=>e.status===503,'matched is the sum of outcomes');
 await assert.rejects(new SchoolBlastService(db([{data:{...preview,sample:null}}])).audience(ctx(),blastId),e=>e.status===503,'a sample when someone is reachable');
 // Commands
 const saved=await new SchoolBlastService(db([{data:{blast:blast(),replayed:false}}],calls)).save(k,saveInput());
 assert.equal(saved.blast.version,1);
 assert(calls.some(([sql,args])=>sql.includes('hon.save_school_blast($1,$2::jsonb,$3,$4::uuid,$5::uuid)')&&args[0]==='oidc:owner'&&args[2]==='k1'));
 await assert.rejects(new SchoolBlastService(db([{data:{blast:blast({body:'Other'}),replayed:false}}])).save(k,saveInput()),e=>e.status===503,'saved what was sent');
 // BL4 (0695): filters and picked people go to the database as given and must come back the same.
 const aud={groups:[],tags:[],filters:{noBelt:true,endsWithinDays:30,ageMin:5,ageMax:12},people:[blastId]};
 const filteredCalls=[];
 assert.deepEqual((await new SchoolBlastService(db([{data:{blast:blast({audience:aud}),replayed:false}}],filteredCalls)).save(k,saveInput({audience:aud}))).blast.audience,aud);
 assert.deepEqual(JSON.parse(filteredCalls.find(([sql])=>sql.includes('hon.save_school_blast('))[1][1]).audience,aud);
 await assert.rejects(new SchoolBlastService(db([{data:{blast:blast({audience:{...aud,people:[]}}),replayed:false}}])).save(k,saveInput({audience:aud})),e=>e.status===503,'saved the picked people');
 await assert.rejects(new SchoolBlastService(db([{data:{blast:blast({version:2}),replayed:false}}])).save(k,saveInput()),e=>e.status===503,'version moves by one');
 assert.equal((await new SchoolBlastService(db([{data:{blast:queued(),replayed:true}}])).send(k,{blastId,expectedVersion:1,sendAt:null})).replayed,true);
 await assert.rejects(new SchoolBlastService(db([{data:{blast:blast({version:2}),replayed:false}}])).send(k,{blastId,expectedVersion:1,sendAt:null}),e=>e.status===503,'send queues');
 const at=later();
 await assert.rejects(new SchoolBlastService(db([{data:{blast:queued(),replayed:false}}])).send(k,{blastId,expectedVersion:1,sendAt:at}),e=>e.status===503,'scheduled at the asked time');
 const cancelled=queued({status:'CANCELLED',version:3,sendAt:at,cancelledAt:'2026-11-18T08:06:00.000Z',deliveries:{...zero(c.SCHOOL_BLAST_DELIVERY_STATES),CANCELLED:3}});
 assert.equal((await new SchoolBlastService(db([{data:{blast:cancelled,replayed:false}}])).cancel(k,{blastId,expectedVersion:2})).blast.status,'CANCELLED');
 await assert.rejects(new SchoolBlastService(db([{data:{blast:queued({version:3}),replayed:false}}])).cancel(k,{blastId,expectedVersion:2}),e=>e.status===503);
});

test('only direct human commands; bad input never reaches the database; refusals map to closed codes',async()=>{
 const calls=[];const s=new SchoolBlastService(db([],calls));
 for(const over of [{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){
  await assert.rejects(s.list(ctx(over)),e=>e.status===403);
  await assert.rejects(s.save(ctx({...over,idempotencyKey:'k'}),saveInput()),e=>e.status===403);
 }
 await assert.rejects(s.list(ctx({idempotencyKey:'x'})),e=>e.status===409);
 await assert.rejects(s.get(ctx(),'not-a-uuid'),e=>e.status===400);
 await assert.rejects(s.save(ctx(),saveInput()),e=>e.status===409,'a command needs a key');
 for(const bad of [saveInput({name:''}),saveInput({name:' padded'}),saveInput({name:'two\nlines'}),saveInput({name:'x'.repeat(101)}),
  saveInput({subject:null}),saveInput({channel:'SMS'}),saveInput({channel:'MMS'}),saveInput({body:''}),saveInput({body:'\nlead'}),saveInput({body:'Hi {{favorite_color}}'}),
  saveInput({body:'Hi {first_name}}'}),saveInput({body:'x'.repeat(3501)}),saveInput({channel:'SMS',subject:null,body:'x'.repeat(1001)}),saveInput({body:'a\u0007b'}),
  saveInput({audience:{groups:[],tags:[]}}),saveInput({audience:{groups:['EVERYONE'],tags:[]}}),saveInput({audience:{groups:['TRIAL','TRIAL'],tags:[]}}),
  saveInput({audience:{groups:['TRIAL'],tags:['a','A']}}),saveInput({audience:{groups:['TRIAL'],tags:['<b>']}}),saveInput({audience:{groups:['TRIAL']}}),
  // BL4 (0695): closed filters and picked people.
  saveInput({audience:{groups:['TRIAL'],tags:[],filters:{}}}),saveInput({audience:{groups:['TRIAL'],tags:[],filters:{color:'red'}}}),
  saveInput({audience:{groups:['TRIAL'],tags:[],filters:{noBelt:true,rankId:blastId}}}),saveInput({audience:{groups:['TRIAL'],tags:[],filters:{endsWithinDays:45}}}),
  saveInput({audience:{groups:['TRIAL'],tags:[],filters:{endsWithinDays:30,endsFrom:'2026-12-01'}}}),saveInput({audience:{groups:['TRIAL'],tags:[],filters:{endsFrom:'2026-02-30'}}}),
  saveInput({audience:{groups:['TRIAL'],tags:[],filters:{ageMin:12,ageMax:5}}}),saveInput({audience:{groups:['TRIAL'],tags:[],filters:{ageMin:'5'}}}),
  saveInput({audience:{groups:['TRIAL'],tags:[],filters:{membership:'FROZEN'}}}),saveInput({audience:{groups:[],tags:[],people:[]}}),
  saveInput({audience:{groups:[],tags:[],people:['not-a-uuid']}}),saveInput({audience:{groups:[],tags:[],people:[blastId,blastId]}}),
  saveInput({audience:{groups:[],tags:[],people:Array.from({length:201},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`)}}),
  saveInput({audience:{groups:['TRIAL'],tags:[],extra:true}}),
  saveInput({blastId,expectedVersion:0}),saveInput({expectedVersion:1}),{...saveInput(),media:[]},(({body,...r})=>r)(saveInput())])
  await assert.rejects(s.save(k,bad),e=>e.status===400,JSON.stringify(bad).slice(0,120));
 for(const bad of [{blastId,expectedVersion:1,sendAt:new Date(Date.now()+30_000).toISOString()},{blastId,expectedVersion:1,sendAt:new Date(Date.now()+61*86_400_000).toISOString()},
  {blastId,expectedVersion:1,sendAt:'tomorrow'},{blastId,expectedVersion:1,sendAt:'2026-11-18T10:00:00Z'},{blastId,expectedVersion:0,sendAt:null},{blastId,expectedVersion:1}])
  await assert.rejects(s.send(k,bad),e=>e.status===400,JSON.stringify(bad));
 await assert.rejects(s.cancel(k,{blastId:'x',expectedVersion:1}),e=>e.status===400);
 assert.equal(calls.length,0);
 for(const [code,message,status,closedCode] of [['42501','SCHOOL_BLAST_FORBIDDEN',403,'SCHOOL_BLAST_FORBIDDEN'],['P0002','BLAST_NOT_FOUND',404,'BLAST_NOT_FOUND'],
   ['55000','BLAST_NOT_DRAFT',409,'BLAST_NOT_DRAFT'],['55000','BLAST_NOT_CANCELLABLE',409,'BLAST_NOT_CANCELLABLE'],['55000','BLAST_NO_RECIPIENTS',409,'BLAST_NO_RECIPIENTS'],
   ['55000','BLAST_AUDIENCE_TOO_LARGE',409,'BLAST_AUDIENCE_TOO_LARGE'],['55000','BLAST_DAILY_LIMIT',409,'BLAST_DAILY_LIMIT'],['22023','BLAST_TEXT_TOO_LONG',400,'BLAST_TEXT_TOO_LONG'],
   ['40001','VERSION_CONFLICT',409,'VERSION_CONFLICT'],['23505','IDEMPOTENCY_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED'],['22023','VALIDATION_FAILED',400,'VALIDATION_FAILED'],
   ['55000','SECRET',503,'SCHOOL_BLAST_UNAVAILABLE'],['55P03','SECRET',409,'SCHOOL_BLAST_CONFLICT'],['42501','SECRET',403,'SCHOOL_BLAST_FORBIDDEN'],['XX000','SECRET SQL',503,'SCHOOL_BLAST_UNAVAILABLE']]){
  const failing=new SchoolBlastService({withTenantTransaction:async()=>{throw Object.assign(new Error(message),{code});}});
  await assert.rejects(failing.cancel(k,{blastId,expectedVersion:1}),e=>e.status===status&&e.getResponse().code===closedCode&&!JSON.stringify(e.getResponse()).includes('SECRET'),`${code}/${message}`);
 }
});

test('guards use their own command names; merge tags fill like the database',()=>{
 assert.equal(new g.SchoolBlastReadHumanUiGuard().command,'marketing_blast.read');
 assert.equal(new g.SchoolBlastSaveHumanUiGuard().command,'marketing_blast.save');
 assert.equal(new g.SchoolBlastSendHumanUiGuard().command,'marketing_blast.send');
 assert.equal(new g.SchoolBlastCancelHumanUiGuard().command,'marketing_blast.cancel');
 const v={firstName:'Cara',lastName:'Park',schoolName:'Tiger Dojo',staffName:'Coach Sam'};
 assert.equal(c.renderSchoolBlast('Hi {{first_name}} {{last_name}} from {{staff_name}} at {{school_name}}',v),'Hi Cara Park from Coach Sam at Tiger Dojo');
 assert.equal(c.renderSchoolBlast('Hi {{first_name}}{{last_name}}',{...v,firstName:' ',lastName:''}),'Hi there');
 assert.equal(c.schoolBlastTextOk('Hi {{ first_name }}',1,10),false,'only exact merge tags');
});
