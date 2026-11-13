import type { Metadata } from 'next';
import { HqAdmission } from '../../../../components/hq-admission/hq-admission';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Sign-up Limits', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the database decides who may read the limits and that only the HQ owner changes them. */
export default function HqSignupLimitsPage() { return <HqAdmission />; }
