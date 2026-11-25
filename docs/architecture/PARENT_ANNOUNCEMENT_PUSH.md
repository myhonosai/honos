# Parent announcement push (0601)

Status: built, **off by default**, not deployed. Owner request (2026-11-20): when staff post an announcement in the CRM,
families get a phone notification and it still shows on Home.

## What happens

1. **Sign-in.** After a family member signs in to the HON Family app, the app first asks the server whether it sends
   notifications at all (`GET /v1/parent/push-devices/status`, `{ sending }`, the same owner switch the sender uses). Only
   then does it ask for notification permission once and register the phone's Expo push token: `POST /v1/parent/push-devices` with `{ expoPushToken, platform }`. The server
   decides the person and school from the verified session (the 0576/0329 parent scope: exactly one live family grant,
   active principal, organization, school and entitlement). No school, family or child id is sent. Saying no to
   notifications changes nothing else in the app. The made-up sample family never registers.
2. **Post.** Staff post an announcement exactly as before (0576). Posting writes nothing new.
3. **Fan out (worker).** The communication worker (`hon_communication_worker`) claims work. Each PUBLISHED announcement
   under 24 hours old is fanned out **once** to every live phone at its school whose person is still live there.
4. **Send (worker).** Just before sending, each delivery is checked again: announcement still PUBLISHED and under 24
   hours old, phone still registered, person still live. Otherwise it is SKIPPED (`WITHDRAWN`, `STALE`,
   `DEVICE_REVOKED`, `NOT_LIVE`). The notification is the **school's name** as title and the **announcement title** as
   text, with data `{ type: 'school_announcement', announcementId }`. Never the body, a child's name or a family.
5. **Tap.** Opens the app's Home tab and reads again, so the family sees the live list (a taken-down announcement is gone).
6. **Sign out.** The app lets the phone go (`POST /v1/parent/push-devices/unregister`) before deleting the session. It
   waits at most 3 seconds; if the server cannot be reached the phone row stays until Expo reports it gone or someone
   else signs in on the phone.

## Rules (DB-enforced)

- One live owner per token. The same phone signed in by someone else moves to them (`REPLACED`). This is deliberate
  for shared family phones; it also means anyone who knows a token and has their own live family grant can move it to
  themselves, which only stops the earlier person's notifications on that phone (it reveals nothing and sends nothing).
  Expo tokens are not shown anywhere in HON. At most 10 live
  phones per person; the least recently seen is let go (`DEVICE_LIMIT`). Expo's `DeviceNotRegistered` lets the phone go.
- Deliveries move forward only: `QUEUED -> SENDING|SKIPPED`, `SENDING -> SENT|FAILED|UNKNOWN|QUEUED`,
  `SENT -> CHECKING|UNKNOWN`, `CHECKING -> DELIVERED|FAILED|SENT|UNKNOWN`. Nothing is deleted.
- **Never sent twice.** A send whose answer is lost (timeout, crashed worker, expired lease) is `UNKNOWN` and is never
  resent. Only Expo's definite refusal (HTTP 429 or `MessageRateExceeded`) is retried, at most 3 attempts; after a
  refusal the worker claims nothing for 60 seconds, so the attempts are spread out.
- Receipts are read after 15 minutes (`DELIVERED` = Expo handed it to Apple or Google). No receipt within 24 hours is
  `UNKNOWN`.
- Tokens never enter audit rows or outbox payloads. The runtime may run only the two parent commands; the worker may run
  only its four functions; three private forced-RLS tables (`parent_push_devices`, `parent_push_fanouts`,
  `parent_push_deliveries`) with no table grants.

## Switches (all off by default)

| Setting | Effect |
| --- | --- |
| `HON_PARENT_PUSH_APPROVED=true` | The only switch that lets the API send. Without it the worker does not even claim, so nothing is fanned out or skipped. Needs the owner's approval. |
| `HON_COMMUNICATION_WORKER_DATABASE_URL` | The existing worker login (refused if superuser, BYPASSRLS, inheriting, or the runtime login). |
| `HON_PARENT_PUSH_INTERVAL_SECONDS` (10-3600) | Runs the worker loop in the API process. |
| `EXPO_ACCESS_TOKEN` (optional) | Only if Expo's enhanced push security is turned on for the project. |

Expo's push service is free and needs no new account (the app already uses EAS project `f9df2343-...`).

## Owner setup before real sends

- **Android:** the free Firebase project `hon-family-7e83d` has the Android app `com.myhonos.family`; its
  `google-services.json` is in the app (`android.googleServicesFile`; a client config that ships inside every build, not
  a secret). Still owed: its FCM V1 service-account key, which is a secret, never committed, uploaded by the owner to EAS (`eas credentials` -> Android ->
  production -> Google Service Account -> FCM V1). Then a new Android build. Until then Android cannot get a token and
  simply skips registering.
- **iOS:** an APNs key from the Apple Developer account, set up through `eas credentials` (on hold with iOS).
- Approve `HON_PARENT_PUSH_APPROVED=true` on the server.

## Not in this slice

- A per-announcement "sent to N phones" count for staff in the CRM.
- Per-family notification preferences in the app (the phone's own setting is the off switch).
- Other notification types (messages, bookings, billing).


## 0658 update (2026-11-23)

Staff now choose per send: only announcements posted with "Also send as a phone alert" ticked are pushed, and a ticked
staff reply in parent app messages pushes a fixed "new message" alert to that family's phones. See
[PARENT_PUSH_STAFF_CHOICE.md](PARENT_PUSH_STAFF_CHOICE.md).
