# School app: one consistent look and plain wording (spec)

Owner request (David, 2026-11-19): "there is lot that is miss match in aesthetics", with 14 screenshots of the school
app. This spec covers the look and the wording of school app pages only. It does not change any page's structure,
data, API, permission or behaviour.

Other threads are rebuilding these screens and own their structure: Texts & email (and the texting inbox), Invoices,
Automation, lead pipeline stages, Commerce (Shopify). This work touches them only through the shared styles below.

## 1. Audit (main 1bbd6c8)

The shell (menu, top bar, school strip, tabs) is dark. Pages under it come in three looks:

| Look | How it is drawn | Pages (of 114 under `/staff`) |
| --- | --- | --- |
| Dark, on the design tokens | `--hon-*` tokens | ~37 (Home, Leads board, Contacts, Calendar, Commerce, Reports, AI team ...) |
| Light card | Hard-coded light colours. The shell spots the dark heading and paints a light rounded card behind the page (`data-canvas="legacy-light"`) | ~45 (Staff tabs, Follow-ups, Trials, Lead memberships, Attendance, Ranks and testing, Billing renewals, Automation, Invoices, Settings ...) |
| Teal dark | A copied stylesheet with its own teal palette (`#102033`, `#8cddd3` buttons) | ~10 (Import leads, Documents, Search, Revenue planning, Health score, Command center ...) |

Mismatches seen in the screenshots:

- A light card inside the dark shell on most pages, while the Leads board and Commerce are dark.
- Three title sizes: around 46px on light pages, 30px on the pipeline, 24px on Leads, with a spaced-out area label
  above the light ones ("S t a f f", "L e a d s") that repeats the menu.
- Form controls drawn three ways. On Conversations a dark browser-default select and search box sit inside a white card.
- Two button colours for the same job (blue `#245ac4` vs teal `#8cddd3`), and pages where every button is primary.
- A page-level "Presentation: Modern" selector on Lead memberships that duplicates the shell's view setting.
- Technical wording on screen: "Lifecycle ACTIVE does not establish current effective dates ... another authorized
  read", "Saved CRM memberships", "minimal lookup", "separately authorized details", "Load authorized school rules",
  "Expected version 0. Authority: NONE. Approval: HUMAN_REVIEW_REQUIRED", "inert MANUAL_REVIEW_TEMPLATE", "Minimum
  aggregate version", "server-owned", "audit attribution", "Create one DRAFT invoice", "Enter record IDs instead".

## 2. One look

Every school page uses the dark token look of the shell (owner direction 2026-11-06: dark premium dashboard). There is
no light card.

| Part | Rule |
| --- | --- |
| Page background | None. The page sits on the shell background. Content width `--hon-content-max`, centred. |
| Page title | One `h1`, display font, `--hon-text-2xl`, weight 800, `--hon-text`. No area label above it (the menu and tabs already say where you are). |
| Page description | One sentence under the title, `--hon-text-muted`, `--hon-text-md`, at most about 70 characters per line. |
| Note | At most one short line per page, `--hon-info-soft` background, `--hon-info` left edge, normal weight. |
| Panel (section, form card) | `--hon-surface`, 1px `--hon-border`, `--hon-radius-md`, padding `--hon-space-5`. Panel title `h2` at `--hon-text-lg`. |
| Inner group (row, filter bar) | `--hon-surface-2`, `--hon-radius-sm`. |
| Field | Label above, `--hon-text-sm` weight 600, `--hon-text-muted`. Control `--hon-control-h` tall, `--hon-surface-solid`, `--hon-border-strong`, `--hon-text`, `color-scheme: dark`. |
| Primary button | `--hon-accent` fill, white text. One per panel for the main action. |
| Secondary button | Transparent, `--hon-border-strong` outline, `--hon-text`. Refresh, Cancel, Back, Remove. |
| Links | `--hon-accent-2`. |
| Tables | Header `--hon-text-subtle` small caps-free, rows split by `--hon-border`. |
| Status colours | Success, warning, danger, info use the `*-soft` background and the matching token text. |
| Focus | `--hon-focus` ring. |

Modern, Classic and Big Button keep working: they change token values (sizes, density, radius), never colours.

## 3. Plain wording

1. Write what the person can do or will see, in the school's words: lead, student, family, membership, class, invoice.
2. Never show code names or states in capitals: no `ACTIVE`, `DRAFT`, `HUMAN_REVIEW_REQUIRED`, `NORMAL`, `v1`.
   Show "Active", "Draft", "Needs your OK", "Normal".
3. Never explain the system's internals: no "authorized read", "server-owned", "audit attribution", "lifecycle",
   "aggregate version", "allowlisted", "inert", "minimal lookup", "record IDs", "UUID", "canonical".
4. Buttons say the action: "Show rules", not "Load authorized school rules".
5. One note per page at most, and only when it changes what the person would do.
6. Area names in titles match the menu: "Memberships", not "Saved CRM memberships".

A test keeps the banned words in rule 3 and capitalised codes in rule 2 out of the visible copy of school pages this
work has cleaned.

## 4. How it is built

The shell already marks older light pages with `data-canvas="legacy-light"`. Instead of painting a light card, the
shell will recolour those pages with the tokens (a "dark adapter" in `shell.module.css`): page text, titles, panels,
notes, fields, buttons and links. This gives every older page the one look at once without touching its file.
Measuring a page is done with the adapter switched off for that moment, so the shell does not flip between the two.

Then each area moves its own stylesheet onto the tokens, and the adapter shrinks as areas finish. The teal pages are
moved onto the tokens directly.

Out of scope: page structure, new features, the five screens other threads are rebuilding (beyond the shared styles),
HQ pages, the parent app, the public site.

## 5. Acceptance

- No school page shows a light card; screenshots of each slice at desktop 1440 and phone 390.
- Titles, notes, panels, fields and buttons match section 2 on every changed page.
- The wording test passes for every cleaned page.
- `pnpm --filter web test`, `check` and `build` pass.

## 6. Plan (small PRs, in order)

| Slice | What | Files |
| --- | --- | --- |
| C1 | Dark adapter replaces the light card; title, note, panel, field and button rules for every older page; shell measures with the adapter off | `school-shell/shell.module.css`, `school-shell/shell.tsx`, tests |
| C2 | Teal pages onto the tokens (Import leads, Documents, Search, Revenue planning, Health score, Command center, Roles) | their stylesheets |
| C3 | Wording pass with the wording test: Lead memberships (and its page-level Presentation selector), Staff tabs, Follow-ups, Trials, Train AI intro, ID fallback label | page copy only |
| C4+ | One area per PR moves its stylesheet onto the tokens (Staff, Leads tabs, Attendance, Ranks and testing, Billing, Settings) and drops out of the adapter | per area |

Screens owned by other threads (Texts & email, Invoices, Automation, pipeline stages, Commerce) get C1 only; their
wording and structure stay with those threads.
