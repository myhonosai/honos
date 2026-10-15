import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe,expect,it,vi } from 'vitest';
import { projectRevenuePlan, type RevenuePlanSnapshot } from '@hon/contracts';
import { RevenuePlanningWorkbench,RevenueProjectionView,planningRequest } from '../src/components/revenue-planning-workbench';
const org='11111111-1111-4111-8111-111111111111',school='22222222-2222-4222-8222-222222222222',plan='33333333-3333-4333-8333-333333333333';
const base=`/api/v1/organizations/${org}/schools/${school}/planning/revenue`;
const snapshot:RevenuePlanSnapshot={plan:{id:plan,version:1,algorithmVersion:'school-revenue-v1',input:{targetMonthlyMinor:100000,currency:'USD',targetFrom:'2026-11-01T00:00:00.000Z',targetTo:'2026-12-01T00:00:00.000Z',historyFrom:'2026-01-01T00:00:00.000Z',historyTo:'2026-01-31T00:00:00.000Z',baselineMethod:'CURRENT_MONTHLY_SCHEDULES',assumptions:{trialToMembership:0.5,activitiesPerLead:3}}},evidence:{currency:'USD',asOf:'2026-10-01T00:00:00.000Z',from:'2026-01-01T00:00:00.000Z',to:'2026-01-31T00:00:00.000Z',eligibleMonthlyMinor:50000,eligibleMemberships:5,activeMemberships:7,excludedMemberships:2,leads:40,bookedTrialLeads:20,completedTrialLeads:10,ambiguousTrialLeads:0},snapshotHash:'a'.repeat(64)};
describe('deterministic school revenue planning UI',()=>{
 it('loads no data or providers by default, keeps assumptions blank, and never promises financial or execution success',()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');try{const html=renderToStaticMarkup(<RevenuePlanningWorkbench/>);expect(fetcher).not.toHaveBeenCalled();
   for(const text of ['No verified school evidence loaded','no financial quantities or sample plans are substituted','planning.revenue.manage','Essential, Core and Complete','No AI/provider calls','financial advice or guarantees','Blank means unavailable','Save human plan and evidence only'])expect(html).toContain(text);
   expect(html).not.toContain('Revenue gap');expect(html).not.toContain('Human plan and immutable evidence saved');expect(html).not.toContain('aria-label="Revenue plan projection"');expect(html).toContain('<fieldset disabled=""');
  }finally{fetcher.mockRestore();}
 });
 it('renders exact evidence ratios, sources, validation metadata, assumptions and saved-versus-live provenance',()=>{
  const p=projectRevenuePlan(snapshot);const saved=renderToStaticMarkup(<RevenueProjectionView projection={p}/>),live=renderToStaticMarkup(<RevenueProjectionView projection={projectRevenuePlan(snapshot,'LIVE')}/>);
  expect(saved).toContain('IMMUTABLE SAVED EVIDENCE');expect(saved).not.toContain('LIVE EVIDENCE — NOT A SAVED REVISION');expect(live).toContain('LIVE EVIDENCE — NOT A SAVED REVISION');
  for(const text of ['Eligible recurring revenue at evidence capture','50,000','500000 / 1000000 = 0.5','CURRENT ELIGIBLE AVERAGE','HUMAN ASSUMPTION','SCOPED HISTORY','Conventional new-member price proxy','Quantity cap: 1,000,000,000','minimum eligible price sample: 5','minimum rate sample: 20','SINGLE_STATEMENT','not financial advice or a revenue guarantee','omits churn','not a collections forecast'])expect(saved).toContain(text);
  expect(saved).toContain(snapshot.snapshotHash);expect(saved).not.toMatch(/<script|dangerouslySetInnerHTML|invoiceId|payer|personId/);
 });
 it('missing evidence is explicitly unavailable and zero-baseline assumption never hides eligible source revenue',()=>{
  const s=structuredClone(snapshot);s.plan.input.assumptions={};s.evidence.eligibleMemberships=1;s.evidence.eligibleMonthlyMinor=10000;s.evidence.activeMemberships=1;s.evidence.excludedMemberships=0;s.evidence.leads=0;s.evidence.bookedTrialLeads=0;s.evidence.completedTrialLeads=0;s.plan.input.baselineMethod='ZERO_BASELINE';
  const html=renderToStaticMarkup(<RevenueProjectionView projection={projectRevenuePlan(s)}/>);expect(html).toContain('Not calculable');expect(html).toContain('No usable signal');expect(html).toContain('ASSUMPTION REQUIRED');expect(html).toContain('No human price/rate/activity assumptions supplied');expect(html).toContain('ZERO BASELINE is a human assumption');expect(html).toContain('10,000 USD minor units');expect(html).not.toContain('READY');
 });
 it('only fixed same-origin API URLs are fetched with no-store, session credentials and retained command keys',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({data:[]}),{status:200}));
  try{expect(await planningRequest(base)).toEqual([]);expect(fetcher).toHaveBeenLastCalledWith(base,expect.objectContaining({method:'GET',cache:'no-store',credentials:'same-origin'}));
   await planningRequest(`${base}/${plan}/versions`,{expectedVersion:1},'retained-key');expect(fetcher).toHaveBeenLastCalledWith(`${base}/${plan}/versions`,expect.objectContaining({method:'POST',headers:{'Content-Type':'application/json','X-HON-Human-Command':'revenue-planning','Idempotency-Key':'retained-key'}}));
   const count=fetcher.mock.calls.length;for(const url of ['https://attacker.test'+base,'//attacker.test'+base,base+'/../billing',base+'?provider=foo','/api/v1/hq/planning',base+'/bad-id'])await expect(planningRequest(url)).rejects.toThrow('Only the fixed same-origin');expect(fetcher).toHaveBeenCalledTimes(count);
  }finally{fetcher.mockRestore();}
 });
 it('failed/malformed success envelopes remain uncertain and never display raw SQL or contact details',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');try{
   for(const status of [401,403,409,500]){fetcher.mockResolvedValueOnce(new Response(JSON.stringify({detail:'SQL_SECRET private@example.test'}),{status}));await expect(planningRequest(base)).rejects.not.toThrow('SQL_SECRET');}
   for(const data of [{},{data:null},null]){fetcher.mockResolvedValueOnce(new Response(JSON.stringify(data),{status:200}));await expect(planningRequest(base)).rejects.toThrow('Outcome uncertain');}
  }finally{fetcher.mockRestore();}
 });
 it('route is registered exactly once and retry keys/timestamps/authority remain honest in source',()=>{
  const routes=JSON.parse(readFileSync(new URL('../public/manus-routes.json',import.meta.url),'utf8'));expect(routes.routes.filter((r:{path:string})=>r.path==='/staff/planning/revenue')).toHaveLength(1);
  const source=readFileSync(new URL('../src/components/revenue-planning-workbench.tsx',import.meta.url),'utf8');expect(source).toContain('new Map<string,{fingerprint:string;key:string}>');expect(source).toContain('old?.fingerprint!==fingerprint');expect(source).toContain('expectedVersion:projection?.plan.version??0');expect(source).toContain('targetFrom:i.targetFrom,targetTo:i.targetTo');expect(source).toContain('No success is assumed');expect(source).toContain('verified saved, but the plan list refresh failed');expect(source).toContain('setProjection(null);setPlans([]);setBase');expect(source).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML|invokeProvider|https:\/\//);
 });
});
