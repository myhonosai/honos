import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { familyMessageBodyOk, type ParentFamilyMessages } from '@hon/contracts/family-messages';
import type { ParentRead } from '../api/client';
import { useFamily } from '../family/family-data';
import { createCommandKeys } from '../schedule/booking-model';
import { FamilyGate } from '../screens/FamilyStates';
import { Body, Button, Card, Loading, Pill, StateMessage, Title } from '../ui/parts';
import { radius, space, TOUCH, type, useColors } from '../ui/theme';

export const MESSAGE_REFUSALS: Record<string, string> = {
  FAMILY_MESSAGES_RATE_LIMITED: 'Too many messages were sent in the last hour. Please try again later.',
  VALIDATION_FAILED: 'Messages are plain text of 1 to 2,000 characters.',
  IDEMPOTENCY_KEY_REUSED: 'This send could not be matched to the earlier one. Please write it again.',
};

type Send = { phase: 'idle' } | { phase: 'sending' } | { phase: 'checking' } | { phase: 'unknown' } | { phase: 'refused'; message: string };

/**
 * The family's one conversation with its school (0330). Messages are HON's own records: nothing here texts, emails
 * or pushes, staff names are never shown, and no AI drafts anything. A send with an unknown outcome is re-read; the
 * same text keeps the same Idempotency-Key so a retry can never post twice.
 */
export function MessagesScreen() {
  const { api, newKey, now, state } = useFamily();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const keys = useMemo(() => createCommandKeys(newKey), [newKey]);
  const [read, setRead] = useState<ParentRead<ParentFamilyMessages> | null>(null);
  const [draft, setDraft] = useState('');
  const [send, setSend] = useState<Send>({ phase: 'idle' });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api.schoolMessages();
    if (mine === generation.current) setRead(result);
    return result;
  }, [api]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);

  const submit = async () => {
    const text = draft;
    if (!familyMessageBodyOk(text)) { setSend({ phase: 'refused', message: MESSAGE_REFUSALS.VALIDATION_FAILED! }); return; }
    const action = `message:${text}`;
    const key = keys.keyFor(action);
    const before = read?.ok ? new Set(read.data.messages.map(m => m.messageId)) : new Set<string>();
    setSend({ phase: 'sending' });
    const result = await api.sendSchoolMessage(text, key);
    if (result.ok) { keys.settle(action); setDraft(''); setSend({ phase: 'idle' }); await load(); return; }
    if (result.state === 'unknown' || result.state === 'offline' || result.state === 'unavailable') {
      setSend({ phase: 'checking' });
      const again = await load();
      const landed = again.ok && again.data.messages.some(m => m.mine && m.from === 'FAMILY' && m.body === text && !before.has(m.messageId));
      if (landed) { keys.settle(action); setDraft(''); setSend({ phase: 'idle' }); return; }
      setSend({ phase: 'unknown' });
      return;
    }
    keys.settle(action);
    if (result.state === 'refused') { setSend({ phase: 'refused', message: (result.code && MESSAGE_REFUSALS[result.code]) ?? 'HON could not send this. Nothing was sent.' }); return; }
    setSend({ phase: 'refused', message: 'Messages are not available on this account right now.' });
  };

  const body = state.status !== 'ready' ? null
    : !read ? <Loading label="Loading messages" />
    : !read.ok ? <StateMessage title="Messages are unavailable" body="We couldn't load your messages with the school right now." action={{ label: 'Try again', onPress: () => void load() }} />
    : (
      <View>
        <Text style={{ color: c.muted, marginTop: space.xs }}>{read.data.schoolName}</Text>
        <View style={{ marginTop: space.lg }}>
          {read.data.messages.length === 0 ? <Card><Body muted>No messages yet. Write to your school below. Your school replies here.</Body></Card> : null}
          {read.data.messages.map(m => (
            <View key={m.messageId} accessible accessibilityLabel={`${m.mine ? 'You' : m.from === 'SCHOOL' ? 'School' : 'Your family'}: ${m.body}`}
              style={{ alignSelf: m.from === 'FAMILY' ? 'flex-end' : 'flex-start', maxWidth: '85%', marginBottom: space.sm,
                backgroundColor: m.from === 'FAMILY' ? c.accent : c.surface, borderColor: c.border, borderWidth: m.from === 'FAMILY' ? 0 : 1,
                borderRadius: radius.md, padding: space.md }}>
              <Text style={{ color: m.from === 'FAMILY' ? c.accentText : c.text, fontSize: type.body, lineHeight: 22 }}>{m.body}</Text>
              <Text style={{ color: m.from === 'FAMILY' ? c.accentText : c.subtle, opacity: 0.8, fontSize: type.caption, marginTop: space.xs }}>
                {m.from === 'SCHOOL' ? 'School · ' : m.mine ? '' : 'Family · '}{formatSent(m.sentAt, now())}
              </Text>
            </View>
          ))}
        </View>
        {read.data.canWrite ? (
          <Card style={{ marginTop: space.lg }}>
            <TextInput accessibilityLabel="Message to your school" value={draft} multiline maxLength={2000} placeholder="Write to your school" placeholderTextColor={c.subtle}
              editable={send.phase === 'idle' || send.phase === 'refused'} onChangeText={t => { setDraft(t); if (send.phase === 'refused') setSend({ phase: 'idle' }); }}
              style={{ minHeight: TOUCH * 1.5, color: c.text, fontSize: type.body, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, padding: space.md }} />
            <View style={{ marginTop: space.md }}>
              {send.phase === 'sending' || send.phase === 'checking' ? <Loading label={send.phase === 'sending' ? 'Sending' : 'Checking with your school'} />
                : send.phase === 'unknown' ? (
                  <View>
                    <Body>We could not confirm this message was sent. It is not shown as sent until HON confirms it.</Body>
                    <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
                      <Button label="Try again" onPress={() => void submit()} />
                      <Button kind="quiet" label="Edit" onPress={() => setSend({ phase: 'idle' })} />
                    </View>
                  </View>
                ) : (
                  <View>
                    {send.phase === 'refused' ? <View style={{ marginBottom: space.sm }}><Pill tone="bad" text={send.message} /></View> : null}
                    <Button label="Send" accessibilityLabel="Send message to school" onPress={() => { if (draft.trim()) void submit(); }} />
                  </View>
                )}
            </View>
            <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.sm }}>Messages stay inside HON. Nothing is texted or emailed.</Text>
          </Card>
        ) : <Card style={{ marginTop: space.lg }}><Body muted>Your family access lets you read messages but not send them.</Body></Card>}
      </View>
    );

  return (
    <ScrollView style={{ backgroundColor: c.bg }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl }}>
      <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700', letterSpacing: 1 }}>MESSAGES</Text>
      <Title>Your school</Title>
      {body ?? <FamilyGate state={state} />}
    </ScrollView>
  );
}

function formatSent(iso: string, now: Date): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat('en-US', sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
