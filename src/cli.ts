/** Lenient command-line parsing for e2e_validator.ts (see cli()). */
import { parseArgs } from "node:util";

export const OPTIONS = {
  config: { type: "string", default: "config.json" },
  suppliers: { type: "string", default: "suppliers.json" },
  only: { type: "string", default: "" },
  "stop-after": { type: "string", default: "" },
  "validate-at": { type: "string", default: "supplier" },
  headed: { type: "boolean", default: false },
  "skip-ui": { type: "boolean", default: false },
  open: { type: "boolean", default: true },
  "no-open": { type: "boolean", default: false },
  "save-responses": { type: "boolean", default: false },
  "output-dir": { type: "string", default: "reports" },
  verbose: { type: "boolean", short: "v", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

type OptionName = keyof typeof OPTIONS;
export type CliArgs = { [K in OptionName]: (typeof OPTIONS)[K]["type"] extends "string" ? string : boolean };

/**
 * Cleans raw argv before parsing: trims whitespace and strips trailing "\" or "/". Those come from shell
 * line-continuation typos (a bash "\" at a PowerShell line end -> "--open\" or a lone "\").
 * Lone "\" / "/" arguments are dropped.
 */
export function sanitizeArgv(argv: string[]): string[] {
  return argv.map((a) => a.trim().replace(/[\\/]+$/, "").trim()).filter((a) => a.length > 0);
}

/** Closest known option for a mistyped flag ("--head" -> "--headed", "--opne" -> "--open"). */
function suggest(name: string): string | undefined {
  const known = Object.keys(OPTIONS);
  const lower = name.toLowerCase();
  return known.find((k) => k === lower)
    ?? known.find((k) => k.startsWith(lower) || lower.startsWith(k))
    ?? known.find((k) => [...lower].sort().join("") === [...k].sort().join(""));
}

/**
 * Lenient CLI parsing: unknown flags and stray arguments produce warnings instead of ERR_PARSE_ARGS_UNKNOWN_OPTION;
 * a value option given without a value (e.g. `--only` alone) is reported as an error.
 */
export function cli(argv = process.argv.slice(2)): { args: CliArgs; warnings: string[]; errors: string[] } {
  const { values, positionals, tokens } = parseArgs({
    args: sanitizeArgv(argv), options: OPTIONS, strict: false, allowPositionals: true, tokens: true,
  });
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "option" || token.name in OPTIONS) continue;
    const hint = suggest(token.name);
    warnings.push(`unknown option ${token.rawName} ignored${hint ? ` (did you mean --${hint}?)` : ""}`);
  }
  if (positionals.length) warnings.push(`extra argument(s) ignored: ${positionals.map((p) => JSON.stringify(p)).join(" ")}`);

  const args = {} as Record<OptionName, string | boolean>;
  for (const [name, spec] of Object.entries(OPTIONS) as Array<[OptionName, (typeof OPTIONS)[OptionName]]>) {
    const value = values[name];
    if (spec.type === "boolean") {
      args[name] = value === undefined ? spec.default : value === true || String(value).toLowerCase() === "true";
    } else if (typeof value === "boolean") {
      errors.push(`--${name} needs a value, e.g. --${name} ${name === "only" ? '"AJet,FlyNas"' : "<value>"}`);
      args[name] = spec.default;
    } else {
      args[name] = value === undefined ? spec.default : value.trim();
    }
  }
  return { args: args as CliArgs, warnings, errors };
}
