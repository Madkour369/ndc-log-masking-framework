/**
 * Re-renders the single-file HTML report (<run>/report.html + reports/latest_report.html) from a saved report.json.
 *   npm run report:build                          latest run
 *   npm run report:build -- reports/<run>/report.json --no-open
 * Older report.json files are upgraded on the fly (verdicts recomputed, missing Dashboards metadata from config.json).
 */
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReportPages } from "./html";
import { autoOpenEnabled, reportReady } from "./open_report";
import { createScanner } from "./masking";
import { buildReport, reapplyMaskingRules, type Report } from "./report";
import type { Config } from "./types";
import { loadEnvFile, loadJson, resolveEnvPlaceholders, writeJson } from "./utils";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function latestReportJson(): string | null {
  const dir = join(ROOT, "reports");
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((d) => existsSync(join(dir, d, "report.json"))).sort();
  return runs.length ? join(dir, runs[runs.length - 1], "report.json") : null;
}

const args = process.argv.slice(2).map((a) => a.trim().replace(/[\\/]+$/, "")).filter(Boolean);
const target = args.find((a) => !a.startsWith("--")) ? resolve(args.find((a) => !a.startsWith("--"))!) : latestReportJson();
if (!target || !existsSync(target)) {
  console.error("No report.json found - run `npm run e2e` first or pass a path.");
  process.exit(1);
}

loadEnvFile(join(ROOT, ".env"));
const cfg = resolveEnvPlaceholders(loadJson<Config>(join(ROOT, "config.json"))).value;
// Masking rules are re-applied to the findings as captured by the run, kept untouched in report.original.json,
// so changing an exclusion back later restores the findings instead of losing them.
const original = join(dirname(target), "report.original.json");
if (!existsSync(original)) copyFileSync(target, original);
const saved = loadJson<Report>(original);
const dropped = reapplyMaskingRules(saved.suppliers, createScanner(cfg.masking, ROOT));
if (dropped.findings || dropped.verified) {
  console.log(`Current masking rules applied: ${dropped.findings} finding(s) and ${dropped.verified} verified entr(ies) `
    + "are now excluded or out of step scope.");
}
const meta = {
  ...saved.meta,
  index_pattern_id: saved.meta.index_pattern_id ?? (saved.meta.dashboards_url ? cfg.dashboards.index_pattern_id ?? null : null),
  time_from: saved.meta.time_from ?? (saved.meta.dashboards_url ? cfg.dashboards.time_range?.from ?? "now-24h" : null),
};
const report = buildReport(saved.suppliers, meta, cfg.masking, saved.timeline);
writeJson(target, report);
const isNewest = latestReportJson() === target;
const pages = writeReportPages(report, dirname(target), isNewest);
console.log(`Rendered single-file report (${report.suppliers.length} supplier views, ${(pages.bytes / 1024).toFixed(0)} KB):\n  ${pages.overview}${pages.latest ? `\n  ${pages.latest}` : ""}`);
if (!isNewest) console.log("Older run: reports/latest_report.html left pointing at the newest run.");
reportReady(pages.latest ?? pages.overview, autoOpenEnabled(args.includes("--no-open")));
