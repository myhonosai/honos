import type { Metadata } from 'next';
import { BookingTypesPage } from '../../../../components/booking-types/booking-types';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Booking types', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The booking type API decides every permission for the verified school; this page only asks. */
export default async function BookingTypesRoute() { await requireVerifiedWebSession(); return <BookingTypesPage />; }
