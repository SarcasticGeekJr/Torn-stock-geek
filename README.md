# Torn Stock Geek

A stock advisor for [Torn](https://www.torn.com). It tells you which stock benefit blocks pay the most for your money, plans what to buy with your cash, and tracks your portfolio. Built for **Torn PDA**, works in **Tampermonkey** too.

It only reads data and gives advice. **It never buys or sells anything.**

## Install

**Torn PDA:** Settings → Userscripts → **+** → Remote load/update → paste this link → Configure:

```
https://raw.githubusercontent.com/SarcasticGeekJr/torn-stock-geek/main/torn-stock-geek.user.js
```

- Injection time: **END**.
- When PDA asks about the API key, tap **Add** to use your PDA key.
- **Tampermonkey:** open the link above and click Install. Then paste a key in ⚙ Settings.

**API key:** a **Limited** key is needed for the Portfolio tab (your shares). A Public key is enough for the Advisor and Planner tabs.

## What it does (v0.1)

Tap the 📈 button (you can drag it).

**Advisor**
- Every stock's **next benefit block**, ranked by **yearly return**.
- Shows the cost, what it pays (valued at item market price), and how many days until it pays for itself.
- Compares each block with your **bank rate** (set it in ⚙).
- Payouts it can't price (like a random property) get a **Set value** button.
- Perks (passive blocks): set what a perk is worth to you to rank it.

**Planner**
- Type your cash (e.g. `2.5b`). It lists the best blocks you can afford, in order, and the yearly payouts you'd get.
- Says what to do with the leftover (bank, or save toward a block).

**Portfolio**
- Value, profit/loss, and yearly payouts of everything you own.
- Per stock: average buy price, **break-even price after the 0.1% sell fee**, blocks held, shares needed for the next block.
- Payouts ready to collect.
- **"You can sell up to X shares and keep your blocks"** warning.

## How Torn stocks work (short)
- Buying is free; selling costs **0.1%**. One price for buying and selling.
- Prices change every minute.
- Each extra block of the same stock costs **double** the shares of the one before, so it earns about half the return.
- Perks (passive) need one block, held for 7 days.

## Coming next
- v0.2: price charts and simple buy/sell signals (price history from Tornsy).
- v0.3: strategy scorecard (tests trading methods on past prices) and practice mode.
- v0.4: alerts, trade plan, fill-amount button on the stock page.
