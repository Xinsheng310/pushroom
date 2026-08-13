/* 一次跑完所有測試。用法：node tests/run-all.mjs */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f=>f.endsWith('.test.mjs')).sort();

let failed = [];
for(const f of files){
  const r = spawnSync(process.execPath, [join(here,f)], { encoding:'utf8' });
  const out = (r.stdout||'') + (r.stderr||'');
  const summary = out.split('\n').filter(l=>/通過|略過|失敗/.test(l)).pop() || '';
  const ok = r.status===0;
  if(!ok) failed.push(f);
  console.log((ok?'✓':'✗') + '  ' + f.padEnd(28) + summary.trim());
  if(!ok) console.log(out.split('\n').filter(l=>l.includes('✗')).slice(0,6).map(l=>'      '+l).join('\n'));
}

console.log('');
if(failed.length){
  console.log(`${failed.length} 支測試失敗：${failed.join(', ')}`);
  process.exit(1);
}
console.log(`${files.length} 支測試全部通過`);
