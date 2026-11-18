import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { ParentPlannedAbsenceRequestContext } from '@hon/contracts/parent-planned-absence-request';
import type { ParentRead } from '../api/client';
import { useFamily } from '../family/family-data';
import { Body, Button, Card, Loading, Pill, Section } from '../ui/parts';
import { radius, space, TOUCH, type, useColors } from '../ui/theme';
import { ABSENCE_REFUSALS, absenceWindow, dayLabel, upcomingDays } from './absence-model';
import { createCommandKeys } from './booking-model';

type Status = { phase: 'idle' } | { phase: 'sending' } | { phase: 'unknown' } | { phase: 'done'; message: string } | { phase: 'refused'; message: string };

/**
 * Report a planned absence (parent request). The child list and ids come from HON's context read; the parent picks a
 * child and a day and confirms. HON records a request for the school to review: the app never says the class is
 * cancelled or that attendance changed. An unknown result keeps the same Idempotency-Key for an exact retry.
 */
export function ReportAbsence() {
  const { api, newKey, now, state } = useFamily();
  const c = useColors();
  const keys = useMemo(() => createCommandKeys(newKey), [newKey]);
  const [read, setRead] = useState<ParentRead<ParentPlannedAbsenceRequestContext> | null>(null);
  const [open, setOpen] = useState(false);
  const [child, setChild] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<Status>({ phase: 'idle' });
  const generation = useRef(0);
  const timeZone = state.status === 'ready' ? state.timeZone : null;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api.absenceContext();
    if (mine === generation.current) setRead(result);
  }, [api]);
  useEffect(() => { if (open && !read) void load(); }, [open, read, load]);
  useEffect(() => () => { generation.current++; }, []);

  if (state.status !== 'ready') return null;
  const days = upcomingDays(timeZone, now());
  const today = days[0]!;
  const reset = () => { setOpen(false); setChild(null); setDay(null); setReason(''); setStatus({ phase: 'idle' }); };

  const send = async () => {
    if (!child || !day) return;
    const window = absenceWindow(timeZone, day, now());
    if (!window) { setStatus({ phase: 'refused', message: 'That day is already over. Pick another day.' }); return; }
    const trimmed = reason.trim();
    const action = `absence:${child}:${day}:${trimmed}`;
    const key = keys.keyFor(action);
    setStatus({ phase: 'sending' });
    const result = await api.reportAbsence({ studentProfileId: child, ...window, ...(trimmed ? { reason: trimmed.slice(0, 1000) } : {}) }, key);
    if (result.ok) {
      keys.settle(action);
      setStatus({ phase: 'done', message: 'Sent to your school. They will review it. This does not change bookings or attendance by itself.' });
      return;
    }
    if (result.state === 'unknown' || result.state === 'offline' || result.state === 'unavailable') { setStatus({ phase: 'unknown' }); return; }
    keys.settle(action);
    setStatus({ phase: 'refused', message: (result.code && ABSENCE_REFUSALS[result.code]) ?? 'HON could not record this. Nothing was sent to your school.' });
  };

  return (
    <View>
      <Section>Report an absence</Section>
      {!open ? (
        <Card>
          <Body muted>Let your school know a child will miss class. The school reviews every request.</Body>
          <View style={{ marginTop: space.md }}><Button kind="quiet" label="Report an absence" onPress={() => setOpen(true)} /></View>
        </Card>
      ) : !read ? <Loading label="Loading your children" /> : !read.ok ? (
        <Card><Body muted>Reporting an absence is not available right now.</Body><View style={{ marginTop: space.md }}><Button kind="quiet" label="Close" onPress={reset} /></View></Card>
      ) : (
        <Card label="Report an absence" style={{ borderColor: c.accent }}>
          <Text style={{ color: c.muted, fontWeight: '700' }}>Who</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
            {read.data.children.length === 0 ? <Body muted>No children on your account can have absences reported.</Body> : null}
            {read.data.children.map(ch => <Chip key={ch.studentProfileId} label={ch.displayName} selected={child === ch.studentProfileId}
              onPress={() => { if (status.phase === 'idle' || status.phase === 'refused') { setChild(ch.studentProfileId); setStatus({ phase: 'idle' }); } }} />)}
          </View>
          <Text style={{ color: c.muted, fontWeight: '700', marginTop: space.lg }}>Which day</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
            {days.map(d => <Chip key={d} label={dayLabel(d, today)} selected={day === d}
              onPress={() => { if (status.phase === 'idle' || status.phase === 'refused') { setDay(d); setStatus({ phase: 'idle' }); } }} />)}
          </View>
          <Text style={{ color: c.muted, fontWeight: '700', marginTop: space.lg }}>Note for the school (optional)</Text>
          <TextInput accessibilityLabel="Note for the school" value={reason} onChangeText={t => { setReason(t); if (status.phase === 'refused') setStatus({ phase: 'idle' }); }}
            editable={status.phase === 'idle' || status.phase === 'refused'} maxLength={1000} multiline placeholder="For example: family trip" placeholderTextColor={c.subtle}
            style={{ marginTop: space.sm, minHeight: TOUCH, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, color: c.text, padding: space.md, fontSize: type.body }} />
          <View style={{ marginTop: space.lg }}>
            {status.phase === 'sending' ? <Loading label="Sending to your school" />
              : status.phase === 'unknown' ? (
                <View>
                  <Body>We could not confirm this with your school yet. Nothing is shown as sent until HON confirms it.</Body>
                  <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
                    <Button label="Try again" onPress={() => void send()} />
                    <Button kind="quiet" label="Close" onPress={reset} />
                  </View>
                </View>
              ) : status.phase === 'done' ? (
                <View><Pill tone="good" text="Sent to your school" /><View style={{ marginTop: space.sm }}><Body muted>{status.message}</Body></View>
                  <View style={{ marginTop: space.md }}><Button kind="quiet" label="Done" onPress={reset} /></View></View>
              ) : (
                <View>
                  {status.phase === 'refused' ? <View style={{ marginBottom: space.md }}><Pill tone="bad" text={status.message} /></View> : null}
                  <View style={{ flexDirection: 'row', gap: space.sm }}>
                    <Button label="Send to school" accessibilityLabel="Send absence to school" onPress={() => { if (child && day) void send(); }} />
                    <Button kind="quiet" label="Cancel" onPress={reset} />
                  </View>
                  {!child || !day ? <Text style={{ color: c.subtle, marginTop: space.sm }}>Pick a child and a day first.</Text> : null}
                </View>
              )}
          </View>
        </Card>
      )}
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={label} onPress={onPress}
      style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1,
        borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accentSoft : c.surface }}>
      <Text style={{ color: selected ? c.accent : c.text, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
