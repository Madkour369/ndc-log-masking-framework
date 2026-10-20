/** Supplier view (#sup-<name>): step-by-step detail for one supplier, with direct OpenSearch Discover links. */
import { securityLine, stepLabel, verifiedLine } from "../live";
import { searchRoute, type Report } from "../report";
import { CATEGORIES, SUB_LABELS } from "../timeline";
import type { SupplierResult } from "../types";
import { badge, discoverUrl, esc, ms, pct, stepAnchor, supplierView, timeRow, type View } from "./layout";
import { effectiveTimeline, supplierCategoryTotals, supplierWallTime } from "./timing";

export function renderSupplierView(report: Report, sup: SupplierResult): View {
  const { meta } = report;
  const { data } = effectiveTimeline(report);
  const wall = supplierWallTime(sup, data);
  const totals = supplierCategoryTotals(data).get(sup.supplier) ?? { network: 0, opensearch: 0, masking: 0, idle: 0 };
  const measured = Object.values(totals).reduce((n, v) => n + v, 0);
  const bar = CATEGORIES.map((c) => `<span style="width:${measured ? (totals[c.id] / measured) * 100 : 0}%;background:var(--c-${c.id})" `
    + `title="${esc(c.label)}: ${esc(ms(totals[c.id]))}"></span>`).join("");
  const legend = CATEGORIES.map((c) => `<div><i style="background:var(--c-${c.id})"></i>${esc(c.label)} <b>${esc(ms(totals[c.id]))}</b>`
    + ` <span class="muted">${pct(totals[c.id], measured)}</span></div>`).join("");

  const stepCards = sup.steps.map((s) => {
    const m = sup.masking.find((x) => x.step === s.step);
    const link = discoverUrl(meta, m?.kql ?? null);
    const events = data.events.filter((e) => e.supplier === sup.supplier && e.step === s.step).sort((a, b) => a.start - b.start);
    const stepMs = events.reduce((n, e) => n + e.ms, 0);
    const kv = (k: string, v: string) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
    const ids = Object.entries(s.correlation_ids).map(([k, v]) => `<code>${esc(v)}</code> <span class="muted">${esc(k)}</span>`).join("<br>") || "-";
    const extracted = Object.entries(s.extracted).map(([k, v]) => {
      const t = String(v);
      return `<code title="${esc(t.length > 300 ? `${t.slice(0, 300)}…` : t)}">${esc(k)} = ${esc(t.length > 60 ? `${t.slice(0, 60)}… (${t.length} chars)` : t)}</code>`;
    }).join("<br>") || "-";
    const attempts = (s.route_attempts?.length ?? 0) > 1
      ? `<h3>Route attempts</h3><table><thead><tr><th></th><th>Route</th><th>Result</th><th class="num">HTTP</th><th class="num">Time</th><th>CorrelationId</th><th>Error</th></tr></thead><tbody>`
        + s.route_attempts!.map((a, i) => `<tr><td>${i ? `fallback ${i}` : "primary"}</td><td class="nw">${esc(a.route)}</td><td>${badge(a.status)}</td>`
          + `<td class="num">${a.http_status ?? ""}</td><td class="num nw">${esc(ms(a.elapsed_ms))}</td><td><code>${esc(a.correlation_id ?? "")}</code></td>`
          + `<td class="muted">${esc(a.error ?? "")}</td></tr>`).join("") + "</tbody></table>"
      : "";
    const findings = [...(m?.findings ?? []), ...s.response_exposure];
    const verified = [...(m?.verified ?? []), ...(s.response_verified ?? [])];
    const secTable = findings.length
      ? `<h3 class="sec">Security assertions failed (${findings.length})</h3><table><thead><tr><th>Assertion</th><th>Value type</th><th>Source</th><th>Rule</th><th>Location / document</th></tr></thead><tbody>`
        + findings.map((f) => `<tr><td><code class="sec">${esc(securityLine(f, s.step))}</code></td><td>${esc(f.kind ?? "")}</td><td>${esc(f.source)}</td>`
          + `<td>${esc(f.rule)}</td><td><code>${esc(f.location)}</code><br><span class="muted">${esc(f.doc ?? "")}</span></td></tr>`).join("") + "</tbody></table>"
      : "";
    const verTable = verified.length
      ? `<h3>Verified masked (${verified.length})</h3><table><thead><tr><th>Assertion</th><th class="num">Occurrences</th><th>Source</th><th>Rule</th></tr></thead><tbody>`
        + verified.map((v) => `<tr><td><code>${esc(verifiedLine(v, s.step))}</code></td><td class="num">${v.count}</td><td>${esc(v.source ?? "")}</td>`
          + `<td>${esc(v.rule)}</td></tr>`).join("") + "</tbody></table>"
      : "";
    const timing = events.length
      ? `<h3>Time breakdown (${esc(ms(stepMs))} measured)</h3><table><thead><tr><th>At</th><th>Category</th><th>Operation</th><th class="num">Duration</th></tr></thead><tbody>`
        + events.map((e) => `<tr><td class="nw muted">+${((e.start - data.started) / 1000).toFixed(2)}s</td>`
          + `<td class="nw"><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--c-${e.category})"></i> ${esc(SUB_LABELS[e.sub] ?? e.sub)}</td>`
          + `<td>${esc(e.label)}</td><td class="num nw">${esc(ms(e.ms))}</td></tr>`).join("") + "</tbody></table>"
      : "";
    const notes = [s.error && `<div class="sec">${esc(s.error)}</div>`, s.warning && `<div class="muted">warning: ${esc(s.warning)}</div>`,
      m?.error && `<div class="muted">${esc(m.error)}</div>`].filter(Boolean).join("");

    return `<section class="panel stepcard" id="${stepAnchor(sup.supplier, s.step)}" style="margin-bottom:14px">
<div class="hd"><h3>${esc(stepLabel(s.step))}</h3>${badge(s.status)}<span class="muted">API</span>${m ? `${badge(m.verdict)}<span class="muted">masking</span>` : ""}
${link ? `<a href="${esc(link)}" target="_blank" rel="noopener" style="margin-left:auto">Open logs in OpenSearch Discover &#8599;</a>` : ""}</div>
<div class="cols"><dl class="kv">${kv("Endpoint", `<code>${esc(s.endpoint)}</code>`)}${kv("HTTP", esc(s.http_status ?? "-"))}
${kv("API latency", esc(s.status === "SKIPPED" ? "-" : ms(s.elapsed_ms)))}${s.route ? kv("Route", esc(s.route)) : ""}${kv("CorrelationId", ids)}${kv("Extracted", extracted)}</dl>
<dl class="kv">${m ? kv("Log hits", String(m.hits)) + kv("Found via", esc(m.search_method === "filter" ? "Add filter fallback" : m.search_method === "query" ? "search bar query" : "-"))
  + kv("KQL", `<code>${esc(m.kql ?? "-")}</code>`) + kv("Unmasked", `<b class="${m.findings.length ? "sec" : ""}">${m.findings.length}</b>`)
  + kv("Verified masked", String(m.verified?.length ?? 0)) : kv("Masking", "not checked")}</dl></div>
${notes}${attempts}${secTable}${verTable}${timing}</section>`;
  }).join("\n");

  const body = `
<p><a href="#overview">&larr; Overview</a></p>
<section class="panel" style="display:grid;gap:12px">
  <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><h2 style="margin:0;font-size:20px">${esc(sup.supplier)}</h2>${badge(sup.overall, "lg")}
  <span class="muted">route ${esc(searchRoute(sup))} &middot; API flow ${esc(sup.flow_status)} &middot; masking ${esc(sup.masking_verdict ?? "-")} &middot; execution ${esc(ms(wall))}</span>
  <a href="#${timeRow(sup.supplier)}" style="margin-left:auto">Compare timing &rarr;</a></div>
  <div class="muted">${esc(sup.overall_reason ?? "All steps and masking checks passed.")}</div>
  <div class="bar" style="height:14px">${bar}</div><div class="legend" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">${legend}</div>
</section>
<h2>Steps</h2>
${stepCards}`;

  const id = supplierView(sup.supplier);
  return { id, html: `<section class="view" id="${esc(id)}" data-title="${esc(sup.supplier)}">${body}</section>` };
}
