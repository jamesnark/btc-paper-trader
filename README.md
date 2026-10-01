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

## Evolution (v2): walk-forward, calibration, ensemble, fee-free orders

Once a week (and whenever the evolution code changes), `maybe-evolve.mjs`:

1. **Refreshes the dataset** (`dataset.json.gz`, kept on its own `dataset` branch). It covers about 12 months of 15-minute windows, with the market's Up price every minute from 36 to 3 minutes before each window and the official result. It also has 1-minute candles for BTC and ETH (Coinbase) and BTC perpetual futures (Deribit).
2. **Runs `evolve.mjs`.**
   - Models are genomes over 18 signals: momentum, volatility, range, volume, ETH, time of day, the futures funding cycle, the market's own price drift, the futures premium, and futures-vs-spot lead.
   - Training mixes decisions made 10, 7 and 4 minutes before the window.
   - Fitness rewards *steady weekly* growth: mean minus half the standard deviation of weekly half-Kelly log-growth, minus a complexity penalty.
   - **Walk-forward:** the last 24 weeks are split into 6 blocks of 4 weeks. Each block is traded blind by a model built only from the 26 weeks before it: 22 weeks to evolve 3 tribes, then 4 weeks to calibrate.
   - **Calibration:** the probability is `sigmoid(marketLogit + k × disagreement)`, and k (0 to 2) is fit on the calibration weeks. A k near 0 means "the models' disagreement with the market didn't pay off, so mostly trust the market."
   - **Ensemble:** the champions average their disagreement with the market, and the ensemble bets with a 2¢ minimum edge after fees.
   - **Stats:** profit per $1 with a week-block bootstrap 95% range, the chance the true edge is ≤ 0, profitable weeks, a calibration table, and baselines.
   - **Production:** the same recipe on the newest 26 weeks (5 tribes) produces the ensemble that trades live.
   - **Scrambled-data tribes** show how much training scores overstate skill.
3. **Runs `maker-check.mjs`.** It replays about 3 weeks of blind bets as fee-free orders at the bid, cancelled 3 minutes into the window, against Polymarket's real trade record. A fill only counts when a trade went strictly through our price.

**Arena (`arena.js`):** each evolution run adds the new ensemble twice, once paying fees ("taker") and once with fee-free orders ("maker", filled using the real trades). There are at most 8 members; the worst with 50+ bets is eliminated, otherwise the oldest retires.

## Files

| File | What it is |
| --- | --- |
| `model.js` | **The part you improve.** Takes candles and returns P(Up). |
| `lib.js` | Engine: data fetching, fees, order-book fills, Kelly math, grading |
| `run.mjs` | One live tick (grade and predict) |
| `backtest.mjs` | Replays the last N days: `node backtest.mjs 7 backtest.json` |
| `maybe-backtest.mjs` | Re-runs the backtest automatically when `model.js` changes, or once a day |
| `features.js` | The 18 signals evolved models can use (shared by training and live) |
| `dsio.js` | Compressed dataset read/write |
| `maker-check.mjs` | Fee-free order replay against real trades |
| `genome.js` | What a model is: predict, mutate, crossover, plain-English description |
| `dataset.mjs` | Builds/refreshes the ~12-month dataset (incremental, time-budgeted) |
| `evolve.mjs` | Walk-forward evolution, calibration, ensemble, bootstrap stats |
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
