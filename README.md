# NDC Multi-Supplier Flow & Log-Masking Validation (TypeScript + Playwright)

For every supplier in `suppliers.json` the tool does two things.

**Phase 1, the API flow (axios).** It calls
`Search → FareConfirm → AddPassengerDetails → Book` against the NDC API (`NDC_BASE_URL`).
It passes the ids from each response into the next request and records the `CorrelationId` header of every step.

**Phase 2, the log check (Playwright).** It logs in to OpenSearch Dashboards (`DASHBOARDS_URL`) and opens
**Discover** on the configured tenant and index pattern (`DASHBOARDS_TENANT`, `DASHBOARDS_INDEX_PATTERN_ID`). For each id it
searches `attributes.correlationId:"<id>"` and checks that credentials in the logs (`<Username>`, `<Password>`,
tokens, `Authorization` headers, …) appear as `********` and not in plain text. A PASS/FAIL line is printed live
for each supplier and step.

Results go to `reports/<run-id>/`: `report.html`, `report.json`, `run.log`, and screenshots of any step that
errors or finds no logs.

## Setup

Requires Node.js 20.12 or newer.

```powershell
npm install
npm run setup            # = playwright install chromium
copy .env.example .env   # then fill in the values (see below)
```

`.env` is git-ignored. It holds:

| Variable | Purpose |
|---|---|
| `NDC_BASE_URL` | NDC API base URL. |
| `DASHBOARDS_URL`, `DASHBOARDS_TENANT`, `DASHBOARDS_INDEX_PATTERN_ID`, `DASHBOARDS_INDEX` | OpenSearch Dashboards URL, tenant, Discover index pattern id, and the index the full-document fetch queries. `config.json` refers to these as `${NAME}`, so no host names are kept in the repository. |
| `DASHBOARDS_USERNAME` / `DASHBOARDS_PASSWORD` | OpenSearch Dashboards login. **Quote the password**: Node's `.env` parser treats `#` as the start of a comment. |
| `NDC_API_KEY` / `CLIENT_ID` | NDC API auth, sent on every call as `x-api-key` and `Client-Id` (default `NDC-Core`). Without the key every call returns 401. |
| `KNOWN_SECRETS` | Optional, recommended. Comma-separated real supplier credential values. Any literal occurrence in a log fails the check, whatever the field is called. |

## Running

```powershell
npm test                                 # unit tests: scanner + path/template helpers (synthetic data)
npm run typecheck
npm run e2e:dry:headed                   # all 32 suppliers, Search + FareConfirm only, visible browser, opens report
npm run e2e:headed                       # FULL flow incl. Book, visible browser, opens report at the end
npm run e2e                              # full flow, headless (CI)
npm run e2e -- --only "AJet,FlyNas" --stop-after fareConfirm --headed   # subset
npm run e2e -- --validate-at end         # all API flows first, then one Dashboards pass (less waiting)
npm run report                           # open the latest reports/<run-id>/report.html
npm run e2e -- --help
```

| Option | Meaning |
|---|---|
| `--only "A,B"` | run a subset of suppliers |
| `--stop-after <step>` | `search`, `fareConfirm`, `addPassengerDetails` or `book`. Anything before `book` creates no bookings. |
| `--validate-at supplier\|end` | check logs right after each supplier (default) or after all flows |
| `--headed` | show the browser |
| `--open` | open `report.html` when the run finishes |
| `--skip-ui` | API flow only |
| `--save-responses` | write raw requests/responses to `reports/<run>/responses/`. These **may contain PII or leaked secrets**. |

### Output

While the run is going, the console shows each supplier and step as it happens:

```
[1/32] Processing AJet...
   Search                         -> PASS     HTTP 200    1840 ms   CorrelationId: 9e420427-...
   FareConfirm                    -> PASS     HTTP 200     912 ms   CorrelationId: 1b07c3aa-...
   ...
   Masking Check [Search]         -> PASS              log hits 14, unmasked 0
   => AJet: PASS
```

At the end it prints an **executive summary**: totals for PASSED / FAILED / BLOCKED, the masking score, a table with
one row per supplier showing every step plus the masking result, a list of issues, and every `[SECURITY FAIL]`.

**Result per supplier:**
- **PASS:** every API step and every masking check passed.
- **FAIL:** a security assertion failed (an unmasked target field in the logs or an API response).
- **BLOCKED:** no security failure was found, but masking could not be fully verified, because an API step failed or
  the logs could not be checked (not indexed in time, or a browser or query error).

### Reports

