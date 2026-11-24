import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { validateSelectParentFamilyInput, verifyParentFamilyChoices, verifyParentFamilySelection, type ParentFamilyChoices } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '22023' && message === 'VALIDATION_FAILED') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (sqlState === 'P0002' && message === 'PARENT_FAMILY_NOT_AVAILABLE') {
    throw new NotFoundException({ code: 'PARENT_FAMILY_NOT_AVAILABLE', detail: 'That family is not linked to your account right now.' });
  }
  if (sqlState === '42501') throw new ForbiddenException({ code: 'PARENT_FAMILY_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'PARENT_FAMILY_CONFLICT' });
  throw new ServiceUnavailableException({ code: 'PARENT_FAMILY_UNAVAILABLE', detail: 'No verified family list is available.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}

/**
 * 0471 parent school and family picker. The list is the parent's live family grants; a choice only names one of them and is
 * proved again by the database, which then decides the tenant for every other parent read and command.
 */
@Injectable()
export class ParentFamilyPickerService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async choices(subject: string): Promise<ParentFamilyChoices> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'PARENT_FAMILY_FORBIDDEN' });
    let data: unknown;
    try { data = await this.database.readParentFamilyChoices(subject); } catch (error) { translate(error); }
    try { return verifyParentFamilyChoices(data); } catch { throw new ServiceUnavailableException({ code: 'PARENT_FAMILY_UNAVAILABLE', detail: 'No verified family list is available.' }); }
  }

  async select(subject: string, value: unknown): Promise<ParentFamilyChoices> {
    let input;
    try { input = validateSelectParentFamilyInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'PARENT_FAMILY_FORBIDDEN' });
    let data: unknown;
    try { data = await this.database.selectParentFamily(subject, input, randomUUID()); } catch (error) { translate(error); }
    try { return verifyParentFamilySelection(data, input); } catch { throw new ServiceUnavailableException({ code: 'PARENT_FAMILY_UNAVAILABLE', detail: 'No verified family list is available.' }); }
  }
}
