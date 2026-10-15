import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe,expect,it,vi } from 'vitest';
import { CampaignWorkbench,CampaignFunnelView,campaignRequest } from '../src/components/campaign-workbench';
import type { CampaignFunnel } from '@hon/contracts';
const id='11111111-1111-4111-8111-111111111111',base='/api/v1/marketing/campaigns';
describe('human campaign planning workbench',()=>{
 it('starts empty, makes no calls, has no actor/school inputs and labels budget and external effects honestly',()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');try{const html=renderToStaticMarkup(<CampaignWorkbench/>);expect(fetcher).not.toHaveBeenCalled();for(const text of ['Planned budget is not actual spend','No external publish/delivery','no actor or school inputs','historic free-text campaign labels stay unlinked','ACTIVE is a human planning status','No verified campaign or sample counts'])expect(html).toContain(text);expect(html).not.toContain('Organization UUID');expect(html).not.toContain('School UUID');expect(html).not.toContain('Aggregate campaign funnel');expect(html).not.toContain('Verified saved human');expect(html).toContain('<fieldset disabled=""');}finally{fetcher.mockRestore();}
 });
 it('renders real CRM aggregate counts only and explicitly declines inferred enrollment/revenue/spend',()=>{
  const funnel={campaign:{id},from:'2026-01-01T00:00:00.000Z',to:'2026-02-01T00:00:00.000Z',asOf:'2026-10-01T00:00:00.000Z',leads:4,trialLeads:2,trialAppointments:3,completedTrialAppointments:1,wonLeads:1,lostLeads:0,archivedLeads:0,enrollmentLinkage:'UNAVAILABLE',revenueLinkage:'UNAVAILABLE'} as CampaignFunnel;
  const html=renderToStaticMarkup(<CampaignFunnelView funnel={funnel}/>);for(const text of ['Recorded CRM cohort only','Counts may overlap','UNAVAILABLE','WON is not enrollment or payment','No contacts, raw attribution','actual spend, ROI or fabricated revenue'])expect(html).toContain(text);expect(html).not.toContain('email');
 });
 it('uses fixed same-origin credentials/header transport and never forwards arbitrary queries, accounts or origin URLs',async()=>{
  const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>({data:{id}})} as Response);try{
   expect(await campaignRequest(base,{expectedVersion:0},'retained-key')).toEqual({id});expect(mock).toHaveBeenCalledWith(base,expect.objectContaining({credentials:'same-origin',cache:'no-store',method:'POST',headers:expect.objectContaining({'X-HON-Human-Command':'marketing-campaign','Idempotency-Key':'retained-key'})}));
   const from='2026-01-01T00:00:00.000Z',to='2026-02-01T00:00:00.000Z';await campaignRequest(`${base}/${id}/funnel?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
   for(const url of [`https://evil.test${base}`,`//evil.test${base}`,`${base}?schoolId=${id}`,`${base}/${id}/publish`,`${base}/${id}/funnel?from=${from}&to=${to}&actorId=${id}`,`${base}/${id}/funnel?from=${from}&from=${from}&to=${to}`,'/api/v1/ai/providers','/api/v1/payments']){const n=mock.mock.calls.length;await expect(campaignRequest(url)).rejects.toThrow();expect(mock.mock.calls.length).toBe(n);}
  }finally{mock.mockRestore();}
 });
 it('redacts error bodies and distinguishes uncertain success from verified server data',async()=>{
  const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status:403,json:async()=>({detail:'PRIVATE_CONTACT secret'})} as Response);try{await expect(campaignRequest(base)).rejects.toThrow('Exact live school permission');mock.mockResolvedValue({ok:true,json:async()=>({})} as Response);await expect(campaignRequest(base)).rejects.toThrow('Outcome uncertain');}finally{mock.mockRestore();}
 });
 it('route manifest and implementation keep human saves separate from any downstream execution',()=>{
  const source=readFileSync('src/components/campaign-workbench.tsx','utf8');expect(source).toContain('retries.current');expect(source).toContain('clear()');expect(source).not.toMatch(/localStorage|sessionStorage|invokeLLM|publishCampaign|PaymentService/);const manifest=JSON.parse(readFileSync('public/manus-routes.json','utf8'));expect(manifest.routes.filter((r:{path:string})=>r.path==='/staff/marketing/campaigns')).toHaveLength(1);
 });
});
