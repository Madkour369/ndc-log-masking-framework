/** Verdicts, report data model and the console executive summary. HTML pages live in ./html/. */
import { securityLine, stepLabel } from "./live";
import type { LeakScanner } from "./masking";
import type { TimelineData } from "./timeline";
import type { Finding, MaskingConfig, OverallVerdict, StepResult, SupplierResult, VerifiedMask } from "./types";
import { log, paint } from "./utils";

export interface ReportMeta {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  base_url: string;
  dashboards_url: string | null;
  tenant: string | null;
  index: string | null;
  index_pattern_id?: string | null;
  /** Discover time window used for the checks, e.g. "now-24h". */
  time_from?: string | null;
  steps: string[];
  stop_after: string | null;
  validate_at: string;
  suppliers_file: string;
}

export interface Report {
  meta: ReportMeta;
  summary: {
    total_suppliers: number;
    passed: number;
    /** Security assertion failed (unmasked target field). */
    failed: number;
    /** Masking could not be fully verified: an API step failed or logs could not be checked. */
    blocked: number;
    flows: { passed: number; failed: number };
    steps: Record<string, Record<string, number>>;
    masking: Record<string, number>;
    masking_checks: { passed: number; total: number };
    unmasked_in_logs: number;
    unmasked_in_api_responses: number;
    /** Distinct target fields (per step) that passed the strict ^*+$ assertion. */
    verified_masked: number;
    /** verified / (verified + exposed) target-field assertions, 0-100; null when nothing was asserted. */
    masking_score: number | null;
  };
  suppliers: SupplierResult[];
  timeline?: TimelineData;
}

// ---------------------------------------------------------------- verdicts
function maskingVerdict(sup: SupplierResult, failOnExposure: boolean): SupplierResult["masking_verdict"] {
  const verdicts = sup.masking.map((m) => m.verdict);
  const exposed = sup.steps.some((s) => s.response_exposure.length > 0);
  if (verdicts.includes("FAIL") || (exposed && failOnExposure)) return "FAIL";
  if (verdicts.length === 0 || verdicts.every((v) => v === "NOT_RUN")) return "NOT_RUN";
  if (verdicts.every((v) => v === "PASS")) return "PASS";
  return "INCONCLUSIVE";
}

/**
 * Sets masking_verdict, overall and overall_reason (idempotent, so older report.json files can be re-rendered):
 *   FAIL    - a security assertion failed (unmasked target field in logs or API response)
 *   BLOCKED - no security failure, but masking could not be fully verified (an API step failed, or logs missing)
 *   PASS    - every API step and every masking check passed
 */
export function applyVerdicts(sup: SupplierResult, maskCfg: MaskingConfig, uiEnabled: boolean): void {
  sup.masking_verdict = maskingVerdict(sup, maskCfg.fail_on_response_exposure ?? true);
  const reasons: string[] = [];
  const failed = sup.steps.find((s) => s.status === "FAIL");
  if (failed) reasons.push(`${stepLabel(failed.step)} failed: ${(failed.error ?? "").split(";")[0]}`);
  if (sup.error) reasons.push(sup.error);
  const leaks = sup.masking.reduce((n, m) => n + m.findings.length, 0);
  const exposures = sup.steps.reduce((n, s) => n + s.response_exposure.length, 0);
  if (leaks) {
    const keys = [...new Set(sup.masking.flatMap((m) => m.findings.map((f) => f.key)))].slice(0, 5).join(", ");
    reasons.push(`${leaks} unmasked value(s) in logs: ${keys}`);
  }
  if (exposures) reasons.push(`${exposures} unmasked value(s) in API responses`);

  let overall: OverallVerdict;
  if (sup.masking_verdict === "FAIL") overall = "FAIL";
  else if (sup.flow_status === "FAIL") overall = "BLOCKED";
  else if (sup.masking_verdict === "PASS" || (!uiEnabled && sup.masking_verdict === "NOT_RUN")) overall = "PASS";
  else {
    overall = "BLOCKED";
    const open = sup.masking.filter((m) => m.verdict !== "PASS").map((m) => `${stepLabel(m.step)}: ${m.verdict}`);
    reasons.push(open.length ? `masking check incomplete (${open.join(", ")})` : "masking check not run");
  }
  sup.overall = overall;
  sup.overall_reason = reasons.join(" | ") || null;
}

const tally = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

