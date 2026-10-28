import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateZernioConfiguration, validateZernioVerification, ZERNIO_VERIFY_CONFIRMATION } from '@hon/contracts';
import { translate } from '@hon/design-system';
import { ZernioController } from '../src/components/zernio-integration/controller';
import { ZernioIntegrationView } from '../src/components/zernio-integration/workbench';
import { loadZernioConfiguration, verifyZernioCredential } from '../src/components/zernio-integration/http';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
const configuration = validateZernioConfiguration({ provider: 'ZERNIO', credential: 'PRESENT', secretStorage: 'API_SERVER_ENVIRONMENT',
  verificationEnabled: true, externalActions: 'DISABLED', schoolConnections: 'NOT_CONFIGURED' });
const receipt = validateZernioVerification({ provider: 'ZERNIO', status: 'VALID', checkedAt: '2026-10-25T08:00:00.000Z', externalActions: 'DISABLED' });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function pending<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
afterEach(() => vi.unstubAllGlobals());

describe('Zernio explicit read-only transport', () => {
  it.each([false,true])('broadcasts authenticated HON 401 for verify=%s, but keeps 403 local', async verify => {
    const events = new EventTarget(), invalidated = vi.fn();
    events.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated);
    vi.stubGlobal('window',events);
    const run = verify ? verifyZernioCredential : loadZernioConfiguration;
    for (const status of [403,401]) {
      vi.stubGlobal('fetch',async()=>new Response('',{status}));
      await expect(run(new AbortController().signal)).rejects.toMatchObject({code:status===401?'UNAUTHORIZED':'FORBIDDEN'});
      expect(invalidated).toHaveBeenCalledTimes(status===401?1:0);
    }
  });
  it.each(['REJECTED','DENIED'] as const)('provider %s inside a successful HON receipt does not invalidate the HON session',async status=>{
    const events=new EventTarget(),invalidated=vi.fn();events.addEventListener(HON_SESSION_INVALIDATED_EVENT,invalidated);vi.stubGlobal('window',events);
    vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({data:{...receipt,status}}),{headers:{'content-type':'application/json'}}));
    expect((await verifyZernioCredential(new AbortController().signal)).status).toBe(status);expect(invalidated).not.toHaveBeenCalled();
  });
  it('uses fixed same-origin paths without keys, URL selectors, persistence or automatic retries', async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => { calls.push({ url, options });
      return new Response(JSON.stringify({ data: options.method === 'POST' ? receipt : configuration }), { headers: { 'content-type': 'application/json' } }); });
    await loadZernioConfiguration(new AbortController().signal);
    await verifyZernioCredential(new AbortController().signal);
    expect(calls.map(c=>c.url)).toEqual(['/api/v1/hq/integrations/zernio/configuration','/api/v1/hq/integrations/zernio/verify']);
    expect(calls[1]!.options).toMatchObject({ method:'POST',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
      body: JSON.stringify({ confirmation: ZERNIO_VERIFY_CONFIRMATION }) });
    expect(calls[1]!.options.headers).not.toHaveProperty('Authorization');
  });
  it.each([401,403,409,503])('fails closed on HTTP %s without interpreting a provider success', async status => {
    const fetch = vi.fn(async () => new Response('private upstream error', { status })); vi.stubGlobal('fetch',fetch);
    await expect(verifyZernioCredential(new AbortController().signal)).rejects.toBeDefined();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects credential leaks, invented activity and extra response envelope fields', async () => {
    for (const data of [{...configuration,key:'not-a-real-key'},{...configuration,externalActions:'ENABLED'},{...configuration,schoolConnections:'CONNECTED'}]) {
      vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}}));
      await expect(loadZernioConfiguration(new AbortController().signal)).rejects.toBeDefined();
    }
  });
});

