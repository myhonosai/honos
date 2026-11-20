import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Text } from '../ui/text';
import type { BookingTypeAnswer } from '@hon/contracts/school-booking-types';
import type {
  ParentSchoolBooking, ParentSchoolBookingReceipt, ParentSchoolBookings, ParentSchoolBookingTypeChoice, ParentSchoolEventChoice, ParentSchoolEventSlot,
} from '@hon/contracts/parent-school-bookings';
import type { ParentRead, ParentWrite } from '../api/client';
import { useFamily } from '../family/family-data';
import { Body, Button, Card, Loading, Pill, Section, StateMessage } from '../ui/parts';
import { radius, space, TOUCH, type, useColors } from '../ui/theme';

/** A school-local calendar date is shown as that date, never shifted by the phone's time zone. */
export function schoolDay(localDate: string): string {
  return new Date(`${localDate}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export const SCHOOL_BOOKING_REFUSALS: Record<string, string> = {
  PARENT_SCHOOL_BOOKING_FULL: 'That time is full. Please pick another.',
  PARENT_SCHOOL_BOOKING_ALREADY_BOOKED: 'Your family already has a booking here.',
  PARENT_SCHOOL_BOOKING_NOT_OFFERED: 'That time can no longer be booked here.',
  PARENT_SCHOOL_BOOKING_NOT_CANCELLABLE: 'This booking can no longer be cancelled in the app. Please contact the school.',
  PARENT_SCHOOL_BOOKING_NOT_FOUND: 'That booking is not available.',
  PARENT_SCHOOL_BOOKING_NO_CONTACT: 'Your account has no email the school can use for a booking. Please contact the school.',
  VALIDATION_FAILED: 'Check your answers and the waiver, then try again.',
  VERSION_CONFLICT: 'This booking changed. Here is the latest.',
};

type Draft = { startsAt: string; answers: BookingTypeAnswer[]; waiverAccepted: boolean };
type Pending =
  | { kind: 'slot'; event: ParentSchoolEventChoice; slot: ParentSchoolEventSlot }
  | { kind: 'type'; type: ParentSchoolBookingTypeChoice }
  | { kind: 'cancel'; booking: ParentSchoolBooking };
type Status = { phase: 'confirm' } | { phase: 'sending' } | { phase: 'unknown' } | { phase: 'result'; tone: 'good' | 'bad'; message: string };

function emptyDraft(t: ParentSchoolBookingTypeChoice): Draft { return { startsAt: '', answers: t.questions.map(() => null), waiverAccepted: false }; }

/** What is sent for a booking type: trimmed text, yes/no or null, and the waiver only when the type has one. */
export function bookingTypeInput(t: ParentSchoolBookingTypeChoice, d: Draft) {
  const answers = t.questions.map((q, i) => { const a = d.answers[i] ?? null; return q.kind === 'TEXT' ? (typeof a === 'string' ? a.trim() : '') : (typeof a === 'boolean' ? a : null); });
  return { typeId: t.typeId, startsAt: d.startsAt, answers, waiverAccepted: t.waiver !== '' && d.waiverAccepted };
}
/** Whether the confirm button can be pressed: a time, every required answer, and the waiver when there is one. */
export function draftReady(t: ParentSchoolBookingTypeChoice, d: Draft): boolean {
  if (!d.startsAt) return false;
  if (t.waiver && !d.waiverAccepted) return false;
  return t.questions.every((q, i) => !q.required || (q.kind === 'TEXT' ? typeof d.answers[i] === 'string' && (d.answers[i] as string).trim() !== '' : typeof d.answers[i] === 'boolean'));
}

/**
 * School events and families-only bookings (0466) in the app. Every row comes from the server's read; the app sends back
 * only the server's own ids, one confirmed action at a time, and re-reads after every answer. A lost answer is "not
 * confirmed yet", never success, and Try again resends the same request with the same Idempotency-Key.
 */
export function EventsArea() {
  const { api, newKey } = useFamily();
  const c = useColors();
  const [read, setRead] = useState<ParentRead<ParentSchoolBookings> | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const generation = useRef(0);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api.schoolBookings();
    if (mine === generation.current) setRead(result);
  }, [api]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);

  const start = (p: Pending) => { setPending(p); setStatus({ phase: 'confirm' }); setDraft(p.kind === 'type' ? emptyDraft(p.type) : null); };
  const close = () => { setPending(null); setStatus(null); setDraft(null); };

  const actionOf = useMemo(() => (p: Pending, d: Draft | null) => p.kind === 'slot' ? `slot:${p.slot.slotId}`
    : p.kind === 'cancel' ? `cancel:${p.booking.bookingId}:${p.booking.version}` : `type:${JSON.stringify(bookingTypeInput(p.type, d!))}`, []);

  const send = async (p: Pending) => {
    const action = actionOf(p, draft);
    let key = keys.current.get(action);
    if (!key) { key = newKey(); keys.current.set(action, key); }
    setStatus({ phase: 'sending' });
    let result: ParentWrite<ParentSchoolBookingReceipt>;
    try {
      result = p.kind === 'slot' ? await api.bookSchoolEventSlot(p.slot.slotId, key)
        : p.kind === 'cancel' ? await api.cancelSchoolBooking(p.booking.bookingId, p.booking.version, key)
          : await api.bookSchoolBookingType(bookingTypeInput(p.type, draft!), key);
    } catch {
      // The input did not pass the shared validator: nothing was sent.
      keys.current.delete(action);
      setStatus({ phase: 'result', tone: 'bad', message: SCHOOL_BOOKING_REFUSALS.VALIDATION_FAILED! });
      return;
    }
    if (!result.ok && result.state === 'unknown') { setStatus({ phase: 'unknown' }); void load(); return; }
    keys.current.delete(action);
    if (result.ok) {
      const b = result.data.booking;
      setStatus({ phase: 'result', tone: 'good', message: `${p.kind === 'cancel' ? 'Cancelled' : 'Booked'}: ${b.title}, ${schoolDay(b.localDate)} at ${b.localStart}.` });
    } else {
      const message = result.state === 'refused' ? (result.code && SCHOOL_BOOKING_REFUSALS[result.code]) || 'This was not accepted. Nothing was changed.'
        : 'Booking is not available on this account right now.';
      setStatus({ phase: 'result', tone: 'bad', message });
    }
    await load();
  };

  if (!read) return <Loading label="Loading events" />;
  if (!read.ok) return <StateMessage title="Events are unavailable" body="We couldn't load this from your school right now. Nothing old is shown in its place." action={{ label: 'Try again', onPress: () => { setRead(null); void load(); } }} />;
  const v = read.data;
  const busy = !!pending;

  const field = { marginTop: space.sm, minHeight: TOUCH, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, color: c.text, padding: space.md, fontSize: type.body } as const;
  const choice = (selected: boolean) => ({ minHeight: TOUCH, paddingHorizontal: space.md, justifyContent: 'center' as const, borderRadius: radius.pill, borderWidth: 1,
    borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : c.surface, marginRight: space.sm, marginTop: space.sm });
  const choiceText = (selected: boolean) => ({ color: selected ? c.accentText : c.text, fontWeight: '600' as const });

  const confirmCard = pending && status ? (
    <Card style={{ borderColor: c.accent, marginTop: space.md }}>
      <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>
        {pending.kind === 'slot' ? `Book ${pending.event.title}?` : pending.kind === 'cancel' ? `Cancel ${pending.booking.title}?` : `Book ${pending.type.name}`}
      </Text>
      {pending.kind === 'slot' ? <Body muted>{schoolDay(pending.event.localDate)}, {pending.slot.localStart}–{pending.slot.localEnd}{pending.event.place ? ` · ${pending.event.place}` : ''}</Body> : null}
      {pending.kind === 'cancel' ? <Body muted>{schoolDay(pending.booking.localDate)}, {pending.booking.localStart}–{pending.booking.localEnd}</Body> : null}
      {pending.kind === 'type' && draft && status.phase === 'confirm' ? (
        <View>
          <Text style={{ color: c.muted, fontWeight: '700', marginTop: space.md }}>Pick a time</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {pending.type.times.filter(x => x.spotsLeft > 0).slice(0, 24).map(x => (
              <Pressable key={x.startsAt} accessibilityRole="button" accessibilityState={{ selected: draft.startsAt === x.startsAt }}
                accessibilityLabel={`${schoolDay(x.localDate)} at ${x.localStart}, ${x.spotsLeft} left`}
                onPress={() => setDraft({ ...draft, startsAt: x.startsAt })} style={choice(draft.startsAt === x.startsAt)}>
                <Text style={choiceText(draft.startsAt === x.startsAt)}>{schoolDay(x.localDate).split(',')[0]} {x.localDate.slice(5).replace('-', '/')} · {x.localStart}</Text>
              </Pressable>
            ))}
          </View>
          {pending.type.questions.map((q, i) => (
            <View key={i} style={{ marginTop: space.md }}>
              <Text style={{ color: c.text, fontWeight: '600' }}>{q.label}{q.required ? '' : ' (optional)'}</Text>
              {q.kind === 'TEXT' ? (
                <TextInput accessibilityLabel={q.label} maxLength={300} value={typeof draft.answers[i] === 'string' ? draft.answers[i] as string : ''}
                  onChangeText={t => setDraft({ ...draft, answers: draft.answers.map((a, j) => (j === i ? t : a)) })} style={field} placeholderTextColor={c.subtle} />
              ) : (
                <View style={{ flexDirection: 'row' }}>
                  {[true, false].map(yes => (
                    <Pressable key={String(yes)} accessibilityRole="button" accessibilityLabel={`${q.label}: ${yes ? 'Yes' : 'No'}`} accessibilityState={{ selected: draft.answers[i] === yes }}
                      onPress={() => setDraft({ ...draft, answers: draft.answers.map((a, j) => (j === i ? yes : a)) })} style={choice(draft.answers[i] === yes)}>
                      <Text style={choiceText(draft.answers[i] === yes)}>{yes ? 'Yes' : 'No'}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          ))}
          {pending.type.waiver ? (
            <View style={{ marginTop: space.md }}>
              <Text style={{ color: c.muted }}>{pending.type.waiver}</Text>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: draft.waiverAccepted }} accessibilityLabel="I have read and accept this"
                onPress={() => setDraft({ ...draft, waiverAccepted: !draft.waiverAccepted })} style={choice(draft.waiverAccepted)}>
                <Text style={choiceText(draft.waiverAccepted)}>{draft.waiverAccepted ? '✓ ' : ''}I have read and accept this</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
      {status.phase === 'confirm' ? (
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
          {pending.kind !== 'type' || (draft && draftReady(pending.type, draft))
            ? <Button label={pending.kind === 'cancel' ? 'Confirm cancel' : 'Confirm booking'} onPress={() => void send(pending)} /> : null}
          <Button kind="quiet" label="Not now" onPress={close} />
        </View>
      ) : status.phase === 'sending' ? <Loading label="Sending to your school" />
        : status.phase === 'unknown' ? (
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
  ) : null;

  return (
    <View>
      {!v.canBook ? <Card style={{ marginTop: space.md }}><Body muted>{v.contact ? 'Your access to this family lets you see these times but not book them. A guardian on the account can book.'
        : 'Your account has no email the school can use for a booking. Please contact the school.'}</Body></Card> : null}
      {confirmCard}
      <Section>Your upcoming bookings</Section>
      {!v.bookings.length ? <Card><Body muted>No upcoming bookings made here.</Body></Card> : v.bookings.map(b => (
        <Card key={b.bookingId}>
          <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{b.title}</Text>
          <Text style={{ color: c.muted, marginTop: space.xs }}>{schoolDay(b.localDate)}, {b.localStart}–{b.localEnd}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' }}>
            <Pill tone="good" text={b.status === 'ARRIVED' ? 'Checked in' : 'Booked'} />
            {v.canBook && b.canCancel && !busy ? <Button kind="quiet" label="Cancel booking" accessibilityLabel={`Cancel ${b.title}`} onPress={() => start({ kind: 'cancel', booking: b })} /> : null}
          </View>
        </Card>
      ))}
      <Section>School events</Section>
      {!v.events.length ? <Card><Body muted>No school events are taking bookings right now.</Body></Card> : v.events.map(e => (
        <Card key={e.eventId}>
          <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{e.title}</Text>
          <Text style={{ color: c.muted, marginTop: space.xs }}>{schoolDay(e.localDate)}{e.place ? ` · ${e.place}` : ''}</Text>
          {e.description ? <Text style={{ color: c.text, marginTop: space.sm }}>{e.description}</Text> : null}
          {e.bookingId ? <View style={{ marginTop: space.sm }}><Pill tone="good" text="Your family is booked" /></View> : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {e.slots.map(x => {
                const open = v.canBook && x.spotsLeft > 0 && !busy;
                return (
                  <Pressable key={x.slotId} disabled={!open} accessibilityRole="button" accessibilityState={{ disabled: !open }}
                    accessibilityLabel={`Book ${e.title} at ${x.localStart}, ${x.spotsLeft > 0 ? `${x.spotsLeft} left` : 'full'}`}
                    onPress={() => start({ kind: 'slot', event: e, slot: x })} style={[choice(false), { opacity: open ? 1 : 0.5 }]}>
                    <Text style={choiceText(false)}>{x.localStart}–{x.localEnd} · {x.spotsLeft > 0 ? `${x.spotsLeft} left` : 'Full'}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </Card>
      ))}
      <Section>Family bookings</Section>
      {!v.bookingTypes.length ? <Card><Body muted>Your school has no family bookings open right now.</Body></Card> : v.bookingTypes.map(t => {
        const open = t.times.some(x => x.spotsLeft > 0);
        return (
          <Card key={t.typeId}>
            <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{t.name}</Text>
            <Text style={{ color: c.muted, marginTop: space.xs }}>{t.durationMinutes} minutes</Text>
            {t.description ? <Text style={{ color: c.text, marginTop: space.sm }}>{t.description}</Text> : null}
            <View style={{ marginTop: space.sm }}>
              {t.bookingId ? <Pill tone="good" text="Your family is booked" />
                : !open ? <Body muted>No times are open right now.</Body>
                  : v.canBook && !busy ? <Button label="Pick a time" accessibilityLabel={`Pick a time for ${t.name}`} onPress={() => start({ kind: 'type', type: t })} /> : null}
            </View>
          </Card>
        );
      })}
      {v.canBook && v.contact ? <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.md }}>Bookings are made as {v.contact.name}, {v.contact.email}. Times are in your school's time zone. No payment is taken.</Text> : null}
    </View>
  );
}
