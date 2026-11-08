const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto');
const {encodeListCursor,decodeListCursor,cursorInstantSql,isCursorInstant,MAX_LIST_CURSOR_LENGTH}=require('../dist/foundation/list-cursor.js');

const school=randomUUID(),other=randomUUID(),id=randomUUID();
const shapes=['instant','uuid'];
const at='2026-02-01T08:30:00.654321Z';
const code=(fn)=>{try{fn();}catch(error){return error.getStatus?.()===400?error.getResponse().code:error;}return 'accepted';};
const split=(cursor)=>{const [payload,signature]=cursor.split('.');return {payload,signature,body:JSON.parse(Buffer.from(payload,'base64url').toString())};};
const repack=(cursor,body)=>`${Buffer.from(JSON.stringify(body)).toString('base64url')}.${split(cursor).signature}`;

test('signed cursor round-trips only for the same list, school and filter',()=>{
 const cursor=encodeListCursor('crm.leads',school,{status:'WON'},shapes,[at,id]);
 assert.match(cursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
 assert.deepEqual(decodeListCursor(cursor,'crm.leads',school,{status:'WON'},shapes),[at,id]);
 assert.deepEqual(decodeListCursor(cursor,'crm.leads',school.toUpperCase(),{status:'WON'},shapes),[at,id]);
 assert.equal(code(()=>decodeListCursor(cursor,'crm.leads',other,{status:'WON'},shapes)),'INVALID_CURSOR');
 assert.equal(code(()=>decodeListCursor(cursor,'crm.leads',school,{status:null},shapes)),'INVALID_CURSOR');
 assert.equal(code(()=>decodeListCursor(cursor,'people.directory',school,{status:'WON'},shapes)),'INVALID_CURSOR');
 assert.equal(decodeListCursor(undefined,'crm.leads',school,{status:'WON'},shapes),null);
});

test('valid-shaped tampering of any position key or a re-signed binding is refused',()=>{
 const cursor=encodeListCursor('crm.leads',school,null,shapes,[at,id]);
 const {body}=split(cursor);
 for(const k of [['2026-02-01T08:30:00.654322Z',id],['2025-02-01T08:30:00.654321Z',id],[at,randomUUID()],[at,id.replace(/^./,id[0]==='a'?'b':'a')]])
  assert.equal(code(()=>decodeListCursor(repack(cursor,{...body,k}),'crm.leads',school,null,shapes)),'INVALID_CURSOR',`accepted ${k}`);
 // A cursor minted for another school cannot be relabelled for this one: the signature covers the binding.
 const foreign=encodeListCursor('crm.leads',other,null,shapes,[at,id]);
 assert.equal(code(()=>decodeListCursor(foreign,'crm.leads',school,null,shapes)),'INVALID_CURSOR');
 // A client-minted signature (any 32 bytes) is refused.
 assert.equal(code(()=>decodeListCursor(`${split(cursor).payload}.${randomBytes(32).toString('base64url')}`,'crm.leads',school,null,shapes)),'INVALID_CURSOR');
 for(const bad of ['', '!!', 'a'.repeat(MAX_LIST_CURSOR_LENGTH+1), split(cursor).payload, `${split(cursor).payload}.`, `${cursor}.x`, Buffer.from('{not json').toString('base64url')])
  assert.equal(code(()=>decodeListCursor(bad,'crm.leads',school,null,shapes)),'INVALID_CURSOR',`accepted ${bad.slice(0,30)}`);
});

test('a session secret change invalidates cursors and the key never equals a process-random fallback',()=>{
 const previous=process.env.HON_SESSION_JWT_SECRET;
 try{
  process.env.HON_SESSION_JWT_SECRET=randomBytes(32).toString('hex');
  const cursor=encodeListCursor('crm.leads',school,null,shapes,[at,id]);
  assert.deepEqual(decodeListCursor(cursor,'crm.leads',school,null,shapes),[at,id]);
  process.env.HON_SESSION_JWT_SECRET=randomBytes(32).toString('hex');
  assert.equal(code(()=>decodeListCursor(cursor,'crm.leads',school,null,shapes)),'INVALID_CURSOR');
  delete process.env.HON_SESSION_JWT_SECRET;
  assert.equal(code(()=>decodeListCursor(cursor,'crm.leads',school,null,shapes)),'INVALID_CURSOR');
 }finally{ if(previous===undefined) delete process.env.HON_SESSION_JWT_SECRET; else process.env.HON_SESSION_JWT_SECRET=previous; }
});

test('instants must be real calendar times with exactly six fractional digits; the server never mints anything else',()=>{
 for(const good of [at,'2024-02-29T23:59:59.999999Z','2026-01-01T00:00:00.000000Z']) assert.equal(isCursorInstant(good),true,good);
 for(const bad of ['2026-02-30T08:30:00.654321Z','2026-02-01T99:99:99.654321Z','2025-02-29T00:00:00.000000Z','2026-13-01T00:00:00.000000Z','2026-02-01T08:30:00.654Z','2026-02-01T08:30:00.654321+00:00','2026-02-01T24:00:00.000000Z'])
  assert.equal(isCursorInstant(bad),false,bad);
 assert.throws(()=>encodeListCursor('crm.leads',school,null,shapes,['2026-02-30T08:30:00.654321Z',id]));
 assert.throws(()=>encodeListCursor('crm.leads',school,null,shapes,[at,id.toUpperCase()]));
 assert.throws(()=>encodeListCursor('people.directory',school,null,['uuid','version'],[id,'0']));
});

test('generated cursors are fixed-size and always fit the public bound',()=>{
 const people=encodeListCursor('people.directory',school,{query:'가'.repeat(160)},['uuid','version'],[id,String(Number.MAX_SAFE_INTEGER)]);
 const leads=encodeListCursor('crm.leads',school,{status:'ARCHIVED'},shapes,['9999-12-31T23:59:59.999999Z',id]);
 assert.ok(people.length<=MAX_LIST_CURSOR_LENGTH && leads.length<=MAX_LIST_CURSOR_LENGTH, `${people.length} ${leads.length}`);
 assert.ok(!Buffer.from(split(people).payload,'base64url').toString().includes('가'),'search text and names never travel in the cursor');
});

test('cursor instants are rendered in UTC microseconds regardless of session time zone',()=>{
 assert.equal(cursorInstantSql('lead.created_at'),`to_char(lead.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
});
