// lib.js - shared engine used by both the live runner and the backtest.
// Data sources (all public, no keys, no account):
//   Polymarket Gamma API  -> which market, final result
//   Polymarket CLOB API   -> live order book (real prices you'd pay)
//   Coinbase Exchange API -> 1-minute BTC candles for the model

export const GAMMA = 'https://gamma-api.polymarket.com';
export const CLOB = 'https://clob.polymarket.com';
export const COINBASE = 'https://api.exchange.coinbase.com';

export const WINDOW = 900;          // 15 minutes
export const START_BANK = 1000;     // pretend dollars per bankroll
export const MIN_SHARES = 5;        // Polymarket minimum order size
export const MIN_EDGE = 0.01;       // need 1 cent of edge per share AFTER fees to bet
export const FLAT_STAKE = 10;       // flat $10 bets used to compare models fairly
export const DEFAULT_FEE_RATE = 0.07; // crypto markets: fee = shares * 0.07 * p * (1-p)

// The four bet-sizing rules, all fed the exact same predictions.
// k = Kelly fraction for that bet (how much of your bankroll the math says to risk).
export const SIZERS = {
  fixed2:    { label: 'Fixed 2%',      color: '#2e7d32', frac: () => 0.02 },
  halfKelly: { label: 'Half Kelly',    color: '#1565c0', frac: k => k / 2 },
  kelly:     { label: 'Full Kelly',    color: '#8e24aa', frac: k => k },
  yolo75:    { label: '75% every bet', color: '#d84315', frac: () => 0.75 },
};

// Models compared on flat $10 bets. "mine" only bets when it sees an edge;
// the baselines bet every single window, so they show what "no skill" looks like.
export const CALLERS = {
  mine:     'Your model',
  alwaysUp: 'Always pick Up',
  coin:     'Coin flip',
  favorite: 'Follow the market favorite',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function getJSON(url, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'btc-paper-trader (educational, no trading)' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) { err = e; await sleep(800 * (i + 1)); }
  }
  throw err;
}

export const slugFor = start => `btc-updown-15m-${start}`;
export const feePerShare = (p, rate = DEFAULT_FEE_RATE) => rate * p * (1 - p);

export async function getMarket(start) {
  const ev = await getJSON(`${GAMMA}/events?slug=${slugFor(start)}`);
  if (!Array.isArray(ev) || !ev.length || !ev[0].markets?.length) return null;
  const m = ev[0].markets[0];
  return {
    slug: slugFor(start),
    title: m.question,
    conditionId: m.conditionId,
    start,
    end: start + WINDOW,
    outcomes: JSON.parse(m.outcomes || '["Up","Down"]'),
    tokens: JSON.parse(m.clobTokenIds || '[]'),
    feeRate: m.feeSchedule?.rate ?? DEFAULT_FEE_RATE,
    closed: !!m.closed,
    outcomePrices: JSON.parse(m.outcomePrices || '[]').map(Number),
  };
}

// Official result: after the window closes Polymarket sets the winner to 1 and loser to 0.
export function winnerOf(mkt) {
  if (!mkt || !mkt.closed) return null;
  const [a, b] = mkt.outcomePrices;
  if (a >= 0.99) return mkt.outcomes[0];
  if (b >= 0.99) return mkt.outcomes[1];
  return null;
}

export async function getBook(token) {
  const b = await getJSON(`${CLOB}/book?token_id=${token}`);
  const asks = (b.asks || []).map(x => [+x.price, +x.size]).sort((x, y) => x[0] - y[0]);
  const bids = (b.bids || []).map(x => [+x.price, +x.size]).sort((x, y) => y[0] - x[0]);
  return { asks, bids, bestAsk: asks[0]?.[0] ?? null, bestBid: bids[0]?.[0] ?? null };
}

// Pretend to buy `dollars` worth by walking up the real order book
// (big bets get worse prices, just like real life). Fee included.
export function fillFromBook(asks, dollars, rate) {
  let left = dollars, shares = 0, cost = 0;
  for (const [p, size] of asks) {
    const per = p + feePerShare(p, rate);
    const take = Math.min(size, left / per);
    if (take <= 0) break;
    shares += take; cost += take * per; left -= take * per;
    if (left < 1e-9) break;
  }
  return { shares, cost, avgPrice: shares ? cost / shares : null };
}

// Backtest has no historical order book, so it fills everything at one price.
export function flatFill(price, dollars, rate) {
  const per = price + feePerShare(price, rate);
  return { shares: dollars / per, cost: dollars, avgPrice: per };
}

// 1-minute candles that fully closed before `endTs`.
export async function getCandles(endTs, minutes = 120, product = 'BTC-USD') {
  // Coinbase returns at most 300 candles per request, so longer spans are fetched in pieces.
  const iso = s => new Date(s * 1000).toISOString();
  const startTs = endTs - minutes * 60;
  const parts = [];
  for (let a = startTs; a < endTs; a += 300 * 60) parts.push([a, Math.min(a + 299 * 60, endTs)]);
  const rows = (await Promise.all(parts.map(([a, b]) =>
    getJSON(`${COINBASE}/products/${product}/candles?granularity=60&start=${iso(a)}&end=${iso(b)}`)))).flat();
  const byT = new Map(rows.map(([t, low, high, open, close, volume]) => [t, { t, open, high, low, close, volume }]));
  return [...byT.values()].filter(c => c.t + 60 <= endTs).sort((a, b) => a.t - b.t);
}

