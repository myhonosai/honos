import { Allow } from 'class-validator';
import { Injectable } from '@nestjs/common';
import type { AutomationRuleInput, AutomationDryRunInput } from '@hon/contracts';
import { StaffAvailabilityHumanUiGuard } from '../staff-availability/staff-availability.dto.js';
export class AutomationRuleDto implements AutomationRuleInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare name: string;
  @Allow() declare enabled: boolean;
  @Allow() declare triggerKind: AutomationRuleInput['triggerKind'];
  @Allow() declare conditions: AutomationRuleInput['conditions'];
  @Allow() declare proposal: AutomationRuleInput['proposal'];
  @Allow() declare posture: AutomationRuleInput['posture'];
  @Allow() declare schedule: AutomationRuleInput['schedule'];
}
export class AutomationDryRunDto implements AutomationDryRunInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare event: AutomationDryRunInput['event'];
  @Allow() declare simulation: AutomationDryRunInput['simulation'];
}
@Injectable()
export class AutomationRuleHumanUiGuard extends StaffAvailabilityHumanUiGuard { protected readonly command: string = 'automation-rules'; }
