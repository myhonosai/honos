import { BadRequestException, type CanActivate, type ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { configuredPublicOrigin } from '@hon/auth';
import { validateCurriculumEnrollmentPreparationInput } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';

const CONTEXTUAL_REQUEST_PROPERTIES = ['honContext', 'honCommandContext', 'commandContext', 'actionContext', 'principalType', 'source', 'actionRequestId', 'delegatedByPrincipalId'];

/** Runs before identity so every success or failure response is private and non-cacheable. */
@Injectable()
export class CurriculumEnrollmentPreparationNoStoreGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return true;
  }
}

/**
 * This is intentionally not the existing curriculum command guard: preparation is
 * a separate non-idempotent read with its own explicit human browser marker.
 */
@Injectable()
export class CurriculumEnrollmentPreparationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HonRequest>();
    const response = context.switchToHttp().getResponse();
    response.setHeader('Cache-Control', 'private, no-store');

    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });

    const fetchSite = request.headers['sec-fetch-site'];
    const contentType = request.headers['content-type'];
    const commandHeaders = Object.keys(request.headers).filter((key) => key.toLowerCase().startsWith('x-hon-'));
    const invalidCommandHeader = commandHeaders.some((key) => key.toLowerCase() !== 'x-hon-human-command');
    const identityHasUnexpectedFields = Boolean(request.honIdentity && Object.keys(request.honIdentity).some((key) => !['externalSubject', 'displayName', 'email'].includes(key)));
    if (request.method !== 'POST' || request.headers.origin !== origin
      || request.headers['x-hon-human-command'] !== 'curriculum-enrollment-preparation'
      || typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
      || typeof fetchSite !== 'string' || !['same-origin', 'same-site', 'none'].includes(fetchSite)
      || invalidCommandHeader || request.headers['idempotency-key'] !== undefined
      || CONTEXTUAL_REQUEST_PROPERTIES.some((key) => Object.hasOwn(request, key)) || identityHasUnexpectedFields) {
      throw new ForbiddenException({ code: 'CURRICULUM_ENROLLMENT_PREPARATION_HUMAN_UI_REQUIRED' });
    }
    if (Object.keys(request.query ?? {}).length !== 0 || request.originalUrl?.includes('?')) {
      throw new BadRequestException({ code: 'CURRICULUM_ENROLLMENT_PREPARATION_SELECTORS_NOT_ACCEPTED' });
    }
    try { validateCurriculumEnrollmentPreparationInput(request.body); } catch {
      throw new BadRequestException({ code: 'INVALID_CURRICULUM_ENROLLMENT_PREPARATION_INPUT' });
    }
    return true;
  }
}
