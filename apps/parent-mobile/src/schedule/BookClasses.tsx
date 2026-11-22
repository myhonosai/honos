import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '../ui/text';
import type { ParentClassBookingChoices, ParentClassSessionChoice } from '@hon/contracts/parent-class-booking';
import type { ParentRead } from '../api/client';
import { useFamily } from '../family/family-data';
import { formatClassTime } from '../home/model';
import { Body, Button, Card, Loading, Pill, Section } from '../ui/parts';
import { Celebration } from '../ui/Celebration';
import { space, type, useColors } from '../ui/theme';
import { bookAction, cancelAction, describeOutcome, sessionAction, type UnconfirmedBooking } from './booking-model';

type Pending = UnconfirmedBooking;
type Status = { phase: 'confirm' } | { phase: 'sending' } | { phase: 'checking' } | { phase: 'unknown' } | { phase: 'result'; tone: 'good' | 'bad'; message: string };

/**
 * Book and cancel from the app (0329). Every row comes from the server's choices read; the app sends only the
 * server's own ids back, one confirmed action at a time, and re-reads after every answer. A network failure is
 * "not confirmed yet", never success: the app re-reads, and a retry reuses the same Idempotency-Key. The keys and the
 * unconfirmed action live with the family (above this screen), so a refresh, a tab switch or a failed re-read never
 * drops them, and the retry stays on screen even when the class list cannot be read.
 */
