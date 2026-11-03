import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setLegacySales } from './saas-legacy-sales-simulation.mjs';
import { addUtcMonthsClamped, verifyUtcMonthFixtures } from './commercial-staging-month-fixtures.mjs';
import { saasUtcCalendarFunctions, verifySaasBillingSecurity } from './saas-billing-security.mjs';
import { DIVERGENT_PERIODS_SQL } from './saas-billing-utc-operator-check.mjs';
// Issue #100 / migration 0201: HON SaaS billing periods are UTC calendar months from the ORIGINAL anchor,
// whatever TimeZone the calling session, database default or reused pooled connection carries.
// Runs on the disposable Champions Club fixture through the real API services (RuntimeDatabaseService +
// SaasBillingService). Anchors are moved into the past with guards disabled (disposable fixture only);
// the system clock is never changed. No provider, payment, entitlement or credit effect.
// Fail-closed target guard (Manus review P2): exact disposable localhost fixture as node-postgres itself interprets
// the URLs, no PG* overrides, explicit client configs, then a server-side database/role/loopback/marker check below.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env),runtime={username:CHAMPIONS_RUNTIME_ROLE};
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
// One pooled connection, so every API call below reuses the SAME backend session (connection-pool reuse).
process.env.HON_RUNTIME_DATABASE_POOL_MAX='1';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const contracts=await import('@hon/contracts');
const db=new RuntimeDatabaseService(),api=new SaasBillingService(db);
const pool=db['getPool']();
const admin=new pg.Client(targets.owner);
const saasTables=['saas_provider_payment_refs','saas_provider_events','saas_checkout_sessions','saas_referral_payment_alerts','saas_free_periods','saas_account_credit_ledger','saas_reward_applications','saas_refund_history','saas_refund_requests',
 'saas_credit_threshold_events','saas_credit_ledger','saas_credit_reservations','saas_credit_allowances','saas_operation_prices','saas_pricing_versions','saas_provider_cost_evidence','saas_payment_evidence','saas_invoice_lines','saas_invoices','saas_invoice_sequences','saas_outbox','saas_audit','saas_requests','saas_subscription_history','saas_subscriptions','saas_founder_reservations','saas_catalog_offers','saas_catalog_plans','saas_catalog_versions'];
