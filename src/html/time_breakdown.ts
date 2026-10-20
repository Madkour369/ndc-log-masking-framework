/** Time breakdown view (#time): performance & timing decomposition (analyst view). */
import { stepLabel } from "../live";
import type { Report } from "../report";
import { breakdown, CATEGORIES, SUB_LABELS, type TimeCategory } from "../timeline";
import { badge, esc, jsonScript, ms, pct, supplierView, timeRow, type View } from "./layout";
import { effectiveTimeline, latencyRows, stepLatencyRows, supplierCategoryTotals, supplierWallTime } from "./timing";

const CAT_INDEX: Record<TimeCategory, number> = { network: 0, opensearch: 1, masking: 2, idle: 3 };

export function renderTimeBreakdown(report: Report): View {
  const { meta } = report;
  const { data, synthesized } = effectiveTimeline(report);
  const { buckets, byCategory, total } = breakdown(data);
  const perSupplier = supplierCategoryTotals(data);

  // ---- category cards
  const cards = CATEGORIES.map((c) => `<div class="kpi clickable" data-drill='${esc(JSON.stringify({ cat: c.id, title: c.label }))}'>
<div class="l"><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--c-${c.id});margin-right:6px"></i>${esc(c.label)}</div>
<div class="v">${esc(ms(byCategory[c.id]))}</div><div class="muted">${pct(byCategory[c.id], total)} of run</div>
<div class="bar" style="margin-top:8px"><span style="width:${total ? (byCategory[c.id] / total) * 100 : 0}%;background:var(--c-${c.id})"></span></div></div>`).join("");

  // ---- cost breakdown statement
  const statement = CATEGORIES.map((c) => {
    const rows = buckets.filter((b) => b.category === c.id);
    const sub = byCategory[c.id];
    const head = `<tr class="clickable" data-drill='${esc(JSON.stringify({ cat: c.id, title: c.label }))}' style="font-weight:650">`
      + `<td><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--c-${c.id});margin-right:8px"></i>${esc(c.label)}</td>`
      + `<td class="num">${rows.reduce((n, b) => n + b.count, 0)}</td><td class="num">${esc(ms(sub))}</td><td class="num"></td><td class="num">${sub ? "100%" : "-"}</td><td class="num">${pct(sub, total)}</td></tr>`;
    const lines = rows.map((b) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ cat: b.category, sub: b.sub, title: SUB_LABELS[b.sub] ?? b.sub }))}'>`
      + `<td style="padding-left:30px">${esc(SUB_LABELS[b.sub] ?? b.sub)}</td><td class="num">${b.count || "-"}</td><td class="num">${esc(ms(b.ms))}</td>`
      + `<td class="num">${b.count ? esc(ms(b.ms / b.count)) : "-"}</td><td class="num">${pct(b.ms, sub)}</td><td class="num">${pct(b.ms, total)}</td></tr>`).join("");
    return head + lines;
  }).join("") + `<tr style="font-weight:700;border-top:2px solid var(--text)"><td>Total run time</td><td class="num">${data.events.length}</td>`
    + `<td class="num">${esc(ms(total))}</td><td></td><td></td><td class="num">100%</td></tr>`;

  // ---- waterfall (horizontal, one floating bar per line item, total at the bottom)
  const W = 1000, LABEL = 290, BAR = 600, ROW = 26;
  let cursor = 0;
  const wfRows = buckets.map((b, i) => {
    const x = LABEL + (total ? (cursor / total) * BAR : 0);
    const w = Math.max(1.5, total ? (b.ms / total) * BAR : 0);
    cursor += b.ms;
    const y = 10 + i * ROW;
    const name = SUB_LABELS[b.sub] ?? b.sub;
    return `<g class="clickable" data-drill='${esc(JSON.stringify({ cat: b.category, sub: b.sub, title: name }))}'>`
      + `<title>${esc(name)}: ${esc(ms(b.ms))} (${pct(b.ms, total)}) - ends at ${esc(ms(cursor))}</title>`
      + `<text x="${LABEL - 10}" y="${y + 16}" text-anchor="end" font-size="12.5" fill="var(--text)">${esc(name)}</text>`
      + `<rect x="${x.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="${ROW - 8}" rx="3" fill="var(--c-${b.category})"/>`
      + `<text x="${Math.min(W - 4, x + w + 6).toFixed(1)}" y="${y + 16}" font-size="12" fill="var(--muted)">${esc(ms(b.ms))}</text></g>`;
  }).join("");
  const totalY = 10 + buckets.length * ROW + 6;
  const axis = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${LABEL + f * BAR}" x2="${LABEL + f * BAR}" y1="4" y2="${totalY + ROW}" stroke="var(--bd)" stroke-dasharray="3 4"/>`
    + `<text x="${LABEL + f * BAR}" y="${totalY + ROW + 16}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(ms(total * f))}</text>`).join("");
  const waterfall = `<svg viewBox="0 0 ${W} ${totalY + ROW + 24}" width="100%" role="img" aria-label="Waterfall of run time">${axis}${wfRows}
<text x="${LABEL - 10}" y="${totalY + 16}" text-anchor="end" font-size="13" font-weight="700" fill="var(--text)">Total</text>
<rect x="${LABEL}" y="${totalY + 3}" width="${BAR}" height="${ROW - 6}" rx="3" fill="var(--text)" opacity=".85"/>
<text x="${LABEL + BAR + 6}" y="${totalY + 16}" font-size="12" font-weight="700" fill="var(--text)">${esc(ms(total))}</text></svg>`;

  // ---- per-supplier stacked bars
  const supRows = report.suppliers
    .map((sup) => ({ sup, wall: supplierWallTime(sup, data), t: perSupplier.get(sup.supplier) ?? { network: 0, opensearch: 0, masking: 0, idle: 0 } }))
    .sort((a, b) => b.wall - a.wall);
  const maxWall = Math.max(1, ...supRows.map((r) => r.wall));
  const stacked = supRows.map(({ sup, wall, t }) => {
    const measured = Object.values(t).reduce((n, v) => n + v, 0);
    const scale = wall / maxWall;
    const segs = CATEGORIES.map((c) => `<span style="width:${measured ? (t[c.id] / measured) * 100 : 0}%;background:var(--c-${c.id})" title="${esc(c.label)}: ${esc(ms(t[c.id]))}"></span>`).join("");
    return `<tr id="${timeRow(sup.supplier)}" class="clickable" data-drill='${esc(JSON.stringify({ supplier: sup.supplier, title: sup.supplier }))}'>`
      + `<td class="nw"><a href="#${supplierView(sup.supplier)}">${esc(sup.supplier)}</a></td><td>${badge(sup.overall)}</td>`
      + `<td style="width:55%"><div class="bar" style="width:${(scale * 100).toFixed(1)}%;height:14px">${segs}</div></td>`
      + `<td class="num nw">${esc(ms(wall))}</td>${CATEGORIES.map((c) => `<td class="num nw">${esc(ms(t[c.id]))}</td>`).join("")}</tr>`;
  }).join("");

  // ---- latency comparison
  const lat = latencyRows(report, data);
  const latRows = lat.map((r, i) => `<tr><td class="num">${r.calls ? i + 1 : "-"}</td><td class="nw"><a href="#${supplierView(r.supplier)}">${esc(r.supplier)}</a></td>`
    + `<td>${badge(r.overall)}</td><td class="num" data-v="${r.calls}">${r.calls}</td><td class="num" data-v="${r.p50}">${esc(ms(r.p50))}</td>`
    + `<td class="num" data-v="${r.p95}">${esc(ms(r.p95))}</td><td class="num" data-v="${r.max}">${esc(ms(r.max))}</td>`
    + `<td>${r.slowest ? `<span class="clickable" data-drill='${esc(JSON.stringify({ supplier: r.supplier, step: r.slowest.step, title: `${r.supplier} - ${stepLabel(r.slowest.step)}` }))}'>`
      + `<b>${esc(stepLabel(r.slowest.step))}</b> <span class="muted">${esc(ms(r.slowest.ms))}</span></span>` : "-"}</td>`
    + `<td class="num" data-v="${r.network}">${esc(ms(r.network))}</td><td class="num" data-v="${r.wall}">${esc(ms(r.wall))}</td>`
    + `<td class="num" data-v="${r.wall ? r.network / r.wall : 0}">${pct(r.network, r.wall)}</td></tr>`).join("");
  const stepRows = stepLatencyRows(data, meta.steps).map((r) => `<tr class="clickable" data-drill='${esc(JSON.stringify({ step: r.step, cat: "network", title: `${stepLabel(r.step)} - all suppliers` }))}'>`
    + `<td>${esc(stepLabel(r.step))}</td><td class="num">${r.calls}</td><td class="num">${esc(ms(r.p50))}</td><td class="num">${esc(ms(r.p95))}</td>`
    + `<td class="num">${esc(ms(r.max))}</td><td class="num">${esc(ms(r.total))}</td></tr>`).join("");

  // ---- drill-down data: compact rows [cat, sub, label, supplier, step, offsetMs, ms]
  const drill = {
    cats: CATEGORIES.map((c) => c.label),
    subs: SUB_LABELS,
    total,
    unattributed: buckets.find((b) => b.sub === "unattributed")?.ms ?? 0,
    events: data.events.slice().sort((a, b) => a.start - b.start)
      .map((e) => [CAT_INDEX[e.category], e.sub, e.label, e.supplier ?? "", e.step ?? "", e.start - data.started, e.ms]),
  };

  const body = `
${synthesized ? `<div class="panel" style="border-color:var(--warn)"><b>Limited timing detail.</b> This report was produced before timing capture
existed; only API latencies could be reconstructed. Re-run with the current framework for the full breakdown.</div>` : ""}
<h2 style="margin-top:4px">Run time: ${esc(ms(total))} <span class="muted" style="font-weight:400">across ${report.suppliers.length} supplier(s), ${data.events.length} measured operations</span></h2>
<div class="kpis">${cards}</div>

<h2>Cost breakdown statement</h2>
<div class="panel"><table><thead><tr><th>Line item</th><th class="num">Operations</th><th class="num">Time</th><th class="num">Avg / op</th>
<th class="num">% of category</th><th class="num">% of run</th></tr></thead><tbody>${statement}</tbody></table>
<p class="muted" style="margin:10px 0 0">Click any line for a timestamped drill-down. <i>Unattributed framework time</i> = run time not covered by any measured operation
(scheduling, report assembly, result extraction).</p></div>

<h2>Waterfall: where every second went</h2>
<div class="panel">${waterfall}</div>

<h2>Time per supplier</h2>
<div class="panel"><table><thead><tr><th>Supplier</th><th>Result</th><th>Decomposition (bar length = wall time)</th><th class="num">Wall time</th>
${CATEGORIES.map((c) => `<th class="num" title="${esc(c.label)}">${esc(c.label.split(" ")[0])}</th>`).join("")}</tr></thead><tbody>${stacked}</tbody></table></div>

<h2>Supplier latency comparison</h2>
<div class="panel"><table id="lat"><thead><tr><th class="num">Rank</th><th>Supplier</th><th>Result</th><th class="num sort">API calls</th><th class="num sort">p50</th>
<th class="num sort">p95</th><th class="num sort">Max</th><th>Slowest step</th><th class="num sort">Network total</th><th class="num sort">Wall time</th><th class="num sort">Network share</th></tr></thead>
<tbody>${latRows}</tbody></table><p class="muted" style="margin:10px 0 0">Ranked by median (p50) API round-trip, fastest first. Includes every route fallback attempt and retry.
Percentiles are nearest-rank over each supplier's API calls.</p></div>

<h2>Latency per step (all suppliers)</h2>
<div class="panel"><table><thead><tr><th>Step</th><th class="num">API calls</th><th class="num">p50</th><th class="num">p95</th><th class="num">Max</th><th class="num">Total</th></tr></thead>
<tbody>${stepRows}</tbody></table></div>

<dialog id="drill"><div class="dh"><div><b id="dt"></b><div class="muted" id="ds"></div></div><button class="x" type="button" id="dx">Close</button></div>
<div class="db"><div class="bar" id="dbar" style="height:12px;margin-bottom:12px"></div><div id="dbody"></div></div></dialog>
${jsonScript("timeline-data", drill)}`;

  const script = `
(function(){var D=JSON.parse(document.getElementById("timeline-data").textContent),cats=["network","opensearch","masking","idle"];
function fmt(v){if(v<1000)return Math.round(v)+" ms";var s=v/1000;if(s<60)return s.toFixed(1)+"s";var m=Math.floor(s/60);return m+"m "+String(Math.round(s%60)).padStart(2,"0")+"s";}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]});}
var dlg=document.getElementById("drill");document.getElementById("dx").onclick=function(){dlg.close()};
dlg.addEventListener("click",function(e){if(e.target===dlg)dlg.close()});
function open(q){var rows=D.events.filter(function(e){return(q.cat===undefined||cats[e[0]]===q.cat)&&(q.sub===undefined||e[1]===q.sub)
&&(q.supplier===undefined||e[3]===q.supplier)&&(q.step===undefined||e[4]===q.step);});
var sum=0,by=[0,0,0,0];rows.forEach(function(e){sum+=e[6];by[e[0]]+=e[6]});
document.getElementById("dt").textContent=q.title||"Drill-down";
document.getElementById("ds").textContent=rows.length+" operation(s), "+fmt(sum)+" measured ("+(D.total?(sum/D.total*100).toFixed(1):0)+"% of run)";
document.getElementById("dbar").innerHTML=cats.map(function(c,i){return'<span title="'+esc(D.cats[i])+": "+fmt(by[i])+'" style="width:'+(sum?by[i]/sum*100:0)+'%;background:var(--c-'+c+')"></span>'}).join("");
var html;if(q.sub==="unattributed"){html='<p>'+fmt(D.unattributed)+' of the run was not covered by any measured operation: scheduling between steps, result extraction, report assembly and other framework work. It is computed as run time minus all measured operations.</p>';}
else if(!rows.length){html='<p class="muted">No measured operations.</p>';}
else{var shown=rows.slice(0,2000);html='<table><thead><tr><th>At</th><th>Supplier</th><th>Step</th><th>Line item</th><th>Operation</th><th class="num">Duration</th></tr></thead><tbody>'
+shown.map(function(e){return'<tr><td class="nw muted">+'+(e[5]/1000).toFixed(2)+'s</td><td class="nw">'+esc(e[3]||"-")+'</td><td class="nw">'+esc(e[4]||"-")
+'</td><td class="nw"><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--c-'+cats[e[0]]+')"></i> '+esc(D.subs[e[1]]||e[1])
+'</td><td>'+esc(e[2])+'</td><td class="num nw">'+fmt(e[6])+'</td></tr>'}).join("")+'</tbody></table>'
+(rows.length>shown.length?'<p class="muted">… '+(rows.length-shown.length)+' more</p>':"");}
document.getElementById("dbody").innerHTML=html;dlg.showModal();}
document.querySelectorAll("[data-drill]").forEach(function(el){el.addEventListener("click",function(ev){if(ev.target.closest("a"))return;open(JSON.parse(el.dataset.drill));});});
var t=document.getElementById("lat");t.querySelectorAll("th.sort").forEach(function(th){var dir=1;th.addEventListener("click",function(){
var idx=[].indexOf.call(th.parentNode.children,th),body=t.tBodies[0],rs=[].slice.call(body.rows);dir=-dir;
rs.sort(function(a,b){return(parseFloat(a.cells[idx].dataset.v)-parseFloat(b.cells[idx].dataset.v))*dir});rs.forEach(function(r){body.appendChild(r)});});});})();`;

  return { id: "time", html: `<section class="view" id="time" data-title="Time breakdown">${body}</section>`, script };
}
