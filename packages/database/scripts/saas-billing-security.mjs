// HON subscription catalog (0154), invoices/payment evidence (0155), premium credits (0156) and
// refunds/Champions reward application (0157) and test-mode payment provider integration (0158):
// HON-bills-schools records,
// separate from school-to-family billing.
// Private deny-all tables reachable only through fixed functions.
export const saasBillingTables = ['saas_subscription_generations','saas_price_schedules','saas_price_acceptances','saas_policy_decisions','saas_catalog_versions','saas_catalog_plans','saas_catalog_offers','saas_founder_reservations',
 'saas_subscriptions','saas_subscription_history','saas_requests','saas_audit','saas_outbox',
 'saas_policy_records','saas_invoice_sequences','saas_invoices','saas_invoice_lines','saas_payment_evidence',
 'saas_credit_program','saas_provider_cost_evidence','saas_pricing_versions','saas_operation_prices','saas_credit_allowances',
 'saas_credit_reservations','saas_credit_ledger','saas_credit_threshold_events',
 'saas_refund_requests','saas_refund_history','saas_reward_fulfillment','saas_reward_applications','saas_account_credit_ledger',
 'saas_free_periods','saas_referral_payment_alerts',
 'saas_payment_program','saas_checkout_sessions','saas_provider_events','saas_provider_payment_refs',
 'saas_access_program','saas_access_policy_terms','saas_access_states','saas_access_transitions',
 'saas_offer_sets','saas_offer_set_offers','saas_offer_sales_stops','saas_new_sales_policy','saas_access_exceptions','saas_exception_policy_decisions','saas_trial_program','saas_trial_policy_versions','saas_trial_policy_decisions','saas_trial_campaign_versions','saas_trial_publications',
 'saas_creative_program','saas_creative_rate_versions','saas_creative_rates','saas_creative_topup_packages','saas_creative_wallets',
 'saas_creative_topup_purchases','saas_creative_adjustments','saas_creative_lots','saas_creative_reservations','saas_creative_ledger','saas_creative_cost_events'];
const evidenceTables = ['saas_subscription_generations','saas_price_schedules','saas_price_acceptances','saas_trial_program','saas_trial_policy_versions','saas_trial_policy_decisions','saas_trial_campaign_versions','saas_trial_publications','saas_policy_decisions','saas_subscription_history','saas_requests','saas_audit','saas_outbox','saas_policy_records','saas_payment_evidence',
 'saas_provider_cost_evidence','saas_credit_ledger','saas_credit_threshold_events',
 'saas_refund_history','saas_reward_applications','saas_account_credit_ledger','saas_free_periods','saas_provider_events','saas_provider_payment_refs',
 'saas_exception_policy_decisions','saas_access_program','saas_access_policy_terms','saas_access_transitions','saas_offer_sales_stops','saas_new_sales_policy',
 'saas_creative_rates','saas_creative_topup_packages','saas_creative_adjustments','saas_creative_lots','saas_creative_ledger','saas_creative_cost_events'];
