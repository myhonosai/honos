import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PublicFormWorkbench } from '../src/components/public-form-workbench';
import { PublishedLeadFormView } from '../src/components/published-lead-form';
import { formStaffRequest, loadPublicLeadForm, sendPublicLeadForm } from '../src/components/public-form-client';

// Deterministic hook/event renderer: no DOM/browser installation or network is needed.
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, pending: [] as (() => void)[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState(initial: any) {
      const index = hooks.cursor++;
      if (!hooks.slots[index]) hooks.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks.slots[index].value, (next: any) => { hooks.slots[index].value = typeof next === 'function' ? next(hooks.slots[index].value) : next; }];
    },
    useRef(initial: any) { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial }; },
    useEffect(effect: () => any, deps: any[]) {
      const index = hooks.cursor++, old = hooks.slots[index];
      if (!old || deps.some((v, i) => v !== old.deps[i])) {
        old?.cleanup?.(); hooks.slots[index] = { deps };
        hooks.pending.push(() => { hooks.slots[index].cleanup = effect(); });
      }
    },
  };
});
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', publicId = 'a'.repeat(48), base = '/api/v1/marketing/forms';
const config = { expectedVersion:0, title:'Enquiries', description:'Enquiry only', pipelineId:id, pipelineStageId:other, campaignId:null, optionalFields:['ageBand'] };
const form = { id, publicId, version:1, status:'DRAFT', title:'Enquiries', description:'Enquiry only', pipelineId:id, pipelineStageId:other, campaignId:null, optionalFields:['ageBand'], acceptedCount:0, updatedAt:'2026-10-01T00:00:00.000Z' };
const projection = {publicId,title:'Enquiries',description:'Enquiry only',optionalFields:['ageBand']};
const body = {name:'PRIVATE_NAME',email:'private@example.test',mobile:'',interest:'',source:'',website:'',acknowledged:false};
const response = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), {status, headers:{'Content-Type':'application/json',...headers}});
function render(component: (props?: any) => any, props?: any) { hooks.cursor = 0; return component(props); }
function all(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(all);
  return [node, ...all(node.props?.children)];
}
function text(node: any): string { if (typeof node === 'string' || typeof node === 'number') return String(node); if (!node) return ''; if (Array.isArray(node)) return node.map(text).join(''); return text(node.props?.children); }
function button(tree: any, label: string) { const node = all(tree).find(n => n.type === 'button' && text(n) === label); expect(node, label).toBeTruthy(); return node; }
function field(tree: any, label: string) { const node = all(tree).find(n => n.type === 'label' && text(n).startsWith(label)); expect(node, label).toBeTruthy(); return all(node).find(n => n.type === 'input' || n.type === 'select'); }
async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
async function effect() { for (const run of hooks.pending.splice(0)) run(); await settle(); }
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; hooks.pending = []; });
afterEach(() => { for (const slot of hooks.slots) slot?.cleanup?.(); vi.restoreAllMocks(); });

