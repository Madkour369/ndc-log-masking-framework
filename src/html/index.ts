/**
 * Builds the single, self-contained HTML report: overview, time breakdown and one view per supplier, with all CSS,
 * JavaScript, SVG charts and drill-down data inlined (no external files, fonts or CDNs). The only outbound links are
 * the optional "Open logs in OpenSearch Discover" buttons, which point at the live Dashboards server.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Report } from "../report";
import { formatDuration } from "../report";
import { chip, shell, supplierView } from "./layout";
import { renderOverview } from "./overview";
import { renderSupplierView } from "./supplier_page";
import { renderTimeBreakdown } from "./time_breakdown";
import { effectiveTimeline } from "./timing";

export function renderReport(report: Report): string {
  const { summary } = report;
  const { data } = effectiveTimeline(report);
  const n = summary.total_suppliers;
  const views = [renderOverview(report), renderTimeBreakdown(report), ...report.suppliers.map((sup) => renderSupplierView(report, sup))];
  return shell({
    meta: report.meta,
    views,
    suppliers: report.suppliers.map((sup) => [supplierView(sup.supplier), `${sup.supplier} - ${sup.overall ?? "-"}`]),
    chips: [
      chip("Duration", formatDuration(data.total_ms)),
      chip("Pass rate", `${n ? Math.round((summary.passed / n) * 100) : 0}%`),
      chip("Masking score", summary.masking_score === null ? "n/a" : `${summary.masking_score}%`),
      chip("Suppliers", String(n)),
    ],
  });
}

export interface WrittenReport {
  /** reports/<run-id>/report.html */
  overview: string;
  /** reports/latest_report.html (identical copy), or null when not updated */
  latest: string | null;
  bytes: number;
}

/**
 * Writes the report to <run>/report.html and - unless re-rendering an older run - the identical file to
 * reports/latest_report.html. Both are complete on their own; the run folder is not needed to open them.
 */
export function writeReportPages(report: Report, outDir: string, updateLatest = true): WrittenReport {
  const html = renderReport(report);
  const overview = join(outDir, "report.html");
  writeFileSync(overview, html, "utf8");
  let latest: string | null = null;
  if (updateLatest) {
    latest = join(dirname(outDir), "latest_report.html");
    writeFileSync(latest, html, "utf8");
  }
  return { overview, latest, bytes: Buffer.byteLength(html) };
}
