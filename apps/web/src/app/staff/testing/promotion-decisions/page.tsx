import React from 'react';
import { PromotionDecisionWorkbench } from '../../../../components/promotion-decision-workbench';

// The shared staff layout verifies the session. Every command/replay separately
// rechecks direct-human identity, exact testing.promotion.decide school scope and tenant integrity.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Final Human Promotion Decision', robots: { index: false, follow: false } };
export default function StaffPromotionDecisionPage() {
  return <PromotionDecisionWorkbench />;
}
