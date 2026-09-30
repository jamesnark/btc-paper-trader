// maybe-backtest.mjs - re-run the 7-day backtest when model.js changes, or once a day.
// Usage: node maybe-backtest.mjs out/backtest.json
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const out = process.argv[2] || 'backtest.json';
const hash = crypto.createHash('sha1').update(fs.readFileSync(new URL('./model.js', import.meta.url))).digest('hex').slice(0, 12);
let old = null;
try { old = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
const age = old ? Date.now() / 1000 - old.updatedAt : Infinity;
if (old && old.modelHash === hash && age < 24 * 3600) {
  console.log(`backtest is current (model ${hash}, ${(age / 3600).toFixed(1)}h old)`);
  process.exit(0);
}
console.log(old ? `re-running backtest (model changed: ${old.modelHash !== hash}, age ${(age / 3600).toFixed(1)}h)` : 'running first backtest');
const tmp = out + '.tmp';
execFileSync('node', [new URL('./backtest.mjs', import.meta.url).pathname, '7', tmp], { stdio: 'inherit' });
const s = JSON.parse(fs.readFileSync(tmp, 'utf8'));
s.modelHash = hash;
fs.writeFileSync(out, JSON.stringify(s));
fs.unlinkSync(tmp);
