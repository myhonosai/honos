import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
export function attendanceDatabaseError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'ATTENDANCE_FORBIDDEN', detail: 'Current direct human school permission and entitlement are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'ATTENDANCE_RECORD_NOT_FOUND' });
  const commandCode = (error as { message?: string }).message;
  if (code === '40001' && ['IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_PROGRESS', 'VERSION_REQUIRED', 'VERSION_CONFLICT'].includes(commandCode ?? '')) {
    throw new ConflictException({ code: commandCode, detail: 'Refresh current records. Keep the original key for an unchanged retry.' });
  }
  if (['40001', '40P01', '55P03', '23505'].includes(code ?? '')) throw new ConflictException({ code: 'ATTENDANCE_CONFLICT', detail: 'Refresh current records. Keep the original key for an unchanged retry.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'ATTENDANCE_TIMEOUT', detail: 'No success is assumed. Retry unchanged with the original key.' });
  if (['23514', '23503', '22P02', '22023'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Category, class/program eligibility or policy input is invalid or lacks required evidence.' });
  throw error;
}
