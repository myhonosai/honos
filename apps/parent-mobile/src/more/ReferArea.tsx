import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Share, View } from 'react-native';
import type { ParentReferrals, FamilyReferralReward, FamilyReferralStatus } from '@hon/contracts/family-referrals';
import type { ParentRead } from '../api/client';
import { useFamily } from '../family/family-data';
import { Body, Button, Card, Loading, Pill, Section, StateMessage } from '../ui/parts';
import { Text } from '../ui/text';
import { radius, space, type, useColors } from '../ui/theme';
import { Icon } from '../ui/icons';
import { formatDay } from './more-model';

export const REFERRAL_STATUS: Record<FamilyReferralStatus, { text: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  INTERESTED: { text: 'Interested', tone: 'neutral' }, JOINED: { text: 'Joined', tone: 'good' }, NOT_JOINED: { text: "Didn't join", tone: 'neutral' },
};
export const REFERRAL_REWARD: Record<FamilyReferralReward, string> = { PENDING: 'Reward not decided yet', GIVEN: 'Reward given', NOT_ELIGIBLE: 'No reward for this one' };
/** The text the share sheet carries: the school's own message, then the family's link. */
export const shareText = (message: string | null, url: string) => (message ? `${message}\n${url}` : url);

/**
 * 0604 More > Refer a friend. The family shares a personal link from the phone's share sheet; a friend who signs up through it
 * becomes a lead at the school. The family sees how many friends they referred, how many joined, and the school's reward in
 * the school's own words. Friends' names are never shown here. The school gives the reward its own way; nothing is paid in HON.
 */
export function ReferArea() {
  const { api, newKey } = useFamily();
  const c = useColors();
  const [read, setRead] = useState<ParentRead<ParentReferrals> | null>(null);
  const [link, setLink] = useState<string | null>(null), [busy, setBusy] = useState(false), [note, setNote] = useState('');
  const key = useRef<string | null>(null), generation = useRef(0), gate = useRef(false);
  const reload = useCallback(() => {
    const mine = ++generation.current;
    setRead(null); setLink(null); setNote('');
    void api.referrals().then(r => { if (mine === generation.current) { setRead(r); if (r.ok) setLink(r.data.shareUrl); } });
  }, [api]);
  useEffect(() => { reload(); return () => { generation.current++; }; }, [reload]);

  if (!read) return <Loading label="Loading your referrals" />;
  if (!read.ok) return <StateMessage title="Referrals are unavailable" body="We couldn't load this from your school right now. Nothing old is shown in its place." action={{ label: 'Try again', onPress: reload }} />;
  const r = read.data;

  async function share() {
    if (gate.current || !read?.ok) return;
    if (api.sampleMode) { setNote("This is the sample family, so there's no real link to share. With your school's account, this opens your phone's share options."); return; }
    setNote(''); setBusy(true); gate.current = true;
    try { await shareOnce(); } finally { gate.current = false; setBusy(false); }
  }
  async function shareOnce() {
    if (!read?.ok) return;
    let url = link;
    if (!url) {
      key.current ??= newKey();
      const out = await api.referralLink(key.current);
      if (!out.ok) {
        const retry = out.state === 'unknown' || (out.state === 'refused' && out.code === 'PARENT_REFERRALS_CONFLICT');
        if (!retry) key.current = null;
        setNote(retry ? "We couldn't confirm your link. Try again." : out.state === 'signed-out' ? 'Sign in again to share your link.'
          : out.state === 'offline' ? "You're offline. Try again when you're connected." : "Your link isn't available right now. Ask your school.");
        return;
      }
      key.current = null; url = out.data.shareUrl; setLink(url);
    }
    try { await Share.share({ message: shareText(r.shareMessage, url) }); } catch { setNote("Your phone couldn't open the share options."); }
  }

  if (!r.on) return <Card style={{ marginTop: space.lg }}><Body muted>{r.schoolName} doesn't have a referral program right now. Ask at the front desk.</Body></Card>;
  const stats: [number, string, string][] = [[r.counts.referred, 'Referred', c.accent], [r.counts.joined, 'Joined', c.success], [r.counts.rewarded, 'Rewards', c.warning]];
  return (
    <View style={{ marginTop: space.lg }}>
      <Card label="Your reward">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 56, height: 56, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: c.warningSoft }}>
            <Icon name="gift" size={32} color={c.warning} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '800', letterSpacing: 1 }}>YOUR REWARD</Text>
            <Text style={{ color: c.text, fontSize: type.body, fontWeight: '800', marginTop: 2 }}>{r.referrerReward}</Text>
          </View>
        </View>
        {r.friendOffer ? <Body>Your friend gets: {r.friendOffer}</Body> : null}
        {r.rules ? <Body muted>{r.rules}</Body> : null}
        <Body muted>{r.schoolName} gives the reward. Nothing is paid or charged in the app.</Body>
      </Card>
      {r.canShare ? <Button kind="go" label={busy ? 'Getting your link…' : 'Share my link'} accessibilityLabel="Share my referral link" onPress={() => void share()} />
        : <Card><Body muted>Only a parent or guardian on the account can share the family's link.</Body></Card>}
      {note ? <Card><Body>{note}</Body></Card> : null}
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
        {stats.map(([n, label, color]) => (
          <Card key={label} style={{ flex: 1, alignItems: 'center', marginBottom: 0 }} label={`${n} ${label}`}>
            <Text style={{ color, fontSize: type.title, fontWeight: '900' }}>{n}</Text>
            <Text style={{ color: c.muted, fontWeight: '800' }}>{label}</Text>
          </Card>
        ))}
      </View>
      <Section>Your referrals</Section>
      {r.referrals.length === 0 ? <Body muted>No friends yet. Share your link to get started.</Body> : r.referrals.map((x, i) => (
        <Card key={`${x.referredAt}-${i}`} label={`Friend referred ${formatDay(x.referredAt, null)}: ${REFERRAL_STATUS[x.status].text}, ${REFERRAL_REWARD[x.reward]}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
            <Text style={{ color: c.text, fontWeight: '800' }}>A friend · {formatDay(x.referredAt, null)}</Text>
            <Pill text={REFERRAL_STATUS[x.status].text} tone={REFERRAL_STATUS[x.status].tone} />
          </View>
          <Body muted>{REFERRAL_REWARD[x.reward]}</Body>
        </Card>
      ))}
    </View>
  );
}
