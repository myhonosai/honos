const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {encodeListCursor,decodeListCursor,cursorInstantSql}=require('../dist/foundation/list-cursor.js');

const school=randomUUID(),other=randomUUID(),id=randomUUID();
const shapes=['instant','uuid'];
const code=(fn)=>{try{fn();}catch(error){return error.getStatus?.()===400?error.getResponse().code:error;}return 'accepted';};

test('cursor round-trips only for the same list, school and filter',()=>{
 const cursor=encodeListCursor('crm.leads',school,{status:'WON'},['2026-02-01T08:30:00.654321Z',id]);
 assert.match(cursor,/^[A-Za-z0-9_-]+$/);
 assert.deepEqual(decodeListCursor(cursor,'crm.leads',school,{status:'WON'},shapes),['2026-02-01T08:30:00.654321Z',id]);
 assert.deepEqual(decodeListCursor(cursor,'crm.leads',school.toUpperCase(),{status:'WON'},shapes),['2026-02-01T08:30:00.654321Z',id]);
 assert.equal(code(()=>decodeListCursor(cursor,'crm.leads',other,{status:'WON'},shapes)),'INVALID_CURSOR');
 assert.equal(code(()=>decodeListCursor(cursor,'crm.leads',school,{status:null},shapes)),'INVALID_CURSOR');
 assert.equal(code(()=>decodeListCursor(cursor,'people.directory',school,{status:'WON'},shapes)),'INVALID_CURSOR');
 assert.equal(decodeListCursor(undefined,'crm.leads',school,{status:'WON'},shapes),null);
});

test('forged, truncated or wrongly shaped cursors are refused before any read',()=>{
 const valid=JSON.parse(Buffer.from(encodeListCursor('crm.leads',school,null,['2026-02-01T08:30:00.654321Z',id]),'base64url').toString());
 const enc=(value)=>Buffer.from(JSON.stringify(value)).toString('base64url');
 for(const bad of ['', '!!', 'a'.repeat(1025), enc([]), enc(null), enc({...valid,v:2}), enc({...valid,extra:1}), enc({...valid,k:[valid.k[0]]}),
   enc({...valid,k:['2026-02-01T08:30:00.654Z',id]}), enc({...valid,k:['2026-02-01T08:30:00.654321+00:00',id]}), enc({...valid,k:[valid.k[0],id.toUpperCase()]}),
   enc({...valid,k:[valid.k[0],'x']}), enc({...valid,k:[valid.k[0],5]}), Buffer.from('{not json').toString('base64url')])
  assert.equal(code(()=>decodeListCursor(bad,'crm.leads',school,null,shapes)),'INVALID_CURSOR',`accepted ${bad.slice(0,30)}`);
 assert.equal(code(()=>decodeListCursor(enc({...valid,k:['x\u0000y']}),'crm.leads',school,null,['text'])),'INVALID_CURSOR');
});

test('cursor instants are rendered in UTC microseconds regardless of session time zone',()=>{
 assert.equal(cursorInstantSql('lead.created_at'),`to_char(lead.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
});
