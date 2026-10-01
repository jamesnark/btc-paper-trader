// maybe-evolve.mjs - refresh the dataset and re-run evolution once a week,
// or right away if the evolution code changes.
// Usage: node maybe-evolve.mjs out
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const dir = process.argv[2] || '.';
const here = f => new URL('./' + f, import.meta.url).pathname;
const hash = crypto.createHash('sha1');
for (const f of ['features.js', 'genome.js', 'evolve.mjs', 'dataset.mjs']) hash.update(fs.readFileSync(here(f)));
const codeHash = hash.digest('hex').slice(0, 12);
const evoPath = path.join(dir, 'evolution.json');
let old = null;
try { old = JSON.parse(fs.readFileSync(evoPath, 'utf8')); } catch {}
const age = old ? Date.now() / 1000 - old.createdAt : Infinity;
if (old && old.codeHash === codeHash && age < 7 * 86400) {
  console.log(`evolution is current (${(age / 86400).toFixed(1)} days old)`);
  process.exit(0);
}
console.log(old ? `re-evolving (code changed: ${old.codeHash !== codeHash}, age ${(age / 86400).toFixed(1)} days)` : 'first evolution run');
execFileSync('node', [here('dataset.mjs'), path.join(dir, 'dataset.json'), '35'], { stdio: 'inherit' });
const tmp = evoPath + '.tmp';
execFileSync('node', [here('evolve.mjs'), path.join(dir, 'dataset.json'), tmp], { stdio: 'inherit' });
const evo = JSON.parse(fs.readFileSync(tmp, 'utf8'));
evo.codeHash = codeHash;
fs.writeFileSync(evoPath, JSON.stringify(evo));
fs.unlinkSync(tmp);
