import React from 'react';
import { describe,expect,it,vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { VOICE_DRAFT_NOTICE,validateVoiceSession,type VoiceSession } from '@hon/contracts';
import { VoiceWorkspace } from '../src/components/voice-workspace';
import { changeVoiceSession,readVoiceSession,VoiceAccessError } from '../src/components/voice-http';
const school='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const session:VoiceSession={id,schoolId:school,organizationId:'33333333-3333-4333-8333-333333333333',actorPrincipalId:'44444444-4444-4444-8444-444444444444',agentCatalogId:'alex',workItemId:null,actionRequestId:null,approvalId:null,resumeSessionId:null,state:'REQUESTED',reasonCode:null,version:1,draftText:null,draftNotice:VOICE_DRAFT_NOTICE,createdAt:'2026-10-15T16:00:00.000Z',updatedAt:'2026-10-15T16:00:00.000Z',expiresAt:'2026-10-15T16:30:00.000Z',expired:false,providerConnected:false,executionTriggered:false};
const response=(data:unknown)=>({ok:true,json:async()=>({data})}) as Response;
describe('provider-independent human voice handoff UI',()=>{
 it('starts honest unavailable with no microphone, connected animation or command sender',()=>{
  const html=renderToStaticMarkup(<VoiceWorkspace/>);expect(html).toContain('Voice unavailable');expect(html).toContain('no provider is connected');expect(html).toContain('No microphone access');expect(html).toContain('No verified session loaded');expect(html).toContain('Parent, Eian, HQ and public use are not supported');expect(html).not.toContain('Listening');expect(html).not.toContain('Speaking');expect(html).not.toContain('Send command');
  const source=readFileSync(new URL('../src/components/voice-workspace.tsx',import.meta.url),'utf8');expect(source).toContain('VOICE_DRAFT_NOTICE');expect(VOICE_DRAFT_NOTICE).toContain('Saving text does not send a command')
 });
 it('uses fixed same-origin trusted UI transport and exact immutable retry key',async()=>{
  const fetcher=vi.fn().mockResolvedValue(response({session,receiptVersion:1,replayed:false}));vi.stubGlobal('fetch',fetcher);
  const key='55555555-5555-4555-8555-555555555555';await changeVoiceSession(school,'create',null,{agentCatalogId:'alex'},key);
  const [url,options]=fetcher.mock.calls[0]!;expect(url).toBe(`/api/v1/staff/voice/${school}`);expect(options.credentials).toBe('same-origin');expect(options.cache).toBe('no-store');expect(options.headers['X-HON-Human-Command']).toBe('voice-session');expect(options.headers['Idempotency-Key']).toBe(key);expect(JSON.parse(options.body)).toEqual({agentCatalogId:'alex'});
  fetcher.mockResolvedValue(response(session));await readVoiceSession(school,id);expect(fetcher.mock.calls[1]![1].headers['X-HON-Human-Command']).toBe('voice-session');vi.unstubAllGlobals();
 });
 it('denies poisoned, expanded, cross-scope and fake-success evidence',async()=>{
  for(const patch of [{providerConnected:true},{executionTriggered:true},{state:'CONNECTED'},{agentCatalogId:'eian'},{rawTranscript:'private'},{draftText:'secret token'},{draftText:'private@example.test'},{reasonCode:'private provider detail'},{draftNotice:'Text sends a command'},{version:0},{version:1.2},{createdAt:'invalid'},{draftText:'General operations.'}])expect(()=>validateVoiceSession({...session,...patch})).toThrow();
  for(const value of [{...session,schoolId:id},{...session,id:school},{...session,providerCredentials:{secret:'private'}}]){vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(value)));await expect(readVoiceSession(school,id)).rejects.toThrow();}vi.unstubAllGlobals();
 });
 it('keeps drafts private and accepts historical version receipts without regressing evidence',async()=>{
  const ended={...session,state:'ENDED',version:4,draftText:'General school operations.'};vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({session:ended,receiptVersion:3,replayed:true})));
  const r=await changeVoiceSession(school,'mark-fallback',id,{expectedVersion:2,reasonCode:'NOT_CONFIGURED',draftText:'General school operations.'},'55555555-5555-4555-8555-555555555555');expect(r.session.state).toBe('ENDED');expect(r.receiptVersion).toBe(3);expect(r.replayed).toBe(true);vi.unstubAllGlobals();
 });
 it('clears private state on access errors and guards late responses / scope switches',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403}));await expect(readVoiceSession(school,id)).rejects.toBeInstanceOf(VoiceAccessError);vi.unstubAllGlobals();
  const source=readFileSync(new URL('../src/components/voice-workspace.tsx',import.meta.url),'utf8');expect(source).toContain('generation!==epoch.current');expect(source).toContain('VoiceAccessError) clearPrivate()');expect(source).toContain('pending.current=null');expect(source).toContain('Retry exact request');expect(source).toContain('Client offline');expect(source).toContain('Outcome unknown');expect(source).toContain('VOICE_DRAFT_NOTICE');
  for(const pattern of ['getUserMedia','MediaRecorder','SpeechRecognition','AudioContext','WebSocket','localStorage','sessionStorage','EventSource'])expect(source).not.toContain(pattern);
 });
 it('rejects draft/control plane shapes before sending anything and registers authenticated route',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(changeVoiceSession(school,'create',null,{agentCatalogId:'alex',provider:'raw'},'55555555-5555-4555-8555-555555555555')).rejects.toThrow();
  await expect(changeVoiceSession(school,'mark-fallback',id,{expectedVersion:1,reasonCode:'NOT_CONFIGURED',draftText:'token private'},'55555555-5555-4555-8555-555555555555')).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();vi.unstubAllGlobals();
  const routes=JSON.parse(readFileSync(new URL('../public/manus-routes.json',import.meta.url),'utf8'));expect(routes.routes.some((r:{path:string})=>r.path==='/staff/voice')).toBe(true);
  const page=readFileSync(new URL('../src/app/staff/voice/page.tsx',import.meta.url),'utf8');expect(page).toContain('verifySession');expect(page).toContain("redirect('/auth/login')");expect(page).toContain('force-dynamic');
 });
});
