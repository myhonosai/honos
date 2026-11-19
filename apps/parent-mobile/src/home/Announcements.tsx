import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { FamilySchoolAnnouncement, ParentSchoolAnnouncements } from '@hon/contracts/school-announcements';
import type { ParentApi, ParentRead } from '../api/client';
import { Card, Section } from '../ui/parts';
import { space, type, useColors } from '../ui/theme';

/** How many announcements Home shows before "Show all". */
export const HOME_ANNOUNCEMENTS = 3;

export function announcementDate(iso: string, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat('en-US', timeZone ? { ...options, timeZone } : options).format(new Date(iso));
}

/** Loads the school's announcements whenever `reload` changes to a new non-null value (each fresh family read); a newer load always wins. */
export function useAnnouncements(api: ParentApi, reload: unknown): ParentRead<ParentSchoolAnnouncements> | null {
  const [read, setRead] = useState<ParentRead<ParentSchoolAnnouncements> | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api.announcements();
    if (mine === generation.current) setRead(result);
  }, [api]);
  useEffect(() => { if (reload !== null) void load(); return () => { generation.current++; }; }, [load, reload]);
  return read;
}

/**
 * 0576: announcements the school posted from the CRM, newest first. Only verified data is shown; if the read fails or
 * there is nothing posted, Home shows no section at all rather than a guess. Who posted it is never shown.
 */
export function SchoolAnnouncements({ read, timeZone }: { read: ParentRead<ParentSchoolAnnouncements> | null; timeZone: string | null }) {
  const [all, setAll] = useState(false);
  const c = useColors();
  if (!read || !read.ok || read.data.announcements.length === 0) return null;
  const list = read.data.announcements;
  const shown = all ? list : list.slice(0, HOME_ANNOUNCEMENTS);
  return (
    <View>
      <Section>Announcements</Section>
      {shown.map(a => <Announcement key={a.announcementId} item={a} timeZone={timeZone} />)}
      {list.length > HOME_ANNOUNCEMENTS ? (
        <Pressable accessibilityRole="button" accessibilityLabel={all ? 'Show fewer announcements' : `Show all ${list.length} announcements`} onPress={() => setAll(!all)}
          style={{ paddingVertical: space.sm }}>
          <Text style={{ color: c.accent, fontWeight: '700', fontSize: type.body }}>{all ? 'Show fewer' : `Show all ${list.length}`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Announcement({ item, timeZone }: { item: FamilySchoolAnnouncement; timeZone: string | null }) {
  const [open, setOpen] = useState(false);
  const c = useColors();
  const date = announcementDate(item.publishedAt, timeZone);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Announcement, ${date}: ${item.title}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
          <Text style={{ flex: 1, color: c.text, fontSize: type.title, fontWeight: '700' }}>{item.title}</Text>
          <Text style={{ color: c.muted, fontSize: type.caption }}>{date}</Text>
        </View>
        <Text style={{ color: c.muted, fontSize: type.body, marginTop: space.xs, lineHeight: type.body * 1.4 }} numberOfLines={open ? undefined : 3}>{item.body}</Text>
      </Card>
    </Pressable>
  );
}
