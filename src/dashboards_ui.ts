/**
 * Phase 2: Playwright automation of OpenSearch Dashboards 2.19 (security plugin) Discover.
 *
 * For each correlation id it:
 *  1. types `attributes.correlationId:"<id>"` into the Discover search bar and submits it,
 *  2. scrapes the result table + expanded document viewers from the DOM,
 *  3. fetches the complete matching documents through the same logged-in browser session
 *     (Dashboards console proxy) - Discover truncates the multi-KB escaped `body` field,
 *     so DOM text alone can miss credentials deeper in the supplier payload,
 *  4. runs LeakScanner over everything -> PASS / FAIL / NO_LOGS / ERROR.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import * as live from "./live";
import { timeline } from "./timeline";
import type { LeakScanner } from "./masking";
import type { DashboardsConfig, Finding, MaskingEntry, SupplierResult, VerifiedMask } from "./types";
import { log, safeFilename, sleep } from "./utils";

const DEFAULT_SELECTORS = {
  username: '[data-test-subj="user-name"]',
  password: '[data-test-subj="password"]',
  loginSubmit: '[data-test-subj="submit"]',
  queryInput: '[data-test-subj="queryInput"]',
  querySubmit: '[data-test-subj="querySubmitButton"]',
  hits: '[data-test-subj="discoverQueryHits"]',
  noResults: '[data-test-subj="discoverNoResults"]',
  rowExpand: '[data-test-subj="docTableExpandToggleColumn"]',
  docViewer: '[data-test-subj="docViewer"], .euiFlyout',
  results: '[data-test-subj="docTable"], [data-test-subj="discoverTable"], .euiDataGrid, main',
};
type Selectors = typeof DEFAULT_SELECTORS;

// Fallback if the tenant modal still appears: it can sit under the home "welcome" overlay, which
// intercepts pointer clicks, so the confirm button is triggered with dispatchEvent instead of click().
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TENANT_MODAL = '[data-test-subj="tenant-switch-modal"]';
const TENANT_CONFIRM = `${TENANT_MODAL} [data-test-subj="confirm"]`;

export class DashboardsValidator {
  private readonly url: string;
  private readonly sel: Selectors;
  private readonly timeout: number;
  private readonly timeRange: { from: string; label: string };
  private fetchFull: boolean;
  private filterActive = false;
  private timeRangeVerified = false;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private readonly cfg: DashboardsConfig,
    private readonly username: string,
    private readonly password: string,
    private readonly scanner: LeakScanner,
    private readonly outDir: string,
    private readonly headless = true,
  ) {
    this.url = cfg.url.replace(/\/?$/, "/");
    this.sel = { ...DEFAULT_SELECTORS, ...(cfg.selectors as Partial<Selectors>) };
    this.timeout = cfg.timeout_ms ?? 60_000;
    this.fetchFull = cfg.fetch_full_documents ?? true;
    this.timeRange = cfg.time_range ?? { from: "now-24h", label: "Last 24 hours" };
  }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    await timeline.time("idle", "session-setup", "browser launch, login, tenant & Discover", {}, () => this.startSession());
  }

  private async startSession(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
    this.context.setDefaultTimeout(this.timeout);
    // Suppress the "Welcome" screen and the "Select your tenant" popup before Dashboards' own scripts run;
    // the tenant itself is selected through the API in login().
    await this.context.addInitScript(() => {
      localStorage.setItem("home:welcome:show", "false");
      sessionStorage.setItem("opendistro::security::tenant::show_popup", "false");
    });
    this.page = await this.context.newPage();
    await this.page.addLocatorHandler(this.page.locator(TENANT_MODAL), async () => {
      await this.page!.locator(TENANT_CONFIRM).dispatchEvent("click");
    });
    await this.login();
    await this.openDiscover();
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }

  private get pg(): Page {
    if (!this.page) throw new Error("DashboardsValidator.start() was not called");
    return this.page;
  }

  private async login(): Promise<void> {
    const page = this.pg;
    log.info(`Dashboards: logging in to ${this.url} as ${this.username}`);
    await page.goto(new URL("app/login", this.url).toString(), { waitUntil: "domcontentloaded" });
    await page.locator(this.sel.username).fill(this.username);
    await page.locator(this.sel.password).fill(this.password);
    await page.locator(this.sel.loginSubmit).click();
    try {
      await page.waitForURL((u) => !u.pathname.startsWith("/app/login"), { timeout: this.timeout });
    } catch {
      throw new Error("Dashboards login failed - check DASHBOARDS_USERNAME / DASHBOARDS_PASSWORD");
    }
    if (this.cfg.tenant) {
      const resp = await this.context!.request.post(new URL("api/v1/multitenancy/tenant", this.url).toString(), {
        headers: { "osd-xsrf": "true" },
        data: { tenant: this.cfg.tenant, username: this.username },
      });
      if (resp.ok()) log.info(`Dashboards: tenant set to ${this.cfg.tenant}`);
      else log.warn(`Dashboards: could not switch to tenant ${this.cfg.tenant} (HTTP ${resp.status()})`);
    }
  }

  private async openDiscover(): Promise<void> {
    let appState = "discover:(columns:!(_source),isDirty:!f,sort:!())";
    if (this.cfg.index_pattern_id) appState += `,metadata:(indexPattern:'${this.cfg.index_pattern_id}',view:discover)`;
    const url = `${new URL("app/data-explorer/discover", this.url)}#?_a=(${appState})`
      + `&_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:${this.timeRange.from},to:now))`
      + "&_q=(filters:!(),query:(language:kuery,query:''))";
    await this.pg.goto(url, { waitUntil: "domcontentloaded" });
    await this.pg.locator(this.sel.queryInput).first().waitFor({ state: "visible" });
    this.filterActive = false;
    await this.ensureTimeRange();
  }

  /**
   * Makes sure the Discover time picker shows the configured window (e.g. "Last 24 hours"). If not, it is set via
   * the "Commonly used" shortcut when one exists, otherwise via the Quick select form (Last / N / unit / Apply).
   */
  private async ensureTimeRange(): Promise<void> {
    const page = this.pg;
    const { from, label } = this.timeRange;
    const shown = page.locator('[data-test-subj="superDatePickerShowDatesButton"]').first();
    const current = async () => (await shown.innerText().catch(() => "")).replace(/Show dates$/, "").trim();
    if ((await current()).includes(label)) {
      if (!this.timeRangeVerified) log.info(`Dashboards: time range verified - "${label}"`);
      this.timeRangeVerified = true;
      return;
    }

    await page.locator('[data-test-subj="superDatePickerToggleQuickMenuButton"]').first().click();
    const shortcut = page.locator(`[data-test-subj="superDatePickerCommonlyUsed_${label.replace(" ", "_")}"]`);
    if (await shortcut.count()) {
      await shortcut.first().click();
    } else {
      const m = /^now-(\d+)([smhdwMy])$/.exec(from);
      if (!m) throw new Error(`time_range.from must look like now-15h / now-24h, got "${from}"`);
      const units: Record<string, string> = { s: "seconds", m: "minutes", h: "hours", d: "days", w: "weeks", M: "months", y: "years" };
      const menu = page.locator('[data-test-subj="superDatePickerQuickMenu"]');
      await menu.locator('select[aria-label="Time tense"]').selectOption({ label: "Last" });
      await menu.locator('input[aria-label="Time value"]').fill(m[1]);
      await menu.locator('select[aria-label="Time unit"]').selectOption({ label: units[m[2]] });
      await menu.getByRole("button", { name: "Apply", exact: true }).click();
    }
    await page.keyboard.press("Escape");
    const now = await current();
    if (now.includes(label)) log.info(`Dashboards: time range set to "${label}"`);
    else log.warn(`Dashboards: time picker shows "${now}", expected "${label}"`);
  }

  // ------------------------------------------------------------------ public API
  /** Validates every executed step of one supplier and fills `result.masking`. */
  async validateSupplier(result: SupplierResult, flowFinishedAt: number): Promise<void> {
    const remaining = (this.cfg.ingest_wait_seconds ?? 15) * 1000 - (Date.now() - flowFinishedAt);
    if (remaining > 0) {
      live.note(`waiting ${Math.ceil(remaining / 1000)}s for log ingestion before the OpenSearch check`);
      await timeline.time("idle", "ingestion-wait", `wait ${Math.ceil(remaining / 1000)}s for log ingestion`,
        { supplier: result.supplier }, () => sleep(remaining));
    }
    result.masking = [];
    for (const step of result.steps) {
      if (step.status === "SKIPPED") continue;
      // Every attempt is a real request with its own logs - failed Search routes are checked too.
      const attemptIds = (step.route_attempts ?? []).flatMap((a) => Object.values(a.correlation_ids));
      const ids = [...new Set([...Object.values(step.correlation_ids), ...attemptIds])].sort();
      const entry: MaskingEntry = {
        step: step.step, correlation_ids: ids, verdict: "NO_CORRELATION_ID", hits: 0, findings: [], error: null,
        kql: ids.length ? this.kql(ids) : null, search_method: null,
      };
      if (ids.length) await this.validateEntry(entry, result.supplier);
      result.masking.push(entry);
      live.masking(entry);
    }
  }

  // ------------------------------------------------------------------ internals
  private kql(ids: string[]): string {
    const field = this.cfg.correlation_field;
    return ids.map((id) => (field ? `${field}:"${id}"` : `"${id}"`)).join(" or ");
  }

  private dsl(ids: string[]): object {
    const field = this.cfg.correlation_field;
    const should = ids.map((id) => (field ? { match_phrase: { [field]: id } } : { multi_match: { query: id, type: "phrase", lenient: true } }));
    return {
      size: this.cfg.max_documents ?? 500,
      query: { bool: { should, minimum_should_match: 1, filter: [{ range: { "@timestamp": { gte: this.timeRange.from } } }] } },
    };
  }

  private async validateEntry(entry: MaskingEntry, supplier: string): Promise<void> {
    const attempts = Math.max(1, this.cfg.poll_attempts ?? 4);
    const interval = (this.cfg.poll_interval_seconds ?? 10) * 1000;
    let uiHits = 0;
    let docs: Array<{ _index?: string; _id?: string; _source?: unknown }> = [];
    let domTexts: string[];
    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const tctx = { supplier, step: entry.step };
        uiHits = await timeline.time("opensearch", "ui-query", `Discover query (attempt ${attempt})`, tctx, () => this.runQuery(entry.kql!));
        entry.search_method = "query";
        if (!uiHits && (this.cfg.filter_fallback ?? true)) {
          live.note(`${entry.step}: search bar returned 0 hits - retrying with Add filter (${this.cfg.correlation_field} is ...)`);
          uiHits = await timeline.time("opensearch", "ui-filter", "Add filter fallback", tctx, () => this.runFilter(entry.correlation_ids));
          if (uiHits) entry.search_method = "filter";
        }
        docs = await timeline.time("opensearch", "doc-fetch", "full-document fetch", tctx, () => this.fetchDocuments(entry));
        if (uiHits || docs.length) break;
        if (attempt < attempts) {
          live.note(`${entry.step}: no logs indexed yet, retry ${attempt + 1}/${attempts} in ${interval / 1000}s`);
          await timeline.time("idle", "poll-wait", `poll wait before attempt ${attempt + 1}`, tctx, () => sleep(interval));
        }
      }
      entry.hits = Math.max(uiHits, docs.length);
      if (!entry.hits) {
        entry.verdict = "NO_LOGS";
        await this.screenshot(supplier, entry, true);
        return;
      }
      domTexts = await timeline.time("opensearch", "dom-scrape", "scrape results + expand rows", { supplier, step: entry.step }, () => this.scrapeDom());
    } catch (err) {
      entry.verdict = "ERROR";
      entry.error = String((err as Error).message ?? err).split("\n")[0];
      await this.screenshot(supplier, entry, true);
      return;
    }

    // Strict assertion per target field: one finding per (field, exposed value) in this step. Full documents are
    // scanned first so the finding points at the exact log document; the Discover DOM adds only what it alone shows.
    const seen = new Set<string>();
    const add = (f: Finding) => {
      const key = `${f.key.toLowerCase()}|${f.evidence}`;
      if (!seen.has(key)) {
        seen.add(key);
        entry.findings.push(f);
      }
    };
    const verified = new Map<string, VerifiedMask>();
    const scan = (value: unknown, source: "full-document" | "ui-dom", doc: string) => {
      const result = this.scanner.scanAll(value, { step: entry.step });
      for (const f of result.findings) add({ ...f, step: entry.step, source, doc });
      for (const v of result.verified) {
        const id = `${v.key.toLowerCase()}|${v.value}`;
        const existing = verified.get(id);
        if (existing) existing.count += v.count;
        else verified.set(id, { ...v, step: entry.step, source, doc });
      }
    };
    timeline.timeSync("masking", "log-scan", `scan ${docs.length} document(s) + ${domTexts.length} DOM text(s)`, { supplier, step: entry.step }, () => {
      for (const doc of docs) scan(doc._source ?? {}, "full-document", `${doc._index}/${doc._id}`);
      for (const text of domTexts) scan(text, "ui-dom", "discover-ui");
    });
    entry.verified = [...verified.values()];
    entry.verdict = entry.findings.length ? "FAIL" : "PASS";
    await this.screenshot(supplier, entry, false);
  }

  private async runQuery(kql: string): Promise<number> {
    const page = this.pg;
    if (page.url().includes("/app/login")) { // session expired
      await this.login();
      await this.openDiscover();
    }
    const box = page.locator(this.sel.queryInput).first();
    if (this.filterActive || !(await box.isVisible())) await this.openDiscover(); // drop filters from a previous fallback
    await box.click();
    await box.fill(kql);
    await box.press("Escape"); // close the autocomplete popover so it can't swallow the submit
    await page.locator(this.sel.querySubmit).first().click();
    return this.waitForHits();
  }

  /** Fallback: empty search bar + "Add filter": <correlation_field> is <id> (or "is one of" for several ids). */
  private async runFilter(ids: string[]): Promise<number> {
    const page = this.pg;
    const field = this.cfg.correlation_field;
    await this.openDiscover(); // fresh page: empty search bar, no filters
    // Don't focus the search bar - its recent-queries popover covers the filter bar and swallows the click.
    await page.keyboard.press("Escape");
    await page.locator('[data-test-subj="addFilter"]').first().click();
    const editor = page.locator('[data-test-subj="globalFilterItemEditor"]');
    // Combo-box options are matched on their exact visible text (their accessible name carries extra text).
    const option = (text: string) => page.locator('[role="option"]').filter({ hasText: new RegExp(`^${escapeRegExp(text)}$`) }).first();
    await editor.locator('[data-test-subj="filterFieldSuggestionList"] input').fill(field);
    await option(field).click();
    await editor.locator('[data-test-subj="filterOperatorList"] input').click();
    await option(ids.length > 1 ? "is one of" : "is").click();
    const value = editor.locator('[data-test-subj="filterParams"] input').first();
    for (const id of ids) {
      await value.fill(id);
      if (ids.length > 1) await value.press("Enter"); // "is one of" is a combo box: Enter adds each value
    }
    await editor.locator('[data-test-subj="saveFilter"]').click();
    this.filterActive = true;
    await page.locator(this.sel.querySubmit).first().click();
    return this.waitForHits();
  }

  private async waitForHits(): Promise<number> {
    const page = this.pg;
    await page.waitForLoadState("networkidle", { timeout: this.timeout }).catch(() => undefined);
    await page.waitForTimeout(1000);
    await page.locator(this.sel.hits).or(page.locator(this.sel.noResults)).first().waitFor({ state: "visible" });
    if (await page.locator(this.sel.noResults).first().isVisible()) return 0;
    const text = await page.locator(this.sel.hits).first().innerText();
    return Number(text.replace(/\D/g, "")) || 0;
  }

  private async scrapeDom(): Promise<string[]> {
    const page = this.pg;
    const texts: string[] = [];
    const results = page.locator(this.sel.results).first();
    if (await results.count()) texts.push(await results.innerText());
    const toggles = page.locator(this.sel.rowExpand);
    const rows = Math.min(await toggles.count(), this.cfg.max_rows_to_expand ?? 20);
    for (let i = 0; i < rows; i++) {
      try {
        await toggles.nth(i).click({ timeout: 3000 });
        const viewer = page.locator(this.sel.docViewer).last();
        await viewer.waitFor({ state: "visible", timeout: 5000 });
        texts.push(await viewer.innerText({ timeout: 5000 }));
        await page.keyboard.press("Escape"); // closes the flyout variant of the document viewer
      } catch (err) {
        log.debug(`could not expand row ${i}: ${(err as Error).message.split("\n")[0]}`);
      }
    }
    return texts;
  }

  private async fetchDocuments(entry: MaskingEntry): Promise<Array<{ _index?: string; _id?: string; _source?: unknown }>> {
    if (!this.fetchFull) return [];
    const resp = await this.context!.request.post(new URL("api/console/proxy", this.url).toString(), {
      params: { path: `${this.cfg.index}/_search`, method: "POST" },
      headers: { "osd-xsrf": "true" },
      data: this.dsl(entry.correlation_ids),
    });
    if (!resp.ok()) { // don't retry for every id; fall back to DOM-only checks
      this.fetchFull = false;
      entry.error = `full-document fetch disabled (HTTP ${resp.status()}); DOM-only validation`;
      log.warn(`Dashboards console proxy returned HTTP ${resp.status()} - continuing with DOM scraping only`);
      return [];
    }
    const json = (await resp.json()) as { hits?: { hits?: Array<{ _index?: string; _id?: string; _source?: unknown }> } };
    return json.hits?.hits ?? [];
  }

  private async screenshot(supplier: string, entry: MaskingEntry, onError: boolean): Promise<void> {
    const mode = this.cfg.screenshots ?? "on_error";
    if (mode === "never" || (mode === "on_error" && !onError)) return;
    const dir = join(this.outDir, "screenshots");
    mkdirSync(dir, { recursive: true });
    await timeline.time("opensearch", "screenshot", `screenshot ${entry.step}`, { supplier, step: entry.step }, () =>
      this.pg.screenshot({ path: join(dir, `${safeFilename(supplier)}_${entry.step}_${entry.verdict}.png`) })
        .then(() => undefined, (err: Error) => log.debug(`screenshot failed: ${err.message}`)));
  }
}

