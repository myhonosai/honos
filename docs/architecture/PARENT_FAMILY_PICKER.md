# Parent school and family picker (0456)

The owner asked on 2026-11-17 that parents linked to more than one family choose which one to view and switch without signing out. This covers a parent with children at two schools, including schools of different HON customers, and a parent in two households at one school.

## Before

Every parent read and command required exactly one live family grant:

- `hon.resolve_parent_journey_scopes` (0087) returned at most two scopes, and every caller refused anything but one.
- `hon.parent_class_booking_scope` (0329, 0330) and `hon.face_checkin_family_scope` (0443) counted grants themselves.

A parent with two families was refused everywhere. Family invitations (0205) also refused a parent who already had a family at another organization.

Children within one family were already switchable inside Student Journey, and that is unchanged.

## Rules

- **F1 Choices.** The parent's live family scopes are listed: one active HUMAN_USER principal, a live grant, and an ACTIVE family, school and organization (0071 `resolve_parent_family_scope` over every school with a live grant). There are at most 20. The browser only names one of them.
- **F2 The choice.** It is stored per sign-in user in `hon.parent_family_selections`, a private table with forced RLS and no runtime privilege. `resolve_parent_journey_scopes` behaves as follows:
  - With several live scopes and a live choice, it returns the chosen one.
  - With one live scope, it returns that one, as before.
  - With several live scopes and no live choice, it still returns two, so everything refuses as before until the parent chooses.
- **F3 One rule everywhere.** The booking and message scope and the face check-in scope take the one resolved scope. Their other checks are unchanged:
  - the API tenant must match;
  - the school, organization and entitlement must be live;
  - only a guardian may write.

  Each command still checks the scope again after its locks and writes. If a switch happens in another tab mid-command, that command refuses and rolls back.
- **F4 Invitations.** A parent may hold families at more than one organization. These are still refused:
  - the same family twice;
  - staff and HQ accounts;
  - accounts with more than one principal.
- **F5 Evidence.** A change of choice writes one audit event at the chosen school, naming only the chosen family. An earlier choice may belong to another organization, so it is never named. There is no outbox event, message, charge or AI.

## API

- `GET /v1/parent/families` returns `{ data: { choices: [{ schoolId, schoolName, familyId, familyName, accessLevel, current }], needsChoice } }`.
- `POST /v1/parent/families/current` takes the body `{ schoolId, familyId }` and the command `parent.family.select` (same-origin browser command). It returns the same shape, with the chosen family current. The answers are:
  - 404 `PARENT_FAMILY_NOT_AVAILABLE` when the family is not a live choice;
  - 403 for the wrong identity or settings;
  - 400 `VALIDATION_FAILED` when the body is not closed.

Contracts are in `packages/contracts/src/parent-family-picker.ts`.

## Web

Parent Home loads the list first.

- With several families and none chosen, it shows the chooser and opens nothing else.
- Once a family is chosen, a "Viewing" bar with a switcher sits above the cards.
- A single family shows nothing new.

## Proof

`packages/database/scripts/test-parent-family-picker-integrity.mjs` runs over signed HTTP on the CRM-close fixture.
