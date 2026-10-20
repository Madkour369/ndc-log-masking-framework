/**
 * Detects credentials that are NOT masked (e.g. <Password>abc</Password> instead of ********).
 *
 * Works on any JSON-like value (an OpenSearch `_source`, scraped DOM text, an API response):
 *  - structured fields whose key is sensitive and whose value is not masked;
 *  - free text inside strings: JSON fragments (incl. escaped / double-encoded JSON, as found in the
 *    `body` field of the NDC logs), XML elements and attributes (SOAP/NDC supplier payloads),
 *    key=value strings, raw HTTP header lines and Basic/Bearer tokens;
 *  - literal occurrences of known real secret values (strongest check, see KNOWN_SECRETS).
 *
 * Evidence is always redacted so reports never re-leak what was found.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, MaskingConfig, VerifiedMask } from "./types";
import { isRecord } from "./utils";

const TEXT_RULES: Array<[string, RegExp]> = [
  ["json-text", /"([\w.:-]{1,64})"\s*:\s*"([^"]*)"/g],
  ["xml-element", /<(?:[\w.-]+:)?([\w.-]{1,64})(?:\s[^<>]*)?>([^<]*)<\/(?:[\w.-]+:)?\1\s*>/g],
  ["xml-attribute", /([\w.:-]{1,64})\s*=\s*"([^"]*)"/g],
  ["key-value", /(?<![\w.-])([\w.-]{1,64})=([^&\s;,"'<>]+)/g],
  ["header-line", /^[ \t]*([\w-]{1,64})[ \t]*:[ \t]*(\S[^\r\n]*?)[ \t]*$/gim],
];
const AUTH_SCHEME = /\b(Basic|Bearer|Digest|NTLM)\s+([A-Za-z0-9+/=._~-]{8,})/g;
const SCHEME_PREFIX = /^(Basic|Bearer|Digest|NTLM)\s+/i;
const MAX_JSON_DEPTH = 4;

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

export function redact(value: unknown): string {
  const text = String(value);
  return text.length <= 4 ? `${"*".repeat(text.length)} (${text.length} chars)` : `${text.slice(0, 2)}****** (${text.length} chars)`;
}

/** Real credential values that must never appear in logs (env var and/or git-ignored file). */
export function loadKnownSecrets(cfg: MaskingConfig, root: string): string[] {
  const secrets = (process.env[cfg.known_secrets_env ?? "KNOWN_SECRETS"] ?? "").split(",").map((s) => s.trim());
  const file = cfg.known_secrets_file ? join(root, cfg.known_secrets_file) : "";
  if (file && existsSync(file)) {
    secrets.push(...readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  }
  return [...new Set(secrets)].filter((s) => s.length >= 4);
}

/** What an exposed value looks like - shown instead of the value itself. */
export function valueKind(value: unknown): string {
  const v = String(value).trim().replace(/^['"]+|['"]+$/g, "");
  if (/^(Basic|Bearer|Digest|NTLM)\s/i.test(v)) return `${v.split(/\s/)[0]} credential`;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(v)) return "JWT";
  if (/\*/.test(v)) return "partially masked";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(v)) return "GUID / API key";
  if (/^\d+$/.test(v)) return "numeric";
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(v)) return "opaque token / base64";
  return "plain text";
}

export interface ScannerOptions {
  /**
   * Exact key names, compared case-, dash- and underscore-insensitively ("client_secret" == "clientSecret").
   * Dotted entries ("credentials.username", "data.token") match only under that parent path.
   */
  keys: string[];
  /** Containers whose EVERY non-empty value must be masked, e.g. "paymentFields", "UniversalRecord.card". */
  containers?: string[];
  /** A key is also sensitive if its normalized name CONTAINS one of these, e.g. "agentUserName", "X-Auth-Token". */
  patterns?: string[];
  /** ...unless it contains one of these (metadata such as "tokenType", "passwordExpiry"). Exact keys always count. */
  ignore?: string[];
  /** Literal secret values that must never appear anywhere. */
  secrets?: string[];
  /** A value is masked only if it fully matches this (default: asterisks only, "^\*+$"). */
  maskRegex?: string;
  /**
   * Keys that are never asserted in any step (no [SECURITY FAIL], no [VERIFIED MASKED]). Wins over keys, patterns
   * and containers. Excluding "Authorization" also turns off the stand-alone Basic/Bearer token rule.
   */
  excluded?: string[];
  /** Key -> the only steps it is asserted in, e.g. { ExpiryDate: ["book"] }. Scans without a step assert it. */
  stepScoped?: Record<string, string[]>;
}

export interface ScanOptions {
  /** Step whose logs / response are being scanned (enables step_scoped_keys). */
  step?: string;
}

