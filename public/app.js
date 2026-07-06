/* LabPulse dashboard — vanilla JS, no dependencies.
   Reads data/activity.json (produced by scripts/fetch_activity.py) and renders
   commits / lines-changed per contributor across all Huang Lab repos, bucketed
   by day / week / month. */
(function () {
  "use strict";

  // --- validated categorical palette (light / dark), + neutral "Other" ------
  const SERIES = {
    light: ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"],
    dark:  ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"],
  };
  const OTHER = { light: "#9a9992", dark: "#78776f" };

  function theme() {
    const attr = document.documentElement.getAttribute("data-theme");
    const dark = attr === "dark" || (!attr && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      dark,
      surface: v("--surface-1"), grid: v("--grid"), axis: v("--axis"),
      textPrimary: v("--text-primary"), textSecondary: v("--text-secondary"), muted: v("--muted"),
      series: dark ? SERIES.dark : SERIES.light,
      other: dark ? OTHER.dark : OTHER.light,
    };
  }

  // --- number / date formatting --------------------------------------------
  const fmtFull = (n) => Math.round(n).toLocaleString("en-US");
  function fmtCompact(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
    return String(Math.round(n));
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parseDay = (s) => new Date(s + "T00:00:00Z");
  const isoDay = (d) => d.toISOString().slice(0, 10);
  function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
  function mondayOf(d) { const day = d.getUTCDay(); const diff = day === 0 ? 6 : day - 1; return addDays(d, -diff); }
  function firstOfMonth(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
  const fmtDayLabel = (d) => MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  const fmtMonthLabel = (d) => MONTHS[d.getUTCMonth()] + " '" + String(d.getUTCFullYear()).slice(2);

  // --- state ----------------------------------------------------------------
  const state = {
    data: null,
    range: "90", from: null, to: null,
    granularity: "week", metric: "lines", stackBy: "author",
    repos: null, authors: null,      // Set of allowed indices, null = all
    sort: { key: "lines", dir: -1 },
  };

  let colorSlot = { author: [], repo: [] };   // index -> slot (0..7) or -1
  const $ = (id) => document.getElementById(id);

  // --- data prep ------------------------------------------------------------
  function metricOfRow(r) {
    switch (state.metric) {
      case "commits": return r[3];
      case "additions": return r[4];
      case "deletions": return r[5];
      default: return r[4] + r[5]; // lines changed
    }
  }
  const metricLabel = () => ({ lines: "Lines changed", commits: "Commits", additions: "Additions", deletions: "Deletions" }[state.metric]);

  function computeStableColors(data) {
    const rank = (n, get) => {
      const tot = new Array(n).fill(0);
      for (const r of data.rows) tot[get(r)] += r[4] + r[5];
      const order = tot.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]);
      const slot = new Array(n).fill(-1);
      order.forEach(([i], k) => { if (k < 8) slot[i] = k; });
      return slot;
    };
    colorSlot.author = rank(data.authors.length, (r) => r[1]);
    colorSlot.repo = rank(data.repos.length, (r) => r[0]);
  }
  const colorFor = (dim, idx, th) => { const s = colorSlot[dim][idx]; return s >= 0 ? th.series[s] : th.other; };

  // --- range / filtering ----------------------------------------------------
  function activeRange() {
    const d = state.data;
    const dataStart = parseDay(d.date_range.start), dataEnd = parseDay(d.date_range.end);
    if (state.range === "all") return [dataStart, dataEnd];
    if (state.range === "custom") {
      const from = state.from ? parseDay(state.from) : dataStart;
      const to = state.to ? parseDay(state.to) : dataEnd;
      return [from, to];
    }
    const n = parseInt(state.range, 10);
    return [addDays(dataEnd, -(n - 1)), dataEnd];
  }

  function rowsIn(start, end) {
    const s = isoDay(start), e = isoDay(end);
    const out = [];
    for (const r of state.data.rows) {
      if (r[2] < s || r[2] > e) continue;
      if (state.repos && !state.repos.has(r[0])) continue;
      if (state.authors && !state.authors.has(r[1])) continue;
      out.push(r);
    }
    return out;
  }

  // --- bucketing ------------------------------------------------------------
  function bucketKey(dateStr) {
    if (state.granularity === "day") return dateStr;
    if (state.granularity === "month") return dateStr.slice(0, 7);
    return isoDay(mondayOf(parseDay(dateStr)));
  }
  function bucketList(start, end) {
    const out = [];
    if (state.granularity === "day") {
      for (let d = start; d <= end; d = addDays(d, 1)) out.push({ key: isoDay(d), date: new Date(d) });
    } else if (state.granularity === "month") {
      for (let d = firstOfMonth(start); d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
        out.push({ key: isoDay(d).slice(0, 7), date: new Date(d) });
    } else {
      for (let d = mondayOf(start); d <= end; d = addDays(d, 7)) out.push({ key: isoDay(d), date: new Date(d) });
    }
    return out;
  }
  function bucketLabel(b) {
    if (state.granularity === "month") return fmtMonthLabel(b.date);
    return fmtDayLabel(b.date);
  }

  // --- SVG helpers ----------------------------------------------------------
  const NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
    return 10 * pow;
  }
  function roundedTopRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
  }

  // --- tooltip --------------------------------------------------------------
  const tip = $("tooltip");
  function showTip(html, x, y) {
    tip.innerHTML = "";
    tip.appendChild(html);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  function tipRow(color, name, value) {
    const row = document.createElement("div"); row.className = "tt-row";
    const key = document.createElement("span"); key.className = "tt-key";
    if (color) { const ln = document.createElement("span"); ln.className = "tt-line"; ln.style.background = color; key.appendChild(ln); }
    const nm = document.createElement("span"); nm.textContent = name; key.appendChild(nm);
    const val = document.createElement("span"); val.className = "tt-val"; val.textContent = value;
    row.appendChild(key); row.appendChild(val); return row;
  }

  // --- KPI tiles ------------------------------------------------------------
  function renderKPIs(cur, start, end) {
    const box = $("kpis"); box.innerHTML = "";
    const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
    const commits = sum(cur, (r) => r[3]);
    const lines = sum(cur, (r) => r[4] + r[5]);
    const contributors = new Set(cur.map((r) => r[1])).size;
    const repos = new Set(cur.map((r) => r[0])).size;

    // previous equal-length window for deltas
    let prev = null;
    if (state.range !== "all") {
      const len = Math.round((end - start) / 86400000) + 1;
      const pEnd = addDays(start, -1), pStart = addDays(pEnd, -(len - 1));
      prev = rowsIn(pStart, pEnd);
    }
    const pv = prev && { commits: sum(prev, (r) => r[3]), lines: sum(prev, (r) => r[4] + r[5]),
      contributors: new Set(prev.map((r) => r[1])).size, repos: new Set(prev.map((r) => r[0])).size };

    const tiles = [
      { label: "Commits", value: commits, prev: pv && pv.commits, kind: "num" },
      { label: "Lines changed", value: lines, prev: pv && pv.lines, kind: "num" },
      { label: "Active contributors", value: contributors, prev: pv && pv.contributors, kind: "count" },
      { label: "Active repositories", value: repos, prev: pv && pv.repos, kind: "count" },
    ];
    for (const t of tiles) {
      const card = document.createElement("div"); card.className = "kpi";
      const l = document.createElement("div"); l.className = "k-label"; l.textContent = t.label;
      const v = document.createElement("div"); v.className = "k-value"; v.textContent = fmtCompact(t.value);
      card.appendChild(l); card.appendChild(v);
      if (t.prev != null) {
        const d = document.createElement("div"); d.className = "k-delta";
        if (t.kind === "count") {
          const diff = t.value - t.prev; const cls = diff > 0 ? "up" : diff < 0 ? "down" : "";
          d.innerHTML = ""; const span = document.createElement("span");
          span.className = cls; span.textContent = (diff > 0 ? "+" : "") + diff;
          d.appendChild(span); d.appendChild(document.createTextNode(" vs previous period"));
        } else {
          const pct = t.prev === 0 ? (t.value > 0 ? 100 : 0) : Math.round(((t.value - t.prev) / t.prev) * 100);
          const cls = pct > 0 ? "up" : pct < 0 ? "down" : ""; const span = document.createElement("span");
          span.className = cls; span.textContent = (pct > 0 ? "▲ " : pct < 0 ? "▼ " : "") + Math.abs(pct) + "%";
          d.appendChild(span); d.appendChild(document.createTextNode(" vs previous period"));
        }
        card.appendChild(d);
      }
      box.appendChild(card);
    }
  }

  // --- time series (stacked columns) ---------------------------------------
  function renderTimeSeries(cur, start, end) {
    const th = theme();
    const dim = state.stackBy;
    const meta = dim === "author" ? state.data.authors : state.data.repos;
    const idxOf = dim === "author" ? (r) => r[1] : (r) => r[0];

    const buckets = bucketList(start, end);
    const bIndex = new Map(buckets.map((b, i) => [b.key, i]));

    // series: colored (slot>=0) entities present, + one "Other"
    const present = new Set(cur.map(idxOf));
    const colored = [...present].filter((i) => colorSlot[dim][i] >= 0).sort((a, b) => colorSlot[dim][a] - colorSlot[dim][b]);
    const others = [...present].filter((i) => colorSlot[dim][i] < 0);
    const series = [];
    if (others.length) series.push({ idx: -1, label: `Other (${others.length})`, color: th.other, data: new Array(buckets.length).fill(0) });
    for (const i of colored) {
      const name = (meta[i].display || meta[i].name || meta[i].login || "unknown");
      series.push({ idx: i, label: name, color: colorFor(dim, i, th), data: new Array(buckets.length).fill(0) });
    }
    const otherSeries = others.length ? series[0] : null;
    const bySeriesIdx = new Map(series.map((s, k) => [s.idx, k]));

    for (const r of cur) {
      const bi = bIndex.get(bucketKey(r[2])); if (bi == null) continue;
      const i = idxOf(r);
      const s = colorSlot[dim][i] >= 0 ? series[bySeriesIdx.get(i)] : otherSeries;
      if (s) s.data[bi] += metricOfRow(r);
    }

    const totals = buckets.map((_, bi) => series.reduce((a, s) => a + s.data[bi], 0));
    const maxTotal = Math.max(1, ...totals);

    // legend (colored first for scanning, Other last)
    const legendEl = $("ts-legend"); legendEl.innerHTML = "";
    const legendOrder = series.slice().sort((a, b) => (a.idx < 0) - (b.idx < 0));
    for (const s of legendOrder) {
      const it = document.createElement("span"); it.className = "item";
      const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = s.color;
      const nm = document.createElement("span"); nm.textContent = s.label;
      it.appendChild(sw); it.appendChild(nm); legendEl.appendChild(it);
    }

    // geometry
    const host = $("timeseries");
    const scrollW = host.parentElement.clientWidth || 800;
    const m = { top: 12, right: 14, bottom: 30, left: 52 };
    const minStep = 10;
    let step = (scrollW - m.left - m.right) / Math.max(1, buckets.length);
    let width = scrollW;
    if (step < minStep) { step = state.granularity === "day" ? 12 : 26; width = m.left + m.right + step * buckets.length; }
    const height = 320;
    const plotH = height - m.top - m.bottom;
    const yMax = niceMax(maxTotal);
    const y = (v) => m.top + plotH - (v / yMax) * plotH;
    const barW = Math.min(24, step * 0.72);

    host.innerHTML = "";
    if (!cur.length) { host.innerHTML = '<div class="empty">No activity in this selection.</div>'; return; }
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: width, height: height, role: "img" });

    // gridlines + y labels
    for (let t = 0; t <= 4; t++) {
      const val = (yMax / 4) * t; const yy = y(val);
      svg.appendChild(el("line", { class: "grid-line", x1: m.left, y1: yy, x2: width - m.right, y2: yy }));
      svg.appendChild(el("text", { class: "axis-text", x: m.left - 8, y: yy + 3.5, "text-anchor": "end" }, fmtCompact(val)));
    }
    // x labels (thinned)
    const maxLabels = Math.max(2, Math.floor((width - m.left - m.right) / 62));
    const labelStep = Math.ceil(buckets.length / maxLabels);
    const GAP = 2;

    buckets.forEach((b, bi) => {
      const cx = m.left + step * bi + step / 2;
      const g = el("g", {});
      // stacked segments bottom-up
      let cum = 0;
      const stackHere = series.filter((s) => s.data[bi] > 0);
      stackHere.forEach((s, k) => {
        const v = s.data[bi];
        const segTop = y(cum + v), segBottom = y(cum);
        const h = segBottom - segTop;
        const isTop = k === stackHere.length - 1;
        const drawH = Math.max(0.5, h - GAP);
        const yTop = segBottom - drawH;
        if (isTop && drawH > 3) {
          g.appendChild(el("path", { d: roundedTopRect(cx - barW / 2, yTop, barW, drawH, 3), fill: s.color }));
        } else {
          g.appendChild(el("rect", { x: cx - barW / 2, y: yTop, width: barW, height: drawH, fill: s.color }));
        }
        cum += v;
      });
      svg.appendChild(g);

      // hit target for tooltip / focus
      const hit = el("rect", { class: "col-hit", x: m.left + step * bi, y: m.top, width: step, height: plotH, tabindex: "0" });
      const tipFor = (evt) => {
        const box = document.createElement("div");
        const title = document.createElement("div"); title.className = "tt-title";
        title.textContent = tipTitle(b); box.appendChild(title);
        let any = false;
        [...stackHere].reverse().forEach((s) => { box.appendChild(tipRow(s.color, s.label, fmtFull(s.data[bi]))); any = true; });
        if (!any) box.appendChild(tipRow(null, "No activity", "0"));
        const tot = document.createElement("div"); tot.className = "tt-row";
        const tk = document.createElement("span"); tk.className = "tt-key"; tk.textContent = "Total";
        const tvv = document.createElement("span"); tvv.className = "tt-val"; tvv.textContent = fmtFull(totals[bi]);
        tot.appendChild(tk); tot.appendChild(tvv);
        tot.style.borderTop = "1px solid var(--border)"; tot.style.marginTop = "4px"; tot.style.paddingTop = "4px";
        box.appendChild(tot);
        const px = evt.clientX != null ? evt.clientX : (hit.getBoundingClientRect().left + step / 2);
        const py = evt.clientY != null ? evt.clientY : hit.getBoundingClientRect().top;
        showTip(box, px, py);
        g.style.opacity = ".82";
      };
      hit.addEventListener("mousemove", tipFor);
      hit.addEventListener("mouseenter", tipFor);
      hit.addEventListener("focus", tipFor);
      hit.addEventListener("mouseleave", () => { hideTip(); g.style.opacity = "1"; });
      hit.addEventListener("blur", () => { hideTip(); g.style.opacity = "1"; });
      svg.appendChild(hit);

      if (bi % labelStep === 0) {
        svg.appendChild(el("text", { class: "axis-text", x: cx, y: height - 10, "text-anchor": "middle" }, bucketLabel(b)));
      }
    });
    // baseline
    svg.appendChild(el("line", { class: "axis-line", x1: m.left, y1: y(0), x2: width - m.right, y2: y(0) }));
    host.appendChild(svg);
  }
  function tipTitle(b) {
    if (state.granularity === "day") return b.date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
    if (state.granularity === "month") return b.date.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
    const wkEnd = addDays(b.date, 6);
    return "Week of " + fmtDayLabel(b.date) + " – " + fmtDayLabel(wkEnd);
  }

  // --- horizontal bar chart -------------------------------------------------
  function renderBars(hostId, entries, dim) {
    const th = theme();
    const host = $(hostId); host.innerHTML = "";
    if (!entries.length) { host.innerHTML = '<div class="empty">No activity.</div>'; return; }
    const top = entries.slice(0, 12);
    const width = host.clientWidth || 520;
    const rowH = 30, gutter = 132, valPad = 46;
    const m = { top: 6, right: valPad, bottom: 6, left: gutter };
    const plotW = Math.max(40, width - m.left - m.right);
    const height = m.top + m.bottom + top.length * rowH;
    const max = Math.max(1, ...top.map((e) => e.value));
    const barH = Math.min(20, rowH - 12);

    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: width, height: height, role: "img" });
    top.forEach((e, i) => {
      const cy = m.top + i * rowH + rowH / 2;
      const w = (e.value / max) * plotW;
      const color = colorFor(dim, e.idx, th);
      // name (left gutter, truncated)
      const name = truncate(e.label, gutter - 12);
      const t = el("text", { class: "bar-label", x: m.left - 10, y: cy + 4, "text-anchor": "end" }, name);
      svg.appendChild(t);
      // bar
      const by = cy - barH / 2;
      svg.appendChild(el("path", { d: barPathRoundedRight(m.left, by, Math.max(2, w), barH, 3), fill: color }));
      // value at tip
      svg.appendChild(el("text", { class: "bar-value", x: m.left + Math.max(2, w) + 8, y: cy + 4 }, fmtCompact(e.value)));
      // hit target
      const hit = el("rect", { x: m.left, y: cy - rowH / 2, width: plotW + valPad, height: rowH, fill: "transparent", tabindex: "0" });
      const show = (evt) => {
        const box = document.createElement("div");
        const title = document.createElement("div"); title.className = "tt-title"; title.textContent = e.label; box.appendChild(title);
        box.appendChild(tipRow(color, metricLabel(), fmtFull(e.value)));
        box.appendChild(tipRow(null, "Commits", fmtFull(e.commits)));
        box.appendChild(tipRow(null, "Lines changed", fmtFull(e.lines)));
        showTip(box, evt.clientX != null ? evt.clientX : m.left + w, evt.clientY != null ? evt.clientY : cy);
      };
      hit.addEventListener("mousemove", show); hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", hideTip); hit.addEventListener("blur", hideTip);
      svg.appendChild(hit);
    });
    host.appendChild(svg);
  }
  function barPathRoundedRight(x, y, w, h, r) {
    r = Math.min(r, w, h / 2);
    return `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
  }
  function truncate(s, px) {
    const max = Math.floor(px / 6.6);
    return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s;
  }

  // --- aggregation for bars + table ----------------------------------------
  function aggregateBy(cur, dim) {
    const idxOf = dim === "author" ? (r) => r[1] : (r) => r[0];
    const meta = dim === "author" ? state.data.authors : state.data.repos;
    const map = new Map();
    for (const r of cur) {
      const i = idxOf(r);
      let a = map.get(i);
      if (!a) { a = { idx: i, commits: 0, additions: 0, deletions: 0, days: new Set(), repos: new Set() }; map.set(i, a); }
      a.commits += r[3]; a.additions += r[4]; a.deletions += r[5];
      a.days.add(r[2]); a.repos.add(r[0]);
    }
    const out = [];
    for (const a of map.values()) {
      const label = dim === "author" ? (meta[a.idx].display || meta[a.idx].name || meta[a.idx].login || "unknown")
                                     : meta[a.idx].name;
      out.push({
        idx: a.idx, label,
        commits: a.commits, additions: a.additions, deletions: a.deletions,
        lines: a.additions + a.deletions, activeDays: a.days.size, repos: a.repos.size,
        url: dim === "author" ? meta[a.idx].url : meta[a.idx].url,
        value: 0,
      });
    }
    for (const e of out) e.value = e[state.metric === "lines" ? "lines" : state.metric];
    out.sort((a, b) => b.value - a.value);
    return out;
  }

  // --- detail table ---------------------------------------------------------
  const COLS = [
    { key: "label", name: "Contributor", num: false },
    { key: "commits", name: "Commits", num: true },
    { key: "lines", name: "Lines", num: true },
    { key: "additions", name: "Added", num: true },
    { key: "deletions", name: "Deleted", num: true },
    { key: "activeDays", name: "Active days", num: true },
    { key: "repos", name: "Repos", num: true },
  ];
  function renderTable(authorAgg) {
    const th = theme();
    const table = $("detail-table");
    const thead = table.querySelector("thead"), tbody = table.querySelector("tbody");
    thead.innerHTML = ""; tbody.innerHTML = "";
    const tr = document.createElement("tr");
    for (const c of COLS) {
      const h = document.createElement("th"); h.textContent = c.name;
      if (state.sort.key === c.key) { h.classList.add("sorted"); if (state.sort.dir === 1) h.classList.add("asc"); }
      h.addEventListener("click", () => {
        if (state.sort.key === c.key) state.sort.dir *= -1;
        else state.sort = { key: c.key, dir: c.num ? -1 : 1 };
        renderTable(authorAgg);
      });
      tr.appendChild(h);
    }
    thead.appendChild(tr);

    const rows = authorAgg.slice().sort((a, b) => {
      const k = state.sort.key;
      const va = a[k], vb = b[k];
      if (typeof va === "string") return state.sort.dir * va.localeCompare(vb);
      return state.sort.dir * (va - vb);
    });
    for (const e of rows) {
      const r = document.createElement("tr");
      const first = document.createElement("td");
      const who = document.createElement("div"); who.className = "who";
      const dot = document.createElement("span"); dot.className = "dot"; dot.style.background = colorFor("author", e.idx, th);
      who.appendChild(dot);
      if (e.url) { const a = document.createElement("a"); a.href = e.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = e.label; who.appendChild(a); }
      else { const s = document.createElement("span"); s.textContent = e.label; who.appendChild(s); }
      first.appendChild(who); r.appendChild(first);
      for (const c of COLS.slice(1)) {
        const td = document.createElement("td"); td.textContent = fmtFull(e[c.key]); r.appendChild(td);
      }
      tbody.appendChild(r);
    }
  }

  // --- master render --------------------------------------------------------
  function render() {
    if (!state.data) return;
    const [start, end] = activeRange();
    const cur = rowsIn(start, end);

    // subtitles / footer
    $("timeseries-sub").textContent =
      `${metricLabel()} per ${state.granularity}, ${state.stackBy === "author" ? "by contributor" : "by repository"} · ` +
      `${isoDay(start)} → ${isoDay(end)}`;

    renderKPIs(cur, start, end);
    renderTimeSeries(cur, start, end);
    const authorAgg = aggregateBy(cur, "author");
    const repoAgg = aggregateBy(cur, "repo");
    renderBars("contrib-bars", authorAgg, "author");
    renderBars("repo-bars", repoAgg, "repo");
    renderTable(authorAgg);
  }

  // --- multi-select population ---------------------------------------------
  function buildMulti(hostId, summaryId, items, stateKey, dim) {
    const host = $(hostId), summary = $(summaryId);
    host.innerHTML = "";
    const actions = document.createElement("div"); actions.className = "multi-actions";
    const all = document.createElement("button"); all.type = "button"; all.textContent = "All";
    const none = document.createElement("button"); none.type = "button"; none.textContent = "None";
    actions.appendChild(all); actions.appendChild(none); host.appendChild(actions);

    const th = theme();
    const boxes = [];
    items.forEach((it, i) => {
      const lab = document.createElement("label"); lab.className = "opt";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true; cb.value = i;
      const dot = document.createElement("span"); dot.className = "dot"; dot.style.background = colorFor(dim, i, th);
      const nm = document.createElement("span"); nm.textContent = it;
      lab.appendChild(cb); lab.appendChild(dot); lab.appendChild(nm); host.appendChild(lab);
      boxes.push(cb);
      cb.addEventListener("change", () => syncMulti());
    });
    function syncMulti() {
      const chosen = boxes.filter((b) => b.checked).map((b) => parseInt(b.value, 10));
      state[stateKey] = chosen.length === boxes.length ? null : new Set(chosen);
      const n = chosen.length;
      summary.textContent = n === boxes.length ? `All ${dim === "author" ? "contributors" : "repositories"}`
        : n === 0 ? `None selected` : `${n} selected`;
      render();
    }
    all.addEventListener("click", () => { boxes.forEach((b) => (b.checked = true)); syncMulti(); });
    none.addEventListener("click", () => { boxes.forEach((b) => (b.checked = false)); syncMulti(); });
  }

  // --- controls -------------------------------------------------------------
  function segmented(id, key, after) {
    const g = $(id);
    g.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      [...g.children].forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      state[key] = b.dataset.val;
      if (after) after();
      render();
    });
  }

  function initControls() {
    $("range").addEventListener("change", (e) => {
      state.range = e.target.value;
      $("custom-range").hidden = state.range !== "custom";
      render();
    });
    $("from").addEventListener("change", (e) => { state.from = e.target.value; render(); });
    $("to").addEventListener("change", (e) => { state.to = e.target.value; render(); });
    segmented("granularity", "granularity");
    segmented("metric", "metric", () => { if (["commits", "lines", "additions", "deletions"].includes(state.sort.key)) state.sort.key = state.metric === "lines" ? "lines" : state.metric; });
    segmented("stackby", "stackBy");

    $("theme-toggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const dark = cur === "dark" || (!cur && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
      render();
    });

    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  }

  // --- boot -----------------------------------------------------------------
  function boot(data) {
    state.data = data;
    computeStableColors(data);

    if (data.demo) $("demo-badge").hidden = false;
    const gen = data.generated_at ? new Date(data.generated_at) : null;
    $("updated").textContent = gen ? "Updated " + gen.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
    $("foot-scope").textContent = `${data.repos.length} repositories · ${data.authors.length} contributors · owners: ${(data.owners || []).join(", ")}`;

    // default custom range inputs to full span
    $("from").value = data.date_range.start; $("to").value = data.date_range.end;

    buildMulti("repo-filter", "repo-summary", data.repos.map((r) => r.name), "repos", "repo");
    buildMulti("author-filter", "author-summary", data.authors.map((a) => a.display || a.name || a.login || "unknown"), "authors", "author");

    initControls();
    render();
  }

  fetch("data/activity.json", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(boot)
    .catch((err) => {
      document.getElementById("app").innerHTML =
        '<div class="empty"><h2>No data yet</h2><p>Could not load <code>data/activity.json</code> (' + err + ').</p>' +
        '<p>Run <code>python3 scripts/make_sample_data.py</code> for a demo, or set up the fetch workflow. See the README.</p></div>';
    });
})();
