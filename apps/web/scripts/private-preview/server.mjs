/** Local-only gateway. Not imported or enabled by any production entry point. */
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { createPreviewFixtures, PROFILES } from './fixtures.mjs';
import { hubPage, loginPage } from './hub.mjs';

const PREVIEW_COOKIE='hon_private_preview';
const hash = x => createHash('sha256').update(x).digest();
const equal = (a,b) => typeof a==='string' && timingSafeEqual(hash(a),hash(b));
export async function boundedBody(req) {let n=0,raw='';for await(const c of req){n+=Buffer.byteLength(c);if(n>16384)throw Object.assign(Error('PREVIEW_BODY_TOO_LARGE'),{status:413});raw+=c;}return raw;}
export function createPreviewServers({origin,secure,session,accessCode,guideText}) {
 const fixture=createPreviewFixtures(), gates=new Map(), active=new Map();let attempts=0,resetAt=0;
 const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'none'"};
 const send=(res,status,body,type='application/json')=>{res.writeHead(status,{...headers,'Content-Type':type});res.end(typeof body==='string'?body:JSON.stringify(body));};
 const cookie=(name,value,age=3600)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;
 const owned=req=>{try{const key=cookieValue(req.headers.cookie,PREVIEW_COOKIE),gate=key&&gates.get(key);if(gate&&gate.expires>Date.now())return gate;if(gate){active.delete(gate.subject);gates.delete(key);}}catch{}return null;};
 const switchTo=(gate,key)=>{if(gate.subject)active.delete(gate.subject);gate.profile=key;gate.subject='oidc:private-preview:'+randomBytes(24).toString('hex');gate.token=issueSession({externalSubject:gate.subject,displayName:PROFILES[key].label},session);active.set(gate.subject,gate);};
 const api=createServer(async(req,res)=>{
  try{
   let identity;try{identity=verifySession(cookieValue(req.headers.cookie,HON_SESSION_COOKIE)??'',session);}catch{return send(res,401,{code:'SYNTHETIC_SESSION_REQUIRED'});}
   const gate=active.get(identity.externalSubject);
   if(!gate||gate.expires<=Date.now())return send(res,401,{code:'SYNTHETIC_SESSION_EXPIRED'});
   const raw=await boundedBody(req);
   // Recheck request ownership after the wait; revoked/replaced identities have no authority.
   if(active.get(identity.externalSubject)!==gate||gate.expires<=Date.now())return send(res,401,{code:'SYNTHETIC_SESSION_EXPIRED'});
   const result=fixture.dispatch({profile:PROFILES[gate.profile],subject:identity.externalSubject,method:req.method,path:req.url,headers:req.headers,body:raw?JSON.parse(raw):null});
   send(res,result.status,result.body);
  }catch(e){send(res,Number.isInteger(e.status)?e.status:400,{code:e.code??'SYNTHETIC_REQUEST_REFUSED'});}
 });
 const gateway=createServer(async(req,res)=>{
  try{
   if(!req.url?.startsWith('/')||req.url.startsWith('//')||!['GET','HEAD','POST','PUT'].includes(req.method))return send(res,405,{code:'PREVIEW_METHOD_REFUSED'});
   const url=new URL(req.url,origin),gate=owned(req),requestSubject=gate?.subject;
   if(url.pathname.includes('%'))return send(res,400,{code:'PREVIEW_PATH_ENCODING_REFUSED'});
   if(req.method==='POST'&&url.pathname==='/__preview/unlock') {
    if(req.headers.origin!==origin||url.search)return send(res,403,loginPage('Same-origin unlock required.'),'text/html; charset=utf-8');
    if(Date.now()>resetAt){attempts=0;resetAt=Date.now()+60000;}if(++attempts>10)return send(res,429,loginPage('Wait one minute before trying again.'),'text/html; charset=utf-8');
    const form=new URLSearchParams(await boundedBody(req));if([...form.keys()].join(',')!=='code'||!equal(form.get('code'),accessCode))return send(res,401,loginPage('Preview code was not accepted.'),'text/html; charset=utf-8');
    for(const [key,g] of gates)if(g.expires<=Date.now()){active.delete(g.subject);gates.delete(key);}
    if(gates.size>=20)return send(res,429,loginPage('Restart preview to clear old private sessions.'),'text/html; charset=utf-8');
    const token=randomBytes(32).toString('hex'),g={csrf:randomBytes(32).toString('hex'),expires:Date.now()+3600000};switchTo(g,'schoolA');gates.set(token,g);
    res.writeHead(303,{...headers,Location:'/__preview','Set-Cookie':[cookie(PREVIEW_COOKIE,token),cookie(HON_SESSION_COOKIE,g.token)]});res.end();return;
   }
   if(!gate)return send(res,401,url.pathname.startsWith('/api/')?{code:'PRIVATE_PREVIEW_LOCKED'}:loginPage(),url.pathname.startsWith('/api/')?'application/json':'text/html; charset=utf-8');
   if(url.pathname.startsWith('/__preview/')) {
    if(url.pathname==='/__preview/guide'&&req.method==='GET')return send(res,200,guideText,'text/plain; charset=utf-8');
    if(!['/__preview/switch','/__preview/lock'].includes(url.pathname)||req.method!=='POST'||req.headers.origin!==origin||url.search)return send(res,403,{code:'PREVIEW_CONTROL_REFUSED'});
    const form=new URLSearchParams(await boundedBody(req));if(!equal(form.get('csrf'),gate.csrf))return send(res,403,{code:'PREVIEW_CONTROL_REFUSED'});
    if(url.pathname==='/__preview/lock'){active.delete(gate.subject);gates.delete(cookieValue(req.headers.cookie,PREVIEW_COOKIE));res.writeHead(303,{...headers,Location:'/__preview','Set-Cookie':[cookie(PREVIEW_COOKIE,'',0),cookie(HON_SESSION_COOKIE,'',0)]});res.end();return;}
    if([...form.keys()].sort().join(',')!=='csrf,profile'||!Object.hasOwn(PROFILES,form.get('profile')))return send(res,400,{code:'PREVIEW_PROFILE_REFUSED'});
    switchTo(gate,form.get('profile'));res.writeHead(303,{...headers,Location:'/__preview','Set-Cookie':cookie(HON_SESSION_COOKIE,gate.token)});res.end();return;
   }
   if(url.pathname==='/__preview') {if(req.method!=='GET'||url.search)return send(res,400,{code:'PREVIEW_CONTROL_REFUSED'});return send(res,200,hubPage(gate),'text/html; charset=utf-8');}
   // Old browser requests cannot gain another identity through an already replaced access cookie.
   if(!equal(cookieValue(req.headers.cookie,HON_SESSION_COOKIE),gate.token))return send(res,401,{code:'PREVIEW_IDENTITY_REPLACED'});
   const profile=PROFILES[gate.profile];
   if(url.pathname.startsWith('/auth/')||url.pathname.startsWith('/parent/')||url.pathname.startsWith('/hq')&&profile.plane!=='hq'||url.pathname.startsWith('/staff')&&profile.plane!=='school')return send(res,403,'This route is unavailable for this synthetic identity. Return to the preview navigation.','text/plain; charset=utf-8');
   if(req.method!=='GET'&&req.method!=='HEAD') {
    if(req.headers.origin!==origin)return send(res,403,{code:'PREVIEW_SAME_ORIGIN_REQUIRED'});
    if(!url.pathname.startsWith('/api/v1/'))return send(res,403,{code:'PREVIEW_MUTATION_REFUSED'});
   }
   if(url.pathname==='/api/client-errors')return send(res,204,'');
   const raw=await boundedBody(req);
   if(owned(req)!==gate||gate.subject!==requestSubject||active.get(requestSubject)!==gate)return send(res,401,{code:'PREVIEW_IDENTITY_REPLACED'});
   // One fixed loopback destination only. Never follow redirects or proxy arbitrary URLs/headers.
   const ownedSubject=requestSubject;
   const forward=httpRequest({hostname:'127.0.0.1',port:3100,path:req.url,method:req.method,timeout:15000,headers:{host:new URL(origin).host,'x-forwarded-host':new URL(origin).host,'x-forwarded-proto':secure?'https':'http',cookie:`${HON_SESSION_COOKIE}=${gate.token}`,...Object.fromEntries(['accept','content-type','idempotency-key','x-hon-human-command','rsc','next-router-state-tree','next-router-prefetch','next-url'].filter(k=>typeof req.headers[k]==='string').map(k=>[k,req.headers[k]]))}},upstream=>{
    if(active.get(ownedSubject)!==gate){upstream.destroy();return send(res,401,{code:'PREVIEW_IDENTITY_REPLACED'});}
    const location=upstream.headers.location;if(location&&(!location.startsWith('/')||location.startsWith('//'))){upstream.destroy();return send(res,503,{code:'PREVIEW_REDIRECT_REFUSED'});}
    // Buffer a bounded response so identity replacement during a read cannot expose late facts.
    const chunks=[];let size=0;upstream.on('data',chunk=>{size+=chunk.length;if(size>32*1024*1024){upstream.destroy();if(!res.headersSent)send(res,503,{code:'PREVIEW_RESPONSE_TOO_LARGE'});}else chunks.push(chunk);});
    upstream.on('end',()=>{if(res.writableEnded)return;if(active.get(ownedSubject)!==gate||gate.subject!==ownedSubject)return send(res,401,{code:'PREVIEW_IDENTITY_REPLACED'});
     res.writeHead(upstream.statusCode??502,{...Object.fromEntries(['content-type','content-encoding','vary','location'].filter(k=>upstream.headers[k]).map(k=>[k,upstream.headers[k]])),...headers});res.end(Buffer.concat(chunks));});
    upstream.on('error',()=>{if(!res.writableEnded)send(res,503,{code:'PREVIEW_APPLICATION_UNAVAILABLE'});});
   });
   forward.on('timeout',()=>forward.destroy());forward.on('error',()=>{if(!res.headersSent)send(res,503,{code:'PREVIEW_APPLICATION_UNAVAILABLE'});else res.destroy();});req.on('aborted',()=>forward.destroy());forward.end(raw);
  }catch{if(!res.headersSent)send(res,400,{code:'PREVIEW_REQUEST_REFUSED'});else res.destroy();}
 });
 for(const server of [gateway,api]){server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=60;server.keepAliveTimeout=1000;}
 return {api,gateway,stats:fixture.stats};
}
