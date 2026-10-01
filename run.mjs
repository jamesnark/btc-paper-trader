// run.mjs - one "tick" of the live paper trader. GitHub Actions runs this every 5 minutes.
//   1. Grade any finished windows using Polymarket's official result.
//   2. If the next 15-minute window has no prediction yet, predict it and place pretend bets
//      against the REAL live order book (real prices, real fees, no real money).
// Usage: node run.mjs path/to/state.json
import fs from 'node:fs';
import path from 'node:path';
import { predictUp, MODEL_NAME } from './model.js';
import { computeFeatures, alignMinutes } from './features.js';
import { syncArena, arenaBets, arenaSettle, hasMakerOrders } from './arena.js';
import {
  WINDOW, CLOB, getJSON, getMarket, winnerOf, getBook, fillFromBook, getCandles, decide,
  newState, placeBets, settle, snapshotEquity, getTrades, makerFillVolume, MAKER_CANCEL_AFTER,
} from './lib.js';

async function getPerpCandles(endTs, minutes) {
  const r = await getJSON(`https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&resolution=1&start_timestamp=${(endTs - minutes * 60) * 1000}&end_timestamp=${endTs * 1000}`);
  const x = r.result || {};
  return (x.ticks || []).map((ms, i) => ({ t: ms / 1000, close: x.close[i], volume: 0 })).filter(c => c.t + 60 <= endTs);
}
// The market's own Up price now and 20 minutes ago (same price series the models trained on)
async function getUpDrift(token, now) {
  const h = await getJSON(`${CLOB}/prices-history?market=${token}&startTs=${now - 2400}&endTs=${now}&fidelity=1`);
  const pts = (h.history || []).sort((a, b) => a.t - b.t);
  const at = t => { let p = null; for (const x of pts) if (x.t <= t) p = x.p; return p; };
  return { upNow: at(now), upPast: at(now - 1200) };
}

const file = process.argv[2] || 'state.json';
const now = Math.floor(Date.now() / 1000);
let state;
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = null; }
if (!state || !state.rounds) state = newState('live', MODEL_NAME);
state.model = MODEL_NAME;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const errors = [];

// 0. Arena: bring in new champions / eliminate the weakest when a new evolution run lands
try {
  const evoPath = path.join(path.dirname(file), 'evolution.json');
  if (fs.existsSync(evoPath)) for (const m of syncArena(state, JSON.parse(fs.readFileSync(evoPath, 'utf8')), now)) log('arena', m);
} catch (e) { errors.push(`arena sync: ${e.message}`); }

// 1. Grade finished rounds
for (const r of state.rounds.filter(r => !r.outcome && now >= r.end)) {
  try {
    const mkt = await getMarket(r.start);
    const w = winnerOf(mkt);
    if (w) {
      let fillVol = null;
      if (hasMakerOrders(r)) { // fee-free orders: check real trades to see whether they would have filled
        const trades = await getTrades(mkt.conditionId);
        const [upTok, downTok] = mkt.tokens;
        fillVol = a => makerFillVolume(trades, a.side === 'Up' ? upTok : downTok, a.side === 'Up' ? downTok : upTok, a.limit, r.decidedAt, r.start + MAKER_CANCEL_AFTER);
      }
      settle(state, r, w, now); arenaSettle(state, r, w, now, fillVol); log('graded', r.slug, '->', w);
    }
    else if (now > r.end + 6 * 3600) { settle(state, r, 'void', now); arenaSettle(state, r, 'void', now); log('voided (no result after 6h)', r.slug); }
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
    const [candles, ethCandles, perpCandles, drift] = await Promise.all([
      getCandles(now, 320), getCandles(now, 320, 'ETH-USD'),
      getPerpCandles(now, 320).catch(() => []), getUpDrift(mkt.tokens[0], now).catch(() => ({})),
    ]);
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
      imb: (() => { // order-book imbalance on the Up side (logged for future models)
        const sz = a => a.slice(0, 5).reduce((t, x) => t + x[1], 0);
        const b = sz(upBook.bids), a = sz(upBook.asks);
        return b + a ? +((b - a) / (b + a)).toFixed(3) : null;
      })(),
      bet: bet ? { side: bet.side, ask: bet.ask, cost: +bet.cost.toFixed(4), edge: +bet.edge.toFixed(4), kelly: +bet.kelly.toFixed(4) } : null,
      noBetReason: bet ? null : `best edge ${best ? (best.edge * 100).toFixed(1) + '¢' : 'n/a'} < 1¢ after fees`,
      outcome: null,
    };
    const fillFn = (side, dollars) => fillFromBook(side === 'Up' ? upBook.asks : downBook.asks, dollars, mkt.feeRate);
    placeBets(state, round, fillFn);
    // Arena: every evolved model makes its own call on the same window
    if (state.arena?.members?.length && upMid != null) {
      const last = Math.floor(now / 60) * 60 - 60; // last minute that fully closed
      const g = alignMinutes({ btc: candles, eth: ethCandles, perp: perpCandles }, last, 300);
      const f = computeFeatures(g.btc.c, g.btc.v, g.eth.c, mkt.start, {
        perpC: perpCandles.length > 200 ? g.perp.c : null, upNow: drift.upNow, upPast: drift.upPast,
      });
      round.features = f ? f.map(x => +x.toFixed(3)) : null;
      if (f) arenaBets(state, round, f, { Up: upBook, Down: downBook }, fillFn);
      else errors.push('arena: not enough candles for features');
    }
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
