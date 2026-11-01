# Phase 2 Zernio Source Record

This source list supports feasibility research only. It is **not** authorization to connect Zernio, Meta, Facebook, Instagram, Google Ads, a webhook, OAuth account, provider credential, provider sandbox, message channel, or advertising account.

| Official source | Assessment use |
| --- | --- |
| [Zernio Meta Lead Forms](https://docs.zernio.com/platforms/meta-ads/lead-forms) | Vendor-documented Meta lead-form behavior and delivery surface. |
| [Zernio Ads Webhooks](https://docs.zernio.com/webhooks/ads) | Vendor-documented lead event and ad/account context. |
| [Zernio Webhooks](https://docs.zernio.com/webhooks) | Signature, event-ID, acknowledgement, retry, and dead-letter design inputs. |
| [Zernio Meta Ads connection](https://docs.zernio.com/platforms/meta-ads/connect) | OAuth/connection, Page selection, account binding, and reconnection design inputs. |
| [Zernio account health](https://docs.zernio.com/accounts/get-all-accounts-health) | A future server-side reconciliation input only; never browser-facing provider-health evidence. |
| [Zernio error handling](https://docs.zernio.com/guides/error-handling) | Stable-code handling, retry/reconnect, and unknown-outcome design inputs. |
| [Zernio full official documentation corpus](https://docs.zernio.com/llms-full.txt) | Corroborating documentation corpus used for the assessment; the live document notes `/v1` versioning and provider error-code handling. |

## Interpretation limit

The material establishes documented vendor capability only. It does not establish a working HON implementation, connected provider account, valid Page/form mapping, valid webhook signature, account health, consent, lead delivery, CRM creation, enrollment, payment, revenue, ROI, or customer communication. HON must not use provider documentation as a substitute for its own tenant-scoped authorization, human confirmation, audit/outbox, idempotency, RLS, data minimization, or reconciliation controls.
