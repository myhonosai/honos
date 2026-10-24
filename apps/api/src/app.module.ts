import { CrmAdultMembershipDraftController } from './billing/crm-adult-membership-draft.controller.js';
import { CrmAdultMembershipDraftService } from './billing/crm-adult-membership-draft.service.js';
import { CrmAdultMembershipDraftFromPlanController, MembershipPlanController } from './billing/membership-plan.controller.js';
import { MembershipPlanService } from './billing/membership-plan.service.js';
import { GuardianChildEnrollmentController, GuardianChildMembershipDraftController } from './crm/guardian-child-enrollment.controller.js';
import { GuardianChildEnrollmentService } from './crm/guardian-child-enrollment.service.js';
import { CrmGuardianChildAdditionHumanUiGuard, CrmGuardianChildEnrollmentReadHumanUiGuard, CrmGuardianChildMembershipDraftFromPlanHumanUiGuard, CrmGuardianChildPayerDesignationHumanUiGuard } from './crm/guardian-child-enrollment.dto.js';
import { CrmAdultMembershipDraftFromPlanHumanUiGuard, CrmAdultMembershipPlanOptionsHumanUiGuard, MembershipPlanCatalogHumanUiGuard, MembershipPlanCreateHumanUiGuard, MembershipPlanReviseHumanUiGuard } from './billing/membership-plan.dto.js';
import { CrmAdultMembershipConfirmationHumanUiGuard, CrmAdultMembershipDraftHumanUiGuard, CrmAdultMembershipPreparationHumanUiGuard, CrmAdultMembershipNoStoreGuard } from './billing/crm-adult-membership-draft.dto.js';
import { OwnerLaunchHumanUiGuard, OwnerLaunchGuardianChildHumanUiGuard, OwnerLaunchFirstClassBookingHumanUiGuard, OwnerLaunchMembershipDraftHumanUiGuard } from './owner-launch/owner-launch-human-ui.guard.js';
import { OwnerLaunchController } from './owner-launch/owner-launch.controller.js';
import { OwnerLaunchService } from './owner-launch/owner-launch.service.js';
import { CurriculumLibraryService } from './curriculum/library.service.js';
import { StaffCurriculumLibraryController, ParentCurriculumLibraryController, CurriculumLibraryHumanUiGuard, ParentCurriculumLibraryReadGuard } from './curriculum/library.controller.js';
import { ParentClassPassViewController, ParentClassPassReadGuard } from './families/parent-classpass-view.controller.js';
import { ParentClassPassViewService } from './families/parent-classpass-view.service.js';
import { ClassPassModule } from './classpass/classpass.module.js';
import { PromotionReadinessController } from './testing/promotion-readiness.controller.js';
import { PromotionReadinessService } from './testing/promotion-readiness.service.js';
import { MarketingAssistantController, MarketingAssistantHumanUiGuard } from './marketing/marketing-assistant.controller.js';
import { MarketingAssistantService } from './marketing/marketing-assistant.service.js';
import { MARKETING_PROVIDER_RUNTIME, OpenRouterRuntime } from './ai/provider-runtime.js';
import { ChadFollowUpAssistantController, ChadFollowUpAssistantHumanUiGuard } from './chad-follow-up-assistant/chad-follow-up-assistant.controller.js';
import { ChadFollowUpAssistantService } from './chad-follow-up-assistant/chad-follow-up-assistant.service.js';
import { CHAD_PROVIDER_RUNTIME, OpenRouterChadRuntime } from './ai/chad-provider-runtime.js';
import { TeachingAssistantController, TeachingAssistantHumanUiGuard } from './teaching-assistant/teaching-assistant.controller.js';
import { TeachingAssistantService } from './teaching-assistant/teaching-assistant.service.js';
import { CLAIRE_PROVIDER_RUNTIME, OpenRouterClaireRuntime } from './ai/claire-provider-runtime.js';
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
import { LeadCreateHumanUiGuard } from './crm/lead-create-human-ui.guard.js';
import { LeadCloseController } from './crm/lead-close.controller.js';
import { LeadCloseService } from './crm/lead-close.service.js';
import { LeadCloseHumanUiGuard } from './crm/lead-close.dto.js';
import { LeadRegistrationController } from './crm/lead-registration.controller.js';
import { LeadRegistrationService } from './crm/lead-registration.service.js';
import { LeadRegistrationHumanUiGuard } from './crm/lead-registration.dto.js';
import { LeadRegistrationRecoveryController } from './crm/lead-registration-recovery.controller.js';
import { LeadRegistrationRecoveryService } from './crm/lead-registration-recovery.service.js';
import { LeadRegistrationRecoveryHumanUiGuard } from './crm/lead-registration-recovery.dto.js';
import { TrialAppointmentController } from './crm/trial-appointment.controller.js';
import { TrialAppointmentService } from './crm/trial-appointment.service.js';
import { TrialAppointmentOutcomeController } from './crm/trial-appointment-outcome.controller.js';
import { TrialAppointmentOutcomeService } from './crm/trial-appointment-outcome.service.js';
import { ActionEngineService } from './action/action-engine.service.js';
import { InterfaceThemeController } from './preferences/interface-theme.controller.js';
import { InterfaceThemeService } from './preferences/interface-theme.service.js';
import { MembershipController } from './billing/membership.controller.js';
import { MembershipService } from './billing/membership.service.js';
import { MembershipDateRevisionController } from './billing/membership-date-revision.controller.js';
import { MembershipDateRevisionService } from './billing/membership-date-revision.service.js';
import { MembershipStatusReportController } from './reports/membership-status-report.controller.js';
import { MembershipActivationHumanUiGuard } from './billing/membership-activation-human-ui.guard.js';
import { BillingAccountController } from './billing/billing-account.controller.js';
import { BillingAccountService } from './billing/billing-account.service.js';
import { BillingAccountHumanUiGuard } from './billing/billing-account-human-ui.guard.js';
import { InvoiceController } from './billing/invoice.controller.js';
import { InvoiceService } from './billing/invoice.service.js';
import { InvoiceHumanUiGuard } from './billing/invoice-human-ui.guard.js';
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
import { ParentBillingViewController, ParentBillingReadGuard } from './families/parent-billing-view.controller.js';
import { ParentBillingViewService } from './families/parent-billing-view.service.js';
import { ParentStudentJourneyService } from './families/parent-student-journey.service.js';
import { ParentFamilyScheduleController } from './families/parent-family-schedule.controller.js';
import { ParentFamilyScheduleService } from './families/parent-family-schedule.service.js';
import { ParentPlannedAbsenceController } from './families/parent-planned-absence.controller.js';
import { ParentPlannedAbsenceService } from './families/parent-planned-absence.service.js';
import { ParentPlannedAbsenceHistoryController, ParentPlannedAbsenceHistoryReadGuard } from './families/parent-planned-absence-history.controller.js';
import { ParentPlannedAbsenceHistoryService } from './families/parent-planned-absence-history.service.js';
import { ParentPlannedAbsenceRequestController, ParentPlannedAbsenceRequestGuard } from './families/parent-planned-absence-request.controller.js';
import { ParentPlannedAbsenceRequestService } from './families/parent-planned-absence-request.service.js';
import { ParentMessageHistoryController, ParentMessageHistoryReadGuard } from './families/parent-message-history.controller.js';
import { ParentMessageHistoryService } from './families/parent-message-history.service.js';
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
import { TestingScorecardController } from './testing/testing-scorecard.controller.js';
import { TestingScorecardService } from './testing/testing-scorecard.service.js';
import { TestingScorecardHumanUiGuard } from './testing/testing-scorecard.dto.js';
import { ParentTestingRegistrationController, StaffTestingRegistrationController } from './testing/testing-registration.controller.js';
import { TestingRegistrationService } from './testing/testing-registration.service.js';
import { TestingRegistrationHumanUiGuard } from './testing/testing-registration-human-ui.guard.js';
import { ParentTestingStatusController, ParentTestingStatusReadGuard } from './testing/parent-testing-status.controller.js';
import { ParentTestingStatusService } from './testing/parent-testing-status.service.js';
import { ProgramController } from './programs/program.controller.js';
import { ProgramService } from './programs/program.service.js';
import { ClassSessionController } from './schedule/class-session.controller.js';
import { ClassSessionHumanUiGuard } from './schedule/class-session-human-ui.guard.js';
import { ClassSessionService } from './schedule/class-session.service.js';
import { ClassSessionsReadController } from './schedule/class-sessions-read.controller.js';
import { ClassSessionsReadHumanUiGuard } from './schedule/class-sessions-read-human-ui.guard.js';
import { ClassSessionsReadService } from './schedule/class-sessions-read.service.js';
import { AttendanceController } from './schedule/attendance.controller.js';
import { AttendanceService } from './schedule/attendance.service.js';
import { AttendancePolicyService } from './schedule/attendance-policy.service.js';
import { AttendancePolicyController } from './schedule/attendance-policy.controller.js';
import { AttendanceHumanUiGuard } from './schedule/attendance-human-ui.guard.js';
import { ClassBookingController } from './schedule/class-booking.controller.js';
import { ClassBookingHumanUiGuard } from './schedule/class-booking-human-ui.guard.js';
import { ClassBookingService } from './schedule/class-booking.service.js';
import { PlannedAbsenceReviewController } from './schedule/planned-absence-review.controller.js';
import { PlannedAbsenceReviewService } from './schedule/planned-absence-review.service.js';
import { PlannedAbsenceReviewQueueController, PlannedAbsenceReviewQueueService } from './schedule/planned-absence-review-queue.controller.js';
import { PlannedAbsenceReviewHumanUiGuard } from './schedule/planned-absence-review-human-ui.guard.js';
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
import { CurrentStaffReportingSchoolController, CurrentStaffReportingSchoolNoStoreGuard } from './reports/current-staff-reporting-school.controller.js';
import { StaffReportingSchoolsController } from './reports/staff-reporting-schools.controller.js';
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
import { HqOverviewService } from './hq/hq-overview.service.js';
import { HqEntitlementController } from './hq/hq-entitlement.controller.js';
import { HqEntitlementService } from './hq/hq-entitlement.service.js';
import { HqEntitlementHumanUiGuard } from './hq/hq-entitlement.dto.js';
import { ChampionsHqController, ChampionsSchoolController } from './champions/champions-club.controller.js';
import { ChampionsClubService } from './champions/champions-club.service.js';
import { ChampionsCommandGuard, ChampionsReadGuard } from './champions/champions-club.guards.js';
import { SaasBillingHqController, SaasCreditsSchoolController } from './saas-billing/saas-billing.controller.js';
import { SaasBillingService } from './saas-billing/saas-billing.service.js';
import { SaasOffersHqController, SaasOffersSchoolController } from './saas-billing/saas-offers.controller.js';
import { PaymentWebhookController, SaasHonOsCheckoutSchoolController, SaasPaymentsHqController, SaasPlanSchoolController } from './payments/saas-payments.controller.js';
import { SaasPaymentsService } from './payments/saas-payments.service.js';
import { SaasAccessExceptionCommandsHqController, SaasAccessExceptionsHqController, SaasAccessReadinessHqController, SaasAccessRetryHqController, SaasOrganizationAccessHqController, SaasSchoolBillingController } from './school-billing/saas-school-billing.controller.js';
import { SaasSchoolBillingService } from './school-billing/saas-school-billing.service.js';
import { LanguageCommandGuard, LanguagePreferencesService, LanguageReadGuard, MyLanguagePreferenceController, SchoolLanguageDefaultController } from './preferences/language-preferences.controller.js';
import { PAYMENT_PROVIDER_ADAPTER, UnconfiguredPaymentProvider } from './payments/payment-provider.js';
import { paymentProviderFromEnvironment } from './payments/stripe-test-mode-adapter.js';
import { SaasCommandGuard, SaasReadGuard } from './saas-billing/saas-billing.guards.js';
import { HqSchoolDirectoryService } from './hq/hq-school-directory.service.js';
import { StaffRoleController } from './staff-roles/staff-role.controller.js';
import { StaffRoleService } from './staff-roles/staff-role.service.js';
import { StaffRoleHumanUiGuard } from './staff-roles/staff-role-human-ui.guard.js';
import { StaffSearchController } from './search/staff-search.controller.js';
import { StaffSearchService } from './search/staff-search.service.js';

