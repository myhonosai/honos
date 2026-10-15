import React, { type ReactElement } from 'react';

/** This reference is not connected to the verified family endpoint. */
export function ParentJourneyUnavailable(): ReactElement {
  return <section aria-label="Student Journey" role="status">
    <h3>Student Journey unavailable</h3>
    <p>No verified family data is connected to this design reference. No scores or progress are shown.</p>
    <p>Recorded requirement observations describe practice only. MET is not testing approval, promotion, or a guarantee.</p>
  </section>;
}
