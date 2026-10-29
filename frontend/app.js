const state = { data: null };

const money = (n) => `KSh ${Number(n || 0).toLocaleString()}`;
const fmt = (n, unit = "") => `${Number(n || 0).toLocaleString()}${unit ? " " + unit : ""}`;

const statusClass = (value) => {
  const v = String(value || "");
  if (/(DOWN|LOW|OPEN|UNPAID|DELAYED|CRITICAL|CONFIGURATION)/.test(v)) return "bad";
  if (/(IDLE|PENDING|IN_PROGRESS|SANDBOX|MAINTENANCE|PARTIAL)/.test(v)) return "warn";
  if (/(PAID|COMPLETED|RUNNING|CONNECTED|SENT)/.test(v)) return "info";
  return "";
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const type = res.headers.get("content-type") || "";
  if (res.status === 401) {
    window.location.replace("/login.html");
    throw new Error("Sign in required");
  }
  if (!res.ok) throw new Error(type.includes("json") ? (await res.json()).error : await res.text());
  return type.includes("json") ? res.json() : res.text();
}

function el(id) { return document.getElementById(id); }

el("signOut")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  window.location.replace("/login.html");
});

function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "BO";
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

async function loadUserChip() {
  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    if (!res.ok) return;
    const { account } = await res.json();
    if (!account) return;
    const displayName = account.name || account.email;
    el("userName").textContent = displayName;
    el("userAvatar").textContent = initialsOf(displayName);
    el("userChip").title = account.email ? `${displayName} · ${account.email}` : displayName;
  } catch {
    // Keep the default "Owner" chip if the status call fails.
  }
}
loadUserChip();

function activateTab(id, updateHash = true) {
  const target = el(id) ? id : "dashboard";
  document.querySelectorAll(".tabs [role=tab]").forEach((tab) => {
    const active = tab.getAttribute("href") === `#${target}`;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("tabindex", active ? "0" : "-1");
  });
  document.querySelectorAll(".band[role=tabpanel]").forEach((panel) => {
    const active = panel.id === target;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  if (updateHash && window.location.hash !== `#${target}`) {
    history.replaceState(null, "", `#${target}`);
  }
  // Update breadcrumb
  const bc = el("breadcrumbCurrent");
  if (bc) {
    const activeLink = document.querySelector(`.tabs [href="#${target}"]`);
    bc.textContent = activeLink ? activeLink.textContent.trim() : target.charAt(0).toUpperCase() + target.slice(1);
  }
}

document.querySelectorAll(".tabs [role=tab]").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.getAttribute("href").slice(1)));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll(".tabs [role=tab]")];
    const current = tabs.indexOf(tab);
    const next = tabs[(current + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    activateTab(next.getAttribute("href").slice(1));
  });
});

window.addEventListener("hashchange", () => activateTab(window.location.hash.slice(1), false));
activateTab(window.location.hash.slice(1) || "dashboard", false);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[char]));
}

function pill(value) {
  return `<span class="status ${statusClass(value)}">${escapeHtml(String(value).replaceAll("_", " "))}</span>`;
}

// ── Shared FinSet chart helpers ──────────────────────────────────────────────
function finRenderLineChart(containerId, rows, color) {
  const container = el(containerId);
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div style="padding:32px;text-align:center;color:#7b7295;font-size:13px">No data yet.</div>`;
    return;
  }
  const W = 500, H = 170, pad = { t: 12, b: 28, l: 10, r: 10 };
  const vals = rows.map(r => Number(r.value || 0));
  const maxV = Math.max(1, ...vals);
  const n = rows.length;
  const xStep = (W - pad.l - pad.r) / Math.max(1, n - 1);
  const yScale = v => pad.t + (1 - v / maxV) * (H - pad.t - pad.b);
  const pts = rows.map((r, i) => ({ x: pad.l + i * xStep, y: yScale(Number(r.value || 0)), label: r.day || "" }));
  const pathD = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaD = pathD + ` L${pts[n-1].x.toFixed(1)},${(H-pad.b).toFixed(1)} L${pad.l},${(H-pad.b).toFixed(1)} Z`;
  const yLines = [0, 0.33, 0.66, 1].map(f => {
    const y = yScale(maxV * f);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W-pad.r}" y2="${y.toFixed(1)}" stroke="#ede9fe" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="${pad.l}" y="${(y-3).toFixed(1)}" font-size="9" fill="#b0a8d0" font-family="Inter,sans-serif">${Math.round(maxV*f/1000)}k</text>`;
  }).join("");
  const labelIdxs = n <= 6 ? rows.map((_,i)=>i) : [0, Math.floor(n*0.2), Math.floor(n*0.4), Math.floor(n*0.6), Math.floor(n*0.8), n-1];
  const xLabels = labelIdxs.map(i => `<text x="${pts[i].x.toFixed(1)}" y="${H-pad.b+14}" text-anchor="middle" font-size="9" fill="#b0a8d0" font-family="Inter,sans-serif">${escapeHtml(String(pts[i].label).slice(5)||"")}</text>`).join("");
  const gradId = "finGrad_" + containerId;
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.18"/><stop offset="100%" stop-color="${color}" stop-opacity="0.01"/></linearGradient></defs>
    ${yLines}
    <path d="${areaD}" fill="url(#${gradId})"/>
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.filter((_,i) => i % Math.max(1,Math.floor(n/8))===0||i===n-1).map(p=>`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#fff" stroke="${color}" stroke-width="2"/>`).join("")}
    ${xLabels}
  </svg>`;
}

function finRenderDonut(svgId, legId, totalId, groups, colors) {
  const svg = el(svgId);
  const legEl = el(legId);
  const totEl = el(totalId);
  if (!svg) return;
  const items = Object.entries(groups).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const total = items.reduce((s,[,v])=>s+v, 0);
  if (totEl) totEl.textContent = money(total);
  svg.querySelectorAll("circle").forEach((c,i) => { if(i>0) c.remove(); });
  const circ = 2 * Math.PI * 64;
  if (!items.length || total === 0) {
    if (legEl) legEl.innerHTML = `<span style="color:#7b7295;font-size:12px">No data yet.</span>`;
    return;
  }
  let offset = circ * 0.25;
  const rendered = items.map(([label, val], idx) => {
    const frac  = val / total;
    const arc   = document.createElementNS("http://www.w3.org/2000/svg","circle");
    arc.setAttribute("cx","90"); arc.setAttribute("cy","90"); arc.setAttribute("r","64");
    arc.setAttribute("fill","none"); arc.setAttribute("stroke", colors[idx % colors.length]);
    arc.setAttribute("stroke-width","28");
    arc.setAttribute("stroke-dasharray",`${(frac*circ).toFixed(2)} ${((1-frac)*circ).toFixed(2)}`);
    arc.setAttribute("stroke-dashoffset", offset.toFixed(2));
    arc.setAttribute("stroke-linecap","round");
    arc.style.transition = "stroke-dasharray .6s ease";
    svg.appendChild(arc);
    offset -= frac * circ;
    return { label, color: colors[idx % colors.length] };
  });
  if (legEl) legEl.innerHTML = rendered.map(r=>`<div class="fin-donut-leg-item"><span class="fin-donut-leg-dot" style="background:${r.color}"></span>${escapeHtml(r.label)}</div>`).join("");
}

function finRenderBarChart(containerId, rows, colorA, colorB) {
  const container = el(containerId);
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div style="padding:24px;text-align:center;color:#7b7295;font-size:13px">No data yet.</div>`;
    return;
  }
  const BUCKETS = Math.min(7, rows.length);
  const step = Math.ceil(rows.length / BUCKETS);
  const buckets = [];
  for (let i = 0; i < rows.length; i += step) {
    const slice = rows.slice(i, i+step);
    const aTotal = slice.reduce((s,r)=>s+Number(r.value||0),0);
    const label  = String(slice[0].day||slice[0].date||"").slice(5,10)||`W${buckets.length+1}`;
    buckets.push({ label, a: aTotal, b: Math.round(aTotal * 0.75) });
  }
  const W = 480, H = 155, pad = { t: 8, b: 28, l: 10, r: 10 };
  const maxV = Math.max(1, ...buckets.map(b=>Math.max(b.a,b.b)));
  const slotW = (W - pad.l - pad.r) / buckets.length;
  const barW  = Math.max(4, slotW * 0.28);
  const yScale = v => pad.t + (1 - v/maxV) * (H - pad.t - pad.b);
  const bars = buckets.map((bk, i) => {
    const xC = pad.l + i*slotW + slotW/2;
    const aH = Math.max(2, yScale(0) - yScale(bk.a));
    const bH = Math.max(2, yScale(0) - yScale(bk.b));
    return `
      <rect x="${(xC-barW-2).toFixed(1)}" y="${yScale(bk.a).toFixed(1)}" width="${barW.toFixed(1)}" height="${aH.toFixed(1)}" rx="4" fill="${colorA}" opacity="0.85"/>
      <rect x="${(xC+2).toFixed(1)}" y="${yScale(bk.b).toFixed(1)}" width="${barW.toFixed(1)}" height="${bH.toFixed(1)}" rx="4" fill="${colorB}" opacity="0.85"/>
      <text x="${xC.toFixed(1)}" y="${H-pad.b+14}" text-anchor="middle" font-size="9" fill="#b0a8d0" font-family="Inter,sans-serif">${escapeHtml(bk.label)}</text>`;
  }).join("");
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <line x1="${pad.l}" y1="${(H-pad.b).toFixed(1)}" x2="${W-pad.r}" y2="${(H-pad.b).toFixed(1)}" stroke="#ede9fe" stroke-width="1"/>
    ${bars}
  </svg>`;
}

// Shared pagination renderer used by all Order-History-style modules
function renderOhPagination(containerId, totalPages, current, onPage) {
  const pg = el(containerId);
  if (!pg) return;
  if (totalPages <= 1) { pg.innerHTML = ""; return; }
  const pages = new Set([1, totalPages, current, current-1, current+1].filter(p=>p>=1&&p<=totalPages));
  const sorted = [...pages].sort((a,b)=>a-b);
  let html = `<button class="oh-page-btn" id="${containerId}Prev" ${current===1?"disabled":""} aria-label="Previous">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
  </button>`;
  let prev = 0;
  for (const p of sorted) {
    if (prev && p-prev>1) html += `<span class="oh-page-ellipsis">…</span>`;
    html += `<button class="oh-page-btn${p===current?" active":""}" data-page="${p}">${p}</button>`;
    prev = p;
  }
  html += `<button class="oh-page-btn" id="${containerId}Next" ${current===totalPages?"disabled":""} aria-label="Next">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
  </button>`;
  pg.innerHTML = html;
  pg.querySelectorAll("[data-page]").forEach(btn=>btn.addEventListener("click",()=>onPage(Number(btn.dataset.page))));
  const prevBtn=el(containerId+"Prev"), nextBtn=el(containerId+"Next");
  if (prevBtn) prevBtn.addEventListener("click",()=>onPage(current-1));
  if (nextBtn) nextBtn.addEventListener("click",()=>onPage(current+1));
}

function kpiCard(label, value, subtext) {
  return `<div class="kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong>${subtext ? `<small class="kpi-sub">${escapeHtml(subtext)}</small>` : ""}</div>`;
}

// TeamHub-style stat card for dashboard
const KPI_ICONS = {
  teal:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 100 7h5a3.5 3.5 0 110 7H6"/></svg>`,
  green:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
  amber:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>`,
  red:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  blue:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M5.34 18.66l-1.41 1.41M12 2v2M12 20v2M4.93 4.93l1.41 1.41M18.66 18.66l1.41 1.41M2 12h2M20 12h2"/></svg>`,
  default:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`
};
function dashKpiCard(label, value, subtext, accent) {
  const accentClass = accent ? ` dash-kpi--${accent}` : "";
  const icon = KPI_ICONS[accent] || KPI_ICONS.default;
  return `<div class="dash-kpi${accentClass}"><div class="dash-kpi-icon">${icon}</div><span class="dash-kpi-label">${escapeHtml(label)}</span><strong class="dash-kpi-value">${escapeHtml(String(value))}</strong>${subtext ? `<small class="dash-kpi-sub">${escapeHtml(subtext)}</small>` : ""}</div>`;
}

function kpiItem(label, value, colorClass) {
  return `<div class="kpi-item"><span class="label">${escapeHtml(label)}</span><span class="value${colorClass ? " " + colorClass : ""}">${escapeHtml(String(value))}</span></div>`;
}

// CSS bar chart for use outside dashboard (reports etc.)
function renderBars(target, rows, labelKey = "day") {
  const max = Math.max(1, ...rows.map((r) => Number(r.value || 0)));
  el(target).innerHTML = rows.length ? rows.map((r) => `
    <div class="bar-row">
      <span>${escapeHtml(String(r[labelKey] || ""))}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, Number(r.value || 0) / max * 100)}%"></div></div>
      <strong>${Number(r.value || 0).toLocaleString()}</strong>
    </div>
  `).join("") : `<div class="event">No data yet</div>`;
}

// SVG inline line chart for dashboard
function renderSvgLine(target, rows, labelKey = "day", color = "#00c896") {
  const container = el(target);
  if (!container) return;
  const W = 340, H = 100, pad = { t: 8, b: 28, l: 6, r: 6 };
  const vals = rows.map((r) => Number(r.value || 0));
  const maxV = Math.max(1, ...vals);
  const minV = 0;
  const n = rows.length;
  if (!n) { container.innerHTML = `<div class="event">No data yet</div>`; return; }
  const xStep = (W - pad.l - pad.r) / Math.max(1, n - 1);
  const yScale = (v) => pad.t + (1 - (v - minV) / (maxV - minV)) * (H - pad.t - pad.b);
  const pts = rows.map((r, i) => ({ x: pad.l + i * xStep, y: yScale(Number(r.value || 0)), label: r[labelKey], val: Number(r.value || 0) }));
  const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  // Area fill path
  const areaD = pathD + ` L${pts[pts.length - 1].x.toFixed(1)},${(H - pad.b).toFixed(1)} L${pad.l},${(H - pad.b).toFixed(1)} Z`;
  // X-axis labels — show first, mid, last
  const labelIdxs = n <= 3 ? rows.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  const labels = labelIdxs.map((i) => `<text x="${pts[i].x.toFixed(1)}" y="${H - pad.b + 14}" text-anchor="middle" font-size="9" fill="rgba(0,0,0,.38)">${escapeHtml(String(pts[i].label || "").slice(5) || "")}</text>`).join("");
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <defs><linearGradient id="lg_${target}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.22"/><stop offset="100%" stop-color="${color}" stop-opacity="0.01"/></linearGradient></defs>
    <path d="${areaD}" fill="url(#lg_${target})" />
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}"/>`).join("")}
    ${labels}
  </svg>`;
}

// SVG inline bar chart for dashboard
function renderSvgBars(target, rows, labelKey = "label", color = "#22d3ee") {
  const container = el(target);
  if (!container) return;
  const W = 340, H = 110, pad = { t: 8, b: 30, l: 6, r: 6 };
  const vals = rows.map((r) => Number(r.value || 0));
  const maxV = Math.max(1, ...vals);
  const n = rows.length;
  if (!n) { container.innerHTML = `<div class="event">No data yet</div>`; return; }
  const barW = Math.max(4, ((W - pad.l - pad.r) / n) - 3);
  const gap = (W - pad.l - pad.r - n * barW) / Math.max(1, n - 1);
  const bars = rows.map((r, i) => {
    const barH = Math.max(2, ((Number(r.value || 0)) / maxV) * (H - pad.t - pad.b));
    const x = pad.l + i * (barW + gap);
    const y = H - pad.b - barH;
    const lbl = String(r[labelKey] || "").slice(0, 8);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${color}" opacity="0.85"/>
    <text x="${(x + barW / 2).toFixed(1)}" y="${H - pad.b + 13}" text-anchor="middle" font-size="8.5" fill="rgba(0,0,0,.38)">${escapeHtml(lbl)}</text>`;
  }).join("");
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">${bars}</svg>`;
}

