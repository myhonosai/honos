import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MyTimeClock } from '@hon/contracts/staff-time-clock';
import type { StaffApi, StaffCommandFailure, StaffFailureState, StaffSchool } from './api/client';
import { ROSTER_MARKS, localTime, type ClassSessionRosterEntry, type CurrentSchoolClassSession, type RosterMark, type RosterPage, type TodayClasses } from './api/today';
import { T } from './ui/theme';

/**
 * S1 Today (docs/architecture/STAFF_MOBILE_TODAY.md): my clock, today's classes, and a class roster to mark. Every
 * section asks the server on its own, so a role without one permission still sees the others. The school is only
 * where to look; the server decides each time. Nothing here books, edits a class, or touches anyone else's hours.
 */
type Section<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'failed'; state: Exclude<StaffFailureState, 'signed-out'> };
type Pending = { key: string; signature: string };

export interface TodayProps {
  api: StaffApi;
  school: StaffSchool;
  newKey: () => string;
  /** The server ended the session: the app wipes the token. */
  onSignedOut: () => void;
}

const SECTION_FAILED: Record<Exclude<StaffFailureState, 'signed-out'>, string> = {
  'no-staff-access': 'Not available for your role at this school.',
  unavailable: 'Not available right now. Nothing was changed.',
  offline: 'You are offline.',
};
const COMMAND_FAILED: Record<Exclude<StaffCommandFailure, 'signed-out'>, string> = {
  'no-staff-access': 'Your role cannot do this at this school. Nothing was changed.',
  changed: 'This changed somewhere else. Showing the latest.',
  rejected: 'HON did not accept that. Nothing was changed.',
  unknown: 'Not sure it saved. Tap the same button again to retry safely.',
  offline: 'You are offline. Tap the same button again when you are back.',
};
export const MARK_LABEL: Record<RosterMark | 'MAKEUP', string> = { PRESENT: 'Present', LATE: 'Late', EXCUSED_ABSENCE: 'Excused', UNEXCUSED_ABSENCE: 'Absent', MAKEUP: 'Make-up' };

/** One key per unchanged command: the same tap after an unknown outcome sends the same key, so it can never count twice. */
function useKeys(newKey: () => string) {
  const pending = useRef(new Map<string, Pending>());
  return {
    keyFor(id: string, signature: string): string {
      const current = pending.current.get(id);
      if (current && current.signature === signature) return current.key;
      const next = { key: newKey(), signature };
      pending.current.set(id, next);
      return next.key;
    },
    done(id: string) { pending.current.delete(id); },
  };
}

function Button({ label, onPress, disabled, tone = 'dark' }: { label: string; onPress: () => void; disabled?: boolean; tone?: 'dark' | 'light' }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={[s.button, tone === 'light' && s.buttonLight, disabled && s.disabled]}>
      <Text style={[s.buttonText, tone === 'light' && s.buttonLightText]}>{label}</Text>
    </Pressable>
  );
}

function Failed({ state, onRetry }: { state: Exclude<StaffFailureState, 'signed-out'>; onRetry?: () => void }) {
  return (
    <View style={s.gap}>
      <Text style={s.muted}>{SECTION_FAILED[state]}</Text>
      {onRetry && state !== 'no-staff-access' ? <Button label="Try again" tone="light" onPress={onRetry} /> : null}
    </View>
  );
}

function ClockCard({ api, school, newKey, onSignedOut }: TodayProps) {
  const [clock, setClock] = useState<Section<MyTimeClock>>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const keys = useKeys(newKey);
  const load = useCallback(async () => {
    setClock({ kind: 'loading' });
    const result = await api.clock(school);
    if (result.ok) setClock({ kind: 'ready', data: result.data });
    else if (result.state === 'signed-out') onSignedOut();
    else setClock({ kind: 'failed', state: result.state });
  }, [api, school, onSignedOut]);
  useEffect(() => { void load(); }, [load]);

  const punch = async (data: MyTimeClock) => {
    const action = data.open ? 'CLOCK_OUT' : 'CLOCK_IN';
    const expectedVersion = data.open ? data.open.version : 0;
    const signature = `${action}:${data.open?.entryId ?? ''}:${expectedVersion}`;
    setBusy(true); setMessage(null);
    const result = await api.punch(school, action, expectedVersion, keys.keyFor('punch', signature));
    setBusy(false);
    if (result.ok) { keys.done('punch'); setMessage(action === 'CLOCK_IN' ? 'Clocked in.' : 'Clocked out.'); await load(); return; }
    if (result.state === 'signed-out') { onSignedOut(); return; }
    setMessage(COMMAND_FAILED[result.state]);
    if (result.state === 'changed' || result.state === 'rejected' || result.state === 'no-staff-access') { keys.done('punch'); await load(); }
  };

  return (
    <View style={[s.card, { backgroundColor: T.orbit.lime }]}>
      <Text style={s.cardTitle}>My clock</Text>
      {clock.kind === 'loading' ? <ActivityIndicator accessibilityLabel="Loading my clock" color={T.ink} /> : null}
      {clock.kind === 'failed' ? <Failed state={clock.state} onRetry={() => void load()} /> : null}
      {clock.kind === 'ready' ? (
        <View style={s.gap}>
          <Text style={s.cardBody}>{clock.data.open ? `Clocked in since ${localTime(clock.data.open.clockInAt, clock.data.timezone)}` : 'You are not clocked in.'}</Text>
          <Button label={clock.data.open ? 'Clock out' : 'Clock in'} disabled={busy} onPress={() => void punch(clock.data)} />
        </View>
      ) : null}
      {message ? <Text accessibilityLiveRegion="polite" style={s.note}>{message}</Text> : null}
    </View>
  );
}

