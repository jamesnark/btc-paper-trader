// evolve.mjs - survival of the fittest, with honesty checks.
// Usage: node evolve.mjs out/dataset.json out/evolution.json
//
//  - Training = everything except the most recent 7 days.
//  - Test week = the most recent 7 days. Evolution NEVER uses it to pick winners;
//    we only peek at it to report how champions do on data they haven't seen.
//  - 5 tribes evolve independently on the real data.
//  - 5 "null" tribes evolve on SCRAMBLED results (no pattern can exist). Their
//    scores are the luck line: what "winning" looks like when there's nothing to find.
import fs from 'node:fs';
import { computeFeatures } from './features.js';
import { rngFrom, randomGenome, mutate, crossover, evaluate, complexity, describe, genomeDecision, MAX_FRAC } from './genome.js';
import { WINDOW } from './lib.js';

const dsPath = process.argv[2] || 'dataset.json';
const out = process.argv[3] || 'evolution.json';
const P = { POP: 80, GENS: 40, ELITE: 8, TOURN: 3, CROSS: 0.7, MIN_BETS: 60, TRIBES: 5, NULLS: 5, LEAD: 600, HALF_SPREAD: 0.005, TEST_DAYS: 7 };

const ds = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
const { t0, btcC, btcV, ethC } = ds.candles;

// ---------- turn windows into rows of features ----------
const rows = [];
for (const w of ds.windows) {
  if (w.m == null || w.o == null || w.m <= 0.02 || w.m >= 0.98) continue;
  const at = w.s - P.LEAD;
  const end = Math.floor((at - 60 - t0) / 60); // last fully closed minute
  if (end - 299 < 0 || end >= btcC.length) continue;
  const b = btcC.slice(end - 299, end + 1), v = btcV.slice(end - 299, end + 1), e = ethC.slice(end - 299, end + 1);
  if (b.some(x => x == null) || e.some(x => x == null)) continue;
  const f = computeFeatures(b, v, e, w.s);
  if (!f) continue;
  rows.push({ s: w.s, f, upMid: w.m, upAsk: +(w.m + P.HALF_SPREAD).toFixed(3), downAsk: +(1 - w.m + P.HALF_SPREAD).toFixed(3), fr: w.fr ?? 0.07, o: w.o });
}
rows.sort((a, b) => a.s - b.s);
const testFrom = rows.at(-1).s - (P.TEST_DAYS * 96 - 1) * WINDOW;
const train = rows.filter(r => r.s < testFrom), test = rows.filter(r => r.s >= testFrom);
const trainY = train.map(r => r.o), testY = test.map(r => r.o);
console.log(`rows: ${rows.length} (train ${train.length}, test ${test.length})`);

const pct = g => +((Math.exp(g) - 1) * 100).toFixed(2);
const summary = e => ({ growthPct: pct(e.growth), bets: e.bets, wins: e.wins, winRate: e.bets ? +(e.wins / e.bets).toFixed(4) : null,
  roi: +e.roi.toFixed(4), flat10: +(e.roi * e.bets * 10).toFixed(2), llEdge: +(e.llEdge * 1000).toFixed(3) });
const fitness = (g, e) => e.growth - complexity(g) - (e.bets < P.MIN_BETS ? 0.01 * (P.MIN_BETS - e.bets) : 0);

function evolveRun(seed, Y) {
  const r = rngFrom(seed);
  let pop = Array.from({ length: P.POP }, () => randomGenome(r));
  const history = [];
  let scored;
  for (let gen = 0; gen < P.GENS; gen++) {
    scored = pop.map(g => { const e = evaluate(g, train, Y); return { g, e, fit: fitness(g, e) }; }).sort((x, y) => y.fit - x.fit);
    const best = scored[0];
    const peek = evaluate(best.g, test, testY); // reporting only, never used for selection
    history.push({ gen, train: +(best.e.roi * 100).toFixed(2), test: +(peek.roi * 100).toFixed(2), trainBets: best.e.bets, testBets: peek.bets, trainWin: best.e.bets ? +(best.e.wins / best.e.bets).toFixed(4) : null, testWin: peek.bets ? +(peek.wins / peek.bets).toFixed(4) : null });
    if (gen === P.GENS - 1) break;
    const tourn = () => { let w = null; for (let k = 0; k < P.TOURN; k++) { const c = scored[Math.floor(r() * scored.length)]; if (!w || c.fit > w.fit) w = c; } return w.g; };
    const next = scored.slice(0, P.ELITE).map(x => x.g);
    while (next.length < P.POP) next.push(mutate(r() < P.CROSS ? crossover(tourn(), tourn(), r) : structuredClone(tourn()), r));
    pop = next;
  }
  return { champ: scored[0], history };
}

