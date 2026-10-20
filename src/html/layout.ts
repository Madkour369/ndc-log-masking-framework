/** Shared building blocks for the report pages: theme, page shell, badges, small SVG charts, links. */
import type { ReportMeta } from "../report";
import { formatDuration } from "../report";
import { safeFilename } from "../utils";

export const esc = (value: unknown) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const badge = (value: string | null | undefined, extra = "") =>
  `<span class="b ${esc(value ?? "NA")}${extra ? ` ${extra}` : ""}">${esc(value ?? "-")}</span>`;

export const ms = (value: number) => formatDuration(value);
export const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "0.0%");
/** In-file anchors of the single-file report (used as "#<id>" links). */
export const supplierView = (supplier: string) => `sup-${safeFilename(supplier)}`;
export const stepAnchor = (supplier: string, step: string) => `${supplierView(supplier)}-step-${safeFilename(step)}`;
export const timeRow = (supplier: string) => `time-${supplierView(supplier)}`;

/** JSON for a <script type="application/json"> block; "<" is escaped so the data can never close the tag. */
export const jsonScript = (id: string, data: unknown) =>
  `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

/** Deep link into OpenSearch Dashboards Discover with the tenant, index pattern, time window and KQL preset. */
export function discoverUrl(meta: ReportMeta, kql: string | null): string | null {
  if (!meta.dashboards_url || !meta.index_pattern_id || !kql) return null;
  const rison = (s: string) => `'${s.replace(/!/g, "!!").replace(/'/g, "!'")}'`;
  const base = meta.dashboards_url.replace(/\/?$/, "/");
  const tenant = meta.tenant ? `?security_tenant=${encodeURIComponent(meta.tenant)}` : "";
  return `${base}app/data-explorer/discover${tenant}#?_a=(discover:(columns:!(_source),isDirty:!f,sort:!()),`
    + `metadata:(indexPattern:'${meta.index_pattern_id}',view:discover))`
    + `&_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:${meta.time_from ?? "now-24h"},to:now))`
    + `&_q=(filters:!(),query:(language:kuery,query:${encodeURIComponent(rison(kql))}))`;
}

/** Ring chart. segments: [value, css colour var]. */
export function ring(segments: Array<[number, string]>, center: string, sub: string, size = 132): string {
  const r = 52;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((n, [v]) => n + v, 0);
  let offset = 0;
  const arcs = total
    ? segments.filter(([v]) => v > 0).map(([v, color]) => {
      const len = (v / total) * c;
      const arc = `<circle r="${r}" cx="66" cy="66" fill="none" stroke="var(${color})" stroke-width="16" `
        + `stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 66 66)"/>`;
      offset += len;
      return arc;
    }).join("")
    : "";
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 132 132" role="img" aria-label="${esc(center)} ${esc(sub)}">`
    + `<circle r="${r}" cx="66" cy="66" fill="none" stroke="var(--track)" stroke-width="16"/>${arcs}`
    + `<text x="66" y="64" text-anchor="middle" class="ring-v">${esc(center)}</text>`
    + `<text x="66" y="84" text-anchor="middle" class="ring-l">${esc(sub)}</text></svg>`;
}

