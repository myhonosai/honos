import React from 'react';
import { CurriculumEnrollmentPreparationWorkbench } from '../../../../components/curriculum-enrollment-preparation-workbench';

// The inherited staff layout verifies the browser session; preparation and the canonical command independently reauthorize.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Curriculum Enrollment', robots: { index: false, follow: false } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Props = { searchParams: Promise<{ studentProfileId?: string | string[] }> };

/** An opaque CRM URL value is only memory-only form text. It never establishes a school or triggers I/O. */
function normalizeInitialStudentProfileId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 80 && UUID.test(value) ? value.toLowerCase() : undefined;
}

export default async function StaffCurriculumEnrollmentsPage({ searchParams }: Props): Promise<React.ReactElement> {
  const initialStudentProfileId = normalizeInitialStudentProfileId((await searchParams).studentProfileId);
  return <CurriculumEnrollmentPreparationWorkbench key={initialStudentProfileId ?? 'empty'} {...(initialStudentProfileId === undefined ? {} : { initialStudentProfileId })} />;
}
