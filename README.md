# Torn Stock Geek

A stock advisor for [Torn](https://www.torn.com). It tells you which stock benefit blocks pay the most for your money, plans what to buy with your cash, tracks your portfolio, and shows charts with swing-trading signals tested on 5 years of real Torn prices. Built for **Torn PDA**, works in **Tampermonkey** too.

It only reads data and gives advice. **It never buys or sells anything.**

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
- Tap a stock: price chart (1D, 1W, 1M, 1Y, 5Y), 24h/7d/30d change, whether players are buying or selling, and its benefit block.

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

## Coming next
- v0.3: strategy scorecard (tests trading methods on past prices) and practice mode.
- v0.4: alerts, trade plan, fill-amount button on the stock page.