// Should the model bet, and on which side?
export function decide(pUp, upAsk, downAsk, rate) {
  const sides = [
    { side: 'Up', q: pUp, ask: upAsk },
    { side: 'Down', q: 1 - pUp, ask: downAsk },
  ].filter(s => s.ask != null && s.ask > 0 && s.ask < 1).map(s => {
    const cost = s.ask + feePerShare(s.ask, rate);   // true price per share incl. fee
    const edge = s.q - cost;                          // expected profit per share
    const kelly = edge > 0 ? edge / (1 - cost) : 0;   // Kelly fraction for a binary bet
    return { ...s, cost, edge, kelly };
  });
  sides.sort((a, b) => b.edge - a.edge);
  const best = sides[0];
  if (!best || best.edge < MIN_EDGE) return { bet: null, best };
  return { bet: best, best };
}

// Deterministic "coin flip" so the baseline can't be re-rolled.
export function coinFor(slug) {
  let h = 2166136261;
  for (const ch of slug) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2 === 0 ? 'Up' : 'Down';
}

export function newState(mode, modelName) {
  const now = Math.floor(Date.now() / 1000);
  return {
    mode, model: modelName, createdAt: now, updatedAt: now,
    config: { START_BANK, MIN_EDGE, FLAT_STAKE, MIN_SHARES, WINDOW },
    banks: Object.fromEntries(Object.keys(SIZERS).map(k => [k, { cash: START_BANK }])),
    rounds: [],
    equity: [{ t: now, ...Object.fromEntries(Object.keys(SIZERS).map(k => [k, START_BANK])) }],
    runs: 0, errors: [],
  };
}

// Place all pretend bets for one round. `fill(side, dollars)` returns {shares, cost}.
export function placeBets(state, round, fill) {
  round.stakes = {};
  round.flat = {};
  if (round.bet) {
    for (const k of Object.keys(SIZERS)) {
      const bank = state.banks[k];
      let frac = Math.max(0, Math.min(1, SIZERS[k].frac(round.bet.kelly)));
      let dollars = bank.cash * frac;
      const minCost = MIN_SHARES * round.bet.cost;
      if (dollars < minCost) {
        if (bank.cash >= minCost && frac > 0) dollars = minCost; // round up to the minimum order
        else { round.stakes[k] = { skipped: bank.cash < minCost ? 'broke' : 'zero' }; continue; }
      }
      const f = fill(round.bet.side, dollars);
      if (!f.shares) { round.stakes[k] = { skipped: 'no liquidity' }; continue; }
      bank.cash -= f.cost;
      round.stakes[k] = { cost: +f.cost.toFixed(4), shares: +f.shares.toFixed(4) };
    }
  }
  const sides = { alwaysUp: 'Up', coin: coinFor(round.slug), favorite: round.upMid >= 0.5 ? 'Up' : 'Down' };
  if (round.bet) sides.mine = round.bet.side;
  for (const [who, side] of Object.entries(sides)) {
    const f = fill(side, FLAT_STAKE);
    if (f.shares) round.flat[who] = { side, cost: +f.cost.toFixed(4), shares: +f.shares.toFixed(4) };
  }
}

export function pendingStake(state, k) {
  return state.rounds.filter(r => !r.outcome && r.stakes?.[k]?.cost).reduce((a, r) => a + r.stakes[k].cost, 0);
}

export function snapshotEquity(state, t) {
  const pt = { t };
  for (const k of Object.keys(SIZERS)) pt[k] = +(state.banks[k].cash + pendingStake(state, k)).toFixed(2);
  state.equity.push(pt);
}

// Grade a round once the official result is known. outcome = 'Up' | 'Down' | 'void'.
export function settle(state, round, outcome, t) {
  round.outcome = outcome;
  round.gradedAt = t;
  for (const [k, s] of Object.entries(round.stakes || {})) {
    if (!s.cost) continue;
    const payout = outcome === 'void' ? s.cost : (round.bet.side === outcome ? s.shares : 0);
    s.payout = +payout.toFixed(4);
    state.banks[k].cash += payout;
  }
  for (const f of Object.values(round.flat || {})) {
    const payout = outcome === 'void' ? f.cost : (f.side === outcome ? f.shares : 0);
    f.pnl = +(payout - f.cost).toFixed(4);
  }
  snapshotEquity(state, t);
}

// ---------- fee-free ("maker") order simulation ----------
// Instead of buying at the ask and paying the fee, post a buy order at the bid and wait.
// You only get filled if someone else trades THROUGH your price, which tends to happen
// right when the price is moving against you. We count a fill only when a real trade
// happened at a strictly worse price than ours (conservative: being at the same price
// isn't enough, since others were in the queue first). No fee, and we ignore the rebate.
export const DATA_API = 'https://data-api.polymarket.com';
export async function getTrades(conditionId, maxPages = 8) {
  const all = [];
  for (let off = 0; off < maxPages * 500; off += 500) {
    let page;
    try { page = await getJSON(`${DATA_API}/trades?market=${conditionId}&limit=500&offset=${off}`, 3); }
    catch (e) { if (off) break; throw e; }
    all.push(...page);
    if (page.length < 500) break;
  }
  return all;
}
// Shares that traded through a resting buy order at `limit` on `token` between t0 and t1.
// Buying Down at q is the mirror of selling Up at 1-q, so both tokens count.
export function makerFillVolume(trades, token, otherToken, limit, t0, t1) {
  let vol = 0;
  for (const tr of trades) {
    if (tr.timestamp < t0 || tr.timestamp > t1) continue;
    const price = +tr.price;
    if (tr.asset === token && price < limit - 1e-9) vol += +tr.size;
    else if (tr.asset === otherToken && price > 1 - limit + 1e-9) vol += +tr.size;
  }
  return vol;
}
export const MAKER_CANCEL_AFTER = 180; // order rests until 3 minutes into the window, then is cancelled
