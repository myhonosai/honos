const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {KaiJournalService}=require('../dist/kai-journal/kai-journal.service.js');
const {KaiJournalReadHumanUiGuard,KaiJournalSaveHumanUiGuard,KaiTeamJournalReadHumanUiGuard}=require('../dist/kai-journal/kai-journal-human-ui.guard.js');
const c=require('@hon/contracts');
// 0497: the Kai teaching journal (KJ1, no AI).
const entryId=randomUUID();
const entry=(over={})=>({entryId,taughtOn:'2026-11-17',className:'Kids 6-8',notes:'Roundhouse kick drills.\nPartner blocking.',topics:['Roundhouse kick','Blocking'],
 source:'SPOKEN',status:'ACTIVE',shared:false,version:1,createdAt:'2026-11-17T20:00:00.000Z',updatedAt:'2026-11-17T20:00:00.000Z',...over});
const read=(over={})=>({timezone:'America/Los_Angeles',today:'2026-11-17',from:'2026-11-10',to:'2026-11-17',entries:[entry()],...over});
const input=(over={})=>({entryId:null,expectedVersion:0,taughtOn:'2026-11-17',className:'Kids 6-8',notes:'Roundhouse kick drills.',topics:['Roundhouse kick'],source:'TYPED',status:'ACTIVE',shared:false,...over});
const team=(over={})=>({today:'2026-11-17',from:'2026-11-10',to:'2026-11-17',entries:[{entryId:randomUUID(),authorName:'Coach Lee',taughtOn:'2026-11-16',className:null,
 notes:'Footwork.',topics:['Footwork'],updatedAt:'2026-11-16T20:00:00.000Z'}],...over});
const ctx=(over={})=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),externalSubject:'oidc:coach',idempotencyKey:'',...over});
function db(rows,calls=[]){const q=async(sql,args)=>{calls.push([sql,args]);return /hon\.(read_kai_journal|read_kai_team_journal|save_kai_journal_entry)/.test(sql)?{rows}:{rows:[]};};
 return {withTenantReadOnlyTransaction:async(_c,f)=>f({query:q}),withTenantTransaction:async(_c,f)=>f({query:q})};}

test('read and save call only the 0497 functions with the session subject and verify the answer',async()=>{
 const calls=[];const s=new KaiJournalService(db([{data:read()}],calls));
 const r=await s.read(ctx(),'2026-11-10','2026-11-17');
 assert.equal(r.entries[0].notes,'Roundhouse kick drills.\nPartner blocking.');
 assert(calls.some(([sql,args])=>sql.includes('hon.read_kai_journal($1,$2::date,$3::date)')&&args[0]==='oidc:coach'&&args[1]==='2026-11-10'&&args[2]==='2026-11-17'));
 for(const bad of [read({from:'2026-11-11'}),read({entries:[entry({taughtOn:'2026-11-09'})]}),read({entries:[entry({status:'REMOVED',notes:null,className:null,topics:[]})]}),
  read({entries:[entry(),entry()]}),read({entries:[entry({taughtOn:'2026-11-12',entryId:randomUUID()}),entry()]}),read({entries:[{...entry(),author:'x'}]}),read({timezone:'bad zone'})])
  await assert.rejects(new KaiJournalService(db([{data:bad}])).read(ctx(),'2026-11-10','2026-11-17'),e=>e.status===503,JSON.stringify(bad));
 const saving=new KaiJournalService(db([{data:{entry:entry({source:'TYPED'}),replayed:false}}]));
 assert.equal((await saving.save(ctx({idempotencyKey:'k1'}),input())).entry.version,1);
 const removed=entry({status:'REMOVED',notes:null,className:null,topics:[],version:2});
 assert.equal((await new KaiJournalService(db([{data:{entry:removed,replayed:true}}])).save(ctx({idempotencyKey:'k2'}),input({entryId,expectedVersion:1,status:'REMOVED'}))).replayed,true);
 for(const bad of [{entry:entry({version:3}),replayed:false},{entry:entry({entryId:randomUUID(),version:2}),replayed:false},{entry:entry({version:2}),replayed:false},
  {entry:{...removed,notes:'kept'},replayed:false}])
  await assert.rejects(new KaiJournalService(db([{data:bad}])).save(ctx({idempotencyKey:'k1'}),input({entryId,expectedVersion:1,status:'REMOVED'})),e=>e.status===503,JSON.stringify(bad));
});