function shuffled(arr, seed) {
  const r = rngFrom(seed), a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const t1 = Date.now();
const tribes = [];
for (let k = 0; k < P.TRIBES; k++) {
  const seed = 1000 + k;
  const { champ, history } = evolveRun(seed, trainY);
  const te = evaluate(champ.g, test, testY);
  tribes.push({ tribe: k + 1, seed, genome: champ.g, desc: describe(champ.g), train: summary(champ.e), test: summary(te), history });
  console.log(`tribe ${k + 1}: train win ${(champ.e.wins / champ.e.bets * 100).toFixed(1)}% roi ${(champ.e.roi * 100).toFixed(1)}% (${champ.e.bets}) | TEST win ${(te.wins / te.bets * 100).toFixed(1)}% roi ${(te.roi * 100).toFixed(1)}% (${te.bets})`);
}
const nulls = [];
for (let k = 0; k < P.NULLS; k++) {
  const seed = 5000 + k;
  const fakeY = shuffled(trainY, seed);
  const { champ, history } = evolveRun(seed, fakeY);
  const te = evaluate(champ.g, test, testY);
  nulls.push({ seed, train: summary(champ.e), test: summary(te), history });
  console.log(`null ${k + 1}: train win ${(champ.e.wins / champ.e.bets * 100).toFixed(1)}% roi ${(champ.e.roi * 100).toFixed(1)}% (${champ.e.bets}) | TEST win ${(te.wins / te.bets * 100).toFixed(1)}% roi ${(te.roi * 100).toFixed(1)}% (${te.bets})`);
}

// Simple reference strategies on the test week (half-Kelly not applicable; flat $10 bets)
function flat(rowsX, sideFn) {
  let pnl = 0, n = 0, w = 0;
  for (const r of rowsX) {
    const side = sideFn(r); const ask = side === 'Up' ? r.upAsk : r.downAsk;
    const cost = ask + r.fr * ask * (1 - ask); const shares = 10 / cost; const won = (side === 'Up') === (r.o === 1);
    pnl += (won ? shares : 0) - 10; n++; if (won) w++;
  }
  return { bets: n, winRate: +(w / n).toFixed(4), pnl: +pnl.toFixed(2) };
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
// Permutation test: if the features were useless, the test-week results would be just as good
// with Up/Down randomly reshuffled. How often does a reshuffle do as well as the champion did?
function permutationTest(g, rowsX, Y, seed, N = 2000) {
  const bets = [];
  rowsX.forEach((r, i) => { const d = genomeDecision(g, r.f, r.upMid, r.upAsk, r.downAsk, r.fr); if (d.bet) bets.push({ i, up: d.bet.side === 'Up', cost: d.bet.cost }); });
  if (!bets.length) return { p: 1, luck95: 0 };
  const roiWith = y => bets.reduce((a, b) => a + (((y[b.i] === 1) === b.up) ? (1 - b.cost) / b.cost : -1), 0) / bets.length;
  const observed = roiWith(Y);
  const rnd = rngFrom(seed), perm = [...Y], sims = [];
  for (let k = 0; k < N; k++) {
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    sims.push(roiWith(perm));
  }
  sims.sort((a, b) => a - b);
  return { p: +((sims.filter(x => x >= observed).length + 1) / (N + 1)).toFixed(4), luck95: +(sims[Math.floor(N * 0.95)] * 100).toFixed(2), luck50: +(sims[Math.floor(N * 0.5)] * 100).toFixed(2) };
}

// Luck line, in "profit per $100 bet" (ROI %), the clearest number to compare.
const r100 = x => +(x.roi * 100).toFixed(2);
const luck = {
  trainMean: +mean(nulls.map(n => r100(n.train))).toFixed(2), trainMax: Math.max(...nulls.map(n => r100(n.train))),
  testMean: +mean(nulls.map(n => r100(n.test))).toFixed(2), testMax: Math.max(...nulls.map(n => r100(n.test))),
  trainWinMax: Math.max(...nulls.map(n => n.train.winRate || 0)), testWinMax: Math.max(...nulls.map(n => n.test.winRate || 0)),
};
// 5 tribes = 5 tries, so "survived" needs p < 0.01 (0.05 / 5); 0.01-0.05 is only "promising".
for (const t of tribes) {
  t.perm = permutationTest(t.genome, test, testY, 9000 + t.tribe);
  t.verdict = t.test.bets < 20 ? 'too few bets'
    : t.test.roi <= 0 ? 'failed the test week'
    : t.perm.p < 0.01 ? 'survived'
    : t.perm.p < 0.05 ? 'promising'
    : 'luck-level';
}
const survivors = tribes.filter(t => t.verdict === 'survived').length;
const now = Math.floor(Date.now() / 1000);
const result = {
  id: `evo-${now}`, createdAt: now, seconds: +((Date.now() - t1) / 1000).toFixed(1),
  params: { ...P, MAX_FRAC },
  split: { trainFrom: train[0].s, trainTo: train.at(-1).s + WINDOW, testFrom: test[0].s, testTo: test.at(-1).s + WINDOW, trainN: train.length, testN: test.length,
           trainUpRate: +mean(trainY).toFixed(4), testUpRate: +mean(testY).toFixed(4) },
  tribes, nulls, luck,
  reference: { test: { alwaysUp: flat(test, () => 'Up'), favorite: flat(test, r => (r.upMid >= 0.5 ? 'Up' : 'Down')) } },
  summary: { survivors, trainRoiMean: +mean(tribes.map(t => r100(t.train))).toFixed(2), testRoiMean: +mean(tribes.map(t => r100(t.test))).toFixed(2) },
};
fs.writeFileSync(out, JSON.stringify(result));
console.log(`scrambled-data tribes (training inflation): train ROI mean ${luck.trainMean}% max ${luck.trainMax}%`);
for (const t of tribes) console.log(`tribe ${t.tribe}: test ROI ${r100(t.test)}% vs luck 95th pct ${t.perm.luck95}% -> p=${t.perm.p} ${t.verdict}`);
console.log(`survivors: ${survivors}/${tribes.length}  (${result.seconds}s)`);
