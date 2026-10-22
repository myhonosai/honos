'use client';

import React, { useEffect, useState } from 'react';
import styles from './crm-enrollment-discard.module.css';

/** Deliberately abandons browser recovery only; never cancels a server command. */
export function CrmEnrollmentDiscard({ disabled, onDiscard, label = 'Discard retry' }: {
  disabled: boolean; onDiscard(): void; label?: string;
}): React.ReactElement {
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { if (disabled) setConfirmed(false); }, [disabled]);
  return <div>
    <p>An action may already have completed. Discard permanently removes its local retry information; it does not cancel or undo a server action. Retry the exact request to resolve an unknown outcome, or deliberately abandon local recovery and verify saved setup before any new action.</p>
    <label className={styles.confirm}><input type="checkbox" disabled={disabled} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I understand and deliberately abandon local recovery.</label>
    <button type="button" disabled={disabled || !confirmed} onClick={() => { if (!disabled && confirmed) { setConfirmed(false); onDiscard(); } }}>{label}</button>
  </div>;
}
