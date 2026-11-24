import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ParentAttendanceStreaks } from '@hon/contracts/parent-attendance-streaks';
import type { ParentApi, ParentRead } from '../api/client';
import { Text } from '../ui/text';
import { Icon } from '../ui/icons';
import { EDGE, radius, space, type, useColors } from '../ui/theme';

export function useStreaks(api: ParentApi, reload: unknown): ParentRead<ParentAttendanceStreaks> | null {
  const [read, setRead] = useState<ParentRead<ParentAttendanceStreaks> | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api.attendanceStreaks();
    if (mine === generation.current) setRead(result);
  }, [api]);
  useEffect(() => { if (reload !== null) void load(); return () => { generation.current++; }; }, [load, reload]);
  return read;
}

export function streakLabel(name: string, weeks: number): string {
  if (weeks === 0) return `${name}: no classes yet this week or last week`;
  return `${name}: ${weeks} ${weeks === 1 ? 'week' : 'weeks'} in a row with a class`;
}

/**
 * 0602: each child's weekly attendance streak, as the school recorded it. Only verified numbers are shown; if the read fails
 * Home shows nothing here rather than a guess. `names` limits the row to the children picked on Home (null = everyone).
 */
export function StreakBar({ read, names }: { read: ParentRead<ParentAttendanceStreaks> | null; names: string[] | null }) {
  const c = useColors();
  if (!read || !read.ok) return null;
  const shown = read.data.children.filter(ch => names === null || names.includes(ch.name));
  if (shown.length === 0) return null;
  return (
    <View style={styles.row}>
      {shown.map(ch => {
        const lit = ch.weeks > 0;
        const first = ch.name.split(/\s+/)[0] || ch.name;
        return (
          <View key={ch.name} accessible accessibilityLabel={streakLabel(ch.name, ch.weeks)}
            style={[styles.stat, { backgroundColor: lit ? c.coralSoft : c.surface, borderColor: c.edge }]}>
            <Icon name="flame" size={24} color={lit ? c.coral : c.subtle} />
            <View>
              <Text style={{ color: c.text, fontSize: type.title, fontWeight: '900', lineHeight: type.title + 4 }}>{ch.weeks}</Text>
              <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700' }}>{shown.length > 1 ? `${first} · ` : ''}{ch.weeks === 1 ? 'week' : 'weeks'} in a row</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  stat: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 2, borderBottomWidth: 2 + EDGE, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
});
