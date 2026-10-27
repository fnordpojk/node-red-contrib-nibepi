'use strict';
// Record or check characterization traces.
//   node test/characterize/run.js record [scenario...]   write golden/<scenario>.txt
//   node test/characterize/run.js check  [scenario...]   compare against golden/, exit 1 on a difference
process.env.TZ = 'Europe/Stockholm';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { run } = require('./harness');
const scenarios = require('./scenarios');

const [mode, ...names] = process.argv.slice(2);
if (mode !== 'record' && mode !== 'check') { console.log('usage: run.js record|check [scenario...]'); process.exit(2); }
const GOLDEN = path.join(__dirname, 'golden');
fs.mkdirSync(GOLDEN, { recursive: true });

(async () => {
    let failed = 0;
    for (const sc of scenarios.filter(s => names.length === 0 || names.includes(s.name))) {
        const t0 = Date.now();
        const events = await run(sc);
        const text = events.join('\n') + '\n';
        const file = path.join(GOLDEN, sc.name + '.txt.gz');
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (mode === 'record') {
            fs.writeFileSync(file, zlib.gzipSync(text, { level: 9 }));
            if (process.env.CHAR_PLAIN) fs.writeFileSync(file.replace(/\.gz$/, ''), text);
            console.log(`${sc.name}: recorded ${events.length} events (${secs} s)`);
            continue;
        }
        const want = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n');
        const got = text.split('\n');
        const i = want.findIndex((l, k) => l !== got[k]);
        if (i === -1 && want.length === got.length) { console.log(`${sc.name}: same (${events.length} events, ${secs} s)`); continue; }
        failed++;
        const at = i === -1 ? Math.min(want.length, got.length) : i;
        console.log(`${sc.name}: DIFFERS at event ${at + 1} of ${want.length} recorded / ${got.length} now`);
        for (let k = Math.max(0, at - 3); k < at + 6; k++) {
            if (want[k] === got[k]) console.log(`    ${want[k] ?? ''}`);
            else { console.log(`  - ${want[k] ?? '(none)'}`); console.log(`  + ${got[k] ?? '(none)'}`); }
        }
    }
    process.exit(failed ? 1 : 0);
})();