Every run writes **one self-contained HTML file**, in two places: `reports/<run-id>/report.html` and an identical
`reports/latest_report.html`, which is always the newest run. All CSS, JavaScript, SVG charts and drill-down data are
inlined, with no external files, fonts or CDNs. You can email or chat the file on its own, and the recipient can
double-click it to get the full interactive dashboard. The only links that leave the file are the
*Open logs in OpenSearch Discover* buttons, which need access to the Dashboards server.

The file has three kinds of views, switched with the header tabs or the *Supplier…* picker. Links are `#` deep links
(e.g. `latest_report.html#sup-AJet-step-search`), and the browser's Back button works.

| View | Contents |
|---|---|
| **Overview** (`#overview`) | Sticky header with a dark/light switch, the run duration, pass rate and masking score. Then a pass-rate donut, the masking-score ring, KPI tiles, the security assertions, and a responsive supplier grid with filter, search and sort that works for 1 to 32+ suppliers. Each card shows its PASS / FAIL / BLOCKED badge, execution time, masking-fail and verified-masked counters, and step chips that jump to the supplier's step. |
| **Time breakdown** (`#time`) | Run time decomposed into **Network / Supplier API Latency**, **OpenSearch Query & Scrape Overhead**, **Masking Scan & Security Rule Engine** and **Framework / Idle Overhead** (waits, session setup, payload rendering, I/O, unattributed gaps). The four always add up to the run time. Includes a cost-breakdown statement, an interactive waterfall, time per supplier, a sortable supplier latency ranking (p50 / p95 / max / slowest step / network share) and latency per step. Click any line, bar or supplier for a timestamped drill-down. |
| **Supplier** (`#sup-<name>`) | Step by step: API status, latency, CorrelationIds, extracted ids, route attempts, masking verdict, KQL, security failures, verified-masked fields, a timestamped time breakdown per step, and an **Open logs in OpenSearch Discover** deep link (tenant, index pattern, time range and query preset). |

The run folder also keeps `report.json` (all data, including the full timeline), `run.log` and `screenshots/`.
Run folders rendered by older versions may still contain `time_breakdown.html` and `suppliers/`. These are no longer
used and can be deleted.

Re-render a saved run, which also upgrades older runs to the current layout:
`npm run report:build` (latest run) or `npm run report:build -- reports/<run-id>/report.json`. At the end of every run
and every re-render, the file opens in your browser and the console prints
`[REPORT READY] View Report: file:///…/reports/latest_report.html`. Use `--no-open`, or set `CI`, to skip opening it.

Argument parsing is forgiving. Trailing `\` or `/` characters and stray arguments, which usually come from a bash `\`
at the end of a PowerShell line, are removed. An unknown flag prints a warning with a suggestion (`--opne` → `--open`) and
is then ignored, instead of crashing. To split a long command over several lines in PowerShell, end each line with a
backtick (`` ` ``), not `\`.

Exit code: `0` = every supplier PASSED; `1` = at least one supplier FAILED or is BLOCKED; `2` = configuration or input error.

## Project structure

```
├── package.json / tsconfig.json
├── config.json            # API base URL, steps/endpoints, id-extraction paths, masking keys, Dashboards settings
├── suppliers.json         # the 32 suppliers: name, API code, routes, per-supplier variables
├── payloads/              # request templates with {{PLACEHOLDERS}}
│   ├── search.json  fareConfirm.json  addPassengerDetails.json  book.json
├── .env / .env.example    # credentials (git-ignored)
└── src/
    ├── e2e_validator.ts   # CLI entry point: orchestrates Phase 1 + 2, live console output, reports
    ├── api_flow.ts        # Phase 1 (axios): chaining, retries, CorrelationId capture
    ├── dashboards_ui.ts   # Phase 2 (Playwright): login, tenant, Discover search, DOM scrape, full-doc fetch
    ├── masking.ts         # LeakScanner - finds unmasked credentials, redacts evidence
    ├── timeline.ts        # run-wide time accounting (network / OpenSearch / masking / idle)
    ├── live.ts            # real-time console output
    ├── cli.ts             # forgiving command-line parsing
    ├── report.ts          # verdicts (PASS / FAIL / BLOCKED), summary, console executive summary
    ├── html/              # single-file report: layout + router, overview, supplier views, time breakdown, timing
    ├── build_report.ts    # npm run report:build - re-render the report from report.json
    ├── open_report.ts     # npm run report - open the latest report.html
    ├── *.test.ts          # npm test - scanner, path/template helpers, CLI
    ├── types.ts / utils.ts