export function buildReport(results: SupplierResult[], meta: ReportMeta, maskCfg: MaskingConfig, timelineData?: TimelineData): Report {
  for (const sup of results) applyVerdicts(sup, maskCfg, meta.dashboards_url !== null);
  const steps = Object.fromEntries(meta.steps.map((name) => [
    name, tally(results.map((r) => r.steps.find((s) => s.step === name)?.status ?? "NOT_RUN")),
  ]));
  const overall = tally(results.map((r) => r.overall ?? "BLOCKED"));
  const checks = results.flatMap((r) => r.masking);
  const unmaskedLogs = results.reduce((n, r) => n + r.masking.reduce((m, e) => m + e.findings.length, 0), 0);
  const unmaskedApi = results.reduce((n, r) => n + r.steps.reduce((m, s) => m + s.response_exposure.length, 0), 0);
  const verified = results.reduce((n, r) => n + verifiedMasks(r).length, 0);
  const asserted = verified + unmaskedLogs + unmaskedApi;
  return {
    meta,
    summary: {
      total_suppliers: results.length,
      passed: overall.PASS ?? 0,
      failed: overall.FAIL ?? 0,
      blocked: overall.BLOCKED ?? 0,
      flows: {
        passed: results.filter((r) => r.flow_status === "PASS").length,
        failed: results.filter((r) => r.flow_status === "FAIL").length,
      },
      steps,
      masking: tally(results.map((r) => r.masking_verdict ?? "NOT_RUN")),
      masking_checks: { passed: checks.filter((m) => m.verdict === "PASS").length, total: checks.length },
      unmasked_in_logs: unmaskedLogs,
      unmasked_in_api_responses: unmaskedApi,
      verified_masked: verified,
      masking_score: asserted ? Math.round((verified / asserted) * 1000) / 10 : null,
    },
    suppliers: results,
    timeline: timelineData,
  };
}

/**
 * Re-applies the CURRENT masking exclusions / step scopes to findings stored in a saved report (raw logs are not
 * kept, so this can only remove assertions, never add new ones). A masking check that failed only because of
 * now-excluded fields becomes PASS. Returns how many findings and verified entries were dropped.
 */
export function reapplyMaskingRules(suppliers: SupplierResult[], scanner: LeakScanner): { findings: number; verified: number } {
  const dropped = { findings: 0, verified: 0 };
  const keep = (key: string, rule: string, step: string) =>
    !scanner.isSuppressed(rule === "auth-scheme" ? "authorization" : key, step);
  for (const sup of suppliers) {
    for (const m of sup.masking) {
      const findings = m.findings.filter((f) => keep(f.key, f.rule, m.step));
      const verified = (m.verified ?? []).filter((v) => keep(v.key, v.rule, m.step));
      dropped.findings += m.findings.length - findings.length;
      dropped.verified += (m.verified?.length ?? 0) - verified.length;
      m.findings = findings;
      m.verified = verified;
      if (m.verdict === "FAIL" && findings.length === 0) m.verdict = "PASS";
    }
    for (const s of sup.steps) {
      const exposure = s.response_exposure.filter((f) => keep(f.key, f.rule, s.step));
      const verified = (s.response_verified ?? []).filter((v) => keep(v.key, v.rule, s.step));
      dropped.findings += s.response_exposure.length - exposure.length;
      dropped.verified += (s.response_verified?.length ?? 0) - verified.length;
      s.response_exposure = exposure;
      s.response_verified = verified;
    }
  }
  return dropped;
}

/** Non-zero when any supplier FAILED a security assertion or is BLOCKED (masking not verified). */
export const exitCode = (report: Report): number => (report.summary.failed + report.summary.blocked > 0 ? 1 : 0);

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------- shared data helpers

export interface SecurityFailure { supplier: string; step: string; finding: Finding }

/** Every failed security assertion (unmasked target field) in logs and API responses, in step order. */
export function securityFailures(suppliers: SupplierResult[]): SecurityFailure[] {
  return suppliers.flatMap((sup) => sup.steps.flatMap((s) => [
    ...(sup.masking.find((m) => m.step === s.step)?.findings ?? []),
    ...s.response_exposure,
  ].map((finding) => ({ supplier: sup.supplier, step: s.step, finding }))));
}

/** All [VERIFIED MASKED] occurrences of a supplier: logs first, then API responses, in step order. */
export function verifiedMasks(sup: SupplierResult): VerifiedMask[] {
  return sup.steps.flatMap((s) => [
    ...(sup.masking.find((m) => m.step === s.step)?.verified ?? []),
    ...(s.response_verified ?? []),
  ].map((v) => ({ ...v, step: s.step })));
}

