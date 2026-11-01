/** Explicit synthetic HTTP double, never a HON service or authority implementation. No network/DB imports. */
import { randomUUID } from 'node:crypto';
import { validateFollowUp, validateCloseCrmLeadInput, validateRegisterCrmLeadInput,
  validateLanguageUpdateInput, LANGUAGE_COMMANDS, CRM_LEAD_REGISTRATION_CONFIRMATION,
  HQ_OVERVIEW_UNAVAILABLE_REASONS, CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND } from '@hon/contracts';

export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const PROFILES = Object.freeze({
  hq: Object.freeze({ label: 'HQ owner · synthetic', plane: 'hq' }),
  schoolA: Object.freeze({ label: 'School A owner · synthetic', plane: 'school', organizationId: id(1), schoolId: id(2), schoolName: 'SYNTHETIC Sunrise Taekwondo' }),
  schoolB: Object.freeze({ label: 'School B owner · synthetic', plane: 'school', organizationId: id(101), schoolId: id(102), schoolName: 'SYNTHETIC Riverside Martial Arts' }),
});
const bad = (status, code) => { throw Object.assign(Error(code), { status, code }); };
const closed = (v, required, optional=[]) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k=>!Object.hasOwn(v,k)) || Object.keys(v).some(k=>![...required,...optional].includes(k))) bad(400,'SYNTHETIC_INVALID');
};
const now = () => new Date().toISOString();
const uuid = v => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v ?? '');
const result = (data, meta=false, replayed=false) => ({ status: 200, body: {data,...(meta?{meta:{requestId:id(900),correlationId:id(900),replayed}}:{})} });

