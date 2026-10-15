import { BadRequestException } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';

const DEFAULT_WINDOW_DAYS = 7;
const MAXIMUM_WINDOW_DAYS = 31;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ParentFamilyScheduleRange {
  from: string;
  to: string;
}

/**
 * Both bounds are optional as a pair. Omitting both selects a small future
 * window; accepting a lone bound would create an unbounded parent read.
 */
export class ParentFamilyScheduleQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  to?: string;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function normalizeTimestamp(value: string, fieldName: string): Date {
  const trimmed = value.trim();
  const hasTimezone = /[Tt].*(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const timestamp = new Date(trimmed);
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})[Tt]/.exec(trimmed);
  const year = Number(dateParts?.[1]);
  const month = Number(dateParts?.[2]);
  const day = Number(dateParts?.[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const hasValidCalendarDate = Boolean(dateParts)
    && calendarDate.getUTCFullYear() === year
    && calendarDate.getUTCMonth() === month - 1
    && calendarDate.getUTCDate() === day;
  if (!hasTimezone || !hasValidCalendarDate || Number.isNaN(timestamp.getTime())) {
    throw validationError(`${fieldName} must be an ISO-8601 timestamp with a timezone.`);
  }
  return timestamp;
}

export function normalizeParentFamilyScheduleRange(
  input: ParentFamilyScheduleQueryDto,
  now = new Date(),
): ParentFamilyScheduleRange {
  const hasFrom = input.from !== undefined;
  const hasTo = input.to !== undefined;
  if (hasFrom !== hasTo) {
    throw validationError('from and to must be supplied together.');
  }

  const from = hasFrom
    ? normalizeTimestamp(input.from!, 'from')
    : new Date(now.getTime());
  const to = hasTo
    ? normalizeTimestamp(input.to!, 'to')
    : new Date(now.getTime() + DEFAULT_WINDOW_DAYS * MILLISECONDS_PER_DAY);

  const durationMilliseconds = to.getTime() - from.getTime();
  if (durationMilliseconds <= 0) {
    throw validationError('to must be later than from.');
  }
  if (durationMilliseconds > MAXIMUM_WINDOW_DAYS * MILLISECONDS_PER_DAY) {
    throw validationError('The requested schedule range cannot exceed 31 days.');
  }

  return { from: from.toISOString(), to: to.toISOString() };
}
