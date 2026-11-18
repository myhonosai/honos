# School Calendar page (one page for the schedule)

Owner ask (David, 2026-11-16): "Class roster, schedule, weekly time table, sale day & event, class booking should be in one page under calendar form."

## Spec

**Objective.** Staff open one page, Classes > Calendar (`/staff/schedule`), and see the school's classes and its sale days and events on a calendar. From the same page they open a class to see its roster, mark attendance and book a student, and they manage the weekly timetable and sale days and events without leaving the page.

**Scope: frontend only.** No migration, no new API, no new permission. Every read and write goes through the existing APIs, and each re-checks the school and the person's permission on the server:

| Need | Existing source |
| --- | --- |
| Classes in the visible days | forward-paging session list (0221, `schedule.session.read`), from the first visible school-local date |
| Roster, attendance marks | class roster read (U5, `attendance.record`) and the attendance command |
| Book a student | the existing manual class booking workbench (canonical booking API) with the class pre-chosen |
| Weekly timetable | the existing class series page (0239/0251) |
| Sale days and events | the existing school events list and page (0261). Sale days already exist there, so nothing new is added. |

**Page.** It has three tabs: Calendar, Weekly timetable, and Sale days & events. `?tab=` and `?view=` take closed values only; anything else is ignored.

**Model (David, 2026-11-16).** The layout follows the scheduler in the CRM David uses today, adapted rather than copied: Month, Week and Day on the right; Previous, Today, Next and the dates on the left; weeks that start on Monday; an hour grid for Week and Day where each class sits at its time, is as tall as it lasts, and sits beside any class it overlaps; filter chips across the top (HON filters by class name, since sessions carry no program or instructor); and class details in a drawer on the right with roster counts, the roster and booking. Two things are not carried over because HON's reads don't hold them: an instructor filter and booked counts on each block.

**Calendar tab.**
- Day, Week and Month views, with Previous, Today and Next. Weeks start on Monday. Week and Day show an hour grid from 7 AM to 9 PM, widened to fit every class. Sale days and events go in an Events row above the hours. Dates and times are school time, from the zone the session list reports.
- Classes and events on each day: events first, then classes by start time. A cancelled class shows as cancelled. A month cell shows up to 3 items and then "+N more", which opens that day.
- To load, the page reads the session list from the first visible date and keeps reading until it passes the last visible date, up to 10 pages (500 classes). Past that it says some classes are not shown. If the list changes while it is being read, it is read again once, and after that it shows "unavailable". Events come from one events read, filtered to the visible days.
- Clicking a class opens the right-side drawer (Close or Escape shuts it) with with when, room, capacity and status, the roster with counts and attendance marks (the same code as the old roster page), and a "Book a student" button that opens the booking form for that class. The button is hidden for cancelled and completed classes.
- Clicking an event opens a panel with its date, hours, status and booked spots, plus "Manage on Sale days & events", which switches tabs.
- If the person may not read events, the calendar still shows classes and says that sale days are hidden for their role. The same goes the other way round.
- Privacy: as on the other school pages, a blur, a hidden tab, a school change or the end of the session hides the page and retires every read.

**Menu and old pages.** Classes > Schedule shows one "Calendar" entry instead of Rosters, Sessions, Timetable, Events and Bookings. `/staff/schedule/sessions`, `/timetable` and `/events` redirect to the matching tab. `/staff/schedule/bookings` (opened from other pages with a class chosen) and `/sessions/create` stay as workflow pages, hidden from the menu, and the shell still marks them as Classes.

**Out of scope.** Drag to reschedule, creating classes from a calendar cell, parent-facing calendar, a new promotions model.

**Success.** Unit tests cover range maths, local-date grouping, the paging loader (stop, cap, drift restart), view rendering (day/week/month, events and classes, "+N more", panels, denied states) and the menu change. `pnpm --filter @hon/web test`, `check` and `build` all pass.

## Plan

1. `school-calendar/range.ts`: pure date maths (range for a view, shift, month grid, local date of an instant), tested first.
2. `school-calendar/http.ts`: the range loader over `rosterApi.sessions` (cap, drift, restart once), tested first.
3. Pull the roster panel and its state out of `ClassRoster` (`useRosterDetail`, `RosterSessionDetail`) with no change in behaviour. The existing roster tests stay green.
4. `school-calendar/view.tsx` and `calendar.tsx`: a pure view plus the state container. `copy.ts` in en/ko/es.
5. `SchoolSchedulePage` with tabs; route `/staff/schedule`; redirects; catalog and copy; `manus-routes.json`.
6. Full web test, type check and build, then independent review.
