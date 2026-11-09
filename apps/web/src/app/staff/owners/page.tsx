import type { Metadata } from 'next';
import { OwnerSchoolOwnership } from '../../../components/school-ownership/owner-school-ownership';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | School owners', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The ownership API decides whether the reader is a live owner of the verified school. */
export default async function OwnerSchoolOwnershipPage() { await requireVerifiedWebSession(); return <OwnerSchoolOwnership />; }