import { StaffAvailabilityController } from './staff-availability/staff-availability.controller.js';
import { StaffAvailabilityService } from './staff-availability/staff-availability.service.js';
import { StaffAvailabilityHumanUiGuard } from './staff-availability/staff-availability.dto.js';
import { InstructorQualificationsController } from './instructor-qualifications/instructor-qualifications.controller.js';
import { InstructorQualificationsService } from './instructor-qualifications/instructor-qualifications.service.js';
import { InstructorQualificationsHumanUiGuard } from './instructor-qualifications/instructor-qualifications.dto.js';
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
import { KioskModule } from './kiosk/kiosk.module.js';

@Module({
  imports: [ClassPassModule, KioskModule],
  controllers: [OwnerLaunchController,
    CurrentStaffReportingSchoolController,
    StaffCurriculumLibraryController, ParentCurriculumLibraryController,
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
    InstructorQualificationsController,
    StaffPublicFormController, PublishedFormController,
    CampaignController,
    MarketingAssistantController,
    ChadFollowUpAssistantController,
    TeachingAssistantController,
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
    ParentBillingViewController,
    ParentClassPassViewController,
    ParentStudentJourneyController,
    ParentFamilyScheduleController,
    ParentPlannedAbsenceController,
    ParentPlannedAbsenceHistoryController,
    ParentPlannedAbsenceRequestController,
    ParentMessageHistoryController,
    LeadController,
    LeadCloseController,
    LeadRegistrationController,
    LeadRegistrationRecoveryController,
    TrialAppointmentController,
    TrialAppointmentOutcomeController,
    PipelineController,
    CurriculumController,
    ProgramController,
    ClassSessionController,
    ClassSessionsReadController,
    AttendanceController,
    AttendancePolicyController,
    ClassBookingController,
    PlannedAbsenceReviewController,
    PlannedAbsenceReviewQueueController,
    KnowledgeArticleController,
    ParentFamilyKnowledgeController,
    WorkItemController,
    AiUsageController,
    AiInvocationPlanController,
    AiTeamController,
    OperationsReportController,
    StaffReportingSchoolsController,
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
    TestingScorecardController,
    PromotionReadinessController,
    ParentTestingRegistrationController,
    StaffTestingRegistrationController,
    ParentTestingStatusController,
    InterfaceThemeController,
    MembershipController,
    MembershipDateRevisionController,
    MembershipStatusReportController,
    CrmAdultMembershipDraftController,
    CrmAdultMembershipDraftFromPlanController,
    MembershipPlanController,
    GuardianChildEnrollmentController,
    GuardianChildMembershipDraftController,
    BillingAccountController,
    InvoiceController,
    HqController,
    HqOnboardingController,
    HqAiProviderController,
    HqEntitlementController,
    ChampionsSchoolController, ChampionsHqController,
    SaasBillingHqController, SaasOffersHqController, SaasOffersSchoolController, SaasCreditsSchoolController, SaasPlanSchoolController, SaasHonOsCheckoutSchoolController, SaasPaymentsHqController, PaymentWebhookController, SaasSchoolBillingController, SaasAccessReadinessHqController, SaasOrganizationAccessHqController, SaasAccessRetryHqController, SaasAccessExceptionsHqController, SaasAccessExceptionCommandsHqController, MyLanguagePreferenceController, SchoolLanguageDefaultController,
    ActionReviewController, ActionApprovalWorkbenchController,
  ],
  providers: [OwnerLaunchService, OwnerLaunchHumanUiGuard, OwnerLaunchGuardianChildHumanUiGuard, OwnerLaunchFirstClassBookingHumanUiGuard, OwnerLaunchMembershipDraftHumanUiGuard,
    CurrentStaffReportingSchoolNoStoreGuard,
    CurriculumLibraryService, CurriculumLibraryHumanUiGuard, ParentCurriculumLibraryReadGuard,
    AchievementsService, AchievementHumanUiGuard,
    TeachingStudioService, TeachingStudioHumanUiGuard,
    RetentionReviewService, RetentionReviewHumanUiGuard,
    ParentJourneyViewService, ParentJourneyReadGuard,
    ParentBillingViewService, ParentBillingReadGuard,
    ParentClassPassViewService, ParentClassPassReadGuard,
    VoiceService, VoiceHumanUiGuard,
    MarketplaceService, MarketplaceHumanUiGuard,
    CommunityService, CommunityHumanUiGuard,
    RenewalService, RenewalHumanUiGuard,
    FollowUpService, FollowUpHumanUiGuard,
    AutomationRuleService, AutomationRuleHumanUiGuard,
    StaffAvailabilityService, StaffAvailabilityHumanUiGuard,
    InstructorQualificationsService, InstructorQualificationsHumanUiGuard,
    PublicFormService, PublicFormHumanUiGuard,
    CampaignService,
    MarketingAssistantService,
    MarketingAssistantHumanUiGuard,
    { provide: MARKETING_PROVIDER_RUNTIME, useFactory: () => new OpenRouterRuntime() }, CampaignHumanUiGuard,
    ChadFollowUpAssistantService,
    ChadFollowUpAssistantHumanUiGuard,
    { provide: CHAD_PROVIDER_RUNTIME, useFactory: () => new OpenRouterChadRuntime() },
    TeachingAssistantService,
    TeachingAssistantHumanUiGuard,
    { provide: CLAIRE_PROVIDER_RUNTIME, useFactory: () => new OpenRouterClaireRuntime() },
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
    ParentPlannedAbsenceHistoryService,
    ParentPlannedAbsenceHistoryReadGuard,
    ParentPlannedAbsenceRequestService,
    ParentPlannedAbsenceRequestGuard,
    ParentMessageHistoryService,
    ParentMessageHistoryReadGuard,
    LeadService,
    LeadCreateHumanUiGuard,
    LeadCloseService,
    LeadCloseHumanUiGuard,
    LeadRegistrationService,
    LeadRegistrationHumanUiGuard,
    LeadRegistrationRecoveryService,
    LeadRegistrationRecoveryHumanUiGuard,
    TrialAppointmentService,
    TrialAppointmentOutcomeService,
    CrmLeadActionTool,
    PipelineService,
    CurriculumService,
    CurriculumRankService,
    ProgramService,
    ClassSessionService,
    ClassSessionHumanUiGuard,
    ClassSessionsReadService,
    ClassSessionsReadHumanUiGuard,
    AttendanceService,
    AttendancePolicyService,
    AttendanceHumanUiGuard,
    ClassBookingHumanUiGuard,
    ClassBookingService,
    PlannedAbsenceReviewService,
    PlannedAbsenceReviewQueueService,
    PlannedAbsenceReviewHumanUiGuard,
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
    TestingScorecardService,
    PromotionReadinessService,
    TestingScorecardHumanUiGuard,
    TestingRegistrationService,
    TestingRegistrationHumanUiGuard,
    ParentTestingStatusService,
    ParentTestingStatusReadGuard,
    ActionEngineService,
    InterfaceThemeService,
    MembershipService,
    MembershipDateRevisionService,
    CrmAdultMembershipDraftService, CrmAdultMembershipDraftHumanUiGuard, CrmAdultMembershipPreparationHumanUiGuard, CrmAdultMembershipConfirmationHumanUiGuard, CrmAdultMembershipNoStoreGuard,
    MembershipPlanService, MembershipPlanCatalogHumanUiGuard, MembershipPlanCreateHumanUiGuard, MembershipPlanReviseHumanUiGuard, CrmAdultMembershipPlanOptionsHumanUiGuard, CrmAdultMembershipDraftFromPlanHumanUiGuard,
    GuardianChildEnrollmentService, CrmGuardianChildEnrollmentReadHumanUiGuard, CrmGuardianChildPayerDesignationHumanUiGuard, CrmGuardianChildAdditionHumanUiGuard, CrmGuardianChildMembershipDraftFromPlanHumanUiGuard,
    MembershipActivationHumanUiGuard,
    BillingAccountService,
    BillingAccountHumanUiGuard,
    InvoiceService,
    InvoiceHumanUiGuard,
    HqOnboardingService,
    HqAiProviderService,
    HqEntitlementService,
    HqEntitlementHumanUiGuard,
    ChampionsClubService, ChampionsCommandGuard, ChampionsReadGuard,
    SaasBillingService, SaasCommandGuard, SaasReadGuard, SaasPaymentsService, SaasSchoolBillingService, LanguagePreferencesService, LanguageReadGuard, LanguageCommandGuard,
    // Real Stripe test mode only when both test credentials are configured; otherwise every call is refused.
    { provide: PAYMENT_PROVIDER_ADAPTER, useFactory: () => paymentProviderFromEnvironment() ?? new UnconfiguredPaymentProvider() },
    HqOverviewService,
    HqSchoolDirectoryService,
  ],
})
export class AppModule {}
