BEGIN;

-- 0706 (E4b): AI designs are paid from the school's creative credits on the 0690 path. Owner decision 2026-11-28 (card
-- "What should one AI-made design cost a school in credits?" -> "2 credits each"): DESIGN_DRAFT (0705) is creative-billed
-- as operation design.generate. The rate itself is the HQ owner's to publish with the existing versioned rate command
-- (per REQUEST, one unit, provisional; the proposal is 2 credits). Until it is published, while the creative program is
-- off, or for a school that is not eligible for creative credits, a design draft stays included AI exactly as in 0705.
-- Everything else is 0690 unchanged: the reservation before the call, the settlement by proposal status, no fallback to
-- included AI for an exhausted school, and at most one creative-paid AI request in flight per school (shared with
-- website edits). Nothing here calls a provider, charges a card or activates a program.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.ai_text_creative_billing') IS NULL OR to_regprocedure('hon.read_school_website_ai_price(text)') IS NULL
    OR to_regprocedure('hon.design_draft_ai_actor(text)') IS NULL OR to_regprocedure('hon.read_design_draft_price(text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM hon.ai_text_creative_billing WHERE kind='DESIGN_DRAFT') THEN
    RAISE EXCEPTION 'Design AI creative credits require 0690 and 0705 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_creative_billing(kind, operation_code) VALUES ('DESIGN_DRAFT', 'design.generate');

-- What the next AI design will cost, shown before asking (no reservation): paid from CREATIVE_CREDITS (the published
-- design.generate rate and this school's available creative credits) or from INCLUDED_AI as in 0705. Anyone who may ask
-- Marcus for a design may read it; it carries no provider, cost or other-school fact. Same rules as the 0690 website price.
CREATE FUNCTION hon.read_design_draft_price(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.design_draft_ai_actor(p_subject); school uuid := hon.current_school_id(); at timestamptz := clock_timestamp();
  per integer; creative boolean; e jsonb; pending integer := 0;
BEGIN
  SELECT r.credits_per_unit INTO per FROM hon.saas_creative_rates r JOIN hon.saas_creative_rate_versions v ON v.id = r.rate_version_id
    JOIN hon.ai_text_creative_billing b ON b.operation_code = r.operation_code AND b.kind = 'DESIGN_DRAFT'
    WHERE v.status = 'PUBLISHED' AND r.media_kind = 'WEBSITE';
  e := hon.saas_creative_eligibility(school, at);
  creative := per IS NOT NULL AND hon.saas_creative_program_active() AND (e->>'eligible')::boolean;
  IF NOT creative THEN RETURN jsonb_build_object('paidWith', 'INCLUDED_AI', 'creditsPerDesign', NULL, 'availableCredits', NULL); END IF;
  -- This month's included credits count before their lot is granted (the first reserve of the window grants it). A
  -- free-trial window (0683) has no subscription and no included monthly lot: only its TRIAL lot counts.
  IF e->>'subscriptionId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hon.saas_creative_lots l WHERE l.school_id = school AND l.lot_kind = 'INCLUDED_MONTHLY'
      AND l.subscription_id = (e->>'subscriptionId')::uuid AND l.window_index = (e#>>'{window,index}')::integer) THEN
    SELECT monthly_included_credits INTO pending FROM hon.saas_creative_program WHERE program_id = 1;
  END IF;
  RETURN jsonb_build_object('paidWith', 'CREATIVE_CREDITS', 'creditsPerDesign', per,
    'availableCredits', coalesce(pending, 0) + (SELECT coalesce(sum(hon.saas_creative_lot_available(x, at)), 0)::integer FROM hon.saas_creative_lots x WHERE x.school_id = school));
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_design_draft_price(text) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_design_draft_price(text) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.read_design_draft_price(text) TO hon_runtime; END IF;
END $$;

COMMIT;
