/** Phase 1: Search -> Reconfirm -> AddPassengerDetails -> Book for one supplier (axios). */
import { readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import axios, { AxiosError, type AxiosInstance } from "axios";
import * as live from "./live";
import { timeline, type TimeContext } from "./timeline";
import type { LeakScanner } from "./masking";
import type { Config, Route, RouteAttempt, StepConfig, StepResult, Supplier, SupplierResult } from "./types";
import {
  extractFirst, getPath, isRecord, loadJson, log, renderTemplate, resolveVariables, safeFilename, sleep, snippet, writeJson,
} from "./utils";

const TRANSIENT_STATUS = new Set([502, 503, 504]);
const EMPTY_GUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const TRANSIENT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_NETWORK"]);

export interface RunContext {
  config: Config;
  payloadDir: string;
  outputDir: string;
  scanner: LeakScanner;
  saveResponses: boolean;
  stopAfter?: string;
}

interface CallResult {
  url: string;
  attempts: number;
  status: number | null;
  elapsedMs: number;
  headers: Record<string, string>;
  body: unknown;
  correlationIds: Record<string, string>;
  error: string | null;
}

const httpOk = (status: number | null) => status !== null && status >= 200 && status < 300;

/**
 * Headers sent with every API call (Search, Reconfirm, AddPassengerDetails, Book):
 *   x-api-key     <- NDC_API_KEY
 *   Client-Id     <- CLIENT_ID (default "NDC-Core")
 *   Content-Type  application/json
 *   Authorization <- NDC_API_AUTHORIZATION (optional, only if set)
 */
export function buildHeaders(cfg: Config): Record<string, string> {
  const headers: Record<string, string> = { ...cfg.default_headers, "Content-Type": "application/json" };
  const apiKey = process.env.NDC_API_KEY?.trim();
  if (apiKey) headers[cfg.api_key_header || "x-api-key"] = apiKey;
  headers["Client-Id"] = process.env.CLIENT_ID?.trim() || "NDC-Core";
  const authorization = process.env.NDC_API_AUTHORIZATION?.trim();
  if (authorization) headers.Authorization = authorization;
  return headers;
}

export class ApiClient {
  private readonly http: AxiosInstance;

  constructor(private readonly cfg: Config) {
    this.http = axios.create({
      headers: buildHeaders(cfg),
      timeout: (cfg.request_timeout_seconds ?? 180) * 1000,
      validateStatus: () => true, // every HTTP status is a result, not an exception
      responseType: "text",
      transformResponse: [(data: unknown) => data],
      httpsAgent: cfg.verify_ssl === false ? new https.Agent({ rejectUnauthorized: false }) : undefined,
    });
  }

  /** Only retryable steps are re-sent on network errors / 502-504, so AddPassengerDetails and Book never duplicate. */
  async post(endpoint: string, payload: unknown, retryable: boolean, tctx: TimeContext = {}): Promise<CallResult> {
    const url = new URL(endpoint.replace(/^\/+/, ""), this.cfg.base_url.replace(/\/?$/, "/")).toString();
    const maxAttempts = 1 + (retryable ? this.cfg.max_retries ?? 2 : 0);
    let result: CallResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = performance.now();
      const startedAt = Date.now();
      result = { url, attempts: attempt, status: null, elapsedMs: 0, headers: {}, body: null, correlationIds: {}, error: null };
      let transient: boolean;
      log.debug(`POST ${url} (attempt ${attempt}/${maxAttempts})`);
      try {
        const res = await this.http.post(url, payload).finally(() => {
          const label = `POST ${endpoint}${maxAttempts > 1 ? ` (attempt ${attempt})` : ""}`;
          timeline.add("network", "supplier-api", label, tctx, startedAt, performance.now() - started);
        });
        result.status = res.status;
        result.headers = flattenHeaders(res.headers);
        result.correlationIds = this.correlationIds(result.headers);
        result.body = parseBody(res.data);
        if (!httpOk(res.status)) result.error = `HTTP ${res.status} ${res.statusText}`;
        transient = TRANSIENT_STATUS.has(res.status);
      } catch (err) {
        const e = err as AxiosError;
        result.error = `${e.code ?? "Error"}: ${e.message}`;
        transient = TRANSIENT_CODES.has(e.code ?? "");
      }
      result.elapsedMs = Math.round(performance.now() - started);
      if (!transient || attempt === maxAttempts) return result;
      const delay = (this.cfg.retry_backoff_seconds ?? 3) * attempt;
      live.note(`${result.error} - retrying in ${delay}s (attempt ${attempt + 1}/${maxAttempts})`);
      await timeline.time("idle", "retry-backoff", `back-off ${delay}s before attempt ${attempt + 1}`, tctx, () => sleep(delay * 1000));
    }
    return result!;
  }

  private correlationIds(headers: Record<string, string>): Record<string, string> {
    const ids: Record<string, string> = {};
    for (const name of this.cfg.correlation_headers) {
      const value = headers[name.toLowerCase()];
      if (value && !EMPTY_GUID.test(value)) ids[name] = value; // rejected requests echo an all-zero placeholder id
    }
    if (Object.keys(ids).length === 0) { // fall back to anything that looks like a correlation / request id
      for (const [name, value] of Object.entries(headers)) {
        if (value && !EMPTY_GUID.test(value) && (name.includes("correlation") || name.endsWith("request-id"))) ids[name] = value;
      }
    }
    return ids;
  }
}

