/** Small helpers: JSON IO, payload templating, response-value extraction, logging. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0) || (isRecord(v) && Object.keys(v).length === 0);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function loadJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function loadEnvFile(path: string): void {
  // Node's built-in parser; real environment variables are not overridden.
  if (existsSync(path)) process.loadEnvFile(path);
}

const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Replaces "${NAME}" in every string of a config object with process.env.NAME, so environment-specific values
 * (hosts, tenant, index) live in the git-ignored .env instead of config.json. Unset variables become "".
 */
export function resolveEnvPlaceholders<T>(value: T): { value: T; missing: string[] } {
  const missing = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.replace(ENV_PLACEHOLDER, (_, name: string) => {
        const v = process.env[name];
        if (v === undefined || v === "") missing.add(name);
        return v ?? "";
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  return { value: walk(value) as T, missing: [...missing] };
}

export const safeFilename =(name: string) => name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";

export function snippet(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

const RELATIVE_DATE = /^\+(\d+)d$/;

/** Expand dynamic values, e.g. DEPARTURE_DATE "+30d" -> today + 30 days (YYYY-MM-DD). */
export function resolveVariables(vars: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => {
    const m = typeof v === "string" ? RELATIVE_DATE.exec(v) : null;
    return [k, m ? new Date(Date.now() + Number(m[1]) * 86_400_000).toISOString().slice(0, 10) : v];
  }));
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;

/**
 * Recursively substitute {{NAME}} placeholders. A string that is only a placeholder keeps the raw
 * value type; embedded placeholders are substituted as text. Unknown names throw, so typos fail loudly.
 */
export function renderTemplate(node: unknown, vars: Record<string, unknown>): unknown {
  const lookup = (name: string): unknown => {
    if (!Object.hasOwn(vars, name)) throw new Error(`Template variable '{{${name}}}' is not defined`);
    return vars[name];
  };
  if (Array.isArray(node)) return node.map((item) => renderTemplate(item, vars));
  if (isRecord(node)) {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [String(renderTemplate(k, vars)), renderTemplate(v, vars)]));
  }
  if (typeof node === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(node.trim());
    if (whole) return lookup(whole[1]);
    return node.replace(PLACEHOLDER, (_, name: string) => String(lookup(name)));
  }
  return node;
}

const PATH_TOKEN = /([^.[\]]+)|\[(\d+|\*)\]/g;

/**
 * Resolve "a.b[0].c" with case-insensitive keys; undefined when any segment is missing.
 * "[*]" tries every array element and returns the first non-empty result (e.g. "offers[*].offerId").
 */
export function getPath(obj: unknown, path: string): unknown {
  let current = obj;
  const tokens = [...path.matchAll(PATH_TOKEN)];
  for (const [i, [, name, index]] of tokens.entries()) {
    if (index === "*") {
      if (!Array.isArray(current)) return undefined;
      const rest = tokens.slice(i + 1).map((t) => (t[2] !== undefined ? `[${t[2]}]` : `.${t[1]}`)).join("").replace(/^\./, "");
      for (const item of current) {
        const value = rest ? getPath(item, rest) : item;
        if (!isEmpty(value)) return value;
      }
      return undefined;
    }
    if (index !== undefined) {
      if (!Array.isArray(current) || Number(index) >= current.length) return undefined;
      current = current[Number(index)];
      continue;
    }
    if (!isRecord(current)) return undefined;
    const key = Object.hasOwn(current, name) ? name : Object.keys(current).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key === undefined) return undefined;
    current = current[key];
  }
  return current;
}

/** Breadth-first search for the shallowest non-empty value stored under `key`. */
export function findKey(obj: unknown, key: string): unknown {
  const target = key.toLowerCase();
  const queue: unknown[] = [obj];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
    } else if (isRecord(node)) {
      for (const [k, v] of Object.entries(node)) if (k.toLowerCase() === target && !isEmpty(v)) return v;
      for (const v of Object.values(node)) queue.push(v);
    }
  }
  return undefined;
}

/** Try each candidate in order. "**.name" means a deep search for key `name`. */
export function extractFirst(body: unknown, candidates: string[]): string | number | undefined {
  for (const candidate of candidates) {
    const value = candidate.startsWith("**.") ? findKey(body, candidate.slice(3)) : getPath(body, candidate);
    if ((typeof value === "string" && value.trim()) || typeof value === "number") return value;
  }
  return undefined;
}

// ---------------------------------------------------------------- logging
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const COLORS: Record<string, string> = {
  PASS: "\x1b[32m", FAIL: "\x1b[31m", ERROR: "\x1b[31m", WARN: "\x1b[33m", INCONCLUSIVE: "\x1b[33m",
  NO_LOGS: "\x1b[33m", NO_CORRELATION_ID: "\x1b[33m", BLOCKED: "\x1b[35m", SKIPPED: "\x1b[90m", NOT_RUN: "\x1b[90m", HEAD: "\x1b[1;36m",
};

export const paint = (text: string, tone: string): string =>
  useColor && COLORS[tone] ? `${COLORS[tone]}${text}\x1b[0m` : text;

class Logger {
  private file?: string;
  private verbose = false;

  configure(file: string, verbose: boolean): void {
    mkdirSync(dirname(file), { recursive: true });
    this.file = file;
    this.verbose = verbose;
  }

  private write(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
    (level === "ERROR" ? console.error : console.log)(paint(line, level));
    if (this.file) appendFileSync(this.file, `${line}\n`, "utf8");
  }

  /** Raw console line (may contain colours) without timestamp; written uncoloured to run.log. */
  line = (text = "") => {
    console.log(text);
    if (this.file) appendFileSync(this.file, `${text.replace(/\x1b\[[0-9;]*m/g, "")}\n`, "utf8");
  };

  debug = (m: string) => { if (this.verbose) this.write("DEBUG", m); };
  info = (m: string) => this.write("INFO", m);
  warn = (m: string) => this.write("WARN", m);
  error = (m: string) => this.write("ERROR", m);
}

export const log = new Logger();