```

## How it works

**Endpoints** (from the API's own OpenAPI spec at `/swagger/index.html`):

| Step | Endpoint | Receives | Produces |
|---|---|---|---|
| Search | `/api/v2/FlightSearch/Search` | route | `searchResponseId`, `selectedOfferId` (first `offers[*].offerId`) |
| FareConfirm | `/api/v2/FlightSearch/FareConfirm` | `searchResponseId`, `selectedOfferId` | `fareConfirmResponseId`, `fareConfirmSelectedOfferId` (`selectedOffer.offerId`) |
| AddPassengerDetails | `/api/v2/Passenger/AddPassengerDetails` | `fareConfirmResponseId`, `fareConfirmSelectedOfferId`, passengers, contact | `passengerResponseId`, `passengerOfferId` (tracking only) |
| Book | `/api/v2/FlightBooking/Book` | `fareConfirmResponseId`, `fareConfirmSelectedOfferId` | - |

At startup the run checks the chain. Every `{{placeholder}}` in a payload must come from `config.json → variables`, the
route, or the `extract` of an earlier step; otherwise the run stops with exit code 2 before any API call.
The contact phone comes from the variables `CONTACT_DIALING_CODE` (`+20`, which must start with `+`) and `CONTACT_PHONE`.

**Suppliers.** Each entry in `suppliers.json` is either a plain name, or an object:

```jsonc
{
  "name": "Air Cairo",                       // display name in console and reports
  "code": "AirCairo",                        // API Supplier enum value, only needed if it differs from name
  "variables": { "CREDENTIALS_SELECTOR": "UAE" },   // per-supplier overrides (Tarco uses UAE)
  "primaryRoute": { "origin": "CAI", "destination": "RUH", "date": "2026-10-20" },
  "fallbackRoutes": [ { "origin": "CAI", "destination": "JED" } ]   // date is optional -> DEPARTURE_DATE
}
```

Valid `code` values are the API's `Supplier` enum (`AirCairo`, `TKConnect`, `ElJazeeraV4`, `FlyDubai`,
`TravelportNdc`, …). Valid credential selectors are `EGY`, `UAE`, `KSA`, `USA`, `UAE2`, `KWI`, `KSA2`,
`EGY2` and `EGY3`.

**Route fallback.** Search first tries the supplier's `primaryRoute`, then its `fallbackRoutes`, then (with
`routes.append_default_fallbacks`) the defaults from `config.json → routes`. Suppliers without a mapping use only
the defaults (CAI-RUH, CAI-JED, CAI-DXB). The next route is tried on HTTP 400/422/500
(`routes.fallback_on_status`) or on a 200 with no usable offer, and the console prints
`[WARN] Primary route failed for <Supplier>, retrying with fallback route...`. Search only FAILs when every route
has failed. Errors that no route can fix stop the loop straight away (`routes.no_fallback_errors`: an unknown supplier
code, or no credentials for the selector). Every attempt has its own CorrelationId, and the logs of all attempts are
checked for masking. Each attempt is listed in the HTML report.

**Chaining.** Templates are filled from `config.json → variables` (`CREDENTIALS_SELECTOR`, `DEPARTURE_DATE`, where
the date can be relative such as `"+30d"`), from the route (`ORIGIN`, `DESTINATION`), from per-supplier
`variables`, and from the ids extracted from earlier steps. If a step fails, the supplier's remaining steps are
marked `SKIPPED` and the next supplier runs. Search and FareConfirm are retried on 502/503/504 and network errors.
AddPassengerDetails and Book are never retried, so a booking can't be created twice.

**Dashboards automation.** The tool:
- logs in through the security-plugin form;
- selects the tenant through `/api/v1/multitenancy/tenant`;
- turns off the *Welcome* and *Select your tenant* overlays with an init script;
- opens `app/data-explorer/discover` with the index pattern;
- **checks that the time picker shows `dashboards.time_range.label`** ("Last 24 hours" by default, or e.g.
  `{ "from": "now-15h", "label": "Last 15 hours" }`). If it doesn't, it sets the range itself, using the
  *Commonly used* shortcut or the *Quick select* form.

For each id it types `attributes.correlationId:"<id>"` into the search bar and submits it, then reads the hit count.
**If that returns 0 hits**, it falls back to **Add filter → `attributes.correlationId` → `is` → `<id>` → Save**
(`is one of` when a step has several ids) and scrapes those results instead. It scrapes the result
table and up to 20 expanded documents. It also fetches the complete matching documents through the same logged-in
session (`/api/console/proxy`), because Discover cuts short the escaped `body` payload where the supplier XML lives.
If the proxy is refused, the run falls back to scraping the page only and says so in the report. Selectors can be
overridden in `config.json → dashboards.selectors`.

**Scanner and strict security assertions.** `masking.ts` walks every log document and the JSON encoded inside it,
including the double-encoded `"response":"\"{...}\""` strings in these logs. It also scans the scraped Discover text
and every API response. A field is a **target** if its name, compared without case, dashes or underscores:
- **equals** an entry in `masking.sensitive_keys`: `username`/`userName`/`User-Name`, `password`/`passWord`/`Pass-Word`,
  `secret`, `client_secret`, `token`, `authToken`, `access_token`, `refresh_token`, `id_token`, `authorization`, `AuthorizedBy`,
  `Nonce`, `apiKey`/`api_key`, `secretKey`/`secret_key`, `x-api-key`, `signature`, `digitalSignature`, `sig`, and the card fields
  `cardNumber`/`card_number`, `cvv`, `cvc`, `expiryDate`, `cardHolder`. Dotted entries (`credentials.username`,
  `credentials.password`, `data.token`) match under that parent; or
- **contains** an entry in `masking.sensitive_key_patterns` (`username`, `password`, `secret`, `token`, `authorization`,
  `apikey`, `signature`), so `agentUserName` and `X-Auth-Token` count too. The exception is when the name also
  contains an entry in `masking.ignore_key_patterns` (metadata such as `tokenType`, `passwordExpiry`, and NDC's
  `EchoToken` message id). Short names like `sig` match exactly only.

**Exceptions** (both in `config.json → masking`):
- `excluded_keys`: never asserted in any step, with no `[SECURITY FAIL]` and no `[VERIFIED MASKED]`. Currently
  `Authorization`, `HostToken`, `HostTokenRef`, `userId` and `HistoricUserName`. Exclusions win over every other rule.
  Excluding `Authorization` also turns off the stand-alone `Basic`/`Bearer` token rule. Literal `KNOWN_SECRETS`
  values, including the run's own `NDC_API_KEY`, are still caught anywhere.
- `step_scoped_keys`: a key is asserted only in the listed steps. Currently `{ "ExpiryDate": ["book"] }`, so offer-expiry
  timestamps in Search, FareConfirm and AddPassengerDetails are ignored, and a card expiry in Book must be masked.

`npm run report:build` re-applies the current exceptions to a saved run. A check that failed only because of a
now-excluded field becomes PASS. The findings as originally captured are kept in `report.original.json`, so
removing an exception later and rebuilding restores them.

Inside a **sensitive container** (`masking.sensitive_containers`: `paymentFields`, `UniversalRecord.card`) *every*
non-empty value must be masked, whatever the inner field is called. This matters for the card data in the Book step.

Target fields are found in structured JSON, JSON/XML text, XML attributes, `key=value` strings and header lines, and
`Basic`/`Bearer` tokens are checked too. **The assertion is strict:** a value passes only if it is all asterisks
(`^\*+$`). Plain text, a partly masked value like `ab****yz`, a JWT or a Basic credential all **fail the step**. Empty or null
values expose nothing and pass. Any `KNOWN_SECRETS` value, and the run's own `NDC_API_KEY`, fails the step wherever it
appears.

Every failure, and every correctly masked occurrence, is reported in the console and in `report.html`:

```
[SECURITY FAIL] Step: Book | Field: Password | Exposed Value: ab****** (10 chars) [plain text]
[VERIFIED MASKED] Step: FareConfirm | Field: Password | Value: *** (x3)
```

Verified occurrences are grouped by field and value, with a count. Amadeus NDC, for example, masks with `***`, which
passes `^\*+$`. To require exactly eight asterisks, set `masking.mask_regex` to `\*{8}`.

The value is always redacted; only its first 2 characters, its length and its type (`plain text`, `JWT`,
`Basic credential`, `GUID / API key`, `partially masked`, …) are shown. In `report.html` the failures appear in a
*Security assertions* section and under each supplier's **Masking** column.

**Verdicts per step:** `PASS` · `FAIL` (unmasked value found) · `NO_LOGS` (nothing indexed within the poll
window) · `ERROR` (browser or query failure, with a screenshot) · `NO_CORRELATION_ID`.

## Before the first full run
- `.env` needs `NDC_API_KEY` (and `CLIENT_ID`, default `NDC-Core`).
- The route mappings in `suppliers.json` are starting points based on each airline's hub. Adjust them to what each
  supplier's staging credentials actually sell.
- `DEPARTURE_DATE` (and the dated Air Cairo / Tarco routes) are fixed at `2026-10-20`. Switch them to something like
  `"+30d"` so the dates never fall in the past.
- A full run (`book`) creates real staging bookings for every supplier. Use `--stop-after addPassengerDetails` until
  you are ready for that.
