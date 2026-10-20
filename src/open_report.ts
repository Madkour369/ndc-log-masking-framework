/** Opens reports/latest_report.html (or the path given as first argument) in the default browser. */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function openFile(path: string): void {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [path]]
    : process.platform === "darwin" ? ["open", [path]] : ["xdg-open", [path]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

/** reports/latest_report.html if present, else the newest reports/<run-id>/report.html. */
export function latestReport(reportsDir: string): string | null {
  const latest = join(reportsDir, "latest_report.html");
  if (existsSync(latest)) return latest;
  if (!existsSync(reportsDir)) return null;
  const runs = readdirSync(reportsDir).filter((d) => existsSync(join(reportsDir, d, "report.html"))).sort();
  return runs.length ? join(reportsDir, runs[runs.length - 1], "report.html") : null;
}

/** Auto-open is on by default; off with --no-open, or when CI / NO_OPEN is set (headless build agents). */
export const autoOpenEnabled = (noOpenFlag: boolean) => !noOpenFlag && !process.env.CI && !process.env.NO_OPEN;

/**
 * Final step of every run / re-render: print the clickable file:// link and open it in the browser.
 * `print` defaults to console.log; e2e passes its logger so the line also lands in run.log.
 */
export function reportReady(path: string, open: boolean, print: (line: string) => void = console.log): void {
  print(`[REPORT READY] View Report: ${pathToFileURL(path).href}`);
  if (open) openFile(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const target = process.argv[2] ? resolve(process.argv[2]) : latestReport(join(root, "reports"));
  if (!target || !existsSync(target)) {
    console.error("No report found - run `npm run e2e` first.");
    process.exit(1);
  }
  reportReady(target, true);
}
