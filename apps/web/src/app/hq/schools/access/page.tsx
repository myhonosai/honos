import type { Metadata } from 'next';
import { HqAccess } from '../../../../components/hq-access/hq-access';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | School access', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the access overview API decides HQ authority for every read and command. */
export default function HqSchoolAccessPage() { return <HqAccess />; }