function actionReceipt(action) {
  if (!action || action.intent === "unknown") return null;
  try {
    const data = JSON.parse(action.structured_json || "{}");
    if (action.intent === "sale") return `Sale: ${data.quantity}${data.unit || ""} ${data.item || "stock"} for KSh ${Number(data.amount || 0).toLocaleString()}`;
    if (action.intent === "record_purchase") return `Purchase: ${data.quantity}${data.unit || ""} ${data.item || "item"} for KSh ${Number(data.totalCost || 0).toLocaleString()}`;
    if (action.intent === "production_update") return `Production: ${data.quantity_produced} ${data.product || "units"}; ${data.quantity_consumed}${data.unit || ""} ${data.material || "material"} consumed`;
    if (action.intent === "record_expense") return `Expense: KSh ${Number(data.amount || 0).toLocaleString()} — ${data.category || "other"}`;
    return `Action: ${action.intent.replaceAll("_", " ")}`;
  } catch {
    return `Action: ${action.intent.replaceAll("_", " ")}`;
  }
}

function render() {
  const data = state.data;
  if (!data) return;

  // ===== Top-level data refs =====
  const k = data.kpis || {};
  const fin = data.financials || {};

  // ===== DASHBOARD MODULE (habaNGhair-style) =====
  (function renderDashboard() {
    // Business name — set sidebar + welcome title (keep SVG heart in title)
    const companyName = (data.company && data.company.name) || "Your Business";
    const dbn = el("dbBusinessName");
    if (dbn) {
      // Set text while preserving the heart SVG child
      const heartSvg = dbn.querySelector("svg");
      // Remove all text nodes, keep only the SVG
      Array.from(dbn.childNodes).forEach(n => { if (n.nodeType === 3) n.remove(); });
      dbn.insertAdjacentText("afterbegin", companyName + " ");
      if (!heartSvg) {
        dbn.insertAdjacentHTML("beforeend", `<svg class="db-heart-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>`);
      }
    }

    // Date range badge — May 1 – May 31, 2024 style
    const drEl = el("dbDateRange");
    if (drEl) {
      const now = new Date();
      const mo  = now.toLocaleString("default", { month: "short" });
      const yr  = now.getFullYear();
      const lastDay = new Date(yr, now.getMonth() + 1, 0).getDate();
      drEl.textContent = `${mo} 1 – ${mo} ${lastDay}, ${yr}`;
    }

    // ── 5 KPI stat cards ──
    const statRow = el("dbStatRow");
    if (statRow) {
      const mPl  = fin.month || {};
      const mRevenue  = mPl.revenue  || k.salesMonth    || 0;
      const mExpenses = mPl.expenses || k.expensesMonth || 0;
      const mProfit   = mPl.profit   || k.profitMonth   || 0;
      const mMargin   = mPl.profitMargin || (mRevenue > 0 ? Math.round(mProfit / mRevenue * 100) : 0);
      const totalOrders = (data.sales || []).length;
      const totalCustomers = k.totalCustomers || (data.customers || []).length;

      function dbStatCard(label, value, trendVal, trendLabel, iconSvg) {
        const isUp   = trendVal > 0;
        const isDown = trendVal < 0;
        const trendCls = isUp ? "db-stat-trend-up" : isDown ? "db-stat-trend-down" : "db-stat-trend-sub";
        const arrowUp   = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
        const arrowDown = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
        const arrow = isUp ? arrowUp : isDown ? arrowDown : "";
        return `<div class="db-stat-card">
          <div class="db-stat-icon">${iconSvg}</div>
          <span class="db-stat-label">${escapeHtml(label)}</span>
          <strong class="db-stat-value">${escapeHtml(String(value))}</strong>
          <div class="db-stat-trend">
            <span class="${trendCls}">${arrow}${trendVal !== 0 ? Math.abs(trendVal) + "%" : "—"}</span>
            <span class="db-stat-trend-sub">${escapeHtml(trendLabel)}</span>
          </div>
        </div>`;
      }

      const iconRevenue  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 100 7h5a3.5 3.5 0 110 7H6"/></svg>`;
      const iconOrders   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>`;
      const iconExpense  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>`;
      const iconProfit   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`;
      const iconCustomer = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`;

      statRow.innerHTML = [
        dbStatCard("Total Revenue",  money(mRevenue),  mMargin,   "vs Apr 1 – Apr 30", iconRevenue),
        dbStatCard("Total Sales",    fmt(totalOrders), 0,          "this month",        iconOrders),
        dbStatCard("Net Profit",     money(mProfit),   mMargin,   "margin",             iconProfit),
        dbStatCard("Expenses",       money(mExpenses), 0,          "vs Apr 1 – Apr 30", iconExpense),
        dbStatCard("Customers",      fmt(totalCustomers), 0,       "total",             iconCustomer),
      ].join("");
    }

    // ── Revenue growth line chart (warm brown) ──
    renderSvgLine("dbRevenueChart", (data.charts || {}).revenue || [], "day", "#8b5a2b");

    // Badge total
    const trendTotal = el("dbTrendTotal");
    if (trendTotal) trendTotal.textContent = money(k.salesMonth || 0);

    // Trend note with icon
    const trendNote = el("dbTrendNote");
    if (trendNote) {
      const wPl     = fin.week || {};
      const wMargin = wPl.profitMargin || 0;
      const wRev    = wPl.revenue  || 0;
      const wProfit = wPl.profit   || 0;
      const iconHtml = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>`;
      if (wRev === 0) {
        trendNote.innerHTML = `${iconHtml} No sales recorded this week — start recording to see your trend.`;
      } else if (wProfit < 0) {
        trendNote.innerHTML = `⚠️ Expenses exceeded revenue this week by ${money(Math.abs(wProfit))}.`;
      } else {
        trendNote.innerHTML = `${iconHtml} Your followers increased ${wMargin}% this week — you're doing great!`;
      }
    }

    // ── Donut (profit overview) — Engagement Overview style ──
    const mPlFin = fin.month || {};
    const rev  = Number(mPlFin.revenue  || k.salesMonth    || 0);
    const exp  = Number(mPlFin.expenses || k.expensesMonth || 0);
    const prof = Number(mPlFin.profit   || k.profitMonth   || 0);
    const rec  = Number(k.customerReceivables || 0);
    const circ = 2 * Math.PI * 52; // ≈326.7

    // Three arcs: profit (brown), expenses (tan), receivables (light)
    const total3 = rev + exp + rec || 1;
    const profShare = Math.min(1, prof > 0 ? prof / total3 : 0);
    const expShare  = Math.min(1 - profShare, exp  / total3);

    const dbDonutRev = document.getElementById("dbDonutRevenue");
    const dbDonutExp = document.getElementById("dbDonutExpense");
    if (dbDonutRev) dbDonutRev.setAttribute("stroke-dasharray", `${(profShare * circ).toFixed(1)} ${((1 - profShare) * circ).toFixed(1)}`);
    if (dbDonutExp) {
      dbDonutExp.setAttribute("stroke-dasharray", `${(expShare * circ).toFixed(1)} ${((1 - expShare) * circ).toFixed(1)}`);
      dbDonutExp.setAttribute("stroke-dashoffset", `${(81.5 - profShare * circ).toFixed(1)}`);
    }

    const pctEl = document.getElementById("dbDonutPct");
    const marg  = rev > 0 ? Math.round(prof / rev * 100) : 0;
    if (pctEl) pctEl.textContent = `${marg}%`;

    const dbRevAmt  = el("dbDonutRevAmt");  if (dbRevAmt)  dbRevAmt.textContent  = money(rev);
    const dbExpAmt  = el("dbDonutExpAmt");  if (dbExpAmt)  dbExpAmt.textContent  = money(exp);
    const dbProfAmt = el("dbDonutProfAmt"); if (dbProfAmt) dbProfAmt.textContent = money(prof);
    const dbRecAmt  = el("dbDonutRecAmt");  if (dbRecAmt)  dbRecAmt.textContent  = money(rec);

    // ── Quote (dynamic based on performance) ──
    const quoteEl = el("dbQuoteText");
    if (quoteEl) {
      const quotes = [
        "Beauty is more than appearance — it's confidence, care, and connection.",
        "Every sale recorded is a step closer to your goals.",
        "Success is the sum of small efforts, repeated day in and day out.",
        "Track every shilling — your future self will thank you.",
        "Great businesses are built on great records and great people."
      ];
      quoteEl.textContent = quotes[new Date().getDate() % quotes.length];
    }

    // ── Top Performing Sales (Top Posts style) ──
    const recentList = el("dbRecentList");
    if (recentList) {
      // Sort by amount descending, take top 3
      const topSales = [...(data.sales || [])].sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0)).slice(0, 3);
      if (topSales.length === 0) {
        recentList.innerHTML = `<div class="db-recent-item"><span style="color:var(--db-muted);font-size:13px">No sales recorded yet.</span></div>`;
      } else {
        recentList.innerHTML = topSales.map(s => {
          const name    = escapeHtml(s.product || s.customer_name || s.item || "Sale");
          const initials = name.slice(0, 2).toUpperCase();
          const date    = s.date ? new Date(s.date).toLocaleDateString("en-KE", { month: "short", day: "numeric", year: "numeric" }) : "—";
          return `<div class="db-recent-item">
            <div class="db-recent-avatar">${initials}</div>
            <div class="db-recent-info">
              <div class="db-recent-name">${name}</div>
              <div class="db-recent-meta">${date}</div>
            </div>
            <div>
              <strong class="db-recent-amount">${money(s.amount || 0)}</strong>
              <span class="db-recent-reach-label">Revenue</span>
            </div>
          </div>`;
        }).join("");
      }
    }

    // ── Sales Activity Calendar (Posting Consistency style) ──
    const calGrid = el("dbCalGrid");
    if (calGrid) {
      const now      = new Date();
      const yr       = now.getFullYear();
      const mo       = now.getMonth();
      const daysInMo = new Date(yr, mo + 1, 0).getDate();
      const firstDow = new Date(yr, mo, 1).getDay(); // 0=Sun

      // Update subtitle
      const calSub = el("dbCalSub");
      if (calSub) {
        const moName = now.toLocaleString("default", { month: "long" });
        calSub.textContent = `You posted ${(data.sales || []).length} times this month.`;
      }

      // Build a map: day → count of sales
      const saleDayMap = {};
      (data.sales || []).forEach(s => {
        if (!s.date) return;
        const d = new Date(s.date);
        if (d.getFullYear() === yr && d.getMonth() === mo) {
          saleDayMap[d.getDate()] = (saleDayMap[d.getDate()] || 0) + 1;
        }
      });
      const maxSales = Math.max(1, ...Object.values(saleDayMap));

      // Day labels row (Sun–Sat)
      const dayLabels = ["S","M","T","W","T","F","S"];
      let html = dayLabels.map(d => `<div class="db-cal-day-label">${d}</div>`).join("");

      // Empty cells before day 1
      for (let i = 0; i < firstDow; i++) {
        html += `<div class="db-cal-dot-cell db-cal-dot-cell--empty"></div>`;
      }

      // Day cells
      for (let d = 1; d <= daysInMo; d++) {
        const cnt = saleDayMap[d] || 0;
        const intensity = cnt === 0 ? 0 : cnt < maxSales * 0.25 ? 1 : cnt < maxSales * 0.5 ? 2 : cnt < maxSales * 0.75 ? 3 : 4;
        const isToday = d === now.getDate() ? ' style="outline:2px solid var(--db-brown);outline-offset:1px"' : "";
        html += `<div class="db-cal-dot-cell db-cal-dot-cell--${intensity}" title="${d}: ${cnt} sale${cnt !== 1 ? "s" : ""}"${isToday}></div>`;
      }
      calGrid.innerHTML = html;
    }

    // ── Expense Breakdown — Platform Breakdown style (progress bars with icons) ──
    const expChart = el("dbExpenseChart");
    if (expChart) {
      const expRows = (data.charts || {}).expenses || [];
      if (expRows.length === 0) {
        expChart.innerHTML = `<div style="color:var(--db-muted);font-size:13px;padding:8px 0">No expenses recorded yet.</div>`;
      } else {
        const maxExp  = Math.max(1, ...expRows.map(r => Number(r.value || 0)));
        const totalExp = expRows.reduce((s, r) => s + Number(r.value || 0), 0);
        // Category SVG icons keyed by common expense names
        const catIcon = (lbl) => {
          const l = lbl.toLowerCase();
          if (l.includes("rent") || l.includes("utili")) return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
          if (l.includes("salary") || l.includes("staff") || l.includes("wage")) return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>`;
          if (l.includes("transport") || l.includes("fuel") || l.includes("travel")) return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`;
          return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>`;
        };
        expChart.innerHTML = expRows.slice(0, 5).map(r => {
          const val  = Number(r.value || 0);
          const pct  = totalExp > 0 ? Math.round(val / totalExp * 100) : 0;
          const barW = Math.max(3, Math.round(val / maxExp * 100));
          const lbl  = String(r.label || "").replace(/_/g, " ");
          const pctCls = pct > 0 ? "" : "db-platform-pct--down";
          return `<div class="db-platform-row">
            <div class="db-platform-top">
              <div class="db-platform-name-wrap">
                <div class="db-platform-icon">${catIcon(lbl)}</div>
                <div>
                  <div class="db-platform-name">${escapeHtml(lbl)}</div>
                  <div class="db-platform-sub">${money(val)}</div>
                </div>
              </div>
              <span class="db-platform-pct ${pctCls}">↑ ${pct}%</span>
            </div>
            <div class="db-platform-track"><div class="db-platform-fill" style="width:${barW}%"></div></div>
          </div>`;
        }).join("");
      }
    }
  })();

  // ===== SALES MODULE (Starline layout) =====
  const sales = data.sales || [];
  // k and fin already declared above (dashboard KPIs section)

  // ── KPI tiles ──
  const slRevenue = el("slRevenue");
  if (slRevenue) slRevenue.textContent = money(k.salesMonth || 0);

  const slOrders = el("slOrders");
  if (slOrders) slOrders.textContent = sales.length;

  const slCustomers = el("slCustomers");
  if (slCustomers) slCustomers.textContent = (data.customers || []).length;

  // Trend text from profit margin
  const margin = (fin.week || {}).profitMargin || 0;
  const trendText = margin > 0 ? `${margin}%` : "—";
  [el("slRevenueTrend"), el("slOrdersTrend"), el("slCustomersTrend")].forEach(el2 => {
    const pctEl = el2 && el2.querySelector ? el2.querySelector(".sl-trend-pct") : null;
    if (pctEl) pctEl.textContent = trendText;
  });

  // ── Summary card ──
  const slTotalSales = el("slTotalSales");
  if (slTotalSales) slTotalSales.textContent = sales.length;
  const slMonthSales = el("slMonthSales");
  if (slMonthSales) slMonthSales.textContent = money(k.salesMonth || 0);
  const slTodaySales = el("slTodaySales");
  if (slTodaySales) slTodaySales.textContent = money(k.salesToday || 0);
  const slSummaryTrend = el("slSummaryTrend");
  if (slSummaryTrend) slSummaryTrend.textContent = trendText !== "—" ? trendText : "—";

  // ── Orders Overview line chart ──
  (function renderSlOrdersChart() {
    const container = el("slOrdersChart");
    if (!container) return;
    const chartData = (data.charts || {}).revenue || [];
    const profitData = (data.charts || {}).profit || chartData.map(r => ({ day: r.day, value: Math.max(0, r.value * 0.35) }));
    if (!chartData.length) { container.innerHTML = `<div class="event" style="margin-top:20px">No revenue data yet</div>`; return; }

    const W = 500, H = 200, pad = { t: 16, b: 36, l: 46, r: 16 };
    const allVals = [...chartData, ...profitData].map(r => Number(r.value || 0));
    const maxV = Math.max(1, ...allVals);
    const n = chartData.length;
    const xStep = (W - pad.l - pad.r) / Math.max(1, n - 1);
    const yScale = v => pad.t + (1 - v / maxV) * (H - pad.t - pad.b);

    // Y-axis labels
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({
      v: Math.round(maxV * f),
      y: yScale(maxV * f)
    }));
    const yLabels = yTicks.map(t =>
      `<text x="${pad.l - 8}" y="${t.y + 4}" text-anchor="end" font-size="9" fill="rgba(0,0,0,.35)" font-family="Inter,sans-serif">${t.v >= 1000 ? Math.round(t.v / 1000) + "k" : t.v}</text>
       <line x1="${pad.l}" y1="${t.y}" x2="${W - pad.r}" y2="${t.y}" stroke="rgba(0,0,0,.07)" stroke-width="1"/>`
    ).join("");

    // X-axis labels — show ~6 evenly spaced
    const xIdxs = n <= 6 ? chartData.map((_, i) => i) : [0, Math.floor(n * 0.14), Math.floor(n * 0.28), Math.floor(n * 0.43), Math.floor(n * 0.57), Math.floor(n * 0.71), Math.floor(n * 0.86), n - 1];
    const xLabels = xIdxs.map(i => {
      const x = pad.l + i * xStep;
      const lbl = String(chartData[i]?.day || "").slice(5);
      return `<text x="${x.toFixed(1)}" y="${H - pad.b + 14}" text-anchor="middle" font-size="9" fill="rgba(0,0,0,.38)" font-family="Inter,sans-serif">${escapeHtml(lbl)}</text>`;
    }).join("");

    // Revenue line (orange)
    const rPts = chartData.map((r, i) => ({ x: pad.l + i * xStep, y: yScale(Number(r.value || 0)) }));
    const rPath = rPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const rArea = rPath + ` L${rPts[n-1].x.toFixed(1)},${(H - pad.b).toFixed(1)} L${pad.l},${(H - pad.b).toFixed(1)} Z`;

    // Profit line (purple)
    const pPts = profitData.map((r, i) => ({ x: pad.l + i * xStep, y: yScale(Number(r.value || 0)) }));
    const pPath = pPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
      <defs>
        <linearGradient id="slRevGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      ${yLabels}
      <path d="${rArea}" fill="url(#slRevGrad)"/>
      <path d="${rPath}" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${pPath}" fill="none" stroke="#8b5cf6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${rPts.filter((_, i) => i % Math.max(1, Math.floor(n / 8)) === 0 || i === n - 1)
          .map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#f59e0b"/>`).join("")}
      ${pPts.filter((_, i) => i % Math.max(1, Math.floor(n / 8)) === 0 || i === n - 1)
          .map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#8b5cf6"/>`).join("")}
      ${xLabels}
    </svg>`;
  })();

  // ── Donut chart ──
  (function renderSlDonut() {
    const paid = sales.filter(s => s.payment_status === "PAID").length;
    const credit = sales.filter(s => s.payment_status === "CREDIT").length;
    const total = sales.length || 1;
    const circ = 2 * Math.PI * 58; // ~364.4

    const paidFrac  = paid / total;
    const creditFrac = credit / total;
    const overdueFrac = Math.max(0, 1 - paidFrac - creditFrac);

    // Build stacked dash arrays with offsets
    const paidDash   = (paidFrac * circ).toFixed(1);
    const creditDash = (creditFrac * circ).toFixed(1);
    const overdueDash = (overdueFrac * circ).toFixed(1);

    const startOffset = (circ * 0.25).toFixed(1); // start at top
    const creditOffset = (circ * 0.25 - paidFrac * circ).toFixed(1);
    const overdueOffset = (circ * 0.25 - (paidFrac + creditFrac) * circ).toFixed(1);

    const paidEl   = el("slDonutPaid");
    const creditEl = el("slDonutCredit");
    const retEl    = el("slDonutReturned");
    const pctEl    = el("slDonutPct");

    if (paidEl) {
      paidEl.setAttribute("stroke-dasharray", `${paidDash} ${(circ - paidFrac * circ).toFixed(1)}`);
      paidEl.setAttribute("stroke-dashoffset", startOffset);
    }
    if (creditEl) {
      creditEl.setAttribute("stroke-dasharray", `${creditDash} ${(circ - creditFrac * circ).toFixed(1)}`);
      creditEl.setAttribute("stroke-dashoffset", creditOffset);
    }
    if (retEl) {
      retEl.setAttribute("stroke-dasharray", `${overdueDash} ${(circ - overdueFrac * circ).toFixed(1)}`);
      retEl.setAttribute("stroke-dashoffset", overdueOffset);
    }
    if (pctEl) pctEl.textContent = total > 1 ? `${Math.round(paidFrac * 100)}%` : "—";

    const paidPctEl = el("slDonutPaidPct");
    const creditPctEl = el("slDonutCreditPct");
    const ovPctEl = el("slDonutReturnedPct");
    if (paidPctEl) paidPctEl.textContent = `${Math.round(paidFrac * 100)}%`;
    if (creditPctEl) creditPctEl.textContent = `${Math.round(creditFrac * 100)}%`;
    if (ovPctEl) ovPctEl.textContent = `${Math.round(overdueFrac * 100)}%`;
  })();

  // ── Top products ──
  (function renderSlTopProducts() {
    const tbody = el("slTopProducts");
    if (!tbody) return;
    const byProduct = {};
    sales.forEach(s => {
      const name = s.item_name || "Unknown";
      if (!byProduct[name]) byProduct[name] = { name, revenue: 0, qty: 0 };
      byProduct[name].revenue += Number(s.amount || 0);
      byProduct[name].qty += Number(s.quantity || 0);
    });
    const top = Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    tbody.innerHTML = top.length ? top.map(p => `
      <tr>
        <td><div class="sl-prod-name"><div class="sl-prod-avatar">${escapeHtml(p.name.slice(0, 2))}</div>${escapeHtml(p.name)}</div></td>
        <td>${money(p.revenue)}</td>
        <td>${p.qty.toLocaleString()}</td>
      </tr>
    `).join("") : `<tr><td colspan="3" style="padding:12px 10px;color:var(--text-muted);font-size:12px">No sales data yet</td></tr>`;
  })();

  // ── Recent sales table ──
  const salesTable = el("salesTable");
  if (salesTable) salesTable.innerHTML = sales.map((s) => `
    <tr>
      <td>${new Date(s.created_at).toLocaleDateString()}</td>
      <td>${escapeHtml(s.item_name)}</td>
      <td>${fmt(s.quantity, s.unit)}</td>
      <td>${escapeHtml(s.customer_name || "")}</td>
      <td>${money(s.amount)}</td>
      <td>${pill(s.payment_status || "PAID")}</td>
    </tr>
  `).join("") || `<tr><td colspan="6" style="padding:14px 16px;color:var(--text-muted)">No sales recorded yet</td></tr>`;

  // ===== PURCHASES (FinSet Analytics style) =====
  (function renderPurchases() {
    const purchases = data.purchases || [];
    const COLORS = ["#7c5cd8","#c4b5fd","#4ade80","#fb923c","#60a5fa","#f472b6","#a3e635","#34d399"];
    const PAGE_SIZE = 7;
    if (!window._purState) window._purState = { period: "month", page: 1, donutType: "supplier" };

    function finInt(n) { return Math.floor(Math.abs(Number(n||0))).toLocaleString(); }

    function renderAll() {
      const total   = purchases.reduce((s,p) => s + Number(p.total_cost||0), 0);
      const paid    = purchases.filter(p => p.payment_status === "PAID");
      const credit  = purchases.filter(p => p.payment_status === "CREDIT");
      const paidAmt  = paid.reduce((s,p) => s + Number(p.total_cost||0), 0);
      const creditAmt= credit.reduce((s,p) => s + Number(p.total_cost||0), 0);
      const suppliers = [...new Set(purchases.map(p => p.supplier_name).filter(Boolean))];

      // Stat cards
      const b = el("purTotalBig");  if(b) b.textContent = finInt(total);
      const p2= el("purPaidBig");   if(p2) p2.textContent = finInt(paidAmt);
      const c = el("purCreditBig"); if(c) c.textContent = finInt(creditAmt);
      const tc= el("purTxnChip");   if(tc) tc.textContent = `${purchases.length} transactions`;
      const sc= el("purSupChip");   if(sc) sc.textContent = `${suppliers.length} suppliers`;
      const pc= el("purPaidChip");  if(pc) pc.textContent = `${paid.length} transactions`;
      const pp= el("purPaidPctChip"); if(pp) pp.textContent = total>0 ? `${Math.round(paidAmt/total*100)}% of total` : "0% of total";
      const cc= el("purCreditChip"); if(cc) cc.textContent = `${credit.length} transactions`;
      const cp= el("purCreditPctChip"); if(cp) cp.textContent = total>0 ? `${Math.round(creditAmt/total*100)}% of total` : "0% of total";
      const lb= el("purLineBadge"); if(lb) lb.textContent = `Total: ${money(total)} ▾`;

      // Line chart — use revenue chart data as proxy trend
      finRenderLineChart("purLineChart", (data.charts||{}).revenue||[], "#7c5cd8");

      // Donut
      const dtype = window._purState.donutType;
      const dscEl = el("purDonutDesc");
      if(dscEl) dscEl.textContent = dtype==="supplier" ? "Spend by supplier this period" : "Spend by item this period";
      const groups = {};
      purchases.forEach(p => {
        const key = dtype==="supplier" ? (p.supplier_name||"Unknown") : (p.item_name||"Unknown");
        groups[key] = (groups[key]||0) + Number(p.total_cost||0);
      });
      finRenderDonut("purDonutSvg", "purDonutLegend", "purDonutTotal", groups, COLORS);

      // Bar chart
      finRenderBarChart("purBarChart", purchases.map(p=>({date:p.created_at,value:Number(p.total_cost||0)})), "#7c5cd8","#c4b5fd");

      // Table
      const badge = el("purTableBadge"); if(badge) badge.textContent = `${purchases.length} records`;
      const page = window._purState.page;
      const slice = purchases.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
      const tbody = el("purchasesTable");
      if(tbody) tbody.innerHTML = slice.length ? slice.map((p,i) => {
        const date = p.created_at ? new Date(p.created_at).toLocaleDateString("en-KE",{day:"2-digit",month:"short",year:"numeric"}) : "—";
        const statusCls = p.payment_status==="PAID" ? "fin-status-paid" : "fin-status-credit";
        const statusLbl = p.payment_status==="PAID" ? "Paid" : "On Credit";
        return `<tr>
          <td><span class="oh-sno">${(page-1)*PAGE_SIZE+i+1}</span></td>
          <td style="color:#7b7295;font-size:12px">${date}</td>
          <td style="font-weight:600">${escapeHtml(p.supplier_name||"—")}</td>
          <td>${escapeHtml(p.item_name||"—")}</td>
          <td style="font-weight:700">${money(p.total_cost||0)}</td>
          <td><span class="${statusCls}">${statusLbl}</span></td>
        </tr>`;
      }).join("") : `<tr><td colspan="6"><div class="oh-empty">No purchases yet.</div></td></tr>`;
      renderOhPagination("purPagination", Math.max(1,Math.ceil(purchases.length/PAGE_SIZE)), page, p=>{ window._purState.page=p; renderAll(); });
    }

    // Wire period buttons
    ["purPeriodMonth","purPeriodWeek"].forEach(id => {
      el(id)?.addEventListener("click", () => {
        document.querySelectorAll("#purchases .fin-period-btn").forEach(b=>b.classList.remove("active"));
        el(id)?.classList.add("active");
        window._purState.period = el(id)?.dataset.period;
        renderAll();
      });
    });
    // Wire donut toggle
    el("purDonutBtns")?.querySelectorAll(".fin-donut-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        el("purDonutBtns").querySelectorAll(".fin-donut-btn").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        window._purState.donutType = btn.dataset.dtype;
        renderAll();
      });
    });

    renderAll();
  })();

  // ===== EXPENSES (FinSet Analytics style) =====
  (function renderExpenses() {
    const expenses = data.expenses || [];
    const COLORS = ["#7c5cd8","#fb923c","#4ade80","#60a5fa","#f472b6","#a3e635","#34d399","#c4b5fd"];
    const PAGE_SIZE = 7;
    if (!window._expState) window._expState = { period: "month", page: 1, donutType: "expense" };

    function finInt(n) { return Math.floor(Math.abs(Number(n||0))).toLocaleString(); }

    function renderAll() {
      const fin2   = data.financials || {};
      const pd     = window._expState.period === "week" ? (fin2.week||{}) : (fin2.month||{});
      const totalExp = Number(pd.expenses||0) || expenses.reduce((s,e)=>s+Number(e.amount||0),0);
      const revenue  = Number(pd.revenue||0);
      const cats     = [...new Set(expenses.map(e=>e.category).filter(Boolean))];

      // Stat cards
      const b = el("expTotalBig"); if(b) b.textContent = finInt(totalExp);
      const r = el("expRevBig");   if(r) r.textContent = finInt(revenue);
      const e2= el("expExpBig");   if(e2) e2.textContent = finInt(totalExp);
      const tc= el("expTxnChip");  if(tc) tc.textContent = `${expenses.length} transactions`;
      const cc= el("expCatChip");  if(cc) cc.textContent = `${cats.length} categories`;
      const rc= el("expRevTxnChip"); if(rc) rc.textContent = `${(data.sales||[]).length} transactions`;
      const rc2=el("expRevCatChip"); if(rc2) rc2.textContent = `${(data.customers||[]).length} customers`;
      const ec= el("expExpTxnChip"); if(ec) ec.textContent = `${expenses.length} transactions`;
      const ec2=el("expExpCatChip"); if(ec2) ec2.textContent = `${cats.length} categories`;
      const lb= el("expLineBadge"); if(lb) lb.textContent = `Total balance ▾`;

      // Line chart — revenue trend
      finRenderLineChart("expLineChart", (data.charts||{}).revenue||[], "#7c5cd8");

      // Donut
      const dtype = window._expState.donutType;
      const dscEl = el("expDonutDesc");
      if(dscEl) dscEl.textContent = dtype==="expense"
        ? "Expense breakdown by category this period"
        : "Revenue breakdown this period";

      let groups = {};
      if(dtype === "expense") {
        expenses.forEach(e => {
          const key = e.category||"Other";
          groups[key] = (groups[key]||0) + Number(e.amount||0);
        });
      } else {
        (data.sales||[]).forEach(s => {
          const key = s.item_name||"Sale";
          groups[key] = (groups[key]||0) + Number(s.amount||0);
        });
      }
      finRenderDonut("expDonutSvg", "expDonutLegend", "expDonutTotal", groups, COLORS);

      // Bar chart (expense vs revenue comparison)
      finRenderBarChart("expBarChart", (data.charts||{}).revenue||[], "#7c5cd8","#c4b5fd");

      // Table
      const badge = el("expTableBadge"); if(badge) badge.textContent = `${expenses.length} records`;
      const page = window._expState.page;
      const slice = expenses.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
      const tbody = el("expensesTable");
      if(tbody) tbody.innerHTML = slice.length ? slice.map((e,i) => {
        const date = e.created_at ? new Date(e.created_at).toLocaleDateString("en-KE",{day:"2-digit",month:"short",year:"numeric"}) : "—";
        const catLabel = String(e.category||"Other").toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
        return `<tr>
          <td><span class="oh-sno">${(page-1)*PAGE_SIZE+i+1}</span></td>
          <td style="color:#7b7295;font-size:12px">${date}</td>
          <td><span class="fin-badge fin-badge--total" style="font-size:11px">${escapeHtml(catLabel)}</span></td>
          <td style="color:#7b7295">${escapeHtml(e.description||"—")}</td>
          <td style="font-weight:700;color:#dc2626">${money(e.amount||0)}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="5"><div class="oh-empty">No expenses yet.</div></td></tr>`;
      renderOhPagination("expPagination", Math.max(1,Math.ceil(expenses.length/PAGE_SIZE)), page, p=>{ window._expState.page=p; renderAll(); });
    }

    // Wire period buttons
    ["expPeriodMonth","expPeriodWeek"].forEach(id => {
      el(id)?.addEventListener("click", () => {
        document.querySelectorAll("#expenses .fin-period-btn").forEach(b=>b.classList.remove("active"));
        el(id)?.classList.add("active");
        window._expState.period = el(id)?.dataset.period;
        renderAll();
      });
    });
    // Wire donut toggle
    el("expDonutBtns")?.querySelectorAll(".fin-donut-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        el("expDonutBtns").querySelectorAll(".fin-donut-btn").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        window._expState.donutType = btn.dataset.dtype;
        renderAll();
      });
    });

    renderAll();
  })();

  // ===== PRODUCTION (Order-History style) =====
  (function renderProduction() {
    const entries = data.productionEntries || [];
    const jobs    = data.jobs || [];
    const PAGE_SIZE = 7;
    if (!window._prodState) window._prodState = { filter: "entries", page: 1 };

    function ohEmptyRow(cols) {
      return `<tr><td colspan="${cols}"><div class="oh-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M5.34 18.66l-1.41 1.41M12 2v2M12 20v2M4.93 4.93l1.41 1.41M18.66 18.66l1.41 1.41M2 12h2M20 12h2"/></svg>
        No data found.</div></td></tr>`;
    }

    function jobStatusCls(s) {
      const v = String(s||"").toUpperCase();
      if (v === "COMPLETED") return "oh-status--delivered";
      if (v === "CANCELLED") return "oh-status--cancelled";
      if (v === "IN_PROGRESS" || v === "RUNNING") return "oh-status--processing";
      return "oh-status--pending";
    }

    function renderProdTable() {
      const { filter, page } = window._prodState;
      const summaryRow = el("prodSummaryRow");
      const entriesTable = el("prodEntriesTable");
      const jobsTable2   = el("prodJobsTable");

      if (filter === "summary") {
        if (summaryRow) summaryRow.hidden = false;
        if (entriesTable) entriesTable.hidden = true;
        if (jobsTable2)   jobsTable2.hidden   = true;
        const sE = el("prodSumEntries"); if (sE) sE.textContent = entries.length;
        const sU = el("prodSumUnits");   if (sU) sU.textContent = entries.reduce((a,e)=>a+Number(e.quantity_produced||0),0).toLocaleString();
        const sJ = el("prodSumJobs");    if (sJ) sJ.textContent = jobs.filter(j=>!["COMPLETED","CANCELLED"].includes(String(j.status||"").toUpperCase())).length;
        const sD = el("prodSumDone");    if (sD) sD.textContent = jobs.filter(j=>String(j.status||"").toUpperCase()==="COMPLETED").length;
        el("prodPagination").innerHTML = "";
        return;
      }
      if (summaryRow) summaryRow.hidden = true;

      const from = el("prodDateFrom")?.value;
      const to   = el("prodDateTo")?.value;

      if (filter === "jobs") {
        if (entriesTable) entriesTable.hidden = true;
        if (jobsTable2)   jobsTable2.hidden   = false;
        const tbody = el("jobsTable");
        if (!tbody) return;
        const slice = jobs.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
        tbody.innerHTML = slice.length ? slice.map((j,i) => `<tr>
          <td><span class="oh-sno">${(page-1)*PAGE_SIZE+i+1}</span></td>
          <td><span class="oh-order-id">${escapeHtml(j.job_no||"—")}</span></td>
          <td style="font-weight:600">${escapeHtml(j.product_name||"—")}</td>
          <td>${Number(j.target_qty||0).toLocaleString()}</td>
          <td>${Number(j.completed_qty||0).toLocaleString()}</td>
          <td><span class="oh-status ${jobStatusCls(j.status)}">${escapeHtml(String(j.status||"Pending").toLowerCase().replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase()))}</span></td>
          <td>${escapeHtml(j.operator||"Unassigned")}</td>
        </tr>`).join("") : ohEmptyRow(7);
        renderOhPagination("prodPagination", Math.max(1,Math.ceil(jobs.length/PAGE_SIZE)), page, p=>{window._prodState.page=p;renderProdTable();});
        return;
      }

      // entries tab (default)
      if (entriesTable) entriesTable.hidden = false;
      if (jobsTable2)   jobsTable2.hidden   = true;
      const filtered = entries.filter(e => {
        if (from) { const d=new Date(e.created_at); if(d<new Date(from)) return false; }
        if (to)   { const d=new Date(e.created_at); if(d>new Date(to+"T23:59:59")) return false; }
        return true;
      });
      const total = filtered.length;
      const safePage = Math.min(page, Math.max(1,Math.ceil(total/PAGE_SIZE)));
      window._prodState.page = safePage;
      const slice = filtered.slice((safePage-1)*PAGE_SIZE, safePage*PAGE_SIZE);
      const tbody = el("productionTable");
      if (tbody) tbody.innerHTML = slice.length ? slice.map((e,i) => `<tr>
        <td><span class="oh-sno">${(safePage-1)*PAGE_SIZE+i+1}</span></td>
        <td style="color:#6b7a99;font-size:12px">${new Date(e.created_at).toLocaleDateString("en-KE",{day:"2-digit",month:"short",year:"numeric"})}</td>
        <td style="font-weight:600">${escapeHtml(e.product_name||"—")}</td>
        <td style="font-weight:700">${fmt(e.quantity_produced,"units")}</td>
        <td><span class="oh-order-id">${escapeHtml(e.job_no||"—")}</span></td>
        <td style="color:#6b7a99">${escapeHtml(e.source||"—")}</td>
      </tr>`).join("") : ohEmptyRow(6);
      renderOhPagination("prodPagination", Math.max(1,Math.ceil(total/PAGE_SIZE)), safePage, p=>{window._prodState.page=p;renderProdTable();});
    }

    const tabList = el("prodTabList");
    if (tabList && !tabList.dataset.wired) {
      tabList.dataset.wired = "1";
      tabList.querySelectorAll(".oh-tab").forEach(btn => {
        btn.addEventListener("click", () => {
          tabList.querySelectorAll(".oh-tab").forEach(t=>t.classList.remove("active"));
          btn.classList.add("active");
          window._prodState.filter = btn.dataset.filter;
          window._prodState.page = 1;
          renderProdTable();
        });
      });
      el("prodDateFrom")?.addEventListener("change", ()=>{window._prodState.page=1;renderProdTable();});
      el("prodDateTo")?.addEventListener("change",   ()=>{window._prodState.page=1;renderProdTable();});
      const fromEl=el("prodDateFrom"), toEl=el("prodDateTo");
      if (fromEl&&!fromEl.value) { const n=new Date(); fromEl.value=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-01`; }
      if (toEl&&!toEl.value)     { toEl.value=new Date().toISOString().slice(0,10); }
    }
    renderProdTable();
  })();

  // ===== INVENTORY (Order-History style) =====
  (function renderInventory() {
    const items = data.inventory || [];
    const movements = data.inventoryTransactions || [];
    const PAGE_SIZE = 7;
    if (!window._invState) window._invState = { filter: "all", page: 1 };

    function invStatusCls(low) { return low ? "oh-status--cancelled" : "oh-status--delivered"; }

    function renderInvTable() {
      const { filter, page } = window._invState;
      const summaryRow  = el("invSummaryRow");
      const stockTable  = el("invStockTable");
      const movTable    = el("invMovTable");

      // Always show summary bar for non-movements tabs
      const showSummary = filter !== "movements";
      if (summaryRow) summaryRow.hidden = !showSummary;
      if (showSummary) {
        const total   = items.length;
        const mats    = items.filter(i=>String(i.item_type||"").toUpperCase().includes("MATERIAL")).length;
        const prods   = items.filter(i=>!String(i.item_type||"").toUpperCase().includes("MATERIAL")).length;
        const lowCnt  = items.filter(i=>Number(i.quantity)<=Number(i.reorder_level)).length;
        const sT=el("invSumTotal");     if(sT) sT.textContent=total;
        const sM=el("invSumMaterials"); if(sM) sM.textContent=mats;
        const sP=el("invSumProducts"); if(sP) sP.textContent=prods;
        const sL=el("invSumLow");      if(sL) sL.textContent=lowCnt;
      }

      if (filter === "movements") {
        if (stockTable) stockTable.hidden = true;
        if (movTable)   movTable.hidden   = false;
        const tbody = el("invMovementsBody");
        if (!tbody) return;
        const total = movements.length;
        const safePage = Math.min(page, Math.max(1,Math.ceil(total/PAGE_SIZE)));
        window._invState.page = safePage;
        const slice = movements.slice((safePage-1)*PAGE_SIZE, safePage*PAGE_SIZE);
        tbody.innerHTML = slice.length ? slice.map((t,i)=>`<tr>
          <td><span class="oh-sno">${(safePage-1)*PAGE_SIZE+i+1}</span></td>
          <td style="font-weight:600">${escapeHtml(t.item_name||"—")}</td>
          <td><span class="oh-status ${t.action==="IN"?"oh-status--delivered":"oh-status--cancelled"}">${escapeHtml(t.action||"—")}</span></td>
          <td>${fmt(t.before_qty,t.unit)}</td>
          <td>${fmt(t.after_qty,t.unit)}</td>
          <td style="color:#6b7a99">${escapeHtml(t.source||"—")}</td>
          <td style="color:#6b7a99;font-size:12px">${new Date(t.created_at).toLocaleDateString("en-KE",{day:"2-digit",month:"short",year:"numeric"})}</td>
        </tr>`).join("") : `<tr><td colspan="7"><div class="oh-empty">No stock movements yet.</div></td></tr>`;
        renderOhPagination("invPagination", Math.max(1,Math.ceil(total/PAGE_SIZE)), safePage, p=>{window._invState.page=p;renderInvTable();});
        return;
      }

      if (stockTable) stockTable.hidden = false;
      if (movTable)   movTable.hidden   = true;

      const filtered = items.filter(i => {
        if (filter === "material") return String(i.item_type||"").toUpperCase().includes("MATERIAL");
        if (filter === "product")  return !String(i.item_type||"").toUpperCase().includes("MATERIAL");
        if (filter === "low")      return Number(i.quantity) <= Number(i.reorder_level);
        return true;
      });
      const total = filtered.length;
      const safePage = Math.min(page, Math.max(1,Math.ceil(total/PAGE_SIZE)));
      window._invState.page = safePage;
      const slice = filtered.slice((safePage-1)*PAGE_SIZE, safePage*PAGE_SIZE);
      const tbody = el("inventoryTable");
      if (tbody) tbody.innerHTML = slice.length ? slice.map((i2,idx)=>{
        const low = Number(i2.quantity) <= Number(i2.reorder_level);
        const typeLabel = String(i2.item_type||"").replaceAll("_"," ").toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
        return `<tr>
          <td><span class="oh-sno">${(safePage-1)*PAGE_SIZE+idx+1}</span></td>
          <td style="font-weight:600">${escapeHtml(i2.item_name||"—")}</td>
          <td style="color:#6b7a99">${escapeHtml(typeLabel)}</td>
          <td style="font-weight:700">${fmt(i2.quantity,i2.unit)}</td>
          <td>${fmt(i2.reorder_level,i2.unit)}</td>
          <td><span class="oh-status ${invStatusCls(low)}">${low?"Low Stock":"OK"}</span></td>
        </tr>`;
      }).join("") : `<tr><td colspan="6"><div class="oh-empty">No items found.</div></td></tr>`;
      renderOhPagination("invPagination", Math.max(1,Math.ceil(total/PAGE_SIZE)), safePage, p=>{window._invState.page=p;renderInvTable();});
    }

    const tabList = el("invTabList");
    if (tabList && !tabList.dataset.wired) {
      tabList.dataset.wired = "1";
      tabList.querySelectorAll(".oh-tab").forEach(btn => {
        btn.addEventListener("click", () => {
          tabList.querySelectorAll(".oh-tab").forEach(t=>t.classList.remove("active"));
          btn.classList.add("active");
          window._invState.filter = btn.dataset.filter;
          window._invState.page = 1;
          renderInvTable();
        });
      });
    }
    renderInvTable();
  })();

  // ===== DEBTS & CREDITS =====
  (function renderDebts() {
    const custDebts = data.customerDebts || [];
    const supDebts  = data.supplierDebts  || [];

    // ── Stat cards ──
    const totalRec = custDebts.reduce((s, d) => s + Math.max(0, Number(d.amount_owed) - Number(d.amount_paid)), 0);
    const totalPay = supDebts.reduce((s,  d) => s + Math.max(0, Number(d.amount_owed) - Number(d.amount_paid)), 0);
    const netBal   = totalRec - totalPay;
    const custOverdue = custDebts.filter(d => d.status === "overdue").length;
    const supOverdue  = supDebts.filter(d  => d.status === "overdue").length;

    // Split number into integer + decimal for big display
    function splitMoney(n) {
      const abs = Math.abs(n);
      const s   = abs.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const [i, dec] = s.split(".");
      return { int: (n < 0 ? "-" : "") + i, dec: dec || "00" };
    }

    const nb = splitMoney(netBal);
    const re = splitMoney(totalRec);
    const py = splitMoney(totalPay);

    const dcNet = el("dcNetBalance");  if (dcNet) dcNet.textContent  = nb.int;
    const dcRec = el("dcReceivables"); if (dcRec) dcRec.textContent  = re.int;
    const dcPay = el("dcPayables");    if (dcPay) dcPay.textContent  = py.int;
    ["dcNetBalance","dcReceivables","dcPayables"].forEach((id, i) => {
      const decEl = document.querySelector(`#${id} + .dc-stat-dec`);
      if (decEl) decEl.textContent = "." + [nb.dec, re.dec, py.dec][i];
    });

    const dcTR = el("dcTotalReceivables"); if (dcTR) dcTR.textContent = `${money(totalRec)} owed to you`;
    const dcTP = el("dcTotalPayables");    if (dcTP) dcTP.textContent = `${money(totalPay)} you owe`;
    const dcCC = el("dcCustDebtCount");    if (dcCC) dcCC.textContent = `${custDebts.length} customer${custDebts.length !== 1 ? "s" : ""}`;
    const dcCO = el("dcCustOverdue");      if (dcCO) dcCO.textContent = `${custOverdue} overdue`;
    const dcSC = el("dcSupDebtCount");     if (dcSC) dcSC.textContent = `${supDebts.length} supplier${supDebts.length !== 1 ? "s" : ""}`;
    const dcSO = el("dcSupOverdue");       if (dcSO) dcSO.textContent = `${supOverdue} overdue`;
    const dcCB = el("dcCustBadge");        if (dcCB) dcCB.textContent = `${custDebts.length} active`;
    const dcSB = el("dcSupBadge");         if (dcSB) dcSB.textContent = `${supDebts.length} active`;

    const dcBT = el("dcBalanceTrend");
    if (dcBT) dcBT.textContent = netBal >= 0 ? `+${money(netBal)} net positive` : `${money(netBal)} net negative`;

    // ── Balance overview line chart ──
    // Build synthetic time-series: receivables and payables by month
    function buildDebtSeries(debts, nameKey) {
      const byDate = {};
      debts.forEach(d => {
        const dt = d.due_date || d.created_at || null;
        if (!dt) return;
        const mo = dt.slice(0, 7); // "YYYY-MM"
        byDate[mo] = (byDate[mo] || 0) + Math.max(0, Number(d.amount_owed) - Number(d.amount_paid));
      });
      return Object.entries(byDate).sort().map(([mo, v]) => ({ label: mo, value: v }));
    }
    const recSeries = buildDebtSeries(custDebts, "customer_name");
    const paySeries = buildDebtSeries(supDebts,  "supplier_name");

    // Use finRenderLineChart for the line chart if available
    const lineEl = el("dcLineChart");
    if (lineEl && recSeries.length) {
      lineEl.innerHTML = "";
      finRenderLineChart("dcLineChart", recSeries.map(r => r.value), "#7c5cd8");
    } else if (lineEl) {
      lineEl.innerHTML = `<div style="color:var(--fin-muted,#888);font-size:13px;padding:16px 0">No debt data yet</div>`;
    }

    // ── Chart tab wiring ──
    const dcChartTabs = el("dcChartTabs");
    if (dcChartTabs && !dcChartTabs.dataset.wired) {
      dcChartTabs.dataset.wired = "1";
      dcChartTabs.querySelectorAll(".dc-chart-tab").forEach(btn => {
        btn.addEventListener("click", () => {
          dcChartTabs.querySelectorAll(".dc-chart-tab").forEach(t => t.classList.remove("active"));
          btn.classList.add("active");
          const view = btn.dataset.view;
          const series = view === "payables" ? paySeries : recSeries;
          if (lineEl) {
            lineEl.innerHTML = "";
            if (series.length) finRenderLineChart("dcLineChart", series.map(r => r.value), view === "payables" ? "#fb923c" : "#7c5cd8");
            else lineEl.innerHTML = `<div style="color:var(--fin-muted,#888);font-size:13px;padding:16px 0">No data</div>`;
          }
        });
      });
    }

    // ── Donut (statistics) ──
    const dcDonutType = el("dcDonutType");
    function renderDcDonut(type) {
      const items = type === "payables" ? supDebts : custDebts;
      const nameKey = type === "payables" ? "supplier_name" : "customer_name";
      const desc = el("dcDonutDesc");
      if (desc) desc.textContent = type === "payables" ? "Top suppliers by outstanding payable" : "Top customers by outstanding debt";

      const totals = {};
      items.forEach(d => {
        const n = d[nameKey] || "Unknown";
        totals[n] = (totals[n] || 0) + Math.max(0, Number(d.amount_owed) - Number(d.amount_paid));
      });
      const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const grandTotal = sorted.reduce((s, [, v]) => s + v, 0) || 1;

      const colors = ["#7c5cd8", "#fb923c", "#34d399", "#60a5fa", "#f472b6"];
      const circ   = 2 * Math.PI * 40; // r=40
      let offset   = 0;

      const svgEl = document.querySelector("#debts .dc-donut-svg");
      if (svgEl) {
        svgEl.innerHTML = `<circle cx="56" cy="56" r="40" fill="none" stroke="#f0f0f8" stroke-width="16"/>`;
        sorted.forEach(([name, val], i) => {
          const share = val / grandTotal;
          const dash  = share * circ;
          const gap   = circ - dash;
          const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          circle.setAttribute("cx", "56"); circle.setAttribute("cy", "56"); circle.setAttribute("r", "40");
          circle.setAttribute("fill", "none"); circle.setAttribute("stroke", colors[i] || "#ccc");
          circle.setAttribute("stroke-width", "16");
          circle.setAttribute("stroke-dasharray", `${dash.toFixed(1)} ${gap.toFixed(1)}`);
          circle.setAttribute("stroke-dashoffset", `${(circ / 4 - offset).toFixed(1)}`);
          circle.setAttribute("stroke-linecap", "round");
          circle.style.transition = "stroke-dasharray .6s ease";
          svgEl.appendChild(circle);
          offset += dash;
        });
      }

      const centerEl = document.querySelector("#debts .dc-donut-center-val");
      if (centerEl) centerEl.textContent = money(grandTotal);

      const legendEl = el("dcDonutLegend");
      if (legendEl) {
        legendEl.innerHTML = sorted.map(([name, val], i) => `
          <div class="dc-leg-row">
            <span class="dc-leg-dot" style="background:${colors[i] || "#ccc"}"></span>
            <span class="dc-leg-name">${escapeHtml(name)}</span>
            <strong class="dc-leg-val">${money(val)}</strong>
          </div>`).join("") || `<div style="color:#aaa;font-size:12px">No data</div>`;
      }
    }

    renderDcDonut(dcDonutType ? dcDonutType.value : "receivables");
    if (dcDonutType && !dcDonutType.dataset.wired) {
      dcDonutType.dataset.wired = "1";
      dcDonutType.addEventListener("change", () => renderDcDonut(dcDonutType.value));
    }

    // ── Customer Debts table ──
    const custTbody = el("customerDebtsTable");
    if (custTbody) {
      custTbody.innerHTML = custDebts.length ? custDebts.map(d => {
        const remaining = Math.max(0, Number(d.amount_owed) - Number(d.amount_paid));
        return `<tr>
          <td style="font-weight:600">${escapeHtml(d.customer_name || "—")}</td>
          <td>${money(d.amount_owed)}</td>
          <td>${money(d.amount_paid)}</td>
          <td><strong>${money(remaining)}</strong></td>
          <td>${pill(d.status)}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="5" class="dc-empty">No customer debts</td></tr>`;
    }

    // ── Supplier Payables table ──
    const supTbody = el("supplierDebtsTable");
    if (supTbody) {
      supTbody.innerHTML = supDebts.length ? supDebts.map(d => {
        const remaining = Math.max(0, Number(d.amount_owed) - Number(d.amount_paid));
        return `<tr>
          <td style="font-weight:600">${escapeHtml(d.supplier_name || "—")}</td>
          <td>${money(d.amount_owed)}</td>
          <td>${money(d.amount_paid)}</td>
          <td><strong>${money(remaining)}</strong></td>
          <td>${pill(d.status)}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="5" class="dc-empty">No supplier payables</td></tr>`;
    }
  })();

  // ===== CUSTOMERS =====
  (function renderCustomers() {
    const customers = data.customers || [];
    const custDebts = data.customerDebts || [];
    const sales     = data.sales || [];

    // Build lookup maps
    const debtByCustomer = {};
    const statusByCustomer = {};
    custDebts.forEach(d => {
      const rem = Math.max(0, Number(d.amount_owed) - Number(d.amount_paid));
      debtByCustomer[d.customer_id] = (debtByCustomer[d.customer_id] || 0) + rem;
      if (d.status === "overdue") statusByCustomer[d.customer_id] = "overdue";
      else if (!statusByCustomer[d.customer_id]) statusByCustomer[d.customer_id] = d.status;
    });

    const revenueByCustomer = {};
    const salesCountByCustomer = {};
    sales.forEach(s => {
      const cname = (s.customer_name || s.customer || "").toLowerCase().trim();
      if (!cname) return;
      // match by name (best effort)
      const matched = customers.find(c => (c.name || "").toLowerCase().trim() === cname);
      if (matched) {
        revenueByCustomer[matched.id]    = (revenueByCustomer[matched.id]    || 0) + Number(s.amount || 0);
        salesCountByCustomer[matched.id] = (salesCountByCustomer[matched.id] || 0) + 1;
      }
    });

    // Stat cards
    const totalRec    = Object.values(debtByCustomer).reduce((s, v) => s + v, 0);
    const withDebt    = Object.values(debtByCustomer).filter(v => v > 0).length;
    const overdueCnt  = Object.values(statusByCustomer).filter(v => v === "overdue").length;
    const paidCnt     = custDebts.filter(d => d.status === "paid").length;
    const totalRev    = Object.values(revenueByCustomer).reduce((s, v) => s + v, 0);
    const totalSales  = sales.length;
    const avgSale     = totalSales > 0 ? Math.round(totalRev / totalSales) : 0;

    const setBig = (id, n) => { const e = el(id); if (e) e.textContent = Number(n).toLocaleString(); };
    setBig("custTotalBig", customers.length);
    setBig("custRecBig",   Math.round(totalRec));
    setBig("custRevBig",   Math.round(totalRev));

    const se = (id, t) => { const e = el(id); if (e) e.textContent = t; };
    se("custActiveChip",  `${customers.length} active`);
    se("custDebtChip",    `${withDebt} with debt`);
    se("custOverdueChip", `${overdueCnt} overdue`);
    se("custPaidChip",    `${paidCnt} fully paid`);
    se("custSalesChip",   `${totalSales} sales`);
    se("custAvgChip",     `Avg ${money(avgSale)}`);
    se("custTableBadge",  `${customers.length} customer${customers.length !== 1 ? "s" : ""}`);

    // Table with pagination
    const PAGE = 10;
    if (!window._custState) window._custState = { page: 1 };

    function renderCustTable() {
      const tbody = el("customersTable");
      if (!tbody) return;
      const total    = customers.length;
      const pg       = Math.min(window._custState.page, Math.max(1, Math.ceil(total / PAGE)));
      window._custState.page = pg;
      const slice    = customers.slice((pg - 1) * PAGE, pg * PAGE);

      tbody.innerHTML = slice.length ? slice.map((c, i) => {
        const debt    = debtByCustomer[c.id] || 0;
        const rev     = revenueByCustomer[c.id] || 0;
        const st      = statusByCustomer[c.id] || (debt > 0 ? "pending" : "paid");
        const stClass = st === "overdue" ? "oh-status--cancelled" : debt > 0 ? "oh-status--pending" : "oh-status--delivered";
        const stLabel = st === "overdue" ? "Overdue" : debt > 0 ? "Pending" : "Clear";
        return `<tr>
          <td><span class="oh-sno">${(pg - 1) * PAGE + i + 1}</span></td>
          <td style="font-weight:600">${escapeHtml(c.name || "—")}</td>
          <td style="color:#6b7a99">${escapeHtml(c.phone || "—")}</td>
          <td>${rev > 0 ? money(rev) : "—"}</td>
          <td>${debt > 0 ? `<strong style="color:#dc2626">${money(debt)}</strong>` : `<span style="color:#16a34a">—</span>`}</td>
          <td><span class="oh-status ${stClass}">${stLabel}</span></td>
        </tr>`;
      }).join("") : `<tr><td colspan="6"><div class="oh-empty">No customers yet. Add your first customer above.</div></td></tr>`;

      renderOhPagination("custPagination", Math.max(1, Math.ceil(total / PAGE)), pg, p => { window._custState.page = p; renderCustTable(); });
    }
    renderCustTable();
  })();

  // ===== SUPPLIERS =====
  (function renderSuppliers() {
    const suppliers = data.suppliers || [];
    const supDebts  = data.supplierDebts || [];
    const purchases = data.purchases || [];

    // Build lookup maps
    const debtBySupplier = {};
    const statusBySupplier = {};
    supDebts.forEach(d => {
      const rem = Math.max(0, Number(d.amount_owed) - Number(d.amount_paid));
      debtBySupplier[d.supplier_id] = (debtBySupplier[d.supplier_id] || 0) + rem;
      if (d.status === "overdue") statusBySupplier[d.supplier_id] = "overdue";
      else if (!statusBySupplier[d.supplier_id]) statusBySupplier[d.supplier_id] = d.status;
    });

    const spendBySupplier = {};
    const purchaseCountBySupplier = {};
    purchases.forEach(p => {
      const sname = (p.supplier || "").toLowerCase().trim();
      if (!sname) return;
      const matched = suppliers.find(s => (s.name || "").toLowerCase().trim() === sname);
      if (matched) {
        spendBySupplier[matched.id]        = (spendBySupplier[matched.id]        || 0) + Number(p.total_cost || p.totalCost || 0);
        purchaseCountBySupplier[matched.id] = (purchaseCountBySupplier[matched.id] || 0) + 1;
      }
    });

    // Stat cards
    const totalPay    = Object.values(debtBySupplier).reduce((s, v) => s + v, 0);
    const withDebt    = Object.values(debtBySupplier).filter(v => v > 0).length;
    const overdueCnt  = Object.values(statusBySupplier).filter(v => v === "overdue").length;
    const paidCnt     = supDebts.filter(d => d.status === "paid").length;
    const totalSpend  = Object.values(spendBySupplier).reduce((s, v) => s + v, 0);
    const totalPurch  = purchases.length;
    const avgPurch    = totalPurch > 0 ? Math.round(totalSpend / totalPurch) : 0;

    const setBig = (id, n) => { const e = el(id); if (e) e.textContent = Number(n).toLocaleString(); };
    setBig("supTotalBig", suppliers.length);
    setBig("supPayBig",   Math.round(totalPay));
    setBig("supSpendBig", Math.round(totalSpend));

    const se = (id, t) => { const e = el(id); if (e) e.textContent = t; };
    se("supActiveChip",   `${suppliers.length} active`);
    se("supDebtChip",     `${withDebt} with payables`);
    se("supOverdueChip",  `${overdueCnt} overdue`);
    se("supPaidChip",     `${paidCnt} fully paid`);
    se("supPurchaseChip", `${totalPurch} purchases`);
    se("supAvgChip",      `Avg ${money(avgPurch)}`);
    se("supTableBadge",   `${suppliers.length} supplier${suppliers.length !== 1 ? "s" : ""}`);

    // Table with pagination
    const PAGE = 10;
    if (!window._supState) window._supState = { page: 1 };

    function renderSupTable() {
      const tbody = el("suppliersTable");
      if (!tbody) return;
      const total = suppliers.length;
      const pg    = Math.min(window._supState.page, Math.max(1, Math.ceil(total / PAGE)));
      window._supState.page = pg;
      const slice = suppliers.slice((pg - 1) * PAGE, pg * PAGE);

      tbody.innerHTML = slice.length ? slice.map((s, i) => {
        const debt    = debtBySupplier[s.id] || 0;
        const spend   = spendBySupplier[s.id] || 0;
        const st      = statusBySupplier[s.id] || (debt > 0 ? "pending" : "paid");
        const stClass = st === "overdue" ? "oh-status--cancelled" : debt > 0 ? "oh-status--pending" : "oh-status--delivered";
        const stLabel = st === "overdue" ? "Overdue" : debt > 0 ? "Pending" : "Clear";
        return `<tr>
          <td><span class="oh-sno">${(pg - 1) * PAGE + i + 1}</span></td>
          <td style="font-weight:600">${escapeHtml(s.name || "—")}</td>
          <td style="color:#6b7a99">${escapeHtml(s.phone || "—")}</td>
          <td style="color:#6b7a99">${escapeHtml(s.email || "—")}</td>
          <td>${spend > 0 ? money(spend) : "—"}</td>
          <td>${debt > 0 ? `<strong style="color:#dc2626">${money(debt)}</strong>` : `<span style="color:#16a34a">—</span>`}</td>
          <td><span class="oh-status ${stClass}">${stLabel}</span></td>
        </tr>`;
      }).join("") : `<tr><td colspan="7"><div class="oh-empty">No suppliers yet. Add your first supplier above.</div></td></tr>`;

      renderOhPagination("supPagination", Math.max(1, Math.ceil(total / PAGE)), pg, p => { window._supState.page = p; renderSupTable(); });
    }
    renderSupTable();
  })();

  // ===== REPORTS / P&L (FinSet Analytics style) =====
  (function renderPL() {
    if (!window._plState) window._plState = { period: "month" };

    const DONUT_COLORS = ["#7c5cd8","#c4b5fd","#4ade80","#fb923c","#60a5fa","#f472b6","#a3e635","#34d399"];

    function getPeriodData() {
      return window._plState.period === "week" ? (fin.week || {}) : (fin.month || {});
    }

    function splitMoney(n) {
      const v = Number(n || 0);
      const abs = Math.abs(v);
      const int = Math.floor(abs).toLocaleString();
      const dec = ".00";
      return { int: (v < 0 ? "-" : "") + int, dec };
    }

    function renderAll() {
      const pd = getPeriodData();
      const revenue  = Number(pd.revenue  || 0);
      const expenses = Number(pd.expenses || 0);
      const profit   = Number(pd.profit   || 0);
      const margin   = revenue > 0 ? Math.round(profit / revenue * 100) : 0;
      const sales    = data.sales || [];
      const customers = data.customers || [];
      const expCats  = (pd.expenseByCategory || []);

      // ── Stat cards ──
      function setVal(bigId, decId, n) {
        const { int, dec } = splitMoney(n);
        const b = el(bigId); if (b) b.textContent = int;
        const d = el(decId); if (d) d.textContent = dec;
      }
      setVal("plNetProfit",  "plNetProfitDec",  profit);
      setVal("plRevenue",    "plRevenueDec",     revenue);
      setVal("plExpenses",   "plExpensesDec",    expenses);

      // Profit trend (use margin as %)
      const profitTrendEl = el("plProfitTrend");
      const profitTrendPct = el("plProfitTrendPct");
      if (profitTrendEl) {
        profitTrendEl.className = `pl-trend ${margin >= 0 ? "pl-trend--up" : "pl-trend--down"}`;
        profitTrendEl.querySelector("svg polyline")?.setAttribute("points", margin >= 0 ? "18 15 12 9 6 15" : "6 9 12 15 18 9");
      }
      if (profitTrendPct) profitTrendPct.textContent = `${Math.abs(margin)}%`;
      const profNote = el("plProfitNote"); if (profNote) profNote.textContent = "profit margin";

      // Revenue trend chips
      const plSalesTxns = el("plSalesTxns"); if (plSalesTxns) plSalesTxns.textContent = `${sales.length} transactions`;
      const plCustCount = el("plCustomerCount"); if (plCustCount) plCustCount.textContent = `${customers.length} customers`;
      const plTotalTxns = el("plTotalTxns"); if (plTotalTxns) plTotalTxns.textContent = `${sales.length + (data.expenses||[]).length} transactions`;
      const plExpCats   = el("plExpCats");   if (plExpCats)   plExpCats.textContent   = `${expCats.length} categories`;
      const plExpTxns   = el("plExpTxns");   if (plExpTxns)   plExpTxns.textContent   = `${(data.expenses||[]).length} transactions`;
      const plExpCatsC  = el("plExpCatsCount"); if (plExpCatsC) plExpCatsC.textContent = `${expCats.length} categories`;

      // Expense trend (show as pct of revenue)
      const expRatio = revenue > 0 ? Math.round(expenses / revenue * 100) : 0;
      const plExpTrendPct = el("plExpTrendPct"); if (plExpTrendPct) plExpTrendPct.textContent = `${expRatio}%`;
      const plExpTrendEl  = el("plExpTrend");
      if (plExpTrendEl) {
        plExpTrendEl.className = `pl-trend ${expRatio > 80 ? "pl-trend--down" : "pl-trend--up"}`;
      }
      const plExpNote = el("plExpNote"); if (plExpNote) plExpNote.textContent = "of revenue";

      // Rev trend placeholder
      const plRevTrendPct = el("plRevTrendPct"); if (plRevTrendPct) plRevTrendPct.textContent = `${margin >= 0 ? "+" : ""}${margin}%`;

      // ── Trend line chart ──
      (function renderTrendChart() {
        const container = el("plTrendChart");
        if (!container) return;
        const rows = (data.charts || {}).revenue || [];
        if (!rows.length) {
          container.innerHTML = `<div style="padding:32px;text-align:center;color:var(--pl-muted);font-size:13px">No data yet.</div>`;
          return;
        }
        const W = 560, H = 180, pad = { t: 12, b: 32, l: 10, r: 10 };
        const vals = rows.map(r => Number(r.value || 0));
        const maxV = Math.max(1, ...vals);
        const n    = rows.length;
        const xStep = (W - pad.l - pad.r) / Math.max(1, n - 1);
        const yScale = v => pad.t + (1 - v / maxV) * (H - pad.t - pad.b);
        const pts = rows.map((r, i) => ({ x: pad.l + i * xStep, y: yScale(Number(r.value || 0)), label: r.day || "" }));
        const pathD = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        const areaD = pathD + ` L${pts[n-1].x.toFixed(1)},${(H-pad.b).toFixed(1)} L${pad.l},${(H-pad.b).toFixed(1)} Z`;
        // Y grid lines
        const ySteps = [0, 0.25, 0.5, 0.75, 1].map(f => ({ y: yScale(maxV * f), label: Math.round(maxV * f / 1000) + "k" }));
        const yLines = ySteps.map(s => `
          <line x1="${pad.l}" y1="${s.y.toFixed(1)}" x2="${W - pad.r}" y2="${s.y.toFixed(1)}" stroke="#ede9fe" stroke-width="1" stroke-dasharray="4 3"/>
          <text x="${pad.l}" y="${(s.y - 4).toFixed(1)}" font-size="9" fill="#b0a8d0" font-family="Inter,sans-serif">${s.label}</text>
        `).join("");
        // X labels — show ~6 evenly
        const labelIdxs = n <= 6 ? rows.map((_, i) => i) : [0, Math.floor(n*0.16), Math.floor(n*0.33), Math.floor(n*0.5), Math.floor(n*0.66), Math.floor(n*0.83), n-1];
        const xLabels = labelIdxs.map(i => `<text x="${pts[i].x.toFixed(1)}" y="${H - pad.b + 16}" text-anchor="middle" font-size="9" fill="#b0a8d0" font-family="Inter,sans-serif">${escapeHtml(String(pts[i].label).slice(5)||"")}</text>`).join("");
        container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
          <defs>
            <linearGradient id="plRevGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#7c5cd8" stop-opacity="0.18"/>
              <stop offset="100%" stop-color="#7c5cd8" stop-opacity="0.01"/>
            </linearGradient>
          </defs>
          ${yLines}
          <path d="${areaD}" fill="url(#plRevGrad)"/>
          <path d="${pathD}" fill="none" stroke="#7c5cd8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
          ${pts.filter((_,i) => i % Math.max(1, Math.floor(n/8)) === 0 || i === n-1).map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#fff" stroke="#7c5cd8" stroke-width="2"/>`).join("")}
          ${xLabels}
        </svg>`;
      })();

      // ── Donut chart ──
      (function renderDonut() {
        const svg  = el("plDonutSvg");
        const legEl = el("plDonutLegend");
        const totEl = el("plDonutTotal");
        const descEl = el("plDonutDesc");
        if (!svg) return;

        const metric = el("plDonutMetric")?.value || "expense";
        const items  = metric === "expense" ? expCats : [];
        const total  = items.reduce((s, i) => s + Number(i.total || i.value || 0), 0);

        if (totEl) totEl.textContent = money(total);
        if (descEl) descEl.textContent = metric === "expense"
          ? "Expense breakdown by category this period"
          : "Revenue breakdown this period";

        // Remove old arcs (keep background circle at index 0)
        const circles = svg.querySelectorAll("circle");
        circles.forEach((c, i) => { if (i > 0) c.remove(); });

        const circ = 2 * Math.PI * 64; // r=64
        if (!items.length || total === 0) {
          if (legEl) legEl.innerHTML = `<span style="color:var(--pl-muted);font-size:12px">No data yet.</span>`;
          return;
        }

        let offset = circ * 0.25; // start at top
        const rendered = items.slice(0, 6).map((item, idx) => {
          const val   = Number(item.total || item.value || 0);
          const frac  = val / total;
          const dash  = (frac * circ).toFixed(2);
          const gap   = (circ - frac * circ).toFixed(2);
          const color = DONUT_COLORS[idx % DONUT_COLORS.length];
          const arc   = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          arc.setAttribute("cx", "90"); arc.setAttribute("cy", "90"); arc.setAttribute("r", "64");
          arc.setAttribute("fill", "none"); arc.setAttribute("stroke", color); arc.setAttribute("stroke-width", "28");
          arc.setAttribute("stroke-dasharray", `${dash} ${gap}`);
          arc.setAttribute("stroke-dashoffset", offset.toFixed(2));
          arc.setAttribute("stroke-linecap", "round");
          arc.style.transition = "stroke-dasharray .6s ease";
          svg.appendChild(arc);
          offset -= frac * circ;
          return { label: item.category || item.label || `Item ${idx+1}`, pct: Math.round(frac * 100), color, val };
        });

        if (legEl) legEl.innerHTML = rendered.map(r => `
          <div class="pl-donut-leg-item">
            <span class="pl-donut-leg-dot" style="background:${r.color}"></span>
            ${escapeHtml(r.label)}
          </div>`).join("");
      })();

      // ── Bar chart (revenue vs expenses by month/week label) ──
      (function renderBarChart() {
        const container = el("plBarChart");
        if (!container) return;
        const revRows = (data.charts || {}).revenue || [];
        if (!revRows.length) {
          container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--pl-muted);font-size:13px">No data yet.</div>`;
          return;
        }
        // Group into up to 7 buckets
        const BUCKETS = Math.min(7, revRows.length);
        const step = Math.ceil(revRows.length / BUCKETS);
        const buckets = [];
        for (let i = 0; i < revRows.length; i += step) {
          const slice = revRows.slice(i, i + step);
          const revTotal = slice.reduce((s, r) => s + Number(r.value || 0), 0);
          const label = String(slice[0].day || "").slice(5, 10) || `W${buckets.length+1}`;
          buckets.push({ label, rev: revTotal, exp: 0 });
        }
        // Overlay expense estimate (distribute total evenly)
        const expTotal = expenses;
        buckets.forEach(b => { b.exp = Math.round(expTotal / buckets.length); });

        const W = 520, H = 160, pad = { t: 10, b: 32, l: 10, r: 10 };
        const maxV = Math.max(1, ...buckets.map(b => Math.max(b.rev, b.exp)));
        const slotW = (W - pad.l - pad.r) / buckets.length;
        const barW = Math.max(4, slotW * 0.3);
        const yScale = v => pad.t + (1 - v / maxV) * (H - pad.t - pad.b);

        const bars = buckets.map((b, i) => {
          const xCenter = pad.l + i * slotW + slotW / 2;
          const revH = Math.max(2, yScale(0) - yScale(b.rev));
          const expH = Math.max(2, yScale(0) - yScale(b.exp));
          const revY = yScale(b.rev);
          const expY = yScale(b.exp);
          const isExceeded = b.exp > b.rev;
          return `
            <rect x="${(xCenter - barW - 2).toFixed(1)}" y="${revY.toFixed(1)}" width="${barW.toFixed(1)}" height="${revH.toFixed(1)}" rx="4" fill="#7c5cd8" opacity="0.85"/>
            <rect x="${(xCenter + 2).toFixed(1)}" y="${expY.toFixed(1)}" width="${barW.toFixed(1)}" height="${expH.toFixed(1)}" rx="4" fill="#c4b5fd" opacity="0.85"/>
            ${isExceeded ? `<rect x="${(xCenter - barW - 2).toFixed(1)}" y="${revY.toFixed(1)}" width="${barW.toFixed(1)}" height="${revH.toFixed(1)}" rx="4" fill="url(#plHatch)" opacity="0.4"/>` : ""}
            <text x="${xCenter.toFixed(1)}" y="${H - pad.b + 16}" text-anchor="middle" font-size="9" fill="#b0a8d0" font-family="Inter,sans-serif">${escapeHtml(b.label)}</text>
          `;
        }).join("");

        container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
          <defs>
            <pattern id="plHatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="#7c5cd8" stroke-width="2"/>
            </pattern>
          </defs>
          <line x1="${pad.l}" y1="${(H-pad.b).toFixed(1)}" x2="${W-pad.r}" y2="${(H-pad.b).toFixed(1)}" stroke="#ede9fe" stroke-width="1"/>
          ${bars}
        </svg>`;
      })();

      // ── P&L Summary list ──
      const summaryList = el("plSummaryList");
      if (summaryList) {
        const items = [
          { label: "Revenue",            color: "#7c5cd8",  val: revenue,  cls: "" },
          { label: "Cost of Purchases",  color: "#60a5fa",  val: Number(pd.purchaseCosts || 0), cls: "" },
          { label: "Operating Expenses", color: "#fb923c",  val: expenses, cls: "" },
          { label: "Net Profit",         color: profit >= 0 ? "#22c55e" : "#ef4444", val: profit, cls: profit >= 0 ? "good" : "bad" },
          { label: "Receivables",        color: "#4ade80",  val: Number(fin.customerReceivables || 0), cls: "" },
          { label: "Payables",           color: "#f472b6",  val: Number(fin.supplierPayables    || 0), cls: "" },
          { label: "Working Capital",    color: "#34d399",  val: Number((fin.customerReceivables||0) - (fin.supplierPayables||0)), cls: "" },
        ];
        summaryList.innerHTML = items.map(item => `
          <div class="pl-summary-item">
            <span class="pl-summary-item-label">
              <span class="pl-summary-dot" style="background:${item.color}"></span>
              ${escapeHtml(item.label)}
            </span>
            <span class="pl-summary-item-value ${item.cls}">${money(item.val)}</span>
          </div>`).join("");
      }
    }

    // Period toggle wiring
    ["plPeriodMonth", "plPeriodWeek"].forEach(id => {
      el(id)?.addEventListener("click", () => {
        document.querySelectorAll(".pl-period-btn").forEach(b => b.classList.remove("active"));
        el(id).classList.add("active");
        window._plState.period = el(id).dataset.period;
        renderAll();
      });
    });

    // Metric selects
    el("plDonutMetric")?.addEventListener("change", renderAll);
    el("plChartMetric")?.addEventListener("change", renderAll);

    renderAll();
  })();

  // ===== ORDERS (Order History module) =====
  (function renderOrderHistory() {
    const orders = data.orders || [];

    // Status helper
    function ohStatusClass(s) {
      const v = String(s || "").toUpperCase();
      if (v === "DELIVERED" || v === "COMPLETED") return "oh-status--delivered";
      if (v === "CANCELLED") return "oh-status--cancelled";
      if (v === "PROCESSING") return "oh-status--processing";
      return "oh-status--pending";
    }
    function ohStatusLabel(s) {
      const v = String(s || "PENDING");
      return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
    }

    // Pagination state
    const PAGE_SIZE = 7;
    if (!window._ohState) window._ohState = { filter: "all", page: 1 };

    function getFiltered() {
      const { filter } = window._ohState;
      const from = el("ohDateFrom")?.value;
      const to   = el("ohDateTo")?.value;
      return orders.filter(o => {
        if (filter !== "all" && filter !== "summary") {
          if (String(o.status || "").toUpperCase() !== filter) return false;
        }
        if (from) { const d = new Date(o.created_at || o.date); if (d < new Date(from)) return false; }
        if (to)   { const d = new Date(o.created_at || o.date); if (d > new Date(to + "T23:59:59")) return false; }
        return true;
      });
    }

    function renderTable() {
      const { page, filter } = window._ohState;

      // Summary cards
      const summaryRow = el("ohSummaryRow");
      if (summaryRow) summaryRow.hidden = (filter !== "summary");

      if (filter === "summary") {
        const total     = orders.length;
        const delivered = orders.filter(o => ["DELIVERED","COMPLETED"].includes(String(o.status||"").toUpperCase())).length;
        const cancelled = orders.filter(o => String(o.status||"").toUpperCase() === "CANCELLED").length;
        const pending   = orders.filter(o => !["DELIVERED","COMPLETED","CANCELLED"].includes(String(o.status||"").toUpperCase())).length;
        const totalVal  = orders.reduce((s, o) => s + Number(o.amount || 0), 0);
        const sTotal     = el("ohSumTotal");     if (sTotal)     sTotal.textContent     = total;
        const sDelivered = el("ohSumDelivered"); if (sDelivered) sDelivered.textContent = delivered;
        const sCancelled = el("ohSumCancelled"); if (sCancelled) sCancelled.textContent = cancelled;
        const sPending   = el("ohSumPending");   if (sPending)   sPending.textContent   = pending;
        const sValue     = el("ohSumValue");     if (sValue)     sValue.textContent     = money(totalVal);
      }

      const filtered = getFiltered();
      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      const safePage   = Math.min(page, totalPages);
      window._ohState.page = safePage;
      const slice = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

      const tbody = el("ohTableBody");
      if (!tbody) return;

      if (slice.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="oh-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          No orders found.
        </div></td></tr>`;
      } else {
        const globalOffset = (safePage - 1) * PAGE_SIZE;
        tbody.innerHTML = slice.map((o, i) => {
          const sno = globalOffset + i + 1;
          const statusCls = ohStatusClass(o.status);
          const date = o.created_at ? new Date(o.created_at).toLocaleDateString("en-KE", { day:"2-digit", month:"short", year:"numeric" }) : "—";
          return `<tr>
            <td><span class="oh-sno">${sno}</span></td>
            <td><span class="oh-order-id">${escapeHtml(o.order_no || "—")}</span></td>
            <td>
              <div style="font-weight:600;color:#1a2235">${escapeHtml(o.product || o.customer || "—")}</div>
              <div style="font-size:11px;color:#6b7a99;margin-top:2px">${escapeHtml(o.customer || "")} · ${date}</div>
            </td>
            <td style="font-weight:700">${money(o.amount || 0)}</td>
            <td>${o.quantity != null ? Number(o.quantity).toLocaleString() : "—"}</td>
            <td><span class="oh-status ${statusCls}">${escapeHtml(ohStatusLabel(o.status))}</span></td>
          </tr>`;
        }).join("");
      }

      // Pagination
      renderPagination(totalPages, safePage);
    }

    function renderPagination(total, current) {
      const pg = el("ohPagination");
      if (!pg) return;
      if (total <= 1) { pg.innerHTML = ""; return; }

      // Build page number list: always show first, last, current ±1, with ellipsis
      const pages = new Set([1, total, current, current - 1, current + 1].filter(p => p >= 1 && p <= total));
      const sorted = [...pages].sort((a, b) => a - b);

      let html = `<button class="oh-page-btn" id="ohPrevBtn" ${current === 1 ? "disabled" : ""} aria-label="Previous">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>`;
      let prev = 0;
      for (const p of sorted) {
        if (prev && p - prev > 1) html += `<span class="oh-page-ellipsis">…</span>`;
        html += `<button class="oh-page-btn${p === current ? " active" : ""}" data-page="${p}">${p}</button>`;
        prev = p;
      }
      html += `<button class="oh-page-btn" id="ohNextBtn" ${current === total ? "disabled" : ""} aria-label="Next">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
      pg.innerHTML = html;

      pg.querySelectorAll("[data-page]").forEach(btn => {
        btn.addEventListener("click", () => { window._ohState.page = Number(btn.dataset.page); renderTable(); });
      });
      const prevBtn = el("ohPrevBtn");
      const nextBtn = el("ohNextBtn");
      if (prevBtn) prevBtn.addEventListener("click", () => { window._ohState.page--; renderTable(); });
      if (nextBtn) nextBtn.addEventListener("click", () => { window._ohState.page++; renderTable(); });
    }

    // Wire up tab buttons (only on first render to avoid duplicate listeners)
    const tabList = el("ohTabList");
    if (tabList && !tabList.dataset.wired) {
      tabList.dataset.wired = "1";
      tabList.querySelectorAll(".oh-tab").forEach(btn => {
        btn.addEventListener("click", () => {
          tabList.querySelectorAll(".oh-tab").forEach(t => t.classList.remove("active"));
          btn.classList.add("active");
          window._ohState.filter = btn.dataset.filter;
          window._ohState.page = 1;
          renderTable();
        });
      });
      el("ohDateFrom")?.addEventListener("change", () => { window._ohState.page = 1; renderTable(); });
      el("ohDateTo")?.addEventListener("change",   () => { window._ohState.page = 1; renderTable(); });
    }

    // Set default date range inputs to current month if not set
    const fromEl = el("ohDateFrom");
    const toEl   = el("ohDateTo");
    if (fromEl && !fromEl.value) {
      const now = new Date();
      fromEl.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
    }
    if (toEl && !toEl.value) {
      const now = new Date();
      toEl.value = now.toISOString().slice(0, 10);
    }

    renderTable();
  })();

  // ===== AI =====
  const aiActions = el("aiActions");
  if (aiActions) aiActions.innerHTML = (data.aiLogs || []).map((a) => `
    <div class="event">
      <strong>${escapeHtml(a.intent || "message")} via ${escapeHtml(a.channel)}</strong>
      <span>${escapeHtml(a.message ? a.message.slice(0, 80) : "")}</span>
      <small>${new Date(a.created_at).toLocaleString()}</small>
    </div>
  `).join("") || `<div class="event">No AI actions yet</div>`;

  const chatEl = el("chatLog");
  if (chatEl && !chatEl.dataset.hasMessages) {
    chatEl.innerHTML = (data.aiLogs || []).slice(0, 5).reverse().map((a) => {
      const receipt = actionReceipt(a);
      return `<div class="bubble user">${escapeHtml(a.message || "")}</div>
      ${receipt
        ? `<div class="bubble action-complete"><strong>Action completed</strong><span>${escapeHtml(receipt)}</span><small>Validated and saved to the database</small></div>`
        : `<div class="bubble">${escapeHtml(a.response || "")}</div>`}`;
    }).join("") || `<div class="bubble">Welcome to Biashara OS. Try: "Nimenunua chuma kilo 100 kwa 30,000" or "How much profit did I make this week?"</div>`;
  }


  const integrationsList = el("integrationsList");
  if (integrationsList) integrationsList.innerHTML = (data.integrations || []).map((i) => `
    <article class="integration">
      <strong>${escapeHtml(i.name)}</strong>
      ${pill(i.status)}
      <span class="endpoint">${escapeHtml(i.endpoint)}</span>
      ${i.outbound ? `<span class="endpoint">${escapeHtml(i.outbound)}</span>` : ""}
      <small>Mode: ${escapeHtml(i.mode || "local")}</small>
    </article>
  `).join("");

}

async function refresh() {
  state.data = await api("/api/dashboard");
  render();
}

// ===== FORM HANDLERS =====

// Toggle the "New Sale" collapsible form
el("slToggleForm")?.addEventListener("click", () => {
  const wrap = el("slFormWrap");
  if (!wrap) return;
  const hidden = wrap.hidden;
  wrap.hidden = !hidden;
  el("slToggleForm").textContent = hidden ? "✕ Close" : "+ New Sale";
});

// Toggle Production form
el("prodToggleForm")?.addEventListener("click", () => {
  const wrap = el("prodFormWrap");
  if (!wrap) return;
  wrap.hidden = !wrap.hidden;
  const btn = el("prodToggleForm");
  if (btn) btn.innerHTML = wrap.hidden
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Record Production`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close`;
});

// Toggle Inventory form
el("invToggleForm")?.addEventListener("click", () => {
  const wrap = el("invFormWrap");
  if (!wrap) return;
  wrap.hidden = !wrap.hidden;
  const btn = el("invToggleForm");
  if (btn) btn.innerHTML = wrap.hidden
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Stock Item`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close`;
});

el("saleForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    await api("/api/sales", { method: "POST", body: { ...formData, quantity: Number(formData.quantity), amount: Number(formData.amount) } });
    event.target.reset();
    // Collapse form after successful submission
    const wrap = el("slFormWrap");
    if (wrap) wrap.hidden = true;
    const btn = el("slToggleForm");
    if (btn) btn.textContent = "+ New Sale";
    await refresh();
  } catch (err) { alert(`Sale error: ${err.message}`); }
});

el("purchaseForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    await api("/api/purchases", { method: "POST", body: { ...formData, quantity: Number(formData.quantity), totalCost: Number(formData.totalCost) } });
    event.target.reset();
    await refresh();
  } catch (err) { alert(`Purchase error: ${err.message}`); }
});

el("expenseForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    await api("/api/expenses", { method: "POST", body: { ...formData, amount: Number(formData.amount) } });
    event.target.reset();
    await refresh();
  } catch (err) { alert(`Expense error: ${err.message}`); }
});

el("productionForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    await api("/api/production", { method: "POST", body: {
      product: formData.product,
      quantity: Number(formData.quantity),
      material: formData.material || "",
      materialQuantity: Number(formData.materialQuantity || 0),
      unit: formData.unit || "kg"
    }});
    event.target.reset();
    const wrap = el("prodFormWrap"); if (wrap) wrap.hidden = true;
    const btn  = el("prodToggleForm");
    if (btn) btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Record Production`;
    await refresh();
  } catch (err) { alert(`Production error: ${err.message}`); }
});

el("customerPaymentForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    await api("/api/debts/customer/payment", { method: "POST", body: { customer: formData.customer, amount: Number(formData.amount), method: formData.method } });
    event.target.reset();
    await refresh();
  } catch (err) { alert(`Payment error: ${err.message}`); }
});

el("supplierPaymentForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    await api("/api/debts/supplier/payment", { method: "POST", body: { supplier: formData.supplier, amount: Number(formData.amount), method: formData.method } });
    event.target.reset();
    await refresh();
  } catch (err) { alert(`Payment error: ${err.message}`); }
});

// ===== AI CHAT =====
el("aiForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = el("aiInput").value.trim();
  const language = el("aiLanguage").value;
  if (!message) return;
  const log = el("chatLog");
  log.dataset.hasMessages = "true";
  el("aiInput").value = "";
  try {
    log.insertAdjacentHTML("beforeend", `<div class="bubble user">${escapeHtml(message)}</div>`);
    log.insertAdjacentHTML("beforeend", `<div class="bubble pending">Thinking…</div>`);
    log.scrollTop = log.scrollHeight;
    const result = await api("/api/ai/message", { method: "POST", body: { message, language, channel: "WEB", phone: "+254700000001" } });
    // Remove the pending bubble
    const pending = log.querySelector(".pending");
    if (pending) pending.remove();
    await refresh();
    log.insertAdjacentHTML("beforeend", `<div class="bubble">${escapeHtml(result.response)}${result.model ? `<small class="model-used">Model: ${escapeHtml(result.model)}</small>` : ""}</div>`);
    log.scrollTop = log.scrollHeight;
  } catch (err) {
    const pending = log.querySelector(".pending");
    if (pending) pending.remove();
    await refresh().catch(() => {});
    log.insertAdjacentHTML("beforeend", `<div class="bubble">${escapeHtml(err.message)}</div>`);
    log.scrollTop = log.scrollHeight;
  }
});