export function BookClasses() {
  const { api, now, refresh, state, booking } = useFamily();
  const c = useColors();
  const keys = booking.keys;
  const [read, setRead] = useState<ParentRead<ParentClassBookingChoices> | null>(null);
  // Mounted again after a lost answer: open on that same action, with its same-key retry.
  const [pending, setPending] = useState<Pending | null>(() => booking.unconfirmed);
  const [status, setStatus] = useState<Status | null>(() => booking.unconfirmed ? { phase: 'unknown' } : null);
  const [party, setParty] = useState<{ detail: string } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api.classBookings();
    if (mine === generation.current) setRead(result);
    return result;
  }, [api]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);

  const partyDetail = (p: Pending) => `${p.childName} · ${p.session.name}, ${formatClassTime(p.session.startsAt, read?.ok ? read.data.timezone : null).text}`;
  const start = (p: Pending) => { setPending(p); setStatus({ phase: 'confirm' }); };
  // Closing an unconfirmed action only hides it: it stays held, and the "not confirmed yet" line brings it back.
  const close = () => { setPending(null); setStatus(null); };
  const reopen = () => { if (booking.unconfirmed) { setPending(booking.unconfirmed); setStatus({ phase: 'unknown' }); } };
  const settled = (p: Pending) => { if (booking.unconfirmed === p) booking.unconfirmed = null; };

  const send = async (p: Pending) => {
    const action = p.kind === 'book' ? bookAction(p.childId, p.session.sessionId) : cancelAction(p.session.booking!.bookingId, p.session.booking!.version);
    const key = keys.keyFor(action);
    setStatus({ phase: 'sending' });
    const result = p.kind === 'book'
      ? await api.bookClass({ studentProfileId: p.childId, sessionId: p.session.sessionId }, key)
      : await api.cancelBooking(p.session.booking!.bookingId, p.session.booking!.version, key);
    const outcome = describeOutcome(result, p.kind);
    if (outcome.kind === 'unknown') {
      // Keep the key. Re-read: if the server already shows the change, say so; otherwise offer the same-key retry.
      setStatus({ phase: 'checking' });
      const again = await load();
      const row = again.ok ? again.data.children.find(ch => ch.studentProfileId === p.childId)?.sessions.find(s => s.sessionId === p.session.sessionId) : undefined;
      const landed = p.kind === 'book' ? !!row?.booking : !!row && !row.booking;
      if (landed) {
        keys.settle(action); settled(p);
        if (p.kind === 'book' && row!.booking!.status !== 'WAITLISTED') setParty({ detail: partyDetail(p) });
        setStatus({ phase: 'result', tone: 'good', message: p.kind === 'book'
          ? (row!.booking!.status === 'WAITLISTED' ? 'Added to the waitlist. This is not a confirmed spot yet.' : 'Booked.') : 'Booking cancelled.' });
        refresh();
        return;
      }
      booking.unconfirmed = p;
      setStatus({ phase: 'unknown' });
      return;
    }
    keys.settle(action); settled(p);
    if (outcome.kind === 'session') { close(); refresh(); return; }
    setStatus({ phase: 'result', tone: outcome.kind === 'done' ? 'good' : 'bad', message: outcome.message });
    if (outcome.kind === 'done' && outcome.confirmedBooking) setParty({ detail: partyDetail(p) });
    await load();
    if (outcome.kind === 'done') refresh();
  };

  if (state.status !== 'ready') return null;
  const timezone = read?.ok ? read.data.timezone : null;
  // The action card and the "not confirmed yet" line never depend on the class list being readable.
  const held = !pending && booking.unconfirmed ? booking.unconfirmed : null;
  const custody = (
    <>
      {held ? (
        <Card style={{ borderColor: c.accent }} label="Booking not confirmed yet">
          <Body>{held.kind === 'book' ? 'Booking' : 'Cancelling'} {held.session.name} for {held.childName} is not confirmed yet.</Body>
          <View style={{ marginTop: space.md }}><Button label="Check again" onPress={reopen} /></View>
        </Card>
      ) : null}
      {pending && status ? (
        <Card style={{ borderColor: c.accent }} label="Booking action">
          <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>
            {pending.kind === 'book' ? 'Book' : 'Cancel'} {pending.session.name} for {pending.childName}?
          </Text>
          <Body muted>{formatClassTime(pending.session.startsAt, timezone).text}{pending.session.roomName ? ` · ${pending.session.roomName}` : ''}</Body>
          {status.phase === 'confirm' ? (
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
              <Button label={pending.kind === 'book' ? 'Confirm booking' : 'Confirm cancel'} onPress={() => void send(pending)} />
              <Button kind="quiet" label="Not now" onPress={close} />
            </View>
          ) : status.phase === 'sending' || status.phase === 'checking' ? (
            <Loading label={status.phase === 'sending' ? 'Sending to your school' : 'Checking with your school'} />
          ) : status.phase === 'unknown' ? (
            <View style={{ marginTop: space.md }}>
              <Body>We could not confirm this with your school yet. Nothing is shown as done until HON confirms it.</Body>
              <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
                <Button label="Try again" onPress={() => void send(pending)} />
                <Button kind="quiet" label="Close" onPress={close} />
              </View>
            </View>
          ) : (
            <View style={{ marginTop: space.md }}>
              <Pill tone={status.tone} text={status.message} />
              <View style={{ marginTop: space.md }}><Button kind="quiet" label="Done" onPress={close} /></View>
            </View>
          )}
        </Card>
      ) : null}
    </>
  );
  if (!read || !read.ok) {
    return (
      <View>
        <Section>Book a class</Section>
        {custody}
        {!read ? <Loading label="Loading classes you can book" />
          : <Card style={{ marginTop: space.lg }}><Body muted>Booking from the app is not available right now. Your classes above are still current.</Body></Card>}
      </View>
    );
  }
  const choices = read.data;
  const nowMs = now().getTime();
  // The booking read is its own response with its own child list; the journey chip selection is not mapped onto it.
  const children = choices.children;

  return (
    <View>
      <Celebration visible={!!party} title="You're booked!" detail={party?.detail ?? ''} onClose={() => setParty(null)} />
      <Section>Book a class</Section>
      {!choices.canBook ? <Body muted>Your family access lets you see classes but not book them. Ask your school if you need booking access.</Body> : null}
      {custody}
      {children.map(child => (
        <View key={child.studentProfileId}>
          <Text style={{ color: c.muted, fontWeight: '700', marginTop: space.md, marginBottom: space.sm }}>{child.displayName}</Text>
          {child.sessions.length === 0 ? <Body muted>No bookable classes in the next {choices.horizonDays} days.</Body> : null}
          {child.sessions.map(session => {
            const what = sessionAction(choices, session, nowMs);
            const when = formatClassTime(session.startsAt, choices.timezone).text;
            const booked = session.booking?.status === 'WAITLISTED' ? 'Waitlisted' : session.booking ? 'Booked' : null;
            return (
              <Card key={session.sessionId} label={`${session.name} for ${child.displayName}, ${when}${booked ? `, ${booked}` : `, ${session.spotsLeft} spots left`}`}>
                <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700' }}>{when.toUpperCase()}</Text>
                <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700', marginTop: space.xs }}>{session.name}</Text>
                <Text style={{ color: c.muted }}>{session.programName}{session.roomName ? ` · ${session.roomName}` : ''}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' }}>
                  {booked ? <Pill tone={booked === 'Booked' ? 'good' : 'warn'} text={booked} /> : <Pill text={session.spotsLeft === 0 ? 'Full' : `${session.spotsLeft} spots left`} />}
                  {what === 'book' && !pending ? <Button label="Book" accessibilityLabel={`Book ${session.name} for ${child.displayName}`}
                    onPress={() => start({ kind: 'book', childId: child.studentProfileId, childName: child.displayName, session })} /> : null}
                  {what === 'cancel' && !pending ? <Button kind="quiet" label="Cancel booking" accessibilityLabel={`Cancel ${session.name} for ${child.displayName}`}
                    onPress={() => start({ kind: 'cancel', childId: child.studentProfileId, childName: child.displayName, session })} /> : null}
                </View>
              </Card>
            );
          })}
        </View>
      ))}
    </View>
  );
}
