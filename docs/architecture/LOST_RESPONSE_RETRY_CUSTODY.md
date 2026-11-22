# Lost-response retry custody for adding a lead and parent booking

Source: launch-readiness review pinned to main `0d476427`, P2 finding [16] (CRM and native lost-response retry custody). Owner instruction (David, 2026-11-22): fix the review's findings before more features. No migration, no API change.

## Problem (verified on main `99643bb1`)

- **Web, add a lead** (`apps/web/src/components/leads/add-lead.tsx`). The prepared lead-create request and its Idempotency-Key lived in a ref inside `AddLead`, and unmounting cleared it. On the lead pipeline, **Close add** unmounts the form. Setup-stage remounts, a concealed shell and the Leads page shell-phase key do the same. A press whose answer was lost, but whose lead was committed, then reopened as an empty form. Pressing Save again sent a new key and could add the person and lead twice.
- **Parent app, booking** (`apps/parent-mobile/src/schedule/BookClasses.tsx`).
  - The command keys and the pending action lived in the screen.
  - Any family refresh unmounts the screen, because the Schedule tab shows a gate while the family read loads. A refresh after another booking does this, and so does pull to refresh.
  - When the re-read after an unknown answer failed, the screen showed only "not available", which hid the **Try again** control.
  - **Close** dropped the action. The key survived only while the screen stayed mounted.

## Contract

- **RC1** Each lead page owns a `LeadCreateCustody`, above every boundary that can unmount the form: `LeadPipeline` and `Leads`. An unanswered press is held there as an immutable capsule with three parts: the frozen prepared request (path, school, body and key), the name, and the form as typed.
- **RC2** A form mounted while its school holds a capsule opens on that press. It shows it as uncertain and locked, and offers its Retry. Retry resends the capsule exactly, whatever the fields show now.
- **RC3** The capsule clears in these cases:
  - a definite answer clears it, even when the answer arrives after the form closed, and it never clears a newer capsule;
  - **Discard** clears it;
  - the owner clears it on a school change or the end of a session, as it already does for every other retained command.

  A capsule made for another school is never shown or sent.
- **RC4** `FamilyProvider` owns a `BookingCustody`, which holds the command keys and the one unconfirmed action. The provider is keyed by session, so signing out drops it. A remounted booking screen opens on the unconfirmed action, with its same-key **Try again**.
- **RC5** In the parent app, the action card, and a "not confirmed yet" line with **Check again**, render even while the class list is loading or unavailable. **Close** only hides the action. The action settles only in two cases:
  - a confirmed answer: directly, through a same-key replay, or through a re-read that shows it;
  - a definite refusal.

## Proofs

- `apps/web/test/add-lead-custody.test.tsx` runs the real `AddLead` handlers through a hook runner and covers:
  - Close after a lost answer, then reopen: the press is uncertain, and Retry sends the identical request object and key;
  - an answer that arrives after unmount settles the capsule, and a lost one keeps it;
  - a refusal or Discard drops it;
  - another school never sees or sends it;
  - both pages own the custody and clear it.

  Three of its four tests fail against the old `add-lead.tsx`.
- `apps/parent-mobile/test/booking-ui.test.tsx` covers three cases:
  - a failed re-read still shows **Try again**, and the retry uses the same key;
  - a shared family refresh after another booking remounts the screen onto the held action, and the retry uses the same key;
  - **Close**, then **Check again**, then **Try again** uses the same key, and the line disappears once the action is confirmed.

  All three fail against the old `BookClasses.tsx`.

## Not changed

- Server idempotency, the lead-create and booking APIs, and the privacy rules: concealment still hides reads, and a school change or session end still drops retained commands.
- Other forms' retained commands on the pipeline page: close, stage save and template.
