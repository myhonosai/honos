import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { HonAskFailure, StaffApi, StaffFailureState, StaffSchool } from './api/client';
import { AGENT_NAMES, QUESTION_MAX, turnNote, type AskableAgent, type MyAgents } from './api/hon';
import { T } from './ui/theme';

/**
 * S2 HON tab (docs/architecture/STAFF_MOBILE_HON.md): ask HON or one of the analysis agents a question about the
 * school. Which agents show is the server's answer (the owner's switches and each agent's own permission); a hidden
 * agent is never the protection, the server refuses it too. One conversation per visit; nothing here drafts, sends or
 * changes anything. A question whose outcome is not known keeps its key, so asking again cannot run it twice.
 */
type Entry = { id: string; agent: AskableAgent; question: string; answer: string | null; note: string | null };
type Load = { kind: 'loading' } | { kind: 'failed'; state: Exclude<StaffFailureState, 'signed-out'> } | { kind: 'ready'; agents: MyAgents };

const ASK_NOTES: Record<Exclude<HonAskFailure, 'signed-out'>, string> = {
  'agent-off': 'Your owner has not turned this agent on for you. Nothing was sent.',
  paused: 'AI is paused or not included for this school right now. Nothing was sent.',
  full: 'This conversation is full. Starting a new one for your next question.',
  'no-staff-access': 'Not available for your role at this school.',
  changed: 'Something changed. Please ask again.',
  rejected: 'HON could not take that question. Remove phone numbers, emails or links and try again.',
  unknown: 'Not sure it went through. Tap Ask again to retry safely.',
  offline: 'You are offline. Tap Ask again when you are connected.',
};
const LOAD_NOTES: Record<Exclude<StaffFailureState, 'signed-out'>, string> = {
  'no-staff-access': 'HON is not available for your role at this school.',
  unavailable: 'HON is not available right now. Try again in a moment.',
  offline: 'You are offline.',
};

