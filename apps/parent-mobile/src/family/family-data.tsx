import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ParentJourneyView } from '@hon/contracts/parent-journey-view';
import type { ParentApi, ParentFailureState } from '../api/client';
import type { ChildSelection } from '../home/model';
import { createBookingCustody, type BookingCustody } from '../schedule/booking-model';

export type FamilyState =
  | { status: 'loading' }
  | { status: 'ready'; view: ParentJourneyView; timeZone: string | null }
  | { status: ParentFailureState };

interface FamilyContextValue {
  state: FamilyState;
  selection: ChildSelection;
  select: (s: ChildSelection) => void;
  refresh: () => void;
  now: () => Date;
  api: ParentApi;
  /** A fresh random Idempotency-Key for a new command. */
  newKey: () => string;
  /**
   * Booking command keys and the one unconfirmed booking action, owned here so a family refresh, a tab switch or a
   * failed re-read cannot unmount them. The provider is keyed by session, so sign-out drops them.
   */
  booking: BookingCustody;
}
const FamilyContext = createContext<FamilyContextValue | null>(null);

/**
 * Owns the one verified family read. Any failure replaces the data (never "keep showing the old family"),
 * a 401 clears the stored session, and the child selection resets whenever a new response arrives because
 * child positions are only meaningful within a single response.
 */
export function FamilyProvider({ api, onSignedOut, now, newKey, children }: { api: ParentApi; onSignedOut: () => void; now: () => Date; newKey: () => string; children: React.ReactNode }) {
  const [state, setState] = useState<FamilyState>({ status: 'loading' });
  const [selection, setSelection] = useState<ChildSelection>('all');
  const generation = useRef(0);
  const booking = useRef<BookingCustody | null>(null);
  booking.current ??= createBookingCustody(newKey);

  const refresh = useCallback(() => {
    const mine = ++generation.current;
    setState({ status: 'loading' });
    setSelection('all');
    void (async () => {
      const [journey, timeZone] = await Promise.all([api.journey(), api.schoolTimeZone()]);
      if (mine !== generation.current) return;
      if (journey.ok) { setState({ status: 'ready', view: journey.data, timeZone }); return; }
      setState({ status: journey.state });
      if (journey.state === 'signed-out') onSignedOut();
    })();
  }, [api, onSignedOut]);

  useEffect(() => { refresh(); return () => { generation.current++; }; }, [refresh]);

  const select = useCallback((s: ChildSelection) => {
    setSelection(prev => (state.status === 'ready' && (s === 'all' || state.view.children[s]) ? s : prev));
  }, [state]);

  return <FamilyContext.Provider value={{ state, selection, select, refresh, now, api, newKey, booking: booking.current }}>{children}</FamilyContext.Provider>;
}

export function useFamily(): FamilyContextValue {
  const v = useContext(FamilyContext);
  if (!v) throw new Error('useFamily outside FamilyProvider');
  return v;
}
