// evolve.mjs (v2) - evolution with walk-forward testing, calibration and an ensemble.
// Usage: node evolve.mjs out/dataset.json.gz out/evolution.json
//
// WALK-FORWARD: the last 24 weeks are split into 6 test blocks of 4 weeks. For each block we
// pretend it's the day before that block starts: evolve on the 22 weeks before it, calibrate on
// the 4 weeks right before it, then trade the block blind. Stitching the 6 blocks together gives
// ~24 weeks of honest, never-seen results ("out-of-sample", OOS).
//
// PRODUCTION: the same recipe on the most recent data produces the ensemble that trades live.
import fs from 'node:fs';
import { computeFeatures, NF, FI } from './features.js';
import { rngFrom, randomGenome, mutate, crossover, complexity, describe, calibrationNote, MAX_FRAC } from './genome.js';
import { loadDataset, priceAt } from './dsio.js';

const dsPath = process.argv[2] || 'dataset.json.gz';
const out = process.argv[3] || 'evolution.json';
const P = {
  WEEK: 604800, TEST_WEEKS: 4, FOLDS: 6, TRAIN_WEEKS: 22, CALIB_WEEKS: 4,
  LEADS: [600, 420, 240], HALF_SPREAD: 0.005, FEE: 0.07, ENS_MIN_EDGE: 0.02,
  FOLD: { POP: 60, GENS: 30, TRIBES: 3 }, PROD: { POP: 80, GENS: 40, TRIBES: 5 }, NULLS: 3,
  ELITE: 0.1, TOURN: 3, CROSS: 0.7, MIN_BETS_PER_WEEK: 15, BOOT: 5000,
};
const T1 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T1) / 1000).toFixed(1)}s]`, ...a);

// ---------------- rows ----------------
const ds = loadDataset(dsPath);
if (!ds) throw new Error('no dataset');
const { t0, btcC, btcV, ethC, perpC, lastReal } = ds.candles;
const tmp = [];
// DROP_DAYS (robustness checks): pretend the data ends N days earlier.
const cutoff = (ds.windows.at(-1)?.s ?? 0) - (+(process.env.DROP_DAYS || 0)) * 86400;
for (const w of ds.windows) {
  if (w.o == null || !w.h || w.s > cutoff) continue;
  const lead = P.LEADS[Math.floor(w.s / 900) % P.LEADS.length]; // mix of 10, 7 and 4 minutes early
  const at = w.s - lead;
  if (at > (lastReal ?? Infinity) + 60) continue;
  const up = priceAt(w, at);
  if (up == null || up < 0.03 || up > 0.97) continue;
  const end = Math.round((at - 60 - t0) / 60); // last candle that closed by `at`
  if (end - 299 < 0 || end >= btcC.length) continue;
  const sl = a => a.subarray(end - 299, end + 1);
  const f = computeFeatures(sl(btcC), sl(btcV), sl(ethC), w.s, { perpC: perpC ? sl(perpC) : null, upNow: up, upPast: priceAt(w, at - 1200) });
  if (!f) continue;
  tmp.push({ s: w.s, lead, f, mid: up, o: w.o });
}
tmp.sort((a, b) => a.s - b.s);
const n = tmp.length;
const F = new Float64Array(n * NF), L = new Float64Array(n), MID = new Float64Array(n), CU = new Float64Array(n), CD = new Float64Array(n);
const S = new Float64Array(n), LEAD = new Int32Array(n), Y = new Uint8Array(n), WK = new Int32Array(n);
const END = tmp[n - 1].s + 900;
const W = Math.floor((END - 1 - tmp[0].s) / P.WEEK) + 1;
const fee = p => P.FEE * p * (1 - p);
tmp.forEach((r, i) => {
  F.set(r.f, i * NF); MID[i] = r.mid; L[i] = Math.log(r.mid / (1 - r.mid));
  const ua = Math.min(0.99, r.mid + P.HALF_SPREAD), da = Math.min(0.99, 1 - r.mid + P.HALF_SPREAD);
  CU[i] = ua + fee(ua); CD[i] = da + fee(da);
  S[i] = r.s; LEAD[i] = r.lead; Y[i] = r.o; WK[i] = W - 1 - Math.floor((END - 1 - r.s) / P.WEEK);
});
const weekStart = wk => END - (W - wk) * P.WEEK;
const rowAtWeek = wk => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (WK[m] < wk) lo = m + 1; else hi = m; } return lo; };
log(`${n} rows over ${W} weeks (${new Date(tmp[0].s * 1000).toISOString().slice(0, 10)} to ${new Date(END * 1000).toISOString().slice(0, 10)})`);

// ---------------- fast scoring ----------------
const sigmoid = z => 1 / (1 + Math.exp(-z));
const iUS = FI.usHours, iWE = FI.weekend, iVR = FI.volRegime;
function gateOk(g, i) {
  if (g.session !== 'all') {
    const us = F[i * NF + iUS] === 1, wk = F[i * NF + iWE] === 1;
    if (g.session === 'us' && !us) return false;
    if (g.session === 'nonus' && us) return false;
    if (g.session === 'weekday' && wk) return false;
    if (g.session === 'weekend' && !wk) return false;
  }
  if (g.vol !== 'all') { const vr = F[i * NF + iVR]; if (g.vol === 'calm' && vr > 0) return false; if (g.vol === 'wild' && vr <= 0) return false; }
  return true;
}
// deviation from the market in log-odds (NaN = filters say no bet)
function devOf(g, i) {
  if (!gateOk(g, i)) return NaN;
  let z = g.a * L[i] + g.b; const base = i * NF;
  for (let j = 0; j < g.w.length; j++) if (g.on[j]) z += g.w[j] * F[base + j];
  return z - L[i];
}
const wkBuf = new Float64Array(W);
// Generic bettor over rows [lo,hi): p = sigmoid(L + k*dev). Returns stats; optionally the bet list.
function trade(devFn, k, minEdge, lo, hi, Yv, collect = false) {
  if (hi <= lo) return { bets: 0, wins: 0, roi: 0, growth: 0, mean: 0, sd: 0, nW: 0, list: [] };
  const w0 = WK[lo], w1 = WK[hi - 1];
  wkBuf.fill(0, w0, w1 + 1);
  let bets = 0, wins = 0, roiSum = 0, growth = 0; const list = collect ? [] : null;
  for (let i = lo; i < hi; i++) {
    const d = devFn(i); if (!(d === d) || d === 0) continue;
    const p = sigmoid(L[i] + k * d);
    const eu = p - CU[i], ed = (1 - p) - CD[i];
    const up = eu >= ed, edge = up ? eu : ed;
    if (edge < minEdge) continue;
    const cost = up ? CU[i] : CD[i];
    const frac = Math.min(MAX_FRAC, edge / (1 - cost) / 2);
    const won = up === (Yv[i] === 1);
    const r = won ? (1 - cost) / cost : -1;
    const gr = won ? Math.log(1 + frac * (1 - cost) / cost) : Math.log(1 - frac);
    wkBuf[WK[i]] += gr; growth += gr; bets++; if (won) wins++; roiSum += r;
    if (list) list.push({ i, s: S[i], wk: WK[i], up, cost, p: up ? p : 1 - p, frac, won, r });
  }
  const nW = w1 - w0 + 1; let m = 0; for (let w = w0; w <= w1; w++) m += wkBuf[w]; m /= nW;
  let v = 0; for (let w = w0; w <= w1; w++) v += (wkBuf[w] - m) ** 2;
  return { bets, wins, roi: bets ? roiSum / bets : 0, growth, mean: m, sd: Math.sqrt(v / nW), nW, list };
}
const tradeGenome = (g, lo, hi, Yv, collect) => trade(i => devOf(g, i), g.k ?? 1, g.minEdge, lo, hi, Yv, collect);

// Fitness rewards CONSISTENT weekly growth, not one lucky week.
function fitness(g, lo, hi, Yv) {
  const t = tradeGenome(g, lo, hi, Yv);
  const minB = P.MIN_BETS_PER_WEEK * t.nW;
  return { t, fit: (t.mean - 0.5 * t.sd) * t.nW - complexity(g) - (t.bets < minB ? 0.01 * (minB - t.bets) : 0) };
}

function evolveTribe(seed, lo, hi, Yv, cfg, peek) {
  const r = rngFrom(seed);
  let pop = Array.from({ length: cfg.POP }, () => randomGenome(r));
  const history = []; let scored;
  const elite = Math.max(2, Math.round(cfg.POP * P.ELITE));
  for (let gen = 0; gen < cfg.GENS; gen++) {
    scored = pop.map(g => ({ g, ...fitness(g, lo, hi, Yv) })).sort((x, y) => y.fit - x.fit);
    if (peek) { const b = scored[0]; const pk = tradeGenome(b.g, peek[0], peek[1], Y); history.push({ gen, train: +(b.t.roi * 100).toFixed(2), peek: +(pk.roi * 100).toFixed(2), bets: b.t.bets }); }
    if (gen === cfg.GENS - 1) break;
    const pick = () => { let w = null; for (let k = 0; k < P.TOURN; k++) { const c = scored[Math.floor(r() * scored.length)]; if (!w || c.fit > w.fit) w = c; } return w.g; };
    const next = scored.slice(0, elite).map(x => x.g);
    while (next.length < cfg.POP) next.push(mutate(r() < P.CROSS ? crossover(pick(), pick(), r) : structuredClone(pick()), r));
    pop = next;
  }
  return { champ: scored[0], history };
}

// Calibration: find k (0..2) that makes the probabilities most accurate on the calibration weeks.
function fitK(devFn, lo, hi) {
  const ds_ = [], ls = [], ys = [];
  for (let i = lo; i < hi; i++) { const d = devFn(i); ds_.push(d === d ? d : 0); ls.push(L[i]); ys.push(Y[i]); }
  let best = { k: 0, ll: -Infinity };
  for (let k = 0; k <= 2.0001; k += 0.05) {
    let ll = 0;
    for (let j = 0; j < ds_.length; j++) { const p = Math.min(0.999, Math.max(0.001, sigmoid(ls[j] + k * ds_[j]))); ll += ys[j] ? Math.log(p) : Math.log(1 - p); }
    if (ll > best.ll + 1e-9) best = { k: +k.toFixed(2), ll };
  }
  return best.k;
}
const ensembleDevFn = members => i => { let d = 0; for (const g of members) { const x = devOf(g, i); if (x === x) d += x; } return d / members.length; };

// Week-block bootstrap: resample whole weeks to get a confidence interval for profit per $1.
function bootstrap(list, seed) {
  if (list.length < 10) return { p: 1, ci: [0, 0] };
  const byWk = new Map();
  for (const b of list) { const x = byWk.get(b.wk) || { r: 0, n: 0 }; x.r += b.r; x.n++; byWk.set(b.wk, x); }
  const wks = [...byWk.values()], rnd = rngFrom(seed), sims = [];
  for (let k = 0; k < P.BOOT; k++) {
    let r = 0, c = 0;
    for (let j = 0; j < wks.length; j++) { const w = wks[Math.floor(rnd() * wks.length)]; r += w.r; c += w.n; }
    sims.push(c ? r / c : 0);
  }
  sims.sort((a, b) => a - b);
  return { p: +((sims.filter(x => x <= 0).length + 1) / (P.BOOT + 1)).toFixed(4), ci: [+(sims[Math.floor(P.BOOT * 0.025)] * 100).toFixed(2), +(sims[Math.floor(P.BOOT * 0.975)] * 100).toFixed(2)] };
}
const stat = t => ({ bets: t.bets, wins: t.wins, winRate: t.bets ? +(t.wins / t.bets).toFixed(4) : null, roi: +(t.roi * 100).toFixed(2), growthPct: +((Math.exp(t.growth) - 1) * 100).toFixed(1) });

// One full "pretend it's this date" run: evolve -> calibrate -> ensemble.
function buildModel(testWeek, cfg, seedBase, withHistory) {
  const trainW0 = Math.max(WK[0], testWeek - P.TRAIN_WEEKS - P.CALIB_WEEKS), calibW0 = testWeek - P.CALIB_WEEKS;
  const lo = rowAtWeek(trainW0), mid = rowAtWeek(calibW0), hi = rowAtWeek(testWeek);
  const champs = [], histories = [];
  for (let t = 0; t < cfg.TRIBES; t++) {
    const { champ, history } = evolveTribe(seedBase + t, lo, mid, Y, cfg, withHistory ? [mid, hi] : null);
    const g = structuredClone(champ.g);
    const raw = tradeGenome({ ...g, k: 1 }, mid, hi, Y);
    g.k = fitK(i => devOf(g, i), mid, hi);
    champs.push({ tribe: t + 1, genome: g, train: stat(champ.t), calibRaw: stat(raw), calib: stat(tradeGenome(g, mid, hi, Y)) });
    histories.push(history);
  }
  const members = champs.map(c => ({ ...c.genome, k: undefined }));
  members.forEach(m => delete m.k);
  const ens = { members, k: fitK(ensembleDevFn(members), mid, hi), minEdge: P.ENS_MIN_EDGE };
  return { ens, champs, histories, range: { trainFrom: weekStart(trainW0), calibFrom: weekStart(calibW0), calibTo: weekStart(testWeek), lo, mid, hi } };
}

// ---------------- walk-forward ----------------
const folds = [], oosEns = [], oosRaw = [], oosSingles = [];
const firstTestWeek = W - P.FOLDS * P.TEST_WEEKS;
for (let f = 0; f < P.FOLDS; f++) {
  const tw = firstTestWeek + f * P.TEST_WEEKS;
  if (tw - 8 < WK[0]) continue;
  const m = buildModel(tw, P.FOLD, 100 * (f + 1), false);
  const lo = rowAtWeek(tw), hi = rowAtWeek(tw + P.TEST_WEEKS);
  const dev = ensembleDevFn(m.ens.members);
  const te = trade(dev, m.ens.k, m.ens.minEdge, lo, hi, Y, true);
  const raw = trade(dev, 1, m.ens.minEdge, lo, hi, Y, true);
  const singles = m.champs.map(c => tradeGenome(c.genome, lo, hi, Y, true));
  oosEns.push(...te.list); oosRaw.push(...raw.list); singles.forEach(s => oosSingles.push(...s.list));
  const fold = {
    i: f + 1, testFrom: weekStart(tw), testTo: Math.min(END, weekStart(tw + P.TEST_WEEKS)), trainFrom: m.range.trainFrom, calibFrom: m.range.calibFrom,
    k: m.ens.k, ens: { ...stat(te), ...bootstrap(te.list, 7 + f) }, raw: stat(raw),
    singles: { roi: +(singles.reduce((a, s) => a + s.roi, 0) / singles.length * 100).toFixed(2), bets: singles.reduce((a, s) => a + s.bets, 0) },
  };
  folds.push(fold);
  log(`fold ${f + 1}: k=${m.ens.k} ensemble ${fold.ens.bets} bets, ${(fold.ens.winRate * 100).toFixed(1)}% won, ${fold.ens.roi}¢/$1 (raw k=1: ${fold.raw.roi}¢ on ${fold.raw.bets}; singles avg ${fold.singles.roi}¢)`);
}

// stitch the out-of-sample record together
oosEns.sort((a, b) => a.s - b.s);
let bank = 1000, flat = 0; const equity = [{ t: oosEns[0]?.s ?? END, kelly: 1000, flat: 0 }];
const weekly = new Map();
for (const b of oosEns) {
  bank *= b.won ? 1 + b.frac * (1 - b.cost) / b.cost : 1 - b.frac;
  flat += 10 * b.r;
  equity.push({ t: b.s + 900, kelly: +bank.toFixed(2), flat: +flat.toFixed(2) });
  const w = weekly.get(b.wk) || { t: weekStart(b.wk), pnl: 0, bets: 0 }; w.pnl += 10 * b.r; w.bets++; weekly.set(b.wk, w);
}
const oosWeeks = [];
for (let wk = firstTestWeek; wk < W; wk++) oosWeeks.push(weekly.get(wk) || { t: weekStart(wk), pnl: 0, bets: 0 });
const bins = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 1.01]];
const calTable = list => bins.map(([a, b]) => { const x = list.filter(q => q.p >= a && q.p < b); return { bin: `${Math.round(a * 100)}-${b > 1 ? 100 : Math.round(b * 100)}%`, n: x.length, claimed: x.length ? +(x.reduce((s, q) => s + q.p, 0) / x.length).toFixed(4) : null, actual: x.length ? +(x.filter(q => q.won).length / x.length).toFixed(4) : null }; });
const oLo = rowAtWeek(firstTestWeek);
function flatBase(side) { let pnl = 0, c = 0, w = 0; for (let i = oLo; i < n; i++) { const up = side(i); const cost = up ? CU[i] : CD[i]; const won = up === (Y[i] === 1); pnl += won ? 10 * (1 - cost) / cost : -10; c++; if (won) w++; } return { bets: c, winRate: +(w / c).toFixed(4), pnl: +pnl.toFixed(2) }; }
const sumStat = list => ({ bets: list.length, wins: list.filter(b => b.won).length, winRate: list.length ? +(list.filter(b => b.won).length / list.length).toFixed(4) : null, roi: list.length ? +(list.reduce((a, b) => a + b.r, 0) / list.length * 100).toFixed(2) : 0 });
const oos = {
  from: weekStart(firstTestWeek), to: END, weeks: oosWeeks.length,
  ...sumStat(oosEns), ...bootstrap(oosEns, 99),
  profitableWeeks: oosWeeks.filter(w => w.pnl > 0).length, activeWeeks: oosWeeks.filter(w => w.bets > 0).length,
  finalKelly: +bank.toFixed(2), flatPnl: +flat.toFixed(2),
  equity: equity.length > 1500 ? equity.filter((_, i) => i % Math.ceil(equity.length / 1500) === 0 || i === equity.length - 1) : equity,
  weekly: oosWeeks.map(w => ({ t: w.t, pnl: +w.pnl.toFixed(2), bets: w.bets })),
  calibration: calTable(oosEns), calibrationRaw: calTable(oosRaw),
  raw: { ...sumStat(oosRaw), ...bootstrap(oosRaw, 98) }, singles: sumStat(oosSingles),
  baselines: { favorite: flatBase(i => MID[i] >= 0.5), alwaysUp: flatBase(() => true) },
};
log(`OOS: ${oos.bets} bets over ${oos.weeks} weeks, ${(oos.winRate * 100).toFixed(1)}% won, ${oos.roi}¢/$1, CI [${oos.ci}], p=${oos.p}, profitable weeks ${oos.profitableWeeks}/${oos.weeks}`);

if (process.env.OOS_ONLY) { fs.writeFileSync(out, JSON.stringify({ verdict: oos.bets < 100 ? 'not enough bets' : (oos.p < 0.05 && oos.ci[0] > 0) ? 'edge held up' : oos.roi > 0 ? 'positive but unproven' : 'no edge after fees', oos: { ...oos, equity: undefined }, folds })); process.exit(0); }

// ---------------- production model (trades live) ----------------
const prod = buildModel(W, P.PROD, 7000, true);
log(`production: ensemble k=${prod.ens.k}`);
const avgHist = prod.histories[0].map((_, gen) => ({ gen, train: +(prod.histories.reduce((a, h) => a + h[gen].train, 0) / prod.histories.length).toFixed(2), peek: +(prod.histories.reduce((a, h) => a + h[gen].peek, 0) / prod.histories.length).toFixed(2) }));

// scrambled-data tribes: evolution on shuffled results, to show how much training scores lie
const shuffledY = Uint8Array.from(Y);
{ const r = rngFrom(4242); const { lo, mid } = prod.range; for (let i = mid - 1; i > lo; i--) { const j = lo + Math.floor(r() * (i - lo + 1)); [shuffledY[i], shuffledY[j]] = [shuffledY[j], shuffledY[i]]; } }
const nulls = [];
for (let t = 0; t < P.NULLS; t++) {
  const { champ, history } = evolveTribe(9100 + t, prod.range.lo, prod.range.mid, shuffledY, P.FOLD, null);
  nulls.push({ train: stat(champ.t), history });
}
const nullHist = [];
{ // re-score null champions per generation is costly; reuse the champions' final training ROI as the luck line
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const luck = { trainRoiMean: +mean(nulls.map(x => x.train.roi)).toFixed(2), trainRoiMax: Math.max(...nulls.map(x => x.train.roi)), trainWinMax: Math.max(...nulls.map(x => x.train.winRate || 0)) };
log(`scrambled tribes: training ROI mean ${luck.trainRoiMean}¢, max ${luck.trainRoiMax}¢`);

const now = Math.floor(Date.now() / 1000);
const verdict = oos.bets < 100 ? 'not enough bets' : (oos.p < 0.05 && oos.ci[0] > 0) ? 'edge held up' : oos.roi > 0 ? 'positive but unproven' : 'no edge after fees';
const result = {
  version: 2, id: `evo-${now}`, createdAt: now, params: P,
  data: { from: tmp[0].s, to: END, rows: n, weeks: W },
  verdict, folds, oos,
  production: {
    ...prod.range, lo: undefined, mid: undefined, hi: undefined,
    ensemble: prod.ens,
    champions: prod.champs.map(c => ({ ...c, desc: describe(c.genome), note: calibrationNote(c.genome.k) })),
    history: avgHist,
  },
  nulls: nulls.map(x => ({ train: x.train })), luck,
  // for the fee-free check: the last 6 weeks of the uncalibrated vote's blind bets (it bets more, so a bigger sample)
  recentBets: oosRaw.sort((a, b) => a.s - b.s).filter(b => b.s >= END - 42 * 86400).map(b => ({ s: b.s, lead: LEAD[b.i], side: b.up ? 'Up' : 'Down', mid: MID[b.i], cost: +b.cost.toFixed(4), p: +b.p.toFixed(4), won: b.won })),
};
result.seconds = +((Date.now() - T1) / 1000).toFixed(1);
fs.writeFileSync(out, JSON.stringify(result));
log(`verdict: ${verdict}. wrote ${out}`);
