/** Overview view (#overview): KPIs, pass-rate donut, masking score, responsive supplier grid. */
import { stepLabel } from "../live";
import { searchRoute, securityFailures, verifiedMasks, type Report } from "../report";
import { securityLine } from "../live";
import { badge, esc, ms, ring, stepAnchor, supplierView, timeRow, type View } from "./layout";
import { effectiveTimeline, supplierWallTime } from "./timing";

export function renderOverview(report: Report): View {
  const { meta, summary } = report;
  const { data } = effectiveTimeline(report);
  const n = summary.total_suppliers;
  const passRate = n ? Math.round((summary.passed / n) * 100) : 0;
  const score = summary.masking_score;
  const fails = securityFailures(report.suppliers);

  const donut = ring([[summary.passed, "--pass"], [summary.failed, "--fail"], [summary.blocked, "--block"]], `${passRate}%`, "pass rate");
  const scoreRing = ring(score === null ? [] : [[score, score >= 100 ? "--pass" : score >= 90 ? "--warn" : "--fail"], [100 - score, "--track"]],
    score === null ? "n/a" : `${score}%`, "masked");
  const kpi = (v: unknown, l: string, cls = "") => `<div class="kpi ${cls}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
  const avg = n ? data.total_ms / n : 0;

  const cards = report.suppliers.map((sup) => {
    const wall = supplierWallTime(sup, data);
    const leaks = sup.masking.reduce((k, m) => k + m.findings.length, 0) + sup.steps.reduce((k, s) => k + s.response_exposure.length, 0);
    const verified = verifiedMasks(sup).length;
    const href = `#${supplierView(sup.supplier)}`;
    const steps = sup.steps.map((s) => {
      const m = sup.masking.find((x) => x.step === s.step);
      const title = `${stepLabel(s.step)}: API ${s.status}${s.http_status ? ` (HTTP ${s.http_status}, ${s.elapsed_ms} ms)` : ""}${m ? `, masking ${m.verdict}` : ""}`;
      const tone = s.status !== "PASS" ? s.status : m?.verdict === "FAIL" ? "FAIL" : m && m.verdict !== "PASS" ? "WARN" : "PASS";
      return `<a class="${esc(tone)}" href="#${stepAnchor(sup.supplier, s.step)}" title="${esc(title)}">${esc(stepLabel(s.step))}</a>`;
    }).join("");
    return `<article class="card" data-status="${esc(sup.overall)}" data-name="${esc(sup.supplier.toLowerCase())}"
 data-time="${wall}" data-fails="${leaks}">
<div class="hd"><div><div class="nm">${esc(sup.supplier)}</div><div class="muted">${esc(searchRoute(sup))}</div></div>${badge(sup.overall, "lg")}</div>
<div class="stats"><div><b>${esc(ms(wall))}</b>execution</div><div class="${leaks ? "bad" : ""}"><b>${leaks}</b>masking fails</div>
<div class="${verified ? "good" : ""}"><b>${verified}</b>verified masked</div></div>
<div class="steps">${steps}</div>
<div class="reason">${esc(sup.overall_reason ?? "All steps and masking checks passed")}</div>
<div class="ft"><a href="${href}">Step-by-step logs &rarr;</a><a href="#${timeRow(sup.supplier)}">Timing</a></div>
</article>`;
  }).join("\n");

  const securitySection = fails.length
    ? `<h2>Security assertions failed (${fails.length})</h2><div class="panel"><ul class="list">${fails.slice(0, 200).map(({ supplier, step, finding }) =>
      `<li><a href="#${stepAnchor(supplier, step)}"><b>${esc(supplier)}</b></a> <code class="sec">${esc(securityLine(finding, step))}</code>
 <span class="muted">(${esc(finding.source)}, ${esc(finding.rule)})</span></li>`).join("")}</ul>${fails.length > 200 ? `<p class="muted">… ${fails.length - 200} more on the supplier pages.</p>` : ""}</div>`
    : `<h2>Security assertions</h2><div class="panel">${badge("PASS")} No unmasked target field found in any checked log or API response`
      + ` &middot; ${summary.verified_masked} field(s) verified masked.</div>`;

  const stepRows = meta.steps.map((s) => {
    const t = summary.steps[s] ?? {};
    const total = (t.PASS ?? 0) + (t.FAIL ?? 0);
    return `<tr><td>${esc(stepLabel(s))}</td><td class="num">${t.PASS ?? 0}</td><td class="num">${t.FAIL ?? 0}</td>`
      + `<td class="num">${t.SKIPPED ?? 0}</td><td class="num">${total ? Math.round(((t.PASS ?? 0) / total) * 100) : 0}%</td></tr>`;
  }).join("");

  const body = `
<section class="hero">
  <div class="panel">${donut}<div class="legend"><div><i style="background:var(--pass)"></i>PASS <b>${summary.passed}</b></div>
    <div><i style="background:var(--fail)"></i>FAIL <b>${summary.failed}</b> <span class="muted">security</span></div>
    <div><i style="background:var(--block)"></i>BLOCKED <b>${summary.blocked}</b> <span class="muted">not verifiable</span></div></div></div>
  <div class="panel">${scoreRing}<div class="legend"><div>Verified masked <b>${summary.verified_masked}</b></div>
    <div>Exposed <b class="${summary.unmasked_in_logs + summary.unmasked_in_api_responses ? "sec" : ""}">${summary.unmasked_in_logs + summary.unmasked_in_api_responses}</b></div>
    <div>Checks passed <b>${summary.masking_checks.passed}/${summary.masking_checks.total}</b></div></div></div>
  <div class="kpis">${kpi(n, "Suppliers")}${kpi(summary.passed, "Passed", "pass")}${kpi(summary.failed, "Failed", "fail")}
    ${kpi(summary.blocked, "Blocked", "block")}${kpi(`${summary.flows.passed}/${n}`, "API flows passed")}
    ${kpi(summary.unmasked_in_logs, "Unmasked in logs", summary.unmasked_in_logs ? "fail" : "")}
    ${kpi(summary.unmasked_in_api_responses, "Unmasked in API responses", summary.unmasked_in_api_responses ? "fail" : "")}
    ${kpi(ms(data.total_ms), "Total duration")}${kpi(ms(avg), "Avg per supplier")}</div>
</section>
${securitySection}
<h2>Suppliers (${n})</h2>
<div class="toolbar" id="tools">
  <button class="on" data-f="ALL">All ${n}</button><button data-f="FAIL">Failed ${summary.failed}</button>
  <button data-f="BLOCKED">Blocked ${summary.blocked}</button><button data-f="PASS">Passed ${summary.passed}</button>
  <input id="q" type="search" placeholder="Search supplier..." aria-label="Search supplier">
  <select id="sort" aria-label="Sort"><option value="run">Run order</option><option value="name">Name</option>
  <option value="status">Status (FAIL first)</option><option value="time">Execution time (slowest first)</option><option value="fails">Masking fails</option></select>
  <span class="muted" id="count"></span>
</div>
<div class="grid" id="grid">${cards}</div>
<h2>Step results</h2>
<div class="panel"><table><thead><tr><th>Step</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Skipped</th><th class="num">Pass rate</th></tr></thead><tbody>${stepRows}</tbody></table></div>`;

  const script = `
(function(){var grid=document.getElementById("grid"),cards=[].slice.call(grid.children),f="ALL";
cards.forEach(function(c,i){c.dataset.idx=i});
function apply(){var q=document.getElementById("q").value.trim().toLowerCase(),shown=0;
cards.forEach(function(c){var ok=(f==="ALL"||c.dataset.status===f)&&(!q||c.dataset.name.indexOf(q)>=0);c.style.display=ok?"":"none";if(ok)shown++;});
document.getElementById("count").textContent=shown+" of "+cards.length+" shown";}
document.querySelectorAll("#tools button").forEach(function(b){b.addEventListener("click",function(){
document.querySelectorAll("#tools button").forEach(function(x){x.classList.toggle("on",x===b)});f=b.dataset.f;apply();});});
document.getElementById("q").addEventListener("input",apply);
var rank={FAIL:0,BLOCKED:1,PASS:2};
document.getElementById("sort").addEventListener("change",function(){var k=this.value;cards.sort(function(a,b){
if(k==="name")return a.dataset.name.localeCompare(b.dataset.name);if(k==="status")return rank[a.dataset.status]-rank[b.dataset.status]||a.dataset.idx-b.dataset.idx;
if(k==="time")return b.dataset.time-a.dataset.time;if(k==="fails")return b.dataset.fails-a.dataset.fails;return a.dataset.idx-b.dataset.idx;});
cards.forEach(function(c){grid.appendChild(c)});});apply();})();`;

  return { id: "overview", html: `<section class="view" id="overview" data-title="Executive overview">${body}</section>`, script };
}
