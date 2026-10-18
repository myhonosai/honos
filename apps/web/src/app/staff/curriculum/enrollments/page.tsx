import React from 'react';
import { CurriculumEnrollmentWorkbench } from '../../../../components/curriculum-enrollment-workbench';

// The inherited staff layout verifies the browser session; the canonical API independently reauthorizes every command.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Curriculum Enrollment', robots: { index: false, follow: false } };

export default function StaffCurriculumEnrollmentsPage(): React.ReactElement {
  return <CurriculumEnrollmentWorkbench />;
}