test('the team read calls only read_kai_team_journal, shows display names only and refuses drift; sharing must round-trip',async()=>{
 const calls=[];const t=await new KaiJournalService(db([{data:team()}],calls)).readTeam(ctx(),'2026-11-10','2026-11-17');
 assert.equal(t.entries[0].authorName,'Coach Lee');
 assert(calls.some(([sql,args])=>sql.includes('hon.read_kai_team_journal($1,$2::date,$3::date)')&&args[0]==='oidc:coach'));
 assert(!calls.some(([sql])=>/save_kai_journal_entry/.test(sql)),'no write path');
 const one=team().entries[0];
 for(const bad of [team({entries:[{...one,authorPrincipalId:randomUUID()}]}),team({entries:[{...one,version:1}]}),team({entries:[{...one,authorName:''}]}),
  team({entries:[{...one,taughtOn:'2026-11-09'}]}),team({entries:[one,one]}),team({from:'2026-11-11'}),team({entries:[{...one,notes:null}]})])
  await assert.rejects(new KaiJournalService(db([{data:bad}])).readTeam(ctx(),'2026-11-10','2026-11-17'),e=>e.status===503,JSON.stringify(bad));
 await assert.rejects(new KaiJournalService(db([])).readTeam(ctx({idempotencyKey:'x'}),'2026-11-10','2026-11-17'),e=>e.status===409);
 await assert.rejects(new KaiJournalService(db([])).readTeam(ctx({source:'ACTION_ENGINE'}),'2026-11-10','2026-11-17'),e=>e.status===403);
 const sharedCalls=[];
 assert.equal((await new KaiJournalService(db([{data:{entry:entry({source:'TYPED',shared:true}),replayed:false}}],sharedCalls)).save(ctx({idempotencyKey:'k3'}),input({shared:true}))).entry.shared,true);
 assert.equal(JSON.parse(sharedCalls.find(([sql])=>/save_kai_journal_entry/.test(sql))[1][1]).shared,true);
 await assert.rejects(new KaiJournalService(db([{data:{entry:entry({source:'TYPED',shared:false}),replayed:false}}])).save(ctx({idempotencyKey:'k4'}),input({shared:true})),e=>e.status===503);
 for(const bad of [input({shared:'yes'}),(({shared,...r})=>r)(input())])
  await assert.rejects(new KaiJournalService(db([])).save(ctx({idempotencyKey:'k'}),bad),e=>e.status===400,JSON.stringify(bad));
});

