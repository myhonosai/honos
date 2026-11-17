const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {StaffTimeService}=require('../dist/staff-time/staff-time.service.js');
const g=require('../dist/staff-time/staff-time-human-ui.guard.js');
const c=require('@hon/contracts');
// 0468: the staff time clock and timesheets.
const person=randomUUID(),entryId=randomUUID();
const entry=(over={})=>({entryId,staffPrincipalId:person,localDate:'2026-11-18',clockInAt:'2026-11-18T17:00:00.000Z',clockOutAt:null,origin:'CLOCK',
 version:1,workedMinutes:null,updatedAt:'2026-11-18T17:00:00.000Z',...over});
const closed=(over={})=>entry({clockOutAt:'2026-11-19T01:00:00.000Z',workedMinutes:480,...over});
const clock=(over={})=>({timezone:'America/Los_Angeles',now:'2026-11-18T18:00:00.000Z',weekStart:'2026-11-16',open:entry(),todayShifts:[],entries:[entry()],approval:null,...over});
const sheet=(over={})=>({weekStart:'2026-11-16',timezone:'America/Los_Angeles',people:[{principalId:person,displayName:'Sam',scheduledMinutes:480,approval:null,entries:[closed()]}],...over});
const fix=(over={})=>({entryId:null,expectedVersion:0,staffPrincipalId:person,clockIn:'2026-11-18T09:00',clockOut:'2026-11-18T17:00',
 reason:'Forgot to clock in',...over});
const ctx=(over={})=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),externalSubject:'oidc:owner',idempotencyKey:'',...over});
function db(rows,calls=[]){const q=async(sql,args)=>{calls.push([sql,args]);return /hon\.(read_my_time_clock|read_staff_timesheet_week|staff_time_clock_punch|save_staff_time_entry|set_staff_timesheet_week)/.test(sql)?{rows}:{rows:[]};};
 return {withTenantReadOnlyTransaction:async(_c,f)=>f({query:q}),withTenantTransaction:async(_c,f)=>f({query:q})};}
const k=ctx({idempotencyKey:'k1'});

