// genome.js - what an evolved model IS, and how it decides.
//
// A genome is a recipe:
//   on[i] / w[i]  which features it pays attention to, and how much (+ = leans Up when feature is high)
//   a             how much it trusts the market's own price (1 = fully, 0 = ignores it)
//   b             a constant lean toward Up (+) or Down (-)
//   minEdge       how many cents of edge (after fees) it demands before betting
//   session/vol   "only bet when..." filters
// Its probability: P(Up) = sigmoid( a * logit(marketPrice) + b + sum(w[i] * feature[i]) )

import { FEATURES, NF, FI } from './features.js';
import { feePerShare } from './lib.js';

export const SESSIONS = ['all', 'us', 'nonus', 'weekday', 'weekend'];
export const VOLS = ['all', 'calm', 'wild'];
export const MAX_FRAC = 0.2; // half-Kelly, capped at 20% of bankroll per bet

// ---------- randomness (seeded, so every run is reproducible) ----------
export function rngFrom(seed) {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  r.pick = arr => arr[Math.floor(r() * arr.length)];
  return r;
}

const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function randomGenome(r) {
  return {
    on: Array.from({ length: NF }, () => r() < 0.3),
    w: Array.from({ length: NF }, () => r.gauss() * 0.08),
    a: clamp(1 + r.gauss() * 0.15, 0, 2),
    b: r.gauss() * 0.02,
    minEdge: 0.005 + r() * 0.035,
    session: r() < 0.6 ? 'all' : r.pick(SESSIONS),
    vol: r() < 0.6 ? 'all' : r.pick(VOLS),
  };
}

export function mutate(g, r) {
  const c = structuredClone(g);
  for (let i = 0; i < NF; i++) {
    if (r() < 0.08) c.on[i] = !c.on[i];
    if (r() < 0.3) c.w[i] = clamp(c.w[i] + r.gauss() * 0.04, -1, 1);
  }
  if (r() < 0.2) c.a = clamp(c.a + r.gauss() * 0.08, 0, 2);
  if (r() < 0.2) c.b = clamp(c.b + r.gauss() * 0.01, -0.3, 0.3);
  if (r() < 0.2) c.minEdge = clamp(c.minEdge + r.gauss() * 0.005, 0.005, 0.08);
  if (r() < 0.05) c.session = r.pick(SESSIONS);
  if (r() < 0.05) c.vol = r.pick(VOLS);
  return c;
}

export function crossover(x, y, r) {
  const c = structuredClone(x);
  for (let i = 0; i < NF; i++) if (r() < 0.5) { c.on[i] = y.on[i]; c.w[i] = y.w[i]; }
  for (const k of ['a', 'b', 'minEdge', 'session', 'vol']) if (r() < 0.5) c[k] = y[k];
  return c;
}

// ---------- deciding ----------
export function gatePass(g, f) {
  const us = f[FI.usHours] === 1, wk = f[FI.weekend] === 1, vr = f[FI.volRegime];
  if (g.session === 'us' && !us) return false;
  if (g.session === 'nonus' && us) return false;
  if (g.session === 'weekday' && wk) return false;
  if (g.session === 'weekend' && !wk) return false;
  if (g.vol === 'calm' && vr > 0) return false;
  if (g.vol === 'wild' && vr <= 0) return false;
  return true;
}

export function pUpOf(g, f, upMid) {
  let z = g.a * logit(clamp(upMid, 0.02, 0.98)) + g.b;
  for (let i = 0; i < NF; i++) if (g.on[i]) z += g.w[i] * f[i];
  return clamp(sigmoid(z), 0.02, 0.98);
}

// Same rule as the main model: bet the side with the most edge after fees, if edge >= minEdge.
export function pickBet(pUp, upAsk, downAsk, rate, minEdge) {
  let best = null;
  for (const [side, q, ask] of [['Up', pUp, upAsk], ['Down', 1 - pUp, downAsk]]) {
    if (ask == null || ask <= 0 || ask >= 1) continue;
    const cost = ask + feePerShare(ask, rate);
    const edge = q - cost;
    if (!best || edge > best.edge) best = { side, ask, cost, edge, kelly: edge > 0 ? edge / (1 - cost) : 0 };
  }
  return best && best.edge >= minEdge ? best : null;
}

