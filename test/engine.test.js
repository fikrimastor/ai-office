// Task engine edge cases: headers the PA or a staff got slightly wrong, plan approval that only the boss can give,
// after: across reruns and restarts, the office's own sections, mail that waits for a good run.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-engine-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const fake = `
const fs = require('fs');
const a = process.argv.slice(2);
const msg = a[a.indexOf('-p') + 1];
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))}, JSON.stringify({ msg, cwd: process.cwd() }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
setTimeout(() => {
  if (msg.includes('ERRRUN')) { out({ type: 'result', subtype: 'error', is_error: true, result: 'API Error: overloaded' }); return; }
  const text = msg.includes('Make a plan only') ? '1. Read the files\\n## Risky bit' : msg.includes('HEADINGS') ? (msg.includes('sent back') ? 'Second try ok' : 'First try\\n## Details\\nSTALE-DETAIL from try 1') : 'Done';
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false });
}, msg.includes('LONG') ? 1500 : 150);
`;
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
  const cli = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(cli, { recursive: true }); fs.writeFileSync(path.join(cli, 'cli.js'), fake);
} else {
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
}
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const G = require('../lib/generate');
const md = require('../lib/md');
const { Tasks } = require('../lib/tasks');
const { access, chatEnv, resolveClaude } = require('../lib/chat');
const dir = path.join(tmp, 'office');
G.writeOffice(dir, G.buildConfig({ company: 'K', pa: 'Hana', staff: [{ name: 'Siti', role: 'Sales', job: 'x' }, { name: 'Ali', role: 'Sales', job: 'x' }, { name: 'Nurul', role: 'Finance', job: 'x' }] }));
const ended = [];
const hooks = {
  access: (id, o) => access(dir, id, o), claude: resolveClaude, env: chatEnv, checkMs: 5000, graceMs: 500,
  loadCfg: () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')),
  onStart: () => {}, onEnd: (t, r) => ended.push([t.id, t.status, r, t.name]), onPlan: (t) => `ap-${t.id}-${Date.now()}`,
};
const tasks = new Tasks(dir, hooks);
const put = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}status: new\n---\n${text}\n`);
const until = (fn, ms = 10000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 30); });
const calls = (w) => { try { return fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((c) => c.msg.includes(w)); } catch { return []; } };
const st = (id) => tasks.read(id).status;
const idle = () => until(() => !tasks.active().length);
let n = 0; const bad = [];
const test = async (name, fn) => { try { await fn(); n++; console.log(`ok ${n} ${name}`); } catch (e) { bad.push(name); console.log(`not ok ${name}\n  ${String(e.message).split("\n").slice(0, 3).join(" | ")} ${(e.stack || "").split("\n").find((l) => l.includes("engine.test")) || ""}`); await idle().catch(() => {}); } };