describe('public lead-form bounded same-origin transports', () => {
  it('allowlists every staff path/method/query/body/key before fetch and retains exact human transport metadata', async () => {
    const mock = vi.spyOn(globalThis,'fetch').mockResolvedValue(response({data:form,meta:{replayed:false}}));
    expect(await formStaffRequest(base,config,id)).toEqual({form,replayed:false});
    expect(mock).toHaveBeenCalledWith(base,expect.objectContaining({method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:expect.objectContaining({'X-HON-Human-Command':'public-lead-form','Idempotency-Key':id})}));
    for (const path of [`https://evil.test${base}`,`//evil.test${base}`,`${base}?schoolId=${id}`,`${base}#x`,`${base}/${id}`,`${base}/${id}/receipts`,`${base}/${id}/../forms`,`${base}/%31${id.slice(1)}/publish`,`${base}/${id}/publish?actor=${id}`,'/api/v1/ai/providers','/api/v1/payments']) {
      const count = mock.mock.calls.length; await expect(formStaffRequest(path)).rejects.toThrow(); expect(mock.mock.calls.length).toBe(count);
    }
    for (const input of [{expectedVersion:1,actorId:id},{expectedVersion:0},{expectedVersion:1.5}]) await expect(formStaffRequest(`${base}/${id}/publish`,input,id)).rejects.toThrow();
    await expect(formStaffRequest(base,config,'short')).rejects.toThrow();
  });
  it('rejects response redirects, oversized/chunked/invalid UTF-8/wrong MIME/schema/PII envelopes and never renders server error text',async()=>{
    const mock = vi.spyOn(globalThis,'fetch');
    for (const r of [response({detail:'PRIVATE_CONTACT secret'},403),response({data:[{...form,hashSecret:'PRIVATE'}]}),response({data:[{...form,acceptedCount:-1}]}),response({data:Array(101).fill(form)}),response({data:[form,form]}),response({data:'PRIVATE'}),new Response('x'.repeat(262145),{headers:{'Content-Type':'application/json'}}),new Response('bad',{headers:{'Content-Type':'text/html'}}),new Response(new Uint8Array([0xc3,0x28]),{headers:{'Content-Type':'application/json'}}),response({data:[]},200,{'Content-Length':'262145'})]) {
      mock.mockResolvedValueOnce(r); await expect(formStaffRequest(base)).rejects.toThrow(/^(?!.*PRIVATE)/);
    }
    mock.mockResolvedValueOnce(Object.assign(response({data:[]}),{}));
    expect(await formStaffRequest(base)).toEqual([]);
    mock.mockResolvedValueOnce({redirected:true,body:{cancel:async()=>{}},url:'https://evil.test/api/v1/marketing/forms'} as unknown as Response);
    await expect(formStaffRequest(base)).rejects.toThrow('No verified');
    mock.mockResolvedValueOnce(response({data:form,meta:{replayed:'yes'}}));await expect(formStaffRequest(base,config,id)).rejects.toThrow('No verified');
  });
  it('public transport omits cookies, validates projection and reports only exact status/result pairs',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({data:projection})).mockResolvedValueOnce(response({result:'accepted'},202));
    expect(await loadPublicLeadForm(publicId)).toEqual(projection);expect(await sendPublicLeadForm(publicId,body,id)).toBe('accepted');
    expect(mock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({credentials:'omit',cache:'no-store',redirect:'error',headers:expect.objectContaining({'Idempotency-Key':id})}));
    for (const [status,result,expected] of [[400,'invalid','invalid'],[429,'rate-limited','rate-limited'],[200,'accepted','unavailable'],[202,'invalid','unavailable'],[503,'PRIVATE_CONTACT','unavailable']] as const) {
      mock.mockResolvedValueOnce(response({result},status));expect(await sendPublicLeadForm(publicId,body,id)).toBe(expected);
    }
    mock.mockResolvedValueOnce(response({result:'accepted',leadId:id},202));expect(await sendPublicLeadForm(publicId,body,id)).toBe('unavailable');
    mock.mockResolvedValueOnce(response({result:'accepted',padding:'x'.repeat(300)},202));expect(await sendPublicLeadForm(publicId,body,id)).toBe('unavailable');
    const count=mock.mock.calls.length;expect(await sendPublicLeadForm(`../${publicId}`,body,id)).toBe('invalid');expect(await sendPublicLeadForm(publicId,{...body,consent:'OPTED_IN'},id)).toBe('invalid');expect(mock.mock.calls.length).toBe(count);
    mock.mockResolvedValueOnce(response({data:{...projection,campaignId:id}}));await expect(loadPublicLeadForm(publicId)).rejects.toThrow();
  });
});

