# BTC Paper Trader

Predicts every 15-minute Polymarket "Bitcoin Up or Down" window, makes **pretend** bets at real prices with real fees, and grades itself when the window closes. It never places a real bet and doesn't need an account or API keys.

**Dashboard:** https://jamesnark.github.io/btc-paper-trader/

## How it works

Every 5 minutes GitHub Actions runs `run.mjs`:

1. **Grade.** For any window that has ended, it fetches Polymarket's official result (Up or Down) and pays out the pretend bets.
2. **Predict.** If the next window has no prediction yet, it:
   - gets the last 2 hours of 1-minute BTC candles from Coinbase
   - asks `model.js` for P(Up)
   - reads the real live order book
   - bets only if the model's probability beats the price plus the fee by at least 1¢ per share
3. **Save.** Everything is written to `state.json` on the `data` branch, and the dashboard reads it from there.

The same predictions run through four bet-sizing rules, each starting with $1,000: **Fixed 2%**, **Half Kelly**, **Full Kelly** and **75% every bet**. Three no-skill baselines bet every window with $10 flat stakes for comparison:

- always pick Up
- coin flip
- follow the market favorite

## Files

| File | What it is |
| --- | --- |
| `model.js` | **The part you improve.** Takes candles and returns P(Up). |
| `lib.js` | Engine: data fetching, fees, order-book fills, Kelly math, grading |
| `run.mjs` | One live tick (grade and predict) |
| `backtest.mjs` | Replays the last N days: `node backtest.mjs 7 backtest.json` |
| `maybe-backtest.mjs` | Re-runs the backtest automatically when `model.js` changes, or once a day |
| `index.html` | Dashboard (GitHub Pages) |
| `.github/workflows/tick.yml` | The every-5-minutes schedule |

## Rules that keep it honest

- The model only sees candles that closed **before** it decides. There's no peeking.
- Fees follow Polymarket's crypto formula: `shares × 0.07 × price × (1 − price)`.
- Live bets walk the real order book, so big bets get worse prices.
- Results come from Polymarket's official resolution, not our own price feed.
- The backtest has no historical order book, so it uses the recorded price plus half a cent. Trust live results more.

## Testing a new model

1. Edit `model.js` (in the GitHub web editor is fine) and commit.
2. Within about 5 minutes the backtest re-runs on the past 7 days and the dashboard's Backtest tab updates.
3. Live results keep accumulating. Each round records which model made it.

If you want a clean live slate after a big model change, delete the `data` branch and the next run starts fresh.

## Run locally

```
node run.mjs state.json
node backtest.mjs 7 backtest.json
```

Needs Node 18+. There are no dependencies.