function ClassesCard({ api, school, onSignedOut, onOpen }: TodayProps & { onOpen: (c: CurrentSchoolClassSession, timezone: string) => void }) {
  const [classes, setClasses] = useState<Section<TodayClasses>>({ kind: 'loading' });
  const load = useCallback(async () => {
    setClasses({ kind: 'loading' });
    const result = await api.todayClasses(school);
    if (result.ok) setClasses({ kind: 'ready', data: result.data });
    else if (result.state === 'signed-out') onSignedOut();
    else setClasses({ kind: 'failed', state: result.state });
  }, [api, school, onSignedOut]);
  useEffect(() => { void load(); }, [load]);

  return (
    <View style={[s.card, s.white]}>
      <Text style={s.cardTitle}>Today's classes</Text>
      {classes.kind === 'loading' ? <ActivityIndicator accessibilityLabel="Loading today's classes" color={T.ink} /> : null}
      {classes.kind === 'failed' ? <Failed state={classes.state} onRetry={() => void load()} /> : null}
      {classes.kind === 'ready' && classes.data.classes.length === 0 ? <Text style={s.muted}>No classes today.</Text> : null}
      {classes.kind === 'ready' ? classes.data.classes.map(c => {
        const cancelled = c.status === 'CANCELLED';
        const when = `${localTime(c.startsAt, classes.data.timezone)} – ${localTime(c.endsAt, classes.data.timezone)}`;
        return (
          <Pressable key={c.sessionId} accessibilityRole="button" accessibilityLabel={`${c.name}, ${when}${cancelled ? ', cancelled' : ''}`}
            onPress={() => onOpen(c, classes.data.timezone)} style={s.classRow}>
            <View style={[s.dot, { backgroundColor: cancelled ? T.line : T.orbit.blue }]} />
            <View style={s.flex}>
              <Text style={[s.rowTitle, cancelled && s.struck]}>{c.name}</Text>
              <Text style={s.muted}>{when}{c.roomName ? ` · ${c.roomName}` : ''}{cancelled ? ' · Cancelled' : ''}</Text>
            </View>
            <Text style={s.arrow}>›</Text>
          </Pressable>
        );
      }) : null}
      {classes.kind === 'ready' && classes.data.more ? <Text style={s.muted}>More classes today than fit here. See the full list on the web.</Text> : null}
    </View>
  );
}

