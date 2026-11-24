import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { Request } from 'express';
@Injectable()
export class CurriculumHumanUiGuard implements CanActivate {
 protected readonly command: string = 'curriculum-progress';
 canActivate(context: ExecutionContext): boolean {
  const request=context.switchToHttp().getRequest<Request & { honChannel?: 'WEB'|'MOBILE' }>();
  if(request.method==='GET') return true;
  // M2 native parent app: a bearer session carries no ambient browser credential, so there is no CSRF to defend with
  // Origin. A browser always sends Origin/Sec-Fetch-Site on a POST (and CORS is off, so it cannot attach a bearer
  // cross-origin), so a native request must carry neither. The identity guard still verifies the bearer itself.
  const mobile=request.honChannel==='MOBILE'||(request.honChannel===undefined&&request.headers.cookie===undefined&&/^Bearer /.test(request.headers.authorization??''));
  if(mobile){
   if(request.method!=='POST'||request.headers.origin!==undefined||request.headers['sec-fetch-site']!==undefined
    ||request.headers['x-hon-human-command']!==this.command||!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']??'')) throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
   return true;
  }
  let origin: string|undefined; try { origin=configuredPublicOrigin(process.env); } catch { /* fail closed */ }
  if(!origin) throw new ServiceUnavailableException({code:'HUMAN_UI_ORIGIN_NOT_CONFIGURED'});
  if(request.method!=='POST'||request.headers.origin!==origin||request.headers['x-hon-human-command']!==this.command
   ||request.headers['sec-fetch-site']==='cross-site'||!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']??'')) throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
  return true;
 }
}
