import { Module } from '@nestjs/common';
import { FoundationController } from './foundation/foundation.controller.js';
import { HonIdentityGuard } from './foundation/hon-identity.guard.js';
import { HonIdentityService } from './foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from './foundation/runtime-database.service.js';
import { SessionContextController } from './foundation/session-context.controller.js';
import { HealthController } from './health/health.controller.js';
import { ReadinessController } from './health/readiness.controller.js';
import { LeadController } from './crm/lead.controller.js';
import { LeadService } from './crm/lead.service.js';
import { TrialAppointmentController } from './crm/trial-appointment.controller.js';
import { TrialAppointmentService } from './crm/trial-appointment.service.js';
import { TrialAppointmentOutcomeController } from './crm/trial-appointment-outcome.controller.js';
import { TrialAppointmentOutcomeService } from './crm/trial-appointment-outcome.service.js';
import { ActionEngineService } from './action/action-engine.service.js';
import { InterfaceThemeController } from './preferences/interface-theme.controller.js';
import { InterfaceThemeService } from './preferences/interface-theme.service.js';
import { MembershipController } from './billing/membership.controller.js';
import { MembershipService } from './billing/membership.service.js';
import { BillingAccountController } from './billing/billing-account.controller.js';
import { BillingAccountService } from './billing/billing-account.service.js';
import { InvoiceController } from './billing/invoice.controller.js';
import { InvoiceService } from './billing/invoice.service.js';
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
import { WorkItemController } from './work-items/work-item.controller.js';
import { WorkItemService } from './work-items/work-item.service.js';
import { AiInvocationPlanController } from './ai/ai-invocation-plan.controller.js';
import { AiInvocationPlanService } from './ai/ai-invocation-plan.service.js';
import { AiUsageController } from './ai/ai-usage.controller.js';
import { AiUsageService } from './ai/ai-usage.service.js';
import { AiTeamController } from './ai-team/ai-team.controller.js';
import { AiTeamService } from './ai-team/ai-team.service.js';
import { OperationsReportController } from './reports/operations-report.controller.js';
import { OperationsReportService } from './reports/operations-report.service.js';
import { CommunicationConsentController } from './communication/communication-consent.controller.js';
import { CommunicationConsentService } from './communication/communication-consent.service.js';
import { OperationsSummaryController } from './reports/operations-summary.controller.js';
import { OperationsSummaryService } from './reports/operations-summary.service.js';
import { CommunicationMessageController } from './communication/communication-message.controller.js';
import { CommunicationMessageService } from './communication/communication-message.service.js';
import { HqAiProviderController } from './hq/hq-ai-provider.controller.js';
import { HqAiProviderService } from './hq/hq-ai-provider.service.js';
import { StaffRoleController } from './staff-roles/staff-role.controller.js';
import { StaffRoleService } from './staff-roles/staff-role.service.js';
import { StaffRoleHumanUiGuard } from './staff-roles/staff-role-human-ui.guard.js';

@Module({
  controllers: [
    StaffRoleController,
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
    TrialAppointmentController,
    TrialAppointmentOutcomeController,
    PipelineController,
    CurriculumController,
    ProgramController,
    ClassSessionController,
    AttendanceController,
    ClassBookingController,
    PlannedAbsenceReviewController,
    KnowledgeArticleController,
    ParentFamilyKnowledgeController,
    WorkItemController,
    AiUsageController,
    AiInvocationPlanController,
    AiTeamController,
    OperationsReportController,
    OperationsSummaryController,
    CommunicationConsentController,
    CommunicationMessageController,
    TestingEventController,
    TestingCandidateController,
    TestingCandidateGradeController,
    PromotionDecisionController,
    InterfaceThemeController,
    MembershipController,
    BillingAccountController,
    InvoiceController,
    HqController,
    HqOnboardingController,
    HqAiProviderController,
    ActionReviewController,
  ],
  providers: [
    StaffRoleService,
    StaffRoleHumanUiGuard,
    RuntimeDatabaseService,
    HonIdentityService,
    HonIdentityGuard,
    PersonService,
    FamilyService,
    ParentStudentJourneyService,
    ParentFamilyScheduleService,
    ParentPlannedAbsenceService,
    LeadService,
    TrialAppointmentService,
    TrialAppointmentOutcomeService,
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
    WorkItemService,
    AiUsageService,
    AiInvocationPlanService,
    AiTeamService,
    OperationsReportService,
    OperationsSummaryService,
    CommunicationConsentService,
    CommunicationMessageService,
    TestingEventService,
    TestingCandidateService,
    PromotionDecisionService,
    ActionEngineService,
    InterfaceThemeService,
    MembershipService,
    BillingAccountService,
    InvoiceService,
    HqOnboardingService,
    HqAiProviderService,
  ],
})
export class AppModule {}
