# Staff presentation ownership (launch-readiness review [20])

Language and appearance are presentation only, but their reads and saves still belong to one signed-in person and,
where they depend on it, one verified school. This note records who owns each answer.

## Session generation

`session-invalidation.ts` counts confirmed session ends on the page (`reportConfirmedSessionInvalidation`). The
language transport (`localization/http.ts`) remembers the generation a request was sent in. A 401 reports a session
end only when:

- the request was sent in the current generation (an answer from before a session end never ends the replacement session),
- its read was not aborted, and
- its owner still holds it (`owned()`; the provider passes its epoch check).

A retired request's 401 still rejects as `DENIED` for its caller; it just never signals the page.

## Language provider

`LocaleProvider` owns every read and command with one epoch. A newer read, a command, or a session end retires older
work. On a session end the provider drops the remote view, any held command (the unknown-outcome retry), the school
claims and every answer still out. A late receipt from before the session end is not applied and starts no follow-up
read. A scope change or unmount retires the same way: it clears the busy flag and any held command, so the new scope
reads at once and accepts a new command instead of staying blocked on a save it no longer owns.

School-language precedence follows the verified school:

- the school shell claims its verified selection with `claimShellSchool(schoolId)` and releases it (null) when the school
  is concealed, changes or the shell unmounts;
- a page that verified a school itself may still use `setSchoolContext(schoolId)`; the newest page claim wins, and
  releasing it returns to the shell's school instead of clearing precedence;
- a change that arrives during a language save is applied when the save finishes.

The claim is only which school's default the server is asked to include; the server still authorizes the read.

## Appearance

`school-shell/appearance-owner.ts` owns the shell's interface-theme reads and saves. Each read or save is valid only
while it is the newest one and its school is still the one selected. A concealment (session end or school change)
retires all of them and resets the view state to local, so a late answer can never set the mode or claim `SAVED` for a
person or school no longer on screen.

Tests: `apps/web/test/presentation-ownership.test.tsx`.