export interface ScanResult {
  /** Target fields with a plain-text / partially masked value -> [SECURITY FAIL]. */
  findings: Finding[];
  /** Target fields whose value is all asterisks -> [VERIFIED MASKED], de-duplicated per field + value. */
  verified: VerifiedMask[];
}

interface ScanState {
  found: Map<string, Finding>;
  verified: Map<string, VerifiedMask>;
  step?: string;
}

type MaskState = "empty" | "masked" | "exposed";
const isScalar = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";

/** Scanner configured from config.json → masking (plus extra literal secrets such as the run's own API key). */
export function createScanner(cfg: MaskingConfig, root: string, extraSecrets: string[] = []): LeakScanner {
  return new LeakScanner({
    keys: cfg.sensitive_keys,
    patterns: cfg.sensitive_key_patterns,
    ignore: cfg.ignore_key_patterns,
    containers: cfg.sensitive_containers,
    excluded: cfg.excluded_keys,
    stepScoped: cfg.step_scoped_keys,
    secrets: [...new Set([...loadKnownSecrets(cfg, root), ...extraSecrets.filter((s) => s.length >= 4)])],
    maskRegex: cfg.mask_regex,
  });
}

export class LeakScanner {
  private readonly keys: Set<string>;
  private readonly pathKeys: string[][];
  private readonly containerKeys: Set<string>;
  private readonly containerPaths: string[][];
  private readonly containerNames: Map<string, string>;
  private readonly patterns: string[];
  private readonly ignore: string[];
  private readonly secrets: string[];
  private readonly maskRe: RegExp;
  private readonly excluded: Set<string>;
  private readonly stepScoped: Map<string, Set<string>>;

  constructor(options: ScannerOptions) {
    this.excluded = new Set((options.excluded ?? []).map(norm));
    this.stepScoped = new Map(Object.entries(options.stepScoped ?? {})
      .map(([key, steps]) => [norm(key), new Set(steps.map((s) => s.toLowerCase()))]));
    const split = (entries: string[]) => ({
      leaf: new Set(entries.filter((k) => !k.includes(".")).map(norm)),
      paths: entries.filter((k) => k.includes(".")).map((k) => k.split(".").map(norm)),
    });
    const keys = split(options.keys);
    const containers = split(options.containers ?? []);
    this.keys = keys.leaf;
    this.pathKeys = keys.paths;
    this.containerKeys = containers.leaf;
    this.containerPaths = containers.paths;
    this.containerNames = new Map((options.containers ?? []).filter((k) => k.includes("."))
      .map((k) => [k.split(".").map(norm).join("."), k]));
    this.patterns = (options.patterns ?? []).map(norm).filter(Boolean);
    this.ignore = (options.ignore ?? []).map(norm).filter(Boolean);
    this.secrets = options.secrets ?? [];
    this.maskRe = new RegExp(`^(?:${options.maskRegex ?? "\\*+"})$`);
  }

  /** Exposed target fields only (kept for callers that don't need the verified list). */
  scan(value: unknown): Finding[] {
    return this.scanAll(value).findings;
  }

  scanAll(value: unknown, options: ScanOptions = {}): ScanResult {
    const state: ScanState = { found: new Map(), verified: new Map(), step: options.step };
    this.walk(value, "$", [], state, 0, null);
    return { findings: [...state.found.values()], verified: [...state.verified.values()] };
  }

  /**
   * True if the key must NOT be asserted: it is in `excluded`, or it is step-scoped and `step` is not one of its
   * steps. Also used to re-apply the rules to findings stored in an existing report.json.
   */
  isSuppressed(key: string, step?: string | null): boolean {
    const leaf = norm(key.replace(/:/g, ".").split(".").pop() ?? key);
    if (this.excluded.has(leaf)) return true;
    const steps = this.stepScoped.get(leaf);
    return !!(steps && step && !steps.has(step.toLowerCase()));
  }

  /** `trail` = normalized parent keys, used for dotted entries such as "credentials.username". */
  isSensitive(key: string, trail: string[] = [], step?: string): boolean {
    if (this.isSuppressed(key, step)) return false;
    const leaf = norm(key.replace(/:/g, ".").split(".").pop() ?? key);
    if (this.keys.has(leaf) || endsWithPath([...trail, leaf], this.pathKeys)) return true;
    if (this.ignore.some((i) => leaf.includes(i))) return false;
    return this.patterns.some((p) => leaf.includes(p));
  }

  /** Label of the matched container ("paymentFields", "UniversalRecord.card"), or null. */
  private containerLabel(key: string, trail: string[]): string | null {
    const leaf = norm(key);
    if (this.containerKeys.has(leaf)) return key;
    const path = this.containerPaths.find((p) => endsWithPath([...trail, leaf], [p]));
    return path ? this.containerNames.get(path.join(".")) ?? key : null;
  }

