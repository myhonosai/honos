// Local synthetic website snapshots only. Not imported by the production module and never selected by request data.
const { createHash }=require('node:crypto');
const c=require('@hon/contracts'),d=require('@hon/domain');
const facts=()=>({businessName:'Synthetic Dojo',websiteUrl:'https://dojo.example.com/',privacyUrl:'https://dojo.example.com/privacy',termsUrl:'https://dojo.example.com/terms',
 optInUrl:'https://dojo.example.com/contact',supportContact:'support@dojo.example.com',messageFlow:'Adults requesting trial information use our public contact form and voluntarily select a separate SMS consent box. No SMS consent is required to request classes.',messageFrequency:'Up to four messages monthly'});
const draft=()=>({facts:facts(),purpose:'SERVICE_NOTIFICATIONS',templates:['TRIAL_CONFIRMATION','TRIAL_REMINDER'],marketingConsent:'NOT_APPLICABLE',ownerConfirmation:c.A2P_FACT_CONFIRMATION});
const review=()=>({websiteUrl:facts().websiteUrl,businessName:facts().businessName,privacyUrl:facts().privacyUrl,termsUrl:facts().termsUrl,optInUrl:facts().optInUrl,messageFlow:facts().messageFlow});
class LocalWebsiteFixtureInspector {
 constructor(kind='complete'){this.kind=kind;this.calls=0;}
 async inspect(){
  ++this.calls;
  const f=facts(),pages=[{url:f.websiteUrl,status:200,body:'<h1>Synthetic Dojo</h1>'},
   {url:f.privacyUrl,status:this.kind==='missing-policies'?404:200,body:'<p>Mobile numbers and SMS consent are not shared for marketing. Message frequency varies. Message and data rates may apply.</p>'},
   {url:f.termsUrl,status:this.kind==='missing-policies'?404:200,body:'<h1>Public school and messaging terms</h1>'},
   {url:f.optInUrl,status:200,body:this.kind==='dynamic'?'<script>renderUnknownConsentForm()</script>':'<form><input type="tel"><input type="checkbox">Optional SMS consent. Reply STOP to opt out; HELP for help. <a href="/privacy">Privacy</a><a href="/terms">Terms</a></form>'}];
  d.approveA2pDnsAnswers(['8.8.8.8']);d.assertA2pPinnedAddress(['8.8.8.8'],'8.8.8.8');
  if(this.kind==='unsafe-redirect')d.approveA2pRedirect(f.websiteUrl,'https://127.0.0.1/',0);
  const bytes=pages.map(p=>Buffer.byteLength(p.body));d.assertA2pInspectionBudget({pages:pages.length,redirects:0,bytesPerPage:Math.max(...bytes),totalBytes:bytes.reduce((a,b)=>a+b,0),elapsedMs:1});
  const observations=c.A2P_FINDING_CODES.map(code=>{
   const page=code==='PRIVACY_PUBLIC'||code==='SMS_DATA_SHARING'?pages[1]:code==='TERMS_PUBLIC'?pages[2]:code==='BUSINESS_IDENTITY'?pages[0]:pages[3];
   let outcome=page.status===404?'MISSING':'PRESENT';
   if(this.kind==='missing-disclosures'&&['RATES','FREQUENCY','STOP','HELP','POLICY_LINKS_NEAR_FORM'].includes(code))outcome='MISSING';
   if(this.kind==='contradictory'&&['BUSINESS_IDENTITY','SMS_DATA_SHARING','FLOW_CONSISTENCY'].includes(code))outcome='CONTRADICTORY';
   if(this.kind==='dynamic'&&['CONSENT_OPTIONAL_UNCHECKED','CONSENT_SEPARATION','FLOW_CONSISTENCY'].includes(code))outcome='DYNAMIC_UNKNOWN';
   const hash=createHash('sha256').update(page.body).digest('hex').slice(0,16).toUpperCase();
   return {code,outcome,evidence:[{id:'LOCAL_'+hash+'_'+code,url:page.url,provenance:'SYNTHETIC_FIXTURE',observedAt:'2026-10-25T00:00:00.000Z',
    excerpt:`Controlled fixture HTTP ${page.status}; ${code}: ${outcome}. Snapshot ${hash}. This is not live website evidence.`}]};
  });
  return {kind:'SYNTHETIC_FIXTURE',observations};
 }
}
module.exports={facts,draft,review,LocalWebsiteFixtureInspector};
