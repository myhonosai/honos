import { describe,it,expect } from 'vitest';
import { A2P_FINDING_CODES,A2P_TEMPLATES,A2P_FACT_CONFIRMATION,a2pPublicHttpsUrl,validateA2pDraftInput,validateA2pWebsiteReview } from '@hon/contracts';
import { evaluateA2pWebsite,generateA2pDraft,type A2pFixtureObservation } from './a2p-registration.js';
import { approveA2pDnsAnswers,assertA2pPinnedAddress,approveA2pRedirect,assertA2pInspectionBudget } from './a2p-website-policy.js';
const facts=()=>({businessName:'Synthetic Dojo',websiteUrl:'https://dojo.example.com/',privacyUrl:'https://dojo.example.com/privacy',termsUrl:'https://dojo.example.com/terms',
  optInUrl:'https://dojo.example.com/contact',supportContact:'support@dojo.example.com',messageFlow:'Adults requesting trial information use the public contact form and voluntarily check the separate SMS consent box.',messageFrequency:'Up to four messages monthly'});
const input=()=>({facts:facts(),purpose:'SERVICE_NOTIFICATIONS',templates:['TRIAL_CONFIRMATION'],marketingConsent:'NOT_APPLICABLE',ownerConfirmation:A2P_FACT_CONFIRMATION});
const observation=(code:typeof A2P_FINDING_CODES[number],outcome:A2pFixtureObservation['outcome']='PRESENT'):A2pFixtureObservation=>({code,outcome,
  evidence:[{id:'LOCAL_'+code,url:'https://dojo.example.com/contact',provenance:'SYNTHETIC_FIXTURE',observedAt:'2026-10-25T00:00:00.000Z',excerpt:'Controlled local website fixture observation; not a live public website.'}]});
