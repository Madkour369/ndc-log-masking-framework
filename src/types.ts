export interface Route {
  origin: string;
  destination: string;
  /** YYYY-MM-DD or relative "+30d"; defaults to variables.DEPARTURE_DATE */
  date?: string;
}

export interface RoutesConfig {
  default_primary: Route;
  default_fallbacks: Route[];
  /** Also try the default routes after a supplier's own mapping is exhausted. */
  append_default_fallbacks?: boolean;
  /** HTTP statuses that trigger the next route (a 2xx without usable offers always does). */
  fallback_on_status?: number[];
  /** Error texts that no other route can fix (bad supplier code, missing credentials) - stop instead of falling back. */
  no_fallback_errors?: string[];
}

export interface StepConfig {
  name: string;
  endpoint: string;
  payload: string;
  retryable?: boolean;
  /** Re-run this step over the supplier's primary + fallback routes until one succeeds (Search). */
  route_fallback?: boolean;
  extract?: Record<string, string[]>;
}

export interface MaskingConfig {
  sensitive_keys: string[];
  sensitive_key_patterns?: string[];
  sensitive_containers?: string[];
  /** Never asserted, in any step - wins over sensitive_keys, patterns and containers. */
  excluded_keys?: string[];
  /** Key -> the only steps in which it is asserted, e.g. { "ExpiryDate": ["book"] }. */
  step_scoped_keys?: Record<string, string[]>;
  ignore_key_patterns?: string[];
  mask_regex?: string;
  known_secrets_env?: string;
  known_secrets_file?: string;
  fail_on_response_exposure?: boolean;
}

export interface DashboardsConfig {
  url: string;
  tenant?: string;
  index_pattern_id?: string;
  index: string;
  correlation_field: string;
  /** Discover time window, e.g. { "from": "now-24h", "label": "Last 24 hours" } or now-15h / "Last 15 hours". */
  time_range?: { from: string; label: string };
  /** When the search-bar query returns 0 hits, retry through "Add filter" (field is value). */
  filter_fallback?: boolean;
  ingest_wait_seconds?: number;
  poll_attempts?: number;
  poll_interval_seconds?: number;
  max_rows_to_expand?: number;
  max_documents?: number;
  fetch_full_documents?: boolean;
  screenshots?: "never" | "on_error" | "always";
  timeout_ms?: number;
  selectors?: Record<string, string>;
}

export interface Config {
  base_url: string;
  request_timeout_seconds?: number;
  verify_ssl?: boolean;
  max_retries?: number;
  retry_backoff_seconds?: number;
  default_headers?: Record<string, string>;
  api_key_header?: string;
  correlation_headers: string[];
  variables: Record<string, unknown>;
  routes: RoutesConfig;
  steps: StepConfig[];
  error_paths?: string[];
  success_flags?: string[];
  masking: MaskingConfig;
  dashboards: DashboardsConfig;
}

export interface Supplier {
  /** Display name used in logs and reports. */
  name: string;
  /** Value of the API's Supplier enum when it differs from the display name (e.g. "Air Cairo" -> "AirCairo"). */
  code?: string;
  enabled?: boolean;
  variables: Record<string, unknown>;
  primaryRoute?: Route;
  fallbackRoutes?: Route[];
}

export interface Finding {
  rule: string;
  location: string;
  key: string;
  evidence: string; // always redacted
  /** What the exposed value looks like: "plain text", "JWT", "Basic credential", "partially masked", ... */
  kind?: string;
  /** Step whose logs / response contained it (set by the Dashboards check and the API flow). */
  step?: string;
  source?: "ui-dom" | "full-document" | "api-response";
  doc?: string;
}

/** A target field whose value passed the strict ^\*+$ assertion. The value is asterisks only, so safe to print. */
export interface VerifiedMask {
  key: string;
  value: string;
  rule: string;
  location: string;
  /** How many times this field + masked value was seen in the step's logs / response. */
  count: number;
  source?: "ui-dom" | "full-document" | "api-response";
  doc?: string;
  step?: string;
}

export type StepStatus = "PASS" | "FAIL" | "SKIPPED";
export type MaskingVerdict = "PASS" | "FAIL" | "NO_LOGS" | "ERROR" | "NOT_RUN" | "NO_CORRELATION_ID";

export interface StepResult {
  step: string;
  endpoint: string;
  status: StepStatus;
  http_status: number | null;
  elapsed_ms: number;
  attempts: number;
  correlation_id: string | null;
  correlation_ids: Record<string, string>;
  extracted: Record<string, string | number>;
  error: string | null;
  warning: string | null;
  response_exposure: Finding[];
  /** Target fields in the API response that were correctly masked. */
  response_verified?: VerifiedMask[];
  /** Route that produced this result (route_fallback steps only), e.g. "CAI-RUH 2026-10-20". */
  route?: string | null;
  route_attempts?: RouteAttempt[];
}

export interface RouteAttempt {
  route: string;
  status: StepStatus;
  http_status: number | null;
  elapsed_ms: number;
  correlation_id: string | null;
  correlation_ids: Record<string, string>;
  error: string | null;
}

export interface MaskingEntry {
  step: string;
  correlation_ids: string[];
  verdict: MaskingVerdict;
  hits: number;
  findings: Finding[];
  /** Target fields in this step's logs that passed the strict masking assertion. */
  verified?: VerifiedMask[];
  error: string | null;
  kql: string | null;
  /** How the logs were found in Discover: search-bar query, or the "Add filter" fallback. */
  search_method?: "query" | "filter" | null;
}

export type OverallVerdict = "PASS" | "FAIL" | "BLOCKED";

export interface SupplierResult {
  supplier: string;
  /** Final verdict: FAIL if any API step or the masking check failed; PASS only if both passed. */
  overall: OverallVerdict | null;
  overall_reason: string | null;
  flow_status: "PASS" | "FAIL";
  failed_step: string | null;
  error: string | null;
  duration_ms: number;
  steps: StepResult[];
  masking: MaskingEntry[];
  masking_verdict: "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_RUN" | null;
}
