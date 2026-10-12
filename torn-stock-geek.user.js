// ==UserScript==
// @name         Torn Stock Geek
// @namespace    https://github.com/SarcasticGeekJr/torn-stock-geek
// @version      0.8.0
// @description  A stock advisor for Torn: compares what your money would earn in the bank, blocks, swing trading or holding; ranks the next benefit block of every stock by yearly return, plans what to buy with your cash, compares with your bank rate, tracks your portfolio, shows price charts with swing-trading signals, tests trading methods on each stock's real prices, has a practice account, price and payout alerts, a trade plan, and a fill-amount helper on the stock page. Built for Torn PDA, works in Tampermonkey too.
// @author       SarcasticGeekJr
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      tornsy.com
// @connect      ntfy.sh
// @connect      raw.githubusercontent.com
// @run-at       document-end
// @homepageURL  https://github.com/SarcasticGeekJr/torn-stock-geek
// @supportURL   https://github.com/SarcasticGeekJr/torn-stock-geek/issues
// @updateURL    https://raw.githubusercontent.com/SarcasticGeekJr/torn-stock-geek/main/torn-stock-geek.user.js
// @downloadURL  https://raw.githubusercontent.com/SarcasticGeekJr/torn-stock-geek/main/torn-stock-geek.user.js
// ==/UserScript==

/*
 * Data sources
 *   Official Torn API
 *     v1 /torn/?selections=stocks          every stock: price, benefit block size, payout text   (Public key)
 *     v1 /torn/?selections=bank            Investment Bank rates (APR per term)                  (Public key)
 *     v1 /user/?selections=stocks          your shares, buy prices, payout progress              (Limited key)
 *     v2 /torn/items                       item market values, to price item payouts             (Public key)
 *     v1 /market/?selections=pointsmarket  points price, for payouts in points                   (Public key)
 *   ntfy (https://ntfy.sh, free, no account): alerts are also sent as phone notifications to your own topic.
 *   Tornsy (https://tornsy.com/api, free, no key): price history of every stock, collected each minute.
 *     /stocks?interval=h24,d7              current prices plus 24h and 7d ago
 *     /{acronym}?interval=d1&limit=760     daily candles [time, open, high, low, close, total_shares]
 *     /{acronym}?interval=h1&limit=1000    hourly candles, to test day trading
 *
 * Rules: this script only reads data and shows advice. It never buys or sells anything.
 * On the stock market page it can type a number of shares into Torn's box when you tap one of its
 * buttons; you still press Torn's own BUY/SELL and confirm. Every action in the game is yours.
 */