export function Hon({ api, school, newKey, onSignedOut }: { api: StaffApi; school: StaffSchool; newKey: () => string; onSignedOut: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [agent, setAgent] = useState<AskableAgent>('hon');
  const [text, setText] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const conversation = useRef<string | null>(null);
  const conversationKey = useRef<string | null>(null);
  // The key for the question now in the box: reused while the same question to the same agent is retried.
  const pending = useRef<{ signature: string; key: string } | null>(null);

  const read = useCallback(async () => {
    setLoad({ kind: 'loading' });
    const result = await api.myAgents(school);
    if (result.ok) {
      setLoad({ kind: 'ready', agents: result.data });
      const list = result.data.askable;
      setAgent(current => (list.length && !list.includes(current) ? list[0]! : current));
    } else if (result.state === 'signed-out') onSignedOut();
    else setLoad({ kind: 'failed', state: result.state });
  }, [api, school, onSignedOut]);
  useEffect(() => { void read(); }, [read]);

  const ask = async () => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true); setNote(null);
    try {
      if (!conversation.current) {
        conversationKey.current ??= newKey();
        const started = await api.startConversation(school, conversationKey.current);
        if (!started.ok) {
          if (started.state === 'signed-out') { onSignedOut(); return; }
          if (started.state !== 'unknown' && started.state !== 'offline') conversationKey.current = null;
          setNote(ASK_NOTES[started.state]);
          return;
        }
        conversation.current = started.data.id;
      }
      const signature = `${conversation.current}|${agent}|${question}`;
      if (pending.current?.signature !== signature) pending.current = { signature, key: newKey() };
      const result = await api.ask(school, conversation.current, agent, question, pending.current.key);
      if (!result.ok) {
        if (result.state === 'signed-out') { onSignedOut(); return; }
        if (result.state !== 'unknown' && result.state !== 'offline') pending.current = null;
        if (result.state === 'full') { conversation.current = null; conversationKey.current = null; }
        setNote(ASK_NOTES[result.state]);
        if (result.state === 'agent-off') void read();
        return;
      }
      pending.current = null;
      setEntries(list => [...list, { id: result.data.turnId, agent, question, answer: result.data.status === 'COMPLETED' ? result.data.reply : null, note: turnNote(result.data) }]);
      setText('');
    } finally {
      setBusy(false);
    }
  };

  if (load.kind === 'loading') return <ActivityIndicator accessibilityLabel="Loading your AI team" color={T.ink} />;
  if (load.kind === 'failed') {
    return (
      <View style={[s.card, s.white]}>
        <Text style={s.muted}>{LOAD_NOTES[load.state]}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Try again" onPress={() => void read()} style={s.button}><Text style={s.buttonText}>Try again</Text></Pressable>
      </View>
    );
  }
  const { askable, webOnly, ready } = load.agents;
  if (!askable.length && !webOnly.length) {
    return (
      <View style={[s.card, s.white]}>
        <Text style={s.cardTitle}>No AI agents yet</Text>
        <Text style={s.muted}>Your owner has not turned on any AI agents for you at this school. They can do it in Staff, Roles and permissions.</Text>
      </View>
    );
  }
  return (
    <View style={s.stack}>
      <View style={[s.card, s.panel]}>
        <Text style={s.panelTitle}>Your AI team</Text>
        <View style={s.strip}>
          {askable.map(a => (
            <Pressable key={a} accessibilityRole="button" accessibilityLabel={`Ask ${AGENT_NAMES[a].name}, ${AGENT_NAMES[a].role}`} accessibilityState={{ selected: a === agent }}
              onPress={() => setAgent(a)} style={[s.chip, a === agent && s.chipOn]}>
              <Text style={[s.chipName, a === agent && s.chipNameOn]}>{AGENT_NAMES[a].name}</Text>
              <Text style={[s.chipRole, a === agent && s.chipRoleOn]}>{AGENT_NAMES[a].role}</Text>
            </Pressable>
          ))}
        </View>
        {webOnly.length ? <Text style={s.panelMuted}>{webOnly.map(a => AGENT_NAMES[a].name).join(', ')}: on the web for now.</Text> : null}
        {!ready ? <Text style={s.panelMuted}>The AI team is not available at this school right now.</Text> : null}
      </View>
      {entries.map(e => (
        <View key={e.id} style={s.gap}>
          <View style={s.mine}><Text style={s.mineText}>{e.question}</Text></View>
          <View style={[s.card, s.white]}>
            <Text style={s.from}>{AGENT_NAMES[e.agent].name}</Text>
            {e.answer ? <Text style={s.answer}>{e.answer}</Text> : null}
            {e.note ? <Text style={s.muted}>{e.note}</Text> : null}
          </View>
        </View>
      ))}
      {askable.length ? (
        <View style={[s.card, s.white]}>
          <TextInput accessibilityLabel={`Question for ${AGENT_NAMES[agent].name}`} placeholder={`Ask ${AGENT_NAMES[agent].name} about your school`} placeholderTextColor={T.muted}
            value={text} onChangeText={setText} multiline maxLength={QUESTION_MAX} style={s.input} />
          <Text style={s.hint}>Tip: tap the microphone on your keyboard to speak your question.</Text>
          {note ? <Text style={s.alert}>{note}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Ask" disabled={busy || !text.trim() || !ready} onPress={() => void ask()}
            style={[s.button, (busy || !text.trim() || !ready) && s.disabled]}>
            {busy ? <ActivityIndicator accessibilityLabel="Asking" color={T.pillText} /> : <Text style={s.buttonText}>Ask</Text>}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 16 },
  gap: { gap: 8 },
  card: { borderRadius: T.radius.card, padding: 20, gap: 12 },
  white: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  panel: { backgroundColor: T.panel },
  panelTitle: { color: T.panelText, fontSize: 18, fontWeight: '700' },
  panelMuted: { color: T.panelMuted, fontSize: 14, lineHeight: 20 },
  cardTitle: { color: T.ink, fontFamily: T.serif, fontSize: 24 },
  muted: { color: T.muted, fontSize: 15, lineHeight: 21 },
  alert: { color: T.alert, fontSize: 14, lineHeight: 20 },
  hint: { color: T.muted, fontSize: 13 },
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  chipOn: { backgroundColor: T.orbit.cyan, borderColor: T.orbit.cyan },
  chipName: { color: T.panelText, fontSize: 15, fontWeight: '700' },
  chipNameOn: { color: T.ink },
  chipRole: { color: T.panelMuted, fontSize: 12 },
  chipRoleOn: { color: T.ink },
  mine: { alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: T.pill, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14 },
  mineText: { color: T.pillText, fontSize: 15, lineHeight: 21 },
  from: { color: T.muted, fontSize: 13, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  answer: { color: T.ink, fontSize: 16, lineHeight: 23 },
  input: { minHeight: 80, color: T.ink, fontSize: 16, lineHeight: 22, backgroundColor: T.soft, borderRadius: 16, padding: 14, textAlignVertical: 'top' },
  button: { backgroundColor: T.pill, borderRadius: T.radius.pill, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: T.pillText, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
