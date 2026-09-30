// backtest.mjs - replay your model over past windows so you don't have to wait a week.
// Usage: node backtest.mjs [days=7] [out=backtest.json]
//
// Same engine as live, with two honest differences:
//   - Decides 10 minutes before each window starts, using only candles from before then.
//   - No historical order book exists, so it pays the recorded market price + half a cent
//     (the usual spread). Live results are the real test; backtests are easy to fool yourself with.
import fs from 'node:fs';
import { predictUp, MODEL_NAME } from './model.js';
import {
  WINDOW, COINBASE, CLOB, getJSON, getMarket, winnerOf, flatFill, decide,
  newState, placeBets, settle,
} from './lib.js';

const days = +(process.argv[2] || 7);
const out = process.argv[3] || 'backtest.json';
const LEAD = 600;        // decide 10 min before start
const HALF_SPREAD = 0.005;
const now = Math.floor(Date.now() / 1000);
const lastStart = Math.floor(now / WINDOW) * WINDOW - 2 * WINDOW; // fully finished + resolved
const firstStart = lastStart - Math.round(days * 96) * WINDOW + WINDOW;
const starts = [];
for (let s = firstStart; s <= lastStart; s += WINDOW) starts.push(s);
console.log(`backtesting ${starts.length} windows (${days} days)`);

async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const j = i++;
      try { res[j] = await fn(items[j]); } catch (e) { res[j] = { error: e.message }; }
      if (++done % 100 === 0) console.log(`  ${done}/${items.length}`);
    }
  }));
  return res;
}

// 1. BTC candles for the whole period (Coinbase gives 300 per request)
const candleMap = new Map();
const cStart = firstStart - LEAD - 130 * 60, cEnd = lastStart;
const chunks = [];
for (let s = cStart; s < cEnd; s += 300 * 60) chunks.push(s);
await pool(chunks, 3, async s => {
  const iso = x => new Date(x * 1000).toISOString();
  const rows = await getJSON(`${COINBASE}/products/BTC-USD/candles?granularity=60&start=${iso(s)}&end=${iso(Math.min(s + 299 * 60, cEnd))}`);
  for (const [t, low, high, open, close, volume] of rows) candleMap.set(t, { t, open, high, low, close, volume });
});
const candles = [...candleMap.values()].sort((a, b) => a.t - b.t);
console.log(`got ${candles.length} candles`);

// 2. Markets, results, and the market's Up price at decision time
const markets = await pool(starts, 8, async start => {
  const mkt = await getMarket(start);
  if (!mkt) return null;
  const winner = winnerOf(mkt);
  const decideAt = start - LEAD;
  const h = await getJSON(`${CLOB}/prices-history?market=${mkt.tokens[0]}&startTs=${decideAt - 1800}&endTs=${decideAt}&fidelity=1`);
  const pts = (h.history || []).filter(p => p.t <= decideAt);
  const upMid = pts.length ? pts.at(-1).p : null;
  return { ...mkt, winner, upMid, decideAt };
});

// 3. Replay in time order: decisions and settlements interleaved exactly like live
const state = newState('backtest', MODEL_NAME);
state.createdAt = firstStart - LEAD;
state.equity[0].t = firstStart - LEAD;
const events = [];
for (const m of markets) {
  if (!m || m.error || !m.winner || m.upMid == null || m.upMid <= 0.02 || m.upMid >= 0.98) continue;
  events.push({ t: m.decideAt, type: 'decide', m });
  events.push({ t: m.end + 60, type: 'settle', m });
}
events.sort((a, b) => a.t - b.t || (a.type === 'settle' ? -1 : 1));
const byStart = new Map();
let ci = 0;
for (const ev of events) {
  const { m } = ev;
  if (ev.type === 'decide') {
    while (ci < candles.length && candles[ci].t + 60 <= ev.t) ci++;
    const hist = candles.slice(Math.max(0, ci - 120), ci);
    const pUp = predictUp(hist);
    const upAsk = +(m.upMid + HALF_SPREAD).toFixed(3);
    const downAsk = +(1 - m.upMid + HALF_SPREAD).toFixed(3);
    const { bet, best } = decide(pUp, upAsk, downAsk, m.feeRate);
    const round = {
      slug: m.slug, title: m.title, start: m.start, end: m.end, decidedAt: ev.t, leadSec: LEAD,
      btc: hist.at(-1)?.close ?? null, pUp: +pUp.toFixed(4), call: pUp >= 0.5 ? 'Up' : 'Down',
      upAsk, downAsk, upMid: m.upMid, feeRate: m.feeRate,
      bet: bet ? { side: bet.side, ask: bet.ask, cost: +bet.cost.toFixed(4), edge: +bet.edge.toFixed(4), kelly: +bet.kelly.toFixed(4) } : null,
      noBetReason: bet ? null : `best edge ${best ? (best.edge * 100).toFixed(1) + '¢' : 'n/a'} < 1¢ after fees`,
      outcome: null,
    };
    placeBets(state, round, (side, dollars) => flatFill(side === 'Up' ? upAsk : downAsk, dollars, m.feeRate));
    state.rounds.push(round);
    byStart.set(m.start, round);
  } else {
    const r = byStart.get(m.start);
    if (r) settle(state, r, m.winner, ev.t);
  }
}
state.updatedAt = now;
state.runs = 1;
state.backtest = { days, windows: starts.length, used: byStart.size, lead: LEAD, halfSpread: HALF_SPREAD };
fs.writeFileSync(out, JSON.stringify(state));
const f = k => state.banks[k].cash.toFixed(2);
console.log(`done: ${byStart.size} rounds, ${state.rounds.filter(r => r.bet).length} bets`);
console.log(`bankrolls: fixed2 $${f('fixed2')} halfKelly $${f('halfKelly')} kelly $${f('kelly')} yolo75 $${f('yolo75')}`);
