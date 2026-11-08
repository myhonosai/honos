import type { Metadata } from 'next';
import { HqExceptionPolicy } from '../../../../../components/hq-exception-policy/hq-exception-policy';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Exception policy', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the exception-policy API decides HQ authority (read: owner or billing operator; decide: owner). */
export default function HqExceptionPolicyPage() { return <HqExceptionPolicy />; }