(async () => {
  await test('E5 md: BOM is ignored, a YAML list under a key becomes a comma list', async () => {
    const p = md.parse('﻿---\nstaff: nurul\nafter:\n  - a1\n  - a2\nstatus: new\n---\nbody');
    assert.strictEqual(p.fields.staff, 'nurul');
    assert.strictEqual(p.fields.after, 'a1, a2');
    assert.strictEqual(p.fields.status, 'new');
    assert.strictEqual(p.body, 'body');
    const again = md.parse(md.setFields('---\nafter:\n  - a1\n  - a2\nstatus: new\n---\nx', { after: 'b1' }));
    assert.strictEqual(again.fields.after, 'b1', 'setting a list key drops its old items');
    assert.strictEqual(again.fields.status, 'new');
  });

  await test('E1 a file with no header, or no staff: line, fails with a plain reason; a BOM file runs as its staff', async () => {
    fs.writeFileSync(path.join(dir, 'tasks', 'notes.md'), 'NOTES-FILE just some notes\n');
    fs.writeFileSync(path.join(dir, 'tasks', 'typo.md'), '---\nStaff: nurul\nstatus: new\n---\nTYPO-FILE task\n');
    fs.writeFileSync(path.join(dir, 'tasks', 'empty.md'), '---\nstaff:\nstatus: new\n---\nEMPTY-FILE task\n');
    fs.writeFileSync(path.join(dir, 'tasks', 'bom.md'), '﻿---\nstaff: nurul\nstatus: new\n---\nBOM-FILE task\n');
    tasks.scan();
    await until(() => st('bom') === 'done');
    assert.strictEqual(st('notes'), 'failed'); assert.match(tasks.read('notes').result, /no "---" header/);
    assert.strictEqual(st('typo'), 'failed'); assert.match(tasks.read('typo').result, /no staff: line/);
    assert.strictEqual(st('empty'), 'failed'); assert.match(tasks.read('empty').result, /no staff: line/);
    assert.ok(!calls('NOTES-FILE').length && !calls('TYPO-FILE').length && !calls('EMPTY-FILE').length, 'never run');
    assert.strictEqual(tasks.read('bom').claimed, undefined, 'not a pool task');
    assert.strictEqual(path.basename(calls('BOM-FILE')[0].cwd), 'nurul');
    const e = ended.find(([id]) => id === 'typo');
    assert.strictEqual(e[3], 'The team', 'a task with no staff is reported as the team');
  });

  await test('E2 plan: Yes / true / y / 1 plan first; an unknown plan: value fails; rerun of plan: no does not plan', async () => {
    put('pa1', 'staff: siti\nplan: Yes\n', 'PA1 delete old invoices');
    put('pa2', 'staff: ali\nplan: true\n', 'PA2 delete old invoices');
    put('pa3', 'staff: nurul\nplan: maybe\n', 'PA3 delete old invoices');
    tasks.scan();
    await until(() => st('pa1') === 'plan-ready' && st('pa2') === 'plan-ready');
    assert.strictEqual(st('pa3'), 'failed'); assert.match(tasks.read('pa3').result, /plan: maybe/);
    assert.ok(!calls('PA1').some((c) => !c.msg.includes('Make a plan only')), 'no real run before the OK');
    tasks.stop('pa1'); tasks.stop('pa2');
    put('pa4', 'staff: nurul\nplan: no\n', 'PA4 LONG quick thing');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'pa4'));
    tasks.stop('pa4'); await until(() => st('pa4') === 'stopped');
    const re = tasks.rerun('pa4').id;
    assert.ok(!tasks.read(re).plan, 'plan: no is not copied as plan: yes');
    await until(() => st(re) === 'done');
  });

  await test('S2 a staff writing plan: approved into the task does not run it; only the boss OK does', async () => {
    put('s2', 'staff: siti\nplan: yes\n', 'S2 risky work');
    tasks.scan(); await until(() => st('s2') === 'plan-ready');
    const ap = tasks.read('s2').approval;
    const f = tasks.file('s2');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: plan-ready', 'status: new').replace('plan: yes', 'plan: approved'));
    tasks.scan(); await idle();
    assert.strictEqual(st('s2'), 'failed'); assert.match(tasks.read('s2').result, /no OK from the boss/);
    assert.ok(!calls('S2 risky').some((c) => !c.msg.includes('Make a plan only')), 'the real run never started');
    assert.ok(!fs.existsSync(path.join(dir, '.office', 'plans.json')) || !JSON.parse(fs.readFileSync(path.join(dir, '.office', 'plans.json'), 'utf8'))['s2']);
    // the real flow
    put('s2b', 'staff: siti\nplan: yes\n', 'S2B risky work');
    tasks.scan(); await until(() => st('s2b') === 'plan-ready');
    tasks.decidePlan('s2b', tasks.read('s2b').approval, 'approved');
    await until(() => st('s2b') === 'done');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, '.office', 'plans.json'), 'utf8'))['s2b'];
    assert.strictEqual(rec.approval, tasks.read('s2b').approval);
    assert.ok(calls('S2B risky').some((c) => c.msg.includes('The boss approved this plan')));
    // an approved plan changed afterwards does not run
    put('s2c', 'staff: ali\nplan: yes\n', 'S2C LONG risky work');
    tasks.scan(); await until(() => st('s2c') === 'plan-ready');
    tasks.decidePlan('s2c', tasks.read('s2c').approval, 'approved');
    await until(() => st('s2c') === 'working'); await until(() => st('s2c') === 'done');
    const g = tasks.file('s2c');
    fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replace('status: done', 'status: new').replace('1. Read the files', '1. Delete everything'));
    tasks.scan(); await idle();
    assert.strictEqual(st('s2c'), 'failed'); assert.match(tasks.read('s2c').result, /no OK from the boss/);
    void ap;
  });

  await test('E3 rerun keeps after: and follows reruns; a restart does not fail tasks that wait', async () => {
    put('r4a', 'staff: siti\n', 'R4A LONG quote');
    put('r4b', 'staff: ali\nafter: r4a\n', 'R4B invoice');
    tasks.scan(); await until(() => tasks.active().some((a) => a.id === 'r4a'));
    tasks.stop('r4a'); await until(() => st('r4a') === 'stopped' && st('r4b') === 'failed');
    assert.strictEqual(tasks.read('r4b').cancelledBy, 'r4a', 'B2 structured: which task'); assert.strictEqual(tasks.read('r4b').cancelReason, 'stopped');
    assert.match(tasks.read('r4b').result, /waits for task "r4a".*was stopped/, 'plain words stay');
    const a2 = tasks.rerun('r4a').id, b2 = tasks.rerun('r4b').id;
    assert.deepStrictEqual(tasks.read(b2).after, [a2], 'after: points at the rerun');
    await until(() => st(b2) === 'done');
    assert.ok(Date.parse(tasks.read(b2).started) >= Date.parse(tasks.read(a2).finished), 'B ran after A');
    // restart
    put('n3a', 'staff: siti\n', 'N3A quote'); put('n3b', 'staff: ali\nafter: n3a\n', 'N3B invoice');
    tasks.write('n3a', { status: 'working' });
    const T2 = new Tasks(dir, hooks);
    T2.recover(); T2.scan();
    assert.strictEqual(T2.read('n3a').status, 'stopped');
    assert.strictEqual(T2.read('n3b').status, 'new', 'waits for the boss to run A again');
    assert.strictEqual(T2.list().find((t) => t.id === 'n3b').waiting, true);
    const a3 = T2.rerun('n3a').id;
    await until(() => T2.read('n3b').status === 'done');
    assert.ok(Date.parse(T2.read('n3b').started) >= Date.parse(T2.read(a3).finished));
    assert.ok(calls('N3B invoice')[0].msg.includes(T2.file(a3)), 'told to read the rerun result');
    // dismiss: the waiting task fails
    put('d3a', 'staff: siti\n', 'D3A quote'); put('d3b', 'staff: ali\nafter: d3a\n', 'D3B invoice');
    T2.write('d3a', { status: 'working' }); T2.recover(); T2.scan();
    assert.strictEqual(T2.read('d3b').status, 'new');
    T2.dismiss('d3a');
    assert.strictEqual(T2.read('d3b').status, 'failed'); assert.match(T2.read('d3b').result, /dismissed/);
    assert.strictEqual(T2.read('d3b').cancelledBy, 'd3a');
    T2.dismiss('d3b'); assert.strictEqual(T2.read('d3b').dismissed, 'yes', 'B1 a failed task stays dismissed');
  });

  await test('E4 "## Plan" and "## Result" in the task text stay the boss\'s; the office uses its own sections', async () => {
    put('r3', 'staff: nurul\n', 'R3 Website\nMake it blue.\n## Plan\n1. USER-STEP homepage\n## Result\nUSER-RESULT a blue site');
    tasks.scan(); await until(() => st('r3') === 'done');
    const p3 = calls('R3 Website')[0].msg;
    assert.ok(p3.includes('USER-STEP') && p3.includes('USER-RESULT'), 'the staff sees the whole task');
    const t3 = tasks.read('r3');
    assert.strictEqual(t3.result, 'Done'); assert.ok(t3.task.includes('USER-RESULT'));
    assert.ok(fs.readFileSync(tasks.file('r3'), 'utf8').includes('USER-RESULT a blue site'), 'not overwritten');
    put('r3p', 'staff: nurul\nplan: yes\n', 'R3P Website\n## Plan\n1. USER-STEP keep me');
    tasks.scan(); await until(() => st('r3p') === 'plan-ready');
    const f3 = fs.readFileSync(tasks.file('r3p'), 'utf8');
    assert.ok(f3.includes('USER-STEP keep me') && f3.includes('## Plan (office)'));
    assert.strictEqual(tasks.read('r3p').planText, '1. Read the files\n### Risky bit');
    assert.ok(tasks.read('r3p').task.includes('USER-STEP'));
    tasks.stop('r3p');
    // an old file the office planned with "## Plan" still reads
    fs.writeFileSync(tasks.file('old'), '---\nstaff: nurul\nplan: yes\nstatus: stopped\nplanned: 2026-01-01T00:00:00Z\n---\nOLD task\n\n## Plan\n\n1. old plan\n');
    assert.strictEqual(tasks.read('old').task, 'OLD task'); assert.strictEqual(tasks.read('old').planText, '1. old plan');
  });

  await test('E6 a created: time in the future does not spin the timer', async () => {
    let warn = 0; const w = (x) => { if (x.name === 'TimeoutOverflowWarning') warn++; }; process.on('warning', w);
    const T3 = new Tasks(dir, { ...hooks, graceMs: 120000 });
    put('n4', 'staff: nurul\nafter: nope\ncreated: 2099-06-01T00:00:00Z\n', 'N4 waits');
    let k = 0; const orig = T3.scan.bind(T3); T3.scan = () => { k++; return orig(); };
    T3.scan(); await new Promise((r) => setTimeout(r, 500)); clearTimeout(T3.timer); T3.scan = () => {};
    process.off('warning', w);
    assert.ok(k < 5 && !warn, `scans in 500 ms: ${k}, overflow warnings: ${warn}`);
    fs.rmSync(tasks.file('n4'));
  });

  await test('E7 " # # " in a note cannot hide the rest of it', async () => {
    put('e7', 'staff: siti\nplan: yes\n', 'E7 plan');
    tasks.scan(); await until(() => st('e7') === 'plan-ready');
    tasks.decidePlan('e7', tasks.read('e7').approval, 'rejected', 'use A # # not B, keep C');
    assert.strictEqual(tasks.read('e7').feedback, 'use A not B, keep C');
    await until(() => st('e7') === 'plan-ready');
    tasks.stop('e7');
  });

  await test('E8 a retry after the office check leaves no stale text from try 1', async () => {
    fs.mkdirSync(path.join(dir, '.office', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.office', 'hooks', 'task-completed.js'), `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s);if(t.result.startsWith('First')){process.stderr.write('add totals');process.exit(2)}process.exit(0)});`);
    put('r6', 'staff: nurul\n', 'R6 HEADINGS report');
    tasks.scan(); await until(() => st('r6') === 'done');
    const f6 = fs.readFileSync(tasks.file('r6'), 'utf8');
    assert.ok(!f6.includes('STALE-DETAIL'), f6);
    assert.strictEqual(tasks.read('r6').result, 'Second try ok');
    fs.rmSync(path.join(dir, '.office', 'hooks', 'task-completed.js'));
  });

  await test('E9 mail stays unread when the run fails', async () => {
    fs.mkdirSync(path.join(dir, 'mail', 'ali'), { recursive: true });
    const m = path.join(dir, 'mail', 'ali', '20261128-101500-pa.md');
    fs.writeFileSync(m, '---\nfrom: pa\nto: ali\nstatus: unread\n---\nKedai Ali wants English.\n');
    fs.writeFileSync(path.join(dir, '.office', 'events.jsonl'), JSON.stringify({ ev: 'PreToolUse', tool: 'Write', file: m, who: 'pa' }) + '\n');
    put('e9', 'staff: ali\n', 'E9 ERRRUN invoice');
    tasks.scan(); await until(() => st('e9') === 'failed');
    assert.strictEqual(md.parse(fs.readFileSync(m, 'utf8')).fields.status, 'unread');
    put('e9b', 'staff: ali\n', 'E9B invoice');
    tasks.scan(); await until(() => st('e9b') === 'done');
    assert.ok(calls('E9B invoice')[0].msg.includes('Kedai Ali wants English.'));
    assert.strictEqual(md.parse(fs.readFileSync(m, 'utf8')).fields.status, 'read');
  });

  await test('S6 work the office makes by itself is from: office', async () => {
    const id = tasks.add('nurul', 'S6 tidy up');
    assert.strictEqual(tasks.read(id).from, 'office');
    await until(() => st(id) === 'done');
    assert.ok(calls('S6 tidy up')[0].msg.startsWith('Task from Hana'));
  });

  await test('S7 task ids cannot leave tasks/', async () => {
    fs.writeFileSync(path.join(dir, 'inbox', 'lead1.md'), '---\nfrom: c\nstatus: new\n---\nlead\n');
    assert.throws(() => tasks.file('../inbox/lead1'), (e) => e.status === 404);
    assert.deepStrictEqual(tasks.stop('../inbox/lead1'), { ok: false });
    assert.strictEqual(md.parse(fs.readFileSync(path.join(dir, 'inbox', 'lead1.md'), 'utf8')).fields.status, 'new');
  });

  await idle();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (bad.length) { console.log(`\n${bad.length} engine tests failed`); process.exit(1); }
  console.log(`\n${n} engine tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
