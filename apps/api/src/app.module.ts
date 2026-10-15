import { MarketingAssistantController, MarketingAssistantHumanUiGuard } from './marketing/marketing-assistant.controller.js';
import { MarketingAssistantService } from './marketing/marketing-assistant.service.js';
import { MARKETING_PROVIDER_RUNTIME, OpenRouterRuntime } from './ai/provider-runtime.js';
import { MarketplaceController } from './marketplace/marketplace.controller.js';
import { MarketplaceService } from './marketplace/marketplace.service.js';
import { MarketplaceHumanUiGuard } from './marketplace/marketplace.dto.js';
import { VoiceController, VoiceHumanUiGuard } from './voice/voice.controller.js';
import { VoiceService } from './voice/voice.service.js';
import { StaffPublicFormController, PublishedFormController, PublicFormHumanUiGuard } from './marketing/public-form.controller.js';
import { PublicFormService } from './marketing/public-form.service.js';
import { CampaignController } from './marketing/campaign.controller.js';
import { CampaignService } from './marketing/campaign.service.js';
import { CampaignHumanUiGuard } from './marketing/campaign-human-ui.guard.js';
import { RevenuePlanningController } from './planning/revenue-planning.controller.js';
import { RevenuePlanningService } from './planning/revenue-planning.service.js';
import { RevenuePlanningHumanUiGuard } from './planning/revenue-planning-human-ui.guard.js';
import { TestingHumanUiGuard } from './testing/testing-human-ui.guard.js';
import { DocumentController } from './documents/document.controller.js';
import { ParentDocumentController } from './documents/parent-document.controller.js';
import { DocumentService } from './documents/document.service.js';
import { CurriculumProgressController } from './curriculum/curriculum-progress.controller.js';
import { CurriculumProgressService } from './curriculum/curriculum-progress.service.js';
import { CurriculumHumanUiGuard } from './curriculum/curriculum-human-ui.guard.js';
import { DocumentHumanUiGuard } from './documents/document-human-ui.guard.js';
import { Module } from '@nestjs/common';
import { LeadImportController } from './migration/lead-import.controller.js';
import { LeadImportService } from './migration/lead-import.service.js';
import { LeadImportHumanUiGuard } from './migration/lead-import-human-ui.guard.js';
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
import { ActionReviewController, ActionApprovalWorkbenchController } from './action/action-review.controller.js';
import { FamilyController } from './families/family.controller.js';
import { FamilyService } from './families/family.service.js';
import { ParentStudentJourneyController } from './families/parent-student-journey.controller.js';
import { ParentJourneyViewController, ParentJourneyReadGuard } from './families/parent-journey-view.controller.js';
import { ParentJourneyViewService } from './families/parent-journey-view.service.js';
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
import { TestingCertificateController } from './testing/testing-certificate.controller.js';
import { TestingCertificateService } from './testing/testing-certificate.service.js';
import { TestingCertificateHumanUiGuard } from './testing/testing-certificate.dto.js';
import { ParentTestingRegistrationController, StaffTestingRegistrationController } from './testing/testing-registration.controller.js';
import { TestingRegistrationService } from './testing/testing-registration.service.js';
import { TestingRegistrationHumanUiGuard } from './testing/testing-registration-human-ui.guard.js';
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
import { WorkItemHumanUiGuard } from './work-items/work-item.dto.js';
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
import { CommandCenterController } from './reports/command-center.controller.js';
import { CommandCenterService } from './reports/command-center.service.js';
import { HealthScoreController } from './reports/health-score.controller.js';
import { HealthScoreService } from './reports/health-score.service.js';
import { CommunicationMessageController } from './communication/communication-message.controller.js';
import { CommunicationMessageService } from './communication/communication-message.service.js';
import { HqAiProviderController } from './hq/hq-ai-provider.controller.js';
import { HqAiProviderService } from './hq/hq-ai-provider.service.js';
import { StaffRoleController } from './staff-roles/staff-role.controller.js';
import { StaffRoleService } from './staff-roles/staff-role.service.js';
import { StaffRoleHumanUiGuard } from './staff-roles/staff-role-human-ui.guard.js';
import { StaffSearchController } from './search/staff-search.controller.js';
import { StaffSearchService } from './search/staff-search.service.js';

import { StaffAvailabilityController } from './staff-availability/staff-availability.controller.js';
import { StaffAvailabilityService } from './staff-availability/staff-availability.service.js';
import { StaffAvailabilityHumanUiGuard } from './staff-availability/staff-availability.dto.js';
import { AutomationRuleController } from './automation-rules/automation-rule.controller.js';
import { AutomationRuleService } from './automation-rules/automation-rule.service.js';
import { AutomationRuleHumanUiGuard } from './automation-rules/automation-rule.dto.js';