const paymentTables = ['saas_payment_program','saas_checkout_sessions'];
const refundRewardTables = ['saas_refund_requests','saas_reward_fulfillment','saas_referral_payment_alerts'];
const creditTables = ['saas_credit_program','saas_pricing_versions','saas_credit_allowances','saas_credit_reservations'];
const catalogRowTables = ['saas_catalog_plans','saas_catalog_offers'];
const invoicingTables = ['saas_invoice_sequences','saas_invoices'];
const creativeTables = ['saas_creative_program','saas_creative_rate_versions','saas_creative_wallets','saas_creative_reservations','saas_creative_topup_purchases'];
// [signature, runtime may execute, SECURITY DEFINER]
export const saasBillingFunctions = [
 ['hon.saas_generation_lock_authority()',false,false],
 ['hon.saas_generation_content(uuid,uuid)',false,false],
 ['hon.saas_generation_json(hon.saas_subscription_generations)',false,false],
 ['hon.saas_generation_available(uuid)',false,false],
 ['hon.record_saas_subscription_generation(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_subscription_generation(text,uuid,uuid)',true,true],
 ['hon.read_saas_subscription_generation_from_hq(text,uuid)',true,true],
 ['hon.guard_saas_generation_insert()',false,true],
 ['hon.verify_saas_generation_evidence()',false,true],
 ['hon.saas_price_usd(integer)',false,false],
 ['hon.saas_price_content(uuid,uuid)',false,false],
 ['hon.saas_price_schedule_json(hon.saas_price_schedules)',false,false],
 ['hon.saas_price_acceptance_json(hon.saas_price_acceptances)',false,false],
 ['hon.saas_price_lock_authority()',false,false],
 ['hon.record_saas_price_schedule(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.saas_price_acceptance_preview(uuid,uuid,uuid)',false,false],
 ['hon.preview_saas_price_acceptance(text,uuid,uuid)',true,true],
 ['hon.accept_saas_price_schedule(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_price_schedule(text,uuid)',true,true],
 ['hon.read_saas_price_acceptance(text,uuid,uuid)',true,true],
 ['hon.guard_saas_price_insert()',false,true],
 ['hon.verify_saas_price_evidence()',false,true],
 ['hon.guard_saas_price_provider_boundary()',false,false],
 ['hon.saas_plan_capabilities(text)',false,false],
 ['hon.guard_saas_evidence()',false,false],
 ['hon.guard_saas_records()',false,false],
 ['hon.guard_saas_catalog_rows()',false,false],
 ['hon.saas_refuse_context()',false,false],
 ['hon.require_saas_hq_actor(text,boolean)',false,true],
 ['hon.saas_claim_request(uuid,uuid,text,text,uuid,uuid)',false,true],
 ['hon.saas_record(uuid,uuid,text,text,text,uuid,uuid,jsonb,jsonb,jsonb,timestamptz)',false,true],
 ['hon.saas_fingerprint(text[])',false,false],
 ['hon.saas_ts(timestamptz)',false,false],
 ['hon.saas_require_policy(text)',false,false],
 ['hon.saas_catalog_json(uuid)',false,false],
 ['hon.saas_founder_inventory(timestamptz)',false,false],
 ['hon.saas_reservation_json(hon.saas_founder_reservations,timestamptz)',false,false],
 ['hon.saas_subscription_json(hon.saas_subscriptions)',false,false],
 ['hon.saas_policies_json()',false,false],
 ['hon.read_saas_catalog_from_hq(text)',true,true],
 ['hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_founder_reservations_from_hq(text,text)',true,true],
 ['hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_subscriptions_from_hq(text,text)',true,true],
 ['hon.read_saas_organization_subscription_from_hq(text,uuid)',true,true],
 ['hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 // 0155 invoices and payment evidence
 ['hon.guard_saas_invoicing()',false,false],
 ['hon.guard_saas_invoice_lines()',false,false],
 ['hon.saas_invoice_facts(uuid,uuid)',false,false],
 ['hon.saas_evidence_json(hon.saas_payment_evidence)',false,false],
 ['hon.saas_invoice_json(uuid,boolean)',false,false],
 ['hon.saas_payment_standing_strength(uuid,boolean)',false,false],
 ['hon.saas_payment_standing(uuid)',false,false],
 ['hon.read_saas_invoices_from_hq(text,text)',true,true],
 ['hon.read_saas_invoice_from_hq(text,uuid)',true,true],
 ['hon.read_saas_payment_standing_from_hq(text,uuid)',true,true],
 ['hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 // 0156 premium credit accounting
 ['hon.guard_saas_credits()',false,false],
 ['hon.guard_saas_operation_prices()',false,false],
 ['hon.require_saas_school_actor(text,uuid)',false,true],
 ['hon.saas_credit_program_active()',false,false],
 ['hon.saas_allowance_period(hon.saas_subscriptions,timestamptz)',false,false],
 ['hon.saas_allowance_balance(uuid)',false,false],
 ['hon.saas_allowance_json(uuid)',false,false],
 ['hon.saas_credit_reservation_json(hon.saas_credit_reservations,boolean)',false,false],
 ['hon.saas_pricing_json(uuid,boolean)',false,false],
 ['hon.saas_cost_evidence_json(hon.saas_provider_cost_evidence)',false,false],
 ['hon.saas_credit_program_json()',false,false],
 ['hon.saas_record_thresholds(uuid,timestamptz)',false,true],
 ['hon.saas_current_allowance(uuid,uuid,timestamptz)',false,true],
 ['hon.saas_published_operation(text)',false,false],
 ['hon.saas_record_provider_usage(hon.saas_credit_reservations,uuid,bigint,bigint,bigint)',false,true],
 ['hon.read_saas_credit_program_from_hq(text)',true,true],
 ['hon.read_saas_organization_credits_from_hq(text,uuid)',true,true],
 ['hon.set_saas_credit_program(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.record_saas_provider_cost_evidence(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.create_saas_pricing_draft(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.publish_saas_pricing(text,uuid,uuid,uuid,uuid)',true,true],
 ['hon.command_saas_credit_allowance(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_school_credits(text,uuid)',true,true],
 ['hon.estimate_saas_premium_operation(text,uuid,text,integer)',true,true],
 ['hon.reserve_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 // 0157 refund guarantee records and Champions reward application
 ['hon.guard_saas_refunds_rewards()',false,false],
 ['hon.saas_evidence_referral_alert()',false,false],
 ['hon.saas_invoice_free_period_check()',false,false],
 ['hon.saas_allowance_free_month_basis()',false,false],
 ['hon.saas_refund_eligibility(uuid,timestamptz)',false,false],
 ['hon.saas_refund_json(hon.saas_refund_requests)',false,false],
 ['hon.saas_reward_fulfillment_json()',false,false],
 ['hon.saas_reward_entry_blocked(uuid)',false,false],
 ['hon.saas_account_credit_grants(uuid)',false,false],
 ['hon.saas_reward_application_json(hon.saas_reward_applications)',false,false],
 ['hon.saas_alert_json(hon.saas_referral_payment_alerts)',false,false],
 ['hon.saas_reward_entry_state(hon.champions_reward_entries)',false,false],
 ['hon.read_saas_refund_eligibility_from_hq(text,uuid,timestamp with time zone)',true,true],
 ['hon.read_saas_refund_requests_from_hq(text,text)',true,true],
 ['hon.read_saas_refund_reserve_from_hq(text)',true,true],
 ['hon.create_saas_refund_request(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.decide_saas_refund_request(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_reward_preview_from_hq(text,uuid)',true,true],
 ['hon.read_saas_referral_alerts_from_hq(text,text)',true,true],
 ['hon.set_saas_reward_fulfillment(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.apply_saas_referral_reward(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_credit_application_preview(text,uuid)',true,true],
 ['hon.apply_saas_account_credit(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.resolve_saas_referral_alert(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 // 0158 payment provider integration (test mode only)
 ['hon.guard_saas_payments()',false,false],
 ['hon.saas_payment_actor()',false,false],
 ['hon.saas_payment_program_json()',false,false],
 ['hon.saas_checkout_json(hon.saas_checkout_sessions)',false,false],
 ['hon.saas_subscription_payment(hon.saas_subscriptions)',false,false],
 ['hon.require_saas_school_purchaser(text,uuid)',false,true],
 ['hon.saas_close_checkout(uuid,text,text,uuid,timestamp with time zone)',false,false],
 ['hon.saas_open_checkout(uuid,uuid,uuid,uuid,text,timestamp with time zone)',false,false],
 ['hon.saas_provider_invoice(hon.saas_subscriptions,integer,integer,timestamp with time zone,text,jsonb,timestamp with time zone)',false,false],
 ['hon.saas_link_payment_refs(text,text[],uuid,timestamp with time zone)',false,false],
 ['hon.saas_activate_checkout(uuid,jsonb,timestamp with time zone)',false,false],
 ['hon.saas_apply_renewal(jsonb,timestamp with time zone)',false,false],
 ['hon.saas_apply_reversal(jsonb,timestamp with time zone)',false,false],
 ['hon.read_saas_payments_from_hq(text)',true,true],
 ['hon.read_saas_school_plan_options(text,uuid)',true,true],
 ['hon.set_saas_payment_program(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.create_saas_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.create_saas_checkout_from_hq(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.attach_saas_checkout_session(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.cancel_saas_checkout(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.sweep_saas_checkouts(text,uuid,uuid,uuid)',true,true],
 ['hon.ingest_saas_provider_event(jsonb,text)',true,true],
 // 0170 school billing reads and the inactive paid-access foundation
 ['hon.require_saas_school_billing_viewer(text,uuid)',false,true],
 ['hon.saas_school_evidence_json(hon.saas_payment_evidence)',false,false],
 ['hon.saas_school_refund_json(hon.saas_refund_requests)',false,false],
 ['hon.saas_school_invoice_json(uuid,boolean)',false,false],
 ['hon.saas_entitlement_json(uuid)',false,false],
 ['hon.saas_access_condition(uuid)',false,false],
 ['hon.saas_access_shadow(uuid)',false,false],
 ['hon.read_saas_school_invoices(text,uuid,text,text,timestamp with time zone,uuid,integer)',true,true],
 ['hon.read_saas_school_invoice(text,uuid,uuid)',true,true],
 ['hon.read_saas_school_billing_account(text,uuid)',true,true],
 ['hon.read_saas_access_readiness_from_hq(text,uuid)',true,true],
 // 0192 owner suspension policy: in-app access standing (billing.hon.view; open to a lapsed school)
 ['hon.read_saas_school_access_standing(text,uuid)',true,true],
 // 0172 B6A first-payment activation (inactive program)
 ['hon.guard_saas_access()',false,false],
 ['hon.saas_access_program_active()',false,false],
 ['hon.saas_organization_access(uuid)',false,false],
 ['hon.saas_capability_allowed(uuid,text)',false,false],
 ['hon.saas_awaiting_first_payment(uuid)',false,false],
 ['hon.saas_apply_first_payment_access(uuid,uuid,uuid,jsonb,timestamp with time zone)',false,false],
 ['hon.saas_try_first_payment_access(uuid,uuid,uuid,jsonb,timestamp with time zone)',false,false],
 ['hon.saas_activate_checkout_core(uuid,jsonb,timestamp with time zone,boolean)',false,false],
 ['hon.read_saas_organization_access_from_hq(text,uuid)',true,true],
 ['hon.place_saas_organization_awaiting_payment(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.retry_saas_first_payment_activation(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 // 0181 HON OS commercial offers (HQ Pricing & Offers; no checkout connection)
 ['hon.guard_saas_offer_sets()',false,false],
 ['hon.guard_saas_offer_set_offers()',false,false],
 ['hon.saas_hon_os_product_json()',false,false],
 ['hon.saas_offer_json(hon.saas_offer_set_offers)',false,false],
 ['hon.saas_offer_set_json(uuid)',false,false],
 ['hon.saas_offer_set_preview(uuid)',false,false],
 ['hon.saas_offer_set_content_valid(jsonb)',false,false],
 ['hon.saas_offer_set_write_content(uuid,jsonb)',false,false],
 ['hon.saas_offer_owner(text)',false,false],
 ['hon.read_saas_offer_management_from_hq(text)',true,true],
 ['hon.read_saas_offer_set_from_hq(text,uuid)',true,true],
 ['hon.create_saas_offer_set_draft(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.revise_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.discard_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.publish_saas_offer_set(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.stop_saas_offer_sales(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_hon_os_offers_for_school(text,uuid)',true,true],
 // 0182 HON OS purchase binding (test-mode checkout of published HON OS offers)
 ['hon.saas_hon_os_billing_interval(text)',false,false],
 ['hon.saas_hon_os_recurring(hon.saas_offer_set_offers)',false,false],
 ['hon.saas_hon_os_offer_on_sale(hon.saas_offer_set_offers,timestamp with time zone)',false,false],
 ['hon.saas_hon_os_accepted_offer(hon.saas_offer_set_offers)',false,false],
 ['hon.saas_hon_os_digest(jsonb)',false,false],
 ['hon.saas_hon_os_offer_usage(uuid,timestamp with time zone,uuid)',false,false],
 ['hon.saas_hon_os_founder_usage(timestamp with time zone,uuid)',false,false],
 ['hon.saas_hon_os_refusal(uuid,hon.saas_offer_set_offers,timestamp with time zone)',false,false],
 ['hon.saas_open_hon_os_checkout(uuid,uuid,uuid,uuid,timestamp with time zone)',false,false],
 ['hon.saas_hon_os_purchase_json(hon.saas_checkout_sessions)',false,false],
 ['hon.saas_activate_hon_os_checkout(uuid,jsonb,timestamp with time zone)',false,false],
 ['hon.saas_planned_monthly_credits(hon.saas_subscriptions)',false,false],
 ['hon.saas_refund_window_hours(uuid)',false,false],
 ['hon.create_saas_hon_os_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 // 0183 HON OS new-school onboarding (D7): private registration and the HON OS activation core
 ['hon.initialize_saas_hon_os_school_account(text,jsonb,uuid,uuid,uuid)',false,true],
 ['hon.saas_activate_hon_os_checkout_core(uuid,jsonb,timestamp with time zone,boolean)',false,false],
 // 0184 HON OS-only new sales (D8): the pinned policy read and the legacy new-sale guard
 ['hon.saas_legacy_new_sales_open()',false,false],
 ['hon.guard_saas_legacy_new_sale()',false,false],
 // 0185 secure HQ provisioning (D9): HQ-owner access exceptions
 ['hon.guard_saas_access_exceptions()',false,false],
 ['hon.guard_saas_access_exception_grant()',false,false],
 ['hon.guard_saas_access_state_exception()',false,false],
 ['hon.saas_access_exception_live(uuid)',false,false],
 ['hon.saas_access_exception_json(hon.saas_access_exceptions)',false,false],
 ['hon.saas_end_access_exception(uuid,text,text,uuid,timestamp with time zone)',false,false],
 ['hon.grant_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.revoke_saas_access_exception(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.close_expired_saas_access_exceptions(text,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_access_exceptions_from_hq(text,uuid)',true,true],
 // 0186 D10: immutable policy ledger, command/read and private enforcement.
 ['hon.saas_exception_policy_json(hon.saas_exception_policy_decisions)',false,false],
 ['hon.saas_require_exception_policy()',false,false],
 ['hon.guard_saas_exception_policy_decision()',false,false],
 ['hon.verify_saas_exception_policy_evidence()',false,true],
 ['hon.verify_saas_exception_policy_binding()',false,true],
 ['hon.decide_saas_exception_policy(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_saas_exception_policy(text)',true,true],

 // D11-A governance only.
 ['hon.saas_trial_keys(jsonb,text[])',false,false],
 ['hon.saas_trial_uint(jsonb,bigint,bigint)',false,false],
 ['hon.saas_trial_choices(jsonb,jsonb)',false,false],
 ['hon.saas_trial_timestamp(jsonb)',false,false],
 ['hon.saas_trial_policy_valid(jsonb)',false,false],
 ['hon.saas_trial_campaign_valid(jsonb)',false,false],
 ['hon.saas_trial_policy_json(hon.saas_trial_policy_versions)',false,false],
 ['hon.saas_trial_decision_json(hon.saas_trial_policy_decisions)',false,false],
 ['hon.saas_trial_campaign_json(hon.saas_trial_campaign_versions)',false,false],
 ['hon.saas_trial_publication_json(hon.saas_trial_publications)',false,false],
 ['hon.saas_trial_begin(text,uuid,text,jsonb,uuid,uuid)',false,false],
 ['hon.saas_trial_preview(uuid)',false,false],
 ['hon.propose_saas_trial_policy(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.decide_saas_trial_policy(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.draft_saas_trial_campaign(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.publish_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.withdraw_saas_trial_campaign(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.guard_saas_trial_insert()',false,true],
 ['hon.verify_saas_trial_evidence()',false,true],
 ['hon.read_saas_trial_governance(text)',true,true],
 ['hon.read_saas_trial_campaign(text,uuid)',true,true],
 ['hon.preview_saas_trial_publication(text,uuid)',true,true],
 // CW1 (0202) HON OS creative credit wallet.
 ['hon.guard_saas_creative()',false,false],
 ['hon.saas_creative_program_active()',false,false],
 ['hon.saas_creative_lock_wallet(uuid,timestamp with time zone)',false,true],
 ['hon.saas_creative_touch_wallet(uuid,timestamp with time zone)',false,true],
 ['hon.saas_creative_pause_gate(uuid)',false,false],
 ['hon.saas_creative_evidence_actor(text,uuid)',false,true],
 ['hon.saas_creative_lot_totals(uuid)',false,false],
 ['hon.saas_creative_lot_remaining(uuid)',false,false],
 ['hon.saas_creative_lot_available(hon.saas_creative_lots,timestamp with time zone)',false,false],
 ['hon.saas_creative_lot_rank(text)',false,false],
 ['hon.saas_creative_expire_lots(uuid,uuid,timestamp with time zone)',false,true],
 ['hon.saas_creative_eligibility(uuid,timestamp with time zone)',false,false],
 ['hon.saas_creative_open_window(uuid,uuid,timestamp with time zone)',false,true],
 ['hon.saas_creative_lot_json(hon.saas_creative_lots,timestamp with time zone)',false,false],
 ['hon.saas_creative_balance_json(uuid,timestamp with time zone)',false,false],
 ['hon.saas_creative_reservation_json(hon.saas_creative_reservations,boolean)',false,false],
 ['hon.saas_creative_rates_json(boolean)',false,false],
 ['hon.saas_creative_packages_json()',false,false],
 ['hon.saas_creative_purchase_json(hon.saas_creative_topup_purchases,boolean)',false,false],
 ['hon.saas_creative_record_usage(hon.saas_creative_reservations,uuid,bigint,integer)',false,true],
 ['hon.saas_creative_settle_lots(hon.saas_creative_reservations,integer,uuid,timestamp with time zone)',false,true],
 ['hon.saas_creative_apply_cost(hon.saas_creative_reservations,uuid,bigint,text,timestamp with time zone)',false,true],
 ['hon.saas_creative_expense_json(uuid)',false,false],
 ['hon.saas_creative_wallet_json(uuid,boolean)',false,false],
 ['hon.set_saas_creative_program(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.publish_saas_creative_rates(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.grant_saas_creative_credits_from_hq(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.debit_saas_creative_lot_from_hq(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.resolve_saas_creative_reservation_from_hq(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.record_saas_creative_cost_from_hq(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.saas_record_creative_provider_cost(uuid,jsonb,timestamp with time zone)',false,true],
 ['hon.read_saas_creative_wallet_from_hq(text,uuid)',true,true],
 ['hon.read_saas_creative_wallets_from_hq(text)',true,true],
 ['hon.read_saas_creative_wallet(text,uuid)',true,true],
 ['hon.open_saas_creative_window(text,uuid,uuid,uuid,uuid)',true,true],
 ['hon.reserve_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.settle_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.create_saas_creative_topup_purchase(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.saas_fulfill_creative_topup(uuid,jsonb,timestamp with time zone)',false,true],
 // 0219 B-HQ-1 HQ access overview: read-only HQ list; the helpers stay internal.
 ['hon.saas_exception_policy_ready()',false,false],
 ['hon.saas_access_overview_row(uuid,boolean)',false,false],
 ['hon.read_saas_access_overview_from_hq(text,text,timestamp with time zone,uuid,integer)',true,true],
];
// Cross-milestone triggers 0157 adds to earlier tables: [table, trigger, tgtype, function].
// Issue #100 (0201): functions that add calendar months to timestamptz run with TimeZone=UTC so billing
// periods never depend on the caller's session, role, database or pooler TimeZone.
export const saasUtcCalendarFunctions = Object.freeze([
  'command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid)',
  'create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid)',
  'saas_provider_invoice(hon.saas_subscriptions,integer,integer,timestamp with time zone,text,jsonb,timestamp with time zone)',
  'saas_apply_renewal(jsonb,timestamp with time zone)',
  'saas_activate_checkout_core(uuid,jsonb,timestamp with time zone,boolean)',
  'saas_activate_hon_os_checkout_core(uuid,jsonb,timestamp with time zone,boolean)',
]);
// Reviewed: these add months only to UTC wall-clock `timestamp` values (explicit AT TIME ZONE 'UTC'),
// which is already independent of the session TimeZone.
export const saasUtcExplicitCalendarFunctions = Object.freeze([
  'saas_allowance_period(hon.saas_subscriptions,timestamp with time zone)',
  'read_saas_organization_credits_from_hq(text,uuid)',
]);
const crossTriggers = [
 ['saas_subscription_generations','saas_generation_authority',7,'guard_saas_generation_insert'],
 ['saas_subscription_generations','saas_generation_evidence',5,'verify_saas_generation_evidence'],
 ['saas_price_schedules','saas_price_authority',7,'guard_saas_price_insert'],
 ['saas_price_schedules','saas_price_evidence',5,'verify_saas_price_evidence'],
 ['saas_price_acceptances','saas_price_authority',7,'guard_saas_price_insert'],
 ['saas_price_acceptances','saas_price_evidence',5,'verify_saas_price_evidence'],
 ['saas_checkout_sessions','saas_price_provider_boundary',7,'guard_saas_price_provider_boundary'],
 ['saas_trial_policy_versions','saas_trial_authority',7,'guard_saas_trial_insert'],
 ['saas_trial_policy_versions','saas_trial_evidence',5,'verify_saas_trial_evidence'],
 ['saas_trial_policy_decisions','saas_trial_authority',7,'guard_saas_trial_insert'],
 ['saas_trial_policy_decisions','saas_trial_evidence',5,'verify_saas_trial_evidence'],
 ['saas_trial_campaign_versions','saas_trial_authority',7,'guard_saas_trial_insert'],
 ['saas_trial_campaign_versions','saas_trial_evidence',5,'verify_saas_trial_evidence'],
 ['saas_trial_publications','saas_trial_authority',7,'guard_saas_trial_insert'],
 ['saas_trial_publications','saas_trial_evidence',5,'verify_saas_trial_evidence'],

 ['saas_exception_policy_decisions','saas_exception_policy_authority',7,'guard_saas_exception_policy_decision'],
 ['saas_exception_policy_decisions','saas_exception_policy_evidence',5,'verify_saas_exception_policy_evidence'],
 ['saas_access_exceptions','saas_exception_policy_binding',5,'verify_saas_exception_policy_binding'],
 ['saas_payment_evidence','saas_referral_alert',5,'saas_evidence_referral_alert'],
 ['saas_invoices','saas_free_period_check',7,'saas_invoice_free_period_check'],
 ['saas_credit_allowances','saas_champions_basis',7,'saas_allowance_free_month_basis'],
 // 0184: no new legacy sale while legacy sales are closed.
 ['saas_subscriptions','saas_legacy_new_sale',7,'guard_saas_legacy_new_sale'],
 ['saas_checkout_sessions','saas_legacy_new_sale',23,'guard_saas_legacy_new_sale'],
 ['saas_founder_reservations','saas_legacy_new_sale',7,'guard_saas_legacy_new_sale'],
 // 0185: a new exception must name a current HQ owner and describe the entitlement exactly.
 ['saas_access_exceptions','saas_exception_authority',7,'guard_saas_access_exception_grant'],
 // 0185: no access state (awaiting or paid) while an exception is open and unexpired (revoke-first pilot conversion).
 ['saas_access_states','saas_exception_await',7,'guard_saas_access_state_exception'],
];
export async function verifySaasBillingSecurity(client, runtime) {
 if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe HON subscription runtime role.');
 for (const table of saasBillingTables) {
  const r=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner) safe
   FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=$1::regclass`,[`hon.${table}`,runtime])).rows[0];
  if (r?.safe!==true) throw new Error(`Unsafe HON subscription table ${table}`);
  const [guard,rowTrigger,rowType] = evidenceTables.includes(table) ? ['guard_saas_evidence','saas_immutable',27]
   : catalogRowTables.includes(table) ? ['guard_saas_catalog_rows','saas_catalog_rows',31]
   : table === 'saas_invoice_lines' ? ['guard_saas_invoice_lines','saas_invoice_lines_rows',31]
   : table === 'saas_operation_prices' ? ['guard_saas_operation_prices','saas_operation_prices_rows',31]
   : paymentTables.includes(table) ? ['guard_saas_payments','saas_guarded',27]
   : table === 'saas_access_states' ? ['guard_saas_access','saas_guarded',27]
   : table === 'saas_access_exceptions' ? ['guard_saas_access_exceptions','saas_guarded',27]
   : table === 'saas_offer_sets' ? ['guard_saas_offer_sets','saas_guarded',27]
   : table === 'saas_offer_set_offers' ? ['guard_saas_offer_set_offers','saas_offer_rows',31]
   : refundRewardTables.includes(table) ? ['guard_saas_refunds_rewards','saas_guarded',27]
   : creditTables.includes(table) ? ['guard_saas_credits','saas_guarded',27]
   : creativeTables.includes(table) ? ['guard_saas_creative','saas_guarded',27]
   : invoicingTables.includes(table) ? ['guard_saas_invoicing','saas_guarded',27] : ['guard_saas_records','saas_guarded',27];
  for (const [name,type] of [[rowTrigger,rowType],['saas_no_truncate',34]]) {
   const t=(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3
    AND tgfoid=$4::regprocedure AND tgenabled='O' AND NOT tgisinternal`,[`hon.${table}`,name,type,`hon.${guard}()`])).rows[0];
   if (t.safe!==true) throw new Error(`Unsafe HON subscription trigger ${table}.${name}`);
  }
 }
 for (const [table,name,type,fn] of crossTriggers) {
  const t=(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3
   AND tgfoid=$4::regprocedure AND tgenabled='O' AND NOT tgisinternal`,[`hon.${table}`,name,type,`hon.${fn}()`])).rows[0];
  if (t.safe!==true) throw new Error(`Unsafe HON subscription trigger ${table}.${name}`);
 }
 const total=(await client.query("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname ~ 'saas'")).rows[0].n;
 if (total!==saasBillingFunctions.length) throw new Error(`Untracked HON subscription functions: ${total}`);
 for (const [signature,execute,definer] of saasBillingFunctions) {
  const r=(await client.query(`SELECT p.prosecdef=$3 AND p.proconfig=CASE WHEN p.oid=ANY(SELECT ('hon.'||f)::regprocedure FROM unnest($5::text[]) f)
     THEN ARRAY['search_path=pg_catalog, hon','TimeZone=UTC'] ELSE ARRAY['search_path=pg_catalog, hon'] END::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute,saasUtcCalendarFunctions])).rows[0];
  if (r?.safe!==true) throw new Error(`Unsafe HON subscription function ${signature}`);
  for (const role of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
   if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role.rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client HON subscription function ${role.rolname}`);
  }
 }
 // Any SaaS function that adds calendar months to a timestamptz must be pinned to UTC (or reviewed as
 // UTC-explicit). A CREATE OR REPLACE that drops the 0201 setting, or a new unpinned function, fails here.
 const unpinned=(await client.query(`SELECT p.oid::regprocedure::text f FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname ~ 'saas'
   AND p.prosrc ~* '(make_interval\\s*\\(\\s*months|interval\\s*''[0-9 ]*(month|year)s?'')'
   AND NOT coalesce('TimeZone=UTC'=ANY(p.proconfig),false)
   AND p.oid<>ALL(SELECT ('hon.'||f)::regprocedure FROM unnest($1::text[]) f) ORDER BY 1`,[saasUtcExplicitCalendarFunctions])).rows.map(r=>r.f);
 if (unpinned.length) throw new Error(`SaaS calendar arithmetic not pinned to UTC: ${unpinned.join(', ')}`);
}