function flattenHeaders(headers: unknown): Record<string, string> {
  const raw = (headers as { toJSON?: () => unknown })?.toJSON?.() ?? headers;
  const out: Record<string, string> = {};
  if (isRecord(raw)) {
    for (const [k, v] of Object.entries(raw)) if (v != null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function parseBody(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * Pre-flight check of the data chain: every {{placeholder}} in a step's payload must come from config variables,
 * the route (ORIGIN / DESTINATION / DEPARTURE_DATE), or the `extract` of an EARLIER step. Returns the problems found.
 */
export function validateChain(cfg: Config, payloadDir: string): string[] {
  const available = new Set([...Object.keys(cfg.variables), "SUPPLIER_NAME", "ORIGIN", "DESTINATION", "DEPARTURE_DATE"]);
  const problems: string[] = [];
  for (const step of cfg.steps) {
    let text: string;
    try {
      text = readFileSync(join(payloadDir, step.payload), "utf8");
    } catch {
      problems.push(`${step.name}: payload file payloads/${step.payload} not found`);
      continue;
    }
    for (const [, name] of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      if (!available.has(name)) problems.push(`${step.name}: {{${name}}} is not produced by config variables or an earlier step`);
    }
    for (const name of Object.keys(step.extract ?? {})) available.add(name);
  }
  return [...new Set(problems)];
}

function selectedSteps(ctx: RunContext): StepConfig[] {
  const steps = ctx.config.steps;
  if (!ctx.stopAfter) return steps;
  return steps.slice(0, steps.findIndex((s) => s.name === ctx.stopAfter) + 1);
}

function skipped(step: StepConfig): StepResult {
  return {
    step: step.name, endpoint: step.endpoint, status: "SKIPPED", http_status: null, elapsed_ms: 0, attempts: 0,
    correlation_id: null, correlation_ids: {}, extracted: {}, error: null, warning: null, response_exposure: [],
  };
}

export async function runSupplier(supplier: Supplier, ctx: RunContext): Promise<SupplierResult> {
  const variables = resolveVariables({
    ...ctx.config.variables, ...supplier.variables, SUPPLIER_NAME: supplier.code ?? supplier.name,
  });
  const result: SupplierResult = {
    supplier: supplier.name, overall: null, overall_reason: null, flow_status: "PASS", failed_step: null, error: null,
    duration_ms: 0, steps: [], masking: [], masking_verdict: null,
  };
  const client = new ApiClient(ctx.config);
  const started = performance.now();
  try {
    for (const [index, step] of selectedSteps(ctx).entries()) {
      const record = result.failed_step ? skipped(step)
        : step.route_fallback ? await runWithRouteFallback(client, step, index, variables, supplier, ctx)
        : await runStep(client, step, index, variables, supplier.name, ctx);
      result.steps.push(record);
      live.step(record);
      if (record.status === "PASS") Object.assign(variables, record.extracted); // chain ids into later payloads
      else if (record.status === "FAIL") [result.flow_status, result.failed_step] = ["FAIL", step.name];
    }
  } catch (err) { // one broken supplier must never abort the whole run
    log.error(`[${supplier.name}] unexpected error: ${(err as Error).stack ?? err}`);
    result.flow_status = "FAIL";
    result.error = String(err);
  }
  result.duration_ms = Math.round(performance.now() - started);
  return result;
}

/**
 * Primary route first, then the fallbacks; the defaults are used when the supplier has no mapping (and appended
 * after the mapping when append_default_fallbacks is on). Dates are resolved so duplicates collapse.
 */
export function routesFor(supplier: Supplier, cfg: Config, defaultDate: unknown): Required<Route>[] {
  const defaults = [cfg.routes.default_primary, ...cfg.routes.default_fallbacks];
  const mapped = supplier.primaryRoute ? [supplier.primaryRoute, ...(supplier.fallbackRoutes ?? [])] : [];
  const all = mapped.length ? (cfg.routes.append_default_fallbacks ?? true ? [...mapped, ...defaults] : mapped) : defaults;
  const seen = new Set<string>();
  const routes: Required<Route>[] = [];
  for (const r of all) {
    const date = String(resolveVariables({ d: r.date ?? defaultDate }).d);
    const key = `${r.origin}-${r.destination}-${date}`.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      routes.push({ origin: r.origin.toUpperCase(), destination: r.destination.toUpperCase(), date });
    }
  }
  return routes;
}

/**
 * Runs a route-dependent step (Search) over the supplier's routes. A route is abandoned for the next one on a
 * configured HTTP status (400/422/500 by default) or a 2xx without usable offers; the step only FAILs when every
 * route failed. The chosen route's ORIGIN / DESTINATION / DEPARTURE_DATE stay in `variables` for later steps.
 */
async function runWithRouteFallback(
  client: ApiClient, step: StepConfig, index: number, variables: Record<string, unknown>, supplier: Supplier, ctx: RunContext,
): Promise<StepResult> {
  const routes = routesFor(supplier, ctx.config, variables.DEPARTURE_DATE);
  const fallbackStatuses = new Set(ctx.config.routes.fallback_on_status ?? [400, 422, 500]);
  const fatalErrors = (ctx.config.routes.no_fallback_errors ?? []).map((e) => e.toLowerCase());
  const attempts: RouteAttempt[] = [];
  let record: StepResult | undefined;
  for (const [i, route] of routes.entries()) {
    const routeVars = { ORIGIN: route.origin, DESTINATION: route.destination, DEPARTURE_DATE: route.date };
    const label = `${route.origin}-${route.destination} ${route.date}`;
    record = await runStep(client, step, index, { ...variables, ...routeVars }, supplier.name, ctx, i ? `_route${i + 1}` : "");
    attempts.push({
      route: label, status: record.status, http_status: record.http_status, elapsed_ms: record.elapsed_ms,
      correlation_id: record.correlation_id, correlation_ids: record.correlation_ids, error: record.error,
    });
    record.route = label;
    record.route_attempts = attempts;
    if (record.status === "PASS") {
      Object.assign(variables, routeVars);
      return record;
    }
    const httpOk = record.http_status !== null && record.http_status >= 200 && record.http_status < 300;
    const fatal = fatalErrors.find((e) => (record!.error ?? "").toLowerCase().includes(e));
    const canFallback = !fatal && (httpOk || (record.http_status !== null && fallbackStatuses.has(record.http_status)));
    live.routeAttempt(label, record);
    if (fatal) live.warn(`Not a route problem for ${supplier.name} ("${fatal}") - skipping the remaining routes`);
    if (!canFallback || i === routes.length - 1) break;
    live.warn(i === 0
      ? `Primary route failed for ${supplier.name}, retrying with fallback route...`
      : `Fallback route ${label} failed for ${supplier.name}, trying the next fallback...`);
  }
  if (record && attempts.length > 1) record.error = `all ${attempts.length} route(s) failed; last: ${record.error}`;
  return record!;
}

async function runStep(
  client: ApiClient, step: StepConfig, index: number, variables: Record<string, unknown>, supplier: string, ctx: RunContext,
  fileSuffix = "",
): Promise<StepResult> {
  const record: StepResult = { ...skipped(step), status: "FAIL" };
  const tctx = { supplier, step: step.name };
  let payload: unknown;
  try {
    payload = timeline.timeSync("idle", "payload-render", `render ${step.payload}`, tctx,
      () => renderTemplate(loadJson(join(ctx.payloadDir, step.payload)), variables));
  } catch (err) {
    record.error = `payload error: ${(err as Error).message}`;
    return record;
  }

  const res = await client.post(step.endpoint, payload, step.retryable ?? false, tctx);
  Object.assign(record, {
    http_status: res.status, elapsed_ms: res.elapsedMs, attempts: res.attempts,
    correlation_id: Object.values(res.correlationIds)[0] ?? null, correlation_ids: res.correlationIds,
  });
  if (ctx.saveResponses) {
    timeline.timeSync("idle", "file-io", `save ${step.name} response`, tctx, () =>
      writeJson(join(ctx.outputDir, "responses", safeFilename(supplier), `${index + 1}_${step.name}${fileSuffix}.json`), {
        request: { url: res.url, payload },
        response: { status: res.status, elapsed_ms: res.elapsedMs, headers: res.headers, body: res.body, error: res.error },
      }));
  }
  if (res.status !== null) {
    const scanned = timeline.timeSync("masking", "api-response-scan", `scan ${step.name} response`, tctx,
      () => ctx.scanner.scanAll({ headers: res.headers, body: res.body }, { step: step.name }));
    record.response_exposure = scanned.findings.map((f) => ({ ...f, step: step.name, source: "api-response" as const }));
    record.response_verified = scanned.verified.map((v) => ({ ...v, step: step.name, source: "api-response" as const }));
  }

  const businessError = findBusinessError(res.body, ctx.config);
  const missing: string[] = [];
  if (httpOk(res.status)) {
    for (const [name, candidates] of Object.entries(step.extract ?? {})) {
      const value = extractFirst(res.body, candidates);
      if (value === undefined) missing.push(name);
      else record.extracted[name] = value;
    }
  }

  const hasExtract = Object.keys(step.extract ?? {}).length > 0;
  if (httpOk(res.status) && missing.length === 0 && (hasExtract || !businessError)) {
    record.status = "PASS";
    record.warning = businessError;
  } else {
    const reasons = [res.error, businessError,
      missing.length ? `could not extract: ${missing.join(", ")} (response has ${describeTopLevel(res.body)})` : null];
    if (!httpOk(res.status) && res.body && !businessError) reasons.push(`body: ${snippet(res.body)}`);
    record.error = reasons.filter(Boolean).join("; ");
  }
  return record;
}

/** "responseId, offers[0], journeys{}" - shows at a glance why an id was missing (e.g. no offers returned). */
function describeTopLevel(body: unknown): string {
  if (!isRecord(body)) return typeof body === "string" ? `a ${body.length}-char text body` : String(body);
  const parts = Object.entries(body).map(([k, v]) =>
    Array.isArray(v) ? `${k}[${v.length}]` : isRecord(v) ? `${k}{${Object.keys(v).length}}` : k);
  return parts.length ? parts.join(", ") : "an empty object";
}

/**
 * APIs often return HTTP 200 with an error object; surface it. The NDC error body's `context` entries carry the
 * actual reason ("The credentials for the selected supplier do not exist...", "$.supplier could not be converted...").
 */
function findBusinessError(body: unknown, cfg: Config): string | null {
  if (!isRecord(body)) return null;
  const context = getPath(body, "context");
  const details = Array.isArray(context)
    ? context.map((c) => (isRecord(c) ? getPath(c, "value") ?? getPath(c, "name") : c)).filter(Boolean).join(" | ")
    : "";
  const withDetails = (message: string) => (details ? `${message} (${snippet(details, 400)})` : message);
  for (const path of cfg.error_paths ?? []) {
    const value = getPath(body, path);
    const empty = value === undefined || value === null || value === "" ||
      (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
    if (!empty) return withDetails(`${path}: ${snippet(value)}`);
  }
  for (const path of cfg.success_flags ?? []) if (getPath(body, path) === false) return withDetails(`${path}=false`);
  return null;
}