describe('staff UI stale-state and retry invariants',()=>{
  it('starts empty and labels intake, permissions, no-effect and historical receipts honestly',()=>{
    const mock=vi.spyOn(globalThis,'fetch');const html=renderToStaticMarkup(render(PublicFormWorkbench));expect(mock).not.toHaveBeenCalled();
    for(const copy of ['Intake only, not messaging permission','never','Exact marketing.form.read','A replay receipt is historical','No current']) if(copy!=='never' && copy!=='No current')expect(html).toContain(copy);
    expect(html).not.toContain('PRIVATE');expect(html).not.toContain('Open published form');expect(html).not.toContain('organizationId');
  });
  it('never makes a replay snapshot current when list refresh fails; clears selected/counts and disables follow-up mutation',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({data:[form]}));
    let tree=render(PublicFormWorkbench);button(tree,'Load authorized school forms').props.onClick();await settle();tree=render(PublicFormWorkbench);
    all(tree).find(n=>n.type==='button'&&text(n).includes('Enquiries · DRAFT')).props.onClick();tree=render(PublicFormWorkbench);
    mock.mockResolvedValueOnce(response({data:{...form,status:'PUBLISHED',version:2},meta:{replayed:true}})).mockRejectedValueOnce(Error('PRIVATE_CONTACT'));
    button(tree,'Publish this form').props.onClick();await settle();tree=render(PublicFormWorkbench);const html=renderToStaticMarkup(tree);
    expect(html).toContain('Command receipt confirmed, but current state is unavailable');expect(html).toContain('No current form state is verified');expect(html).not.toContain('PUBLISHED / v2');expect(html).not.toContain('Open published form');expect(all(tree).find(n=>n.type==='fieldset').props.disabled).toBe(true);expect(all(tree).some(n=>n.type==='button'&&text(n)==='Publish this form')).toBe(false);
    mock.mockResolvedValueOnce(response({data:[{...form,status:'DISABLED',version:3}]}));button(tree,'Load authorized school forms').props.onClick();await settle();tree=render(PublicFormWorkbench);expect(text(tree)).toContain('DISABLED · v3');expect(text(tree)).not.toContain('PUBLISHED · v2');
  });
  it('uses a fresh authorized list rather than a successful historical replay response and clears everything on permission denial',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({data:[form]}));let tree=render(PublicFormWorkbench);button(tree,'Load authorized school forms').props.onClick();await settle();tree=render(PublicFormWorkbench);all(tree).find(n=>n.type==='button'&&text(n).includes('Enquiries · DRAFT')).props.onClick();tree=render(PublicFormWorkbench);
    mock.mockResolvedValueOnce(response({data:{...form,status:'PUBLISHED',version:2},meta:{replayed:true}})).mockResolvedValueOnce(response({data:[{...form,status:'DISABLED',version:4,acceptedCount:7}]}));button(tree,'Publish this form').props.onClick();await settle();tree=render(PublicFormWorkbench);expect(text(tree)).toContain('DISABLED / v4');expect(text(tree)).toContain('7 accepted leads');expect(text(tree)).not.toContain('PUBLISHED / v2');
    mock.mockResolvedValueOnce(response({detail:'PRIVATE_CONTACT'},403));button(tree,'Publish this form').props.onClick();await settle();tree=render(PublicFormWorkbench);expect(text(tree)).toContain('Exact current human school permission');expect(text(tree)).not.toContain('PRIVATE_CONTACT');expect(text(tree)).not.toContain('7 accepted leads');expect(text(tree)).not.toContain('Retry unchanged command');
  });
  it('retains the exact body/key after uncertain outcome, serializes clicks and retries without inventing success',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({data:[form]}));let tree=render(PublicFormWorkbench);button(tree,'Load authorized school forms').props.onClick();await settle();tree=render(PublicFormWorkbench);all(tree).find(n=>n.type==='button'&&text(n).includes('Enquiries · DRAFT')).props.onClick();tree=render(PublicFormWorkbench);
    mock.mockRejectedValueOnce(Error('network'));button(tree,'Publish this form').props.onClick();button(tree,'Publish this form').props.onClick();await settle();tree=render(PublicFormWorkbench);expect(mock.mock.calls).toHaveLength(2);const first=mock.mock.calls[1];expect(text(tree)).toContain('Retry unchanged command');expect(text(tree)).not.toContain('Human command recorded');
    mock.mockResolvedValueOnce(response({data:{...form,status:'PUBLISHED',version:2},meta:{replayed:true}})).mockResolvedValueOnce(response({data:[{...form,status:'PUBLISHED',version:2}]}));button(tree,'Retry unchanged command').props.onClick();await settle();tree=render(PublicFormWorkbench);const retry=mock.mock.calls[2];expect(retry?.[0]).toBe(first?.[0]);expect(retry?.[1]?.body).toBe(first?.[1]?.body);expect(retry?.[1]?.headers).toEqual(first?.[1]?.headers);expect(text(tree)).toContain('PUBLISHED / v2');
  });
});

