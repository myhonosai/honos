import { raw, type Request, type Response, type NextFunction } from 'express';
import { configuredPublicOrigin } from '@hon/auth';
import { kioskExactInput } from '@hon/domain';
import { parsePublicFormJson } from '../marketing/public-form-transport.js';
const generic = {result:'NEEDS_STAFF_ASSISTANCE'};
export function kioskTransport() {
 const parser=raw({type:()=>true,limit:1024,inflate:false});
 let start=Date.now(),attempts=0;
 return (req: Request,res: Response,next: NextFunction): void => {
  if (!/^\/v1\/kiosk(?:\/|$)/i.test(req.path)) { next(); return; }
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  let origin: string|undefined;
  try {origin=configuredPublicOrigin(process.env);} catch {/* fail closed */}
  if (req.method!=='POST' || req.path!=='/v1/kiosk/handoffs' || req.originalUrl.includes('?')
   || req.headers.cookie!==undefined || req.headers.authorization!==undefined || req.headers.referer!==undefined
   || Object.keys(req.headers).some(k=>k.startsWith('x-hon'))
   || !origin || req.headers.origin!==undefined && req.headers.origin!==origin
   || req.headers['sec-fetch-site']!==undefined && req.headers['sec-fetch-site']!=='same-origin'
   || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')
   || req.headers['content-encoding']!==undefined && req.headers['content-encoding']!=='identity') {
   res.status(400).json(generic); return;
  }
  if (Date.now()-start>=60000) {start=Date.now();attempts=0;}
  if (++attempts>300) {res.status(429).json(generic);return;}
  parser(req,res,error=>{
   if(error) {res.status(400).json(generic);return;}
   try { const input=parsePublicFormJson(req.body as Buffer);kioskExactInput(input,['terminalSession','claim']);req.body=input; }
   catch {res.status(400).json(generic);return;}
   next();
  });
 };
}
