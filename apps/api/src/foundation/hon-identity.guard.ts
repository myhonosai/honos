import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ManusIdentityService, type HonRequest } from './manus-identity.service.js';

@Injectable()
export class HonIdentityGuard implements CanActivate {
  constructor(private readonly identity: ManusIdentityService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    (request as HonRequest).honIdentity = this.identity.authenticate(request);
    return true;
  }
}