/** "CAI-JED" for the route the Search step ended on, "-" when none. */
export function searchRoute(sup: SupplierResult): string {
  return sup.steps.find((s) => s.route)?.route?.split(" ")[0] ?? "-";
}

// ---------------------------------------------------------------- console executive summary
const stepCell = (s?: StepResult) => (s ? `${s.status}${s.http_status ? ` ${s.http_status}` : ""}` : "-");
const colored = (text: string, width: number, tone = text.split(" ")[0]) => paint(text.padEnd(width), tone);

export function printExecutiveSummary(report: Report, htmlPath: string, jsonPath: string): void {
  const { meta, summary } = report;
  const nameWidth = Math.max(8, ...report.suppliers.map((s) => s.supplier.length)) + 2;
  const stepWidths = meta.steps.map((n) => Math.max(stepLabel(n).length, 9) + 2);
  const routeWidth = 10;
  const header = "  #  " + "Supplier".padEnd(nameWidth) + "Route".padEnd(routeWidth)
    + meta.steps.map((n, i) => stepLabel(n).padEnd(stepWidths[i])).join("") + "Masking".padEnd(14) + "Result";
  const rule = "=".repeat(Math.max(header.length + 8, 78));
  const thin = "-".repeat(rule.length);
  const pct = (n: number) => (summary.total_suppliers ? ` (${Math.round((n / summary.total_suppliers) * 100)}%)` : "");

  log.line();
  log.line(rule);
  log.line(paint(` EXECUTIVE SUMMARY   run ${meta.run_id}   duration ${formatDuration(meta.duration_ms)}`, "HEAD"));
  log.line(rule);
  log.line(` Suppliers processed : ${summary.total_suppliers}`);
  log.line(` ${paint("PASSED", "PASS")}              : ${summary.passed}${pct(summary.passed)}`);
  log.line(` ${paint("FAILED", "FAIL")}              : ${summary.failed}${pct(summary.failed)}   (security assertion failed)`);
  log.line(` ${paint("BLOCKED", "BLOCKED")}             : ${summary.blocked}${pct(summary.blocked)}   (masking not fully verified)`);
  log.line(` API flows passed    : ${summary.flows.passed}/${summary.total_suppliers}`);
  log.line(` Masking checks      : ${summary.masking_checks.passed}/${summary.masking_checks.total} passed`
    + `   masking score ${summary.masking_score === null ? "n/a" : `${summary.masking_score}%`}`);
  log.line(` Unmasked values     : ${summary.unmasked_in_logs} in logs, ${summary.unmasked_in_api_responses} in API responses`);
  log.line(` Verified masked     : ${summary.verified_masked} target field(s) asserted as ********`);
  log.line(thin);
  log.line(header);
  log.line(thin);
  report.suppliers.forEach((sup, i) => {
    const byName = new Map(sup.steps.map((s) => [s.step, s]));
    const cells = meta.steps.map((n, j) => colored(stepCell(byName.get(n)), stepWidths[j])).join("");
    log.line(`${String(i + 1).padStart(3)}  ${sup.supplier.padEnd(nameWidth)}${searchRoute(sup).padEnd(routeWidth)}${cells}`
      + `${colored(sup.masking_verdict ?? "-", 14)}${paint(sup.overall ?? "-", sup.overall ?? "")}`);
  });
  const issues = report.suppliers.filter((s) => s.overall !== "PASS");
  if (issues.length) {
    log.line(thin);
    log.line(" Issues:");
    for (const sup of issues) {
      log.line(`  - ${paint((sup.overall ?? "").padEnd(8), sup.overall ?? "")} ${sup.supplier.padEnd(nameWidth)} ${sup.overall_reason ?? ""}`);
    }
  }
  const fails = securityFailures(report.suppliers);
  if (fails.length) {
    log.line(thin);
    log.line(paint(` Security assertions failed: ${fails.length}`, "FAIL"));
    for (const { supplier, step, finding } of fails.slice(0, 40)) {
      log.line(paint(`  ${supplier.padEnd(nameWidth)} ${securityLine(finding, step)}  (${finding.source})`, "FAIL"));
    }
    if (fails.length > 40) log.line(paint(`  ... ${fails.length - 40} more in report.html`, "FAIL"));
  }
  log.line(rule);
  log.line(` HTML report : ${htmlPath}`);
  log.line(`               single self-contained file (overview, time breakdown, supplier views)`);
  log.line(` JSON report : ${jsonPath}`);
  log.line(rule);
}