export const CSS = `
:root{--bg:#f5f7fa;--panel:#fff;--text:#1f2328;--muted:#5b6672;--bd:#d8dee4;--track:#e7ebef;--head:#0d2b45;--head-text:#fff;
--pass:#1a7f37;--pass-bg:#dafbe1;--fail:#cf222e;--fail-bg:#ffebe9;--block:#8250df;--block-bg:#f3ebff;--warn:#9a6700;--warn-bg:#fff8c5;
--skip:#57606a;--skip-bg:#eaeef2;--c-network:#2f81f7;--c-opensearch:#d4a72c;--c-masking:#bf3989;--c-idle:#8c959f;--link:#0969da;--shadow:0 1px 2px rgba(31,35,40,.06)}
[data-theme=dark]{--bg:#0d1117;--panel:#161b22;--text:#e6edf3;--muted:#8d96a0;--bd:#30363d;--track:#262c36;--head:#010409;--head-text:#e6edf3;
--pass:#3fb950;--pass-bg:#122d1c;--fail:#f85149;--fail-bg:#3a1418;--block:#bc8cff;--block-bg:#2a1f3d;--warn:#d29922;--warn-bg:#2f2410;
--skip:#8d96a0;--skip-bg:#21262d;--link:#4493f8;--shadow:none}
*{box-sizing:border-box} html{scroll-padding-top:84px}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 "Segoe UI",system-ui,-apple-system,Arial,sans-serif}
a{color:var(--link);text-decoration:none} a:hover{text-decoration:underline}
header.top{position:sticky;top:0;z-index:20;background:var(--head);color:var(--head-text);padding:10px 28px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;box-shadow:0 2px 6px rgba(0,0,0,.25)}
header.top h1{font-size:17px;margin:0;font-weight:650} header.top .run{opacity:.75;font-size:12.5px}
header.top nav{display:flex;gap:4px;margin-left:8px} header.top nav a{color:var(--head-text);opacity:.8;padding:5px 10px;border-radius:6px}
header.top nav a.on,header.top nav a:hover{opacity:1;background:rgba(255,255,255,.12);text-decoration:none}
.chips{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
.chip{background:rgba(255,255,255,.1);border-radius:999px;padding:4px 12px;font-size:12.5px;white-space:nowrap} .chip b{font-weight:650}
#theme{border:1px solid rgba(255,255,255,.3);background:transparent;color:var(--head-text);border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
main{padding:22px 28px 56px;max-width:1500px;margin:0 auto} h2{font-size:16px;margin:30px 0 12px} h3{font-size:14px;margin:18px 0 8px}
.panel{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
.hero{display:grid;grid-template-columns:auto auto 1fr;gap:18px;align-items:stretch} @media(max-width:1000px){.hero{grid-template-columns:1fr}}
.hero .panel{display:flex;gap:16px;align-items:center}
.legend{display:grid;gap:4px;font-size:13px} .legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.ring-v{font-size:22px;font-weight:700;fill:var(--text)} .ring-l{font-size:10.5px;fill:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.kpi{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}
.kpi .v{font-size:24px;font-weight:700;line-height:1.2} .kpi .l{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.kpi.pass .v{color:var(--pass)} .kpi.fail .v{color:var(--fail)} .kpi.block .v{color:var(--block)}
.b{display:inline-block;padding:2px 9px;border-radius:999px;font-weight:650;font-size:11.5px;white-space:nowrap;letter-spacing:.02em}
.PASS{background:var(--pass-bg);color:var(--pass)} .FAIL,.ERROR{background:var(--fail-bg);color:var(--fail)} .BLOCKED{background:var(--block-bg);color:var(--block)}
.SKIPPED,.NOT_RUN,.NA{background:var(--skip-bg);color:var(--skip)} .NO_LOGS,.INCONCLUSIVE,.NO_CORRELATION_ID,.WARN{background:var(--warn-bg);color:var(--warn)}
.b.lg{font-size:13px;padding:4px 12px}
table{border-collapse:collapse;width:100%;font-size:13px} th,td{border-bottom:1px solid var(--bd);padding:7px 10px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
th.sort{cursor:pointer} th.sort:after{content:" \\2195";opacity:.4} td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover td{background:color-mix(in srgb,var(--text) 4%,transparent)}
code{font:12px Consolas,"SF Mono",monospace;word-break:break-all} .muted{color:var(--muted)} .nw{white-space:nowrap}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.toolbar button,.toolbar select,.toolbar input{border:1px solid var(--bd);background:var(--panel);color:var(--text);border-radius:8px;padding:6px 12px;font:inherit;font-size:13px}
.toolbar button{cursor:pointer} .toolbar button.on{background:var(--head);color:var(--head-text);border-color:var(--head)} .toolbar input{min-width:220px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--bd);border-left:4px solid var(--skip);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;box-shadow:var(--shadow)}
.card[data-status=PASS]{border-left-color:var(--pass)} .card[data-status=FAIL]{border-left-color:var(--fail)} .card[data-status=BLOCKED]{border-left-color:var(--block)}
.card .hd{display:flex;justify-content:space-between;gap:10px;align-items:start} .card .nm{font-weight:650;font-size:15px}
.card .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:12px} .card .stats div{background:var(--bg);border-radius:8px;padding:6px 8px}
.card .stats b{display:block;font-size:15px} .card .stats .bad b{color:var(--fail)} .card .stats .good b{color:var(--pass)}
.steps{display:flex;gap:6px;flex-wrap:wrap} .steps a{font-size:11.5px;padding:3px 8px;border-radius:6px;font-weight:600}
.card .reason{font-size:12.5px;color:var(--muted);min-height:1em} .card .ft{display:flex;gap:14px;font-size:12.5px;margin-top:auto}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--track)} .bar span{display:block;height:100%}
.sec{color:var(--fail);font-weight:600} ul.list{margin:0;padding-left:18px} ul.list li{margin:5px 0}
dialog{border:1px solid var(--bd);border-radius:14px;background:var(--panel);color:var(--text);width:min(1100px,94vw);max-height:86vh;padding:0;box-shadow:0 12px 40px rgba(0,0,0,.35)}
dialog::backdrop{background:rgba(1,4,9,.55)} dialog .dh{position:sticky;top:0;background:var(--panel);padding:14px 18px;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;gap:12px;align-items:center}
dialog .db{padding:12px 18px 18px} dialog button.x{border:1px solid var(--bd);background:var(--bg);color:var(--text);border-radius:8px;padding:4px 10px;cursor:pointer;font:inherit}
footer{color:var(--muted);font-size:12px;margin-top:40px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:13px} .kv dt{color:var(--muted)} .kv dd{margin:0}
.stepcard{scroll-margin-top:84px} .stepcard .hd{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px} .stepcard .hd h3{margin:0;font-size:15px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px} @media(max-width:1000px){.cols{grid-template-columns:1fr}}
svg text{font-family:inherit} .clickable{cursor:pointer} .clickable:hover{opacity:.82}
.view{display:none} .view.on{display:block}
.flash{outline:2px solid var(--link);outline-offset:2px;border-radius:8px}
#pick{border:1px solid rgba(255,255,255,.3);background:transparent;color:var(--head-text);border-radius:6px;padding:5px 8px;font:inherit;max-width:190px}
#pick option{color:#1f2328}
`;

