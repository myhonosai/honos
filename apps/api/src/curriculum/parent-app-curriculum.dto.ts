import { Allow } from 'class-validator';
import type { CurriculumAppSettingsInput } from '@hon/contracts';
/** Closed bodies; the service validates every field again with the contract checks and the database checks a third time. */
export class CurriculumAppSettingsDto implements CurriculumAppSettingsInput {
 @Allow() declare expectedVersion: number; @Allow() declare displayMode: CurriculumAppSettingsInput['displayMode']; @Allow() declare showInApp: boolean;
 @Allow() declare rankShowEarlier: boolean; @Allow() declare rankShowNext: boolean; @Allow() declare cycleRotation: CurriculumAppSettingsInput['cycleRotation'];
 @Allow() declare cycleAnchorDate: string|null; @Allow() declare cycleLengthWeeks: number|null; @Allow() declare cycleShowNext: boolean;
}
export class CurriculumCycleCreateDto { @Allow() declare name: string }
export class CurriculumCycleRenameDto { @Allow() declare expectedVersion: number; @Allow() declare name: string }
export class CurriculumCycleVersionDto { @Allow() declare expectedVersion: number }
export class CurriculumCycleOrderDto { @Allow() declare cycleIds: string[] }
