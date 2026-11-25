# A2P step 2: privacy policy and terms pages on school websites

Gap report: `/mnt/project-files/a2p-ghl/A2P_GHL_GAP_REPORT.md` (step 2).

## Why
Before carriers approve a school's texting (A2P 10DLC), they review its website. They reject a registration when the
privacy policy is missing or implies mobile numbers may be shared (error 30932), or when the consent disclosures
(frequency, rates, STOP/HELP) are missing (30924). School websites (0361) had no privacy policy or terms page.

## What
- Every published school site has `/sites/<address>/privacy` and `/sites/<address>/terms`. There is nothing for the
  owner to set up. Every site page footer links to both.
- The wording comes from `buildSchoolSitePolicy` (`packages/contracts/src/school-site-policies.ts`). It uses the school
  name and the first CONTACT block on the published site, read with the renderer's rules (`findSiteContact`), so the
  policy always shows the same phone and email as the page.
- The privacy policy includes the carrier sentence: "We do not sell or share your mobile phone number or your text
  message consent with third parties or affiliates for marketing or promotional purposes". It also covers frequency,
  rates, STOP and HELP. The terms include a texting program section: consent is not a condition of any purchase, and
  carriers are not liable for delayed or undelivered messages.
- In the website editor, a card says the pages are added automatically and links to them once the site is live. It
  warns when no Contact section has an email or phone number. The card is in English, Korean and Spanish.
- `privacy` and `terms` are built-in page addresses. `applyWebsiteEdit` addPage and the create and save draft inputs
  refuse them. **This is enforced in contracts (API input) only, not in the 0361 database rule**, so no migration is
  needed. A site published earlier with such a page still reads, and the built-in page takes its address (the Next
  static route wins).

## Not in this piece
- Owner-editable policy text, legal-name fields (these come with the A2P registration facts in #382), translations of
  the public pages, and the lead-form consent box (the intake-consent thread owns that).
- No message is sent, no provider or AI is called, and nothing changes in billing or the database.