test('reads and commands call only the 0468 functions with the session subject and verify the answer',async()=>{
 const calls=[];
 assert.equal((await new StaffTimeService(db([{data:clock()}],calls)).myClock(ctx())).open.entryId,entryId);
 assert(calls.some(([sql,args])=>sql.includes('hon.read_my_time_clock($1)')&&args[0]==='oidc:owner'));
 await assert.rejects(new StaffTimeService(db([{data:clock({open:closed()})}])).myClock(ctx()),e=>e.status===503,'an open entry is open');
 await assert.rejects(new StaffTimeService(db([{data:clock({entries:[entry(),closed({entryId:randomUUID(),staffPrincipalId:randomUUID()})]})}])).myClock(ctx()),e=>e.status===503,'one person only');
 assert.equal((await new StaffTimeService(db([{data:sheet()}])).timesheet(ctx(),'2026-11-16')).people[0].entries[0].workedMinutes,480);
 await assert.rejects(new StaffTimeService(db([{data:sheet({weekStart:'2026-11-23'})}])).timesheet(ctx(),'2026-11-16'),e=>e.status===503);
 await assert.rejects(new StaffTimeService(db([{data:sheet({people:[{principalId:person,displayName:'Sam',scheduledMinutes:0,approval:null,entries:[closed({localDate:'2026-11-23'})]}]})}])).timesheet(ctx(),'2026-11-16'),e=>e.status===503,'entries stay in the week');
 await assert.rejects(new StaffTimeService(db([{data:sheet({people:[{principalId:person,displayName:'Sam',scheduledMinutes:0,approval:null,entries:[closed({staffPrincipalId:randomUUID()})]}]})}])).timesheet(ctx(),'2026-11-16'),e=>e.status===503,'entries belong to their person');
 // Punches
 assert.equal((await new StaffTimeService(db([{data:{entry:entry(),replayed:false}}])).punch(k,{action:'CLOCK_IN',expectedVersion:0})).entry.version,1);
 await assert.rejects(new StaffTimeService(db([{data:{entry:closed(),replayed:false}}])).punch(k,{action:'CLOCK_IN',expectedVersion:0}),e=>e.status===503,'clock in is open');
 await assert.rejects(new StaffTimeService(db([{data:{entry:entry({version:2,breaks:[]}),replayed:false}}])).punch(k,{action:'CLOCK_IN',expectedVersion:0}),e=>e.status===503,'no break fields in an answer');
 await assert.rejects(new StaffTimeService(db([{data:{entry:entry({version:2}),replayed:false}}])).punch(k,{action:'BREAK_START',expectedVersion:1}),e=>e.status===400,'no break actions');
 assert.equal((await new StaffTimeService(db([{data:{entry:closed({version:4}),replayed:true}}])).punch(k,{action:'CLOCK_OUT',expectedVersion:3})).replayed,true);
 await assert.rejects(new StaffTimeService(db([{data:{entry:entry({version:4}),replayed:false}}])).punch(k,{action:'CLOCK_OUT',expectedVersion:3}),e=>e.status===503,'clock out closes');
 // Manager fix and week decision
 assert.equal((await new StaffTimeService(db([{data:{entry:closed({origin:'MANAGER'}),replayed:false}}])).saveEntry(k,fix())).entry.origin,'MANAGER');
 await assert.rejects(new StaffTimeService(db([{data:{entry:closed({staffPrincipalId:randomUUID()}),replayed:false}}])).saveEntry(k,fix()),e=>e.status===503);
 await assert.rejects(new StaffTimeService(db([{data:{entry:closed({version:3}),replayed:false}}])).saveEntry(k,fix({entryId:randomUUID(),expectedVersion:2})),e=>e.status===503,'same entry id');
 await assert.rejects(new StaffTimeService(db([{data:{entry:closed({breakMinutes:0}),replayed:false}}])).saveEntry(k,fix()),e=>e.status===503,'no break fields in an answer');
 const decision={staffPrincipalId:person,weekStart:'2026-11-16',action:'APPROVE',expectedVersion:0};
 assert.equal((await new StaffTimeService(db([{data:{approval:{status:'APPROVED',version:1,decidedAt:'2026-11-23T10:00:00.000Z'},replayed:false}}])).decide(k,decision)).approval.status,'APPROVED');
 await assert.rejects(new StaffTimeService(db([{data:{approval:{status:'OPEN',version:1,decidedAt:'2026-11-23T10:00:00.000Z'},replayed:false}}])).decide(k,decision),e=>e.status===503);
});