describe('A2P structured, provenance-preserving checks',()=>{
  it('never mistakes a complete local fixture for carrier/legal approval',()=>{
    const report=evaluateA2pWebsite({kind:'SYNTHETIC_FIXTURE',observations:A2P_FINDING_CODES.map(c=>observation(c))});
    expect(report.findings).toHaveLength(13);expect(report.findings.every(f=>f.status==='PASS')).toBe(true);
    expect(report.overallStatus).toBe('REVIEW_REQUIRED');expect(report.legalCompliance).toBe('NOT_DETERMINED');expect(report.carrierApproval).toBe('NOT_REQUESTED');
    expect(report.findings.every(f=>f.evidence.every(e=>e.provenance==='SYNTHETIC_FIXTURE'))).toBe(true);
    expect(report.sources.every(s=>s.reviewedOn==='2026-10-25'&&s.url.includes('twilio.com/'))).toBe(true);
  });
  it.each(A2P_FINDING_CODES)('flags missing %s with actionable source-backed findings',code=>{
    const result=evaluateA2pWebsite({kind:'SYNTHETIC_FIXTURE',observations:[observation(code,'MISSING')]});
    const f=result.findings.find(f=>f.code===code)!;expect(f.status).toBe('NEEDS_FIX');expect(f.remediation.length).toBeGreaterThan(20);expect(f.sourceIds.length).toBeGreaterThan(0);
  });
  it.each(['BUSINESS_IDENTITY','SMS_DATA_SHARING','FLOW_CONSISTENCY'] as const)('refuses contradictory %s',code=>{
    expect(evaluateA2pWebsite({kind:'SYNTHETIC_FIXTURE',observations:[observation(code,'CONTRADICTORY')]}).findings.find(f=>f.code===code)?.status).toBe('NEEDS_FIX');
  });
  it('requires review of dynamic consent and does not infer missing policies from an unavailable site',()=>{
    const dynamic=evaluateA2pWebsite({kind:'SYNTHETIC_FIXTURE',observations:[observation('CONSENT_OPTIONAL_UNCHECKED','DYNAMIC_UNKNOWN')]});
    expect(dynamic.findings.find(f=>f.code==='CONSENT_OPTIONAL_UNCHECKED')?.status).toBe('REVIEW_REQUIRED');
    const unavailable=evaluateA2pWebsite({kind:'UNAVAILABLE',reason:'LIVE_INSPECTION_DISABLED'});
    expect(unavailable.findings.every(f=>f.status==='UNAVAILABLE'&&f.evidence.length===0)).toBe(true);
  });
  it('rejects forged, absent, unsafe or duplicate fixture evidence',()=>{
    const o=observation('PRIVACY_PUBLIC');
    for(const observations of [[o,o],[{...o,evidence:[]}],[{...o,evidence:[{...o.evidence[0]!,provenance:'PUBLIC_VERIFIED'}]}],
      [{...o,evidence:[{...o.evidence[0]!,url:'http://127.0.0.1/'}]}],[{...o,evidence:[{...o.evidence[0]!,observedAt:'2026-02-30T00:00:00.000Z'}]}]]){
      expect(()=>evaluateA2pWebsite({kind:'SYNTHETIC_FIXTURE',observations:observations as A2pFixtureObservation[]})).toThrow();
    }
  });
});
describe('A2P deterministic martial arts registration drafts',()=>{
  it.each(A2P_TEMPLATES)('prepares two factual-placeholder %s samples and proposed HELP/STOP only',template=>{
    const value=template==='PROMOTIONAL'?{...input(),purpose:'MARKETING',marketingConsent:'SEPARATE_CONFIRMED',templates:[template]}:{...input(),templates:[template]};
    const d=generateA2pDraft(value,'Synthetic Dojo');expect(d.state).toBe('DRAFT_FOR_OWNER_REVIEW');expect(d.sampleMessages).toHaveLength(2);
    expect(d.sampleMessages.every(s=>s.content.includes('Synthetic Dojo')&&s.content.includes('STOP')&&s.content.includes('HELP')&&s.content.length>=20&&s.content.length<=1024)).toBe(true);
    expect(d.helpResponseSample!.length).toBeLessThanOrEqual(320);expect(d.stopResponseSample!.length).toBeLessThanOrEqual(320);
    expect(d).toMatchObject({consentRecorded:false,saved:false,submitted:false,messagesSent:0,factsProvenance:'OWNER_STATEMENTS_NOT_INDEPENDENTLY_VERIFIED'});
    expect(d.answers!.messageFlow).toContain(facts().messageFlow);expect(d.answers!.messageFlow).toContain(facts().privacyUrl);
    expect(d.warnings).toContain('PROVIDER_USE_CASE_AND_BRAND_ELIGIBILITY_NOT_VERIFIED');
    expect(JSON.stringify(d.sampleMessages)).not.toMatch(/20%|free trial|\$[0-9]|charged|payment received/i);
  });
  it('preserves actual owner flow without inventing double opt-in, welcome or recorded-call evidence',()=>{
    const d=generateA2pDraft(input(),'Synthetic Dojo');expect(d.answers!.messageFlow).not.toMatch(/double opt|welcome|recorded|approved/i);
    expect(d.answers!.messageFlow.startsWith(facts().messageFlow)).toBe(true);
    expect(d.sampleMessages[0]!.content).toContain('[trial_date]');
  });
  it.each(Object.keys(facts()))('does not fabricate missing %s',key=>{
    const value=input();(value.facts as Record<string,unknown>)[key]=null;
    const d=generateA2pDraft(value,'Synthetic Dojo');expect(d.missingFields).toContain(key);expect(d.copyPreparationAvailable).toBe(false);expect(d.answers).toBeNull();expect(d.sampleMessages).toEqual([]);
  });
  it('requires owner and separate marketing confirmation, and rejects incompatible campaign claims',()=>{
    const owner=generateA2pDraft({...input(),ownerConfirmation:'NOT_CONFIRMED'},'Synthetic Dojo');expect(owner.missingFields).toContain('ownerConfirmation');
    const marketing={...input(),purpose:'MARKETING',templates:['PROMOTIONAL'],marketingConsent:'NOT_CONFIRMED'};
    expect(generateA2pDraft(marketing,'Synthetic Dojo').missingFields).toContain('marketingConsent.separateConfirmation');
    for(const patch of [{purpose:'2FA'},{purpose:'K12_EDUCATION'},{purpose:'SOLE_PROPRIETOR'},{templates:['PROMOTIONAL']},
      {purpose:'MIXED',marketingConsent:'SEPARATE_CONFIRMED'},{purpose:'MARKETING',marketingConsent:'SEPARATE_CONFIRMED'}])expect(()=>validateA2pDraftInput({...input(),...patch})).toThrow();
  });
  it('preserves five selected samples and never silently truncates financial/support/flow facts',()=>{
    expect(generateA2pDraft({...input(),templates:A2P_TEMPLATES.slice(0,5)},'Synthetic Dojo').sampleMessages).toHaveLength(5);
    expect(()=>validateA2pDraftInput({...input(),templates:A2P_TEMPLATES.slice(0,6)})).toThrow();
    const long=generateA2pDraft({...input(),facts:{...facts(),messageFlow:'x'.repeat(2048)}},'Synthetic Dojo');
    expect(long.missingFields).toContain('messageFlow.withPolicyLinksMaximum2048');expect(long.copyPreparationAvailable).toBe(false);
    const contact='a'.repeat(130)+'@example.com';
    const help=generateA2pDraft({...input(),facts:{...facts(),businessName:'x'.repeat(120),supportContact:contact}},'Synthetic Dojo');
    expect(help.missingFields).toContain('helpStopSamples.maximum320Characters');
  });
  it('requires business-domain terms and human review for different recorded/trade identities',()=>{
    expect(generateA2pDraft({...input(),facts:{...facts(),termsUrl:'https://other.example.com/terms'}},'Synthetic Dojo').copyPreparationAvailable).toBe(false);
    expect(generateA2pDraft(input(),'Different Verified School').warnings).toContain('BUSINESS_TRADE_NAME_REQUIRES_RECONCILIATION');
  });
  it('normalizes detached immutable inputs and rejects secrets/authority/evidence/extra output claims',()=>{
    const v=input(),checked=validateA2pDraftInput(v);v.facts.businessName='Changed';expect(checked.facts.businessName).toBe('Synthetic Dojo');expect(Object.isFrozen(checked.facts)).toBe(true);
    for(const patch of [{schoolId:'foreign'},{approved:true},{consentRecorded:true},{html:'<form>'},{observations:[]},{provider:'TWILIO'},{idempotencyKey:'fake'}])expect(()=>validateA2pDraftInput({...input(),...patch})).toThrow();
    expect(()=>validateA2pDraftInput({...input(),facts:{...facts(),businessName:'api_key=do-not-echo'}})).toThrow('INVALID_A2P_INPUT');
  });
});
describe('A2P prospective inspection policy is closed and never performs I/O',()=>{
  it.each(['http://example.com','https://127.0.0.1/','https://127.1/','https://[::1]/','https://2130706433/',
    'https://localhost/','https://school.local/','https://metadata.google.internal/','https://user:pass@example.com/',
    'https://example.com:443/','https://example.com/?token=secret','https://example.com/#x','https://example.com/%2fprivate',
    'https://example.com/../secret','https://example.com\\@127.0.0.1/','https://example.com/\nsecret'])('rejects URL %s',url=>expect(()=>a2pPublicHttpsUrl(url)).toThrow());
  it('accepts canonical public-looking selectors without claiming DNS, identity or ownership verification',()=>{
    expect(a2pPublicHttpsUrl('https://School.Example.com')).toBe('https://school.example.com/');
    expect(validateA2pWebsiteReview({websiteUrl:facts().websiteUrl,businessName:null,privacyUrl:null,termsUrl:null,optInUrl:null,messageFlow:null}).privacyUrl).toBeNull();
  });
  it.each(['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1',
    '192.0.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',
    '::1','::ffff:127.0.0.1','2001:4860:4860::8888','8.8.8.999','008.8.8.8'])('rejects private/special/unsupported DNS %s',ip=>{
      expect(()=>approveA2pDnsAnswers([ip])).toThrow();expect(()=>approveA2pDnsAnswers(['8.8.8.8',ip])).toThrow();
    });
  it('binds the exact connection address to the approved complete answer set',()=>{
    expect(approveA2pDnsAnswers(['8.8.8.8','1.1.1.1','8.8.8.8'])).toEqual(['1.1.1.1','8.8.8.8']);
    expect(()=>assertA2pPinnedAddress(['8.8.8.8'],'1.1.1.1')).toThrow();expect(()=>assertA2pPinnedAddress(['8.8.8.8'],'127.0.0.1')).toThrow();
    assertA2pPinnedAddress(['8.8.8.8'],'8.8.8.8');
  });
  it('revalidates redirects and enforces time/response/crawl budgets',()=>{
    const initial=facts().websiteUrl;expect(approveA2pRedirect(initial,'/privacy',0)).toBe(facts().privacyUrl);
    for(const to of ['http://example.com/','//127.0.0.1/','https://other.example.com/','https://example.com:443/','javascript:alert(1)','/\nprivate','/%2fsecret'])expect(()=>approveA2pRedirect(initial,to,0)).toThrow();
    expect(()=>approveA2pRedirect(initial,'/loop',2)).toThrow();
    const budget={pages:4,redirects:2,bytesPerPage:65536,totalBytes:262144,elapsedMs:5000};assertA2pInspectionBudget(budget);
    for(const [k,v] of Object.entries(budget))expect(()=>assertA2pInspectionBudget({...budget,[k]:v+1})).toThrow();
  });
});