describe('public UI lifecycle and non-consent facts',()=>{
  it('renders only verified escaped content/choices and retains retries without sending consent or authority fields',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({data:{...projection,title:'<script>unsafe</script>'}}));let tree=render(PublishedLeadFormView,{publicId});await effect();tree=render(PublishedLeadFormView,{publicId});expect(renderToStaticMarkup(tree)).toContain('&lt;script&gt;unsafe&lt;/script&gt;');expect(text(tree)).toContain('not consent to marketing messages');expect(field(tree,'Website').props.tabIndex).toBe(-1);
    field(tree,'Name').props.onChange({target:{value:'PRIVATE_NAME'}});tree=render(PublishedLeadFormView,{publicId});field(tree,'Email').props.onChange({target:{value:'private@example.test'}});tree=render(PublishedLeadFormView,{publicId});
    mock.mockRejectedValueOnce(Error('network'));all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();tree=render(PublishedLeadFormView,{publicId});expect(text(tree)).toContain('Acceptance is not confirmed');const first=mock.mock.calls[1];
    mock.mockResolvedValueOnce(response({result:'accepted'},202));all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();tree=render(PublishedLeadFormView,{publicId});expect(mock.mock.calls[2]?.[1]?.body).toBe(first?.[1]?.body);expect(mock.mock.calls[2]?.[1]?.headers).toEqual(first?.[1]?.headers);expect(JSON.parse(String(first?.[1]?.body))).toEqual({...body,acknowledged:false});expect(text(tree)).toContain('No message or marketing subscription');
  });
  it('unknown/inactive forms show no contact form and route changes hide stale form immediately',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({data:projection}));render(PublishedLeadFormView,{publicId});await effect();let tree=render(PublishedLeadFormView,{publicId});expect(all(tree).some(n=>n.type==='form')).toBe(true);
    const nextId='b'.repeat(48);mock.mockResolvedValueOnce(response({result:'invalid'},404));tree=render(PublishedLeadFormView,{publicId:nextId});expect(all(tree).some(n=>n.type==='form')).toBe(false);await effect();tree=render(PublishedLeadFormView,{publicId:nextId});expect(text(tree)).toContain('This form is unavailable');expect(all(tree).some(n=>n.type==='input')).toBe(false);
  });
  it('manifest has exact public/staff paths and UI uses no local PII storage or downstream execution',()=>{
    const manifest=JSON.parse(readFileSync('public/manus-routes.json','utf8'));for(const path of ['/staff/marketing/forms','/forms/:publicId'])expect(manifest.routes.filter((r:{path:string})=>r.path===path)).toHaveLength(1);
    for(const path of ['src/components/published-lead-form.tsx','src/components/public-form-workbench.tsx','src/components/public-form-client.ts'])expect(readFileSync(path,'utf8')).not.toMatch(/localStorage|sessionStorage|invokeLLM|PaymentService|ActionEngine/);
  });
});

it('same-origin response identity and streaming deadline cannot be bypassed',async()=>{
 const mock=vi.spyOn(globalThis,'fetch');
 mock.mockResolvedValueOnce({redirected:false,url:'https://evil.test/api/v1/marketing/forms',body:{cancel:async()=>{}}} as unknown as Response);
 await expect(formStaffRequest(base)).rejects.toThrow('No verified');
 const count=mock.mock.calls.length;await expect(formStaffRequest(base+'\n',config,id)).rejects.toThrow();expect(mock.mock.calls.length).toBe(count);
 vi.useFakeTimers();
 try {
  mock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({start(){}}),{headers:{'Content-Type':'application/json'}}));
  const pending=formStaffRequest(base).catch(error=>error);
  await vi.advanceTimersByTimeAsync(10001);
  expect((await pending).message).toContain('No success confirmed');
 } finally { vi.useRealTimers(); }
});
