import { Module } from '@nestjs/common';
import { FoundationController } from './foundation/foundation.controller.js';
import { HonIdentityGuard } from './foundation/hon-identity.guard.js';
import { ManusIdentityService } from './foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from './foundation/runtime-database.service.js';
import { SessionContextController } from './foundation/session-context.controller.js';
import { HealthController } from './health/health.controller.js';
import { ReadinessController } from './health/readiness.controller.js';
import { LeadController } from './crm/lead.controller.js';
import { LeadService } from './crm/lead.service.js';
import { ActionEngineService } from './action/action-engine.service.js';
import { InterfaceThemeController } from './preferences/interface-theme.controller.js';
import { InterfaceThemeService } from './preferences/interface-theme.service.js';
import { MembershipController } from './billing/membership.controller.js';
import { MembershipService } from './billing/membership.service.js';
import { BillingAccountController } from './billing/billing-account.controller.js';
import { BillingAccountService } from './billing/billing-account.service.js';
import { HqController } from './hq/hq.controller.js';
import { IdentityController } from './foundation/identity.controller.js';
import { PipelineController } from './crm/pipeline.controller.js';
import { PipelineService } from './crm/pipeline.service.js';
import { HqOnboardingController } from './hq/hq-onboarding.controller.js';
import { HqOnboardingService } from './hq/hq-onboarding.service.js';
import { PersonController } from './people/person.controller.js';
import { PersonService } from './people/person.service.js';
import { ActionReviewController } from './action/action-review.controller.js';
import { FamilyController } from './families/family.controller.js';
import { FamilyService } from './families/family.service.js';
import { CrmLeadActionTool } from './crm/crm-lead-action.tool.js';
import { CurriculumController } from './curriculum/curriculum.controller.js';
import { CurriculumService } from './curriculum/curriculum.service.js';
import { CurriculumRankService } from './curriculum/curriculum-rank.service.js';
import { TestingEventController } from './testing/testing-event.controller.js';
import { TestingEventService } from './testing/testing-event.service.js';
import { ProgramController } from './programs/program.controller.js';
import { ProgramService } from './programs/program.service.js';
import { ClassSessionController } from './schedule/class-session.controller.js';
import { ClassSessionService } from './schedule/class-session.service.js';
import { AttendanceController } from './schedule/attendance.controller.js';
import { AttendanceService } from './schedule/attendance.service.js';

@Module({
  controllers: [
    HealthController,
    ReadinessController,
    FoundationController,
    SessionContextController,
    IdentityController,
    PersonController,
    FamilyController,
    LeadController,
    PipelineController,
    CurriculumController,
    ProgramController,
    ClassSessionController,
    AttendanceController,
    TestingEventController,
    InterfaceThemeController,
    MembershipController,
    BillingAccountController,
    HqController,
    HqOnboardingController,
    ActionReviewController,
  ],
  providers: [
    RuntimeDatabaseService,
    ManusIdentityService,
    HonIdentityGuard,
    PersonService,
    FamilyService,
    LeadService,
    CrmLeadActionTool,
    PipelineService,
    CurriculumService,
    CurriculumRankService,
    ProgramService,
    ClassSessionService,
    AttendanceService,
    TestingEventService,
    ActionEngineService,
    InterfaceThemeService,
    MembershipService,
    BillingAccountService,
    HqOnboardingService,
  ],
})
export class AppModule {}
