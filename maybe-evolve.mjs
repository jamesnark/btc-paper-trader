// maybe-evolve.mjs - once a week (or when the evolution code changes):
//   1. refresh the dataset (incremental; a time budget keeps any one run short)
//   2. run walk-forward evolution  -> evolution.json
//   3. replay recent blind bets as fee-free orders -> maker.json
//   4. robustness: re-run the walk-forward with the data ending 1, 3 and 5 days earlier.
//      A real edge shouldn't depend on exactly where the 4-week test blocks start.
// Usage: node maybe-evolve.mjs out
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { loadDataset } from './dsio.js';

const dir = process.argv[2] || '.';
const here = f => new URL('./' + f, import.meta.url).pathname;
const run = (f, ...args) => execFileSync('node', [here(f), ...args], { stdio: 'inherit' });
const hash = crypto.createHash('sha1');
for (const f of ['features.js', 'genome.js', 'evolve.mjs', 'dsio.js']) hash.update(fs.readFileSync(here(f)));
const codeHash = hash.digest('hex').slice(0, 12);
const evoPath = path.join(dir, 'evolution.json'), dsPath = path.join(dir, 'dataset.json.gz');

let old = null;
try { old = JSON.parse(fs.readFileSync(evoPath, 'utf8')); } catch {}
const age = old ? Date.now() / 1000 - old.createdAt : Infinity;
if (old && old.version === 2 && old.codeHash === codeHash && age < 7 * 86400) {
  console.log(`evolution is current (${(age / 86400).toFixed(1)} days old)`);
  process.exit(0);
}
fs.rmSync(path.join(dir, 'dataset.json'), { force: true }); // v1 dataset, no longer used
if (!fs.existsSync(dsPath) && fs.existsSync(here('seed/dataset.json.gz'))) {
  fs.copyFileSync(here('seed/dataset.json.gz'), dsPath);
  console.log('seeded dataset from repo');
}
console.log(old ? `re-evolving (code changed: ${old.codeHash !== codeHash}, age ${(age / 86400).toFixed(1)} days)` : 'first evolution run');
run('dataset.mjs', dsPath, '400', '900');
const ds = loadDataset(dsPath);
const days = ds ? ds.windows.length / 96 : 0;
if (days < 300) { console.log(`dataset has only ${days.toFixed(0)} days so far; will keep building next run`); process.exit(0); }
const tmp = evoPath + '.tmp';
run('evolve.mjs', dsPath, tmp);
const evo = JSON.parse(fs.readFileSync(tmp, 'utf8'));
evo.codeHash = codeHash;
fs.writeFileSync(evoPath, JSON.stringify(evo));
fs.unlinkSync(tmp);
try { run('maker-check.mjs', evoPath, path.join(dir, 'maker.json')); } catch (e) { console.log('maker check failed:', e.message); }

const SHIFTS = [1, 3, 5];
await Promise.all(SHIFTS.map(k => new Promise(res => {
  const p = spawn('node', [here('evolve.mjs'), dsPath, path.join(dir, `rob_${k}.tmp`)], { env: { ...process.env, DROP_DAYS: String(k), OOS_ONLY: '1' }, stdio: 'inherit' });
  p.on('exit', res); p.on('error', res);
})));
const pick = (shift, e) => ({ shift, verdict: e.verdict, from: e.oos.from, to: e.oos.to,
  cal: { bets: e.oos.bets, winRate: e.oos.winRate, roi: e.oos.roi, ci: e.oos.ci, p: e.oos.p },
  raw: { bets: e.oos.raw.bets, winRate: e.oos.raw.winRate, roi: e.oos.raw.roi, ci: e.oos.raw.ci, p: e.oos.raw.p } });
const runs = [pick(0, evo)];
for (const k of SHIFTS) {
  const f = path.join(dir, `rob_${k}.tmp`);
  try { runs.push(pick(k, JSON.parse(fs.readFileSync(f, 'utf8')))); } catch { console.log(`robustness run ${k} failed`); }
  fs.rmSync(f, { force: true });
}
const count = (fn) => runs.filter(fn).length;
evo.robustness = {
  runs,
  calProfitable: count(r => r.cal.roi > 0), calProven: count(r => r.cal.ci[0] > 0 && r.cal.bets >= 100),
  rawProfitable: count(r => r.raw.roi > 0), rawProven: count(r => r.raw.ci[0] > 0 && r.raw.bets >= 100),
};
// The headline verdict now needs to survive the shifted tests too.
const n = runs.length, R = evo.robustness;
evo.verdict = R.calProven >= Math.ceil(n * 0.75) ? 'edge held up'
  : R.calProfitable >= Math.ceil(n * 0.75) ? 'positive but unproven'
  : R.calProfitable >= Math.ceil(n / 2) ? 'mixed' : 'no edge after fees';
fs.writeFileSync(evoPath, JSON.stringify(evo));
console.log(`robustness: calibrated profitable ${R.calProfitable}/${n}, proven ${R.calProven}/${n}; uncalibrated profitable ${R.rawProfitable}/${n}, proven ${R.rawProven}/${n} -> ${evo.verdict}`);
