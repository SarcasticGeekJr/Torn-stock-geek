// ==UserScript==
// @name         Torn Stock Geek
// @namespace    https://github.com/SarcasticGeekJr/torn-stock-geek
// @version      0.1.0
// @description  A stock advisor for Torn: ranks the next benefit block of every stock by yearly return, plans what to buy with your cash, compares with the bank, and tracks your portfolio (profit, break-even, blocks, payouts). Built for Torn PDA, works in Tampermonkey too.
// @author       SarcasticGeekJr
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      raw.githubusercontent.com
// @run-at       document-end
// @homepageURL  https://github.com/SarcasticGeekJr/torn-stock-geek
// @supportURL   https://github.com/SarcasticGeekJr/torn-stock-geek/issues
// @updateURL    https://raw.githubusercontent.com/SarcasticGeekJr/torn-stock-geek/main/torn-stock-geek.user.js
// @downloadURL  https://raw.githubusercontent.com/SarcasticGeekJr/torn-stock-geek/main/torn-stock-geek.user.js
// ==/UserScript==

/*
 * Data sources (official Torn API only in this version)
 *   v1 /torn/?selections=stocks       every stock: price, benefit block size, payout text  (Public key)
 *   v1 /user/?selections=stocks       your shares, buy prices, payout progress           (Limited key)
 *   v2 /torn/items                    item market values, to price item payouts           (Public key)
 *   v1 /market/?selections=pointsmarket  points price, for payouts in points              (Public key)
 *
 * Rules: this script only reads data and shows advice. It never buys or sells anything.
 * Every action in the game is still yours.
 */

