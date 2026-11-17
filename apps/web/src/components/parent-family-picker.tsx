'use client';

import React, { useState } from 'react';
import type { ParentFamilyChoice, SelectParentFamilyInput } from '@hon/contracts';
import s from './parent-home.module.css';

const LEVEL: Record<ParentFamilyChoice['accessLevel'], string> = {
  PRIMARY_GUARDIAN: 'Guardian', SECONDARY_GUARDIAN: 'Guardian', VIEWER: 'View only',
};
const key = (c: ParentFamilyChoice) => `${c.schoolId}/${c.familyId}`;
export const familyLabel = (c: ParentFamilyChoice) => `${c.schoolName} · ${c.familyName}`;

/**
 * 0456: shows the families this parent is linked to now. With several and none chosen, the parent must choose before any
 * family page opens. With several and one chosen, a small switcher lets the parent change it without signing out. The choice
 * only names one of the listed families; the server checks it again on every page.
 */
export function ParentFamilyPicker({ choices, needsChoice, busy, error, onChoose }: {
  choices: ParentFamilyChoice[]; needsChoice: boolean; busy: boolean; error: string | null;
  onChoose: (input: SelectParentFamilyInput) => void;
}): React.ReactElement | null {
  const current = choices.find(c => c.current) ?? null;
  const others = choices.filter(c => !c.current);
  const [picked, setPicked] = useState('');
  if (choices.length < 2) return null;
  const choose = (c: ParentFamilyChoice) => onChoose({ schoolId: c.schoolId, familyId: c.familyId });

  if (needsChoice || !current) {
    return <section className={s.state} aria-labelledby="family-picker-heading">
      <p className={s.eyebrow}>CHOOSE A FAMILY</p>
      <h2 id="family-picker-heading">Which school and family do you want to see?</h2>
      <p>Your account is linked to more than one family. Choose one to open. You can switch at any time from this page without signing out.</p>
      <ul className={s.familyList}>
        {choices.map(c => <li key={key(c)}>
          <button type="button" disabled={busy} onClick={() => choose(c)}>
            <strong>{c.schoolName}</strong><span>{c.familyName} · {LEVEL[c.accessLevel]}</span>
          </button>
        </li>)}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>;
  }

  const target = others.find(c => key(c) === picked) ?? null;
  return <section className={s.familySwitch} aria-label="Current family">
    <p><span className={s.eyebrow}>VIEWING</span> <strong>{familyLabel(current)}</strong></p>
    <div>
      <label htmlFor="family-switch">Switch to</label>
      <select id="family-switch" value={picked} disabled={busy} onChange={event => setPicked(event.target.value)}>
        <option value="">Choose another family</option>
        {others.map(c => <option key={key(c)} value={key(c)}>{familyLabel(c)}</option>)}
      </select>
      <button type="button" disabled={busy || !target} onClick={() => { if (target) { setPicked(''); choose(target); } }}>{busy ? 'Switching…' : 'Switch'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
