import { Allow } from 'class-validator';

/** 0467 shift save. Every field is closed-validated by the shared contract validator in the service. */
export class SaveStaffShiftDto {
  @Allow() shiftId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() staffPrincipalId?: unknown;
  @Allow() date?: unknown;
  @Allow() start?: unknown;
  @Allow() end?: unknown;
  @Allow() position?: unknown;
  @Allow() note?: unknown;
  @Allow() status?: unknown;
}