const K=()=>randomUUID(),iso=d=>new Date(d).toISOString(),NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
// Zones with DST in both hemispheres, half-hour/large offsets and both date-line extremes.
const ZONES=['UTC','America/New_York','Pacific/Kiritimati','Australia/Sydney','America/Los_Angeles','Asia/Kolkata','Pacific/Pago_Pago','Europe/London','America/St_Johns','Australia/Lord_Howe','Pacific/Chatham'];
// The exact read-only check an operator runs before deploying 0201 (shared module, so the tested text is the documented text).
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const O=Object.fromEntries([1,2,3,4,5,6,7].map(n=>[n,{id:randomUUID()}]));
const hq={id:randomUUID(),user:randomUUID(),subject:`saas-utc-owner-${randomUUID()}`};
async function withoutGuards(table,sql,params=[]){
 await admin.query('BEGIN');
 try{await admin.query(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);await admin.query(sql,params);await admin.query(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
}
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of saasTables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query('SET CONSTRAINTS ALL DEFERRED');
  for(const t of saasTables)await admin.query(`DELETE FROM hon.${t}`);
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const t of saasTables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  const orgIds=Object.values(O).map(o=>o.id);
  await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id=ANY($1::uuid[])',[orgIds]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1',[hq.id]);
  await admin.query('DELETE FROM hon.principals WHERE id=$1',[hq.id]);
  await admin.query('DELETE FROM hon.users WHERE id=$1',[hq.user]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgIds]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const session=async()=>(await pool.query("SELECT pg_backend_pid() pid,current_setting('TimeZone') tz")).rows[0];
// Leaves a session-level TimeZone on the single pooled connection, exactly like an earlier borrower would.
const leakZone=async zone=>{await pool.query("SELECT set_config('TimeZone',$1,false)",[zone]);return session();};
const cmd=(id,version,action,reasonCode)=>api.commandSubscription(hq.subject,id,{action,expectedVersion:version,reasonCode},K());
const subRow=async id=>(await admin.query('SELECT version,period_index,period_anchor_at,current_period_start,current_period_end FROM hon.saas_subscriptions WHERE id=$1',[id])).rows[0];
// Disposable fixture only: make the subscription look as if service started at `anchor` (UTC-correct period 0).
const rewind=(id,anchor)=>withoutGuards('saas_subscriptions',`UPDATE hon.saas_subscriptions SET service_started_at=$2::timestamptz,period_anchor_at=$2::timestamptz,
  period_index=0,current_period_start=$2::timestamptz,current_period_end=$3::timestamptz WHERE id=$1`,[id,anchor,addUtcMonthsClamped(anchor,1)]);
const pinned=async()=>(await admin.query(`SELECT array_agg(f ORDER BY f) FILTER (WHERE 'TimeZone=UTC'=ANY(p.proconfig)) ok,count(*)::int n
  FROM unnest($1::text[]) f JOIN pg_proc p ON p.oid=('hon.'||f)::regprocedure`,[saasUtcCalendarFunctions])).rows[0];
// A POSIX zone whose daylight time starts 5 days from now and ends ~45 days from now, so "now + 1 month"
// crosses a DST transition whatever day the proof runs (a fixed named zone would only on some dates).
const dstAroundNow=()=>{const doy=d=>Math.floor((Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-Date.UTC(d.getUTCFullYear(),0,1))/DAY)+1;
 const j=offset=>Math.min(365,doy(new Date(NOW+offset*DAY)));return `HON0HDT,J${j(5)}/0,J${j(45)}/0`;};

let commands=0,advances=0,drafts=0;
await admin.connect();
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection({query:(...a)=>pool.query(...a)},CHAMPIONS_RUNTIME_ROLE);
let databaseDefaultChanged=false;
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 await verifyUtcMonthFixtures(admin,'0201');

 // ---------- 1. forward-only migration: configuration only, every month-adding SaaS function pinned ----------
 const migration=await readFile(new URL('../migrations/0201_saas_billing_utc_calendar_periods.sql',import.meta.url),'utf8');
 const statements=migration.split('\n').filter(l=>l.trim()&&!l.startsWith('--'));
 assert.equal(statements[0],'BEGIN;');assert.equal(statements.at(-1),'COMMIT;');
 assert.equal(statements.length,saasUtcCalendarFunctions.length+2);
 assert.ok(statements.slice(1,-1).every(s=>/^ALTER FUNCTION hon\.[a-z_]+\([^)]*\) SET TimeZone = 'UTC';$/.test(s)),'0201 only changes function settings; no data, body or grant change');
 assert.deepEqual(await pinned(),{ok:[...saasUtcCalendarFunctions].sort(),n:saasUtcCalendarFunctions.length});
 await verifySaasBillingSecurity(admin,runtime.username);

 // ---------- fixture ----------
 await cleanup();
 await setLegacySales(admin,true);
 await admin.query('BEGIN');
 await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[hq.user,hq.subject,`${hq.user}@example.test`]);
 await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[hq.id,hq.user]);
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour')",[hq.id]);
 for(const[n,o]of Object.entries(O)){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`UTC Period Fixture Dojo ${n}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '30 days')",[o.id]);
 }
 await admin.query('COMMIT');
 const draft=structuredClone(contracts.SAAS_OWNER_APPROVED_DRAFT);draft.termsReference='Fixture HON plan terms v1 (not customer terms)';
 draft.founderProgram={...draft.founderProgram,eligibility:'NO_PRIOR_CATALOG_SUBSCRIPTION',reservationHoldDays:7,opensAt:iso(NOW-HOUR)};
 const d=await api.createCatalogDraft(hq.subject,draft,K());commands++;
 const cat=(await api.publishCatalog(hq.subject,d.catalog.catalogId,K())).catalog;commands++;
 const coreMonthly=cat.offers.find(o=>o.planCode==='CORE'&&o.offerKind==='REGULAR_MONTHLY');
 assert.equal(coreMonthly.priceMinor,14900);
 const sub={};
 for(const n of Object.keys(O)){
  sub[n]=(await api.recordSubscription(hq.subject,{source:'CATALOG_OFFER',organizationId:O[n].id,offerId:coreMonthly.offerId,founderReservationId:null},K())).subscription;commands++;
 }
 const first=await session();

 // ---------- 2. START_SERVICE under a non-UTC database default with a DST change inside the month ----------
 const posix=dstAroundNow();
 await admin.query(`ALTER DATABASE hon_champions_validation SET TimeZone = '${posix}'`);databaseDefaultChanged=true;
 // A fresh pool (new connections) picks up the database default, as a production role/database setting would.
 const db2=new RuntimeDatabaseService(),api2=new SaasBillingService(db2);
 try{
  assert.equal((await db2['getPool']().query("SELECT current_setting('TimeZone') tz")).rows[0].tz,posix);
  const sanity=(await db2['getPool']().query("SELECT to_char((clock_timestamp()+interval '1 month') AT TIME ZONE 'UTC','HH24:MI') naive,to_char((clock_timestamp() AT TIME ZONE 'UTC'),'HH24:MI') now_utc")).rows[0];
  assert.notEqual(sanity.naive,sanity.now_utc,'the default zone really moves naive month arithmetic by the DST hour');
  const started=(await api2.commandSubscription(hq.subject,sub[1].subscriptionId,{action:'START_SERVICE',expectedVersion:1,reasonCode:'SERVICE_STARTED'},K())).subscription;commands++;
  assert.equal(started.currentPeriod.index,0);assert.equal(started.currentPeriod.startsAt,started.serviceStartedAt);
  assert.equal(started.currentPeriod.endsAt,addUtcMonthsClamped(started.serviceStartedAt,1),'START_SERVICE period end is UTC + 1 month');
  assert.equal((await db2['getPool']().query("SELECT current_setting('TimeZone') tz")).rows[0].tz,posix,'caller session TimeZone restored');
 }finally{await db2.onModuleDestroy?.();await admin.query('ALTER DATABASE hon_champions_validation RESET TimeZone');databaseDefaultChanged=false;}
 for(const n of ['2','3','4','5','6','7']){await leakZone(ZONES[Number(n)%ZONES.length]);await cmd(sub[n].subscriptionId,1,'START_SERVICE','SERVICE_STARTED');commands++;}

 // ---------- 3. the production issue, reproduced through the real API path with the 0201 setting removed ----------
 // Disposable database only: RESET the pin on command_saas_subscription, advance a month-end anchor in an
 // America/New_York session, observe the session-dependent period, then restore the pin and prove the guard.
 const repro=sub[7].subscriptionId,reproAnchor='2026-01-31T02:00:00.000Z';
 await rewind(repro,reproAnchor);
 const signature='hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid)';
 await admin.query(`ALTER FUNCTION ${signature} RESET TimeZone`);
 try{
  await assert.rejects(verifySaasBillingSecurity(admin,runtime.username),/Unsafe HON subscription function hon\.command_saas_subscription|not pinned to UTC/,'the security verifier refuses an unpinned billing function');
  await leakZone('America/New_York');
  const wrong=(await cmd(repro,2,'ADVANCE_PERIOD','PERIOD_ELAPSED')).subscription;commands++;
  // UTC: Jan 31 02:00Z + 1 month = Feb 28 02:00Z. New York: Jan 30 21:00 EST + 1 month = Feb 28 21:00 EST = Mar 1 02:00Z,
  // and + 2 months crosses the March DST change: Mar 30 21:00 EDT = Mar 31 01:00Z instead of Mar 31 02:00Z.
  assert.deepEqual(wrong.currentPeriod,{index:1,startsAt:'2026-03-01T02:00:00.000Z',endsAt:'2026-03-31T01:00:00.000Z'},'pre-0201 behaviour reproduced');
  assert.notEqual(wrong.currentPeriod.startsAt,addUtcMonthsClamped(reproAnchor,1));
 }finally{
  await admin.query(`ALTER FUNCTION ${signature} SET TimeZone = 'UTC'`);
 }
 assert.deepEqual(await pinned(),{ok:[...saasUtcCalendarFunctions].sort(),n:saasUtcCalendarFunctions.length});
 await verifySaasBillingSecurity(admin,runtime.username);
 // The operator check finds exactly the row the unpinned session wrote, and nothing else.
 assert.deepEqual((await admin.query(DIVERGENT_PERIODS_SQL)).rows.map(r=>[r.id,iso(r.utc_period_start),iso(r.utc_period_end)]),
  [[repro,addUtcMonthsClamped(reproAnchor,1),addUtcMonthsClamped(reproAnchor,2)]]);
 // Same anchor, same New York session, pinned: UTC result.
 await rewind(sub[6].subscriptionId,reproAnchor);
 await leakZone('America/New_York');
 const right=(await cmd(sub[6].subscriptionId,2,'ADVANCE_PERIOD','PERIOD_ELAPSED')).subscription;commands++;
 assert.deepEqual(right.currentPeriod,{index:1,startsAt:addUtcMonthsClamped(reproAnchor,1),endsAt:addUtcMonthsClamped(reproAnchor,2)});
 assert.equal(right.currentPeriod.startsAt,'2026-02-28T02:00:00.000Z');

 // ---------- 4. ADVANCE_PERIOD sweep: month-end clamping, leap years, DST days, time of day, rotating sessions ----------
 // Every advance runs on the SAME pooled backend, left in a different TimeZone by the previous borrower.
 const anchors={2:'2024-01-31T23:59:59.999Z',3:'2024-02-29T12:00:00.000Z',4:'2025-03-09T07:30:00.000Z',5:'2025-10-26T00:30:00.000Z'};
 for(const[n,anchor]of Object.entries(anchors)){
  const id=sub[n].subscriptionId;await rewind(id,anchor);
  let version=(await subRow(id)).version;
  for(let idx=1;Date.parse(addUtcMonthsClamped(anchor,idx))<=Date.now();idx++){
   const zone=ZONES[(advances+Number(n))%ZONES.length];
   const before=await leakZone(zone);assert.equal(before.pid,first.pid,'single pooled backend reused');
   const x=(await cmd(id,version,'ADVANCE_PERIOD','PERIOD_ELAPSED')).subscription;commands++;advances++;version++;
   assert.deepEqual(x.currentPeriod,{index:idx,startsAt:addUtcMonthsClamped(anchor,idx),endsAt:addUtcMonthsClamped(anchor,idx+1)},`${anchor} period ${idx} in ${zone}`);
   const after=await session();assert.deepEqual(after,{pid:first.pid,tz:zone},'function-level UTC never leaks into, or out of, the pooled session');
  }
  await deny(cmd(id,version,'ADVANCE_PERIOD','PERIOD_ELAPSED'),422,'SAAS_PERIOD_NOT_ENDED');
  // Immutable history carries the same UTC periods.
  const hist=(await admin.query('SELECT period_index,current_period_start s,current_period_end e FROM hon.saas_subscription_history WHERE subscription_id=$1 AND period_index>0 ORDER BY version',[id])).rows;
  assert.ok(hist.length>=8);
  for(const h of hist)assert.deepEqual([iso(h.s),iso(h.e)],[addUtcMonthsClamped(anchor,h.period_index),addUtcMonthsClamped(anchor,h.period_index+1)]);
 }
 // Spot checks of the approved semantics on the leap-year month-end anchor.
 const leap=(await admin.query("SELECT current_period_start s FROM hon.saas_subscription_history WHERE subscription_id=$1 AND period_index=ANY('{1,2,13,25}') ORDER BY period_index",[sub[2].subscriptionId])).rows.map(r=>iso(r.s));
 assert.deepEqual(leap,['2024-02-29T23:59:59.999Z','2024-03-31T23:59:59.999Z','2025-02-28T23:59:59.999Z','2026-02-28T23:59:59.999Z']);

 // ---------- 5. B2 invoice service periods use the same UTC months ----------
 for(const[k,period]of [1,0,13,12,24,25].entries()){
  const zone=ZONES[(k*3+1)%ZONES.length];await leakZone(zone);
  const r=await api.createInvoiceDraft(hq.subject,{subscriptionId:sub[2].subscriptionId,periodIndex:period},K());commands++;drafts++;
  const inv=(await admin.query('SELECT service_period_start s,service_period_end e,description FROM hon.saas_invoices WHERE id=$1',[r.invoice.invoiceId])).rows[0];
  const [s,e]=[addUtcMonthsClamped(anchors[2],period),addUtcMonthsClamped(anchors[2],period+1)];
  assert.deepEqual([iso(inv.s),iso(inv.e)],[s,e],`invoice period ${period} in ${zone}`);
  assert.ok(inv.description.endsWith(`service period ${s.slice(0,10)} to ${e.slice(0,10)}`),inv.description);
  assert.equal((await session()).tz,zone);
 }

 // ---------- 6. no other effect; isolation ----------
 assert.deepEqual((await admin.query(DIVERGENT_PERIODS_SQL)).rows.map(r=>r.id),[repro],'only the deliberately unpinned reproduction diverges');
 const others=(await admin.query('SELECT count(*)::int n FROM hon.saas_subscriptions WHERE organization_id<>ALL($1::uuid[])',[Object.values(O).map(o=>o.id)])).rows[0].n;
 assert.equal(others,0,'no subscription outside the fixture organizations');
 const ev=(await admin.query(`SELECT (SELECT count(*) FROM hon.saas_requests WHERE status='COMPLETED')::int req,(SELECT count(*) FROM hon.saas_requests WHERE status<>'COMPLETED')::int open,
  (SELECT count(*) FROM hon.saas_audit)::int audit,(SELECT count(*) FROM hon.saas_outbox)::int outbox,
  (SELECT count(*) FROM hon.saas_subscriptions WHERE charges_enabled OR payment_status<>'NOT_BILLED')::int billed,
  (SELECT count(*) FROM hon.saas_credit_allowances)::int allowances,(SELECT count(*) FROM hon.saas_payment_evidence)::int payments`)).rows[0];
 assert.deepEqual(ev,{req:commands,open:0,audit:commands,outbox:commands,billed:0,allowances:0,payments:0});
 assert.equal((await session()).pid,first.pid);
 console.log(`PASS: 0201 UTC billing periods — ${commands} API commands on one reused pooled session across ${ZONES.length} zones and a DST-changing database default; ${advances} ADVANCE_PERIOD + ${drafts} invoice drafts match UTC month arithmetic (month-end clamping, leap years, DST days, time of day kept); pre-0201 drift reproduced only with the pin removed; verifier refuses unpinned billing month arithmetic; no billing, payment or credit effect.`);
}finally{
 if(databaseDefaultChanged)await admin.query('ALTER DATABASE hon_champions_validation RESET TimeZone').catch(e=>console.error('RESET FAILED',e));
 await admin.query("ALTER FUNCTION hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid) SET TimeZone = 'UTC'").catch(e=>console.error('REPIN FAILED',e));
 await setLegacySales(admin,false).catch(e=>console.error('RESTORE FAILED',e));
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),db.onModuleDestroy?.()]);}
}