function Roster({ api, school, newKey, onSignedOut, session, timezone, onBack }: TodayProps & { session: CurrentSchoolClassSession; timezone: string; onBack: () => void }) {
  const [roster, setRoster] = useState<Section<RosterPage>>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const keys = useKeys(newKey);
  const load = useCallback(async () => {
    const result = await api.roster(school, session.sessionId);
    if (result.ok) setRoster({ kind: 'ready', data: result.data });
    else if (result.state === 'signed-out') onSignedOut();
    else setRoster({ kind: 'failed', state: result.state });
  }, [api, school, session.sessionId, onSignedOut]);
  useEffect(() => { void load(); }, [load]);

  const mark = async (entry: ClassSessionRosterEntry, status: RosterMark) => {
    const id = entry.studentProfileId;
    const signature = `${status}:${entry.attendance?.id ?? ''}:${entry.attendance?.version ?? 0}`;
    setBusy(id); setNotes(n => ({ ...n, [id]: '' }));
    const result = await api.mark(school, session.sessionId, entry, status, keys.keyFor(id, signature));
    setBusy(null);
    if (result.ok) {
      keys.done(id);
      setRoster(r => r.kind !== 'ready' ? r : { kind: 'ready', data: { ...r.data, entries: r.data.entries.map(e => e.studentProfileId === id ? { ...e, attendance: result.data } : e) } });
      return;
    }
    if (result.state === 'signed-out') { onSignedOut(); return; }
    const note = COMMAND_FAILED[result.state];
    setNotes(n => ({ ...n, [id]: note }));
    if (result.state === 'changed' || result.state === 'rejected' || result.state === 'no-staff-access') { keys.done(id); await load(); }
  };

  const when = `${localTime(session.startsAt, timezone)} – ${localTime(session.endsAt, timezone)}`;
  return (
    <View style={s.stack}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to Today" onPress={onBack} style={s.back}><Text style={s.backText}>‹ Today</Text></Pressable>
      <Text style={s.hero}>{session.name}</Text>
      <Text style={s.muted}>{when}{session.roomName ? ` · ${session.roomName}` : ''}{session.status === 'CANCELLED' ? ' · Cancelled' : ''}</Text>
      <View style={[s.card, s.white]}>
        {roster.kind === 'loading' ? <ActivityIndicator accessibilityLabel="Loading the roster" color={T.ink} /> : null}
        {roster.kind === 'failed' ? <Failed state={roster.state} onRetry={() => { setRoster({ kind: 'loading' }); void load(); }} /> : null}
        {roster.kind === 'ready' && roster.data.entries.length === 0 ? <Text style={s.muted}>Nobody is booked on this class yet.</Text> : null}
        {roster.kind === 'ready' ? roster.data.entries.map(entry => {
          const name = `${entry.givenName} ${entry.familyName}`;
          const current = entry.attendance?.status;
          return (
            <View key={entry.studentProfileId} style={s.student}>
              <View style={s.studentTop}>
                <Text style={s.rowTitle}>{name}</Text>
                <Text style={s.muted}>{current ? MARK_LABEL[current] : entry.booking?.status === 'CANCELLED' ? 'Booking cancelled' : 'Not marked'}</Text>
              </View>
              <View style={s.marks}>
                {ROSTER_MARKS.map(status => (
                  <Pressable key={status} accessibilityRole="button" accessibilityLabel={`${MARK_LABEL[status]}: ${name}`}
                    accessibilityState={{ selected: current === status, disabled: busy !== null }} disabled={busy !== null}
                    onPress={() => void mark(entry, status)} style={[s.mark, current === status && s.markOn]}>
                    <Text style={[s.markText, current === status && s.markTextOn]}>{MARK_LABEL[status]}</Text>
                  </Pressable>
                ))}
              </View>
              {notes[entry.studentProfileId] ? <Text accessibilityLiveRegion="polite" style={s.alert}>{notes[entry.studentProfileId]}</Text> : null}
            </View>
          );
        }) : null}
        {roster.kind === 'ready' && roster.data.more ? <Text style={s.muted}>More students than fit here. See the full roster on the web.</Text> : null}
      </View>
    </View>
  );
}

export function Today(props: TodayProps) {
  const [open, setOpen] = useState<{ session: CurrentSchoolClassSession; timezone: string } | null>(null);
  if (open) return <Roster {...props} session={open.session} timezone={open.timezone} onBack={() => setOpen(null)} />;
  return (
    <View style={s.stack}>
      <ClockCard {...props} />
      <ClassesCard {...props} onOpen={(session, timezone) => setOpen({ session, timezone })} />
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 16 },
  gap: { gap: 10 },
  flex: { flex: 1, gap: 2 },
  card: { borderRadius: T.radius.card, padding: 22, gap: 12 },
  white: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  cardTitle: { color: T.ink, fontFamily: T.serif, fontSize: 24 },
  cardBody: { color: T.ink, fontFamily: T.serif, fontSize: 18, lineHeight: 25 },
  muted: { color: T.muted, fontSize: 15, lineHeight: 21 },
  note: { color: T.ink, fontSize: 15 },
  alert: { color: T.alert, fontSize: 14 },
  hero: { color: T.ink, fontFamily: T.serif, fontSize: 30, lineHeight: 36 },
  button: { backgroundColor: T.pill, borderRadius: T.radius.pill, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: T.pillText, fontSize: 16, fontWeight: '700' },
  buttonLight: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  buttonLightText: { color: T.ink },
  disabled: { opacity: 0.5 },
  classRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: T.soft, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowTitle: { color: T.ink, fontSize: 17, fontWeight: '600' },
  struck: { textDecorationLine: 'line-through', color: T.muted },
  arrow: { color: T.muted, fontSize: 24 },
  back: { alignSelf: 'flex-start', backgroundColor: T.card, borderRadius: T.radius.pill, borderWidth: 1, borderColor: T.line, paddingVertical: 8, paddingHorizontal: 14 },
  backText: { color: T.ink, fontSize: 15, fontWeight: '700' },
  student: { gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.line },
  studentTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  marks: { flexDirection: 'row', gap: 6 },
  mark: { flex: 1, alignItems: 'center', borderRadius: T.radius.pill, borderWidth: 1, borderColor: T.line, backgroundColor: T.soft, paddingVertical: 9, paddingHorizontal: 4 },
  markOn: { backgroundColor: T.pill, borderColor: T.pill },
  markText: { color: T.ink, fontSize: 13, fontWeight: '600' },
  markTextOn: { color: T.pillText },
});
