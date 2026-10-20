/**
 * End-to-end validator: NDC API flow (axios) + OpenSearch Dashboards masking check (Playwright).
 *
 * Per supplier in suppliers.json:
 *   Phase 1  Search -> Reconfirm -> AddPassengerDetails -> Book, collecting each response's CorrelationId.
 *   Phase 2  Log in to Dashboards, search every CorrelationId in Discover, scrape the logs and assert that
 *            credentials are masked as ******** (PASS / FAIL printed live).
 * Ends with an executive summary in the console and reports/<run-id>/report.html + report.json.
 *
 *   npm run e2e                                    all suppliers, headless
 *   npm run e2e:headed                             all suppliers, visible browser
 *   npm run e2e -- --only "AJet,FlyNas" --no-open  subset, don't open the browser at the end
 *   npm run e2e -- --stop-after reconfirm          no bookings
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSupplier, validateChain, type RunContext } from "./api_flow";
import { cli } from "./cli";
import { DashboardsValidator } from "./dashboards_ui";
import * as live from "./live";
import { createScanner } from "./masking";
import { autoOpenEnabled, reportReady } from "./open_report";
import { writeReportPages } from "./html";
import { applyVerdicts, buildReport, exitCode, printExecutiveSummary, type ReportMeta } from "./report";
import { timeline } from "./timeline";
import type { Config, Supplier, SupplierResult } from "./types";
import { isRecord, loadEnvFile, loadJson, log, paint, resolveEnvPlaceholders, writeJson } from "./utils";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fromRoot = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));

const USAGE = `Usage: npm run e2e -- [options]
  --config <file>        default config.json
  --suppliers <file>     suppliers.json (names or {name, enabled, variables}) or .txt (one per line)
  --only "A,B"           subset of suppliers
  --stop-after <step>    last API step to run: search | fareConfirm | addPassengerDetails | book
  --validate-at <when>   supplier (default) | end
  --headed               show the browser
  --skip-ui              API flow only
  --no-open              don't open reports/latest_report.html when the run finishes (also off when CI is set)
  --save-responses       keep raw request/response JSON (may contain PII/secrets)
  --output-dir <dir>     default reports
  -v, --verbose`;

export function loadSuppliers(path: string, only?: string): Supplier[] {
  const data: unknown = path.toLowerCase().endsWith(".json")
    ? loadJson(path)
    : readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const items = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.suppliers) ? data.suppliers : [];
  let suppliers: Supplier[] = items.map((item: unknown) => {
    const entry = typeof item === "string" ? { name: item } : (item as Partial<Supplier>);
    if (!entry?.name) throw new Error(`supplier entry without a name: ${JSON.stringify(item)}`);
    return {
      name: entry.name, code: entry.code, enabled: entry.enabled ?? true, variables: entry.variables ?? {},
      primaryRoute: entry.primaryRoute, fallbackRoutes: entry.fallbackRoutes,
    };
  }).filter((s: Supplier) => s.enabled);
  if (only) {
    const wanted = new Set(only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const unknown = [...wanted].filter((w) => !suppliers.some((s) => s.name.toLowerCase() === w));
    if (unknown.length) throw new Error(`unknown supplier(s) in --only: ${unknown.join(", ")}`);
    suppliers = suppliers.filter((s) => wanted.has(s.name.toLowerCase()));
  }
  return suppliers;
}

async function main(): Promise<number> {
  const { args, warnings, errors } = cli();
  for (const w of warnings) console.warn(`[WARN] ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[ERROR] ${e}`);
    console.error(`\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  loadEnvFile(join(ROOT, ".env"));
  const { value: cfg, missing: missingEnv } = resolveEnvPlaceholders(loadJson<Config>(fromRoot(args.config)));
  if (!cfg.base_url) {
    console.error("NDC API URL is not set - add NDC_BASE_URL to .env (see .env.example)");
    return 2;
  }
  if (!args["skip-ui"] && !cfg.dashboards.url) {
    console.error("OpenSearch Dashboards URL is not set - add DASHBOARDS_URL to .env (see .env.example), or use --skip-ui");
    return 2;
  }
  if (missingEnv.length) console.warn(`[WARN] not set in .env, used empty values: ${missingEnv.join(", ")}`);
  const stepNames = cfg.steps.map((s) => s.name);
  const stopAfter = args["stop-after"];
  if (stopAfter && !stepNames.includes(stopAfter)) {
    console.error(`--stop-after must be one of: ${stepNames.join(", ")}`);
    return 2;
  }
  const chainProblems = validateChain(cfg, join(ROOT, "payloads"));
  if (chainProblems.length) {
    console.error(`Broken step chain in config.json / payloads:\n  - ${chainProblems.join("\n  - ")}`);
    return 2;
  }
  if (!["supplier", "end"].includes(args["validate-at"])) {
    console.error("--validate-at must be 'supplier' or 'end'");
    return 2;
  }
  const uiEnabled = !args["skip-ui"];
  const { DASHBOARDS_USERNAME: username, DASHBOARDS_PASSWORD: password } = process.env;
  if (uiEnabled && !(username && password)) {
    console.error("Set DASHBOARDS_USERNAME and DASHBOARDS_PASSWORD (e.g. in .env)");
    return 2;
  }
  let suppliers: Supplier[];
  try {
    suppliers = loadSuppliers(fromRoot(args.suppliers), args.only);
  } catch (err) {
    console.error(`Cannot load suppliers: ${(err as Error).message}`);
    return 2;
  }

  const started = new Date();
  timeline.start(started.getTime());
  const runId = started.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const outDir = join(fromRoot(args["output-dir"]), runId);
  log.configure(join(outDir, "run.log"), args.verbose);

  log.info(`Run ${runId}: ${suppliers.length} supplier(s) | API ${cfg.base_url} | `
    + `Dashboards ${uiEnabled ? `${cfg.dashboards.url} (${cfg.dashboards.tenant} / ${cfg.dashboards.index}, ${cfg.dashboards.time_range?.label ?? "Last 24 hours"})` : "disabled"}`);
  const clientId = process.env.CLIENT_ID?.trim() || "NDC-Core";
  if (process.env.NDC_API_KEY?.trim()) log.info(`API auth: x-api-key from NDC_API_KEY, Client-Id ${clientId}`);
  else log.warn("NDC_API_KEY is not set - the NDC API will answer 401 Unauthorized");

  // Our own x-api-key is a known secret too: if the API logs request headers, its literal value must never appear.
  const ownSecrets = [process.env.NDC_API_KEY?.trim()].filter((s): s is string => !!s && s.length >= 4);
  const scanner = createScanner(cfg.masking, ROOT, ownSecrets);
  const ctx: RunContext = {
    config: cfg, payloadDir: join(ROOT, "payloads"), outputDir: outDir, scanner,
    saveResponses: args["save-responses"], stopAfter: stopAfter || undefined,
  };
  const validator = uiEnabled
    ? new DashboardsValidator(cfg.dashboards, username!, password!, scanner, outDir, !args.headed)
    : null;

  const results: SupplierResult[] = [];
  const finish = (result: SupplierResult) => {
    applyVerdicts(result, cfg.masking, uiEnabled);
    live.supplierEnd(result);
  };
  try {
    await validator?.start();
    for (const [i, supplier] of suppliers.entries()) {
      live.supplierStart(i + 1, suppliers.length, supplier.name);
      const flowStart = Date.now();
      const result = await runSupplier(supplier, ctx);
      timeline.span(supplier.name, "flow", flowStart, Date.now() - flowStart);
      results.push(result);
      if (validator && args["validate-at"] === "supplier") await validateTimed(validator, result, Date.now());
      if (!validator || args["validate-at"] === "supplier") finish(result);
    }
    if (validator && args["validate-at"] === "end") {
      log.line();
      log.info("All API flows done - running the OpenSearch masking checks");
      const flowsDone = Date.now();
      for (const [i, result] of results.entries()) {
        live.supplierStart(i + 1, results.length, `${result.supplier} (masking check)`);
        await validateTimed(validator, result, flowsDone);
        finish(result);
      }
    }
  } catch (err) {
    // e.g. Dashboards login failure - whatever finished so far is still reported
    log.error(`Run aborted: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    await validator?.close();
  }

  const finished = new Date();
  timeline.finish(finished.getTime());
  const meta: ReportMeta = {
    run_id: runId,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: finished.getTime() - started.getTime(),
    base_url: cfg.base_url,
    dashboards_url: uiEnabled ? cfg.dashboards.url : null,
    tenant: uiEnabled ? cfg.dashboards.tenant ?? null : null,
    index: uiEnabled ? cfg.dashboards.index : null,
    index_pattern_id: uiEnabled ? cfg.dashboards.index_pattern_id ?? null : null,
    time_from: uiEnabled ? cfg.dashboards.time_range?.from ?? "now-24h" : null,
    steps: stopAfter ? stepNames.slice(0, stepNames.indexOf(stopAfter) + 1) : stepNames,
    stop_after: stopAfter || null,
    validate_at: args["validate-at"],
    suppliers_file: args.suppliers,
  };
  const report = buildReport(results, meta, cfg.masking, timeline.data());
  const jsonPath = join(outDir, "report.json");
  writeJson(jsonPath, report);
  const pages = writeReportPages(report, outDir);
  printExecutiveSummary(report, pages.overview, jsonPath);
  reportReady(pages.latest ?? pages.overview, autoOpenEnabled(args["no-open"]), (line) => log.line(paint(line, "HEAD")));
  if (results.length < suppliers.length) {
    log.error(`Only ${results.length}/${suppliers.length} supplier(s) were processed`);
    return 1;
  }
  return exitCode(report);
}

/** Masking validation of one supplier, recorded as that supplier's "validation" span. */
async function validateTimed(validator: DashboardsValidator, result: SupplierResult, flowFinishedAt: number): Promise<void> {
  const start = Date.now();
  try {
    await validator.validateSupplier(result, flowFinishedAt);
  } finally {
    timeline.span(result.supplier, "validation", start, Date.now() - start);
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(2);
});
