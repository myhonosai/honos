import { SchoolOwnerInvitationController, SchoolAccountHumanGuard } from './accounts/school-owner-invitation.controller.js';
import { SchoolOwnerInvitationService } from './accounts/school-owner-invitation.service.js';
import { SchoolOwnershipController } from './accounts/school-ownership.controller.js';
import { SchoolOwnershipService } from './accounts/school-ownership.service.js';
import { SchoolStaffInvitationController, SchoolStaffAccountHumanGuard } from './accounts/school-staff-invitation.controller.js';
import { SchoolStaffInvitationService } from './accounts/school-staff-invitation.service.js';
import { HonOsSignupController, HonOsSignupHumanGuard } from './accounts/hon-os-signup.controller.js';
import { HonOsSignupService } from './accounts/hon-os-signup.service.js';
import { HonOsTrialController, HonOsTrialHumanGuard } from './accounts/hon-os-trial.controller.js';
import { HonOsTrialService } from './accounts/hon-os-trial.service.js';
import { HonOsAdmissionHqController, HonOsAdmissionHumanGuard } from './hon-os-admission/hon-os-admission.controller.js';
import { HonOsAdmissionService } from './hon-os-admission/hon-os-admission.service.js';
import { SchoolFamilyAccessInvitationController, SchoolFamilyAccountHumanGuard } from './accounts/school-family-access-invitation.controller.js';
import { SchoolFamilyAccessInvitationService } from './accounts/school-family-access-invitation.service.js';
import { SaasSubscriptionGenerationService } from './saas-pricing/saas-subscription-generation.service.js';
import { SaasSubscriptionGenerationHqController, SaasSubscriptionGenerationSchoolController } from './saas-pricing/saas-subscription-generation.controller.js';
import { SaasScheduleBillingService } from './saas-pricing/saas-schedule-billing.service.js';
import { SaasScheduleBindingHqController, SaasScheduleBindingSchoolController } from './saas-pricing/saas-schedule-billing.controller.js';
import { SaasPaidReviewHqController } from './saas-paid-review/saas-paid-review.controller.js';
import { SaasPaidReviewService } from './saas-paid-review/saas-paid-review.service.js';
import { SaasFounderAvailabilitySchoolController, SaasFounderPoolHqController } from './saas-founder/saas-founder.controller.js';
import { SaasFounderService } from './saas-founder/saas-founder.service.js';
import { SaasPriceAcceptanceService } from './saas-pricing/saas-price-acceptance.service.js';
import { SaasPriceScheduleHqController, SaasPriceAcceptanceSchoolController } from './saas-pricing/saas-price-acceptance.controller.js';
import { SaasTrialsService } from './saas-trials/saas-trials.service.js';
import { SaasTrialsHqController } from './saas-trials/saas-trials.controller.js';
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
import { ParentAppCurriculumService } from './curriculum/parent-app-curriculum.service.js';
import { StaffParentAppCurriculumController, ParentCurriculumAppController, ParentAppCurriculumHumanUiGuard } from './curriculum/parent-app-curriculum.controller.js';
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
import { HON_REPLY_PROVIDER_RUNTIME, OpenRouterHonReplyRuntime } from './ai/hon-reply-provider-runtime.js';
import { HonReplyService } from './hon-conversation/hon-reply.service.js';
import { EianController, EianAskGuard, EianReadGuard } from './eian/eian.controller.js';
import { EianService } from './eian/eian.service.js';
import { ParentInvoicePayCancelGuard, ParentInvoicePayConfirmGuard, ParentInvoicePayController, ParentInvoicePayStartGuard } from './parent-pay/parent-invoice-pay.controller.js';
import { ParentInvoicePayService } from './parent-pay/parent-invoice-pay.service.js';
import { EIAN_PROVIDER_RUNTIME, OpenRouterEianRuntime } from './eian/eian-provider-runtime.js';
import { CREATIVE_PROVIDER_RUNTIME } from './creative-studio/creative-provider-runtime.js';
import { createCreativeProviderRuntime } from './creative-studio/providers/creative-provider-router.js';
import { CreativeStudioService } from './creative-studio/creative-studio.service.js';
import { CreativeStudioController } from './creative-studio/creative-studio.controller.js';
import { CreativeStudioAvatarsController, CreativeStudioAvatarVideosController } from './creative-studio/creative-studio-avatars.controller.js';
import { CreativeLimitsHqController, CreativeLimitsService } from './creative-studio/creative-limits.controller.js';
import { CREATIVE_JOB_WORKER_STORE, CreativeJobScheduler, CreativeJobWorker, CreativeJobWorkerDatabase } from './creative-studio/creative-job-worker.js';
import { TeachingAssistantController, TeachingAssistantHumanUiGuard } from './teaching-assistant/teaching-assistant.controller.js';
import { TeachingAssistantService } from './teaching-assistant/teaching-assistant.service.js';
import { CLAIRE_PROVIDER_RUNTIME, OpenRouterClaireRuntime } from './ai/claire-provider-runtime.js';
import { AiTeamReadinessController, AiTeamReadinessService } from './ai-team/ai-team-readiness.controller.js';
import { HonConversationController, HonConversationHumanUiGuard, HonConversationService } from './hon-conversation/hon-conversation.controller.js';
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
import { StarterPipelineHumanUiGuard, TemplatePipelineHumanUiGuard } from './crm/starter-pipeline-human-ui.guard.js';
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
import { TrialAppointmentReadController } from './crm/trial-appointment-read.controller.js';
import { TrialAppointmentOutcomeService } from './crm/trial-appointment-outcome.service.js';
import { ActionEngineService } from './action/action-engine.service.js';
import { InterfaceThemeController } from './preferences/interface-theme.controller.js';
import { InterfaceThemeService } from './preferences/interface-theme.service.js';
import { AgentVoiceController } from './preferences/agent-voice.controller.js';
import { AgentVoiceService } from './preferences/agent-voice.service.js';
import { MembershipController } from './billing/membership.controller.js';
import { MembershipService } from './billing/membership.service.js';
import { CrmLeadMembershipsController } from './billing/crm-lead-memberships.controller.js';
import { CrmLeadMembershipsService } from './billing/crm-lead-memberships.service.js';
import { MembershipDateRevisionController } from './billing/membership-date-revision.controller.js';
import { MembershipDateRevisionService } from './billing/membership-date-revision.service.js';
import { MembershipPauseController } from './billing/membership-pause.controller.js';
import { MembershipPauseService } from './billing/membership-pause.service.js';
import { StudentImportController } from './migration/student-import.controller.js';
import { StudentImportService } from './migration/student-import.service.js';
import { PaperImportController } from './paper-import/paper-import.controller.js';
import { PaperImportService } from './paper-import/paper-import.service.js';
import { PAPER_READER_RUNTIME, SyntheticPaperReader } from './paper-import/paper-reader.js';
import { BillingImportController } from './migration/billing-import.controller.js';
import { BillingImportService } from './migration/billing-import.service.js';
import { HistoryImportController } from './migration/history-import.controller.js';
import { HistoryImportService } from './migration/history-import.service.js';
import { PublishedSchoolWebsiteController, SchoolWebsiteController } from './website/school-website.controller.js';
import { SchoolWebsiteService } from './website/school-website.service.js';
import { SchoolWebsiteAiController } from './website/website-ai.controller.js';
import { WebsiteAiService } from './website/website-ai.service.js';
import { WEBSITE_PROVIDER_RUNTIME, OpenRouterWebsiteRuntime } from './ai/website-provider-runtime.js';
import { MerchAiController } from './commerce/shopify/merch-ai.controller.js';
import { MerchAiService } from './commerce/shopify/merch-ai.service.js';
import { COMMERCE_REVIEW_PROVIDER_RUNTIME, COMMERCE_REVIEW_TEXT_PROFILE, MERCH_PROVIDER_RUNTIME, OpenRouterMerchRuntime } from './commerce/shopify/merch-provider-runtime.js';
import { CommerceReviewController } from './commerce/shopify/commerce-review.controller.js';
import { CommerceReviewService } from './commerce/shopify/commerce-review.service.js';
import { PAPER_VISION_RUNTIME, OpenRouterPaperVisionRuntime } from './ai/paper-vision-runtime.js';
import { SchoolOnboardingController } from './onboarding/school-onboarding.controller.js';
import { SchoolOnboardingService } from './onboarding/school-onboarding.service.js';
import { SchoolSupportController } from './support/school-support.controller.js';
import { AutomationWorkflowController, ContactTagController } from './automations/automation.controller.js';
import { AutomationService } from './automations/automation.service.js';
import { AutomationEngineScheduler, AutomationWorkerDatabase } from './automations/automation-engine.js';
import { AutomationActivateHumanUiGuard, AutomationPauseHumanUiGuard, AutomationArchiveHumanUiGuard, AutomationCreateHumanUiGuard, AutomationReadHumanUiGuard, AutomationRestoreHumanUiGuard, AutomationSaveHumanUiGuard, ContactTagAddHumanUiGuard, ContactTagLookupHumanUiGuard, ContactTagRemoveHumanUiGuard } from './automations/automation.guard.js';
import { SchoolSupportService } from './support/school-support.service.js';
import { CustomToolController } from './custom-tools/custom-tool.controller.js';
import { CustomToolService } from './custom-tools/custom-tool.service.js';
import { SchoolSocialController } from './marketing/social/school-social.controller.js';
import { SchoolSocialService } from './marketing/social/school-social.service.js';
import { SchoolSocialPostsController } from './marketing/social/school-social-posts.controller.js';
import { SchoolSocialPostsService } from './marketing/social/school-social-posts.service.js';
import { SchoolSocialInboxController } from './marketing/social/school-social-inbox.controller.js';
import { SchoolSocialInboxService } from './marketing/social/school-social-inbox.service.js';
import { SchoolSocialAdsController } from './marketing/social/school-social-ads.controller.js';
import { SchoolSocialAdsService } from './marketing/social/school-social-ads.service.js';
import { SocialPostDispatcher } from './marketing/social/social-post-dispatcher.js';
import { ZERNIO_SOCIAL_ADAPTER, zernioSocialAdapterFactory } from './marketing/social/zernio-social-adapter.js';
import { SchoolMembershipListController, SchoolMembershipListHumanUiGuard } from './billing/school-membership-list.controller.js';
import { SchoolMembershipListService } from './billing/school-membership-list.service.js';
import { CrmSchoolClockController, CrmSchoolClockHumanUiGuard, CrmSessionSchoolClockController } from './crm/crm-school-clock.controller.js';
import { CrmSchoolClockService } from './crm/crm-school-clock.service.js';
import { MembershipStatusReportController } from './reports/membership-status-report.controller.js';
import { AttendanceReportController, SchoolReportsController, SchoolReportsDashboardController } from './reports/school-reports.controller.js';
import { SchoolContactsController } from './people/school-contacts.controller.js';
import { SchoolContactsService } from './people/school-contacts.service.js';
import { SchoolContactAdminController } from './people/school-contact-admin.controller.js';
import { SchoolContactAdminService } from './people/school-contact-admin.service.js';
import { SchoolReportsService } from './reports/school-reports.service.js';
import { MembershipActivationHumanUiGuard, SimpleInvoiceCreateHumanUiGuard, TuitionPaymentRecordHumanUiGuard, TuitionPaymentVoidHumanUiGuard, TuitionReadHumanUiGuard } from './billing/membership-activation-human-ui.guard.js';
import { TuitionPaymentController } from './billing/tuition-payment.controller.js';
import { SimpleInvoiceController } from './billing/simple-invoice.controller.js';
import { SimpleInvoiceService } from './billing/simple-invoice.service.js';
import { TuitionPaymentService } from './billing/tuition-payment.service.js';
import { SchoolPaymentController } from './school-payments/school-payment.controller.js';
import { SchoolPaymentService } from './school-payments/school-payment.service.js';
import { SCHOOL_PAYMENT_ADAPTERS, schoolPaymentAdaptersFromEnvironment } from './school-payments/school-payment-adapter.js';
import { SCHOOL_PAYMENT_VAULT, schoolPaymentVaultForProcess } from './school-payments/school-payment-vault.js';
import {
  SchoolPayDefaultHumanUiGuard, SchoolPayDisconnectHumanUiGuard, SchoolPayFinishHumanUiGuard, SchoolPayOnboardingLinkHumanUiGuard,
  SchoolPayReadHumanUiGuard, SchoolPayRefreshHumanUiGuard, SchoolPayStartHumanUiGuard,
  SchoolPayExpiringReadHumanUiGuard, SchoolPayMethodDefaultHumanUiGuard, SchoolPayMethodFinishHumanUiGuard, SchoolPayMethodRemoveHumanUiGuard,
  SchoolPayMethodSetupHumanUiGuard, SchoolPayMethodsReadHumanUiGuard,
  SchoolPayAutopayCancelHumanUiGuard, SchoolPayAutopayCycleHumanUiGuard, SchoolPayAutopayEnrollHumanUiGuard, SchoolPayAutopayMethodHumanUiGuard,
  SchoolPayAutopayReadHumanUiGuard, SchoolPayAutopayStateHumanUiGuard, SchoolPayDiscountReadHumanUiGuard, SchoolPayDiscountSetHumanUiGuard,
} from './school-payments/school-payment-human-ui.guard.js';
import { SchoolPayMethodController } from './school-payments/school-pay-method.controller.js';
import { SchoolPayMethodService } from './school-payments/school-pay-method.service.js';
import { SchoolPayAutopayController } from './school-payments/school-pay-autopay.controller.js';
import { SchoolPayAutopayService } from './school-payments/school-pay-autopay.service.js';
import { SchoolPayChargeController } from './school-payments/school-pay-charge.controller.js';
import { SchoolPayChargeService } from './school-payments/school-pay-charge.service.js';
import { SchoolPayOnceService } from './school-payments/school-pay-once.service.js';
import { SchoolCheckoutController } from './school-checkout/school-checkout.controller.js';
import { SchoolCheckoutService } from './school-checkout/school-checkout.service.js';
import { ShopifyController, ShopifyHumanGuard } from './commerce/shopify/shopify.controller.js';
import { ShopifyService } from './commerce/shopify/shopify.service.js';
import { SHOPIFY_APP, shopifyAppFromEnvironment } from './commerce/shopify/shopify-adapter.js';
import { ShopifyWebhookController } from './commerce/shopify/shopify-webhook.controller.js';
import { SHOPIFY_WORKER_STORE, ShopifyBackgroundScheduler, ShopifyBackgroundSync, ShopifyWorkerDatabase } from './commerce/shopify/shopify-worker.js';
import { SchoolCheckoutOrdersReadHumanUiGuard, SchoolCheckoutReadHumanUiGuard, SchoolCheckoutSaveHumanUiGuard, SchoolCheckoutSettingsSaveHumanUiGuard } from './school-checkout/school-checkout-human-ui.guard.js';
import { MayaAtRiskController, MayaAtRiskReadHumanUiGuard } from './maya/maya-at-risk.controller.js';
import { MayaAtRiskService } from './maya/maya-at-risk.service.js';
import { SchoolBrandingController } from './school-branding/school-branding.controller.js';
import { SchoolBrandingService } from './school-branding/school-branding.service.js';
import { SchoolBrandingReadHumanUiGuard, SchoolBrandingSaveHumanUiGuard } from './school-branding/school-branding-human-ui.guard.js';
import { SchoolLocationController } from './school-location/school-location.controller.js';
import { CrmPipelineBoardController } from './crm-pipeline-board/crm-pipeline-board.controller.js';
import { CrmPipelineBoardService } from './crm-pipeline-board/crm-pipeline-board.service.js';
import { CrmLeadStageMoveHumanUiGuard, CrmPipelineBoardReadHumanUiGuard, CrmPipelineStagesSaveHumanUiGuard } from './crm-pipeline-board/crm-pipeline-board-human-ui.guard.js';
import { SchoolLocationService } from './school-location/school-location.service.js';
import { SchoolLocationReadHumanUiGuard, SchoolLocationSaveHumanUiGuard } from './school-location/school-location-human-ui.guard.js';
import { SchoolDemoDataController } from './school-demo-data/school-demo-data.controller.js';
import { StaffShiftController } from './staff-shifts/staff-shifts.controller.js';
import { StaffShiftService } from './staff-shifts/staff-shifts.service.js';
import { StaffShiftReadHumanUiGuard, StaffShiftSaveHumanUiGuard } from './staff-shifts/staff-shifts-human-ui.guard.js';
import { StaffTimeController } from './staff-time/staff-time.controller.js';
import { StaffTimeService } from './staff-time/staff-time.service.js';
import { StaffTimeEntrySaveHumanUiGuard, StaffTimePunchHumanUiGuard, StaffTimeReadHumanUiGuard, StaffTimesheetDecideHumanUiGuard } from './staff-time/staff-time-human-ui.guard.js';
import { SchoolDemoDataService } from './school-demo-data/school-demo-data.service.js';
import { SchoolDemoDataLoadHumanUiGuard, SchoolDemoDataReadHumanUiGuard, SchoolDemoDataRemoveHumanUiGuard } from './school-demo-data/school-demo-data-human-ui.guard.js';
import { BillingAccountController } from './billing/billing-account.controller.js';
import { BillingAccountService } from './billing/billing-account.service.js';
import { BillingAccountHumanUiGuard } from './billing/billing-account-human-ui.guard.js';
import { InvoiceController } from './billing/invoice.controller.js';
import { InvoiceService } from './billing/invoice.service.js';
import { InvoiceHumanUiGuard } from './billing/invoice-human-ui.guard.js';
import { HqController } from './hq/hq.controller.js';
import { IdentityController } from './foundation/identity.controller.js';
import { MobileSessionController } from './foundation/mobile-session.controller.js';
import { PipelineController } from './crm/pipeline.controller.js';
import { PipelineService } from './crm/pipeline.service.js';
import { HqOnboardingController } from './hq/hq-onboarding.controller.js';
import { HqOnboardingService } from './hq/hq-onboarding.service.js';
import { PersonController } from './people/person.controller.js';
import { SchoolPersonRecordController, SchoolPersonRecordHumanGuard } from './people/school-person-record.controller.js';
import { SchoolPersonRecordService } from './people/school-person-record.service.js';
import { SchoolPersonPhotoController, SchoolPersonPhotoHumanGuard } from './people/school-person-photo.controller.js';
import { SchoolPersonPhotoService } from './people/school-person-photo.service.js';
import { SchoolPosController, SchoolPosHumanGuard } from './pos/school-pos.controller.js';
import { SchoolPosService } from './pos/school-pos.service.js';
import { AttendanceCardsController, AttendanceCardsHumanGuard, AttendanceScanController, AttendanceScanHumanGuard } from './schedule/attendance-cards.controller.js';
import { AttendanceCardsService } from './schedule/attendance-cards.service.js';
import { FaceCheckInController, FaceCheckInHumanGuard, FaceCheckInScanController, FaceCheckInScanHumanGuard, FamilyFaceCheckInController, FamilyFaceCheckInSignGuard, FamilyFaceCheckInWithdrawGuard } from './face-checkin/face-checkin.controller.js';
import { FaceCheckInService } from './face-checkin/face-checkin.service.js';
import { FamilyMembershipAgreementController, FamilyMembershipAgreementSignGuard, FamilyPersonPhotoGuard, MembershipAgreementController, MembershipAgreementHumanGuard, MembershipAgreementLinkController, MembershipAgreementLinkHumanGuard, PublicMembershipAgreementLinkController } from './membership-agreement/membership-agreement.controller.js';
import { MembershipAgreementService } from './membership-agreement/membership-agreement.service.js';
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
import { ParentClassBookingBookGuard, ParentClassBookingCancelGuard, ParentClassBookingController, ParentClassBookingReadGuard } from './families/parent-class-booking.controller.js';
import { ParentClassBookingService } from './families/parent-class-booking.service.js';
import { ParentFamilyPickerController, ParentFamilyPickerReadGuard, ParentFamilyPickerSelectGuard } from './families/parent-family-picker.controller.js';
import { ParentFamilyPickerService } from './families/parent-family-picker.service.js';
import { ParentSchoolBookingBookGuard, ParentSchoolBookingCancelGuard, ParentSchoolBookingController, ParentSchoolBookingReadGuard } from './families/parent-school-bookings.controller.js';
import { ParentSchoolBookingService } from './families/parent-school-bookings.service.js';
import { FamilyMessagesInboxController, FamilyMessagesInboxReadGuard, FamilyMessagesMarkReadGuard, FamilyMessagesReplyGuard, ParentFamilyMessagesController, ParentFamilyMessagesReadGuard, ParentFamilyMessagesSendGuard } from './families/family-messages.controller.js';
import { FamilyMessagesService } from './families/family-messages.service.js';
import { ParentSchoolAnnouncementsController, ParentSchoolAnnouncementsReadGuard, SchoolAnnouncementsController, SchoolAnnouncementsPublishGuard, SchoolAnnouncementsReadGuard, SchoolAnnouncementsWithdrawGuard } from './announcements/school-announcements.controller.js';
import { SchoolAnnouncementsService } from './announcements/school-announcements.service.js';
import { ParentPushController, ParentPushRegisterGuard, ParentPushStatusGuard, ParentPushUnregisterGuard } from './parent-push/parent-push.controller.js';
import { ParentPushService } from './parent-push/parent-push.service.js';
import { EXPO_PUSH_TRANSPORT, ExpoPushClient } from './parent-push/expo-push-client.js';
import { PARENT_PUSH_WORKER_STORE, ParentPushScheduler, ParentPushWorker, ParentPushWorkerDatabase } from './parent-push/parent-push-worker.js';
import { ParentProShopController, ParentProShopReadGuard } from './pro-shop/parent-pro-shop.controller.js';
import { ParentProShopService } from './pro-shop/parent-pro-shop.service.js';
import { ParentAttendanceStreaksController, ParentAttendanceStreaksReadGuard } from './attendance-streaks/parent-attendance-streaks.controller.js';
import { ParentAttendanceStreaksService } from './attendance-streaks/parent-attendance-streaks.service.js';
import { JourneyRecommendationsController, JourneyRecommendationsReadGuard, JourneyRecommendationsSaveGuard, JourneyRecommendationsStatusGuard, ParentJourneyRecommendationsController, ParentJourneyRecommendationsReadGuard, ParentJourneyRecommendationsRespondGuard } from './journey-recommendations/journey-recommendations.controller.js';
import { JourneyRecommendationsService } from './journey-recommendations/journey-recommendations.service.js';
import { ParentReferralLinkGuard, ParentReferralsController, ParentReferralsReadGuard } from './referrals/parent-referrals.controller.js';
import { ParentReferralsService } from './referrals/parent-referrals.service.js';
import { PublicReferralController, PublicReferralService } from './referrals/public-referral.controller.js';
import { SchoolReferralProgramGuard, SchoolReferralRewardGuard, SchoolReferralsController, SchoolReferralsReadGuard } from './referrals/school-referrals.controller.js';
import { SchoolReferralsService } from './referrals/school-referrals.service.js';
import { ParentCheckoutCancelGuard, ParentCheckoutConfirmGuard, ParentCheckoutController, ParentCheckoutOrderGuard, ParentCheckoutStartGuard } from './family-checkout/parent-checkout.controller.js';
import { ParentCheckoutService } from './family-checkout/parent-checkout.service.js';
import { ConversationCreateLeadGuard, ConversationLinkGuard, ConversationMarkReadGuard, ConversationReadGuard, ConversationReplyGuard, ConversationUpdateGuard, SchoolConversationsController } from './conversations/school-conversations.controller.js';
import { SchoolConversationsService } from './conversations/school-conversations.service.js';
import { ContactEmailResendGuard, ContactHistoryReadGuard, ContactMessagesController } from './conversations/contact-messages.controller.js';
import { ContactMessagesService } from './conversations/contact-messages.service.js';
import { SchoolMessageHistoryReadGuard, SchoolMessagesController, SchoolOptedOutReadGuard } from './communication/school-messages.controller.js';
import { SchoolMessagesService } from './communication/school-messages.service.js';
import { SchoolMessageTemplatesController, SchoolTemplateSaveGuard, SchoolTemplateStatusGuard, SchoolTemplatesReadGuard } from './communication/school-message-templates.controller.js';
import { SchoolMessageTemplatesService } from './communication/school-message-templates.service.js';
import { CreativeDesignPhotoGuard, CreativeDesignSaveGuard, CreativeDesignStatusGuard, CreativeDesignsController, CreativeDesignsReadGuard } from './creative-studio/creative-designs.controller.js';
import { CreativeDesignsService } from './creative-studio/creative-designs.service.js';
import { ConversationAiController, ConversationAiFileGuard, ConversationAiItemSaveGuard, ConversationAiItemStatusGuard, ConversationAiKnowledgeGuard, ConversationAiProgramHqController, ConversationAiReadGuard, ConversationAiSettingsGuard, ConversationAiUploadGuard } from './conversations/conversation-ai.controller.js';
import { ConversationAiProgramService, ConversationAiService } from './conversations/conversation-ai.service.js';
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
import { ClassSessionPagesController, ClassSessionPagesHumanUiGuard } from './schedule/class-session-pages.controller.js';
import { ClassSeriesController } from './schedule/class-series.controller.js';
import { CalendarCardsController } from './schedule/calendar-cards.controller.js';
import { CalendarCardsService } from './schedule/calendar-cards.service.js';
import { CalendarCardCreateHumanUiGuard, CalendarCardMoveHumanUiGuard, CalendarCardsReadHumanUiGuard } from './schedule/calendar-cards-human-ui.guard.js';
import { CalendarSettingsController, PublicShareCalendarController } from './schedule/calendar-settings.controller.js';
import { CalendarSettingsService } from './schedule/calendar-settings.service.js';
import {
  CalendarBlockOutAddHumanUiGuard, CalendarBlockOutRemoveHumanUiGuard, CalendarBlockOutsReadHumanUiGuard, CalendarSettingsReadHumanUiGuard,
  CalendarShareSettingsSaveHumanUiGuard, ShareCalendarDeleteHumanUiGuard, ShareCalendarSaveHumanUiGuard,
} from './schedule/calendar-settings-human-ui.guard.js';
import { ClassSeriesService } from './schedule/class-series.service.js';
import { PublicSchoolEventController, SchoolEventController } from './schedule/school-event.controller.js';
import { SchoolEventService } from './schedule/school-event.service.js';
import { BookingTypeController, PublicBookingTypeController } from './schedule/booking-type.controller.js';
import { BookingTypeService } from './schedule/booking-type.service.js';
import { PublicWalkInKioskController, WalkInKioskController } from './walk-in-kiosk/walk-in-kiosk.controller.js';
import { WalkInKioskService } from './walk-in-kiosk/walk-in-kiosk.service.js';
import { WalkInKioskDeskPaidHumanUiGuard, WalkInKioskDeviceEndHumanUiGuard, WalkInKioskDeviceStartHumanUiGuard, WalkInKioskReadHumanUiGuard, WalkInKioskSettingsHumanUiGuard } from './walk-in-kiosk/walk-in-kiosk-human-ui.guard.js';
import { BookingTypeBookingStatusHumanUiGuard, BookingTypeReadHumanUiGuard, BookingTypeSaveHumanUiGuard, BookingTypeStatusHumanUiGuard } from './schedule/booking-type-human-ui.guard.js';
import { SchoolEventBookingStatusHumanUiGuard, SchoolEventReadHumanUiGuard, SchoolEventSaveHumanUiGuard, SchoolEventStatusHumanUiGuard } from './schedule/school-event-human-ui.guard.js';
import { ClassSeriesCreateHumanUiGuard, ClassSeriesEndHumanUiGuard, ClassSeriesFillHumanUiGuard, ClassSeriesOngoingHumanUiGuard, ClassSeriesReadHumanUiGuard, ClassSeriesReviseHumanUiGuard, ClassSeriesTopUpHumanUiGuard } from './schedule/class-series-human-ui.guard.js';
import { ClassSessionPagesService } from './schedule/class-session-pages.service.js';
import { AttendanceController } from './schedule/attendance.controller.js';
import { AttendanceService } from './schedule/attendance.service.js';
import { ClassSessionRosterController } from './schedule/class-session-roster.controller.js';
import { ClassSessionRosterService } from './schedule/class-session-roster.service.js';
import { AttendancePolicyService } from './schedule/attendance-policy.service.js';
import { AttendancePolicyController } from './schedule/attendance-policy.controller.js';
import { AttendanceHumanUiGuard } from './schedule/attendance-human-ui.guard.js';
import { ClassBookingController } from './schedule/class-booking.controller.js';
import { BookableStudentsController, BookableStudentsService } from './schedule/bookable-students.js';
import { SchoolPickersController, SchoolPickersService } from './school-pickers/school-pickers.js';
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
import { COMMUNICATION_PROVIDER_ADAPTERS } from './communication/delivery/communication-provider.js';
import { FakeCommunicationProvider } from './communication/delivery/fake-communication-provider.js';
import { COMMUNICATION_WORKER_STORE, CommunicationWorkerDatabase } from './communication/delivery/communication-worker-database.js';
import { CommunicationDispatcher, CommunicationDispatchScheduler } from './communication/delivery/communication-dispatcher.js';
import { SendGridEmailProvider, SendGridEventWebhookVerifier } from './communication/delivery/sendgrid-email-provider.js';
import { CommunicationWebhookController, SENDGRID_EVENT_VERIFIER, TWILIO_WEBHOOK_VERIFIER, ZERNIO_LEAD_VERIFIER } from './communication/delivery/communication-webhook.controller.js';
import { ZernioLeadWebhookVerifier } from './communication/delivery/zernio-lead-webhook.js';
import { TwilioTextProvider, TwilioWebhookVerifier } from './communication/delivery/twilio-text-provider.js';
import { TWILIO_SUBACCOUNT_DIRECTORY, TwilioRestProvisioningClient, twilioSubaccountVaultFromEnvironment, WorkerTwilioSubaccountDirectory, type TwilioSubaccountDirectory } from './communication/delivery/twilio-subaccounts.js';
import { SchoolMissedCallHqController, SchoolMissedCallsController, SchoolTextSenderHqController, ZernioLeadFormHqController } from './communication/delivery/school-text-sender.controller.js';
import { MissedCallTextBackDispatcher } from './communication/delivery/missed-call-text-back.js';
import { SchoolNumberController, SchoolNumberOrderHqController } from './communication/delivery/school-number.controller.js';
import { SchoolNumberCancelHumanUiGuard, SchoolNumberOrderHumanUiGuard, SchoolNumberReadHumanUiGuard } from './communication/delivery/school-number.guard.js';
import { SchoolNumberService } from './communication/delivery/school-number.service.js';
import { SCHOOL_NUMBER_PURCHASE_SETUP, SCHOOL_NUMBER_PURCHASE_STORE, SchoolNumberPurchaseScheduler, SchoolNumberPurchaseWorker } from './communication/delivery/school-number-purchase.js';
import { SCHOOL_A2P_SETUP, SCHOOL_A2P_STORE, SchoolA2pScheduler, SchoolA2pWorker, TWILIO_A2P_CLIENT, UnavailableTwilioA2pClient } from './communication/delivery/school-a2p.js';
import { SchoolA2pCancelHumanUiGuard, SchoolA2pController, SchoolA2pHqController, SchoolA2pReadHumanUiGuard, SchoolA2pRequestHumanUiGuard } from './communication/delivery/school-a2p.controller.js';
import { SchoolA2pService } from './communication/delivery/school-a2p.service.js';
import { TWILIO_NUMBER_CLIENT, TwilioRestNumberClient } from './communication/delivery/twilio-numbers.js';
import { HqAiProviderController } from './hq/hq-ai-provider.controller.js';
import { HqAiProviderService } from './hq/hq-ai-provider.service.js';
import { ZernioIntegrationController, ZernioHumanUiGuard } from './integrations/zernio.controller.js';
import { ZernioIntegrationService } from './integrations/zernio.service.js';
import { ZERNIO_RUNTIME, ZernioCredentialRuntime } from './integrations/zernio-runtime.js';
import { A2pPreparationController, A2pPreparationHumanGuard } from './a2p/a2p-preparation.controller.js';
import { A2pPreparationService } from './a2p/a2p-preparation.service.js';
import { A2P_WEBSITE_INSPECTOR, UnavailableA2pWebsiteInspector } from './a2p/a2p-inspector.js';
import { HqOverviewService } from './hq/hq-overview.service.js';
import { HqEntitlementController } from './hq/hq-entitlement.controller.js';
import { HqEntitlementService } from './hq/hq-entitlement.service.js';
import { HqEntitlementHumanUiGuard } from './hq/hq-entitlement.dto.js';
import { ChampionsHqController, ChampionsSchoolController } from './champions/champions-club.controller.js';
import { ChampionsClubService } from './champions/champions-club.service.js';
import { ChampionsCommandGuard, ChampionsReadGuard } from './champions/champions-club.guards.js';
import { SaasBillingHqController, SaasCreditsSchoolController } from './saas-billing/saas-billing.controller.js';
import { SaasCreativeWalletHqController, SaasCreativeWalletSchoolController } from './saas-billing/saas-creative-wallet.controller.js';
import { SaasCreativeWalletService } from './saas-billing/saas-creative-wallet.service.js';
import { SaasBillingService } from './saas-billing/saas-billing.service.js';
import { SaasOffersHqController, SaasOffersSchoolController } from './saas-billing/saas-offers.controller.js';
import { PaymentWebhookController, SaasHonOsCheckoutSchoolController, SaasPaymentsHqController, SaasPlanSchoolController } from './payments/saas-payments.controller.js';
import { SaasPaymentsService } from './payments/saas-payments.service.js';
import { AiSpendPauseHqController, AiSpendPauseService } from './ai-spend/ai-spend-pause.controller.js';
import { AiSchoolCostLimitHqController, AiSchoolCostLimitService } from './ai-spend/ai-school-cost-limit.controller.js';
import { AiExceptionAllowanceHqController, AiExceptionAllowanceService } from './ai-spend/ai-exception-allowance.controller.js';
import { AiUnknownResolutionHqController, AiUnknownResolutionService } from './ai-spend/ai-unknown-resolution.controller.js';
import { AiSchoolUsageHqController, AiSchoolUsageService } from './ai-spend/ai-school-usage.controller.js';
import { SaasExceptionPolicyHqController, SaasAccessExceptionCommandsHqController, SaasAccessExceptionsHqController, SaasAccessOverviewHqController, HqSchoolDetailController, HqBusinessNumbersController, SaasAccessReadinessHqController, SaasAccessRetryHqController, SaasOrganizationAccessHqController, SaasSchoolBillingController } from './school-billing/saas-school-billing.controller.js';
import { SaasSchoolBillingService } from './school-billing/saas-school-billing.service.js';
import { HqSupportController } from './hq-support/hq-support.controller.js';
import { HqSupportService } from './hq-support/hq-support.service.js';
import { HqCommunicationsController } from './hq-communications/hq-communications.controller.js';
import { HqCommunicationsService } from './hq-communications/hq-communications.service.js';
import { HqContactController } from './hq-communications/hq-contact.controller.js';
import { HqContactService } from './hq-communications/hq-contact.service.js';
import { HQ_MESSAGE_WORKER_STORE, HqMessageDispatchScheduler, HqMessageDispatcher, HqMessageWorkerDatabase } from './hq-communications/hq-message-dispatcher.js';
import { HqMarketingController } from './hq-marketing/hq-marketing.controller.js';
import { HqMarketingService } from './hq-marketing/hq-marketing.service.js';
import { HqPlanPromotionsController, SchoolPlanPromotionsController } from './hq-plan-promotions/hq-plan-promotions.controller.js';
import { HqPlanPromotionsService } from './hq-plan-promotions/hq-plan-promotions.service.js';
import { HqProspectsController } from './hq-prospects/hq-prospects.controller.js';
import { HqProspectsService } from './hq-prospects/hq-prospects.service.js';
import { HqCreativeController } from './hq-creative/hq-creative.controller.js';
import { HqCreativeService } from './hq-creative/hq-creative.service.js';
import { HqHonController } from './hq-hon/hq-hon.controller.js';
import { HqHonService } from './hq-hon/hq-hon.service.js';
import { LanguageCommandGuard, LanguagePreferencesService, LanguageReadGuard, MyLanguagePreferenceController, SchoolLanguageDefaultController } from './preferences/language-preferences.controller.js';
import { PAYMENT_PROVIDER_ADAPTER, UnconfiguredPaymentProvider } from './payments/payment-provider.js';
import { SUBSCRIPTION_SCHEDULE_PROVIDER, UnconfiguredSubscriptionScheduleProvider } from './payments/subscription-schedule-provider.js';
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
  controllers: [HonOsSignupController,HonOsTrialController,HonOsAdmissionHqController,SchoolOwnerInvitationController,SchoolOwnershipController,SchoolStaffInvitationController,SchoolFamilyAccessInvitationController,OwnerLaunchController,
    CurrentStaffReportingSchoolController,
    StaffCurriculumLibraryController, ParentCurriculumLibraryController, StaffParentAppCurriculumController, ParentCurriculumAppController,
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
    MobileSessionController,
    PersonController, SchoolPersonRecordController, SchoolPersonPhotoController, SchoolPosController, AttendanceCardsController, AttendanceScanController, FaceCheckInController, FaceCheckInScanController, FamilyFaceCheckInController, MembershipAgreementController, FamilyMembershipAgreementController, MembershipAgreementLinkController, PublicMembershipAgreementLinkController,
    FamilyController,
    ParentJourneyViewController,
    ParentBillingViewController,
    ParentClassPassViewController,
    ParentStudentJourneyController,
    ParentFamilyScheduleController,
    ParentPlannedAbsenceController,
    ParentPlannedAbsenceHistoryController,
    ParentPlannedAbsenceRequestController,
    ParentClassBookingController,
    ParentFamilyPickerController,
    ParentSchoolBookingController,
    ParentFamilyMessagesController,
    EianController,
    ParentInvoicePayController,
    FamilyMessagesInboxController,
    ParentSchoolAnnouncementsController,
    SchoolAnnouncementsController,
    ParentPushController,
    ParentProShopController,
    ParentAttendanceStreaksController,
    ParentJourneyRecommendationsController,
    JourneyRecommendationsController,
    ParentReferralsController, PublicReferralController, SchoolReferralsController,
    ParentCheckoutController,
    SchoolConversationsController,
    ContactMessagesController,
    SchoolMessagesController,
    SchoolMessageTemplatesController,
    CreativeDesignsController,
    ConversationAiController,
    ConversationAiProgramHqController,
    ParentMessageHistoryController,
    LeadController,
    LeadCloseController,
    LeadRegistrationController,
    LeadRegistrationRecoveryController,
    TrialAppointmentController,
    TrialAppointmentOutcomeController,
    TrialAppointmentReadController,
    PipelineController,
    CurriculumController,
    ProgramController,
    ClassSessionController,
    ClassSessionsReadController,
    ClassSessionPagesController,
    ClassSeriesController,
    CalendarCardsController,
    CalendarSettingsController,
    PublicShareCalendarController,
    SchoolEventController,
    PublicSchoolEventController,
    BookingTypeController,
    PublicBookingTypeController,
    WalkInKioskController,
    PublicWalkInKioskController,
    AttendanceController,
    ClassSessionRosterController,
    AttendancePolicyController,
    ClassBookingController,
    BookableStudentsController,
    SchoolPickersController,
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
    AgentVoiceController,
    MembershipController,
    CrmLeadMembershipsController,
    MembershipDateRevisionController,
    MembershipPauseController,
    StudentImportController,
    PaperImportController,
    BillingImportController,
    HistoryImportController,
    SchoolWebsiteController,
    SchoolWebsiteAiController,
    MerchAiController,
    CommerceReviewController,
    PublishedSchoolWebsiteController,
    SchoolOnboardingController,
    SchoolSupportController,
    CustomToolController,
    AutomationWorkflowController,
    ContactTagController,
    SchoolSocialController,
    SchoolSocialPostsController,
    SchoolSocialInboxController,
    SchoolSocialAdsController,
    TuitionPaymentController,
    SimpleInvoiceController,
    SchoolPaymentController,
    SchoolPayMethodController,
    SchoolPayAutopayController,
    SchoolPayChargeController,
    SchoolCheckoutController,
    ShopifyController,
    ShopifyWebhookController,
    MayaAtRiskController,
    SchoolBrandingController,
    SchoolLocationController,
    SchoolDemoDataController,
    StaffShiftController,
    StaffTimeController,
    CrmPipelineBoardController,
    SchoolMembershipListController,
    CrmSchoolClockController,
    CrmSessionSchoolClockController,
    MembershipStatusReportController,
    SchoolReportsController,
    SchoolReportsDashboardController,
    AttendanceReportController,
    SchoolContactsController,
    SchoolContactAdminController,
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
    ZernioIntegrationController,
    A2pPreparationController,
    HqEntitlementController,
    ChampionsSchoolController, ChampionsHqController,
    SaasSubscriptionGenerationHqController, HqHonController, SaasSubscriptionGenerationSchoolController, SaasScheduleBindingHqController, SaasScheduleBindingSchoolController, SaasPaidReviewHqController, SaasFounderPoolHqController, SaasFounderAvailabilitySchoolController, SaasPriceScheduleHqController, SaasPriceAcceptanceSchoolController, SaasTrialsHqController, SaasBillingHqController, SaasOffersHqController, SaasOffersSchoolController, SaasCreditsSchoolController, SaasCreativeWalletHqController, SaasCreativeWalletSchoolController, CreativeStudioController, CreativeStudioAvatarsController, CreativeStudioAvatarVideosController, CreativeLimitsHqController, SaasPlanSchoolController, SaasHonOsCheckoutSchoolController, SaasPaymentsHqController, PaymentWebhookController, CommunicationWebhookController, SchoolTextSenderHqController, SchoolNumberController, SchoolNumberOrderHqController, SchoolA2pController, SchoolA2pHqController, SchoolMissedCallHqController, SchoolMissedCallsController, ZernioLeadFormHqController, SaasSchoolBillingController, SaasAccessReadinessHqController, SaasOrganizationAccessHqController, SaasAccessRetryHqController, SaasAccessExceptionsHqController, SaasAccessExceptionCommandsHqController, SaasExceptionPolicyHqController, SaasAccessOverviewHqController, HqSchoolDetailController, HqBusinessNumbersController, HqSupportController, HqMarketingController, HqPlanPromotionsController, SchoolPlanPromotionsController, HqCreativeController, AiSpendPauseHqController, AiSchoolCostLimitHqController, AiExceptionAllowanceHqController, AiUnknownResolutionHqController, AiSchoolUsageHqController, AiTeamReadinessController, HonConversationController, MyLanguagePreferenceController, SchoolLanguageDefaultController, HqCommunicationsController, HqContactController, HqProspectsController,
    ActionReviewController, ActionApprovalWorkbenchController,
  ],
  providers: [BookableStudentsService, SchoolPickersService, HonOsSignupService, HonOsSignupHumanGuard, HonOsTrialService, HonOsTrialHumanGuard, HonOsAdmissionService, HonOsAdmissionHumanGuard, SchoolOwnerInvitationService, SchoolOwnershipService, SchoolAccountHumanGuard, SchoolStaffInvitationService, SchoolStaffAccountHumanGuard, SchoolFamilyAccessInvitationService, SchoolFamilyAccountHumanGuard, SchoolPersonRecordService, SchoolPersonRecordHumanGuard, SchoolPersonPhotoService, SchoolPersonPhotoHumanGuard, SchoolPosService, SchoolPosHumanGuard, AttendanceCardsService, AttendanceCardsHumanGuard, AttendanceScanHumanGuard, FaceCheckInService, FaceCheckInHumanGuard, FaceCheckInScanHumanGuard, FamilyFaceCheckInSignGuard, FamilyFaceCheckInWithdrawGuard, MembershipAgreementService, MembershipAgreementHumanGuard, MembershipAgreementLinkHumanGuard, FamilyMembershipAgreementSignGuard, FamilyPersonPhotoGuard,
    SaasSubscriptionGenerationService, SaasScheduleBillingService, SaasPaidReviewService, SaasFounderService, SaasPriceAcceptanceService, SaasTrialsService, OwnerLaunchService, OwnerLaunchHumanUiGuard, OwnerLaunchGuardianChildHumanUiGuard, OwnerLaunchFirstClassBookingHumanUiGuard, OwnerLaunchMembershipDraftHumanUiGuard,
    CurrentStaffReportingSchoolNoStoreGuard,
    CurriculumLibraryService, CurriculumLibraryHumanUiGuard, ParentCurriculumLibraryReadGuard, ParentAppCurriculumService, ParentAppCurriculumHumanUiGuard,
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
    { provide: HON_REPLY_PROVIDER_RUNTIME, useFactory: () => new OpenRouterHonReplyRuntime() },
    // E-AI1: Eian family AI. The same OpenRouter rules: off until the key and the paid-call approval flag are both set.
    { provide: EIAN_PROVIDER_RUNTIME, useFactory: () => new OpenRouterEianRuntime() }, EianService, EianAskGuard, EianReadGuard,
    ParentInvoicePayService, ParentInvoicePayStartGuard, ParentInvoicePayConfirmGuard, ParentInvoicePayCancelGuard,
    // CS1: no creative provider is connected; the synthetic runtime is test-only and never selected here.
    // C2: real adapters exist, but stay off until results can be copied into HON storage (C3).
    { provide: CREATIVE_PROVIDER_RUNTIME, useFactory: () => createCreativeProviderRuntime({ mediaStorageReady: false }) },
    // C1 (0354): the provider job worker (worker login only; the loop is off unless its interval is set).
    CreativeJobWorkerDatabase,
    { provide: CREATIVE_JOB_WORKER_STORE, useExisting: CreativeJobWorkerDatabase },
    CreativeJobWorker,
    CreativeJobScheduler,
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
    ParentClassBookingService,
    ParentSchoolBookingService,
    ParentClassBookingReadGuard,
    ParentSchoolBookingReadGuard,
    ParentSchoolBookingBookGuard,
    ParentSchoolBookingCancelGuard,
    ParentClassBookingBookGuard,
    ParentClassBookingCancelGuard,
    ParentFamilyPickerService,
    ParentFamilyPickerReadGuard,
    ParentFamilyPickerSelectGuard,
    FamilyMessagesService,
    ParentFamilyMessagesReadGuard,
    ParentFamilyMessagesSendGuard,
    FamilyMessagesInboxReadGuard,
    FamilyMessagesMarkReadGuard,
    FamilyMessagesReplyGuard,
    SchoolAnnouncementsService,
    ParentSchoolAnnouncementsReadGuard,
    SchoolAnnouncementsReadGuard,
    SchoolAnnouncementsPublishGuard,
    SchoolAnnouncementsWithdrawGuard,
    ParentPushService,
    ParentPushRegisterGuard,
    ParentPushUnregisterGuard,
    ParentPushStatusGuard,
    ExpoPushClient,
    { provide: EXPO_PUSH_TRANSPORT, useExisting: ExpoPushClient },
    ParentPushWorkerDatabase,
    { provide: PARENT_PUSH_WORKER_STORE, useExisting: ParentPushWorkerDatabase },
    ParentPushWorker,
    ParentPushScheduler,
    ParentProShopService,
    ParentProShopReadGuard,
    ParentAttendanceStreaksService,
    ParentAttendanceStreaksReadGuard,
    JourneyRecommendationsService,
    ParentJourneyRecommendationsReadGuard,
    ParentJourneyRecommendationsRespondGuard,
    JourneyRecommendationsReadGuard,
    JourneyRecommendationsSaveGuard,
    JourneyRecommendationsStatusGuard,
    ParentReferralsService, ParentReferralsReadGuard, ParentReferralLinkGuard, PublicReferralService,
    SchoolReferralsService, SchoolReferralsReadGuard, SchoolReferralProgramGuard, SchoolReferralRewardGuard,
    ParentCheckoutService, ParentCheckoutOrderGuard, ParentCheckoutStartGuard, ParentCheckoutConfirmGuard, ParentCheckoutCancelGuard,
    SchoolConversationsService,
    ContactMessagesService,
    ContactHistoryReadGuard,
    ContactEmailResendGuard,
    SchoolMessagesService,
    SchoolMessageTemplatesService,
    CreativeDesignsService,
    CreativeDesignsReadGuard,
    CreativeDesignSaveGuard,
    CreativeDesignStatusGuard,
    CreativeDesignPhotoGuard,
    SchoolMessageHistoryReadGuard,
    SchoolTemplatesReadGuard,
    SchoolTemplateSaveGuard,
    SchoolTemplateStatusGuard,
    SchoolOptedOutReadGuard,
    ConversationAiService,
    ConversationAiProgramService,
    ConversationAiReadGuard, ConversationAiKnowledgeGuard, ConversationAiFileGuard, ConversationAiSettingsGuard, ConversationAiUploadGuard, ConversationAiItemSaveGuard, ConversationAiItemStatusGuard,
    ConversationReadGuard,
    ConversationReplyGuard,
    ConversationUpdateGuard,
    ConversationMarkReadGuard,
    ConversationLinkGuard,
    ConversationCreateLeadGuard,
    ParentPlannedAbsenceRequestGuard,
    ParentMessageHistoryService,
    ParentMessageHistoryReadGuard,
    LeadService,
    LeadCreateHumanUiGuard,
    StarterPipelineHumanUiGuard,
    TemplatePipelineHumanUiGuard,
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
    ClassSessionPagesService,
    ClassSessionPagesHumanUiGuard,
    AttendanceService,
    ClassSessionRosterService,
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
    CommunicationWorkerDatabase,
    { provide: COMMUNICATION_WORKER_STORE, useExisting: CommunicationWorkerDatabase },
    // Real adapters (SendGrid, Twilio) are listed before the fakes; each is READY only behind its own approval flag.
    // T1 (0351): school subaccounts are looked up through the communication worker login only.
    { provide: TWILIO_SUBACCOUNT_DIRECTORY, useFactory: (worker: CommunicationWorkerDatabase) => new WorkerTwilioSubaccountDirectory(worker), inject: [CommunicationWorkerDatabase] },
    { provide: COMMUNICATION_PROVIDER_ADAPTERS, useFactory: (subaccounts: TwilioSubaccountDirectory) => [new SendGridEmailProvider(),
      new TwilioTextProvider(undefined, undefined, subaccounts), new FakeCommunicationProvider('EMAIL'), new FakeCommunicationProvider('SMS')], inject: [TWILIO_SUBACCOUNT_DIRECTORY] },
    { provide: TWILIO_WEBHOOK_VERIFIER, useFactory: () => new TwilioWebhookVerifier() },
    { provide: ZERNIO_LEAD_VERIFIER, useFactory: () => new ZernioLeadWebhookVerifier() },
    { provide: SENDGRID_EVENT_VERIFIER, useFactory: () => new SendGridEventWebhookVerifier() },
    // T2 (0352): school number search/orders and the HQ-approved purchase worker; every Twilio call is behind
    // HON_TWILIO_PROVISIONING_APPROVED, and the worker loop also needs HON_SCHOOL_NUMBER_PURCHASE_INTERVAL_SECONDS.
    { provide: TWILIO_NUMBER_CLIENT, useFactory: () => new TwilioRestNumberClient() },
    { provide: SCHOOL_NUMBER_PURCHASE_STORE, useExisting: CommunicationWorkerDatabase },
    { provide: SCHOOL_NUMBER_PURCHASE_SETUP, useFactory: () => ({ provisioning: new TwilioRestProvisioningClient(), vault: () => twilioSubaccountVaultFromEnvironment() }) },
    SchoolNumberService,
    SchoolNumberReadHumanUiGuard,
    SchoolNumberOrderHumanUiGuard,
    SchoolNumberCancelHumanUiGuard,
    SchoolNumberPurchaseWorker,
    SchoolNumberPurchaseScheduler,
    // T3a (0553): school A2P registrations. Nothing is submitted without HON_TWILIO_A2P_SUBMIT_APPROVED and a READY A2P
    // client; this piece wires only the never-ready client, so production cannot submit (the REST client is T3c).
    { provide: TWILIO_A2P_CLIENT, useFactory: () => new UnavailableTwilioA2pClient() },
    { provide: SCHOOL_A2P_STORE, useExisting: CommunicationWorkerDatabase },
    { provide: SCHOOL_A2P_SETUP, useFactory: () => ({ vault: () => twilioSubaccountVaultFromEnvironment() }) },
    SchoolA2pService,
    SchoolA2pReadHumanUiGuard,
    SchoolA2pRequestHumanUiGuard,
    SchoolA2pCancelHumanUiGuard,
    SchoolA2pWorker,
    SchoolA2pScheduler,
    CommunicationDispatcher,
    MissedCallTextBackDispatcher,
    CommunicationDispatchScheduler,
    HqMessageWorkerDatabase,
    { provide: HQ_MESSAGE_WORKER_STORE, useExisting: HqMessageWorkerDatabase },
    HqMessageDispatcher,
    HqMessageDispatchScheduler,
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
    AgentVoiceService,
    MembershipService,
    CrmLeadMembershipsService,
    MembershipDateRevisionService,
    MembershipPauseService,
    StudentImportService,
    PaperImportService,
    // 0388: the stand-in reads only the built-in sample pages. 0594: HON reads real photos on the AI team's route; no call is
    // made until HQ keeps a DOCUMENT_READING profile on an image model and the existing OpenRouter key and approval are set.
    { provide: PAPER_READER_RUNTIME, useFactory: () => new SyntheticPaperReader() },
    { provide: PAPER_VISION_RUNTIME, useFactory: () => new OpenRouterPaperVisionRuntime() },
    BillingImportService,
    HistoryImportService,
    SchoolWebsiteService,
    WebsiteAiService,
    { provide: WEBSITE_PROVIDER_RUNTIME, useFactory: () => new OpenRouterWebsiteRuntime() },
    MerchAiService,
    { provide: MERCH_PROVIDER_RUNTIME, useFactory: () => new OpenRouterMerchRuntime() },
    CommerceReviewService,
    { provide: COMMERCE_REVIEW_PROVIDER_RUNTIME, useFactory: () => new OpenRouterMerchRuntime(undefined, undefined, COMMERCE_REVIEW_TEXT_PROFILE) },
    SchoolOnboardingService,
    SchoolSupportService,
    CustomToolService,
    AutomationService, AutomationWorkerDatabase, AutomationEngineScheduler, AutomationActivateHumanUiGuard, AutomationPauseHumanUiGuard,
    AutomationReadHumanUiGuard, AutomationCreateHumanUiGuard, AutomationSaveHumanUiGuard, AutomationRestoreHumanUiGuard, AutomationArchiveHumanUiGuard,
    ContactTagAddHumanUiGuard, ContactTagRemoveHumanUiGuard, ContactTagLookupHumanUiGuard,
    SchoolSocialService,
    SchoolSocialPostsService,
    SchoolSocialInboxService,
    SchoolSocialAdsService,
    SocialPostDispatcher,
    ClassSeriesService,
    CalendarCardsService,
    CalendarSettingsService,
    SchoolReportsService,
    SchoolContactsService,
    SchoolContactAdminService,
    SchoolEventService,
    SchoolEventReadHumanUiGuard,
    SchoolEventSaveHumanUiGuard,
    SchoolEventStatusHumanUiGuard,
    SchoolEventBookingStatusHumanUiGuard,
    BookingTypeService,
    WalkInKioskService,
    WalkInKioskReadHumanUiGuard,
    WalkInKioskSettingsHumanUiGuard,
    WalkInKioskDeviceStartHumanUiGuard,
    WalkInKioskDeviceEndHumanUiGuard,
    WalkInKioskDeskPaidHumanUiGuard,
    BookingTypeReadHumanUiGuard,
    BookingTypeSaveHumanUiGuard,
    BookingTypeStatusHumanUiGuard,
    BookingTypeBookingStatusHumanUiGuard,
    ClassSeriesCreateHumanUiGuard,
    CalendarCardsReadHumanUiGuard,
    CalendarCardCreateHumanUiGuard,
    CalendarCardMoveHumanUiGuard,
    CalendarSettingsReadHumanUiGuard,
    CalendarBlockOutsReadHumanUiGuard,
    CalendarShareSettingsSaveHumanUiGuard,
    CalendarBlockOutAddHumanUiGuard,
    CalendarBlockOutRemoveHumanUiGuard,
    ShareCalendarSaveHumanUiGuard,
    ShareCalendarDeleteHumanUiGuard,
    ClassSeriesReviseHumanUiGuard,
    ClassSeriesOngoingHumanUiGuard,
    ClassSeriesTopUpHumanUiGuard,
    ClassSeriesEndHumanUiGuard,
    ClassSeriesFillHumanUiGuard,
    ClassSeriesReadHumanUiGuard,
    TuitionPaymentService,
    SimpleInvoiceService,
    SchoolPaymentService,
    SchoolPayMethodService,
    SchoolPayAutopayService,
    SchoolPayChargeService,
    SchoolPayOnceService,
    { provide: SCHOOL_PAYMENT_ADAPTERS, useFactory: () => schoolPaymentAdaptersFromEnvironment() },
    { provide: SCHOOL_PAYMENT_VAULT, useFactory: () => schoolPaymentVaultForProcess() },
    SchoolPayReadHumanUiGuard, SchoolPayStartHumanUiGuard, SchoolPayOnboardingLinkHumanUiGuard, SchoolPayFinishHumanUiGuard,
    SchoolPayRefreshHumanUiGuard, SchoolPayDefaultHumanUiGuard, SchoolPayDisconnectHumanUiGuard,
    SchoolPayMethodsReadHumanUiGuard, SchoolPayExpiringReadHumanUiGuard, SchoolPayMethodSetupHumanUiGuard, SchoolPayMethodFinishHumanUiGuard,
    SchoolPayMethodDefaultHumanUiGuard, SchoolPayMethodRemoveHumanUiGuard,
    SchoolPayAutopayReadHumanUiGuard, SchoolPayDiscountReadHumanUiGuard, SchoolPayDiscountSetHumanUiGuard, SchoolPayAutopayEnrollHumanUiGuard,
    SchoolPayAutopayMethodHumanUiGuard, SchoolPayAutopayStateHumanUiGuard, SchoolPayAutopayCancelHumanUiGuard, SchoolPayAutopayCycleHumanUiGuard,
    SchoolCheckoutService, SchoolCheckoutOrdersReadHumanUiGuard, SchoolCheckoutReadHumanUiGuard, SchoolCheckoutSaveHumanUiGuard, SchoolCheckoutSettingsSaveHumanUiGuard,
    ShopifyService, ShopifyHumanGuard, { provide: SHOPIFY_APP, useFactory: () => shopifyAppFromEnvironment(process.env) },
    ShopifyWorkerDatabase, { provide: SHOPIFY_WORKER_STORE, useExisting: ShopifyWorkerDatabase }, ShopifyBackgroundSync, ShopifyBackgroundScheduler,
    MayaAtRiskService,
    MayaAtRiskReadHumanUiGuard,
    SchoolBrandingService, SchoolBrandingReadHumanUiGuard, SchoolBrandingSaveHumanUiGuard,
    SchoolLocationService, SchoolLocationReadHumanUiGuard, SchoolLocationSaveHumanUiGuard,
    SchoolDemoDataService, SchoolDemoDataReadHumanUiGuard, SchoolDemoDataLoadHumanUiGuard, SchoolDemoDataRemoveHumanUiGuard,
    StaffShiftService, StaffShiftReadHumanUiGuard, StaffShiftSaveHumanUiGuard,
    StaffTimeService, StaffTimeReadHumanUiGuard, StaffTimePunchHumanUiGuard, StaffTimeEntrySaveHumanUiGuard, StaffTimesheetDecideHumanUiGuard,
    CrmPipelineBoardService, CrmPipelineBoardReadHumanUiGuard, CrmLeadStageMoveHumanUiGuard, CrmPipelineStagesSaveHumanUiGuard,
    SchoolMembershipListService,
    SchoolMembershipListHumanUiGuard,
    CrmSchoolClockService,
    CrmSchoolClockHumanUiGuard,
    CrmAdultMembershipDraftService, CrmAdultMembershipDraftHumanUiGuard, CrmAdultMembershipPreparationHumanUiGuard, CrmAdultMembershipConfirmationHumanUiGuard, CrmAdultMembershipNoStoreGuard,
    MembershipPlanService, MembershipPlanCatalogHumanUiGuard, MembershipPlanCreateHumanUiGuard, MembershipPlanReviseHumanUiGuard, CrmAdultMembershipPlanOptionsHumanUiGuard, CrmAdultMembershipDraftFromPlanHumanUiGuard,
    GuardianChildEnrollmentService, CrmGuardianChildEnrollmentReadHumanUiGuard, CrmGuardianChildPayerDesignationHumanUiGuard, CrmGuardianChildAdditionHumanUiGuard, CrmGuardianChildMembershipDraftFromPlanHumanUiGuard,
    MembershipActivationHumanUiGuard,
    TuitionPaymentRecordHumanUiGuard,
    SimpleInvoiceCreateHumanUiGuard,
    TuitionPaymentVoidHumanUiGuard,
    TuitionReadHumanUiGuard,
    BillingAccountService,
    BillingAccountHumanUiGuard,
    InvoiceService,
    InvoiceHumanUiGuard,
    HqOnboardingService,
    HqAiProviderService,
    ZernioIntegrationService, ZernioHumanUiGuard,
    { provide: ZERNIO_RUNTIME, useFactory: () => new ZernioCredentialRuntime() },
    { provide: ZERNIO_SOCIAL_ADAPTER, useFactory: () => zernioSocialAdapterFactory() },
    A2pPreparationService, A2pPreparationHumanGuard,
    {provide:A2P_WEBSITE_INSPECTOR,useFactory:()=>new UnavailableA2pWebsiteInspector()},
    HqEntitlementService,
    HqEntitlementHumanUiGuard,
    ChampionsClubService, ChampionsCommandGuard, ChampionsReadGuard,
    SaasBillingService, SaasCreativeWalletService, CreativeStudioService, CreativeLimitsService, SaasCommandGuard, SaasReadGuard, SaasPaymentsService, SaasSchoolBillingService, HqSupportService, HqMarketingService, HqPlanPromotionsService, HqCreativeService, HqHonService, AiSpendPauseService, AiSchoolCostLimitService, AiExceptionAllowanceService, AiUnknownResolutionService, AiSchoolUsageService, AiTeamReadinessService, HonConversationService, HonReplyService, HonConversationHumanUiGuard, LanguagePreferencesService, LanguageReadGuard, LanguageCommandGuard, HqCommunicationsService, HqContactService, HqProspectsService,
    // Real Stripe test mode only when both test credentials are configured; otherwise every call is refused.
    { provide: PAYMENT_PROVIDER_ADAPTER, useFactory: () => paymentProviderFromEnvironment() ?? new UnconfiguredPaymentProvider() },
    // 0230 schedule billing never selects a provider from environment. Only tests may override this deterministic boundary.
    { provide: SUBSCRIPTION_SCHEDULE_PROVIDER, useFactory: () => new UnconfiguredSubscriptionScheduleProvider() },
    HqOverviewService,
    HqSchoolDirectoryService,
  ],
})
export class AppModule {}
