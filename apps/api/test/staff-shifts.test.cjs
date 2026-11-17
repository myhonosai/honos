const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {StaffShiftService}=require('../dist/staff-shifts/staff-shifts.service.js');
const {StaffShiftReadHumanUiGuard,StaffShiftSaveHumanUiGuard}=require('../dist/staff-shifts/staff-shifts-human-ui.guard.js');
const c=require('@hon/contracts');
// 0464: the staff shift schedule.
const person=randomUUID(),shiftId=randomUUID();
const shift=(over={})=>({shiftId,staffPrincipalId:person,date:'2026-11-18',start:'09:00',end:'17:00',startsAt:'2026-11-18T17:00:00.000Z',endsAt:'2026-11-19T01:00:00.000Z',
 position:'Front desk',note:null,status:'SCHEDULED',version:1,updatedAt:'2026-11-17T10:00:00.000Z',...over});
const week=(over={})=>({mode:'MANAGE',weekStart:'2026-11-16',timezone:'America/Los_Angeles',staff:[{principalId:person,displayName:'Sam'}],shifts:[shift()],
 availability:[{principalId:person,windows:[{weekday:3,start:'08:00',end:'18:00'}]}],...over});
const input=(over={})=>({shiftId:null,expectedVersion:0,staffPrincipalId:person,date:'2026-11-18',start:'09:00',end:'17:00',position:'Front desk',note:null,status:'SCHEDULED',...over});
const ctx=(over={})=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),externalSubject:'oidc:owner',idempotencyKey:'',...over});
function db(rows,calls=[]){const q=async(sql,args)=>{calls.push([sql,args]);return /hon\.(read_staff_shift_week|save_staff_shift)/.test(sql)?{rows}:{rows:[]};};
 return {withTenantReadOnlyTransaction:async(_c,f)=>f({query:q}),withTenantTransaction:async(_c,f)=>f({query:q})};}

test('week and save call only the 0464 functions with the session subject and verify the answer',async()=>{
 const calls=[];const s=new StaffShiftService(db([{data:week()}],calls));
 const w=await s.week(ctx(),'2026-11-16');
 assert.equal(w.shifts[0].position,'Front desk');
 assert(calls.some(([sql,args])=>sql.includes('hon.read_staff_shift_week($1,$2::date)')&&args[0]==='oidc:owner'&&args[1]==='2026-11-16'));
 await assert.rejects(new StaffShiftService(db([{data:week({weekStart:'2026-11-23'})}])).week(ctx(),'2026-11-16'),e=>e.status===503);
 await assert.rejects(new StaffShiftService(db([{data:week({shifts:[shift({staffPrincipalId:randomUUID()})]})}])).week(ctx(),'2026-11-16'),e=>e.status===503);
 await assert.rejects(new StaffShiftService(db([{data:week({shifts:[shift({date:'2026-11-23'})]})}])).week(ctx(),'2026-11-16'),e=>e.status===503);
 await assert.rejects(new StaffShiftService(db([{data:week({mode:'OWN'})}])).week(ctx(),'2026-11-16'),e=>e.status===503,'own mode never carries availability');
 const saving=new StaffShiftService(db([{data:{shift:shift(),replayed:false}}]));
 assert.equal((await saving.save(ctx({idempotencyKey:'k1'}),input())).shift.version,1);
 await assert.rejects(new StaffShiftService(db([{data:{shift:shift({version:3}),replayed:false}}])).save(ctx({idempotencyKey:'k1'}),input()),e=>e.status===503);
 await assert.rejects(new StaffShiftService(db([{data:{shift:shift({status:'CANCELLED',version:2}),replayed:false}}])).save(ctx({idempotencyKey:'k1'}),input({shiftId,expectedVersion:1})),e=>e.status===503);
 await assert.rejects(new StaffShiftService(db([{data:{shift:shift({shiftId:randomUUID(),version:2}),replayed:false}}])).save(ctx({idempotencyKey:'k1'}),input({shiftId,expectedVersion:1})),e=>e.status===503);
});

