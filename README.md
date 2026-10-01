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

## Evolution and the arena

Once a week (and whenever the evolution code changes), the workflow:

1. **Refreshes `dataset.json`**: 5 weeks of windows (market price 10 minutes before the start, plus the official result) and 1-minute BTC and ETH candles.
2. **Runs `evolve.mjs`**. Each model is a genome: which of 13 signals it watches and how much (momentum, volatility, range position, volume, ETH, time of day...), how much it trusts the market price, a minimum edge, and "only bet when..." filters.
   - 5 tribes × 80 models × 40 generations, evolved on everything **except the most recent 7 days**.
   - Fitness = log growth of a half-Kelly bankroll after fees, minus a small complexity penalty.
   - **Sealed test week:** the champions are scored on the last 7 days, which selection never sees.
   - **Permutation test:** the test week's results are reshuffled 2,000 times to get a p-value. Because there are 5 tribes, "survived" means p < 0.01.
   - **Scrambled-data tribes:** 5 extra tribes evolve on shuffled results. Their training scores show how much evolution can fool itself.
3. **Arena (`arena.js`)**: champions trade live with $1,000 each (half-Kelly, max 20% per bet). On each new evolution run, the worst member with 50+ bets (or anyone broke) is eliminated and replaced by the best new champion.

## Files

| File | What it is |
| --- | --- |
| `model.js` | **The part you improve.** Takes candles and returns P(Up). |
| `lib.js` | Engine: data fetching, fees, order-book fills, Kelly math, grading |
| `run.mjs` | One live tick (grade and predict) |
| `backtest.mjs` | Replays the last N days: `node backtest.mjs 7 backtest.json` |
| `maybe-backtest.mjs` | Re-runs the backtest automatically when `model.js` changes, or once a day |
| `features.js` | The 13 signals evolved models can use (shared by training and live) |
| `genome.js` | What a model is: predict, mutate, crossover, plain-English description |
| `dataset.mjs` | Builds/refreshes the 5-week dataset (incremental) |
| `evolve.mjs` | Tribes, sealed test week, permutation test, scrambled-data tribes |
| `maybe-evolve.mjs` | Runs the above weekly or when the code changes |
| `arena.js` | Live competition between champions, weekly elimination |
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
