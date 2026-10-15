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
import { ParentStudentJourneyController } from './families/parent-student-journey.controller.js';
import { ParentStudentJourneyService } from './families/parent-student-journey.service.js';
import { ParentFamilyScheduleController } from './families/parent-family-schedule.controller.js';
import { ParentFamilyScheduleService } from './families/parent-family-schedule.service.js';
import { ParentPlannedAbsenceController } from './families/parent-planned-absence.controller.js';
import { ParentPlannedAbsenceService } from './families/parent-planned-absence.service.js';
import { CrmLeadActionTool } from './crm/crm-lead-action.tool.js';
import { CurriculumController } from './curriculum/curriculum.controller.js';
import { CurriculumService } from './curriculum/curriculum.service.js';
import { CurriculumRankService } from './curriculum/curriculum-rank.service.js';
import { TestingEventController } from './testing/testing-event.controller.js';
import { TestingEventService } from './testing/testing-event.service.js';
import { TestingCandidateController } from './testing/testing-candidate.controller.js';
import { TestingCandidateGradeController } from './testing/testing-candidate-grade.controller.js';
import { TestingCandidateService } from './testing/testing-candidate.service.js';
import { PromotionDecisionController } from './testing/promotion-decision.controller.js';
import { PromotionDecisionService } from './testing/promotion-decision.service.js';
import { ProgramController } from './programs/program.controller.js';
import { ProgramService } from './programs/program.service.js';
import { ClassSessionController } from './schedule/class-session.controller.js';
import { ClassSessionService } from './schedule/class-session.service.js';
import { AttendanceController } from './schedule/attendance.controller.js';
import { AttendanceService } from './schedule/attendance.service.js';
import { ClassBookingController } from './schedule/class-booking.controller.js';
import { ClassBookingService } from './schedule/class-booking.service.js';
import { PlannedAbsenceReviewController } from './schedule/planned-absence-review.controller.js';
import { PlannedAbsenceReviewService } from './schedule/planned-absence-review.service.js';
import { KnowledgeArticleController } from './knowledge/knowledge-article.controller.js';
import { KnowledgeArticleService } from './knowledge/knowledge-article.service.js';
import { ParentFamilyKnowledgeController } from './knowledge/parent-family-knowledge.controller.js';
import { ParentFamilyKnowledgeService } from './knowledge/parent-family-knowledge.service.js';

@Module({
  controllers: [
    HealthController,
    ReadinessController,
    FoundationController,
    SessionContextController,
    IdentityController,
    PersonController,
    FamilyController,
    ParentStudentJourneyController,
    ParentFamilyScheduleController,
    ParentPlannedAbsenceController,
    LeadController,
    PipelineController,
    CurriculumController,
    ProgramController,
    ClassSessionController,
    AttendanceController,
    ClassBookingController,
    PlannedAbsenceReviewController,
    KnowledgeArticleController,
    ParentFamilyKnowledgeController,
    TestingEventController,
    TestingCandidateController,
    TestingCandidateGradeController,
    PromotionDecisionController,
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
    ParentStudentJourneyService,
    ParentFamilyScheduleService,
    ParentPlannedAbsenceService,
    LeadService,
    CrmLeadActionTool,
    PipelineService,
    CurriculumService,
    CurriculumRankService,
    ProgramService,
    ClassSessionService,
    AttendanceService,
    ClassBookingService,
    PlannedAbsenceReviewService,
    KnowledgeArticleService,
    ParentFamilyKnowledgeService,
    TestingEventService,
    TestingCandidateService,
    PromotionDecisionService,
    ActionEngineService,
    InterfaceThemeService,
    MembershipService,
    BillingAccountService,
    HqOnboardingService,
  ],
})
export class AppModule {}