test('only direct human commands; bad input never reaches the database; refusals map to closed codes',async()=>{
 const calls=[];const s=new StaffShiftService(db([],calls));
 for(const over of [{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])
  await assert.rejects(s.week(ctx(over),'2026-11-16'),e=>e.status===403);
 await assert.rejects(s.week(ctx({idempotencyKey:'x'}),'2026-11-16'),e=>e.status===409);
 await assert.rejects(s.week(ctx(),'2026-11-17'),e=>e.status===400,'a week starts on Monday');
 await assert.rejects(s.save(ctx(),input()),e=>e.status===409);
 for(const bad of [input({expectedVersion:1}),input({status:'CANCELLED'}),input({shiftId,expectedVersion:0}),input({end:'09:10'}),input({start:'09:00',end:'01:00'}),
  input({end:'24:30'}),input({start:'00:00',end:'24:00'}),input({date:'2026-02-30'}),input({position:' x'}),input({position:'<b>'}),input({note:'x'.repeat(301)}),
  input({staffPrincipalId:'nope'}),{...input(),extra:1},(({note,...r})=>r)(input())])
  await assert.rejects(s.save(ctx({idempotencyKey:'k'}),bad),e=>e.status===400,JSON.stringify(bad));
 assert.equal(calls.length,0);
 for(const [code,message,status,closed] of [['42501','STAFF_SHIFT_FORBIDDEN',403,'STAFF_SHIFT_FORBIDDEN'],['42501','STAFF_MEMBER_UNAVAILABLE',403,'STAFF_MEMBER_UNAVAILABLE'],
   ['23P01','SHIFT_OVERLAP',409,'SHIFT_OVERLAP'],['55000','STAFF_SHIFT_CANCELLED',409,'STAFF_SHIFT_CANCELLED'],['P0002','STAFF_SHIFT_NOT_FOUND',404,'STAFF_SHIFT_NOT_FOUND'],
   ['40001','VERSION_CONFLICT',409,'VERSION_CONFLICT'],['23505','IDEMPOTENCY_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED'],['22023','VALIDATION_FAILED',400,'VALIDATION_FAILED'],
   ['23P01','SECRET',503,'STAFF_SHIFT_UNAVAILABLE'],['55P03','SECRET',409,'STAFF_SHIFT_CONFLICT'],['XX000','SECRET SQL',503,'STAFF_SHIFT_UNAVAILABLE']]){
  const failing=new StaffShiftService({withTenantTransaction:async()=>{throw Object.assign(new Error(message),{code});}});
  await assert.rejects(failing.save(ctx({idempotencyKey:'k'}),input()),e=>e.status===status&&e.getResponse().code===closed&&!JSON.stringify(e.getResponse()).includes('SECRET'),`${code}/${message}`);
 }
});

test('the guards use their own command names; availability helper',()=>{
 assert.equal(new StaffShiftReadHumanUiGuard().command,'staff_shift.read');
 assert.equal(new StaffShiftSaveHumanUiGuard().command,'staff_shift.save');
 assert.equal(c.shiftWithinAvailability({date:'2026-11-18',start:'09:00',end:'17:00'},[{weekday:3,start:'08:00',end:'18:00'}]),true);
 assert.equal(c.shiftWithinAvailability({date:'2026-11-18',start:'07:00',end:'17:00'},[{weekday:3,start:'08:00',end:'18:00'}]),false);
 assert.equal(c.shiftWithinAvailability({date:'2026-11-19',start:'09:00',end:'17:00'},[{weekday:3,start:'08:00',end:'18:00'}]),false);
 assert.equal(c.shiftWithinAvailability({date:'2026-11-19',start:'09:00',end:'17:00'},[]),true);
 assert.equal(c.staffShiftMinutes('00:00','16:00'),960);
 assert.equal(c.staffShiftMinutes('00:00','16:01'),null);
 assert.equal(c.isStaffShiftWeekStart('2026-11-16'),true);
 assert.equal(c.isStaffShiftWeekStart('2026-11-15'),false);
});
