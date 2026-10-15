import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

export function testingDatabaseError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'TESTING_FORBIDDEN', detail: 'Current direct human instructor permission is required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'TESTING_RECORD_NOT_FOUND', detail: 'The testing event, registration, or child was not found in this current scope.' });
  if (['40001', '40P01', '55P03', '23505'].includes(code ?? '')) throw new ConflictException({ code: 'TESTING_CONFLICT', detail: 'Refresh current records. Retain the original key for an unchanged retry.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'TESTING_TIMEOUT', detail: 'No success is assumed. Retry the unchanged request with its original key.' });
  if (['23514', '23503', '22P02', '22023'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw error;
}
