// run.mjs - one "tick" of the live paper trader. GitHub Actions runs this every 5 minutes.
//   1. Grade any finished windows using Polymarket's official result.
//   2. If the next 15-minute window has no prediction yet, predict it and place pretend bets
//      against the REAL live order book (real prices, real fees, no real money).
// Usage: node run.mjs path/to/state.json
import fs from 'node:fs';
import { predictUp, MODEL_NAME } from './model.js';
import {
  WINDOW, getMarket, winnerOf, getBook, fillFromBook, getCandles, decide,
  newState, placeBets, settle, snapshotEquity,
} from './lib.js';

const file = process.argv[2] || 'state.json';
const now = Math.floor(Date.now() / 1000);
let state;
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = null; }
if (!state || !state.rounds) state = newState('live', MODEL_NAME);
state.model = MODEL_NAME;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const errors = [];

// 1. Grade finished rounds
for (const r of state.rounds.filter(r => !r.outcome && now >= r.end)) {
  try {
    const w = winnerOf(await getMarket(r.start));
    if (w) { settle(state, r, w, now); log('graded', r.slug, '->', w); }
    else if (now > r.end + 6 * 3600) { settle(state, r, 'void', now); log('voided (no result after 6h)', r.slug); }
    else log('waiting for result', r.slug);
  } catch (e) { errors.push(`grade ${r.slug}: ${e.message}`); }
}

// 2. Predict the next window
const next = Math.floor(now / WINDOW) * WINDOW + WINDOW;
if (!state.rounds.some(r => r.start === next)) {
  try {
    const mkt = await getMarket(next);
    if (!mkt) throw new Error('market not listed yet');
    const [upBook, downBook] = await Promise.all(mkt.tokens.map(getBook));
    const candles = await getCandles(now, 120);
    const pUp = predictUp(candles);
    const upMid = upBook.bestBid != null && upBook.bestAsk != null ? (upBook.bestBid + upBook.bestAsk) / 2 : null;
    const { bet, best } = decide(pUp, upBook.bestAsk, downBook.bestAsk, mkt.feeRate);
    const round = {
      slug: mkt.slug, title: mkt.title, start: mkt.start, end: mkt.end, model: MODEL_NAME,
      decidedAt: now, leadSec: mkt.start - now,
      btc: candles.at(-1)?.close ?? null,
      pUp: +pUp.toFixed(4), call: pUp >= 0.5 ? 'Up' : 'Down',
      upAsk: upBook.bestAsk, downAsk: downBook.bestAsk, upMid,
      feeRate: mkt.feeRate,
      bet: bet ? { side: bet.side, ask: bet.ask, cost: +bet.cost.toFixed(4), edge: +bet.edge.toFixed(4), kelly: +bet.kelly.toFixed(4) } : null,
      noBetReason: bet ? null : `best edge ${best ? (best.edge * 100).toFixed(1) + '¢' : 'n/a'} < 1¢ after fees`,
      outcome: null,
    };
    placeBets(state, round, (side, dollars) =>
      fillFromBook(side === 'Up' ? upBook.asks : downBook.asks, dollars, mkt.feeRate));
    state.rounds.push(round);
    snapshotEquity(state, now);
    log('predicted', round.slug, `P(up)=${round.pUp}`, round.bet ? `BET ${round.bet.side} @ ${round.bet.ask}` : `no bet (${round.noBetReason})`);
  } catch (e) { errors.push(`predict ${next}: ${e.message}`); }
}

state.runs = (state.runs || 0) + 1;
state.updatedAt = now;
state.errors = [...errors.map(m => ({ t: now, m })), ...(state.errors || [])].slice(0, 20);
errors.forEach(m => log('ERROR', m));
fs.writeFileSync(file, JSON.stringify(state));
log(`saved ${state.rounds.length} rounds`);