export function genomeDecision(g, f, upMid, upAsk, downAsk, rate) {
  const pUp = pUpOf(g, f, upMid);
  const bet = gatePass(g, f) ? pickBet(pUp, upAsk, downAsk, rate, g.minEdge) : null;
  return { pUp, bet };
}

export const betFraction = kelly => Math.min(MAX_FRAC, kelly / 2);

// Score a genome on a set of rows. outcomes[i] = 1 if Up won, 0 if Down.
// growth = log growth of a half-Kelly bankroll (exp(growth)-1 = % gain).
export function evaluate(g, rows, outcomes) {
  let growth = 0, bets = 0, wins = 0, ll = 0, llm = 0, roi = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], y = outcomes[i];
    const pUp = pUpOf(g, r.f, r.upMid);
    ll -= Math.log(y ? pUp : 1 - pUp);
    llm -= Math.log(y ? r.upMid : 1 - r.upMid);
    if (!gatePass(g, r.f)) continue;
    const bet = pickBet(pUp, r.upAsk, r.downAsk, r.fr, g.minEdge);
    if (!bet) continue;
    bets++;
    const won = (bet.side === 'Up') === (y === 1);
    if (won) wins++;
    roi += won ? (1 - bet.cost) / bet.cost : -1; // profit per $1 on a flat bet
    const f = betFraction(bet.kelly);
    growth += won ? Math.log(1 + (f * (1 - bet.cost)) / bet.cost) : Math.log(1 - f);
  }
  return { growth, bets, wins, roi: bets ? roi / bets : 0, llEdge: (llm - ll) / Math.max(1, rows.length) };
}

// ---------- plain-English description ----------
const TREND = new Set(['mom5', 'mom15', 'mom60', 'mom240', 'eth15']);
export function describe(g) {
  const parts = [];
  const genes = FEATURES.map((ft, i) => ({ ...ft, i, w: g.w[i], on: g.on[i] }))
    .filter(x => x.on && Math.abs(x.w) >= 0.02)
    .sort((x, y) => Math.abs(y.w) - Math.abs(x.w));
  let timeDone = false;
  for (const x of genes.slice(0, 4)) {
    const strength = Math.abs(x.w) > 0.25 ? 'strongly ' : Math.abs(x.w) < 0.07 ? 'slightly ' : '';
    if (TREND.has(x.key)) parts.push(`${strength}${x.w > 0 ? 'follows' : 'bets against'} the ${x.label.toLowerCase()}`);
    else if (x.key === 'ethLead') parts.push(`${strength}${x.w > 0 ? 'follows ETH when it moves first' : 'fades ETH when it moves first'}`);
    else if (x.key === 'hourSin' || x.key === 'hourCos') { if (!timeDone) parts.push('has a time-of-day pattern'); timeDone = true; }
    else if (x.key === 'usHours' || x.key === 'weekend') parts.push(`${strength}leans ${x.w > 0 ? 'Up' : 'Down'} during ${x.label}`);
    else if (x.key === 'rangePos') parts.push(`${strength}${x.w > 0 ? 'leans Up near the top of the hourly range (breakouts)' : 'leans Down near the top of the hourly range (pullbacks)'}`);
    else parts.push(`${strength}leans ${x.w > 0 ? 'Up' : 'Down'} when ${x.label.toLowerCase()} is high`);
  }
  if (!parts.length) parts.push('mostly copies the market price');
  const trust = g.a > 1.2 ? 'exaggerates the market\'s lean' : g.a < 0.6 ? 'mostly ignores the market price' : g.a < 0.9 ? 'partly trusts the market price' : 'trusts the market price';
  const sess = { all: '', us: 'only bets during US market hours', nonus: 'only bets outside US market hours', weekday: 'only bets on weekdays', weekend: 'only bets on weekends' }[g.session];
  const vol = { all: '', calm: 'only when the market is calm', wild: 'only when volatility is high' }[g.vol];
  const gate = [sess, vol].filter(Boolean).join(', ');
  return `${parts.join('; ')}. ${trust[0].toUpperCase() + trust.slice(1)}.${gate ? ' ' + gate[0].toUpperCase() + gate.slice(1) + '.' : ''} Needs ${(g.minEdge * 100).toFixed(1)}¢ of edge to bet.`;
}

export const complexity = g => g.on.reduce((s, on, i) => s + (on ? 0.004 + 0.03 * Math.abs(g.w[i]) : 0), 0);