  /** Strict: only a value that fully matches the mask (asterisks) is masked. Empty / null exposes nothing. */
  maskState(value: unknown): MaskState {
    const text = String(value).trim().replace(/^['"]+|['"]+$/g, "").replace(SCHEME_PREFIX, "");
    if (!text || ["null", "none", "undefined"].includes(text.toLowerCase())) return "empty";
    return this.maskRe.test(text) ? "masked" : "exposed";
  }

  isMasked(value: unknown): boolean {
    return this.maskState(value) !== "exposed";
  }

  /** The single assertion every target value goes through. */
  private assert(state: ScanState, rule: string, location: string, key: string, value: unknown): void {
    const verdict = this.maskState(value);
    if (verdict === "exposed") this.addFinding(state, rule, location, key, value);
    else if (verdict === "masked") {
      const text = String(value).trim();
      const id = `${norm(key)}|${text}`;
      const existing = state.verified.get(id);
      if (existing) existing.count++;
      else state.verified.set(id, { key, value: text, rule, location, count: 1 });
    }
  }

  private addFinding(state: ScanState, rule: string, location: string, key: string, value: unknown): void {
    const dedupe = String(value).trim().replace(SCHEME_PREFIX, ""); // same value via several rules -> report once
    if (!state.found.has(dedupe)) state.found.set(dedupe, { rule, location, key, evidence: redact(value), kind: valueKind(value) });
  }

  private walk(node: unknown, path: string, trail: string[], state: ScanState, depth: number, container: string | null): void {
    if (Array.isArray(node)) {
      node.forEach((item, i) => this.walk(item, `${path}[${i}]`, trail, state, depth, container));
    } else if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        const child = `${path}.${key}`;
        const opened = container ? null : this.containerLabel(key, trail);
        const childContainer = container ?? opened;
        const items = Array.isArray(value) ? value.filter(isScalar) : isScalar(value) ? [value] : [];
        if (childContainer) {
          // inside paymentFields / UniversalRecord.card: every value must be masked, whatever the field is called
          const label = opened ? opened : `${childContainer}.${key}`;
          if (!this.isSuppressed(key, state.step)) {
            for (const item of items) this.assert(state, "sensitive-container", child, label, item);
          }
        } else if (this.isSensitive(key, trail, state.step)) {
          for (const item of items) this.assert(state, "structured-field", child, key, item);
        }
        this.walk(value, child, [...trail, norm(key)], state, depth, childContainer);
      }
    } else if (typeof node === "string") {
      this.scanText(node, path, state);
      const s = node.trim();
      const looksEncoded = s.length > 1 && (s[0] === "{" || s[0] === "[" || (s[0] === '"' && s.endsWith('"')));
      if (depth < MAX_JSON_DEPTH && looksEncoded) {
        try {
          const parsed: unknown = JSON.parse(s);
          if ((typeof parsed === "object" && parsed !== null) || typeof parsed === "string") {
            this.walk(parsed, `${path}<json>`, trail, state, depth + 1, container);
          }
        } catch {
          // not JSON - the text rules above already covered it
        }
      }
    }
  }

  private scanText(text: string, path: string, state: ScanState): void {
    const plain = unescapeLogText(text);
    for (const secret of this.secrets) {
      if (text.includes(secret) || plain.includes(secret)) this.addFinding(state, "known-secret", path, "<known secret value>", secret);
    }
    for (const [rule, regex] of TEXT_RULES) {
      for (const m of plain.matchAll(regex)) {
        if (this.isSensitive(m[1], [], state.step)) this.assert(state, rule, path, m[1], m[2]);
      }
    }
    // a stand-alone "Basic/Bearer <token>" is an Authorization value: excluding Authorization excludes this rule too
    if (this.isSuppressed("authorization", state.step)) return;
    for (const m of plain.matchAll(AUTH_SCHEME)) {
      const token = m[2];
      if (token.length >= 16 || /[\d+/=]/.test(token)) this.addFinding(state, "auth-scheme", path, m[1], token);
    }
  }
}

/** True if `trail` ends with one of the dotted paths (all segments already normalized). */
function endsWithPath(trail: string[], paths: string[][]): boolean {
  return paths.some((p) => p.length <= trail.length && p.every((seg, i) => seg === trail[trail.length - p.length + i]));
}

/** Undo common log escaping layers: \" -> ", \n -> newline, &lt; -> <. */
export function unescapeLogText(text: string): string {
  for (let i = 0; i < 3; i++) {
    const next = text.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\r/g, "");
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}