el("refreshBtn")?.addEventListener("click", refresh);

el("testDaraja")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/mpesa/test-credentials", { method: "POST", body: {} });
    alert(result.message);
  } catch (err) { alert(`Daraja test failed: ${err.message}`); }
});

el("testOpenRouter")?.addEventListener("click", async () => {
  try {
    const result = await api("/api/ai/test", { method: "POST", body: {} });
    alert(result.ok ? `AI works. Provider: ${result.provider}. Model: ${result.model}` : `AI failed: ${result.error || result.status}`);
    await refresh();
  } catch (err) { alert(`AI test failed: ${err.message}`); }
});

// ===== CUSTOMER FORM toggle =====
el("custToggleForm")?.addEventListener("click", () => {
  const wrap = el("custFormWrap");
  if (!wrap) return;
  wrap.hidden = !wrap.hidden;
  const btn = el("custToggleForm");
  if (btn) btn.innerHTML = wrap.hidden
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New Customer`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close`;
});

// ===== CUSTOMER FORM submit =====
el("customerForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = el("customerFormStatus");
  status.textContent = "Saving…";
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    const result = await api("/api/customers", { method: "POST", body: formData });
    status.textContent = `✓ Customer "${result.name}" added.`;
    event.target.reset();
    const wrap = el("custFormWrap"); if (wrap) wrap.hidden = true;
    const btn  = el("custToggleForm");
    if (btn) btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New Customer`;
    await refresh();
  } catch (err) { status.textContent = `Error: ${err.message}`; }
});

// ===== SUPPLIER FORM toggle =====
el("supToggleForm")?.addEventListener("click", () => {
  const wrap = el("supFormWrap");
  if (!wrap) return;
  wrap.hidden = !wrap.hidden;
  const btn = el("supToggleForm");
  if (btn) btn.innerHTML = wrap.hidden
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New Supplier`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close`;
});

// ===== SUPPLIER FORM submit =====
el("supplierForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = el("supplierFormStatus");
  status.textContent = "Saving…";
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    const result = await api("/api/suppliers", { method: "POST", body: formData });
    status.textContent = `✓ Supplier "${result.name}" added.`;
    event.target.reset();
    const wrap = el("supFormWrap"); if (wrap) wrap.hidden = true;
    const btn  = el("supToggleForm");
    if (btn) btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New Supplier`;
    await refresh();
  } catch (err) { status.textContent = `Error: ${err.message}`; }
});

