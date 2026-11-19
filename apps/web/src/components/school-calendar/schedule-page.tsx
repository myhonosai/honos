'use client';
import React, { useCallback, useState } from 'react';
import { useLocale } from '../localization/provider';
import { ClassSeriesPage } from '../class-series/class-series';
import { SchoolEventsPage } from '../school-events/school-events';
import { SchoolCalendar } from './calendar';
import { calendarText, type CalendarKey } from './copy';
import { CALENDAR_TABS, type CalendarTab, type CalendarView } from './range';
import styles from './school-calendar.module.css';

const TAB_LABEL: Record<CalendarTab, CalendarKey> = { calendar: 'tabCalendar', timetable: 'tabTimetable', events: 'tabEvents' };

/** The URL for a tab: the calendar is the page itself; other tabs add a closed `tab` value. */
export function scheduleTabHref(tab: CalendarTab): string { return tab === 'calendar' ? '/staff/schedule' : `/staff/schedule?tab=${tab}`; }

/**
 * Classes > Calendar: one page for the school's schedule. The calendar (classes, rosters, booking, sale days and events),
 * the weekly timetable and sale days and events are tabs of it; each tab is the existing page, with its own reads and checks.
 * The timetable and events pages carry their own main landmark; only the calendar tab adds one.
 */
export function SchoolSchedulePage({ initialTab = 'calendar', initialView = 'week' }: { initialTab?: CalendarTab; initialView?: CalendarView }): React.ReactElement {
  const { preferences } = useLocale();
  const t = (key: CalendarKey) => calendarText(preferences.language, key);
  const [tab, setTab] = useState<CalendarTab>(initialTab);
  const [addSignal, setAddSignal] = useState(0);
  const choose = useCallback((next: CalendarTab) => {
    setTab(next);
    // Keeps the tab in the address so a refresh or a shared link opens it; history may be unavailable, which is harmless.
    try { window.history.replaceState(window.history.state, '', scheduleTabHref(next)); } catch { /* not available */ }
  }, []);
  return <div className={styles.page} data-hon-native="">
    <header className={styles.head}>
      <div><h1 id="schedule-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      <div className={styles.headActions}>
        <button type="button" className={styles.primary} onClick={() => { choose('calendar'); setAddSignal((n) => n + 1); }} data-testid="calendar-add-class">{t('addClass')}</button>
        <button type="button" className={styles.secondary} onClick={() => choose('events')}>{t('addEvent')}</button>
      </div>
    </header>
    <div className={styles.tabs} role="tablist" aria-label={t('tabsLabel')}>
      {CALENDAR_TABS.map((key) => <button key={key} type="button" role="tab" id={`schedule-tab-${key}`} aria-controls="schedule-panel" aria-selected={tab === key}
        className={styles.tab} onClick={() => choose(key)}>{t(TAB_LABEL[key])}</button>)}
    </div>
    <div className={styles.panel} id="schedule-panel" role="tabpanel" aria-labelledby={`schedule-tab-${tab}`}>
      {tab === 'calendar' ? <main aria-labelledby="schedule-title"><SchoolCalendar initialView={initialView} onManageEvent={() => choose('events')} addSignal={addSignal}/></main> : tab === 'timetable' ? <ClassSeriesPage/> : <SchoolEventsPage/>}
    </div>
  </div>;
}