(function () {
  "use strict";

  if (window.__tornStockGeekLoaded) return;
  window.__tornStockGeekLoaded = true;

  // ---------------------------------------------------------------- config
  const PDA_KEY = "###PDA-APIKEY###"; // Torn PDA replaces this with your key at runtime
  const VERSION = "0.1.0"; // keep in sync with @version above
  const UPDATE_URL = "https://raw.githubusercontent.com/SarcasticGeekJr/torn-stock-geek/main/torn-stock-geek.user.js";
  const TORN = "https://api.torn.com";
  const STOCKS_PAGE = "https://www.torn.com/page.php?sid=stocks";
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const MARKET_TTL = 1 * MIN; // stock prices change every minute
  const MINE_TTL = 1 * MIN;
  const ITEMS_TTL = 3 * 60 * MIN;
  const POINTS_TTL = 30 * MIN;
  const AUTO_REFRESH = 1 * MIN; // while the panel is open
  const SELL_FEE = 0.001; // 0.1% fee when selling shares
  const MAX_STEPS = 8; // how many blocks deep the planner looks per stock

  const DEFAULTS = {
    apiKey: "",
    bankApr: 0, // your best Investment Bank rate, % per year (0 = not set)
    budget: 0, // planner cash
    tab: "advisor",
    showAll: false, // advisor: also show stocks we can't value
    custom: {}, // acronym -> $ value of one payout (active) or $ per year (passive), set by the user
    fab: null, // { right, bottom } in px once dragged
  };

  // Payouts we know from the community, used only when the payout text from the API can't be read.
  // item: item id, cash: $ per payout, caches: average of the cache items, manual: user sets the value.
  const KNOWN = {
    ASS: { item: 817 }, MUN: { item: 818 }, LSC: { item: 369 }, LAG: { item: 368 }, FHG: { item: 367 },
    PRN: { item: 366 }, SYM: { item: 370 }, THS: { item: 365 }, EWM: { item: 364 },
    TCC: { caches: true }, HRG: { manual: "a random property" },
    CNC: { cash: 80e6 }, TSB: { cash: 50e6 }, TMI: { cash: 25e6 }, IOU: { cash: 12e6 }, GRN: { cash: 4e6 }, TCT: { cash: 1e6 },
  };
  const CACHE_IDS = [1057, 1112, 1113, 1114, 1115, 1116, 1117];

  // ---------------------------------------------------------------- storage
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("tsg_" + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("tsg_" + k, JSON.stringify(v));
      } catch {}
    },
  };
  const S = Object.assign({}, DEFAULTS, store.get("settings", {}));
  S.custom = Object.assign({}, S.custom);
  const save = () => store.set("settings", S);
  const apiKey = () => (S.apiKey || (PDA_KEY.includes("#") ? "" : PDA_KEY)).trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- http
  function httpGet(url) {
    if (typeof window.PDA_httpGet === "function") return pdaGet(url);
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((res, rej) =>
        GM_xmlhttpRequest({
          method: "GET",
          url,
          timeout: 15000,
          onload: (r) => {
            if (r.status < 200 || r.status >= 300) return rej(new Error("HTTP " + r.status));
            try {
              res(JSON.parse(r.responseText));
            } catch (e) {
              rej(e);
            }
          },
          onerror: () => rej(new Error("Network error")),
          ontimeout: () => rej(new Error("Timed out")),
        })
      );
    }
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // Torn PDA silently drops a GET for a URL it already fetched in the last 2s and resolves with
  // undefined, so wait out that window and try again instead of treating it as a response.
  async function pdaGet(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await window.PDA_httpGet(url, {});
      if (r && r.status != null) {
        const status = +r.status;
        if (status < 200 || status >= 300) throw new Error("HTTP " + status);
        return JSON.parse(r.responseText);
      }
      await sleep(2100);
    }
    throw new Error("Torn PDA didn't return a response");
  }

  const memo = new Map(); // url -> { t, p, done }
  function cached(url, ttl, force) {
    const hit = memo.get(url);
    // A request for this URL still in flight is reused even when forced, so a refresh never fires a duplicate.
    if (hit && (!hit.done || (!force && Date.now() - hit.t < ttl))) return hit.p;
    const entry = { t: Date.now(), done: false };
    entry.p = httpGet(url).then(
      (d) => {
        entry.done = true;
        return d;
      },
      (e) => {
        if (memo.get(url) === entry) memo.delete(url);
        throw e;
      }
    );
    memo.set(url, entry);
    return entry.p;
  }

  class ApiError extends Error {
    constructor(msg, code) {
      super(msg);
      this.code = code;
    }
  }

  // Official Torn API. path like "/torn/?selections=stocks" or "/v2/torn/items".
  async function torn(path, ttl, force) {
    const key = apiKey();
    if (!key) throw new ApiError("no API key", -1);
    const sep = path.includes("?") ? "&" : "?";
    const url = `${TORN}${path}${sep}key=${encodeURIComponent(key)}&comment=StockGeek`;
    const d = await cached(url, ttl, force);
    if (d && d.error) {
      memo.delete(url);
      throw new ApiError(d.error.error || "Torn API error " + d.error.code, d.error.code);
    }
    return d;
  }

  // ---------------------------------------------------------------- data
  const data = {
    market: null, // [stock]
    marketAt: 0,
    marketErr: null,
    mine: null, // { [stockId]: holding }
    mineAt: 0,
    mineErr: null,
    items: null, // { id: { n: name, v: market value } }
    pointsPrice: 0,
  };

  const num = (v) => (v == null || v === "" || isNaN(+v) ? 0 : +v);

  function normStock(s, id) {
    const b = s.benefit || {};
    return {
      id: +(s.stock_id || s.id || id),
      acr: String(s.acronym || "").toUpperCase(),
      name: s.name || "",
      price: num(s.current_price),
      cap: num(s.market_cap),
      totalShares: num(s.total_shares),
      investors: num(s.investors),
      type: String(b.type || "").toLowerCase() === "passive" ? "passive" : "active",
      freq: num(b.frequency) || 7,
      req: num(b.requirement),
      desc: String(b.description || ""),
    };
  }

  async function loadMarket(force) {
    try {
      const d = await torn("/torn/?selections=stocks", MARKET_TTL, force);
      const raw = d.stocks || {};
      const list = Array.isArray(raw) ? raw.map((s) => normStock(s)) : Object.entries(raw).map(([id, s]) => normStock(s, id));
      data.market = list.filter((s) => s.id && s.acr && s.price > 0);
      data.marketAt = Date.now();
      data.marketErr = null;
      store.set("market", { t: data.marketAt, list: data.market });
    } catch (e) {
      data.marketErr = e;
      if (!data.market) {
        const c = store.get("market", null);
        if (c) {
          data.market = c.list; // stale is better than nothing
          data.marketAt = c.t;
        }
      }
    }
    return data.market;
  }

  // Your holdings. Field names are read tolerantly because the v1 stocks selection has changed over time.
  function normHolding(h, id) {
    const tx = h.transactions || {};
    const lots = (Array.isArray(tx) ? tx : Object.values(tx))
      .map((t) => ({ shares: num(t.shares ?? t.amount), price: num(t.bought_price ?? t.price), time: num(t.time_bought ?? t.time) }))
      .filter((t) => t.shares > 0);
    const pay = h.dividend || h.benefit || null;
    return {
      id: +(h.stock_id || id),
      shares: num(h.total_shares ?? h.shares),
      lots,
      payout: pay
        ? { ready: !!num(pay.ready), progress: num(pay.progress), freq: num(pay.frequency), increment: num(pay.increment) }
        : null,
    };
  }

  async function loadMine(force) {
    if (!apiKey()) return null;
    try {
      const d = await torn("/user/?selections=stocks", MINE_TTL, force);
      const raw = d.stocks || {};
      const out = {};
      for (const [id, h] of Array.isArray(raw) ? raw.map((h) => [h.stock_id, h]) : Object.entries(raw)) {
        const n = normHolding(h, id);
        if (n.id && n.shares > 0) out[n.id] = n;
      }
      data.mine = out;
      data.mineAt = Date.now();
      data.mineErr = null;
    } catch (e) {
      data.mineErr = e;
    }
    return data.mine;
  }

  async function loadItems(force) {
    const c = store.get("items", null);
    if (!force && c && Date.now() - c.t < ITEMS_TTL) {
      if (data.items !== c.items) descMemo.clear();
      return (data.items = c.items);
    }
    try {
      const d = await torn("/v2/torn/items", ITEMS_TTL, force);
      const out = {};
      for (const it of d.items || []) out[it.id] = { n: it.name, v: num(it.value && it.value.market_price) };
      data.items = out;
      descMemo.clear();
      store.set("items", { t: Date.now(), items: out });
    } catch (e) {
      if (c && !data.items) {
        data.items = c.items;
        descMemo.clear();
      }
    }
    return data.items;
  }

  async function loadPoints(force) {
    const c = store.get("points", null);
    if (!force && c && Date.now() - c.t < POINTS_TTL) return (data.pointsPrice = c.v);
    try {
      const d = await torn("/market/?selections=pointsmarket", POINTS_TTL, force);
      const costs = Object.values(d.pointsmarket || {}).map((l) => num(l.cost)).filter((x) => x > 0);
      if (costs.length) {
        data.pointsPrice = Math.min(...costs);
        store.set("points", { t: Date.now(), v: data.pointsPrice });
      }
    } catch (e) {
      if (c) data.pointsPrice = c.v;
    }
    return data.pointsPrice;
  }

  async function loadAll(force) {
    await Promise.all([loadMarket(force), loadMine(force), loadItems(false), loadPoints(false)]);
  }

  // ---------------------------------------------------------------- payout values
  const itemVal = (id) => (data.items && data.items[id] ? data.items[id].v : 0);
  const itemNm = (id) => (data.items && data.items[id] ? data.items[id].n : "item #" + id);

  // Reads the payout text, e.g. "1x Feathery Hotel Coupon", "$50,000,000", "100 points".
  const descMemo = new Map(); // desc -> parsed, reset when the item list loads
  function parseDesc(desc) {
    if (!descMemo.has(desc)) descMemo.set(desc, readDesc(desc));
    return descMemo.get(desc);
  }
  function readDesc(desc) {
    const d = desc.replace(/\s+/g, " ").trim();
    const cash = d.match(/\$\s?([\d,.]+)\s*(k|m|b|thousand|million|billion)?\b/i);
    if (cash) {
      const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }[(cash[2] || "").toLowerCase()] || 1;
      const v = parseFloat(cash[1].replace(/,/g, "")) * mult;
      if (v > 0) return { cash: v };
    }
    const pts = d.match(/([\d,]+)\s*points?\b/i);
    if (pts) return { points: +pts[1].replace(/,/g, "") };
    if (/\bcache\b/i.test(d)) return { caches: true };
    if (data.items) {
      const low = d.toLowerCase();
      let best = null;
      for (const [id, it] of Object.entries(data.items)) {
        const n = it.n.toLowerCase();
        if (n.length > 3 && low.includes(n) && (!best || n.length > best.len)) best = { id: +id, len: n.length };
      }
      if (best) {
        const name = data.items[best.id].n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const q = d.match(new RegExp("(\\d+)\\s*x\\s*" + name, "i")) || d.match(new RegExp("(\\d+)\\s+" + name, "i"));
        return { item: best.id, qty: q ? +q[1] : 1 };
      }
    }
    return null;
  }

  // { value: $ per payout (active) or $ per year (passive), how: text, ok: bool, custom: bool }
  function payoutValue(s) {
    if (S.custom[s.acr] > 0) return { value: S.custom[s.acr], how: "your value", ok: true, custom: true };
    if (s.type === "passive") return { value: 0, how: "a perk (set what it's worth to you)", ok: false };
    const p = parseDesc(s.desc) || KNOWN[s.acr] || null;
    if (!p) return { value: 0, how: s.desc || "unknown payout", ok: false };
    if (p.cash) return { value: p.cash, how: money(p.cash) + " cash", ok: true, cash: true };
    if (p.points) {
      const v = p.points * data.pointsPrice;
      return { value: v, how: `${p.points} points × ${money(data.pointsPrice)}`, ok: v > 0 };
    }
    if (p.caches) {
      const vals = CACHE_IDS.map(itemVal).filter((v) => v > 0);
      const v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      return { value: v, how: "a random cache (average value)", ok: v > 0 };
    }
    if (p.item) {
      const qty = p.qty || 1;
      const v = qty * itemVal(p.item);
      return { value: v, how: `${qty}× ${itemNm(p.item)}${v ? " at market value" : ""}`, ok: v > 0 };
    }
    if (p.manual) return { value: 0, how: p.manual + " (set its value)", ok: false };
    return { value: 0, how: s.desc || "unknown payout", ok: false };
  }

  // ---------------------------------------------------------------- block maths
  // Block k (1-based) needs req × 2^(k-1) more shares, so holding n blocks takes req × (2^n − 1) shares.
  const sharesFor = (req, n) => req * (Math.pow(2, n) - 1);
  function blocksHeld(shares, req) {
    if (!req) return 0;
    let n = 0;
    while (sharesFor(req, n + 1) <= shares && n < 40) n++;
    return n;
  }
  const yearly = (perPayout, freq) => (perPayout * 365) / (freq || 7);
  const owned = (id) => (data.mine && data.mine[id] ? data.mine[id].shares : 0);

  // The next few blocks you could buy for a stock, with cost and yearly return of each.
  function steps(s, depth) {
    const pv = payoutValue(s);
    const have = owned(s.id);
    const held = blocksHeld(have, s.req);
    const out = [];
    if (s.type === "passive") {
      if (held >= 1) return out;
      const need = s.req - have;
      const cost = need * s.price;
      out.push({ s, block: 1, need, cost, perYear: pv.value, roi: pv.ok && cost ? pv.value / cost : 0, pv });
      return out;
    }
    for (let k = held + 1; k <= held + depth; k++) {
      const need = sharesFor(s.req, k) - Math.max(have, sharesFor(s.req, k - 1));
      const cost = need * s.price;
      const perYear = yearly(pv.value, s.freq);
      out.push({ s, block: k, need, cost, perYear, roi: pv.ok && cost ? perYear / cost : 0, pv, partial: k === held + 1 && have > sharesFor(s.req, held) });
    }
    return out;
  }

  // Greedy planner: buy the best-return next block you can afford, then look again.
  function plan(budget) {
    const bank = S.bankApr / 100;
    const queues = (data.market || []).filter((s) => s.req > 0).map((s) => steps(s, MAX_STEPS).filter((x) => x.roi > 0));
    const picks = [];
    let left = budget;
    for (;;) {
      let best = null;
      for (const q of queues) {
        const x = q[0];
        if (!x || x.cost > left) continue;
        if (bank && x.roi <= bank) continue;
        if (!best || x.roi > best.roi) best = x;
      }
      if (!best) break;
      picks.push(best);
      left -= best.cost;
      queues.find((q) => q[0] === best).shift();
    }
    // The best block you can't afford yet, to save toward.
    let next = null;
    for (const q of queues) {
      const x = q[0];
      if (x && x.cost > left && (!bank || x.roi > bank) && (!next || x.roi > next.roi)) next = x;
    }
    return { picks, left, next };
  }

  // ---------------------------------------------------------------- formatting
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const commas = (n) => Math.round(n).toLocaleString("en-US");
  function money(n) {
    if (!isFinite(n)) return "—";
    const a = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}b`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
    return `${sign}$${a.toFixed(a < 10 ? 2 : 0)}`;
  }
  const price = (n) => "$" + (+n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctTxt = (r, d = 1) => (isFinite(r) ? (r * 100).toFixed(d) + "%" : "—");
  const signPct = (r) => (r > 0 ? "+" : "") + pctTxt(r);
  const shares = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(2) + "m" : n >= 1e3 ? +(n / 1e3).toFixed(1) + "k" : commas(n));
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago";
  };
  const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10] || "th");
  // Reads "1.5b", "250m", "10k", "1,000,000".
  function parseMoney(t) {
    const m = String(t || "").replace(/[$,\s]/g, "").match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return 0;
    return parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1);
  }
  const roiClass = (roi) => {
    const bank = S.bankApr / 100;
    if (!roi) return "even";
    if (bank) return roi > bank ? "good" : "bad";
    return roi >= 0.15 ? "good" : roi >= 0.05 ? "even" : "bad";
  };

  // ---------------------------------------------------------------- UI shell
  const host = document.createElement("div");
  host.id = "torn-stock-geek";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="fab" data-act="toggle" title="Torn Stock Geek (drag to move)"><span>📈</span></button>
    <div class="scrim" data-act="close" hidden></div>
    <section class="panel" hidden role="dialog" aria-label="Torn Stock Geek">
      <header class="top">
        <div class="title">Torn Stock Geek</div>
        <button class="ib" data-act="refresh" title="Refresh">⟳</button>
        <button class="ib" data-act="tab" data-tab="settings" title="Settings">⚙</button>
        <button class="ib" data-act="close" title="Close">✕</button>
      </header>
      <nav class="tabs">
        <button class="tab" data-act="tab" data-tab="advisor">Advisor</button>
        <button class="tab" data-act="tab" data-tab="planner">Planner</button>
        <button class="tab" data-act="tab" data-tab="portfolio">Portfolio</button>
      </nav>
      <div class="body"></div>
    </section>
    <div class="toast" hidden></div>`;
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const body = () => $(".body");

  let autoT = 0;
  let loading = false;
  function open() {
    $(".panel").hidden = false;
    $(".scrim").hidden = false;
    render();
    refresh(false);
    clearInterval(autoT);
    autoT = setInterval(() => refresh(false, true), AUTO_REFRESH);
  }
  function close() {
    $(".panel").hidden = true;
    $(".scrim").hidden = true;
    clearInterval(autoT);
  }
  const isOpen = () => !$(".panel").hidden;

  let toastT = 0;
  function toast(msg, kind, ms = 2200) {
    const t = $(".toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(toastT);
    if (ms) toastT = setTimeout(() => (t.hidden = true), ms);
  }

  async function refresh(force, quiet) {
    if (loading || !apiKey()) return render();
    loading = true;
    $("[data-act=refresh]").classList.add("spinning");
    if (!quiet) render();
    await loadAll(force);
    loading = false;
    $("[data-act=refresh]").classList.remove("spinning");
    // Don't redraw the settings or planner while someone is typing there.
    const typing = root.activeElement && root.activeElement.tagName === "INPUT";
    if (isOpen() && !(typing && S.tab !== "advisor" && S.tab !== "portfolio")) render();
    else if (S.tab === "planner") renderPlan();
  }

  function render() {
    $$(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    $(".tabs").hidden = S.tab === "settings";
    $(".title").textContent = S.tab === "settings" ? "Settings" : "Torn Stock Geek";
    const scroll = body().scrollTop;
    if (!apiKey() && S.tab !== "settings") renderNoKey();
    else ({ advisor: renderAdvisor, planner: renderPlanner, portfolio: renderPortfolio, settings: renderSettings })[S.tab]();
    body().scrollTop = scroll;
  }

  function renderNoKey() {
    body().innerHTML = `<div class="card">
      <b>Add your Torn API key to start</b>
      <p class="muted">On Torn PDA this happens by itself. In Tampermonkey, open ⚙ Settings and paste a key.
      A <b>Limited</b> key lets the Portfolio tab see your shares; a Public key only gives market advice.</p>
      <button class="btn" data-act="tab" data-tab="settings">Open settings</button></div>
      ${foot()}`;
  }

  const foot = () =>
    `<p class="foot muted">Advice only: Torn Stock Geek never buys or sells. Prices change every minute and returns aren't guaranteed.<br>Torn Stock Geek v${VERSION}</p>`;

  function status() {
    const parts = [];
    if (data.marketAt) parts.push(`Prices ${ago(data.marketAt)}`);
    parts.push(S.bankApr ? `Bank ${S.bankApr}%/yr` : `<button class="link" data-act="tab" data-tab="settings">Set your bank rate</button>`);
    let err = "";
    if (data.marketErr) err = `<p class="err">Couldn't load stocks: ${esc(data.marketErr.message)}${data.market ? " (showing saved prices)" : ""}</p>`;
    return `${err}<p class="status muted">${parts.join(" · ")}</p>`;
  }

  function loadingOr(fn) {
    if (!data.market) {
      body().innerHTML = data.marketErr
        ? `${status()}<button class="btn" data-act="refresh">Try again</button>`
        : `<p class="muted center"><span class="spin">⟳</span> Loading stocks…</p>`;
      return;
    }
    fn();
  }

  // ---------------------------------------------------------------- advisor
  function renderAdvisor() {
    loadingOr(() => {
      const all = data.market.filter((s) => s.req > 0);
      const act = all.filter((s) => s.type === "active").map((s) => steps(s, 1)[0]).filter(Boolean);
      const valued = act.filter((x) => x.roi > 0).sort((a, b) => b.roi - a.roi);
      const unvalued = act.filter((x) => !(x.roi > 0));
      const pas = all.filter((s) => s.type === "passive");
      body().innerHTML = `${status()}
        <p class="intro muted">Best <b>next benefit block</b> to buy, by yearly return on the money it costs. Each extra block of the same stock costs double, so it earns about half as much.</p>
        <div class="cards">${valued.map(blockCard).join("") || `<p class="muted">No payouts could be valued yet.</p>`}</div>
        ${unvalued.length ? `<h3>Can't value automatically (${unvalued.length})</h3>
          <p class="muted small">Tap <b>Set value</b> and type what one payout is worth to you.</p>
          <div class="cards">${unvalued.map(blockCard).join("")}</div>` : ""}
        <h3>Perks (passive, need 1 block)</h3>
        <p class="muted small">Perks last while you hold the shares (they start after 7 days). Set what a perk is worth to you per year to rank it.</p>
        <div class="cards">${pas.map(perkCard).join("")}</div>
        ${foot()}`;
    });
  }

  function blockCard(x) {
    const s = x.s;
    const have = owned(s.id);
    const held = blocksHeld(have, s.req);
    const bank = S.bankApr / 100;
    const payback = x.roi > 0 ? Math.round(365 / x.roi) : 0;
    return `<div class="card" data-acr="${esc(s.acr)}">
      <div class="crow">
        <div class="grow"><b class="acr">${esc(s.acr)}</b> <span class="muted">${esc(s.name)}</span>
          <small class="muted">${price(s.price)} · pays every ${s.freq} days${held ? ` · you have ${held} block${held > 1 ? "s" : ""}` : ""}</small></div>
        <span class="pill ${roiClass(x.roi)}">${x.roi > 0 ? pctTxt(x.roi) + "/yr" : "?"}</span>
      </div>
      <div class="line">${ordinal(x.block)} block: <b>+${shares(x.need)}</b> shares · <b>${money(x.cost)}</b>${x.partial ? ` <span class="muted">(you already have ${shares(have - sharesFor(s.req, held))} toward it)</span>` : ""}</div>
      <div class="line muted">Pays ${esc(x.pv.how)}${x.pv.ok ? `${x.pv.cash ? "" : ` ≈ ${money(x.pv.value)}`} → <b class="tx">${money(x.perYear)}/yr</b>` : ""}
        <button class="link" data-act="setval" data-acr="${esc(s.acr)}">${x.pv.custom ? "Edit value" : x.pv.ok ? "Change" : "Set value"}</button></div>
      ${x.roi > 0 ? `<div class="line">Pays for itself in <b>${commas(payback)} days</b>${bank ? (x.roi > bank ? ` · <span class="g">beats bank (${S.bankApr}%)</span>` : ` · <span class="r">bank pays more (${S.bankApr}%)</span>`) : ""}</div>` : ""}
      ${!x.pv.custom && s.desc ? `<div class="line small muted">Torn says: “${esc(s.desc)}”</div>` : ""}
    </div>`;
  }

  function perkCard(s) {
    const have = owned(s.id);
    const got = have >= s.req;
    const x = steps(s, 1)[0];
    const val = S.custom[s.acr] || 0;
    return `<div class="card ${got ? "pick" : ""}" data-acr="${esc(s.acr)}">
      <div class="crow">
        <div class="grow"><b class="acr">${esc(s.acr)}</b> <span class="muted">${esc(s.name)}</span>
          <small class="muted">${esc(s.desc || "perk")}</small></div>
        ${got ? `<span class="pill good">✓ have it</span>` : val ? `<span class="pill ${roiClass(x.roi)}">${pctTxt(x.roi)}/yr</span>` : ""}
      </div>
      <div class="line">${got ? `You hold ${shares(have)} (needs ${shares(s.req)})` : `Needs <b>${shares(s.req)}</b> shares · <b>${money(x.cost)}</b>${have ? ` more (you have ${shares(have)})` : ""}`}
        <button class="link" data-act="setval" data-acr="${esc(s.acr)}">${val ? `worth ${money(val)}/yr to you` : "Set worth"}</button></div>
    </div>`;
  }

  // ---------------------------------------------------------------- planner
  function renderPlanner() {
    loadingOr(() => {
      body().innerHTML = `${status()}
        <label class="field">How much cash do you want to invest?
          <input class="budget" inputmode="decimal" placeholder="e.g. 500m or 2.5b" value="${S.budget ? esc(money(S.budget).replace("$", "")) : ""}" autocomplete="off"></label>
        <div class="plan"></div>
        ${foot()}`;
      const inp = $(".budget");
      inp.addEventListener("input", () => {
        S.budget = parseMoney(inp.value);
        save();
        renderPlan();
      });
      renderPlan();
    });
  }

  function renderPlan() {
    const box = $(".plan");
    if (!box || !data.market) return;
    if (!S.budget) {
      box.innerHTML = `<p class="muted">Type an amount. The planner picks the blocks with the best yearly return you can afford, one at a time${S.bankApr ? `, and skips anything that pays less than your bank (${S.bankApr}%)` : ""}.</p>`;
      return;
    }
    const p = plan(S.budget);
    const spent = S.budget - p.left;
    const income = p.picks.reduce((a, x) => a + x.perYear, 0);
    const bank = S.bankApr / 100;
    box.innerHTML = `
      ${p.picks.length ? `<ol class="steps">${p.picks.map((x) => `<li>
          Buy <b>${shares(x.need)} ${esc(x.s.acr)}</b> (${money(x.cost)}) → ${ordinal(x.block)} ${esc(x.s.acr)} ${x.s.type === "passive" ? "perk" : "block"}
          <span class="pill ${roiClass(x.roi)}">${pctTxt(x.roi)}/yr</span>
          <small class="muted">${x.s.type === "passive" ? esc(x.s.desc) : `${esc(x.pv.how)} every ${x.s.freq} days`}</small></li>`).join("")}</ol>
        <div class="sum">Spend <b>${money(spent)}</b> → about <b class="g">${money(income)}/yr</b> in payouts (${pctTxt(spent ? income / spent : 0)}/yr)</div>`
        : `<p class="muted">Nothing worth buying with ${money(S.budget)}${bank ? ` that beats your bank (${S.bankApr}%)` : ""}.</p>`}
      ${p.left > 0 ? `<div class="sum">Left over: <b>${money(p.left)}</b>${bank ? ` → put it in the bank (${S.bankApr}%/yr ≈ ${money(p.left * bank)}/yr)` : ""}${p.next ? `, or save toward <b>${esc(p.next.s.acr)}</b> ${ordinal(p.next.block)} block (${money(p.next.cost)}, ${pctTxt(p.next.roi)}/yr)` : ""}.</div>` : ""}
      <p class="muted small">Buy on the <a href="${STOCKS_PAGE}" target="_top">stock market page</a>. Prices move every minute, so check the cost there. Share prices also go up and down, so a block can be worth less (or more) when you sell.</p>`;
  }

  // ---------------------------------------------------------------- portfolio
  function renderPortfolio() {
    loadingOr(() => {
      if (data.mineErr && !data.mine) {
        const access = data.mineErr.code === 16;
        body().innerHTML = `${status()}<div class="card"><b>Couldn't load your shares</b>
          <p class="muted">${access ? "Your API key's access level is too low. The Portfolio tab needs a <b>Limited</b> key (or higher)." : esc(data.mineErr.message)}</p>
          <button class="btn" data-act="tab" data-tab="settings">Settings</button></div>${foot()}`;
        return;
      }
      if (!data.mine) {
        body().innerHTML = `<p class="muted center"><span class="spin">⟳</span> Loading your shares…</p>`;
        return;
      }
      const byId = Object.fromEntries(data.market.map((s) => [s.id, s]));
      const rows = Object.values(data.mine)
        .filter((h) => byId[h.id])
        .map((h) => holdingStats(h, byId[h.id]))
        .sort((a, b) => b.value - a.value);
      const tv = rows.reduce((a, r) => a + r.value, 0);
      const tc = rows.reduce((a, r) => a + (r.cost || 0), 0);
      const known = rows.every((r) => r.cost);
      const income = rows.reduce((a, r) => a + r.income, 0);
      const ready = rows.filter((r) => r.h.payout && r.h.payout.ready && r.s.type === "active");
      body().innerHTML = `${status()}
        ${rows.length ? `<div class="stats">
          <div class="stat"><span>Value (if sold)</span><b>${money(tv * (1 - SELL_FEE))}</b></div>
          <div class="stat"><span>Profit / loss</span><b class="${tv * (1 - SELL_FEE) - tc >= 0 ? "g" : "r"}">${known ? money(tv * (1 - SELL_FEE) - tc) : "—"}</b><small>${known && tc ? signPct((tv * (1 - SELL_FEE)) / tc - 1) : "buy prices missing"}</small></div>
          <div class="stat"><span>Payouts</span><b>${money(income)}/yr</b><small>${tv ? pctTxt(income / tv) + " of value" : ""}</small></div>
          <div class="stat"><span>Ready to collect</span><b class="${ready.length ? "a" : ""}">${ready.length ? ready.map((r) => esc(r.s.acr)).join(", ") : "none"}</b></div>
        </div>
        <div class="cards">${rows.map(holdingCard).join("")}</div>` : `<p class="muted">You don't own any shares yet. The <b>Advisor</b> and <b>Planner</b> tabs show what's worth buying.</p>`}
        ${foot()}`;
    });
  }

  function holdingStats(h, s) {
    const value = h.shares * s.price;
    const lotShares = h.lots.reduce((a, l) => a + l.shares, 0);
    // Buy prices are only trusted when the lots add up to what you hold.
    const avg = lotShares && Math.abs(lotShares - h.shares) / h.shares < 0.001 ? h.lots.reduce((a, l) => a + l.shares * l.price, 0) / lotShares : 0;
    const cost = avg ? avg * h.shares : 0;
    const held = blocksHeld(h.shares, s.req);
    const pv = payoutValue(s);
    const income = s.type === "passive" ? (held ? pv.value : 0) : held * yearly(pv.value, s.freq);
    return { h, s, value, avg, cost, held, pv, income };
  }

  function holdingCard(r) {
    const { h, s, avg, held } = r;
    const net = r.value * (1 - SELL_FEE);
    const pl = r.cost ? net - r.cost : 0;
    const be = avg ? avg / (1 - SELL_FEE) : 0;
    const passive = s.type === "passive";
    const keep = passive ? (held ? s.req : 0) : sharesFor(s.req, held);
    const free = h.shares - keep;
    const toNext = passive ? (held ? 0 : s.req - h.shares) : sharesFor(s.req, held + 1) - h.shares;
    const pay = h.payout;
    let payTxt = "";
    if (held && pay && !passive) payTxt = pay.ready ? `<span class="a">Payout ready to collect!</span>` : pay.freq ? `Next payout in ${Math.max(0, pay.freq - pay.progress)} day(s)` : "";
    if (held && passive && pay && !pay.ready) payTxt = `Perk active in ${Math.max(0, (pay.freq || 7) - pay.progress)} day(s)`;
    return `<div class="card" data-acr="${esc(s.acr)}">
      <div class="crow">
        <div class="grow"><b class="acr">${esc(s.acr)}</b> <span class="muted">${esc(s.name)}</span>
          <small class="muted">${commas(h.shares)} shares × ${price(s.price)} = ${money(r.value)}</small></div>
        ${r.cost ? `<span class="pill ${pl >= 0 ? "good" : "bad"}">${signPct(net / r.cost - 1)}</span>` : ""}
      </div>
      ${avg ? `<div class="line">Bought at <b>${price(avg)}</b> avg · profit if sold now <b class="${pl >= 0 ? "g" : "r"}">${money(pl)}</b></div>
        <div class="line muted">Break-even price (after 0.1% fee): <b class="tx">${price(be)}</b></div>` : ""}
      <div class="line">${held ? `✓ ${passive ? "Perk" : `${held} block${held > 1 ? "s" : ""}`}${!passive && r.pv.ok ? ` · ${money(r.income)}/yr` : ""}` : "No block yet"}
        ${toNext > 0 ? ` · <span class="muted">${shares(toNext)} more for ${passive ? "the perk" : `the ${ordinal(held + 1)} block`} (${money(toNext * s.price)})</span>` : ""}</div>
      ${payTxt ? `<div class="line">${payTxt}</div>` : ""}
      ${held ? `<div class="line small ${free > 0 ? "muted" : "a"}">${free > 0 ? `You can sell up to ${commas(free)} shares and keep your ${passive ? "perk" : "blocks"}.` : `⚠ Selling any shares loses ${passive ? "the perk" : `your ${ordinal(held)} block`}.`}</div>` : ""}
    </div>`;
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    const pda = !PDA_KEY.includes("#");
    body().innerHTML = `
      <button class="link back" data-act="tab" data-tab="advisor">‹ Back</button>
      <h3>API key</h3>
      <p class="muted small">${pda ? "Torn PDA is giving the script your key. You only need this box to use a different key." : "Paste a Torn API key. A <b>Limited</b> key is needed for the Portfolio tab; Public works for the rest."}</p>
      <input class="set-key" type="password" placeholder="${pda ? "using Torn PDA key" : "API key"}" value="${esc(S.apiKey)}" autocomplete="off">
      <h3>Your bank rate</h3>
      <p class="muted small">Open City Bank → Investment and type your best yearly rate (APR). Blocks that pay less get marked red.</p>
      <label class="tog"><input class="set-bank num" inputmode="decimal" value="${S.bankApr || ""}" placeholder="e.g. 18"> % per year</label>
      <h3>Your values</h3>
      ${Object.keys(S.custom).length ? `<div class="cards">${Object.entries(S.custom).map(([a, v]) => `<div class="card crow"><b class="grow">${esc(a)}</b> ${money(v)} <button class="link" data-act="clearval" data-acr="${esc(a)}">Remove</button></div>`).join("")}</div>` : `<p class="muted small">None yet. Set them with "Set value" on the Advisor tab.</p>`}
      <h3>About</h3>
      <div class="about">
        <div><b>Torn Stock Geek v${VERSION}</b></div>
        <div class="muted small">Advice from the official Torn API. It never buys or sells anything for you.</div>
        <button class="btn ghost" data-act="update">Check for updates</button>
        <div class="upd muted small"></div>
      </div>
      ${foot()}`;
    $(".set-key").addEventListener("change", (e) => {
      S.apiKey = e.target.value.trim();
      save();
      memo.clear();
      data.mine = null;
      data.mineErr = null;
      toast("Key saved");
    });
    $(".set-bank").addEventListener("change", (e) => {
      S.bankApr = Math.max(0, parseFloat(e.target.value) || 0);
      save();
      toast(S.bankApr ? `Bank rate ${S.bankApr}%` : "Bank rate cleared");
    });
  }

  async function checkUpdate() {
    const out = $(".upd");
    out.textContent = "Checking…";
    try {
      const url = UPDATE_URL + "?t=" + Date.now();
      let text;
      if (typeof window.PDA_httpGet === "function") text = (await window.PDA_httpGet(url, {}))?.responseText;
      else if (typeof GM_xmlhttpRequest === "function")
        text = await new Promise((res, rej) => GM_xmlhttpRequest({ method: "GET", url, onload: (r) => res(r.responseText), onerror: rej }));
      else text = await (await fetch(url)).text();
      const latest = ((text || "").match(/@version\s+([\d.]+)/) || [])[1];
      if (!latest) throw new Error("no version found");
      const a = latest.split(".").map(Number);
      const b = VERSION.split(".").map(Number);
      const newer = a.reduce((r, n, i) => r || (n > (b[i] || 0) ? 1 : n < (b[i] || 0) ? -1 : 0), 0) > 0;
      out.innerHTML = newer
        ? `Version <b>${esc(latest)}</b> is out. In Torn PDA: Settings → Userscripts → ⟳, then REVIEW. In Tampermonkey: Dashboard → check for updates.`
        : `You have the latest version (${esc(VERSION)}).`;
    } catch (e) {
      out.textContent = "Couldn't check: " + e.message;
    }
  }

  // Ask what a payout (or perk) is worth, in plain money like "15m".
  function setValue(acr) {
    const s = (data.market || []).find((x) => x.acr === acr);
    if (!s) return;
    const passive = s.type === "passive";
    const cur = S.custom[acr] ? money(S.custom[acr]).replace("$", "") : "";
    const q = passive
      ? `${acr} perk: ${s.desc}\n\nWhat is this perk worth to you per YEAR? (e.g. 200m). Empty = clear.`
      : `${acr} pays: ${s.desc}\n\nWhat is ONE payout worth to you? (e.g. 15m). Empty = use the automatic value.`;
    const ans = prompt(q, cur);
    if (ans == null) return;
    const v = parseMoney(ans);
    if (v > 0) S.custom[acr] = v;
    else delete S.custom[acr];
    save();
    render();
  }

  // ---------------------------------------------------------------- events
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "toggle") {
      if (fabDragged) return;
      isOpen() ? close() : open();
    } else if (act === "close") close();
    else if (act === "refresh") refresh(true);
    else if (act === "tab") {
      S.tab = b.dataset.tab;
      if (S.tab !== "settings") save();
      body().scrollTop = 0;
      render();
      if (S.tab !== "settings" && apiKey() && !data.market) refresh(false);
    } else if (act === "setval") setValue(b.dataset.acr);
    else if (act === "clearval") {
      delete S.custom[b.dataset.acr];
      save();
      render();
    } else if (act === "update") checkUpdate();
  });

  // Draggable button, so it never sits on top of something you need.
  let fabDragged = false;
  function fabSetup() {
    const fab = $(".fab");
    if (S.fab) Object.assign(fab.style, { right: S.fab.right + "px", bottom: S.fab.bottom + "px" });
    let start = null;
    fab.addEventListener("pointerdown", (e) => {
      start = { x: e.clientX, y: e.clientY, r: parseFloat(getComputedStyle(fab).right), b: parseFloat(getComputedStyle(fab).bottom) };
      fabDragged = false;
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!fabDragged && Math.hypot(dx, dy) < 8) return;
      fabDragged = true;
      const right = Math.min(Math.max(4, start.r - dx), innerWidth - 56);
      const bottom = Math.min(Math.max(4, start.b - dy), innerHeight - 56);
      Object.assign(fab.style, { right: right + "px", bottom: bottom + "px" });
      S.fab = { right, bottom };
    });
    const end = () => {
      if (start && fabDragged) save();
      start = null;
      setTimeout(() => (fabDragged = false), 0);
    };
    fab.addEventListener("pointerup", end);
    fab.addEventListener("pointercancel", end);
  }

  // ---------------------------------------------------------------- styles
  function CSS() {
    return `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
button { font: inherit; cursor: pointer; }
[hidden] { display: none !important; }
:host {
  --bg: #1d1f22; --bg2: #26292d; --bg3: #30343a; --line: #3a3f46; --text: #e9ecef; --muted: #9aa3ad;
  --acc: #74c0fc; --g: #7fdc6f; --r: #ff8787; --amber: #ffd43b;
}
.fab { position: fixed; right: 14px; bottom: 148px; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;
  border: 1px solid var(--line); background: var(--bg2); color: var(--text); box-shadow: 0 4px 14px rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center; font-size: 24px; -webkit-tap-highlight-color: transparent;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.fab:active { transform: scale(.95); }
.scrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.45); }
.panel { position: fixed; z-index: 2147483002; left: 0; right: 0; bottom: 0; height: 88vh; height: 88dvh;
  background: var(--bg); color: var(--text); border-radius: 16px 16px 0 0; border: 1px solid var(--line);
  display: flex; flex-direction: column; box-shadow: 0 -8px 30px rgba(0,0,0,.5); font-size: 14px; line-height: 1.35; }
@media (min-width: 760px) { .panel { left: auto; top: 0; height: 100vh; width: 440px; border-radius: 0; } }
.top { display: flex; align-items: center; gap: 6px; padding: 10px 10px 8px; }
.title { flex: 1; font-weight: 700; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ib { background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 10px; min-width: 36px; height: 36px; font-size: 17px; padding: 0 8px; }
.ib.spinning { animation: sp .8s linear infinite; opacity: .7; }
.spin { display: inline-block; animation: sp .8s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ib.spinning, .spin { animation-duration: 3s; } }
.tabs { display: flex; gap: 4px; margin: 0 10px 8px; background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 3px; }
.tab { flex: 1; background: transparent; border: 0; color: var(--muted); border-radius: 9px; padding: 8px 4px; font-size: 14px; }
.tab.on { background: var(--bg3); color: var(--text); font-weight: 700; }
.body { flex: 1; overflow-y: auto; padding: 4px 12px 12px; border-top: 1px solid var(--line); -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 2px 6px; }
p { margin: 6px 2px; }
.muted { color: var(--muted); } .small { font-size: 12px; } .g { color: var(--g); } .r { color: var(--r); } .a { color: var(--amber); } .err { color: var(--r); }
.center { text-align: center; padding: 30px 0; }
.status { font-size: 12px; margin: 8px 2px; }
.intro { font-size: 13px; }
.foot { font-size: 11px; margin-top: 18px; text-align: center; }
.link { background: none; border: 0; color: var(--acc); padding: 0 2px; font-size: inherit; text-decoration: underline; }
a { color: var(--acc); }
.back { margin: 8px 0 0; text-decoration: none; }
input { font: inherit; font-size: 16px; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; width: 100%; outline: none; }
input:focus { border-color: var(--acc); }
input.num { width: 90px; }
.field { display: grid; gap: 6px; font-weight: 600; margin: 8px 2px 10px; }
.tog { display: flex; align-items: center; gap: 10px; }
.cards { display: flex; flex-direction: column; gap: 6px; }
.card { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 9px 10px; display: grid; gap: 3px; }
.card.pick { border-color: rgba(127,220,111,.5); }
.card p { margin: 4px 0 8px; }
.crow { display: flex; align-items: center; gap: 8px; }
.grow { flex: 1; min-width: 0; }
.grow small { display: block; font-size: 11px; margin-top: 1px; }
.acr { font-size: 15px; }
.line { font-size: 13px; }
.tx { color: var(--text); }
.pill { display: inline-block; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; flex: none; }
.pill.good { background: rgba(127,220,111,.15); color: var(--g); } .pill.bad { background: rgba(255,135,135,.15); color: var(--r); }
.pill.even { background: var(--bg3); color: var(--muted); }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
.stat { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; min-width: 0; }
.stat > span { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.stat b { font-size: 17px; word-break: break-word; }
.stat small { display: block; font-size: 11px; color: var(--muted); }
.steps { margin: 6px 0; padding-left: 22px; display: grid; gap: 8px; }
.steps li { font-size: 14px; }
.steps small { display: block; font-size: 12px; }
.sum { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 9px 10px; margin: 8px 0; font-size: 13px; }
.btn { display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 14px; border-radius: 10px; border: 0;
  background: var(--acc); color: #0b1a26; font-weight: 700; text-decoration: none; font-size: 14px; justify-self: start; }
.btn.ghost { background: transparent; color: var(--acc); border: 1px solid var(--acc); }
.about { display: grid; gap: 6px; justify-items: start; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483003; background: var(--bg3); color: var(--text);
  border: 1px solid var(--line); border-radius: 10px; padding: 9px 14px; font-size: 14px; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
.toast.bad { border-color: var(--r); }
`;
  }

  // ---------------------------------------------------------------- start
  function start() {
    if (!document.body) return setTimeout(start, 200);
    document.body.appendChild(host);
    fabSetup();
  }
  start();
})();