test('only direct human commands; bad input never reaches the database; refusals map to closed codes',async()=>{
 const calls=[];const s=new StaffTimeService(db([],calls));
 for(const over of [{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){
  await assert.rejects(s.myClock(ctx(over)),e=>e.status===403);
  await assert.rejects(s.punch(ctx({...over,idempotencyKey:'k'}),{action:'CLOCK_IN',expectedVersion:0}),e=>e.status===403);
 }
 await assert.rejects(s.myClock(ctx({idempotencyKey:'x'})),e=>e.status===409);
 await assert.rejects(s.timesheet(ctx(),'2026-11-17'),e=>e.status===400,'a week starts on Monday');
 await assert.rejects(s.punch(ctx(),{action:'CLOCK_IN',expectedVersion:0}),e=>e.status===409,'a command needs a key');
 for(const bad of [{action:'CLOCK_IN',expectedVersion:1},{action:'CLOCK_OUT',expectedVersion:0},{action:'NAP',expectedVersion:1},{action:'BREAK_START',expectedVersion:1},{action:'BREAK_END',expectedVersion:1},{action:'CLOCK_IN',expectedVersion:0,at:'2026-11-18T09:00'},{action:'CLOCK_IN'}])
  await assert.rejects(s.punch(k,bad),e=>e.status===400,JSON.stringify(bad));
 for(const bad of [fix({reason:''}),fix({reason:'ok'}),fix({reason:' padded'}),fix({reason:'<b>bad</b>'}),fix({reason:'x'.repeat(301)}),fix({clockOut:'2026-11-18T09:00'}),
  fix({clockOut:'2026-11-19T09:01'}),fix({clockIn:'2026-02-30T09:00'}),fix({clockIn:'2026-11-18 09:00'}),fix({breaks:[]}),
  fix({entryId:entryId}),fix({expectedVersion:1}),{...fix(),extra:1},(({reason,...r})=>r)(fix())])
  await assert.rejects(s.saveEntry(k,bad),e=>e.status===400,JSON.stringify(bad));
 for(const bad of [{staffPrincipalId:person,weekStart:'2026-11-17',action:'APPROVE',expectedVersion:0},{staffPrincipalId:person,weekStart:'2026-11-16',action:'REOPEN',expectedVersion:0},
  {staffPrincipalId:person,weekStart:'2026-11-16',action:'LOCK',expectedVersion:0}])
  await assert.rejects(s.decide(k,bad),e=>e.status===400,JSON.stringify(bad));
 assert.equal(calls.length,0);
 for(const [code,message,status,closedCode] of [['42501','STAFF_TIME_FORBIDDEN',403,'STAFF_TIME_FORBIDDEN'],['42501','STAFF_MEMBER_UNAVAILABLE',403,'STAFF_MEMBER_UNAVAILABLE'],
   ['55000','TIME_CLOCK_STATE_CHANGED',409,'TIME_CLOCK_STATE_CHANGED'],['55000','TIMESHEET_APPROVED',409,'TIMESHEET_APPROVED'],['55000','TIME_ENTRY_TOO_LONG',409,'TIME_ENTRY_TOO_LONG'],
   ['55000','TIMESHEET_HAS_OPEN_ENTRY',409,'TIMESHEET_HAS_OPEN_ENTRY'],['23P01','TIME_ENTRY_OVERLAP',409,'TIME_ENTRY_OVERLAP'],['P0002','TIME_ENTRY_NOT_FOUND',404,'TIME_ENTRY_NOT_FOUND'],
   ['40001','VERSION_CONFLICT',409,'VERSION_CONFLICT'],['23505','IDEMPOTENCY_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED'],['22023','VALIDATION_FAILED',400,'VALIDATION_FAILED'],
   ['23P01','SECRET',503,'STAFF_TIME_UNAVAILABLE'],['55P03','SECRET',409,'STAFF_TIME_CONFLICT'],['XX000','SECRET SQL',503,'STAFF_TIME_UNAVAILABLE']]){
  const failing=new StaffTimeService({withTenantTransaction:async()=>{throw Object.assign(new Error(message),{code});}});
  await assert.rejects(failing.punch(k,{action:'CLOCK_IN',expectedVersion:0}),e=>e.status===status&&e.getResponse().code===closedCode&&!JSON.stringify(e.getResponse()).includes('SECRET'),`${code}/${message}`);
 }
});

test('guards use their own command names; summary totals hours only (no overtime, no pay); CSV cells never run as formulas',()=>{
 assert.equal(new g.StaffTimeReadHumanUiGuard().command,'staff_time.read');
 assert.equal(new g.StaffTimePunchHumanUiGuard().command,'staff_time.punch');
 assert.equal(new g.StaffTimeEntrySaveHumanUiGuard().command,'staff_time.entry.save');
 assert.equal(new g.StaffTimesheetDecideHumanUiGuard().command,'staff_timesheet.decide');
 const day=(d,m)=>c.verifyTimeEntry(closed({entryId:randomUUID(),localDate:d,workedMinutes:m}));
 const easy=c.summarizeTimesheet([day('2026-11-17',300),day('2026-11-16',480),day('2026-11-16',120)]);
 assert.deepEqual(easy,{workedMinutes:900,days:[{date:'2026-11-16',workedMinutes:600},{date:'2026-11-17',workedMinutes:300}],flags:[]});
 const week=c.summarizeTimesheet(['16','17','18','19','20','21'].map(d=>day(`2026-11-${d}`,600)));
 assert.deepEqual([week.workedMinutes,week.flags],[3600,[]],'a long week is just hours, never an overtime flag');
 assert.equal('overtimeMinutes' in week,false);
 const open=c.summarizeTimesheet([c.verifyTimeEntry(entry()),day('2026-11-17',1000)]);
 assert.deepEqual(open.flags,['STILL_CLOCKED_IN','LONG_ENTRY']);
 assert.equal(c.csvCell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');
 for(const v of ['+1','-1','@SUM(A1)','\tx']) assert(c.csvCell(v).startsWith('"\''),v);
 assert.equal(c.csvCell('Sam'),'"Sam"');
 assert.equal(c.csvCell(450),'"450"');
 assert.equal(c.csvCell(null),'""');
 assert.equal(c.localMinutesBetween('2026-11-18T23:00','2026-11-19T01:30'),150);
});
