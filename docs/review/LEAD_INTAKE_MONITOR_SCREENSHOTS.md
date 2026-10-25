# Lead Sources & Intake Monitor — Review Screenshots

## Idle-state captures

These captures were rendered from the actual isolated monitor component in a temporary local-only review route, then the route was removed before staging. They show the genuine **idle** state: no protected intake read was initiated, no form configuration or contact data was available, no provider was connected, and no AI, automation, communication, advertising, billing, or payment effect occurred.

- [Desktop idle capture](./lead-intake-monitor-desktop-idle.png) — full page: 1440 × 1455 (viewport: 1440 × 1050)
- [Mobile idle capture](./lead-intake-monitor-mobile-idle.png) — full page: 390 × 2931 (viewport: 390 × 844)

## Loaded-state captures

For these local verification captures only, a temporary review route issued a signed test web session, passed the existing staff web-session gate, and returned a hardcoded **closed monitor projection** containing two safe fixture forms. The temporary route, session material, and test endpoint were removed before staging. These are not customer/school records, do not demonstrate a live provider connection, and do not replace the real API’s separate current-school authorization and loopback test evidence.

- **Desktop** (viewport: 1440 × 1050): [Modern HON](./lead-intake-monitor-loaded-modern-desktop.png) — full page 1440 × 1840; [Classic CRM](./lead-intake-monitor-loaded-classic-desktop.png) — full page 1440 × 1699; [Big-Button / Phone](./lead-intake-monitor-loaded-big-button-desktop.png) — full page 1440 × 2865.
- **Mobile** (viewport: 390 × 844): [Modern HON](./lead-intake-monitor-loaded-modern-mobile.png) — full page 390 × 3546; [Classic CRM](./lead-intake-monitor-loaded-classic-mobile.png) — full page 390 × 3248; [Big-Button / Phone](./lead-intake-monitor-loaded-big-button-mobile.png) — full page 390 × 3658.

Browser inspection confirmed one `main`, one `h1`, named settings/staff navigation and named sections, no dialog/modal or horizontal overflow, keyboard-native presentation controls with exclusive `aria-pressed` state, and no additional monitor read when a presentation control changes. The production route remains `/staff/marketing/intake` behind the verified web-session gate. Review captures demonstrate layout/readability only; API/transport tests remain the evidence for current-school authorization and the minimal response boundary.
