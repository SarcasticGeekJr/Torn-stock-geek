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

**API key:** a **Limited** key is needed for the Mine tab (your shares). A Public key is enough for the Advisor and Money tabs. The Trade tab works without a key.

## What it does

Tap the 📈 button (you can drag it).

**Advisor**
- Every stock's **next benefit block**, ranked by **yearly return**.
- Shows the cost, what it pays (valued at item market price), and how many days until it pays for itself.
- Compares each block with the **bank**: Torn's Investment Bank rates are loaded for you (add your Bank Interest merits in ⚙; the TCI block is counted automatically).
- Payouts it can't price (like a random property) get a **Set value** button.
- Perks (passive blocks): set what a perk is worth to you to rank it.

**💰 Money** (what should I do with my cash?)
- Type how much you can invest now (e.g. `20m`) and pick a period: 1 week, 1 month, 3 months or 1 year.
- It shows what your **whole amount** would earn in each option, with the **best one on top**:
  - 🏦 Bank: Torn's real rate (with your merits and TCI), using the best term for the period.
  - 🎯 Benefit blocks: only when they beat the bank (the rest goes to the bank). Shows exactly what to buy.
  - 📈 Swing trade: the best stock in the buy zone now: the price to buy at, the price to sell at, the profit it made last year in similar cases, and a **🔔 Remind me at buy & sell zone** button.
  - 📊 Just holding a stock: the profit or loss it made last year.
  - ✖ Day trading: ≈ $0, because Torn prices move less in an hour than the 0.1% fee.
- It never splits your money unless the split really earns more (a block that beats the bank, or money over the bank's $2b limit).
- If you can't afford a good block yet, it shows the cheapest one and how much more you need.

**Trade** (charts and signals, no key needed)
- Every stock with its place in the **last 20 days' price range**: 🟢 buy zone (bottom 10%), 🔴 sell zone (top 10%), ⚪ wait.
- How that swing rule did on each stock in the last year (trades won).
- Sort by nearest buy zone or by best swing record.
- Tap a stock: price chart (1D, 1W, 1M, 1Y, 5Y), 24h/7d/30d change, whether players are buying or selling, and its benefit block.
- **Strategy scorecard** on each stock: what swing (20 and 10 days), dip buying (RSI), trend following, just holding, and the bank would have made in the last year after fees, plus a **day trading test** on hourly prices.

- **Swing trade plan** on each stock: how many shares for your amount, a target (sell zone) and a stop-loss, what you'd make or lose, break-even after the fee, and one tap to set alerts at both.

**🔔 Alerts**
- Per stock: price above / below, or when it enters the swing buy or sell zone.
- Zone reminders come with a one-line warning in prices, from that stock's last year, e.g. "It could still drop: last year it usually went down to about $323.68 (lowest $314.60) before bouncing." The same line shows on the stock's page.
- Benefit payout ready to collect (Limited key).
- A banner on any Torn page, a badge on the 📈 button, and a vibration. Checked once a minute **while a Torn page is open** (on your phone or a computer).
- **📲 Phone notifications with ntfy** (free app, no account): ⚙ Settings → tap **New** for a private topic, subscribe to it in the ntfy app, tap **Send test**. Every alert then also arrives as a phone notification. Alerts are only checked while Torn is open somewhere; your phone may pause Torn PDA in the background, so leave Torn open in a browser on a computer to get them while you're away.

**📈 Fill shares (on Torn's stock market page)**
- Open a stock's BUY or SELL panel: under Torn's shares box you get buttons like "Plan $100m: 114,429", "For block 2: 1,000,000" or "All but blocks: 100,000". Tapping one only types the number. You still press BUY/SELL and confirm.

**🛡 Park cash safely** (Money tab)
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
- **Day trading** (minutes or hours) lost money on every stock. A typical hour moves 0.05%, a typical day 0.25%; the fee is 0.1%. Of 864 short-term rules tested on 2 months of 5-minute prices, the best made +0.09% in a month.
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