import { FollowUpController } from './crm/follow-up.controller.js';
import { FollowUpService } from './crm/follow-up.service.js';
import { FollowUpHumanUiGuard } from './crm/follow-up.dto.js';
import { RenewalController } from './billing/renewal.controller.js';
import { RenewalService } from './billing/renewal.service.js';
import { RenewalHumanUiGuard } from './billing/renewal.dto.js';

import { CommunityController } from './community/community.controller.js';
import { CommunityService } from './community/community.service.js';
import { CommunityHumanUiGuard } from './community/community.dto.js';
import { AchievementsController, ParentAchievementsController } from './achievements/achievements.controller.js';
import { AchievementsService } from './achievements/achievements.service.js';
import { AchievementHumanUiGuard } from './achievements/achievements.dto.js';
import { TeachingStudioController } from './teaching-studio/teaching-studio.controller.js';
import { TeachingStudioService } from './teaching-studio/teaching-studio.service.js';
import { TeachingStudioHumanUiGuard } from './teaching-studio/teaching-studio.dto.js';
import { RetentionReviewController } from './retention-review/retention-review.controller.js';
import { RetentionReviewService } from './retention-review/retention-review.service.js';
import { RetentionReviewHumanUiGuard } from './retention-review/retention-review.dto.js';

@Module({
  controllers: [
    AchievementsController, ParentAchievementsController,
    TeachingStudioController,
    RetentionReviewController,
    VoiceController,
    MarketplaceController,
    CommunityController,
    RenewalController,
    FollowUpController,
    AutomationRuleController,
    StaffAvailabilityController,
    StaffPublicFormController, PublishedFormController,
    CampaignController,
    MarketingAssistantController,
    RevenuePlanningController,
    StaffSearchController,
    CurriculumProgressController,
    LeadImportController,
    DocumentController, ParentDocumentController,
    StaffRoleController,
    HealthController,
    ReadinessController,
    FoundationController,
    SessionContextController,
    IdentityController,
    PersonController,
    FamilyController,
    ParentJourneyViewController,
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
    CommandCenterController,
    HealthScoreController,
    CommunicationConsentController,
    CommunicationMessageController,
    TestingEventController,
    TestingCandidateController,
    TestingCandidateGradeController,
    PromotionDecisionController,
    TestingCertificateController,
    ParentTestingRegistrationController,
    StaffTestingRegistrationController,
    InterfaceThemeController,
    MembershipController,
    BillingAccountController,
    InvoiceController,
    HqController,
    HqOnboardingController,
    HqAiProviderController,
    ActionReviewController, ActionApprovalWorkbenchController,
  ],
  providers: [
    AchievementsService, AchievementHumanUiGuard,
    TeachingStudioService, TeachingStudioHumanUiGuard,
    RetentionReviewService, RetentionReviewHumanUiGuard,
    ParentJourneyViewService, ParentJourneyReadGuard,
    VoiceService, VoiceHumanUiGuard,
    MarketplaceService, MarketplaceHumanUiGuard,
    CommunityService, CommunityHumanUiGuard,
    RenewalService, RenewalHumanUiGuard,
    FollowUpService, FollowUpHumanUiGuard,
    AutomationRuleService, AutomationRuleHumanUiGuard,
    StaffAvailabilityService, StaffAvailabilityHumanUiGuard,
    PublicFormService, PublicFormHumanUiGuard,
    CampaignService,
    MarketingAssistantService,
    MarketingAssistantHumanUiGuard,
    { provide: MARKETING_PROVIDER_RUNTIME, useFactory: () => new OpenRouterRuntime() }, CampaignHumanUiGuard,
    RevenuePlanningService, RevenuePlanningHumanUiGuard,
    StaffSearchService,
    CurriculumProgressService, CurriculumHumanUiGuard, TestingHumanUiGuard,
    LeadImportService, LeadImportHumanUiGuard,
    DocumentService, DocumentHumanUiGuard,
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
    WorkItemService, WorkItemHumanUiGuard,
    AiUsageService,
    AiInvocationPlanService,
    AiTeamService,
    OperationsReportService,
    OperationsSummaryService,
    CommandCenterService,
    HealthScoreService,
    CommunicationConsentService,
    CommunicationMessageService,
    TestingEventService,
    TestingCandidateService,
    PromotionDecisionService,
    TestingCertificateService,
    TestingCertificateHumanUiGuard,
    TestingRegistrationService,
    TestingRegistrationHumanUiGuard,
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
