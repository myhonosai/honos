import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { HonIdentityService, type HonRequest } from './hon-identity.service.js';

@Injectable()
export class HonIdentityGuard implements CanActivate {
  constructor(private readonly identity: HonIdentityService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    (request as HonRequest).honIdentity = this.identity.authenticate(request);
    return true;
  }
}