describe('Zernio focus-loss and explicit restoration lifecycle', () => {
  it('conceals an error-only view and invalidates a late rejection without restoring the error',async()=>{
    const pendingRead=pending<typeof configuration>();let reads=0;
    const c=new ZernioController({configuration:()=>++reads===1?Promise.reject(Error('denied')):pendingRead.promise,verify:async()=>receipt});
    c.start();await flush();expect(c.snapshot().error).toBe(true);c.conceal();expect(c.snapshot()).toMatchObject({concealed:true,error:false});
    const restore=c.refresh();c.conceal();pendingRead.reject(Error('late private error'));await restore;
    expect(c.snapshot()).toMatchObject({concealed:true,error:false,busy:false,configuration:null,receipt:null});c.stop();
  });
  it('shared invalidation cancels a real transport read and late success cannot reveal facts',async()=>{
    const events=new EventTarget(),waiting=pending<Response>();vi.stubGlobal('window',events);
    let signal:AbortSignal|undefined;const fetch=vi.fn((_url:unknown,options:RequestInit)=>{signal=options.signal as AbortSignal;return waiting.promise;});vi.stubGlobal('fetch',fetch);
    const c=new ZernioController();events.addEventListener(HON_SESSION_INVALIDATED_EVENT,()=>c.conceal());c.start();
    events.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));expect(signal?.aborted).toBe(true);
    waiting.resolve(new Response(JSON.stringify({data:configuration}),{headers:{'content-type':'application/json'}}));
    // Wait for response parsing as well as request settlement.
    await new Promise(done=>setTimeout(done,0));expect(c.snapshot()).toMatchObject({concealed:true,busy:false,configuration:null,receipt:null,error:false});
    expect(fetch).toHaveBeenCalledTimes(1);c.stop();
  });
  it('loads configuration without ever automatically verifying the provider credential', async () => {
    const verify=vi.fn(async()=>receipt),c=new ZernioController({configuration:async()=>configuration,verify});
    c.start();await flush();expect(c.snapshot().configuration).toEqual(configuration);expect(verify).not.toHaveBeenCalled();
    c.conceal();expect(c.snapshot()).toMatchObject({concealed:true,configuration:null,receipt:null});await c.refresh();
    expect(c.snapshot().concealed).toBe(false);expect(verify).not.toHaveBeenCalled();c.stop();
  });
  it('settles an in-flight read behind the privacy shield and restores without page reload', async () => {
    const read=pending<typeof configuration>();let reads=0;
    const c=new ZernioController({configuration:()=>++reads===1?read.promise:Promise.resolve(configuration),verify:async()=>receipt});
    c.start();c.conceal();expect(c.snapshot()).toMatchObject({busy:true,concealed:true,configuration:null});
    read.resolve(configuration);await flush();expect(c.snapshot()).toMatchObject({busy:false,concealed:true,configuration:null});
    await c.refresh();expect(c.snapshot()).toMatchObject({busy:false,concealed:false,configuration});c.stop();
  });
  it('prevents double verification and hides a late receipt after focus loss', async () => {
    const waiting=pending<typeof receipt>(),verify=vi.fn(()=>waiting.promise);
    const c=new ZernioController({configuration:async()=>configuration,verify});c.start();await flush();
    const first=c.verify();await flush();await c.verify();expect(verify).toHaveBeenCalledTimes(1);
    c.conceal();waiting.resolve(receipt);await first;
    expect(c.snapshot()).toMatchObject({concealed:true,receipt:null,busy:false});await c.refresh();expect(c.snapshot().receipt).toBeNull();c.stop();
  });
  it('does not begin provider verification if focus is lost during the preceding access read', async () => {
    const waiting=pending<typeof configuration>();let reads=0;const verify=vi.fn(async()=>receipt);
    const c=new ZernioController({configuration:()=>++reads===1?Promise.resolve(configuration):waiting.promise,verify});c.start();await flush();
    const request=c.verify();c.conceal();waiting.resolve(configuration);await request;expect(verify).not.toHaveBeenCalled();c.stop();
  });
  it('repeated focus loss, revoked access and session expiration never reveal cached facts', async () => {
    let allowed=true;const waiting=pending<typeof configuration>();let reads=0;
    const c=new ZernioController({configuration:()=>{if(!allowed)throw Error('expired');return ++reads===2?waiting.promise:Promise.resolve(configuration);},verify:async()=>receipt});
    c.start();await flush();c.conceal();const restore=c.refresh();c.conceal();waiting.resolve(configuration);await restore;
    expect(c.snapshot().concealed).toBe(true);allowed=false;await c.refresh();expect(c.snapshot()).toMatchObject({concealed:true,error:true,configuration:null,receipt:null});c.stop();
  });
  it('does not let a destroyed instance callback change the restarted view', async () => {
    const old=pending<typeof configuration>();let reads=0;
    const c=new ZernioController({configuration:()=>++reads===1?old.promise:Promise.resolve(configuration),verify:async()=>receipt});
    c.start();c.stop();c.start();await flush();old.resolve({...configuration,credential:'MISSING',verificationEnabled:false});await flush();
    expect(c.snapshot().configuration).toEqual(configuration);expect(c.snapshot().busy).toBe(false);c.stop();
  });
  it('keeps verification disabled when server approval disappears before the click is processed', async () => {
    let enabled=true;const verify=vi.fn(async()=>receipt);
    const c=new ZernioController({configuration:async()=>({...configuration,verificationEnabled:enabled}),verify});c.start();await flush();enabled=false;
    await c.verify();expect(verify).not.toHaveBeenCalled();expect(c.snapshot()).toMatchObject({error:true,receipt:null});c.stop();
  });
});

describe('Zernio accessible translated presentation', () => {
  it('offers protected server setup without a browser API-key field or activation controls', () => {
    const html=renderToStaticMarkup(<ZernioIntegrationView view={{configuration,receipt:null,busy:false,concealed:false,error:false}} refresh={()=>{}} verify={()=>{}}/>);
    expect(html).toContain('node scripts/configure-zernio.mjs');expect(html).toContain('ZERNIO_API_KEY');
    expect(html).not.toContain('type="password"');expect(html).toContain('type="checkbox"');expect(html).toContain('aria-labelledby');
    expect(html).not.toContain('<main'); // The authenticated HQ shell owns the single main landmark.
    expect(html).toContain('Posting, messaging, advertising');expect(html).not.toContain('Publish now');
  });
  it('conceals configuration and receipts and supplies an explicit restoration action', () => {
    const html=renderToStaticMarkup(<ZernioIntegrationView view={{configuration:null,receipt:null,busy:false,concealed:true,error:false}} refresh={()=>{}} verify={()=>{}}/>);
    expect(html).toContain('Verify access and resume');expect(html).not.toContain('Server key present');expect(html).not.toContain('Credential accepted');
  });
  it.each(['en','ko','es'] as const)('has real %s translations for setup, errors, gates and all credential results', language => {
    for(const key of ['zernio.title','zernio.managed','zernio.safety','zernio.confirm','zernio.error','zernio.VALID','zernio.REJECTED','zernio.UNKNOWN'] as const) {
      expect(translate(language,key)).not.toBe(key);if(language!=='en')expect(translate(language,key)).not.toBe(translate('en',key));
    }
  });
});