test('only direct human commands; bad input never reaches the database; refusals map to closed codes',async()=>{
 const calls=[];const s=new KaiJournalService(db([],calls));
 for(const over of [{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])
  await assert.rejects(s.read(ctx(over),'2026-11-10','2026-11-17'),e=>e.status===403);
 await assert.rejects(s.read(ctx({idempotencyKey:'x'}),'2026-11-10','2026-11-17'),e=>e.status===409);
 for(const [from,to] of [['2026-11-17','2026-11-10'],['2026-07-01','2026-11-17'],['2026-02-30','2026-03-01'],['x','2026-11-17']])
  await assert.rejects(s.read(ctx(),from,to),e=>e.status===400,`${from}..${to}`);
 await assert.rejects(s.save(ctx(),input()),e=>e.status===409,'a save needs a key');
 for(const bad of [input({expectedVersion:1}),input({status:'REMOVED'}),input({entryId,expectedVersion:0}),input({notes:''}),input({notes:' x'}),input({notes:'x'.repeat(2001)}),
  input({notes:'<script>'}),input({notes:'a\tb'}),input({className:''}),input({className:'a\nb'}),input({topics:['A','a']}),input({topics:Array.from({length:11},(_,i)=>`t${i}`)}),
  input({topics:['x'.repeat(41)]}),input({topics:['two  spaces']}),input({source:'AI'}),input({taughtOn:'2026-02-30'}),{...input(),extra:1},(({notes,...r})=>r)(input())])
  await assert.rejects(s.save(ctx({idempotencyKey:'k'}),bad),e=>e.status===400,JSON.stringify(bad));
 assert.equal(calls.length,0);
 for(const [code,message,status,closed] of [['42501','KAI_JOURNAL_FORBIDDEN',403,'KAI_JOURNAL_FORBIDDEN'],['P0002','KAI_JOURNAL_ENTRY_NOT_FOUND',404,'KAI_JOURNAL_ENTRY_NOT_FOUND'],
   ['55000','KAI_JOURNAL_ENTRY_REMOVED',409,'KAI_JOURNAL_ENTRY_REMOVED'],['40001','VERSION_CONFLICT',409,'VERSION_CONFLICT'],['23505','IDEMPOTENCY_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED'],
   ['40001','IDEMPOTENCY_IN_PROGRESS',409,'IDEMPOTENCY_IN_PROGRESS'],['22023','VALIDATION_FAILED',400,'VALIDATION_FAILED'],['22023','SCHOOL_TIMEZONE_INVALID',400,'VALIDATION_FAILED'],
   ['55P03','SECRET',409,'KAI_JOURNAL_CONFLICT'],['XX000','SECRET SQL',503,'KAI_JOURNAL_UNAVAILABLE']]){
  const failing=new KaiJournalService({withTenantTransaction:async()=>{throw Object.assign(new Error(message),{code});}});
  await assert.rejects(failing.save(ctx({idempotencyKey:'k'}),input()),e=>e.status===status&&e.getResponse().code===closed&&!JSON.stringify(e.getResponse()).includes('SECRET'),`${code}/${message}`);
 }
});

test('the guards use their own command names',()=>{
 assert.equal(new KaiJournalReadHumanUiGuard().command,'kai_journal.read');
 assert.equal(new KaiJournalSaveHumanUiGuard().command,'kai_journal.save');
 assert.equal(new KaiTeamJournalReadHumanUiGuard().command,'kai_journal.team_read');
});

test('recall turns questions into school-local ranges (en, ko, es); weeks run Monday to Sunday',()=>{
 const today='2026-11-18'; // a Wednesday
 const p=q=>{const r=c.kaiJournalPeriod(q,today);return [r.kind,r.from,r.to];};
 assert.deepEqual(p('What did we work on last week?'),['LAST_WEEK','2026-11-09','2026-11-15']);
 assert.deepEqual(p('지난주에 뭐 했지?'),['LAST_WEEK','2026-11-09','2026-11-15']);
 assert.deepEqual(p('¿Qué trabajamos la semana pasada?'),['LAST_WEEK','2026-11-09','2026-11-15']);
 assert.deepEqual(p('this week'),['THIS_WEEK','2026-11-16','2026-11-18']);
 assert.deepEqual(p('What did I teach yesterday'),['YESTERDAY','2026-11-17','2026-11-17']);
 assert.deepEqual(p('오늘'),['TODAY','2026-11-18','2026-11-18']);
 assert.deepEqual(p('last month'),['LAST_MONTH','2026-10-01','2026-10-31']);
 assert.deepEqual(p('este mes'),['THIS_MONTH','2026-11-01','2026-11-18']);
 assert.deepEqual(p('the last 10 days'),['LAST_DAYS','2026-11-09','2026-11-18']);
 assert.deepEqual(p('지난 3주'),['LAST_WEEKS','2026-10-29','2026-11-18']);
 assert.deepEqual(p('last 900 days'),['LAST_DAYS','2026-07-22','2026-11-18'],'clamped to the 120-day read');
 const d=c.kaiJournalPeriod('kicks?',today);assert.deepEqual([d.kind,d.from,d.to,d.understood],['DEFAULT','2026-11-05','2026-11-18',false]);
 assert.deepEqual([c.kaiJournalPeriod('last month','2026-01-15').from,c.kaiJournalPeriod('last month','2026-01-15').to],['2025-12-01','2025-12-31']);
 assert.equal(c.kaiJournalPeriod('last week','2026-11-16').from,'2026-11-09','Monday itself');
 for(const q of ['last week','last month','last 120 days','last 17 weeks','hoy']){const r=c.kaiJournalPeriod(q,today);assert(c.isKaiJournalRange(r.from,r.to),q);}
});

test('pattern suggestions follow the fixed rules and never exceed three',()=>{
 const today='2026-11-18';let n=0;
 const e=(taughtOn,topics)=>entry({entryId:randomUUID(),taughtOn,topics,createdAt:`2026-11-01T00:00:${String(n++%60).padStart(2,'0')}.000Z`});
 assert.deepEqual(c.kaiJournalSuggestions([],today),[]);
 // FOCUS: 5 of the last 7 classes in 28 days were roundhouse kicks.
 const focus=[e('2026-11-17',['Roundhouse kick']),e('2026-11-14',['roundhouse kick','Blocking']),e('2026-11-12',['Roundhouse kick']),e('2026-11-10',['Forms']),
  e('2026-11-06',['Roundhouse kick']),e('2026-11-03',['Sparring']),e('2026-10-30',['Roundhouse kick'])];
 assert.deepEqual(c.kaiJournalSuggestions(focus,today)[0],{kind:'FOCUS',topic:'Roundhouse kick',count:5,total:7});
 // REVISIT: Breakfalls twice, last 30 days ago; LOG not shown because there is a class in the last 7 days.
 const revisit=[e('2026-11-17',['Forms']),e('2026-10-19',['Breakfalls']),e('2026-10-05',['Breakfalls']),e('2026-09-01',['Stances']),e('2026-08-25',['Stances']),e('2026-08-01',['Old'])];
 const r=c.kaiJournalSuggestions(revisit,today);
 assert.deepEqual(r,[{kind:'REVISIT',topic:'Stances',daysAgo:78,count:2},{kind:'REVISIT',topic:'Breakfalls',daysAgo:30,count:2}]);
 // LOG + TAG: nothing in the last 7 days and the latest entries have no topics.
 const quiet=[e('2026-11-05',[]),e('2026-11-04',[]),e('2026-11-03',[]),e('2026-11-02',['Forms'])];
 assert.deepEqual(c.kaiJournalSuggestions(quiet,today),[{kind:'LOG',lastDate:'2026-11-05'},{kind:'TAG'}]);
 // Entries older than 90 days or in the future are ignored; removed entries never count.
 assert.deepEqual(c.kaiJournalSuggestions([e('2026-08-01',['A']),e('2026-07-30',['A']),e('2026-11-25',['A'])],today),[]);
 const many=[...focus,...revisit,...quiet];assert(c.kaiJournalSuggestions(many,today).length<=3);
 assert.deepEqual(c.kaiJournalTopicTally(focus).slice(0,2),[{topic:'Roundhouse kick',count:5},{topic:'Blocking',count:1}]);
 assert.deepEqual(c.kaiJournalTopicHints('We did roundhouse kick drills and some forms',[{topic:'Roundhouse kick',count:5},{topic:'Forms',count:2},{topic:'Sparring',count:1}],['forms']),['Roundhouse kick']);
});