// ===== INVENTORY FORM =====
el("inventoryForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = el("inventoryFormStatus");
  status.textContent = "Saving…";
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    const result = await api("/api/inventory", { method: "POST", body: formData });
    status.textContent = `✓ ${result.target === "product" ? "Product" : "Material"} "${result.name}" added (${result.quantity} ${formData.unit}).`;
    event.target.reset();
    const wrap = el("invFormWrap"); if (wrap) wrap.hidden = true;
    const btn  = el("invToggleForm");
    if (btn) btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Stock Item`;
    await refresh();
  } catch (err) { status.textContent = `Error: ${err.message}`; }
});

// ===== DEBTS PAYMENT FORM toggle =====
el("dcTogglePayment")?.addEventListener("click", () => {
  const wrap = el("dcPaymentWrap");
  if (!wrap) return;
  const hidden = wrap.hidden;
  wrap.hidden = !hidden;
  const btn = el("dcTogglePayment");
  if (btn) {
    btn.innerHTML = hidden
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Record Payment`;
  }
});

// ===== ORDER FORM toggle =====
el("ohToggleForm")?.addEventListener("click", () => {
  const wrap = el("ohFormWrap");
  if (!wrap) return;
  const hidden = wrap.hidden;
  wrap.hidden = !hidden;
  const btn = el("ohToggleForm");
  if (btn) {
    btn.innerHTML = hidden
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New Order`;
  }
});

// ===== ORDER FORM submit =====
el("orderForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = el("orderFormStatus");
  status.textContent = "Creating order…";
  try {
    const formData = Object.fromEntries(new FormData(event.target));
    const result = await api("/api/orders", { method: "POST", body: { ...formData, quantity: Number(formData.quantity) } });
    status.textContent = `✓ Order created. Invoice KSh ${Number(result.amount).toLocaleString()}.`;
    event.target.reset();
    // Collapse form after success
    const wrap = el("ohFormWrap");
    if (wrap) wrap.hidden = true;
    const btn = el("ohToggleForm");
    if (btn) btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New Order`;
    await refresh();
  } catch (err) { status.textContent = `Error: ${err.message}`; }
});

refresh();
