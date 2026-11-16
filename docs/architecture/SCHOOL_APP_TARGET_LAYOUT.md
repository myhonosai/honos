# School app target layout (one menu, one page per job)

Owner request (David, 2026-11-16): "each function is made too complicated. Look at my current CRM and make all simple ...
keep our current set up functions, use the organization style of my current CRM." And: "retain our set up big button,
modern, classic."

This document is the **single target information architecture** for the HON school app. Every thread that changes a
school page or the school menu (`apps/web/src/components/school-shell/catalog.ts`) follows it. A copy lives at
`/mnt/project-files/school-ia/SCHOOL_APP_TARGET_LAYOUT.md`.

## 1. What we take from David's current CRM (organization only, not its look)

Mapped read-only from his Manus CRM on 2026-11-16. Its whole menu is 19 pages under six small headings:

| Heading | Pages |
|---|---|
| Overview | Dashboard |
| Automation | AI Assistance, Conversation AI, Coordination, AI History |
| Operations | Scheduler, Communications |
| Finance | Checkout Pages, Point of Sale |
| People | Website App, Leads, Contacts |
| Business | Rank System, Attendance, Membership, Reports, Invoices, Tags |
| (bottom) | Light mode, Settings |

The rules that make it feel simple:

1. **Two levels, never three.** The menu lists pages. A page has at most a handful of tabs inside it (POS: Register /
   History / Inventory; Membership: Plans / Programs / Members / Alerts; Rank System: Rank chart / Belt tests / AI
   analysis; Attendance: Today's roster / History / Stats / Scanner / Check-in cards). HON today has three levels
   (8 areas, then groups, then up to 9 tabs; about 75 menu entries).
2. **A page is named after the job** ("Point of Sale", "Invoices", "Leads"), not after the record or the workflow step.
3. **Each page opens on the useful thing**: a few number cards at the top, then the list or board, one primary button
   at the top right (New Plan, New Invoice, Add Contact).
4. **People actions live on the person** (contact card), not on separate workflow pages.
5. **Settings is one page** with a row of tabs (School info, Branding, Instructors, Agreements, Notifications,
   Integrations, Reminders, Message templates, Staff ...).

We keep HON's three views exactly as they are (Big Button, Modern, Classic), HON's colours and HON's functions. We only
change how pages are grouped and named.

## 2. Target menu (David's own layout, 2026-11-16 07:52Z; replaces the six-heading draft)

David wrote the menu himself:

> Dashboard: Ask HON · AI: AI team, Conversation AI · Calendar: calendar, attendance · Contacts: contact list, staff ·
> Lead: lead pipeline (editable, automations) · Communication: SMS, email, FB/IG messaging · Finance: checkout pages,
> POS, Shopify, invoices · Marketing: website, marketing, creative · Ranks: rank setup, test, mass rank promotion ·
> Business: membership, agreement, report · Community

So the menu has **eleven headings**, each with its few pages under it, and Settings at the bottom. Tabs inside a page are
the existing routes; nothing is deleted. A route marked *(hidden)* stays in the catalog so "where am I" works, but is
opened from a link on its page, not from the menu.

| Heading | Page (menu name) | Opens at | Tabs inside the page | Owner thread |
|---|---|---|---|---|
| Dashboard | **Dashboard** | `/staff/dashboard` | Overview · Work · Command Center | this thread |
| Dashboard | **Ask HON** | `/staff/hon` | (none) | this thread |
| AI | **AI Team** | `/staff/ai-team` | Team · Approvals · AI drafts · Voice. Chad, Marcus, Kai, Maya workspaces *(hidden, opened from each card)* | this thread |
| AI | **Conversation AI** | `/staff/conversations` | Inbox (Train AI settings join when #388 lands) | Conversation AI thread |
| Calendar | **Calendar** | `/staff/schedule` | Calendar · Weekly timetable · Sale days & events (per calendar spec) | calendar thread |
| Calendar | **Attendance** | `/staff/attendance` | Today's roster · Planned absences · Walk-in kiosk · Import class history (old kiosk/ClassPass hidden) | kiosk thread + this thread |
| Contacts | **Contact list** | `/staff/people` | Contacts · Family access · Import students · Import from photos. Search *(hidden, top-bar icon)* | contacts thread |
| Contacts | **Staff** | `/staff/team/invitations` | Team · Roles · Availability · Qualifications · Documents | this thread |
| Lead | **Lead pipeline** | `/staff/crm` | Pipeline · Follow-ups · Trials · Lead memberships · Import leads (Enroll a lead / Journey hidden after the board lands) | pipeline thread |
| Lead | **Automations** | `/staff/automation/rules` | Rules (AU-1 builder joins later) | AU thread |
| Communication | **Texts & email** | `/staff/family-messages` | Family messages (SMS blasts and email join here) | this thread |
| Communication | **Facebook & Instagram** | `/staff/marketing/social` | Social inbox and accounts | social thread |
| Finance | **Checkout Pages** | `/staff/billing/checkout-pages` | (inside the page) | tuition thread |
| Finance | **Point of Sale** | `/staff/billing/pos` | Register · History · Inventory (inside the page) | POS thread (added when it merges) |
| Finance | **Shopify** | none yet | **Not built.** HON has no Shopify code today; only the product plan mentions Shopify sync. Needs an owner go-ahead (paid/external service). | open decision |
| Finance | **Invoices** | `/staff/billing/invoices` | Invoices · Tuition balances | tuition thread |
| Marketing | **Website** | `/staff/marketing/website` | Website · Lead forms · Lead intake | this thread |
| Marketing | **Marketing** | `/staff/marketing` | Overview · Campaigns · Champions Club | this thread |
| Marketing | **Creative Studio** | `/staff/creative-studio` | (inside the page) | creative thread |
| Ranks | **Rank setup** | `/staff/curriculum/library` | Curriculum library · Progress · Teaching studio · Achievements | this thread |
| Ranks | **Tests** | `/staff/testing/readiness` | Numbered steps, not tabs: 1 Who is ready · 2 Sign-ups · 3 Register · 4 Grade · 5 Scorecards · 6 Certificates (see L3) | this thread |
| Ranks | **Mass rank promotion** | `/staff/testing/promotion-decisions` | Pick students, one decision for all (one student at a time below it) | this thread |
| Business | **Membership** | `/staff/billing/membership-plans` | Plans · Memberships · Dates & history · Renewals · Import (Activation and Changes hidden once #399 lands) | membership thread |
| Business | **Agreement** | none yet | Agreement & waiver page arrives with the membership thread's slice E | membership thread |
| Business | **Reports** | `/staff/reports` | Reports · Operations · Health score · Revenue planning · Retention review | this thread |
| Community | **Community** | `/community` | Owner community · Marketplace | community thread |
| (bottom) | **Settings** | `/staff/settings` | Summary · Location · Branding · Booking types · Texting number · Payment processors · Saved payment methods · Language · Texts from HON · Account · Owners · Subscription · Help | this thread |

Onboarding pages (Welcome, School launch, Founder Setup) stay hidden under Dashboard, reached from its setup card and
Settings, as today.

### How the three views show it (presentation only, same links)

- **Classic**: left sidebar like the CRM: small heading, then its pages with icons. Settings at the bottom.
- **Modern**: the top bar shows the everyday pages (Dashboard, Conversation AI, Calendar, Attendance, Contact list,
  Lead pipeline); **More** opens the Menu panel with every heading and its pages.
- **Big Button**: no bar; the Menu panel shows one big card per page, under the eleven headings.
- **Phone bottom bar**: Dashboard, Contact list, Lead pipeline, Calendar, More.
- Inside any page the tab row shows only that page's tabs. The extra "groups" row is removed.
- The guided tour walks the eleven headings and Settings.

## 3. Rules for every thread

1. **Do not add a new heading or a third level.** Add your page as a tab of the page in the table above, or ask this
   thread to add a page.
2. **No more than about five tabs per page.** If a workflow needs more steps, put them on one page as steps (see Belt
   Tests follow-up below), not as more tabs.
3. **Open on the useful thing**: number cards, then the list/board, one primary button top right. No explanation walls,
   no ID boxes, no "what this page never does" text (see `SCHOOL_APP_UI_CLEANUP_SPEC.md`).
4. **Actions on a person go on the contact card** (membership, billing, attendance history, tags).
5. **Keep the three views.** Never style a page for one view only; the shell decides layout.
6. Page names in the menu use the job name from the table, in en/ko/es.

## 4. Slices this thread builds

- **L1 Menu (this PR)**: catalog becomes headings → pages → tabs with David's eleven headings; frame renders the
  sidebar headings, the Modern top-bar set, the Big Button card grid and the phone bar; groups row removed; copy in
  en/ko/es; tour steps follow the headings. Frontend only, no migration, no API change, every existing route still
  listed or hidden-with-a-link (a test checks each hidden route is linked from the app).
- **L2 Dashboard**: opens like the CRM dashboard: number cards (active students, monthly revenue, upcoming payments,
  new members, renewals, trial bookings) from existing reads, Quick Add button, newest contacts, today's classes.
- **L3 Tests as one page**: registrations → readiness → scorecards → certificates as steps on one page; Mass rank promotion
  promotes a picked group of students in one action.
- **L4 Texts & email and Settings tidy**: one composer (SMS / email) at the top of Texts & email; Settings tabs in a wrapped row.
- **L5 Staff**: one Staff list with role, availability and qualifications on a slide-out card.

### L3 spec: Tests as one page, and Mass rank promotion

**Tests.** A belt test is one job done in order, so the Tests page shows its routes as numbered steps instead of tabs:
1 Who is ready (`/staff/testing/readiness`) · 2 Sign-ups (`/staff/testing/registrations`) · 3 Register
(`/staff/testing/candidates/register`) · 4 Grade (`/staff/testing/candidates/grade`) · 5 Scorecards · 6 Certificates.
The page opens at step 1. The catalog marks the page `steps: true`; the shell draws the same links as an ordered step
row ("Step 2 of 6", current step marked) in all three views, and the Register and Grade pages (unlisted until now) join
the page so "where am I" names Tests. Steps are exempt from the five-tab rule. Deciding the promotion is the next page,
Mass rank promotion.

**Mass rank promotion.** Opens on the list of graded students waiting for a decision (the existing candidate picker read,
`for=decision`, up to 50 rows), each with a checkbox, plus "Pick everyone who passed". One decision (default Promoted)
and one reason apply to all picked students. After a confirm box, one button records the decision for each picked student.
Under the hood it is the existing per-student command, sent one after another, each with its own idempotency key and the
version the list returned; nothing new on the server, no migration. Each row then shows Recorded, Already recorded,
Not recorded (rejected, for example the test changed), or Not sure (network/unknown), and only a Not sure row offers an
exact retry of its own unchanged command. A lost session or permission stops the run at once and clears the picks and
reason. Changing picks, decision or reason clears the confirm. The existing one-student form stays below the list for a
student who needs a different decision. Without a verified school the page shows only the one-student form, as today.
Only an instructor decides: HON and the AI team never promote.

Each slice: spec section here, tests first, independent review, standing merge rule.
