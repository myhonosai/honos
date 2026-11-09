import type { Metadata } from 'next';
import { HqSchoolOwnership } from '../../../../components/school-ownership/hq-school-ownership';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | School owners', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the ownership API decides HQ-owner authority on every read and command. */
export default function HqSchoolOwnershipPage() { return <HqSchoolOwnership />; }
