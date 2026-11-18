# Contacts on one page: list + slide-out contact card

Owner request (David, 2026-11-16 06:00Z, screenshots of the Contacts tab row Search · People · Family access ·
Conversations · Family messages): "These sections should [be] under one by making contacts list with contact card
slider. Contact card has option to keep it side or full screen."

Builds on: contacts list C1 (#383, 0373), contact card C2 (#384, 0374), delete/restore/merge C3 (#390, 0387),
memberships on the card (#399, 0398/0399, `card-link.ts`, `membershipSlot`), conversations inbox (#387, 0364),
family messages (0330), family access invitations. One shared card component: `people/contact-card.tsx`.

## Objective

A school staff member works with contacts from one page. The list is always the starting point; clicking a contact
opens that person's card in a panel that slides in from the right. The card holds everything about the person,
including their texts, their family's messages and their family's app access. Nothing about the person needs a
separate page.

## What the person sees

1. **Contacts tab row.** Search, Family access, Conversations and Family messages leave the Contacts tab row and the
   menu. Their routes stay (hidden, as `h()` entries) so old links and bookmarks still work. People stays and is the
   Contacts home. The other Contacts pages (achievements, retention, imports, staff pages) are unchanged.
2. **Inboxes stay reachable.** The People header has two links: "Texts inbox" (`/staff/conversations`) and "Family
   messages inbox" (`/staff/family-messages`), for working through unanswered messages across all contacts. No counts
   are read for these links (no extra reads).
3. **Slide-out card.** Clicking a contact opens the card panel.
   - **Side** (default on wide screens): the panel docks on the right, the list stays visible and usable beside it;
     clicking another contact swaps the card.
   - **Full screen**: the panel fills the page content area and the list is hidden behind it.
   - Buttons in the card header: "Full screen" / "Keep at side" (toggle) and "Close". Escape closes the card.
   - The choice is remembered in this browser only (`localStorage`, wrapped in try/catch; a failure means Side).
   - Below 900px wide the card is always full screen and the toggle is hidden.
   - The open person and tab are in the URL (`?person=&tab=`, from #399's `card-link.ts`), updated with
     `history.replaceState`, so a reload or shared link reopens the same card. Closing removes them.
4. **Card tabs.** Overview · Details · Family · Messages · Membership · Billing · Appointments · Tasks · Timeline.
   - **Details** (new): the existing edit form (name, email, phone), contact consents, child's birth date, and
     Delete / Restore / Merge. These were below the card; they move inside it. Behaviour is unchanged, including
     "Try again", the save lock, and the merge opening the kept person with its notice above the tabs.
   - **Family**: members as today, then a **Family app access** section per family: the invitations for that family
     with Revoke / End, and an Invite form (email, access level, hours), using the existing family-access controller
     and endpoints with the shell's verified school and the family fixed by the card. No typed IDs.
   - **Messages**: two sections.
     - **Texts**: this person's conversations (slice B), each opening inline with history, mark read and reply
       (same consent and sender rules as the inbox). Before slice B: the counts plus a link to the Texts inbox.
     - **Family messages**: the family threads of this person's families, opened inline with history, mark read and
       reply (the 0330 rules).
   - Membership, billing, appointments, tasks, timeline unchanged.

## Data and security boundary

- No new permission and no new grant. Every read and command goes through the existing endpoints, which check the
  verified school and the caller's permission (`conversation.read/manage`, `family_messages.manage`, family access
  manager check). The UI never decides permission; a denied section says "not available for your role".
- The person/family ids used by the card come from the server's card read, never typed.
- Family messages: the school inbox read (max 200 threads, `FAMILY_MESSAGE_LIMITS.inbox`) is filtered in the browser
  to the card's family ids. Threads of other families are never rendered.
- Slice B, migration **0401**: `hon.read_school_conversations` accepts an optional `personId` (uuid) filter, ANDed
  with the existing filters, same caller check. The API controller accepts `personId` on the list query; the
  contract validates it as a lowercase UUID. The card asks for `status: 'ALL'` explicitly; the function's default
  (OPEN) is unchanged.
- Privacy: the panel lives inside the People view's `data-shell-private` node, so blur / hidden tab / school change /
  session end conceal it exactly as today, and the embedded sections retire their reads on those events.

## Not in scope

- No change to who may see what, no AI, no sending changes (texts still go through the 0243 worker after consent,
  quiet hours and sender checks).
- No change to the staff Search API; class/program/curriculum search remains at `/staff/search` (hidden route).
- Lead pipeline board links (other thread) use `/staff/people?person=&tab=`.

## Slices

- **A (frontend only, stacked on #399):** panel with Side/Full/Close + remembered mode + URL; Details tab; Family app
  access section; Family messages section; Texts counts + inbox link; menu/tab change; inbox links; en/ko/es copy.
- **B (0401 + API + frontend, stacked on A):** `personId` filter; Texts section inline with reply.

## Tests

- `people-card-panel-ui.test.tsx`: opening a contact shows the panel in Side mode; toggle to Full hides the list and is
  remembered; storage throwing falls back to Side; Close and Escape close it and clear `?person`; narrow screen forces
  Full; another contact swaps the card.
- Details tab holds the edit form, consents, birth date and actions; save/try-again and merge-opens-kept-person still
  work (existing people tests moved to open the Details tab).
- Family messages section shows only the card's families' threads; reply sends with the thread's newest message id.
- Family access section lists only that family's invitations; invite sends the fixed family id.
- Catalog test: Search, Family access, Conversations and Family messages are hidden routes still owned by Contacts.
- Slice B: contract rejects a non-UUID `personId`; API passes it through; DB proof: filter returns only that person's
  conversations and still refuses a caller without `conversation.read`.
