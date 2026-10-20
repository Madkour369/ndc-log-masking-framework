/** Real-time console output while suppliers are processed (also mirrored to run.log). */
import type { Finding, MaskingEntry, StepResult, SupplierResult, VerifiedMask } from "./types";
import { log, paint } from "./utils";

/** "addPassengerDetails" -> "AddPassengerDetails" */
export const stepLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const LABEL = 30;
const MAX_VERIFIED_LINES = 20;

/** "[SECURITY FAIL] Step: Book | Field: password | Exposed Value: ab****** (10 chars) [plain text]" (value redacted). */
export function securityLine(f: Finding, step = f.step ?? "?"): string {
  return `[SECURITY FAIL] Step: ${stepLabel(step)} | Field: ${f.key} | Exposed Value: ${f.evidence} [${f.kind ?? "plain text"}]`;
}

/** "[VERIFIED MASKED] Step: Book | Field: access_token | Value: ********" (+ occurrence count). */
export function verifiedLine(v: VerifiedMask, step = v.step ?? "?"): string {
  return `[VERIFIED MASKED] Step: ${stepLabel(step)} | Field: ${v.key} | Value: ${v.value}${v.count > 1 ? ` (x${v.count})` : ""}`;
}

function printVerified(items: VerifiedMask[], step: string, where: string): void {
  for (const v of items.slice(0, MAX_VERIFIED_LINES)) log.line(paint(`   ${verifiedLine(v, step)}  (${where})`, "PASS"));
  if (items.length > MAX_VERIFIED_LINES) {
    log.line(paint(`   [VERIFIED MASKED] ... ${items.length - MAX_VERIFIED_LINES} more in ${stepLabel(step)}, see report`, "PASS"));
  }
}
const short = (text: string, max = 180) => (text.length > max ? `${text.slice(0, max)}...` : text);
const verdict = (value: string, width = 8) => paint(value.padEnd(width), value);

export function supplierStart(index: number, total: number, name: string): void {
  log.line();
  log.line(paint(`[${index}/${total}] Processing ${name}...`, "HEAD"));
}

export function step(record: StepResult): void {
  const label = stepLabel(record.step).padEnd(LABEL);
  if (record.status === "SKIPPED") {
    log.line(`   ${label} -> ${verdict("SKIPPED")}`);
    return;
  }
  const http = `HTTP ${record.http_status ?? "---"}`.padEnd(9);
  const ms = `${record.elapsed_ms} ms`.padStart(9);
  const route = record.route ? `   Route: ${record.route}` : "";
  log.line(`   ${label} -> ${verdict(record.status)} ${http} ${ms}   CorrelationId: ${record.correlation_id ?? "-"}${route}`);
  if (record.error) log.line(paint(`   ${" ".repeat(LABEL)}    error: ${short(record.error)}`, "FAIL"));
  if (record.warning) log.line(paint(`   ${" ".repeat(LABEL)}    warning: ${short(record.warning)}`, "WARN"));
  for (const f of record.response_exposure.slice(0, 10)) {
    log.line(paint(`   ${securityLine(f, record.step)}  (in API response, ${f.rule})`, "FAIL"));
  }
  printVerified(record.response_verified ?? [], record.step, "in API response");
}

/** One failed route attempt of a route_fallback step (the final outcome is printed by step()). */
export function routeAttempt(route: string, record: StepResult): void {
  log.line(`   ${"".padEnd(LABEL)}    route ${route}: HTTP ${record.http_status ?? "---"}, CorrelationId ${record.correlation_id ?? "-"}`
    + (record.error ? ` - ${short(record.error, 120)}` : ""));
}

export function warn(text: string): void {
  log.line(paint(`   [WARN] ${text}`, "WARN"));
}

export function note(text: string): void {
  log.line(`   ... ${text}`);
}

export function masking(entry: MaskingEntry): void {
  const label = `Masking Check [${stepLabel(entry.step)}]`.padEnd(LABEL);
  const via = entry.search_method === "filter" ? " (found via Add filter)" : "";
  const detail = `log hits ${entry.hits}, unmasked ${entry.findings.length}, verified masked ${entry.verified?.length ?? 0}${via}`;
  log.line(`   ${label} -> ${verdict(entry.verdict, 17)} ${detail}`);
  if (entry.error) log.line(paint(`   ${" ".repeat(LABEL)}    ${short(entry.error)}`, entry.verdict === "ERROR" ? "FAIL" : "WARN"));
  for (const f of entry.findings.slice(0, 10)) {
    log.line(paint(`   ${securityLine(f, entry.step)}  (${f.source}, ${f.rule})`, "FAIL"));
  }
  if (entry.findings.length > 10) log.line(paint(`   [SECURITY FAIL] ... ${entry.findings.length - 10} more in ${stepLabel(entry.step)}, see report`, "FAIL"));
  printVerified(entry.verified ?? [], entry.step, "in logs");
}

export function supplierEnd(result: SupplierResult): void {
  const reason = result.overall_reason ? ` (${result.overall_reason})` : "";
  log.line(`   => ${result.supplier}: ${paint(result.overall ?? "-", result.overall ?? "")}${reason}`);
}