const THEME_HEAD = `<script>(function(){try{var t=localStorage.getItem("ndc-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t;}catch(e){}})();</script>`;
const THEME_JS = `document.getElementById("theme").addEventListener("click",function(){var d=document.documentElement,t=d.dataset.theme==="dark"?"light":"dark";d.dataset.theme=t;try{localStorage.setItem("ndc-theme",t)}catch(e){}this.textContent=t==="dark"?"\\u2600 Light":"\\u263E Dark";});
document.getElementById("theme").textContent=document.documentElement.dataset.theme==="dark"?"\\u2600 Light":"\\u263E Dark";`;

/** A view (tab) of the single-file report. Exactly one view is visible at a time. */
export interface View {
  id: string;
  html: string;
  script?: string;
}

export interface ShellOptions {
  meta: ReportMeta;
  chips: string[];
  views: View[];
  /** [view id, label] for the supplier picker in the header */
  suppliers: Array<[string, string]>;
}

/**
 * Hash router: "#<id>" shows the view that contains the element with that id (the view itself, or e.g. a step
 * section inside a supplier view) and scrolls to it. Works from file://, supports Back/Forward and deep links.
 */
const ROUTER_JS = `
(function(){var views=[].slice.call(document.querySelectorAll(".view")),pick=document.getElementById("pick");
function show(){var id=decodeURIComponent(location.hash.slice(1))||"overview",target=document.getElementById(id);
if(!target||!target.closest(".view"))target=document.getElementById("overview");var view=target.closest(".view");
views.forEach(function(v){v.classList.toggle("on",v===view)});
document.querySelectorAll("header.top nav a").forEach(function(a){a.classList.toggle("on",a.dataset.view===view.id)});
pick.value=view.id.indexOf("sup-")===0?view.id:"";document.title=(view.dataset.title||"Report")+" - "+document.body.dataset.run;
document.querySelectorAll(".flash").forEach(function(e){e.classList.remove("flash")});
if(target!==view){target.classList.add("flash");setTimeout(function(){target.scrollIntoView({block:"start"})},0);}else{window.scrollTo(0,0);}}
pick.addEventListener("change",function(){if(this.value)location.hash=this.value;});
window.addEventListener("hashchange",show);show();})();`;

export function shell(o: ShellOptions): string {
  const nav = [["overview", "Overview"], ["time", "Time breakdown"]]
    .map(([id, label]) => `<a href="#${id}" data-view="${id}">${label}</a>`).join("");
  const options = o.suppliers.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NDC Log-Masking QA - ${esc(o.meta.run_id)}</title>${THEME_HEAD}<style>${CSS}</style></head><body data-run="${esc(o.meta.run_id)}">
<header class="top"><h1>NDC Log-Masking QA</h1><span class="run">Run ${esc(o.meta.run_id)} &middot; ${esc(o.meta.started_at.replace("T", " ").slice(0, 19))} UTC</span>
<nav>${nav}</nav><select id="pick" aria-label="Go to supplier"><option value="">Supplier...</option>${options}</select>
<div class="chips">${o.chips.join("")}</div><button id="theme" type="button">Theme</button></header>
<main>${o.views.map((v) => v.html).join("\n")}
<footer>Single-file report &middot; generated ${esc(new Date().toISOString().replace("T", " ").slice(0, 19))} UTC &middot; API ${esc(o.meta.base_url)}
${o.meta.dashboards_url ? ` &middot; Dashboards ${esc(o.meta.dashboards_url)} (${esc(o.meta.tenant)} / ${esc(o.meta.index)})` : ""}
${o.meta.stop_after ? ` &middot; stopped after ${esc(o.meta.stop_after)}` : ""}</footer></main>
<script>${THEME_JS}${o.views.map((v) => v.script ?? "").join("\n")}${ROUTER_JS}</script></body></html>`;
}

export const chip = (label: string, value: string) => `<span class="chip">${esc(label)} <b>${esc(value)}</b></span>`;

