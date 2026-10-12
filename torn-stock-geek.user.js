// ==UserScript==
// @name         Torn Stock Geek
// @namespace    https://github.com/SarcasticGeekJr/torn-stock-geek
// @version      0.2.0
// @description  A stock advisor for Torn: ranks the next benefit block of every stock by yearly return, plans what to buy with your cash, compares with your bank rate, tracks your portfolio, and shows price charts with swing-trading signals. Built for Torn PDA, works in Tampermonkey too.
// @author       SarcasticGeekJr
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      tornsy.com
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
 *   Tornsy (https://tornsy.com/api, free, no key): price history of every stock, collected each minute.
 *     /stocks?interval=h24,d7              current prices plus 24h and 7d ago
 *     /{acronym}?interval=d1&limit=400     daily candles [time, open, high, low, close, total_shares]
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
  const VERSION = "0.2.0"; // keep in sync with @version above
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
    tab: "advisor",
    tradeFilter: "all",
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
      const d = await tornsy(`/${acr.toLowerCase()}?interval=d1&limit=400`, DAILY_TTL, force);
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

  function verdict(g) {
    if (g.zone == null) return { cls: "even", icon: "⚪", short: "no data", text: "Price history isn't loaded yet." };
    const rec = g.rec;
    const record = rec && rec.trades ? `This rule won ${rec.wins} of ${rec.trades} trades on ${g.acr} in the last year.` : "";
    if (g.zone === "buy")
      return g.works
        ? { cls: "good", icon: "🟢", short: "buy zone", text: `Price is near its 20-day low (${price(g.lo)}). ${record}` }
        : { cls: "even", icon: "🟡", short: "low, weak record", text: `Price is near its 20-day low, but the swing rule hasn't worked well on ${g.acr} lately. ${record}` };
    if (g.zone === "sell")
      return { cls: "bad", icon: "🔴", short: "sell zone", text: `Price is near its 20-day high (${price(g.hi)}). A good time to sell swing shares (not your benefit blocks).` };
    const where = g.pos < 0.35 ? "in the lower part" : g.pos > 0.65 ? "in the upper part" : "in the middle";
    return { cls: "even", icon: "⚪", short: "wait", text: `Price is ${where} of its 20-day range. Swing buyers wait for ${price(g.lo + (g.hi - g.lo) * SWING_LO)} or lower.` };
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
    <button class="fab" data-act="toggle" title="Torn Stock Geek (drag to move)"><span>📈</span></button>
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
        <button class="tab" data-act="tab" data-tab="planner">Planner</button>
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
    const onStock = S.tab === "stock";
    $$(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    $(".tabs").hidden = S.tab === "settings" || onStock;
    $("[data-act=back]").hidden = !onStock;
    $(".title").textContent = onStock ? `${view.acr} ${(stockByAcr(view.acr) || (data.live && data.live[view.acr]) || {}).name || ""}` : TITLES[S.tab] || "Torn Stock Geek";
    const scroll = body().scrollTop;
    if (!apiKey() && !["settings", "trade", "stock"].includes(S.tab)) renderNoKey();
    else ({ advisor: renderAdvisor, planner: renderPlanner, trade: renderTrade, portfolio: renderPortfolio, settings: renderSettings, stock: renderStock })[S.tab]();
    body().scrollTop = scroll;
  }

  function go(tab) {
    if (tab === "stock") view.from = S.tab === "stock" ? view.from : S.tab;
    S.tab = tab;
    if (!["settings", "stock"].includes(tab)) save();
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
    const bankPct = bankApr();
    if (!S.budget) {
      box.innerHTML = `<p class="muted">Type an amount. The planner picks the blocks with the best yearly return you can afford, one at a time${bankPct ? `, and skips anything that pays less than your bank (${bankPct}%)` : ""}.</p>`;
      return;
    }
    const p = plan(S.budget);
    const spent = S.budget - p.left;
    const income = p.picks.reduce((a, x) => a + x.perYear, 0);
    const bank = bankPct / 100;
    const inBank = Math.min(p.left, BANK_LIMIT);
    box.innerHTML = `
      ${p.picks.length ? `<ol class="steps">${p.picks.map((x) => `<li>
          Buy <b>${shares(x.need)} ${esc(x.s.acr)}</b> (${money(x.cost)}) → ${ordinal(x.block)} ${esc(x.s.acr)} ${x.s.type === "passive" ? "perk" : "block"}
          <span class="pill ${roiClass(x.roi)}">${pctTxt(x.roi)}/yr</span>
          <small class="muted">${x.s.type === "passive" ? esc(x.s.desc) : `${esc(x.pv.how)} every ${x.s.freq} days`}${x.belowBank ? " · less than the bank, but the bank is full" : ""}</small></li>`).join("")}</ol>
        <div class="sum">Spend <b>${money(spent)}</b> → about <b class="g">${money(income)}/yr</b> in payouts (${pctTxt(spent ? income / spent : 0)}/yr)</div>`
        : `<p class="muted">Nothing worth buying with ${money(S.budget)}${bank ? ` that beats your bank (${bankPct}%)` : ""}.</p>`}
      ${p.left > 0 ? `<div class="sum">Left over: <b>${money(p.left)}</b>${bank ? ` → the bank (${bankPct}%/yr) pays about ${money(inBank * bank)}/yr${p.left > BANK_LIMIT ? ` on ${money(BANK_LIMIT)} (the most one investment takes)` : ""}` : ""}${p.next ? `${bank ? ";" : ""} or save toward <b>${esc(p.next.s.acr)}</b> ${ordinal(p.next.block)} block (${money(p.next.cost)}, ${pctTxt(p.next.roi)}/yr)` : ""}.</div>` : ""}
      <p class="muted small">Buy on the <a href="${STOCKS_PAGE}" target="_top">stock market page</a>. Prices move every minute, so check the cost there. Share prices also go up and down, so a block can be worth less (or more) when you sell.</p>`;
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
      .sort((a, b) => (a.pos ?? 2) - (b.pos ?? 2));
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
      <div class="sorts">
        ${[["all", "All"], ["buy", `Buy zone (${nBuy})`], ["sell", `Sell zone (${nSell})`], ["mine", "Mine"]].map(([k, l]) => `<button class="seg ${f === k ? "on" : ""}" data-act="filter" data-f="${k}">${l}</button>`).join("")}
      </div>
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
      <span class="mid">${bar}<small>${g.rec && g.rec.trades ? `swing: won ${g.rec.wins}/${g.rec.trades}` : "&nbsp;"}</small></span>
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
        ${g.lo != null ? `<div class="line muted">20-day range: ${price(g.lo)} – ${price(g.hi)} · buy zone below ${price(g.lo + (g.hi - g.lo) * SWING_LO)} · sell zone above ${price(g.lo + (g.hi - g.lo) * SWING_HI)}</div>` : ""}
        ${have && g.zone === "sell" && free > 0 ? `<div class="line">You have <b>${commas(free)}</b> shares above your ${held ? "blocks" : "0 blocks"} that you could sell.</div>` : ""}
        ${g.rec ? `<div class="line small muted">Last year with this rule: ${signPct(g.rec.ret)} vs ${signPct(g.rec.hold)} just holding · ${g.rec.trades} trades, ${g.rec.wins} won${g.rec.trades ? `, worst ${signPct(g.rec.worst)}` : ""}.</div>` : ""}
      </div>
      ${g.flow7 != null ? `<div class="line muted small flow">Players ${g.flow7 >= 0 ? "bought" : "sold"} ${pctTxt(Math.abs(g.flow7), 2)} of all shares this week${Math.abs(g.flow7) < 0.002 ? " (quiet)" : ""}.</div>` : ""}
      ${s ? stockBlockInfo(s, have, held) : ""}
      <p class="muted small"><a href="${STOCKS_PAGE}" target="_top">Open the stock market</a> to buy or sell.</p>
      ${foot()}`;
    drawChart(acr);
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
        <div class="cards">${rows.map(holdingCard).join("")}</div>` : `<p class="muted">You don't own any shares yet. The <b>Advisor</b> and <b>Planner</b> tabs show what's worth buying.</p>`}
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
      <button class="link back" data-act="tab" data-tab="${esc(view.from && view.from !== "stock" ? view.from : "advisor")}">‹ Back</button>
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
      if (b.dataset.tab === "settings" && S.tab !== "settings") view.from = S.tab;
      go(b.dataset.tab);
      if (!["settings", "trade"].includes(S.tab) && apiKey() && !data.market) refresh(false);
    } else if (act === "back") go(view.from || "trade");
    else if (act === "stock") {
      view.acr = b.dataset.acr;
      go("stock");
    } else if (act === "range") {
      S.range = b.dataset.r;
      save();
      $$("[data-act=range]").forEach((x) => x.classList.toggle("on", x.dataset.r === S.range));
      drawChart(view.acr);
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