export function createPreviewFixtures() {
  const schools = new Map(), preferences = new Map(), attempts = new Map();
  const school = profile => {
    if (!schools.has(profile.schoolId)) schools.set(profile.schoolId, {
      leads: [0,1].map((n)=>({id:id((profile===PROFILES.schoolA?10:110)+n),primaryPersonId:id((profile===PROFILES.schoolA?20:120)+n),pipelineStageId:id(5),version:1,status:'OPEN',givenName:'Synthetic',familyName:n?'Lee':'Rivera',email:`preview${n}@example.test`,createdAt:now()})),
      trials: new Map(), followUps: [], registrations: new Map(), effects:0, theme:'modern',
    });
    return schools.get(profile.schoolId);
  };
  for (const p of Object.values(PROFILES)) if (p.plane==='school') school(p);
  const directory = () => ({schools:Object.values(PROFILES).filter(p=>p.plane==='school').map(p=>({schoolId:p.schoolId,organizationDisplayName:`SYNTHETIC ${p===PROFILES.schoolA?'Sunrise':'Riverside'} Organization`,schoolDisplayName:p.schoolName,organizationOperationalStatus:'ACTIVE',schoolOperationalStatus:'ACTIVE',entitlementTier:null,createdAt:'2026-10-30T12:00:00.000Z'}))});
  const overview = () => ({overview:{asOf:now(),callerHqRole:'OWNER',organizationCount:2,schoolCount:2,onboarding:{availability:'AVAILABLE',requestCount:0,inProgressRequestCount:0,completedRequestCount:0},configuredProviderStates:{disabled:0,configured:0,healthy:0,degraded:0,unavailable:0},taskProfileCount:0,
    financialMetrics:{availability:'UNAVAILABLE',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics},aiUsage:{availability:'UNAVAILABLE',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage},durableHqWork:{availability:'UNAVAILABLE',state:'NO_RECORDED_WORK',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork}}});
  function dispatch({profile,subject,method,path,headers={},body=null}) {
    if (!profile || !Object.values(PROFILES).includes(profile) || !subject) bad(401,'SYNTHETIC_SESSION_REQUIRED');
    const url = new URL(path,'http://127.0.0.1'), p=url.pathname;
    const requestKey=headers['idempotency-key'];
    const mutate = action => {
      if (!uuid(requestKey) || !headers['x-hon-human-command']) bad(400,'SYNTHETIC_COMMAND_REQUIRED');
      const key=subject+':'+requestKey, fingerprint=JSON.stringify([method,path,body]);
      if(attempts.has(key)) {const a=attempts.get(key);if(a.fingerprint!==fingerprint)bad(409,'IDEMPOTENCY_KEY_REUSED');return result(a.meta?structuredClone(a.data):{...structuredClone(a.data),replayed:true},a.meta,true);}
      const data=action();const meta=p!=='/v1/me/language-preference';attempts.set(key,{fingerprint,data:structuredClone(data),meta});return result(data,meta);
    };
    if(p==='/v1/me/language-preference') {
      if(url.search)bad(400,'SYNTHETIC_SELECTOR_REFUSED');
      const pref=preferences.get(profile)??{language:'en',version:1,updatedAt:now()};
      if(method==='GET')return result({preference:pref,schoolDefault:null,effective:{language:pref.language,source:'PERSONAL'},supportedLanguages:['en','ko','es']});
      if(method==='POST')return mutate(()=>{validateLanguageUpdateInput(body);if(headers['x-hon-human-command']!==LANGUAGE_COMMANDS.updateMyLanguage)bad(400,'SYNTHETIC_MARKER_INVALID');if(body.expectedVersion!==pref.version)bad(409,'VERSION_CONFLICT');const next={language:body.language,version:pref.version+1,updatedAt:now()};preferences.set(profile,next);return{preference:next,replayed:false};});
      bad(405,'SYNTHETIC_METHOD_UNAVAILABLE');
    }
    if(p.startsWith('/v1/hq/')) {
      if(profile.plane!=='hq')bad(403,'SYNTHETIC_HQ_DENIED');
      if(method!=='GET'||url.search)bad(403,'PREVIEW_BUSINESS_MUTATION_DISABLED');
      if(p==='/v1/hq/overview')return result(overview());
      if(p==='/v1/hq/session')return result({principalId:id(900),hqRole:'HON_HQ_OWNER'});
      if(p==='/v1/hq/schools')return result({directory:directory()});
      bad(503,'PREVIEW_NOT_MODELED');
    }
    if(profile.plane!=='school')bad(403,'SYNTHETIC_SCHOOL_DENIED');
    const s=school(profile), scope={organizationId:profile.organizationId,schoolId:profile.schoolId};
    const base=`/v1/organizations/${profile.organizationId}/schools/${profile.schoolId}`;
    if(p.startsWith('/v1/organizations/')&&!p.startsWith(base+'/'))bad(403,'SYNTHETIC_FOREIGN_SCOPE_DENIED');
    if(method==='GET') {
      if(path==='/v1/staff/current-reporting-school')return result({state:'RESOLVED',...scope});
      if(path==='/v1/owner-launch')return result({...scope,schoolName:profile.schoolName,tier:'COMPLETE',program:null,classSession:null,registration:null,guardianChildRegistration:null});
      if(p===base+'/crm/leads'&&url.search==='?limit=50')return result(structuredClone(s.leads),true);
      if(p==='/v1/staff/crm/follow-ups') {
        const status=url.searchParams.get('status');if([...url.searchParams.keys()].sort().join(',')!=='queue,status'||url.searchParams.get('queue')!=='mine'||!['OPEN','COMPLETED','CANCELLED','ALL'].includes(status))bad(403,'SYNTHETIC_QUEUE_DENIED');
        return result({schoolId:profile.schoolId,principalId:id(900),canManage:false,humanOnly:true,queue:'mine',status,items:s.followUps.filter(f=>status==='ALL'||f.status===status).map(f=>Object.fromEntries(['followUpId','leadId','assigneeId','version','status','priority','dueAt'].map(k=>[k,f[k]]))).sort((a,b)=>a.followUpId.localeCompare(b.followUpId)),nextAfter:null},true);
      }
      if(p.startsWith('/v1/staff/crm/follow-ups/')&&!url.search){const f=s.followUps.find(f=>f.followUpId===p.slice('/v1/staff/crm/follow-ups/'.length));if(!f)bad(404,'SYNTHETIC_FOLLOW_UP_UNAVAILABLE');return result(structuredClone(f),true);}
      if(p===base+'/interface-theme'&&!url.search)return result({interfaceTheme:s.theme,selectedVia:'SETTINGS'},true);
      if(p===base+'/command-center'&&!url.search) {
        const time=Date.now(),window = days => ({availability:'AVAILABLE',windowFrom:new Date(time-days*86400000).toISOString(),windowTo:new Date(time).toISOString(),count:0});
        return result({...scope,entitlementTier:'COMPLETE',generatedAt:now(),metrics:{newLeads24h:window(1),upcomingTrials24h:window(1),upcomingTestingEvents30d:window(30),membershipTermsEnding30d:window(30),pendingActionApprovals:{availability:'AVAILABLE',count:0},outstandingWorkItems:{availability:'AVAILABLE',count:0},paidInvoicesCreated30d:{...window(30),amountsByCurrency:[]},unansweredInquiries:{availability:'UNAVAILABLE',reason:'No approved inquiry response-state projection exists.'},attendanceDecline:{availability:'INSUFFICIENT_DATA',reason:'No approved attendance-decline policy or longitudinal projection exists.'},trialConversion:{availability:'UNAVAILABLE',reason:'No authoritative trial-to-enrollment linkage is available.'},revenue:{availability:'UNAVAILABLE',reason:'Current paid invoice state is not authoritative cash revenue or collection data.'}},dailyBriefing:'Daily briefing: no counted priorities are currently recorded in the available Command Center metrics.',recommendations:[]});
      }
      if(path===`/v1/staff/action-center/approvals/${profile.schoolId}?status=AWAITING_APPROVAL`)return result({...scope,reviewerPrincipalId:id(900),reviewerPermission:'action.approve',status:'AWAITING_APPROVAL',items:[],nextAfter:null,executionTriggered:false});
      if(p===base+'/reports/operations')return result({...scope,generatedAt:now(),from:new Date(Date.now()-30*86400000).toISOString(),to:now(),studentProfiles:{total:0},leads:{byStatus:Object.fromEntries(['OPEN','WON','LOST','ARCHIVED'].map(k=>[k,s.leads.filter(l=>l.status===k).length]))},classSessions:{inRange:{scheduled:0,completed:0,cancelled:0}},attendance:{inRangeByStatus:{PRESENT:0,LATE:0,EXCUSED_ABSENCE:0,UNEXCUSED_ABSENCE:0,MAKEUP:0}},memberships:{byState:{DRAFT:0,ACTIVE:0,FROZEN:0,CANCELLATION_PENDING:0,CANCELLED:0,EXPIRED:0}},invoices:{inRangeByStatus:{DRAFT:0,ISSUED:0,PAID:0,VOID:0,UNCOLLECTIBLE:0}},paymentAttempts:{inRangeByState:{PENDING:0,PROCESSING:0,SUCCEEDED:0,FAILED:0,REQUIRES_ACTION:0,UNKNOWN:0,REFUNDED:0}}});
      if(['/v1/marketing/assistant/mine','/v1/staff/teaching-assistant/mine','/v1/staff/leads/assistant/mine'].includes(p)&&!url.search)return result([]);
      bad(503,'PREVIEW_NOT_MODELED');
    }
    if(p===base+'/interface-theme'&&method==='PUT'&&!url.search) {
      closed(body,['interfaceTheme','selectedVia']);if(!uuid(requestKey)||!['modern','classic','big-button'].includes(body.interfaceTheme)||!['SETTINGS','ONBOARDING'].includes(body.selectedVia))bad(400,'SYNTHETIC_THEME_INVALID');
      // Presentation-only, request-key-bound memory. No entitlement or school mutation.
      const key=subject+':'+requestKey, fingerprint=JSON.stringify([method,path,body]);const prior=attempts.get(key);
      if(prior){if(prior.fingerprint!==fingerprint)bad(409,'IDEMPOTENCY_KEY_REUSED');return result(prior.data,true,true);}
      s.theme=body.interfaceTheme;const data={interfaceTheme:s.theme,selectedVia:body.selectedVia};attempts.set(key,{fingerprint,data});return result(data,true);
    }
    const leadPath=new RegExp('^'+base+'/crm/leads/([a-f0-9-]+)/([^/]+)$').exec(p);
    const l=leadPath&&s.leads.find(l=>l.id===leadPath[1]);
    if(leadPath&&!l)bad(404,'SYNTHETIC_LEAD_UNAVAILABLE');
    if(method==='POST'&&leadPath?.[2]==='guardian-child-enrollment') {
      closed(body,[]);if(requestKey||headers['x-hon-human-command']!==CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND)bad(400,'SYNTHETIC_READ_INVALID');
      return result({leadId:l.id,workflowState:s.registrations.has(l.id)?s.registrations.get(l.id).registrationPath==='ADULT'?'ADULT_REGISTRATION':'NEEDS_STAFF_REVIEW':'NOT_REGISTERED'},true);
    }
    const outcome=new RegExp('^'+base+'/crm/appointments/([a-f0-9-]+)/outcome$').exec(p);
    if(method!=='POST'||!['trials','close','register'].includes(leadPath?.[2])&&!outcome&&p!=='/v1/staff/crm/follow-ups')bad(403,'PREVIEW_BUSINESS_MUTATION_DISABLED');
    const marker=p==='/v1/staff/crm/follow-ups'?'crm-follow-ups':outcome||leadPath?.[2]==='trials'?'crm-trial-appointment':leadPath?.[2]==='close'?'crm-lead-close':'crm-lead-register';
    if(headers['x-hon-human-command']!==marker)bad(400,'SYNTHETIC_MARKER_INVALID');
    return mutate(()=>{
      let data;
      if(p==='/v1/staff/crm/follow-ups') {
        validateFollowUp('CREATE',body);if(body.expectedVersion!==0||body.assigneeId!==id(900)||!s.leads.some(l=>l.id===body.leadId))bad(403,'SYNTHETIC_FOREIGN_LEAD_DENIED');
        data={...body,followUpId:randomUUID(),schoolId:profile.schoolId,version:1,status:'OPEN',recordedAt:now(),completedAt:null,cancelledAt:null,humanOnly:true};delete data.expectedVersion;
        s.followUps.push(data);
      } else if(leadPath?.[2]==='trials') {
        closed(body,['startsAt','endsAt'],['location','notes']);if(!Number.isFinite(Date.parse(body.startsAt))||Date.parse(body.startsAt)<=Date.now()||Date.parse(body.endsAt)<=Date.parse(body.startsAt))bad(422,'SYNTHETIC_DATES_INVALID');
        if([...s.trials.values()].some(t=>t.crmLeadId===l.id))bad(409,'SYNTHETIC_TRIAL_ALREADY_RECORDED');
        data={...body,id:randomUUID(),crmLeadId:l.id,appointmentType:'TRIAL',status:'SCHEDULED',createdByPrincipalId:id(900),version:1,createdAt:now(),updatedAt:now()};s.trials.set(data.id,data);
      } else if(outcome) {
        closed(body,['status','expectedVersion'],['outcomeNotes']);const a=s.trials.get(outcome[1]);if(!a)bad(404,'SYNTHETIC_TRIAL_UNAVAILABLE');if(a.version!==body.expectedVersion||a.status!=='SCHEDULED'||!['COMPLETED','NO_SHOW','CANCELLED'].includes(body.status))bad(409,'VERSION_CONFLICT');data={...a,status:body.status,version:a.version+1,updatedAt:now()};s.trials.set(a.id,data);
      } else if(leadPath?.[2]==='close') {
        validateCloseCrmLeadInput(body);if(l.version!==body.expectedVersion||l.status!=='OPEN')bad(409,'VERSION_CONFLICT');data={...scope,leadId:l.id,status:body.status,priorVersion:l.version,version:l.version+1,closedAt:now(),closeNote:body.closeNote??null,crmOnly:true};l.status=body.status;l.version++;
      } else {
        validateRegisterCrmLeadInput(body);if(body.confirmation!==CRM_LEAD_REGISTRATION_CONFIRMATION||l.status!=='WON')bad(422,'SYNTHETIC_REGISTRATION_REQUIRES_WON');if(s.registrations.has(l.id))bad(409,'SYNTHETIC_REGISTRATION_ALREADY_RECORDED');
        // This milestone previews registration records only, never billing or membership creation.
        data={outcome:'REGISTERED',leadId:l.id,sourceContactPersonId:l.primaryPersonId,registrationPath:body.registrationPath,studentProfileId:randomUUID(),familyId:body.registrationPath==='ADULT'?null:randomUUID(),recordedAt:now()};s.registrations.set(l.id,data);
      }
      s.effects++;return structuredClone(data);
    });
  }
  return {dispatch,stats:()=>({syntheticEffects:[...schools.values()].reduce((n,s)=>n+s.effects,0),providerCalls:0,financialEffects:0}),directory};
}
