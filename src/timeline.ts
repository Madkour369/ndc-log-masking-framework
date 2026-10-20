/**
 * Run-wide time accounting. Every measured operation is a leaf event in one of four categories, so the
 * categories add up to the wall-clock run time; whatever is not measured becomes "unattributed framework time".
 */

export type TimeCategory = "network" | "opensearch" | "masking" | "idle";

export const CATEGORIES: Array<{ id: TimeCategory; label: string; description: string }> = [
  { id: "network", label: "Network / Supplier API Latency", description: "Round-trip time waiting for the NDC API and airline endpoints, per attempt." },
  { id: "opensearch", label: "OpenSearch Query & Scrape Overhead", description: "Discover searches, Add-filter fallback, full-document fetches, DOM scraping and screenshots." },
  { id: "masking", label: "Masking Scan & Security Rule Engine", description: "Matching target keys and asserting ^\\*+$ over log documents, DOM text and API responses." },
  { id: "idle", label: "Framework / Idle Overhead", description: "Log-ingestion and poll waits, retry back-off, browser session setup, payload rendering, file I/O and gaps between steps." },
];

export const SUB_LABELS: Record<string, string> = {
  "supplier-api": "Supplier API round-trip",
  "ui-query": "Discover search-bar query",
  "ui-filter": "Add-filter fallback query",
  "doc-fetch": "Full-document fetch",
  "dom-scrape": "DOM scrape & row expansion",
  screenshot: "Screenshots",
  "log-scan": "Log document & DOM scan",
  "api-response-scan": "API response scan",
  "ingestion-wait": "Log-ingestion wait",
  "poll-wait": "Poll wait (logs not indexed yet)",
  "retry-backoff": "Retry back-off",
  "session-setup": "Browser launch, login & Discover setup",
  "payload-render": "Payload rendering",
  "file-io": "File I/O (saved responses)",
  "unattributed": "Unattributed framework time (gaps)",
};

export interface TimeEvent {
  category: TimeCategory;
  sub: string;
  label: string;
  supplier: string | null;
  step: string | null;
  /** epoch ms */
  start: number;
  ms: number;
}

export interface SupplierSpan {
  supplier: string;
  phase: "flow" | "validation";
  start: number;
  ms: number;
}

export interface TimelineData {
  started: number;
  finished: number;
  total_ms: number;
  events: TimeEvent[];
  spans: SupplierSpan[];
}

export interface TimeContext {
  supplier?: string | null;
  step?: string | null;
}

class Timeline {
  private events: TimeEvent[] = [];
  private spans: SupplierSpan[] = [];
  private started = Date.now();
  private finished: number | null = null;

  start(at = Date.now()): void {
    this.events = [];
    this.spans = [];
    this.started = at;
    this.finished = null;
  }

  finish(at = Date.now()): void {
    this.finished = at;
  }

  add(category: TimeCategory, sub: string, label: string, ctx: TimeContext, start: number, ms: number): void {
    this.events.push({ category, sub, label, supplier: ctx.supplier ?? null, step: ctx.step ?? null, start, ms: Math.max(0, Math.round(ms)) });
  }

  /** Measure an async leaf operation. Do not nest measured operations of different categories. */
  async time<T>(category: TimeCategory, sub: string, label: string, ctx: TimeContext, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.add(category, sub, label, ctx, start, performance.now() - t0);
    }
  }

  timeSync<T>(category: TimeCategory, sub: string, label: string, ctx: TimeContext, fn: () => T): T {
    const start = Date.now();
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.add(category, sub, label, ctx, start, performance.now() - t0);
    }
  }

  span(supplier: string, phase: SupplierSpan["phase"], start: number, ms: number): void {
    this.spans.push({ supplier, phase, start, ms: Math.round(ms) });
  }

  data(): TimelineData {
    const finished = this.finished ?? Date.now();
    return { started: this.started, finished, total_ms: finished - this.started, events: [...this.events], spans: [...this.spans] };
  }
}

export const timeline = new Timeline();

// ---------------------------------------------------------------- aggregation (used by the report pages)

export interface Bucket {
  category: TimeCategory;
  sub: string;
  ms: number;
  count: number;
}

/** Per category + sub totals, including the computed unattributed gap so everything sums to total_ms. */
export function breakdown(data: TimelineData): { buckets: Bucket[]; byCategory: Record<TimeCategory, number>; total: number } {
  const map = new Map<string, Bucket>();
  for (const e of data.events) {
    const key = `${e.category}|${e.sub}`;
    const b = map.get(key) ?? { category: e.category, sub: e.sub, ms: 0, count: 0 };
    b.ms += e.ms;
    b.count++;
    map.set(key, b);
  }
  const measured = [...map.values()].reduce((n, b) => n + b.ms, 0);
  const gap = Math.max(0, data.total_ms - measured);
  if (gap > 0) map.set("idle|unattributed", { category: "idle", sub: "unattributed", ms: gap, count: 0 });
  const buckets = [...map.values()].sort((a, b) =>
    CATEGORIES.findIndex((c) => c.id === a.category) - CATEGORIES.findIndex((c) => c.id === b.category) || b.ms - a.ms);
  const byCategory = { network: 0, opensearch: 0, masking: 0, idle: 0 } as Record<TimeCategory, number>;
  for (const b of buckets) byCategory[b.category] += b.ms;
  return { buckets, byCategory, total: Math.max(data.total_ms, measured) };
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
