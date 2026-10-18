import React from 'react';
import { CurriculumEnrollmentWorkbench } from '../../../../components/curriculum-enrollment-workbench';

// The inherited staff layout verifies the browser session; the canonical API independently reauthorizes every command.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Curriculum Enrollment', robots: { index: false, follow: false } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Props = { searchParams: Promise<{ studentProfileId?: string | string[] }> };

/** An opaque URL value is form text only; it never establishes school scope or triggers I/O. */
function normalizeInitialStudentProfileId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 80 && UUID.test(value) ? value.toLowerCase() : undefined;
}

export default async function StaffCurriculumEnrollmentsPage({ searchParams }: Props): Promise<React.ReactElement> {
  const initialStudentProfileId = normalizeInitialStudentProfileId((await searchParams).studentProfileId);
  return <CurriculumEnrollmentWorkbench key={initialStudentProfileId ?? 'empty'} {...(initialStudentProfileId === undefined ? {} : { initialStudentProfileId })} />;
}
