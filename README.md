# Torn Stock Geek

A stock advisor for [Torn](https://www.torn.com). It tells you which stock benefit blocks pay the most for your money, plans what to buy with your cash, tracks your portfolio, and shows charts with swing-trading signals tested on 5 years of real Torn prices. Built for **Torn PDA**, works in **Tampermonkey** too.

It only reads data and gives advice. **It never buys or sells anything.** On Torn's stock page it can type a number of shares into Torn's box when you tap its button; you still press BUY/SELL yourself.

## Install

**Torn PDA:** Settings → Userscripts → **+** → Remote load/update → paste this link → Configure:

```
https://raw.githubusercontent.com/SarcasticGeekJr/torn-stock-geek/main/torn-stock-geek.user.js
```

- Injection time: **END**.
- When PDA asks about the API key, tap **Add** to use your PDA key.
- **Tampermonkey:** open the link above and click Install. Then paste a key in ⚙ Settings.

**API key:** a **Limited** key is needed for the Mine tab (your shares). A Public key is enough for the Advisor and Planner tabs. The Trade tab works without a key.

## What it does

Tap the 📈 button (you can drag it).

**Advisor**
- Every stock's **next benefit block**, ranked by **yearly return**.
- Shows the cost, what it pays (valued at item market price), and how many days until it pays for itself.
- Compares each block with the **bank**: Torn's Investment Bank rates are loaded for you (add your Bank Interest merits in ⚙; the TCI block is counted automatically).
- Payouts it can't price (like a random property) get a **Set value** button.
- Perks (passive blocks): set what a perk is worth to you to rank it.

**Planner**
- Type your cash (e.g. `2.5b`). It lists the best blocks you can afford, in order, and the yearly payouts you'd get.
- Skips blocks that pay less than the bank, except with money over the bank's $2b limit.

**Trade** (charts and signals, no key needed)
- Every stock with its place in the **last 20 days' price range**: 🟢 buy zone (bottom 10%), 🔴 sell zone (top 10%), ⚪ wait.
- How that swing rule did on each stock in the last year (trades won).
- Sort by nearest buy zone or by best swing record.
- Tap a stock: price chart (1D, 1W, 1M, 1Y, 5Y), 24h/7d/30d change, whether players are buying or selling, and its benefit block.
- **Strategy scorecard** on each stock: what swing (20 and 10 days), dip buying (RSI), trend following, just holding, and the bank would have made in the last year after fees, plus a **day trading test** on hourly prices.

- **Swing trade plan** on each stock: how many shares for your amount, a target (sell zone) and a stop-loss, what you'd make or lose, break-even after the fee, and one tap to set alerts at both.

**🔔 Alerts**
- Per stock: price above / below, or when it enters the swing buy or sell zone.
- Benefit payout ready to collect (Limited key).
- A banner on any Torn page, a badge on the 📈 button, and a vibration. Checked once a minute **while a Torn page is open**; they can't reach you when Torn is closed.

**📈 Fill shares (on Torn's stock market page)**
- Open a stock's BUY or SELL panel: under Torn's shares box you get buttons like "Plan $100m: 114,429", "For block 2: 1,000,000" or "All but blocks: 100,000". Tapping one only types the number. You still press BUY/SELL and confirm.

**🛡 Park cash safely** (Planner tab)
- The calmest stocks lately, for keeping cash where it can't be mugged (selling costs 0.1%).

**🎮 Practice account**
- Fake money (starts at $1b) to try trading with live prices and the real 0.1% fee. Nothing happens in Torn.
- Buy and sell from any stock's page; see your holdings, profit and trade history. Reset any time.

**Mine**
- Value, profit/loss, and yearly payouts of everything you own.
- Per stock: average buy price, **break-even price after the 0.1% sell fee**, blocks held, shares needed for the next block.
- Payouts ready to collect.
- **"You can sell up to X shares and keep your blocks"** warning.

## What we found testing on real prices
Tested on 5 years of Torn prices (from Tornsy), after the 0.1% sell fee:
- **Day trading** (minutes or hours) lost money on every stock. Moves that short are smaller than the fee.
- **Swing trading** over days (buy in the bottom 10% of the last 20 days' range, sell in the top 10%) beat holding on most stocks, in both halves of the 5 years and in the last year.
- Past results don't promise future ones. Only swing with shares you don't need for a benefit block.

## How Torn stocks work (short)
- Buying is free; selling costs **0.1%**. One price for buying and selling.
- Prices change every minute.
- Each extra block of the same stock costs **double** the shares of the one before, so it earns about half the return.
- Perks (passive) need one block, held for 7 days.

## Not yet checked on the real site
- The fill-shares buttons depend on how Torn's stock page is built; if Torn changes it, they just won't show.
- The payout-ready alert relies on Torn's `dividend.ready` field.
