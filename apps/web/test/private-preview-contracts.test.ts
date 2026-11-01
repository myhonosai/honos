import { expect, it } from 'vitest';
import { createPreviewFixtures, PROFILES, id } from '../scripts/private-preview/fixtures.mjs';
import { validateMyLanguagePreferenceView, validateMyLanguagePreferenceReceipt, verifyCrmLeadRegistrationResult, CRM_LEAD_REGISTRATION_CONFIRMATION } from '@hon/contracts';
import { verifyHqOverviewSnapshot } from '../src/components/hq-overview-http';
import { verifyCrmLeadList } from '../src/components/crm-leads-http';
import { verifyFollowUpQueue, verifyFollowUpRecord } from '../src/components/crm-follow-ups-http';
import { verifyTrialAppointment } from '../src/components/trial-appointment-http';
import { verifyStaffDashboardSnapshot } from '../src/components/staff-dashboard-http';
import { verifyCommandCenterSnapshot } from '../src/components/command-center-http';
const A=PROFILES.schoolA,B=PROFILES.schoolB,HQ=PROFILES.hq;
const fixture=()=>{
 const f=createPreviewFixtures();
 const call=(method:string,path:string,body?:unknown,key=id(800),marker='crm-trial-appointment',profile=A)=>f.dispatch({profile,subject:'synthetic:'+profile.label,method,path,body,headers:{'idempotency-key':key,'x-hon-human-command':marker}});
 return {f,call,base:`/v1/organizations/${A.organizationId}/schools/${A.schoolId}`};
};
it('preview responses use the real school, HQ, dashboard, command-center and language validators',()=>{
 const {call,base}=fixture();
 expect(verifyCrmLeadList(call('GET',base+'/crm/leads?limit=50').body.data)).toHaveLength(2);
 expect(verifyStaffDashboardSnapshot(call('GET',base+'/reports/operations').body.data,A.organizationId!,A.schoolId!).organizationId).toBe(A.organizationId);
 expect(verifyCommandCenterSnapshot(call('GET',base+'/command-center').body.data,A.organizationId!,A.schoolId!).recommendations).toEqual([]);
 expect(validateMyLanguagePreferenceView(call('GET','/v1/me/language-preference').body.data).effective.language).toBe('en');
 expect(verifyHqOverviewSnapshot((call('GET','/v1/hq/overview',undefined,id(800),'',HQ).body.data as {overview:unknown}).overview).schoolCount).toBe(2);
});
it('a preview trial, follow-up, close and registration are accepted by the actual frontend validators',()=>{
 const {call,base}=fixture(),lead=verifyCrmLeadList(call('GET',base+'/crm/leads?limit=50').body.data)[0]!;
 const body={startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString()};
 const trial=verifyTrialAppointment(call('POST',base+`/crm/leads/${lead.id}/trials`,body).body.data,{leadId:lead.id,schedule:body});
 verifyTrialAppointment(call('POST',base+`/crm/appointments/${trial.id}/outcome`,{status:'COMPLETED',expectedVersion:1},id(801)).body.data,{leadId:lead.id,prior:trial,outcome:'COMPLETED'});
 const follow={expectedVersion:0,leadId:lead.id,assigneeId:id(900),subject:'Synthetic follow-up',note:'',dueAt:null,priority:'NORMAL'};
 verifyFollowUpRecord(call('POST','/v1/staff/crm/follow-ups',follow,id(802),'crm-follow-ups').body.data);
 expect(verifyFollowUpQueue(call('GET','/v1/staff/crm/follow-ups?queue=mine&status=ALL').body.data,'mine','ALL').items).toHaveLength(1);
 call('POST',base+`/crm/leads/${lead.id}/close`,{status:'WON',expectedVersion:1},id(803),'crm-lead-close');
 const input={registrationPath:'ADULT' as const,birthDate:'1990-01-01',confirmation:CRM_LEAD_REGISTRATION_CONFIRMATION};
 expect(verifyCrmLeadRegistrationResult(call('POST',base+`/crm/leads/${lead.id}/register`,input,id(804),'crm-lead-register').body.data,lead.id,input).outcome).toBe('REGISTERED');
});
it.each([['A to B',A,`/v1/organizations/${B.organizationId}/schools/${B.schoolId}/crm/leads?limit=50`],['B to A',B,`/v1/organizations/${A.organizationId}/schools/${A.schoolId}/crm/leads?limit=50`],['school to HQ',A,'/v1/hq/schools'],['HQ to school',HQ,'/v1/owner-launch']] as const)('synthetic permission boundary rejects %s',(_,profile,path)=>{
 const {f}=fixture();expect(()=>f.dispatch({profile,subject:'owner',method:'GET',path})).toThrow();expect(f.stats()).toEqual({syntheticEffects:0,providerCalls:0,financialEffects:0});
});
it('duplicate exact trial requests replay one effect; changed requests and replacement scheduling fail',()=>{
 const {f,call,base}=fixture(),path=base+'/crm/leads/'+id(10)+'/trials',body={startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString()};
 const first=call('POST',path,body);expect(call('POST',path,body).body.data).toEqual(first.body.data);expect(call('POST',path,body).body.meta?.replayed).toBe(true);
 expect(()=>call('POST',path,{...body,notes:'changed'})).toThrow();expect(()=>call('POST',path,body,id(810))).toThrow();expect(f.stats().syntheticEffects).toBe(1);
});
it.each(['/v1/hq/saas/offers','/v1/school-subscriptions/checkout','/v1/staff/membership/activate','/v1/communications/send','/v1/ai/execute'])('no fixture fallback can activate %s',path=>{
 const {f}=fixture();for(const profile of [A,HQ])expect(()=>f.dispatch({profile,subject:'owner',method:'POST',path,body:{},headers:{'idempotency-key':id(800),'x-hon-human-command':'anything'}})).toThrow();expect(f.stats()).toEqual({syntheticEffects:0,providerCalls:0,financialEffects:0});
});
it('language preferences are independent across synthetic identities and replay honestly',()=>{
 const {call}=fixture();const changed=call('POST','/v1/me/language-preference',{language:'ko',expectedVersion:1},id(810),'language-preference-update');
 expect(validateMyLanguagePreferenceReceipt(changed.body.data).preference.language).toBe('ko');
 expect(validateMyLanguagePreferenceView(call('GET','/v1/me/language-preference').body.data).effective.language).toBe('ko');
 expect(validateMyLanguagePreferenceView(call('GET','/v1/me/language-preference',undefined,id(800),'',B).body.data).effective.language).toBe('en');
 expect(validateMyLanguagePreferenceReceipt(call('POST','/v1/me/language-preference',{language:'ko',expectedVersion:1},id(810),'language-preference-update').body.data).replayed).toBe(true);
});
it('standalone follow-up default OPEN queue and exact detail use the existing minimized contracts',()=>{
 const {call}=fixture();const body={expectedVersion:0,leadId:id(10),assigneeId:id(900),subject:'Synthetic follow-up',note:'',dueAt:null,priority:'NORMAL'};
 const item=verifyFollowUpRecord(call('POST','/v1/staff/crm/follow-ups',body,id(811),'crm-follow-ups').body.data);
 const queue=verifyFollowUpQueue(call('GET','/v1/staff/crm/follow-ups?queue=mine&status=OPEN').body.data,'mine','OPEN');expect(queue.items).toHaveLength(1);expect(JSON.stringify(queue.items)).not.toContain('subject');
 expect(verifyFollowUpRecord(call('GET','/v1/staff/crm/follow-ups/'+item.followUpId).body.data)).toEqual(item);
 expect(()=>call('GET','/v1/staff/crm/follow-ups/'+item.followUpId,undefined,id(800),'',B)).toThrow();
});
