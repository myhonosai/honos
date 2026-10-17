import React from 'react';
import { ClassBookingWorkbench } from '../../../../components/class-booking-workbench';
import { exactClassBookingSelectorPrefill } from '../../../../components/class-booking-selector-prefill';

// The existing /staff layout verifies the signed session; the canonical API
// independently rechecks current school permission for every submit and replay.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Staff Manual Class Booking', robots: { index: false, follow: false } };

type StaffClassBookingsPageProps = { searchParams: Promise<Record<string, unknown>> };

export default async function StaffClassBookingsPage({ searchParams }: StaffClassBookingsPageProps) {
  const query = await searchParams;
  return <ClassBookingWorkbench initialPrefill={exactClassBookingSelectorPrefill(query)} />;
}