(function () {
  "use strict";

  if (window.__tornStockGeekLoaded) return;
  window.__tornStockGeekLoaded = true;

  // ---------------------------------------------------------------- config
  const PDA_KEY = "###PDA-APIKEY###"; // Torn PDA replaces this with your key at runtime
  const VERSION = "0.8.0"; // keep in sync with @version above
  const UPDATE_URL = "https://raw.githubusercontent.com/SarcasticGeekJr/torn-stock-geek/main/torn-stock-geek.user.js";
  const TORN = "https://api.torn.com";
  const TORNSY = "https://tornsy.com/api";
  const STOCKS_PAGE = "https://www.torn.com/page.php?sid=stocks";
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const MARKET_TTL = 1 * MIN; // stock prices change every minute
  const MINE_TTL = 1 * MIN;
  const ITEMS_TTL = 3 * HOUR;
  const POINTS_TTL = 30 * MIN;
  const BANK_TTL = 1 * HOUR;
  const LIVE_TTL = 55 * 1000;
  const DAILY_TTL = 6 * HOUR; // daily candles; today's price comes from the live feed
  const AUTO_REFRESH = 1 * MIN; // while the panel is open
  const SELL_FEE = 0.001; // 0.1% fee when selling shares
  const MAX_STEPS = 8; // how many blocks deep the planner looks per stock
  const BANK_LIMIT = 2e9; // most you can put in one bank investment
  const SWING_N = 20; // swing signal: position in the last 20 days' range
  const SWING_LO = 0.1; // bottom 10% of the range = buy zone
  const SWING_HI = 0.9; // top 10% = sell zone

  const DEFAULTS = {
    apiKey: "",
    bankApr: 0, // your own bank rate, % per year (0 = use Torn's rate)
    merits: 0, // Bank Interest merits, +5% each
    budget: 0, // planner cash
    period: "3m", // money compare period
    tab: "advisor",
    tradeFilter: "all",
    tradeSort: "zone", // or "record"
    planAmt: 100e6, // trade plan: money to use
    alerts: {}, // acronym -> { above, below, zone, last }
    alertsOn: true,
    vibrate: true,
    payoutAlert: true, // tell me when a benefit payout is ready to collect
    inbox: [], // alerts that went off: { t, acr, text, seen }
    ntfyTopic: "", // ntfy.sh topic for phone notifications ("" = off)
    range: "1M", // chart range
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
  const BANK_TERMS = [["1w", "1 week"], ["2w", "2 weeks"], ["1m", "1 month"], ["2m", "2 months"], ["3m", "3 months"]];

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
  // Torn PDA's page blocks direct requests to tornsy.com, so PDA_httpGet (which runs outside the page) comes first.
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

  // POST, for sending notifications. Same order as GET: Torn PDA, then Tampermonkey, then fetch.
  async function httpPost(url, body, headers = {}) {
    if (typeof window.PDA_httpPost === "function") {
      const r = await window.PDA_httpPost(url, headers, body);
      if (r && r.status != null && (+r.status < 200 || +r.status >= 300)) throw new Error("HTTP " + r.status);
      return r;
    }
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((res, rej) =>
        GM_xmlhttpRequest({
          method: "POST",
          url,
          headers,
          data: body,
          timeout: 15000,
          onload: (r) => (r.status >= 200 && r.status < 300 ? res(r) : rej(new Error("HTTP " + r.status))),
          onerror: () => rej(new Error("Network error")),
          ontimeout: () => rej(new Error("Timed out")),
        })
      );
    }
    const r = await fetch(url, { method: "POST", headers, body });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r;
  }

  // ntfy phone notification. Title goes in a header, which must be plain ASCII, so emoji go in Tags.
  const NTFY = "https://ntfy.sh/";
  const ntfyTopicOk = (t) => /^[A-Za-z0-9_-]{1,64}$/.test(t || "");
  function sendNtfy(text, opts = {}) {
    if (!ntfyTopicOk(S.ntfyTopic)) return Promise.resolve(false);
    const headers = {
      Title: (opts.title || "Torn Stock Geek").replace(/[^\x20-\x7E]/g, ""),
      Tags: opts.tags || "chart_with_upwards_trend",
      Click: opts.click || STOCKS_PAGE,
    };
    if (opts.priority) headers.Priority = String(opts.priority);
    return httpPost(NTFY + S.ntfyTopic, text, headers).then(
      () => true,
      (e) => {
        // ntfy limits how often one address can send; try an alert once more a minute later.
        if (!/429/.test(e.message)) return false;
        if (opts.retry !== false) setTimeout(() => sendNtfy(text, Object.assign({}, opts, { retry: false })), 65 * 1000);
        return "busy";
      }
    );
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

  const tornsy = (path, ttl, force) => cached(TORNSY + path, ttl, force);

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
    bank: null, // { "1w": apr, ... }
    live: null, // { ACR: { price, shares, p24, p7, s7 } }
    liveAt: 0,
    liveErr: null,
    daily: {}, // ACR -> { t, time:[], close:[] } complete days only
    dailyLoading: false,
    dailyDone: 0,
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
  // Active stocks report payout progress under `dividend`, passive perks under `benefit`.
  function normHolding(h, id) {
    const tx = h.transactions || {};
    const lots = (Array.isArray(tx) ? tx : Object.values(tx))
      .map((t) => ({ shares: num(t.shares ?? t.amount), price: num(t.bought_price ?? t.price), time: num(t.time_bought ?? t.time) }))
      .filter((t) => t.shares > 0);
    const pay = h.dividend || null;
    return {
      id: +(h.stock_id || id),
      shares: num(h.total_shares ?? h.shares),
      lots,
      payout: pay ? { ready: !!num(pay.ready), progress: num(pay.progress), freq: num(pay.frequency), increment: num(pay.increment) } : null,
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
      if (!data.items) descMemo.clear();
      return (data.items = data.items || c.items);
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

  // Investment Bank rates come as APR in % per term, e.g. { "1w": 41.2, ..., "3m": 64.8 }.
  async function loadBank(force) {
    const c = store.get("bank", null);
    if (!force && c && Date.now() - c.t < BANK_TTL) return (data.bank = c.v);
    try {
      const d = await torn("/torn/?selections=bank", BANK_TTL, force);
      const b = d.bank || {};
      const out = {};
      for (const [k] of BANK_TERMS) {
        let v = num(b[k]);
        if (v > 0 && v < 1) v *= 100; // in case it ever comes as a fraction
        if (v > 0) out[k] = v;
      }
      if (Object.keys(out).length) {
        data.bank = out;
        store.set("bank", { t: Date.now(), v: out });
      }
    } catch (e) {
      if (c) data.bank = c.v;
    }
    return data.bank;
  }

  async function loadLive(force) {
    try {
      const d = await tornsy("/stocks?interval=h24,d7", LIVE_TTL, force);
      const out = {};
      for (const s of d.data || []) {
        const iv = s.interval || {};
        out[String(s.stock).toUpperCase()] = {
          name: s.name,
          price: num(s.price),
          shares: num(s.total_shares),
          p24: num(iv.h24 && iv.h24.price),
          p7: num(iv.d7 && iv.d7.price),
          s7: num(iv.d7 && iv.d7.total_shares),
        };
      }
      data.live = out;
      data.liveAt = Date.now();
      data.liveErr = null;
    } catch (e) {
      data.liveErr = e;
    }
    return data.live;
  }

  async function loadAll(force) {
    await Promise.all([loadMarket(force), loadMine(force), loadItems(false), loadPoints(false), loadBank(false), loadLive(force)]);
  }

  // Daily closes for one stock. Today's unfinished candle is dropped; the live price stands in for today.
  async function loadDaily(acr, force) {
    const c = store.get("d_" + acr, null);
    if (!force && c && Date.now() - c.t < DAILY_TTL) return (data.daily[acr] = c);
    try {
      const d = await tornsy(`/${acr.toLowerCase()}?interval=d1&limit=760`, DAILY_TTL, force);
      const rows = (d.data || []).filter((r) => r && r.length >= 5);
      const today = Math.floor(Date.now() / DAY) * (DAY / 1000);
      const done = rows.filter((r) => +r[0] < today);
      const v = { t: Date.now(), time: done.map((r) => +r[0]), close: done.map((r) => +(+r[4]).toFixed(2)) };
      data.daily[acr] = v;
      store.set("d_" + acr, v);
    } catch (e) {
      if (c) data.daily[acr] = c;
    }
    return data.daily[acr];
  }

  // Daily history for every stock, a few at a time (cached for hours, so this is slow only the first time).
  async function loadAllDaily(onProgress) {
    if (data.dailyLoading || !data.live) return;
    data.dailyLoading = true;
    const acrs = Object.keys(data.live).filter((a) => a !== "TCSE");
    data.dailyDone = 0;
    let i = 0;
    const worker = async () => {
      while (i < acrs.length) {
        const a = acrs[i++];
        await loadDaily(a).catch(() => {});
        data.dailyDone++;
        if (onProgress) onProgress();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    data.dailyLoading = false;
    if (onProgress) onProgress();
  }

  // ---------------------------------------------------------------- payout values
  const itemVal = (id) => (data.items && data.items[id] ? data.items[id].v : 0);
  const itemNm = (id) => (data.items && data.items[id] ? data.items[id].n : "item #" + id);

  // Reads the payout text Torn gives, e.g. "1x Feathery Hotel Coupon", "$50,000,000", "100 points".
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

  // ---------------------------------------------------------------- bank
  const ownsTCI = () => {
    const t = (data.market || []).find((s) => s.acr === "TCI");
    return !!(t && owned(t.id) >= t.req && t.req > 0);
  };
  // Your yearly bank rate in %: your own number if you typed one, else Torn's best term with your bonuses.
  function bankRate() {
    if (S.bankApr > 0) return { apr: S.bankApr, src: "your rate" };
    if (!data.bank) return { apr: 0, src: "" };
    let best = null;
    for (const [k, label] of BANK_TERMS) if (data.bank[k] && (!best || data.bank[k] > best.v)) best = { k, label, v: data.bank[k] };
    if (!best) return { apr: 0, src: "" };
    const mult = (1 + 0.05 * (S.merits || 0)) * (ownsTCI() ? 1.1 : 1);
    return { apr: +(best.v * mult).toFixed(1), src: `Torn bank, ${best.label}` + (mult > 1 ? " with your bonuses" : "") };
  }
  const bankApr = () => bankRate().apr;

  // What the bank pays on `amount` over `days`, re-investing each term. Uses the best term that fits the period.
  const TERM_DAYS = { "1w": 7, "2w": 14, "1m": 30, "2m": 60, "3m": 90 };
  function bankOver(amount, days) {
    const put = Math.min(amount, BANK_LIMIT);
    if (S.bankApr > 0) return { gain: put * (S.bankApr / 100) * (days / 365), apr: S.bankApr, term: "", put };
    if (!data.bank) return null;
    const mult = (1 + 0.05 * (S.merits || 0)) * (ownsTCI() ? 1.1 : 1);
    let best = null;
    for (const [k, label] of BANK_TERMS) {
      const td = TERM_DAYS[k];
      if (!data.bank[k] || (td > days && k !== "1w")) continue;
      const apr = data.bank[k] * mult;
      const gain = put * (Math.pow(1 + ((apr / 100) * td) / 365, Math.max(1, Math.floor(days / td))) - 1);
      if (!best || gain > best.gain) best = { gain, apr: +apr.toFixed(1), term: label, put, times: Math.max(1, Math.floor(days / td)) };
    }
    return best;
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
  const stockByAcr = (acr) => (data.market || []).find((s) => s.acr === acr);

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
  // Blocks that pay less than the bank are only bought with money the bank can't take (over its $2b limit).
  function plan(budget) {
    const bank = bankApr() / 100;
    const queues = (data.market || []).filter((s) => s.req > 0).map((s) => steps(s, MAX_STEPS).filter((x) => x.roi > 0));
    const picks = [];
    let left = budget;
    for (;;) {
      let best = null;
      for (const q of queues) {
        const x = q[0];
        if (!x || x.cost > left) continue;
        const overflow = bank ? left - BANK_LIMIT : left; // money the bank can't hold
        if (bank && x.roi <= bank && x.cost > overflow) continue;
        if (!best || x.roi > best.roi) best = x;
      }
      if (!best) break;
      best.belowBank = bank && best.roi <= bank;
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

  // ---------------------------------------------------------------- signals
  // Tested on 5 years of Torn prices: buying near the bottom of the last 20 days' range and selling near
  // the top beat holding on most stocks, while minute/hour trading lost to the 0.1% fee on every stock.
  function rangeOf(closes, n) {
    const w = closes.slice(-n);
    if (w.length < n) return null;
    return { lo: Math.min(...w), hi: Math.max(...w) };
  }

  // Replays the swing rule over the last `days` days of closes. Returns the money result after fees.
  function swingTest(closes, days = 365, n = SWING_N, lo = SWING_LO, hi = SWING_HI) {
    const start = Math.max(n, closes.length - days);
    if (closes.length - start < 60) return null;
    let cash = 1, sh = 0, entry = 0, inDays = 0;
    const trades = [];
    for (let i = start; i < closes.length; i++) {
      const w = closes.slice(i - n, i);
      const l = Math.min(...w), h = Math.max(...w);
      if (sh) inDays++;
      if (h <= l) continue;
      const pos = (closes[i] - l) / (h - l);
      if (pos < lo && !sh) {
        sh = cash / closes[i];
        cash = 0;
        entry = closes[i];
      } else if (pos > hi && sh) {
        cash = sh * closes[i] * (1 - SELL_FEE);
        trades.push((closes[i] * (1 - SELL_FEE)) / entry - 1);
        sh = 0;
      }
    }
    const last = closes[closes.length - 1];
    const open = sh ? last / entry - 1 : null; // a trade still running
    if (sh) cash = sh * last * (1 - SELL_FEE);
    const wins = trades.filter((t) => t > 0).length;
    return {
      ret: cash - 1,
      hold: last / closes[start] - 1,
      trades: trades.length,
      wins,
      worst: trades.length ? Math.min(...trades) : 0,
      avg: trades.length ? trades.reduce((a, b) => a + b, 0) / trades.length : 0,
      inMarket: inDays / (closes.length - start),
      open,
      days: closes.length - start,
    };
  }

  // Everything the Trade tab says about one stock.
  function signal(acr) {
    const lv = data.live && data.live[acr];
    const dd = data.daily[acr];
    const price = (lv && lv.price) || (stockByAcr(acr) || {}).price || 0;
    const out = { acr, price, ch24: lv && lv.p24 ? price / lv.p24 - 1 : null, ch7: lv && lv.p7 ? price / lv.p7 - 1 : null, flow7: lv && lv.s7 ? lv.shares / lv.s7 - 1 : null };
    if (!dd || dd.close.length < SWING_N + 5 || !price) return out;
    const r = rangeOf(dd.close, SWING_N);
    out.lo = r.lo;
    out.hi = r.hi;
    out.pos = r.hi > r.lo ? (price - r.lo) / (r.hi - r.lo) : 0.5;
    out.zone = out.pos < SWING_LO ? "buy" : out.pos > SWING_HI ? "sell" : "mid";
    out.ch30 = dd.close.length > 30 ? price / dd.close[dd.close.length - 30] - 1 : null;
    out.rec = swingTest(dd.close);
    out.works = !!(out.rec && out.rec.trades >= 3 && out.rec.ret > 0 && out.rec.wins / out.rec.trades >= 0.7);
    return out;
  }

  // How far the price usually kept going after entering a zone last year, before turning around.
  // Buy zone: the lowest close before it reached the sell zone (or 30 days). Sell zone: the highest close.
  const overMemo = new Map(); // acr|zone|history time -> result
  function overshoot(acr, zone) {
    const dd = data.daily[acr];
    if (!dd || dd.close.length < SWING_N + 60) return null;
    const key = `${acr}|${zone}|${dd.t}`;
    if (overMemo.has(key)) return overMemo.get(key);
    const x = dd.close;
    const sig = swingSignals(x);
    const other = zone === "buy" ? "sell" : "buy";
    const moves = [];
    for (let i = Math.max(SWING_N + 1, x.length - 365); i < x.length - 1; i++) {
      if (sig[i] !== zone || sig[i - 1] === zone) continue; // the day it entered the zone
      let ext = x[i];
      for (let j = i + 1; j < Math.min(x.length, i + 31) && sig[j] !== other; j++) ext = zone === "buy" ? Math.min(ext, x[j]) : Math.max(ext, x[j]);
      moves.push(ext / x[i] - 1);
    }
    const res = moves.length >= 3 ? { usual: pctl(moves, 0.5), worst: zone === "buy" ? Math.min(...moves) : Math.max(...moves), n: moves.length } : null;
    overMemo.set(key, res);
    return res;
  }
  // One line: where the price could still go from here, in prices.
  function overshootLine(acr, zone, px) {
    const o = overshoot(acr, zone);
    if (!o || !px) return "";
    return zone === "buy"
      ? `It could still drop: last year it usually went down to about ${price(px * (1 + o.usual))} (lowest ${price(px * (1 + o.worst))}) before bouncing.`
      : `It could still rise: last year it usually went up to about ${price(px * (1 + o.usual))} (highest ${price(px * (1 + o.worst))}) before falling.`;
  }

  function verdict(g) {
    if (g.zone == null) return { cls: "even", icon: "⚪", short: "no data", text: "Price history isn't loaded yet." };
    const rec = g.rec;
    const record = rec && rec.trades ? `This rule won ${rec.wins} of ${rec.trades} trades on ${g.acr} in the last year.` : "";
    const warn = g.zone === "buy" || g.zone === "sell" ? overshootLine(g.acr, g.zone, g.price) : "";
    const v = verdictBase(g, record);
    if (warn) v.warn = warn;
    return v;
  }
  function verdictBase(g, record) {
    if (g.zone === "buy")
      return g.works
        ? { cls: "good", icon: "🟢", short: "buy zone", text: `Price is near its 20-day low (${price(g.lo)}). ${record}` }
        : { cls: "even", icon: "🟡", short: "low, weak record", text: `Price is near its 20-day low, but the swing rule hasn't worked well on ${g.acr} lately. ${record}` };
    if (g.zone === "sell")
      return { cls: "bad", icon: "🔴", short: "sell zone", text: `Price is near its 20-day high (${price(g.hi)}). A good time to sell swing shares (not your benefit blocks).` };
    const where = g.pos < 0.35 ? "in the lower part" : g.pos > 0.65 ? "in the upper part" : "in the middle";
    return { cls: "even", icon: "⚪", short: "wait", text: `Price is ${where} of its 20-day range. Swing buyers wait for ${price(g.lo + (g.hi - g.lo) * SWING_LO)} or lower.` };
  }

  // ---------------------------------------------------------------- strategy scorecard
  // Replays a rule on closing prices from day `start`: decide(i) says "buy", "sell" or nothing.
  // All-in, long only (Torn has no short selling), the 0.1% fee on every sale.
  function replay(closes, start, decide) {
    let cash = 1, sh = 0, entry = 0;
    const trades = [];
    for (let i = start; i < closes.length; i++) {
      const a = decide(i);
      if (a === "buy" && !sh) {
        sh = cash / closes[i];
        cash = 0;
        entry = closes[i];
      } else if (a === "sell" && sh) {
        cash = sh * closes[i] * (1 - SELL_FEE);
        trades.push((closes[i] * (1 - SELL_FEE)) / entry - 1);
        sh = 0;
      }
    }
    if (sh) cash = sh * closes[closes.length - 1] * (1 - SELL_FEE);
    return { ret: cash - 1, trades: trades.length, wins: trades.filter((t) => t > 0).length, open: !!sh };
  }
  function smaAt(x, n, i) {
    if (i < n - 1) return null;
    let t = 0;
    for (let k = i - n + 1; k <= i; k++) t += x[k];
    return t / n;
  }
  function rsiSeries(x, n = 14) {
    const out = new Array(x.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i < x.length; i++) {
      const ch = x[i] - x[i - 1];
      const up = Math.max(ch, 0), dn = Math.max(-ch, 0);
      if (i <= n) {
        g += up / n;
        l += dn / n;
      } else {
        g = (g * (n - 1) + up) / n;
        l = (l * (n - 1) + dn) / n;
      }
      if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  const rangeRule = (x, n) => (i) => {
    if (i < n) return null;
    const w = x.slice(i - n, i);
    const lo = Math.min(...w), hi = Math.max(...w);
    if (hi <= lo) return null;
    const p = (x[i] - lo) / (hi - lo);
    return p < SWING_LO ? "buy" : p > SWING_HI ? "sell" : null;
  };
  const rsiRule = (x) => {
    const r = rsiSeries(x);
    return (i) => (r[i] == null ? null : r[i] < 30 ? "buy" : r[i] > 70 ? "sell" : null);
  };
  const METHODS = [
    { name: "Swing, 20 days", how: "Buy in the bottom 10% of the last 20 days' price range, sell in the top 10%. (The Trade tab's signal.)", make: (x) => rangeRule(x, 20) },
    { name: "Fast swing, 10 days", how: "The same with the last 10 days: more trades, smaller moves.", make: (x) => rangeRule(x, 10) },
    { name: "Dip buying (RSI)", how: "Buy when RSI(14) drops below 30 (the price fell fast), sell when it goes above 70.", make: rsiRule },
    { name: "Trend following", how: "Buy when the 20-day average price crosses above the 100-day average, sell when it crosses back below.",
      make: (x) => (i) => {
        const a = smaAt(x, 20, i), b = smaAt(x, 100, i), a0 = smaAt(x, 20, i - 1), b0 = smaAt(x, 100, i - 1);
        if (a == null || b == null || a0 == null || b0 == null) return null;
        return a > b && a0 <= b0 ? "buy" : a < b && a0 >= b0 ? "sell" : null;
      } },
  ];

  // Every method on the last year of one stock's daily prices, next to just holding and the bank.
  function scorecard(acr) {
    const dd = data.daily[acr];
    if (!dd || dd.close.length < 120) return null;
    const x = dd.close;
    const start = Math.max(0, x.length - 365);
    const days = x.length - start;
    const rows = METHODS.map((m) => Object.assign({ name: m.name, how: m.how }, replay(x, start, m.make(x))));
    const hold = (x[x.length - 1] * (1 - SELL_FEE)) / x[start] - 1;
    const bank = (bankApr() / 100) * (days / 365);
    return { rows, hold, bank, days };
  }

  // Day trading test: the same ideas on hourly prices (about the last 6 weeks).
  async function dayTradeTest(acr) {
    const d = await tornsy(`/${acr.toLowerCase()}?interval=h1&limit=1000`, 30 * MIN);
    const x = (d.data || []).filter((r) => r && r.length >= 5).map((r) => +r[4]);
    if (x.length < 100) return null;
    const rows = [
      Object.assign({ name: "Hourly swing, 24 hours" }, replay(x, 24, rangeRule(x, 24))),
      Object.assign({ name: "Hourly dip buying (RSI)" }, replay(x, 15, rsiRule(x))),
    ];
    return { rows, hold: (x[x.length - 1] * (1 - SELL_FEE)) / x[24] - 1, days: Math.round(x.length / 24) };
  }

  // ---------------------------------------------------------------- practice account
  // Fake money to try trading without risk. Buys and sells at the live price, with the real 0.1% fee.
  const PAPER_START = 1e9;
  const paperNew = (start = PAPER_START) => ({ cash: start, start, pos: {}, log: [], since: Date.now() });
  let paper = Object.assign(paperNew(), store.get("paper", {}));
  const savePaper = () => store.set("paper", paper);
  const livePrice = (acr) => (data.live && data.live[acr] && data.live[acr].price) || (stockByAcr(acr) || {}).price || 0;
  function paperValue() {
    let v = paper.cash;
    for (const [a, p] of Object.entries(paper.pos)) v += p.sh * (livePrice(a) || p.cost / p.sh) * (1 - SELL_FEE);
    return v;
  }
  function paperBuy(acr, dollars) {
    const px = livePrice(acr);
    if (!px) return "No price yet, try again in a moment.";
    const sh = Math.floor(Math.min(dollars, paper.cash) / px);
    if (sh < 1) return "Not enough practice cash.";
    const p = paper.pos[acr] || (paper.pos[acr] = { sh: 0, cost: 0 });
    p.sh += sh;
    p.cost += sh * px;
    paper.cash -= sh * px;
    paper.log.unshift({ t: Date.now(), acr, side: "buy", sh, px });
    paper.log = paper.log.slice(0, 50);
    savePaper();
    return `Bought ${commas(sh)} ${acr} at ${price(px)} (practice).`;
  }
  function paperSell(acr) {
    const p = paper.pos[acr];
    const px = livePrice(acr);
    if (!p || !p.sh) return "You have no practice shares of " + acr + ".";
    if (!px) return "No price yet, try again in a moment.";
    const got = p.sh * px * (1 - SELL_FEE);
    const pl = got - p.cost;
    paper.cash += got;
    paper.log.unshift({ t: Date.now(), acr, side: "sell", sh: p.sh, px, pl });
    paper.log = paper.log.slice(0, 50);
    delete paper.pos[acr];
    savePaper();
    return `Sold ${commas(got / px / (1 - SELL_FEE))} ${acr} at ${price(px)}: ${pl >= 0 ? "profit" : "loss"} ${money(Math.abs(pl))} (practice).`;
  }

  // ---------------------------------------------------------------- money compare
  const PERIODS = [["1w", "1 week", 7], ["1m", "1 month", 30], ["3m", "3 months", 91], ["1y", "1 year", 365]];
  const pctl = (arr, q) => {
    const a = [...arr].sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))] : 0;
  };
  // Swing-rule signal for every day: "buy" in the bottom 10% of the previous 20 days, "sell" in the top 10%.
  function swingSignals(x) {
    const out = new Array(x.length).fill(null);
    for (let i = SWING_N; i < x.length; i++) out[i] = rangeRule(x, SWING_N)(i);
    return out;
  }
  // What the swing rule made in every `days`-long stretch of the last year. `fromBuy` keeps only stretches that
  // started in the buy zone, which is the situation you'd be in if you started today.
  function swingStretches(acr, days, fromBuy) {
    const dd = data.daily[acr];
    if (!dd || dd.close.length < SWING_N + days + 30) return [];
    const x = dd.close;
    const sig = swingSignals(x);
    const out = [];
    for (let st = Math.max(SWING_N, x.length - 365 - days); st + days < x.length; st++) {
      if (fromBuy && sig[st] !== "buy") continue;
      let cash = 1, sh = 0;
      for (let i = st; i <= st + days; i++) {
        if (sig[i] === "buy" && !sh) {
          sh = cash / x[i];
          cash = 0;
        } else if (sig[i] === "sell" && sh) {
          cash = sh * x[i] * (1 - SELL_FEE);
          sh = 0;
        }
      }
      if (sh) cash = sh * x[st + days] * (1 - SELL_FEE);
      out.push(cash - 1);
    }
    return out;
  }
  // Buy-and-hold over every `days`-long stretch of the last year, for every stock.
  function holdStretches(days) {
    const out = [];
    for (const dd of Object.values(data.daily)) {
      const x = dd && dd.close;
      if (!x || x.length < days + 30) continue;
      for (let st = Math.max(0, x.length - 365 - days); st + days < x.length; st += 2) out.push((x[st + days] * (1 - SELL_FEE)) / x[st] - 1);
    }
    return out;
  }
  // The best swing stock right now: in the buy zone, with the best typical result from that point.
  function bestSwing(days) {
    let best = null;
    bestSwing.why = "zone";
    for (const acr of Object.keys(data.daily)) {
      const g = signal(acr);
      if (g.zone !== "buy") continue;
      bestSwing.why = "history";
      let r = swingStretches(acr, days, true);
      if (r.length < 5) r = swingStretches(acr, days, false);
      if (r.length < 5) continue;
      const c = { acr, mid: pctl(r, 0.5), lo: pctl(r, 0.1), hi: pctl(r, 0.9), n: r.length, g };
      if (!best || c.mid > best.mid) best = c;
    }
    return best;
  }
  // Blocks worth more than the bank (plus any money over the bank's limit), and what they pay out within `days`.
  function blocksOver(amount, days) {
    if (!data.market) return null;
    const p = plan(amount);
    if (!p.picks.length) return { p, gain: 0 };
    let pay = 0;
    for (const x of p.picks) pay += x.s.type === "passive" ? (x.perYear * days) / 365 : Math.floor(days / x.s.freq) * x.pv.value;
    const b = bankOver(p.left, days);
    return { p, pay, bank: b, gain: pay + (b ? b.gain : 0) };
  }
  // The cheapest first block that beats the bank, for when you can't afford one yet.
  function cheapestGoodBlock(amount) {
    const bank = bankApr() / 100;
    let best = null;
    for (const st of data.market || []) {
      if (!st.req || st.type === "passive" || blocksHeld(owned(st.id), st.req) > 0) continue;
      const x = steps(st, 1)[0];
      if (!x || !(x.roi > 0) || (bank && x.roi <= bank) || x.cost <= amount) continue;
      if (!best || x.cost < best.cost) best = x;
    }
    return best;
  }

  // ---------------------------------------------------------------- trade plan
  // Typical daily move (standard deviation of daily changes) over the last 60 days.
  function dailyVol(acr, n = 60) {
    const x = data.daily[acr] && data.daily[acr].close;
    if (!x || x.length < n + 1) return null;
    const r = [];
    for (let i = x.length - n; i < x.length; i++) r.push(x[i] / x[i - 1] - 1);
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length);
  }

  // Shares, target, stop-loss and what each would mean, for a swing trade of `amount` dollars.
  function tradePlan(acr, amount) {
    const g = signal(acr);
    if (g.lo == null || !g.price) return null;
    const vol = dailyVol(acr) || 0.005;
    const sh = Math.floor(amount / g.price);
    const target = g.lo + (g.hi - g.lo) * SWING_HI;
    const stop = Math.min(g.lo, g.price) * (1 - 2 * vol);
    const cost = sh * g.price;
    const win = sh * target * (1 - SELL_FEE) - cost;
    const loss = sh * stop * (1 - SELL_FEE) - cost;
    return { g, sh, cost, target, stop, win, loss, be: g.price / (1 - SELL_FEE), ratio: loss < 0 ? win / -loss : 0, vol };
  }

  // ---------------------------------------------------------------- alerts
  // Checked once a minute while any Torn page is open (one tab does the checking). Nothing runs when Torn is closed.
  const MON_EVERY = 60 * 1000;
  const alertCount = () => Object.keys(S.alerts).length;
  function notify(acr, text, tags) {
    sendNtfy(text, { title: `Torn Stock Geek: ${acr}`, tags: tags || "bell", priority: 4 });
    S.inbox.unshift({ t: Date.now(), acr, text, seen: false });
    S.inbox = S.inbox.slice(0, 20);
    save();
    showBanner(acr, text);
    badge();
    if (S.vibrate && navigator.vibrate) {
      try {
        navigator.vibrate([200, 100, 200]);
      } catch {}
    }
  }
  let bannerT = 0;
  function showBanner(acr, text) {
    const b = $(".banner");
    b.innerHTML = `<span>🔔 ${esc(text)}</span><button class="ib sm" data-act="bannerclose">✕</button>`;
    b.dataset.acr = acr;
    b.hidden = false;
    clearTimeout(bannerT);
    bannerT = setTimeout(() => (b.hidden = true), 12000);
  }
  function badge() {
    const n = S.inbox.filter((x) => !x.seen).length;
    const el = $(".fab-badge");
    el.textContent = n > 9 ? "9+" : n;
    el.hidden = !n;
  }

  async function monitor() {
    // Only one Torn tab checks, so alerts don't go off twice.
    const lock = store.get("mon", 0);
    if (Date.now() - lock < MON_EVERY - 5000 && store.get("monTab", "") !== TAB_ID) return;
    store.set("mon", Date.now());
    store.set("monTab", TAB_ID);
    Object.assign(S, { alerts: store.get("settings", {}).alerts || S.alerts }); // pick up changes made in other tabs
    if (S.alertsOn && alertCount()) {
      await loadLive();
      let changed = false;
      for (const [acr, a] of Object.entries(S.alerts)) {
        const px = livePrice(acr);
        if (!px) continue;
        if (a.above && px >= a.above) {
          notify(acr, `${acr} is ${price(px)}, above your ${price(a.above)}.`);
          a.above = 0;
          changed = true;
        }
        if (a.below && px <= a.below) {
          notify(acr, `${acr} is ${price(px)}, below your ${price(a.below)}.`);
          a.below = 0;
          changed = true;
        }
        if (a.zone) {
          const c = data.daily[acr] || store.get("d_" + acr, null);
          if (!c || Date.now() - c.t > DAILY_TTL) await loadDaily(acr);
          else data.daily[acr] = c;
          const z = signal(acr).zone;
          if (z && z !== a.last) {
            if (z === "buy") notify(acr, `${acr} entered the buy zone (${price(px)}). ${overshootLine(acr, "buy", px)}`.trim(), "green_circle");
            if (z === "sell") notify(acr, `${acr} entered the sell zone (${price(px)}). ${overshootLine(acr, "sell", px)}`.trim(), "red_circle");
            a.last = z;
            changed = true;
          }
        }
        if (!a.above && !a.below && !a.zone) {
          delete S.alerts[acr];
          changed = true;
        }
      }
      if (changed) save();
    }
    // Payouts ready to collect, checked every 10 minutes (needs a Limited key).
    if (S.alertsOn && S.payoutAlert && apiKey() && Date.now() - store.get("payChk", 0) > 10 * MIN) {
      store.set("payChk", Date.now());
      await Promise.all([loadMarket(), loadMine()]);
      const told = store.get("payTold", {});
      const day = new Date().toISOString().slice(0, 10);
      for (const h of Object.values(data.mine || {})) {
        const st = (data.market || []).find((x) => x.id === h.id);
        if (!st || !h.payout || !h.payout.ready || st.type !== "active") continue;
        if (told[st.acr] === day) continue;
        told[st.acr] = day;
        notify(st.acr, `${st.acr} payout is ready to collect on the stock market page.`, "moneybag");
      }
      store.set("payTold", told);
    }
  }
  const TAB_ID = Math.random().toString(36).slice(2);

  // ---------------------------------------------------------------- stock page helper
  // On Torn's stock market page, adds a small row under the shares box of an open BUY/SELL panel.
  // Tapping one of its buttons only types a number into Torn's box. You still press BUY/SELL and confirm.
  const isStocksPage = () => /sid=stocks/.test(location.href);
  function acrFromRow(el) {
    const row = el.closest('ul[class*="stock___"]') || el.closest('[class*="stock___"]');
    if (!row) return "";
    const img = row.querySelector('img[src*="logos/"]');
    const m = img && (img.getAttribute("src") || "").match(/logos\/([A-Za-z]{2,4})\./);
    if (m) return m[1].toUpperCase();
    const t = row.querySelector("[data-acronym]");
    return t ? String(t.getAttribute("data-acronym")).toUpperCase() : "";
  }
  function sideOf(input) {
    let el = input.parentElement;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      const btn = [...el.querySelectorAll("button")].find((b) => /^(buy|sell)$/i.test((b.textContent || "").trim()));
      if (btn) return btn.textContent.trim().toLowerCase();
    }
    return "";
  }
  // "Buy on Torn" remembers what you planned, so the stock page can point at it. It expires after 15 minutes.
  const INTENT_TTL = 15 * MIN;
  function buyIntent() {
    const i = store.get("buyIntent", null);
    return i && Date.now() - i.t < INTENT_TTL ? i : null;
  }

  function fillChoices(acr, side) {
    const st = stockByAcr(acr);
    const px = livePrice(acr);
    const out = [];
    const intent = buyIntent();
    if (intent && intent.acr === acr && side !== "sell") out.push(["🛒 Your plan", intent.n, true]);
    if (!px) return out;
    const have = st ? owned(st.id) : 0;
    const held = st ? blocksHeld(have, st.req) : 0;
    if (side !== "sell") {
      const planSh = Math.floor(S.planAmt / px);
      if (planSh > 0 && !(intent && intent.acr === acr && intent.n === planSh)) out.push([`Plan ${money(S.planAmt)}`, planSh]);
      if (st && st.req) {
        const next = st.type === "passive" ? (held ? 0 : st.req - have) : sharesFor(st.req, held + 1) - have;
        if (next > 0) out.push([st.type === "passive" ? "For the perk" : `For block ${held + 1}`, next]);
      }
    }
    if (side !== "buy" && have) {
      const keep = st ? (st.type === "passive" ? (held ? st.req : 0) : sharesFor(st.req, held)) : 0;
      if (have - keep > 0) out.push([held ? "All but blocks" : "All", have - keep]);
    }
    return out;
  }
  function setReactValue(input, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function scanStockPage() {
    const inputs = document.querySelectorAll('input.input-money:not([type="hidden"]), input[data-testid="legacy-money-input"]:not([type="hidden"])');
    for (const input of inputs) {
      if (input.closest(".tsg-fill")) continue;
      const box = input.parentElement && input.parentElement.parentElement ? input.parentElement.parentElement : input.parentElement;
      if (!box || box.querySelector(":scope > .tsg-fill") || (box.nextElementSibling && box.nextElementSibling.classList.contains("tsg-fill"))) continue;
      const acr = acrFromRow(input);
      if (!acr) continue;
      const side = sideOf(input);
      const choices = fillChoices(acr, side);
      if (!choices.length) continue;
      const row = document.createElement("div");
      row.className = "tsg-fill";
      row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0;font:12px Arial,sans-serif;color:#9aa3ad";
      row.innerHTML =
        `<span>📈 Fill shares:</span>` +
        choices
          .map(([l, n, big]) =>
            big
              ? `<button type="button" data-n="${n}" data-plan="1" style="border:0;background:#7fdc6f;color:#0b260f;border-radius:9px;padding:8px 12px;font:bold 14px Arial,sans-serif;cursor:pointer">${esc(l)}: Fill ${commas(n)} shares</button>`
              : `<button type="button" data-n="${n}" style="border:1px solid #74c0fc;background:transparent;color:#74c0fc;border-radius:8px;padding:3px 8px;font:12px Arial,sans-serif;cursor:pointer">${esc(l)}: ${commas(n)}</button>`
          )
          .join("");
      row.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-n]");
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        // Torn re-renders its box often, so find the live one again.
        const live = (row.parentElement && row.parentElement.querySelector('input.input-money:not([type="hidden"]), input[data-testid="legacy-money-input"]:not([type="hidden"])')) || input;
        setReactValue(live, b.dataset.n);
        live.focus();
        if (b.dataset.plan) {
          store.set("buyIntent", null);
          document.querySelectorAll(".tsg-guide").forEach((g) => (g.textContent = "✓ Filled. Now press Torn's BUY and confirm."));
        }
      });
      box.parentNode.insertBefore(row, box.nextSibling);
    }
  }
  // Scrolls to the stock you chose with "Buy on Torn", outlines it and says what to tap next.
  function highlightIntent() {
    const intent = buyIntent();
    if (!intent) return;
    let tries = 0;
    const timer = setInterval(() => {
      const row = [...document.querySelectorAll('ul[class*="stock___"]')].find((u) => acrFromRow(u) === intent.acr);
      if (!row && ++tries < 40) return;
      clearInterval(timer);
      if (!row) return;
      row.style.outline = "3px solid #7fdc6f";
      row.style.outlineOffset = "2px";
      row.style.borderRadius = "6px";
      if (!row.parentNode.querySelector(".tsg-guide")) {
        const g = document.createElement("div");
        g.className = "tsg-guide";
        g.style.cssText = "margin:6px 0;padding:8px 10px;border-radius:8px;background:#26292d;color:#e9ecef;border:1px solid #7fdc6f;font:13px Arial,sans-serif";
        g.textContent = `🛒 Torn Stock Geek: open ${intent.acr}'s BUY panel, then tap the green “Your plan: Fill ${commas(intent.n)} shares” under Torn's box. You press BUY and confirm.`;
        row.parentNode.insertBefore(g, row);
      }
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 500);
  }

  function stockPageHelper() {
    if (!isStocksPage()) return;
    highlightIntent();
    if (apiKey()) loadAll(false).then(scanStockPage);
    else loadLive().then(scanStockPage);
    let t = 0;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(scanStockPage, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- formatting
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const commas = (n) => Math.round(n).toLocaleString("en-US");
  function money(n) {
    if (!isFinite(n)) return "—";
    const a = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (a >= 999.5e6) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}b`;
    if (a >= 999.5e3) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
    return `${sign}$${a.toFixed(a < 10 ? 2 : 0)}`;
  }
  const price = (n) => "$" + (+n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctTxt = (r, d = 1) => (isFinite(r) && r != null ? (r * 100).toFixed(d) + "%" : "—");
  const signPct = (r, d = 1) => (r == null || !isFinite(r) ? "—" : (r > 0 ? "+" : "") + pctTxt(r, d));
  const chg = (r, d = 1) => (r == null ? `<span class="muted">—</span>` : `<span class="${r > 0 ? "g" : r < 0 ? "r" : "muted"}">${signPct(r, d)}</span>`);
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
    const bank = bankApr() / 100;
    if (!roi) return "even";
    if (bank) return roi > bank ? "good" : "bad";
    return roi >= 0.15 ? "good" : roi >= 0.05 ? "even" : "bad";
  };
  const stockLink = (acr, label) => `<button class="link nm" data-act="stock" data-acr="${esc(acr)}">${label || esc(acr)}</button>`;

  // ---------------------------------------------------------------- UI shell
  const host = document.createElement("div");
  host.id = "torn-stock-geek";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="fab" data-act="toggle" title="Torn Stock Geek (drag to move)"><span>📈</span><span class="fab-badge" hidden></span></button>
    <div class="banner" hidden role="alert" data-act="banner"></div>
    <div class="scrim" data-act="close" hidden></div>
    <section class="panel" hidden role="dialog" aria-label="Torn Stock Geek">
      <header class="top">
        <button class="ib" data-act="back" title="Back" hidden>‹</button>
        <div class="title">Torn Stock Geek</div>
        <button class="ib" data-act="refresh" title="Refresh">⟳</button>
        <button class="ib" data-act="tab" data-tab="settings" title="Settings">⚙</button>
        <button class="ib" data-act="close" title="Close">✕</button>
      </header>
      <nav class="tabs">
        <button class="tab" data-act="tab" data-tab="advisor">Advisor</button>
        <button class="tab" data-act="tab" data-tab="planner">Money</button>
        <button class="tab" data-act="tab" data-tab="trade">Trade</button>
        <button class="tab" data-act="tab" data-tab="portfolio">Mine</button>
      </nav>
      <div class="body"></div>
    </section>
    <div class="toast" hidden></div>`;
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const body = () => $(".body");

  const view = { acr: "", from: "advisor" }; // the stock page and the tab it was opened from

  let autoT = 0;
  let loading = false;
  function open() {
    if (S.inbox.some((x) => !x.seen)) {
      S.inbox.forEach((x) => (x.seen = true));
      save();
      badge();
    }
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
    if (loading) return;
    if (!apiKey()) {
      // The Trade tab works without a key (Tornsy needs none).
      await loadLive(force);
      return redraw();
    }
    loading = true;
    $("[data-act=refresh]").classList.add("spinning");
    if (!quiet) render();
    await loadAll(force);
    loading = false;
    $("[data-act=refresh]").classList.remove("spinning");
    redraw();
  }

  // Redraw after new data, but never under someone's fingers while they type.
  function redraw() {
    if (!isOpen()) return;
    const typing = root.activeElement && root.activeElement.tagName === "INPUT";
    if (typing && S.tab === "planner") return renderPlan();
    if (typing) return;
    render();
  }

  const TITLES = { settings: "Settings" };
  function render() {
    const onStock = S.tab === "stock" || S.tab === "practice";
    $$(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    $(".tabs").hidden = S.tab === "settings" || onStock;
    $("[data-act=back]").hidden = !onStock;
    $(".title").textContent =
      S.tab === "practice" ? "🎮 Practice account" : onStock ? `${view.acr} ${(stockByAcr(view.acr) || (data.live && data.live[view.acr]) || {}).name || ""}` : TITLES[S.tab] || "Torn Stock Geek";
    const scroll = body().scrollTop;
    if (!apiKey() && !["settings", "trade", "stock", "practice"].includes(S.tab)) renderNoKey();
    else ({ advisor: renderAdvisor, planner: renderPlanner, trade: renderTrade, portfolio: renderPortfolio, settings: renderSettings, stock: renderStock, practice: renderPractice })[S.tab]();
    body().scrollTop = scroll;
  }

  const SUB = ["settings", "stock", "practice"]; // pages with a back button instead of tabs
  function go(tab) {
    if (tab === "stock" || tab === "practice") {
      if (!SUB.includes(S.tab)) view.from = S.tab;
      if (S.tab === "practice" && tab === "stock") view.back = "practice";
      else if (tab === "stock") view.back = "";
    }
    S.tab = tab;
    if (!SUB.includes(tab)) save();
    render();
    body().scrollTop = 0;
  }

  function renderNoKey() {
    body().innerHTML = `<div class="card">
      <b>Add your Torn API key to start</b>
      <p class="muted">On Torn PDA this happens by itself. In Tampermonkey, open ⚙ Settings and paste a key.
      A <b>Limited</b> key lets the Mine tab see your shares; a Public key gives the market advice.</p>
      <button class="btn" data-act="tab" data-tab="settings">Open settings</button></div>
      <p class="muted small">The <b>Trade</b> tab (charts and signals) works without a key.</p>
      ${foot()}`;
  }

  const foot = () =>
    `<p class="foot muted">Advice only: Torn Stock Geek never buys or sells. Prices change every minute and returns aren't guaranteed.<br>Torn Stock Geek v${VERSION}</p>`;

  function status() {
    const parts = [];
    if (data.marketAt) parts.push(`Prices ${ago(data.marketAt)}`);
    const b = bankRate();
    parts.push(b.apr ? `Bank ${b.apr}%/yr <button class="link" data-act="tab" data-tab="settings">change</button>` : `<button class="link" data-act="tab" data-tab="settings">Set your bank rate</button>`);
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
    const bank = bankApr();
    const payback = x.roi > 0 ? Math.round(365 / x.roi) : 0;
    return `<div class="card" data-acr="${esc(s.acr)}">
      <div class="crow">
        <div class="grow">${stockLink(s.acr, `<b class="acr">${esc(s.acr)}</b>`)} <span class="muted">${esc(s.name)}</span>
          <small class="muted">${price(s.price)} · pays every ${s.freq} days${held ? ` · you have ${held} block${held > 1 ? "s" : ""}` : ""}</small></div>
        <span class="pill ${roiClass(x.roi)}">${x.roi > 0 ? pctTxt(x.roi) + "/yr" : "?"}</span>
      </div>
      <div class="line">${ordinal(x.block)} block: <b>+${shares(x.need)}</b> shares · <b>${money(x.cost)}</b>${x.partial ? ` <span class="muted">(you already have ${shares(have - sharesFor(s.req, held))} toward it)</span>` : ""}</div>
      <div class="line muted">Pays ${esc(x.pv.how)}${x.pv.ok ? `${x.pv.cash ? "" : ` ≈ ${money(x.pv.value)}`} → <b class="tx">${money(x.perYear)}/yr</b>` : ""}
        <button class="link" data-act="setval" data-acr="${esc(s.acr)}">${x.pv.custom ? "Edit value" : x.pv.ok ? "Change" : "Set value"}</button></div>
      ${x.roi > 0 ? `<div class="line">Pays for itself in <b>${commas(payback)} days</b>${bank ? (x.roi * 100 > bank ? ` · <span class="g">beats bank (${bank}%)</span>` : ` · <span class="r">bank pays more (${bank}%)</span>`) : ""}</div>` : ""}
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
        <div class="grow">${stockLink(s.acr, `<b class="acr">${esc(s.acr)}</b>`)} <span class="muted">${esc(s.name)}</span>
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
        <label class="field">💰 How much can you invest now?
          <input class="budget" inputmode="decimal" placeholder="e.g. 20m or 2.5b" value="${S.budget ? esc(money(S.budget).replace("$", "")) : ""}" autocomplete="off"></label>
        <div class="sorts slim">${PERIODS.map(([k, l]) => `<button class="seg ${S.period === k ? "on" : ""}" data-act="period" data-k="${k}">${l}</button>`).join("")}</div>
        <div class="plan"></div>
        ${vaultHtml()}
        ${foot()}`;
      const inp = $(".budget");
      inp.addEventListener("input", () => {
        S.budget = parseMoney(inp.value);
        save();
        renderPlan();
      });
      renderPlan();
      // The swing and holding estimates need every stock's daily history.
      const acrs = Object.keys(data.live || {}).filter((a) => a !== "TCSE");
      acrs.forEach((a) => {
        if (!data.daily[a]) {
          const c = store.get("d_" + a, null);
          if (c) data.daily[a] = c;
        }
      });
      const stale = !acrs.length || acrs.some((a) => !data.daily[a] || Date.now() - data.daily[a].t > DAILY_TTL);
      if (stale && !data.dailyLoading) (data.live ? Promise.resolve() : loadLive()).then(() => loadAllDaily(() => S.tab === "planner" && !data.dailyLoading && renderPlan()));
    });
  }

  // Where to park cash so it can't be mugged: the calmest stocks lately.
  function vaultHtml() {
    const acrs = (data.market || []).map((s) => s.acr);
    acrs.forEach((a) => {
      if (!data.daily[a]) {
        const c = store.get("d_" + a, null);
        if (c) data.daily[a] = c;
      }
    });
    const vols = acrs.map((a) => ({ a, v: dailyVol(a), s: stockByAcr(a) })).filter((x) => x.v != null);
    const have = vols.length;
    const calm = vols
      .sort((x, y) => x.v - y.v)
      .slice(0, 5);
    const amt = S.budget || 1e9;
    return `<h3>🛡 Park cash safely</h3>
      <p class="muted small">Cash in hand can be mugged; shares can't. Selling takes seconds and costs 0.1% (${money(amt * SELL_FEE)} on ${money(amt)}). Calm stocks move least while your money sits there:</p>
      ${calm.length < 5 || have < acrs.length * 0.8 ? `<button class="btn ghost" data-act="loadhist">Load price history for all stocks</button>` : ""}
      ${calm.length ? `<div class="list">${calm.map((x) => `<button class="row" data-act="stock" data-acr="${esc(x.a)}"><span class="nm"><b>${esc(x.a)}</b><small>${esc(x.s ? x.s.name : "")}</small></span>
          <span class="mid small muted">typical day ±${pctTxt(x.v, 2)} · a bad week about ${pctTxt(-x.v * Math.sqrt(5) * 2, 1)}</span></button>`).join("")}</div>`
        : ""}
      <p class="muted small">Tip: parking in a stock you're building a block in does two jobs at once.</p>`;
  }

  // Everything your money could do over the chosen period, each with the WHOLE amount, best first.
  function renderPlan() {
    const box = $(".plan");
    if (!box || !data.market) return;
    const A = S.budget;
    const [, plabel, days] = PERIODS.find((x) => x[0] === S.period) || PERIODS[2];
    if (!A) {
      box.innerHTML = `<p class="muted">Type an amount (like <b>20m</b>) and pick a period. You'll see what the whole amount would earn in the bank, in benefit blocks, swing trading or just holding a stock, with the best one on top.</p>`;
      return;
    }
    const loadingHist = data.dailyLoading || !Object.keys(data.daily).length;
    const bank = bankOver(A, days);
    const blocks = blocksOver(A, days);
    const sw = loadingHist ? null : bestSwing(days);
    const hold = loadingHist ? [] : holdStretches(days);
    const opts = [];
    if (bank)
      opts.push({ key: "bank", safe: true, gain: bank.gain, title: `🏦 Put ${A > BANK_LIMIT ? money(BANK_LIMIT) : `all ${money(A)}`} in the bank`,
        sub: `${bank.term ? `${bank.term} term${bank.times > 1 ? ` × ${bank.times}` : ""}, ` : ""}${bank.apr}%/yr · no risk, money locked${A > BANK_LIMIT ? ` · one investment takes at most ${money(BANK_LIMIT)}` : ""}` });
    // Blocks only count as their own option when they beat the bank; then the rest of the money goes to the bank.
    if (blocks && blocks.p.picks.length && (!bank || blocks.gain > bank.gain)) {
      const p = blocks.p;
      const names = p.picks.map((x) => `${x.s.acr}${x.block > 1 ? " #" + x.block : ""}`).join(", ");
      opts.push({ key: "blocks", safe: true, gain: blocks.gain,
        title: `🎯 Buy ${p.picks.length > 1 ? "blocks" : "the block"}: ${esc(names)}${p.left > 0 && bank ? ` + ${money(Math.min(p.left, BANK_LIMIT))} in the bank` : ""}`,
        sub: `payouts ${money(blocks.pay)}${blocks.bank && p.left > 0 ? ` + bank ${money(blocks.bank.gain)}` : ""} · share price can move`,
        more: `<details class="more"><summary>What to buy</summary><ol class="steps">${p.picks.map((x) => `<li>Buy <b>${shares(x.need)} ${esc(x.s.acr)}</b> (${money(x.cost)}) → ${ordinal(x.block)} ${x.s.type === "passive" ? "perk" : "block"} <span class="pill ${roiClass(x.roi)}">${pctTxt(x.roi)}/yr</span><small class="muted">${x.s.type === "passive" ? esc(x.s.desc) : `${esc(x.pv.how)} every ${x.s.freq} days`}</small></li>`).join("")}</ol></details>` });
    }
    if (sw)
      opts.push({ key: "swing", gain: A * sw.mid, lo: A * sw.lo, hi: A * sw.hi, title: `📈 Swing trade ${esc(sw.acr)} (in the buy zone now)`,
        sub: `Buy at ${price(sw.g.lo + (sw.g.hi - sw.g.lo) * SWING_LO)} or lower · sell at about ${price(sw.g.lo + (sw.g.hi - sw.g.lo) * SWING_HI)}`,
        rangeLabel: `Profit last year in ${sw.n} similar cases`, acr: sw.acr });
    if (hold.length)
      opts.push({ key: "hold", gain: A * pctl(hold, 0.5), lo: A * pctl(hold, 0.1), hi: A * pctl(hold, 0.9), title: "📊 Just buy a stock and hold it", sub: `Any stock, held for ${plabel}`, rangeLabel: "Profit or loss last year" });
    opts.sort((a, b) => b.gain - a.gain);
    const best = opts[0];
    const short = !blocks || !blocks.p.picks.length ? cheapestGoodBlock(A) : null;
    const line = (o, isBest) => `<div class="opt ${isBest ? "best" : ""}">
        <div class="crow"><span class="grow">${isBest ? "✅ <b>Best:</b> " : ""}${o.title}</span>
          <b class="${o.gain > 0 ? "g" : o.gain < 0 ? "r" : ""}">${o.gain >= 0 ? "+" : ""}${money(o.gain)}</b></div>
        <div class="line small muted">${o.sub}${o.acr ? ` ${stockLink(o.acr, "chart ›")}` : ""}</div>
        ${o.lo != null ? `<div class="line small muted">${o.rangeLabel}: ${o.lo >= 0 ? "+" : ""}${money(o.lo)} to ${o.hi >= 0 ? "+" : ""}${money(o.hi)} (typical ${o.gain >= 0 ? "+" : ""}${money(o.gain)}) <span class="a">⚠ can lose</span></div>` : ""}
        ${o.key === "swing" && livePrice(o.acr) ? `<button class="btn small" data-act="buytorn" data-acr="${esc(o.acr)}" data-n="${Math.floor(A / livePrice(o.acr))}">🛒 Buy ${shares(Math.floor(A / livePrice(o.acr)))} ${esc(o.acr)} on Torn</button>` : ""}
        ${o.key === "swing" ? (S.alerts[o.acr] && S.alerts[o.acr].zone ? `<div class="line small g">🔔 Reminder on for ${esc(o.acr)}'s buy & sell zone ✓</div>` : `<button class="btn ghost small" data-act="zonealert" data-acr="${esc(o.acr)}">🔔 Remind me at buy & sell zone</button>`) : ""}
        ${o.more || ""}</div>`;
    box.innerHTML = `
      <p class="ptitle">${money(A)} over ${plabel}</p>
      ${best ? line(best, true) : `<p class="muted">No options yet.${data.bank || S.bankApr ? "" : " Set your bank rate in ⚙."}</p>`}
      ${opts.length > 1 ? `<p class="small muted">Compared with (all ${money(A)} in each):</p>${opts.slice(1).map((o) => line(o, false)).join("")}` : ""}
      ${!sw && !loadingHist ? `<div class="opt"><div class="line small muted">📈 Swing trade: ${bestSwing.why === "history" ? `not enough price history to estimate ${plabel}; try a shorter period.` : "no stock is in the buy zone right now. Swing traders wait (the Trade tab shows when one gets there)."}</div></div>` : ""}
      ${loadingHist ? `<div class="opt"><div class="line small muted"><span class="spin">⟳</span> Loading price history for the swing and holding estimates…</div></div>` : ""}
      ${short ? `<div class="opt"><div class="line small">🎯 Cheapest block that beats the bank: <b>${esc(short.s.acr)}</b> costs ${money(short.cost)}, <b>${money(short.cost - A)} more</b> than you have. Then ${esc(short.pv.how)} every ${short.s.freq} days (${pctTxt(short.roi)}/yr).</div><div class="bar"><i style="width:${Math.min(100, (A / short.cost) * 100).toFixed(0)}%"></i></div></div>` : ""}
      <div class="opt"><div class="line small muted">✖ Day trading (minutes or hours): ≈ $0 or less. Torn prices move about 0.05% in an hour, less than the 0.1% fee.</div></div>
      ${!bank ? `<p class="small muted">Bank: <button class="link" data-act="tab" data-tab="settings">set your rate</button> or add an API key to load Torn's rates.</p>` : ""}
      <p class="muted small">Estimates from last year's real prices and today's item values. Past results don't promise future ones.</p>`;
  }

  // ---------------------------------------------------------------- trade
  function renderTrade() {
    if (!data.live) {
      body().innerHTML = data.liveErr
        ? `<p class="err">Couldn't load prices from Tornsy: ${esc(data.liveErr.message)}</p><button class="btn" data-act="refresh">Try again</button>`
        : `<p class="muted center"><span class="spin">⟳</span> Loading prices…</p>`;
      if (!data.liveErr) loadLive().then(redraw);
      return;
    }
    const acrs = Object.keys(data.live).filter((a) => a !== "TCSE");
    // Use saved history straight away; fetch what's missing or old in the background.
    acrs.forEach((a) => {
      if (!data.daily[a]) {
        const c = store.get("d_" + a, null);
        if (c) data.daily[a] = c;
      }
    });
    const stale = acrs.some((a) => !data.daily[a] || Date.now() - data.daily[a].t > DAILY_TTL);
    if (stale && !data.dailyLoading) loadAllDaily(() => S.tab === "trade" && (data.dailyLoading ? updateProgress() : redraw()));
    const sigs = acrs.map(signal);
    const mineAcr = new Set((data.market || []).filter((s) => owned(s.id) > 0).map((s) => s.acr));
    const f = S.tradeFilter;
    const shown = sigs
      .filter((g) => f === "all" || (f === "buy" && g.zone === "buy") || (f === "sell" && g.zone === "sell") || (f === "mine" && mineAcr.has(g.acr)))
      .sort((a, b) =>
        S.tradeSort === "record"
          ? (b.rec ? b.rec.ret : -9) - (a.rec ? a.rec.ret : -9)
          : (a.pos ?? 2) - (b.pos ?? 2)
      );
    const nBuy = sigs.filter((g) => g.zone === "buy").length;
    const nSell = sigs.filter((g) => g.zone === "sell").length;
    const idx = data.live.TCSE;
    body().innerHTML = `
      <p class="status muted">Tornsy prices ${ago(data.liveAt)}${idx ? ` · Market index ${chg(idx.p24 ? idx.price / idx.p24 - 1 : null, 2)} today` : ""}</p>
      <details class="note"><summary>How these signals work</summary>
        <p>We tested trading methods on 5 years of real Torn prices, after the 0.1% sell fee:</p>
        <ul><li><b>Day trading</b> (minutes or hours) <span class="r">lost money on every stock</span>. Moves that short are smaller than the fee.</li>
        <li><b>Swing trading</b> over days (buy when the price is in the bottom 10% of its last 20 days' range, sell in the top 10%) <span class="g">beat holding on most stocks</span>, in every year we checked.</li></ul>
        <p>Each stock shows how the rule did on it in the last year. Past results don't promise future ones. Only swing with shares you don't need for a benefit block.</p></details>
      <button class="row practice-entry" data-act="practice"><span class="nm2">🎮 <b>Practice account</b><small>try trading with fake money</small></span>
        <span class="rt">${money(paperValue())}<small>${chg(paperValue() / paper.start - 1)}</small></span></button>
      <div class="sorts">
        ${[["all", "All"], ["buy", `Buy zone (${nBuy})`], ["sell", `Sell zone (${nSell})`], ["mine", "Mine"]].map(([k, l]) => `<button class="seg ${f === k ? "on" : ""}" data-act="filter" data-f="${k}">${l}</button>`).join("")}
      </div>
      <div class="sortby small muted">Sort: ${[["zone", "nearest buy zone"], ["record", "best swing record"]].map(([k, l]) => `<button class="link ${S.tradeSort === k ? "on" : ""}" data-act="tsort" data-k="${k}">${l}</button>`).join(" · ")}</div>
      <div class="progress muted small" ${data.dailyLoading ? "" : "hidden"}>Loading price history ${data.dailyDone}/${acrs.length}…</div>
      <div class="list">${shown.map(tradeRow).join("") || `<p class="muted">Nothing here right now.</p>`}</div>
      ${foot()}`;
  }

  function updateProgress() {
    const p = $(".progress");
    if (!p) return;
    p.hidden = !data.dailyLoading;
    p.textContent = `Loading price history ${data.dailyDone}/${Object.keys(data.live || {}).length - 1}…`;
  }

  function tradeRow(g) {
    const v = verdict(g);
    const lv = data.live[g.acr] || {};
    const bar = g.pos != null ? `<span class="rbar"><i style="left:${Math.max(0, Math.min(100, g.pos * 100)).toFixed(0)}%"></i></span>` : "";
    return `<button class="row" data-act="stock" data-acr="${esc(g.acr)}">
      <span class="nm"><b>${esc(g.acr)}</b> <small>${esc(lv.name || "")}</small></span>
      <span class="mid">${bar}<small>${g.rec && g.rec.trades ? `swing ${signPct(g.rec.ret)}/yr · won ${g.rec.wins}/${g.rec.trades}` : "&nbsp;"}</small></span>
      <span class="rt">${price(g.price)}<small>${chg(g.ch24)} 24h</small></span>
      <span class="pill ${v.cls} zone">${v.icon} ${v.short}</span>
    </button>`;
  }

  // ---------------------------------------------------------------- one stock
  const RANGES = { "1D": ["m15", 96], "1W": ["h1", 168], "1M": ["h4", 186], "1Y": ["d1", 365], "5Y": ["w1", 262] };
  const RANGE_TTL = { "1D": 2 * MIN, "1W": 10 * MIN, "1M": 30 * MIN, "1Y": 3 * HOUR, "5Y": 6 * HOUR };
  const chart = { key: "", rows: null, err: null };

  function renderStock() {
    const acr = view.acr;
    const s = stockByAcr(acr);
    const lv = (data.live && data.live[acr]) || {};
    if (!data.daily[acr]) {
      const c = store.get("d_" + acr, null);
      if (c) data.daily[acr] = c;
      if (!c || Date.now() - c.t > DAILY_TTL) loadDaily(acr).then(() => S.tab === "stock" && view.acr === acr && redraw());
    }
    const g = signal(acr);
    const v = verdict(g);
    const have = s ? owned(s.id) : 0;
    const held = s ? blocksHeld(have, s.req) : 0;
    const keep = s ? (s.type === "passive" ? (held ? s.req : 0) : sharesFor(s.req, held)) : 0;
    const free = have - keep;
    body().innerHTML = `
      <div class="phead">
        <div><b class="big">${price(g.price)}</b></div>
        <div class="chips">
          <span class="chip">24h ${chg(g.ch24, 2)}</span><span class="chip">7d ${chg(g.ch7)}</span><span class="chip">30d ${chg(g.ch30)}</span>
        </div>
      </div>
      <div class="sorts slim">${Object.keys(RANGES).map((r) => `<button class="seg ${S.range === r ? "on" : ""}" data-act="range" data-r="${r}">${r}</button>`).join("")}</div>
      <div class="chartbox"><p class="muted center small">Loading chart…</p></div>
      <div class="card sig ${v.cls}">
        <div class="crow"><b class="grow">${v.icon} Swing signal: ${esc(v.short)}</b></div>
        <div class="line">${esc(v.text)}</div>
        ${v.warn ? `<div class="line a">⚠ ${esc(v.warn)}</div>` : ""}
        ${g.lo != null ? `<div class="line muted">20-day range: ${price(g.lo)} – ${price(g.hi)} · buy zone below ${price(g.lo + (g.hi - g.lo) * SWING_LO)} · sell zone above ${price(g.lo + (g.hi - g.lo) * SWING_HI)}</div>` : ""}
        ${have && g.zone === "sell" && free > 0 ? `<div class="line">You have <b>${commas(free)}</b> shares above your ${held ? "blocks" : "0 blocks"} that you could sell.</div>` : ""}
        ${g.rec ? `<div class="line small muted">Last year with this rule: ${signPct(g.rec.ret)} vs ${signPct(g.rec.hold)} just holding · ${g.rec.trades} trades, ${g.rec.wins} won${g.rec.trades ? `, worst ${signPct(g.rec.worst)}` : ""}.</div>` : ""}
      </div>
      ${g.flow7 != null ? `<div class="line muted small flow">Players ${g.flow7 >= 0 ? "bought" : "sold"} ${pctTxt(Math.abs(g.flow7), 2)} of all shares this week${Math.abs(g.flow7) < 0.002 ? " (quiet)" : ""}.</div>` : ""}
      ${planCard(acr)}
      ${alertCard(acr)}
      ${scoreCardHtml(acr)}
      ${practiceCard(acr)}
      ${s ? stockBlockInfo(s, have, held) : ""}
      <p class="muted small"><a href="${STOCKS_PAGE}" target="_top">Open the stock market</a> to buy or sell.</p>
      ${foot()}`;
    drawChart(acr);
    drawDayTrade(acr);
    const pa = $(".plan-amt");
    if (pa)
      pa.addEventListener("input", () => {
        const v = parseMoney(pa.value);
        if (v > 0) {
          S.planAmt = v;
          save();
          $(".plan-out").innerHTML = planOut(acr);
        }
      });
  }

  function planCard(acr) {
    return `<div class="card">
      <b>📝 Swing trade plan</b>
      <label class="tog"><span>Money to use</span><input class="plan-amt" inputmode="decimal" value="${esc(money(S.planAmt).replace("$", ""))}" autocomplete="off" style="width:120px"></label>
      <div class="plan-out">${planOut(acr)}</div>
    </div>`;
  }

  function planOut(acr) {
    const t = tradePlan(acr, S.planAmt);
    if (!t) return `<div class="line muted">Needs price history; loading…</div>`;
    if (!t.sh) return `<div class="line muted">That's less than one share.</div>`;
    const wait = t.g.zone !== "buy";
    return `
      <div class="line">Buy <b>${commas(t.sh)}</b> shares at about ${price(t.g.price)} = ${money(t.cost)}${wait ? ` <span class="a">(not in the buy zone now: swing buyers wait for ${price(t.g.lo + (t.g.hi - t.g.lo) * SWING_LO)})</span>` : ""}</div>
      <div class="line">🎯 Target (sell zone): <b>${price(t.target)}</b> → <span class="${t.win >= 0 ? "g" : "r"}">${t.win >= 0 ? "+" : ""}${money(t.win)}</span></div>
      <div class="line">🛑 Stop-loss: <b>${price(t.stop)}</b> → <span class="r">${money(t.loss)}</span> <span class="muted small">(2 typical daily moves under the 20-day low)</span></div>
      <div class="line muted">Break-even after the fee: ${price(t.be)} · ${t.ratio ? `you risk $1 to make $${t.ratio.toFixed(1)}` : ""}</div>
      <div class="pbuy">
        <button class="btn ghost" data-act="planalerts" data-acr="${esc(acr)}">🔔 Alert me at target & stop</button>
        <button class="btn" data-act="buytorn" data-acr="${esc(acr)}" data-n="${t.sh}">🛒 Buy on Torn</button>
        <button class="btn ghost" data-act="copy" data-n="${t.sh}">Copy ${shares(t.sh)}</button>
      </div>
      ${isStocksPage() ? `<div class="line small muted">On this page: open ${esc(acr)}'s BUY panel and tap “📈 Fill shares” under Torn's box.</div>` : ""}`;
  }

  function alertCard(acr) {
    const a = S.alerts[acr] || {};
    return `<div class="card">
      <div class="crow"><b class="grow">🔔 Alerts for ${esc(acr)}</b>${a.above || a.below || a.zone ? `<button class="link" data-act="aclear" data-acr="${esc(acr)}">remove</button>` : ""}</div>
      <div class="arow"><label>Above $<input class="al-above" inputmode="decimal" value="${a.above || ""}" placeholder="price"></label>
        <label>Below $<input class="al-below" inputmode="decimal" value="${a.below || ""}" placeholder="price"></label></div>
      <label class="tog small"><input type="checkbox" class="al-zone" ${a.zone ? "checked" : ""} style="width:auto"> <span>When it enters the swing buy or sell zone</span></label>
      <div class="pbuy"><button class="btn" data-act="asave" data-acr="${esc(acr)}">Save alert</button>
        <span class="muted small">Works while a Torn page is open${S.alertsOn ? "" : " · alerts are off in ⚙"}.</span></div>
    </div>`;
  }

  function scoreCardHtml(acr) {
    const sc = scorecard(acr);
    if (!sc) return `<div class="card"><b>📊 Strategy scorecard</b><div class="line muted">Needs price history; loading…</div></div>`;
    const best = Math.max(...sc.rows.map((r) => r.ret), sc.hold);
    const row = (name, ret, extra, how) => `<div class="srow ${ret === best ? "best" : ""}">
        <span class="sn">${esc(name)}${how ? `<small>${esc(how)}</small>` : ""}</span>
        <span class="sv"><b class="${ret > 0 ? "g" : ret < 0 ? "r" : ""}">${signPct(ret)}</b><small>${extra}</small></span></div>`;
    return `<div class="card score">
      <b>📊 Strategy scorecard: ${esc(acr)}, last ${sc.days} days</b>
      <div class="line small muted">What each method would have made on this stock, after the 0.1% fee. Best in green border.</div>
      ${sc.rows.map((r) => row(r.name, r.ret, r.trades ? `${r.trades} trade${r.trades > 1 ? "s" : ""}, ${r.wins} won${r.open ? ", 1 open" : ""}` : r.open ? "1 trade, still open" : "no trades", r.how)).join("")}
      ${row("Just holding", sc.hold, "buy once, sell at the end")}
      ${sc.bank ? `<div class="srow"><span class="sn">Bank instead (${bankApr()}%/yr)</span><span class="sv"><b class="g">${signPct(sc.bank)}</b><small>no risk, money locked</small></span></div>` : ""}
      <div class="daytrade line small muted">Day trading test (hourly prices): loading…</div>
      <div class="line small muted">Past results don't promise future ones. A method that won here can lose next month.</div>
    </div>`;
  }

  async function drawDayTrade(acr) {
    let res = null;
    try {
      res = await dayTradeTest(acr);
    } catch (e) {}
    const box = $(".daytrade");
    if (!box || S.tab !== "stock" || view.acr !== acr) return;
    if (!res) return void (box.textContent = "Day trading test: couldn't load hourly prices.");
    box.innerHTML = `<b class="tx">Day trading (hourly, last ${res.days} days):</b> ${res.rows.map((r) => `${esc(r.name)} ${chg(r.ret)} (${r.trades} trades, ${r.wins} won)`).join(" · ")} · holding ${chg(res.hold)}.`;
  }

  function practiceCard(acr) {
    const p = paper.pos[acr];
    const px = livePrice(acr);
    const pl = p ? p.sh * px * (1 - SELL_FEE) - p.cost : 0;
    return `<div class="card practice">
      <div class="crow"><b class="grow">🎮 Practice (fake money)</b><button class="link" data-act="practice">account ›</button></div>
      <div class="line muted">Practice cash ${money(paper.cash)}${p ? ` · you hold ${commas(p.sh)} ${esc(acr)} <span class="${pl >= 0 ? "g" : "r"}">${pl >= 0 ? "+" : ""}${money(pl)}</span>` : ""}</div>
      <div class="pbuy"><input class="pamt" inputmode="decimal" placeholder="amount, e.g. 100m" autocomplete="off">
        <button class="btn" data-act="pbuy" data-acr="${esc(acr)}">Buy</button>
        ${p ? `<button class="btn ghost" data-act="psell" data-acr="${esc(acr)}">Sell all</button>` : ""}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- practice page
  function renderPractice() {
    const v = paperValue();
    const pos = Object.entries(paper.pos);
    const realized = paper.log.filter((l) => l.side === "sell").reduce((a, l) => a + (l.pl || 0), 0);
    body().innerHTML = `
      <div class="stats">
        <div class="stat"><span>Account value</span><b>${money(v)}</b><small>started with ${money(paper.start)}</small></div>
        <div class="stat"><span>Profit / loss</span><b class="${v >= paper.start ? "g" : "r"}">${money(v - paper.start)}</b><small>${signPct(v / paper.start - 1)} · cash ${money(paper.cash)}</small></div>
      </div>
      <p class="muted small">Fake money only: nothing happens in Torn. Buy and sell from any stock's page (Trade tab → tap a stock). Prices are live and the 0.1% fee is real, so you can test the signals before using real money.</p>
      <h3>Holding</h3>
      ${pos.length ? `<div class="list">${pos.map(([a, p]) => {
        const px = livePrice(a);
        const val = p.sh * px * (1 - SELL_FEE);
        return `<button class="row" data-act="stock" data-acr="${esc(a)}"><span class="nm"><b>${esc(a)}</b><small>${shares(p.sh)} sh</small></span>
          <span class="mid small muted">bought ${price(p.cost / p.sh)} · now ${price(px)}</span>
          <span class="rt">${money(val)}<small>${chg(val / p.cost - 1)}</small></span></button>`;
      }).join("")}</div>` : `<p class="muted">Nothing yet.</p>`}
      <h3>Trades${realized ? ` · closed trades ${realized >= 0 ? "made" : "lost"} ${money(Math.abs(realized))}` : ""}</h3>
      ${paper.log.length ? `<div class="log">${paper.log.slice(0, 20).map((l) => `<div class="small"><span class="muted">${new Date(l.t).toISOString().slice(5, 16).replace("T", " ")}</span> ${l.side === "buy" ? "Bought" : "Sold"} ${shares(l.sh)} <b>${esc(l.acr)}</b> at ${price(l.px)}${l.pl != null ? ` <span class="${l.pl >= 0 ? "g" : "r"}">${l.pl >= 0 ? "+" : ""}${money(l.pl)}</span>` : ""}</div>`).join("")}</div>` : `<p class="muted small">No trades yet.</p>`}
      <h3>Start over</h3>
      <div class="pbuy"><input class="preset-amt" inputmode="decimal" value="${esc(money(paper.start).replace("$", ""))}" autocomplete="off"><button class="btn ghost" data-act="preset">Reset account</button></div>
      ${foot()}`;
  }

  function stockBlockInfo(s, have, held) {
    const pv = payoutValue(s);
    const x = steps(s, 1)[0];
    return `<div class="card">
      <b>Benefit block</b>
      <div class="line">${s.type === "passive" ? "Perk" : `Pays every ${s.freq} days`}: ${esc(s.desc || "—")}</div>
      <div class="line muted">1st block needs ${shares(s.req)} shares (${money(s.req * s.price)}); each next block doubles.</div>
      ${have ? `<div class="line">You hold <b>${commas(have)}</b> shares · ${held ? `${held} block${held > 1 ? "s" : ""}` : "no block yet"}</div>` : ""}
      ${x && x.roi > 0 ? `<div class="line">Next block: ${pctTxt(x.roi)}/yr on ${money(x.cost)} (${esc(pv.how)})</div>` : ""}
    </div>`;
  }

  async function drawChart(acr) {
    const r = S.range;
    const key = acr + "|" + r;
    const [iv, limit] = RANGES[r];
    if (chart.key !== key) {
      chart.key = key;
      chart.rows = null;
      chart.err = null;
      try {
        const d = await tornsy(`/${acr.toLowerCase()}?interval=${iv}&limit=${limit}`, RANGE_TTL[r]);
        if (chart.key !== key) return;
        chart.rows = (d.data || []).filter((x) => x && x.length >= 5).map((x) => ({ t: +x[0], c: +x[4], h: +x[2], l: +x[3] }));
      } catch (e) {
        if (chart.key !== key) return;
        chart.err = e;
      }
    }
    const box = $(".chartbox");
    if (!box || S.tab !== "stock" || view.acr !== acr || chart.key !== key) return;
    if (chart.err) return void (box.innerHTML = `<p class="err small">Couldn't load the chart: ${esc(chart.err.message)}</p>`);
    if (!chart.rows) return;
    const g = signal(acr);
    box.innerHTML = svgChart(chart.rows, r, g);
  }

  function svgChart(rows, r, g) {
    if (rows.length < 2) return `<p class="muted center small">Not enough data.</p>`;
    const W = 340, H = 150, P = { l: 4, r: 70, t: 10, b: 18 };
    const vals = rows.map((x) => x.c);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    // Show the 20-day swing zones when they fit the view.
    const bands = g && g.lo != null && (r === "1M" || r === "1W") ? [g.lo, g.hi] : [];
    bands.forEach((b) => ((lo = Math.min(lo, b)), (hi = Math.max(hi, b))));
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
    const x = (i) => P.l + (i / (rows.length - 1)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const path = rows.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join("");
    const up = vals[vals.length - 1] >= vals[0];
    const col = up ? "var(--g)" : "var(--r)";
    const fmtT = (t) => {
      const d = new Date(t * 1000);
      if (r === "1D") return d.toISOString().slice(11, 16);
      if (r === "5Y") return d.toISOString().slice(0, 7);
      return d.toISOString().slice(5, 10);
    };
    const minV = Math.min(...vals), maxV = Math.max(...vals);
    // Price labels on the right, skipped where a 20-day line's label already sits.
    const axis = (v) => (bands.some((b) => Math.abs(y(b) - y(v)) < 12) ? "" : `<text x="${W - P.r + 3}" y="${(y(v) + 3).toFixed(1)}" class="ax">${v.toFixed(2)}</text>`);
    const band = (v, label, cls) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="bl ${cls}"/><text x="${W - P.r + 3}" y="${(y(v) + 3).toFixed(1)}" class="bt ${cls}">${label}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(r)} price chart">
      <path d="${path}L${x(rows.length - 1).toFixed(1)},${H - P.b}L${P.l},${H - P.b}Z" fill="${col}" opacity=".10"/>
      <path d="${path}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/>
      ${bands.length ? band(bands[0], "20d low " + bands[0].toFixed(0), "lo") + band(bands[1], "20d high " + bands[1].toFixed(0), "hi") : ""}
      ${axis(maxV)}${axis(minV)}
      <text x="${P.l}" y="${H - 4}" class="ax">${fmtT(rows[0].t)}</text>
      <text x="${W - P.r}" y="${H - 4}" class="ax" text-anchor="end">${fmtT(rows[rows.length - 1].t)}</text>
    </svg>
    <div class="small muted center">${r}: ${chg(vals[vals.length - 1] / vals[0] - 1, 2)} · low ${price(minV)} · high ${price(maxV)}</div>`;
  }

  // ---------------------------------------------------------------- portfolio
  function renderPortfolio() {
    loadingOr(() => {
      if (data.mineErr && !data.mine) {
        const access = data.mineErr.code === 16;
        body().innerHTML = `${status()}<div class="card"><b>Couldn't load your shares</b>
          <p class="muted">${access ? "Your API key's access level is too low. The Mine tab needs a <b>Limited</b> key (or higher)." : esc(data.mineErr.message)}</p>
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
      const costed = rows.filter((r) => r.cost);
      const tc = costed.reduce((a, r) => a + r.cost, 0);
      const tvc = costed.reduce((a, r) => a + r.costedValue * (1 - SELL_FEE), 0);
      const income = rows.reduce((a, r) => a + r.income, 0);
      const ready = rows.filter((r) => r.h.payout && r.h.payout.ready);
      body().innerHTML = `${status()}
        ${rows.length ? `<div class="stats">
          <div class="stat"><span>Value (if sold)</span><b>${money(tv * (1 - SELL_FEE))}</b></div>
          <div class="stat"><span>Profit / loss</span><b class="${tvc - tc >= 0 ? "g" : "r"}">${tc ? money(tvc - tc) : "—"}</b><small>${tc ? signPct(tvc / tc - 1) + (costed.length < rows.length ? " (known buys)" : "") : "buy prices missing"}</small></div>
          <div class="stat"><span>Payouts</span><b>${money(income)}/yr</b><small>${tv ? pctTxt(income / tv) + " of value" : ""}</small></div>
          <div class="stat"><span>Ready to collect</span><b class="${ready.length ? "a" : ""}">${ready.length ? ready.map((r) => esc(r.s.acr)).join(", ") : "none"}</b></div>
        </div>
        <div class="cards">${rows.map(holdingCard).join("")}</div>` : `<p class="muted">You don't own any shares yet. The <b>Advisor</b> and <b>Money</b> tabs show what's worth buying.</p>`}
        ${foot()}`;
    });
  }

  function holdingStats(h, s) {
    const value = h.shares * s.price;
    // Torn reports a buy price of 0 for some old purchases, so average only the lots that have one.
    const known = h.lots.filter((l) => l.price > 0);
    const knownShares = Math.min(h.shares, known.reduce((a, l) => a + l.shares, 0));
    const avg = knownShares ? known.reduce((a, l) => a + l.shares * l.price, 0) / known.reduce((a, l) => a + l.shares, 0) : 0;
    const cost = avg * knownShares;
    // Counted from shares: Torn's own block count only updates on payout day.
    const held = blocksHeld(h.shares, s.req);
    const pv = payoutValue(s);
    const income = s.type === "passive" ? (held ? pv.value : 0) : held * yearly(pv.value, s.freq);
    return { h, s, value, avg, cost, knownShares, costedValue: knownShares * s.price, held, pv, income };
  }

  function holdingCard(r) {
    const { h, s, avg, held } = r;
    const net = r.knownShares * s.price * (1 - SELL_FEE);
    const pl = r.cost ? net - r.cost : 0;
    const be = avg ? avg / (1 - SELL_FEE) : 0;
    const passive = s.type === "passive";
    const keep = passive ? (held ? s.req : 0) : sharesFor(s.req, held);
    const free = h.shares - keep;
    const toNext = passive ? (held ? 0 : s.req - h.shares) : sharesFor(s.req, held + 1) - h.shares;
    const pay = h.payout;
    let payTxt = "";
    if (held && pay && !passive) payTxt = pay.ready ? `<span class="a">Payout ready to collect!</span>` : pay.freq ? `Next payout in ${Math.max(0, pay.freq - pay.progress)} day(s)` : "";
    const g = signal(s.acr);
    const v = verdict(g);
    return `<div class="card" data-acr="${esc(s.acr)}">
      <div class="crow">
        <div class="grow">${stockLink(s.acr, `<b class="acr">${esc(s.acr)}</b>`)} <span class="muted">${esc(s.name)}</span>
          <small class="muted">${commas(h.shares)} shares × ${price(s.price)} = ${money(r.value)}</small></div>
        ${r.cost ? `<span class="pill ${pl >= 0 ? "good" : "bad"}">${signPct(net / r.cost - 1)}</span>` : ""}
      </div>
      ${avg ? `<div class="line">Bought at <b>${price(avg)}</b> avg${r.knownShares < h.shares ? ` <span class="muted">(${shares(r.knownShares)} shares with a known price)</span>` : ""} · profit if sold now <b class="${pl >= 0 ? "g" : "r"}">${money(pl)}</b></div>
        <div class="line muted">Break-even price (after 0.1% fee): <b class="tx">${price(be)}</b></div>` : ""}
      <div class="line">${held ? `✓ ${passive ? "Perk" : `${held} block${held > 1 ? "s" : ""}`}${!passive && r.pv.ok ? ` · ${money(r.income)}/yr` : ""}` : "No block yet"}
        ${toNext > 0 ? ` · <span class="muted">${shares(toNext)} more for ${passive ? "the perk" : `the ${ordinal(held + 1)} block`} (${money(toNext * s.price)})</span>` : ""}</div>
      ${payTxt ? `<div class="line">${payTxt}</div>` : ""}
      ${held ? `<div class="line small ${free > 0 ? "muted" : "a"}">${free > 0 ? `You can sell up to ${commas(free)} shares and keep your ${passive ? "perk" : "blocks"}.` : `⚠ Selling any shares loses ${passive ? "the perk" : `your ${ordinal(held)} block`}.`}</div>` : ""}
      ${g.zone && free > 0 && g.zone !== "mid" ? `<div class="line small">${v.icon} Swing: ${esc(v.short)} ${stockLink(s.acr, "chart ›")}</div>` : ""}
    </div>`;
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    const pda = !PDA_KEY.includes("#");
    const b = bankRate();
    body().innerHTML = `
      <button class="link back" data-act="tab" data-tab="${esc(view.from && !SUB.includes(view.from) ? view.from : "advisor")}">‹ Back</button>
      <h3>API key</h3>
      <p class="muted small">${pda ? "Torn PDA is giving the script your key. You only need this box to use a different key." : "Paste a Torn API key. A <b>Limited</b> key is needed for the Mine tab; Public works for the rest."}</p>
      <input class="set-key" type="password" placeholder="${pda ? "using Torn PDA key" : "API key"}" value="${esc(S.apiKey)}" autocomplete="off">
      <h3>Bank rate</h3>
      ${data.bank ? `<div class="bankrates">${BANK_TERMS.map(([k, l]) => (data.bank[k] ? `<span class="chip">${l}: <b>${data.bank[k]}%</b></span>` : "")).join("")}</div>
        <p class="muted small">Torn's Investment Bank rates (APR). Each Bank Interest merit adds 5%, and the TCI block adds 10%${ownsTCI() ? " (you have it ✓)" : ""}.</p>` : `<p class="muted small">Torn's bank rates load with your API key.</p>`}
      <label class="tog"><span>Bank Interest merits</span><input class="set-merits num" inputmode="numeric" value="${S.merits || 0}"></label>
      <label class="tog"><span>Or type your own rate</span><input class="set-bank num" inputmode="decimal" value="${S.bankApr || ""}" placeholder="auto"> %/yr</label>
      <p class="muted small">Now using: <b>${b.apr ? `${b.apr}%/yr` : "not set"}</b>${b.src ? ` (${esc(b.src)})` : ""}. Blocks that pay less are marked red.</p>
      <h3>Your values</h3>
      ${Object.keys(S.custom).length ? `<div class="cards">${Object.entries(S.custom).map(([a, v]) => `<div class="card crow"><b class="grow">${esc(a)}</b> ${money(v)} <button class="link" data-act="clearval" data-acr="${esc(a)}">Remove</button></div>`).join("")}</div>` : `<p class="muted small">None yet. Set them with "Set value" on the Advisor tab.</p>`}
      <h3>Alerts</h3>
      <label class="tog"><span>Alerts on</span><input type="checkbox" class="set-alerts" ${S.alertsOn ? "checked" : ""} style="width:auto"></label>
      <label class="tog"><span>Vibrate</span><input type="checkbox" class="set-vibrate" ${S.vibrate ? "checked" : ""} style="width:auto"></label>
      <label class="tog"><span>Payout ready to collect (Limited key)</span><input type="checkbox" class="set-payout" ${S.payoutAlert ? "checked" : ""} style="width:auto"></label>
      <p class="muted small">Alerts are checked once a minute while any Torn page is open (Torn PDA or browser). Nothing is checked when Torn is closed everywhere. Add phone notifications below to get alerts in your phone's notification bar.</p>
      ${alertCount() ? `<div class="cards">${Object.entries(S.alerts).map(([a, x]) => `<div class="card crow"><span class="grow">${stockLink(a, `<b>${esc(a)}</b>`)} ${[x.above ? `above ${price(x.above)}` : "", x.below ? `below ${price(x.below)}` : "", x.zone ? "swing zones" : ""].filter(Boolean).join(" · ")}</span><button class="link" data-act="aclear" data-acr="${esc(a)}">Remove</button></div>`).join("")}</div>` : `<p class="muted small">No alerts set. Add them on any stock's page.</p>`}
      ${S.inbox.length ? `<p class="small"><b>Recent:</b></p><div class="log">${S.inbox.slice(0, 8).map((x) => `<div class="small"><span class="muted">${new Date(x.t).toISOString().slice(5, 16).replace("T", " ")}</span> ${esc(x.text)}</div>`).join("")}</div>` : ""}
      <h3>📲 Phone notifications (ntfy)</h3>
      <p class="muted small">Get every alert in your phone's notification bar with the free <b>ntfy</b> app (no account).</p>
      <ol class="small muted setup">
        <li>Install <b>ntfy</b> from the Play Store or App Store.</li>
        <li>In ntfy tap <b>+</b> (Subscribe to topic) and type your topic below. Leave the server as ntfy.sh.</li>
        <li>Tap <b>Send test</b> here.</li>
      </ol>
      <div class="pbuy"><input class="set-ntfy" value="${esc(S.ntfyTopic)}" placeholder="your topic" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn ghost" data-act="ntfynew">New</button><button class="btn" data-act="ntfytest">Send test</button></div>
      <p class="muted small">Anyone who knows the topic name can read it, so keep the random one. Alerts are only checked while Torn is open somewhere. Your phone may pause Torn PDA in the background, so for alerts while you're away, leave Torn open in a browser on a computer. Empty = off.</p>
      <h3>About</h3>
      <div class="about">
        <div><b>Torn Stock Geek v${VERSION}</b></div>
        <div class="muted small">Advice from the official Torn API, with price history from Tornsy (tornsy.com). It never buys or sells anything for you.</div>
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
      refresh(true);
    });
    $(".set-bank").addEventListener("change", (e) => {
      S.bankApr = Math.max(0, parseFloat(e.target.value) || 0);
      save();
      toast(S.bankApr ? `Bank rate ${S.bankApr}%` : "Using Torn's bank rate");
      renderSettings();
    });
    const tog = (cls, key) =>
      $(cls).addEventListener("change", (e) => {
        S[key] = e.target.checked;
        save();
      });
    tog(".set-alerts", "alertsOn");
    tog(".set-vibrate", "vibrate");
    tog(".set-payout", "payoutAlert");
    $(".set-ntfy").addEventListener("change", (e) => {
      const t = e.target.value.trim();
      if (t && !ntfyTopicOk(t)) return toast("Topic: letters, numbers, - and _ only", "bad");
      S.ntfyTopic = t;
      save();
      toast(t ? "Topic saved" : "Phone notifications off");
    });
    $(".set-merits").addEventListener("change", (e) => {
      S.merits = Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0));
      save();
      renderSettings();
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
    const s = stockByAcr(acr);
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
      if (b.dataset.tab === "settings" && !SUB.includes(S.tab)) view.from = S.tab;
      go(b.dataset.tab);
      if (!["settings", "trade"].includes(S.tab) && apiKey() && !data.market) refresh(false);
    } else if (act === "back") {
      if (S.tab === "stock" && view.back === "practice") go("practice");
      else go(view.from || "trade");
    }
    else if (act === "stock") {
      view.acr = b.dataset.acr;
      go("stock");
    } else if (act === "range") {
      S.range = b.dataset.r;
      save();
      $$("[data-act=range]").forEach((x) => x.classList.toggle("on", x.dataset.r === S.range));
      drawChart(view.acr);
    } else if (act === "practice") go("practice");
    else if (act === "asave") {
      const acr = b.dataset.acr;
      const above = parseFloat(($(".al-above") || {}).value) || 0;
      const below = parseFloat(($(".al-below") || {}).value) || 0;
      const zone = !!($(".al-zone") || {}).checked;
      if (!above && !below && !zone) {
        delete S.alerts[acr];
        toast("Alert removed");
      } else {
        S.alerts[acr] = { above, below, zone, last: signal(acr).zone || "" };
        toast(`Alert saved for ${acr}`);
      }
      save();
      render();
    } else if (act === "aclear") {
      delete S.alerts[b.dataset.acr];
      save();
      render();
    } else if (act === "planalerts") {
      const acr = b.dataset.acr;
      const t = tradePlan(acr, S.planAmt);
      if (!t) return;
      S.alerts[acr] = Object.assign({}, S.alerts[acr], { above: +t.target.toFixed(2), below: +t.stop.toFixed(2) });
      save();
      toast(`Alerts set: above ${price(t.target)}, below ${price(t.stop)}`, "", 3000);
      render();
    } else if (act === "buytorn") {
      store.set("buyIntent", { acr: b.dataset.acr, n: +b.dataset.n, t: Date.now() });
      if (isStocksPage()) {
        close();
        highlightIntent();
        scanStockPage();
      } else {
        toast("Opening the stock market…");
        location.href = STOCKS_PAGE;
      }
    } else if (act === "copy") {
      const n = b.dataset.n;
      (navigator.clipboard ? navigator.clipboard.writeText(n) : Promise.reject()).then(
        () => toast(`Copied ${commas(n)}`),
        () => toast(`Shares: ${commas(n)}`, "", 4000)
      );
    } else if (act === "loadhist") {
      b.disabled = true;
      b.textContent = "Loading…";
      (data.live ? Promise.resolve() : loadLive()).then(() => loadAllDaily()).then(() => render());
    } else if (act === "bannerclose") {
      e.stopPropagation();
      $(".banner").hidden = true;
    } else if (act === "banner") {
      $(".banner").hidden = true;
      view.acr = b.dataset.acr;
      if (!isOpen()) open();
      go("stock");
    } else if (act === "pbuy") {
      const amt = parseMoney(($(".pamt") || {}).value);
      if (!amt) return toast("Type an amount first, e.g. 100m", "bad");
      toast(paperBuy(b.dataset.acr, amt), "", 3000);
      render();
    } else if (act === "psell") {
      toast(paperSell(b.dataset.acr), "", 3500);
      render();
    } else if (act === "preset") {
      const amt = parseMoney(($(".preset-amt") || {}).value) || PAPER_START;
      if (!confirm(`Reset the practice account to ${money(amt)}? Your practice trades will be cleared.`)) return;
      paper = paperNew(amt);
      savePaper();
      render();
    } else if (act === "ntfynew") {
      const t = "tsg-" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
      S.ntfyTopic = t;
      save();
      $(".set-ntfy").value = t;
      toast("New topic made. Subscribe to it in the ntfy app.", "", 3500);
    } else if (act === "ntfytest") {
      const t = ($(".set-ntfy") || {}).value ? $(".set-ntfy").value.trim() : S.ntfyTopic;
      if (!ntfyTopicOk(t)) return toast("Tap New to make a topic first", "bad");
      S.ntfyTopic = t;
      save();
      sendNtfy("Test from Torn Stock Geek. Alerts will arrive like this.", { tags: "white_check_mark", retry: false }).then((ok) =>
        toast(ok === true ? "Test sent. Check the ntfy app." : ok === "busy" ? "ntfy says too many messages; try again in a few minutes." : "Couldn't send. Check your connection.", ok === true ? "" : "bad", 3500)
      );
    } else if (act === "zonealert") {
      const acr = b.dataset.acr;
      S.alerts[acr] = Object.assign({ above: 0, below: 0 }, S.alerts[acr], { zone: true, last: signal(acr).zone || "" });
      save();
      toast(`You'll get a reminder when ${acr} enters the buy or sell zone (while Torn is open).`, "", 3500);
      renderPlan();
    } else if (act === "period") {
      S.period = b.dataset.k;
      save();
      $$("[data-act=period]").forEach((x) => x.classList.toggle("on", x.dataset.k === S.period));
      renderPlan();
    } else if (act === "tsort") {
      S.tradeSort = b.dataset.k;
      save();
      render();
    } else if (act === "filter") {
      S.tradeFilter = b.dataset.f;
      save();
      render();
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
.fab-badge { position: absolute; top: -5px; right: -5px; min-width: 20px; padding: 2px 5px; border-radius: 10px; font-size: 11px; font-weight: 700; background: var(--amber); color: #2b2200; }
.banner { position: fixed; left: 10px; right: 10px; top: 10px; z-index: 2147483004; display: flex; align-items: center; gap: 8px; background: var(--bg3); color: var(--text);
  border: 1px solid var(--amber); border-radius: 12px; padding: 10px 12px; font-size: 14px; box-shadow: 0 6px 20px rgba(0,0,0,.5); cursor: pointer; }
.banner span { flex: 1; }
@media (min-width: 760px) { .banner { left: auto; width: 420px; } }
.ib.sm { min-width: 28px; height: 28px; font-size: 13px; padding: 0 6px; }
.arow { display: flex; gap: 8px; }
.arow label { flex: 1; display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--muted); }
.arow input { padding: 7px 8px; }
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
.tab { flex: 1; background: transparent; border: 0; color: var(--muted); border-radius: 9px; padding: 8px 2px; font-size: 14px; }
.tab.on { background: var(--bg3); color: var(--text); font-weight: 700; }
.body { flex: 1; overflow-y: auto; padding: 4px 12px 12px; border-top: 1px solid var(--line); -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 2px 6px; }
p { margin: 6px 2px; }
ul { margin: 4px 0; padding-left: 20px; }
.muted { color: var(--muted); } .small { font-size: 12px; } .g { color: var(--g); } .r { color: var(--r); } .a { color: var(--amber); } .err { color: var(--r); }
.center { text-align: center; padding: 30px 0; }
.small.center { padding: 4px 0; }
.status { font-size: 12px; margin: 8px 2px; }
.intro { font-size: 13px; }
.foot { font-size: 11px; margin-top: 18px; text-align: center; }
.link { background: none; border: 0; color: var(--acc); padding: 0 2px; font-size: inherit; text-decoration: underline; }
.link.nm { color: var(--text); text-decoration: none; padding: 0; }
a { color: var(--acc); }
.back { margin: 8px 0 0; text-decoration: none; }
input { font: inherit; font-size: 16px; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; width: 100%; outline: none; }
input:focus { border-color: var(--acc); }
input.num { width: 90px; }
.field { display: grid; gap: 6px; font-weight: 600; margin: 8px 2px 10px; }
.tog { display: flex; align-items: center; gap: 10px; margin: 6px 2px; }
.tog > span { flex: 1; }
.cards { display: flex; flex-direction: column; gap: 6px; }
.card { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 9px 10px; display: grid; gap: 3px; margin-bottom: 6px; }
.cards .card { margin-bottom: 0; }
.card.pick { border-color: rgba(127,220,111,.5); }
.card.sig.good { border-color: rgba(127,220,111,.55); } .card.sig.bad { border-color: rgba(255,135,135,.5); }
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
.sorts { display: flex; gap: 4px; margin: 8px 0; background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 3px; }
.seg { flex: 1; background: transparent; border: 0; color: var(--muted); border-radius: 9px; padding: 7px 2px; font-size: 12.5px; white-space: nowrap; }
.seg.on { background: var(--bg3); color: var(--text); font-weight: 700; }
.list { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 12px; padding: 8px 10px; }
.row .nm { width: 64px; flex: none; overflow: hidden; }
.row .nm small { display: block; font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .mid { flex: 1; min-width: 0; }
.row .mid small { display: block; font-size: 10.5px; color: var(--muted); margin-top: 3px; }
.row .rt { text-align: right; font-size: 13px; flex: none; }
.row .rt small { display: block; font-size: 11px; }
.row .zone { font-size: 11px; padding: 2px 6px; min-width: 74px; text-align: center; }
.rbar { position: relative; display: block; height: 6px; border-radius: 3px; background: linear-gradient(90deg, rgba(127,220,111,.45) 0 10%, var(--bg3) 10% 90%, rgba(255,135,135,.4) 90% 100%); }
.rbar i { position: absolute; top: -3px; width: 4px; height: 12px; margin-left: -2px; border-radius: 2px; background: var(--text); }
.note { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; font-size: 13px; }
.note summary { cursor: pointer; color: var(--acc); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--bg2); border: 1px solid var(--line); border-radius: 999px; padding: 3px 9px; font-size: 12px; }
.bankrates { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
.phead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 2px 0; flex-wrap: wrap; }
.big { font-size: 22px; }
.sorts.slim { margin: 8px 0 4px; }
.chartbox { min-height: 160px; margin-bottom: 8px; }
.chart { width: 100%; height: auto; display: block; }
.chart .ax { fill: var(--muted); font-size: 10px; }
.chart .bl { stroke-width: 1; stroke-dasharray: 4 3; }
.chart .bl.lo { stroke: var(--g); } .chart .bl.hi { stroke: var(--r); }
.chart .bt { font-size: 9.5px; } .chart .bt.lo { fill: var(--g); } .chart .bt.hi { fill: var(--r); }
.flow { margin: 0 2px 8px; }
.score .srow { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border: 1px solid transparent; border-radius: 9px; }
.score .srow.best { border-color: rgba(127,220,111,.55); }
.score .sn { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; }
.score .sn small, .score .sv small { display: block; font-size: 11px; font-weight: 400; color: var(--muted); }
.score .sv { text-align: right; flex: none; font-size: 14px; }
.pbuy { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
.pbuy input { flex: 1; min-width: 0; }
.pbuy .btn { flex: none; }
.practice-entry { margin: 8px 0 0; border-style: dashed; }
.practice-entry .nm2 { flex: 1; }
.practice-entry .nm2 small { display: block; font-size: 11px; color: var(--muted); }
.sortby { margin: -2px 2px 8px; }
.sortby .link { color: var(--muted); text-decoration: none; }
.sortby .link.on { color: var(--acc); font-weight: 700; }
.log { display: grid; gap: 4px; }
.ptitle { font-weight: 700; font-size: 15px; margin: 12px 2px 4px; }
.opt { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 9px 10px; margin: 6px 0; }
.opt.best { border-color: rgba(127,220,111,.6); background: rgba(127,220,111,.06); }
.opt .crow b { font-size: 15px; white-space: nowrap; }
.opt details.more summary { cursor: pointer; color: var(--acc); font-size: 13px; margin-top: 4px; }
.setup { margin: 4px 0 6px; padding-left: 20px; }
.btn.small { height: 30px; font-size: 13px; padding: 0 10px; margin-top: 6px; }
.bar { height: 6px; border-radius: 3px; background: var(--bg3); margin-top: 6px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--acc); }
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
    badge();
    stockPageHelper();
    setTimeout(monitor, 4000);
    setInterval(monitor, MON_EVERY);
  }
  start();
})();
