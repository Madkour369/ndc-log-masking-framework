/** Timing analytics shared by the report pages. */
import type { Report } from "../report";
import { percentile, type TimeCategory, type TimeEvent, type TimelineData } from "../timeline";
import type { SupplierResult } from "../types";

export interface EffectiveTimeline {
  data: TimelineData;
  /** true when the report predates timeline capture and network timing was rebuilt from step durations. */
  synthesized: boolean;
}

export function effectiveTimeline(report: Report): EffectiveTimeline {
  if (report.timeline?.events?.length) return { data: report.timeline, synthesized: false };
  const started = Date.parse(report.meta.started_at) || 0;
  let cursor = started;
  const events: TimeEvent[] = [];
  for (const sup of report.suppliers) {
    for (const s of sup.steps) {
      const attempts = s.route_attempts?.length ? s.route_attempts : s.status === "SKIPPED" ? [] : [{ elapsed_ms: s.elapsed_ms, route: "" }];
      for (const a of attempts) {
        events.push({ category: "network", sub: "supplier-api", label: `POST ${s.endpoint}${a.route ? ` ${a.route}` : ""}`,
          supplier: sup.supplier, step: s.step, start: cursor, ms: a.elapsed_ms });
        cursor += a.elapsed_ms;
      }
    }
  }
  return {
    data: { started, finished: started + report.meta.duration_ms, total_ms: report.meta.duration_ms, events, spans: [] },
    synthesized: true,
  };
}

export type CategoryTotals = Record<TimeCategory, number>;
const zero = (): CategoryTotals => ({ network: 0, opensearch: 0, masking: 0, idle: 0 });

/** Measured time per supplier and category. */
export function supplierCategoryTotals(data: TimelineData): Map<string, CategoryTotals> {
  const map = new Map<string, CategoryTotals>();
  for (const e of data.events) {
    if (!e.supplier) continue;
    const t = map.get(e.supplier) ?? zero();
    t[e.category] += e.ms;
    map.set(e.supplier, t);
  }
  return map;
}

/** Wall-clock time spent on a supplier (API flow + its masking validation). */
export function supplierWallTime(sup: SupplierResult, data: TimelineData): number {
  const spans = data.spans.filter((s) => s.supplier === sup.supplier);
  if (spans.length) return spans.reduce((n, s) => n + s.ms, 0);
  const measured = data.events.filter((e) => e.supplier === sup.supplier).reduce((n, e) => n + e.ms, 0);
  return Math.max(sup.duration_ms, measured);
}

export interface LatencyRow {
  supplier: string;
  calls: number;
  p50: number;
  p95: number;
  max: number;
  slowest: { step: string; label: string; ms: number } | null;
  network: number;
  wall: number;
  overall: string;
}

export function latencyRows(report: Report, data: TimelineData): LatencyRow[] {
  return report.suppliers.map((sup) => {
    const calls = data.events.filter((e) => e.supplier === sup.supplier && e.category === "network");
    const values = calls.map((e) => e.ms);
    const slowest = calls.reduce<TimeEvent | null>((a, e) => (!a || e.ms > a.ms ? e : a), null);
    return {
      supplier: sup.supplier,
      calls: calls.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length ? Math.max(...values) : 0,
      slowest: slowest ? { step: slowest.step ?? "", label: slowest.label, ms: slowest.ms } : null,
      network: values.reduce((n, v) => n + v, 0),
      wall: supplierWallTime(sup, data),
      overall: sup.overall ?? "BLOCKED",
    };
  }).sort((a, b) => (a.calls ? a.p50 : Infinity) - (b.calls ? b.p50 : Infinity));
}

export interface StepLatencyRow { step: string; calls: number; p50: number; p95: number; max: number; total: number }

export function stepLatencyRows(data: TimelineData, steps: string[]): StepLatencyRow[] {
  return steps.map((step) => {
    const values = data.events.filter((e) => e.category === "network" && e.step === step).map((e) => e.ms);
    return { step, calls: values.length, p50: percentile(values, 50), p95: percentile(values, 95),
      max: values.length ? Math.max(...values) : 0, total: values.reduce((n, v) => n + v, 0) };
  });
}
