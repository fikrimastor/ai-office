// Task runner tests with a fake "claude": tasks run as the staff, one at a time per staff,
// in parallel across staff; results go back into the task file; unknown staff and Stop handled.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-tasks-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const fake = `
const fs = require('fs');
const a = process.argv.slice(2);
const msg = a[a.indexOf('-p') + 1];
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))}, JSON.stringify({ args: a, cwd: process.cwd(), at: Date.now() }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const wait = msg.includes('LONG') ? 2500 : 400;
setTimeout(() => {
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done: ' + msg.split('\\n')[2] }] } });
  out({ type: 'result', subtype: 'success', is_error: false });
}, wait);
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
const D = require('../lib/defaults');
const { Tasks } = require('../lib/tasks');
const { access, chatEnv, resolveClaude } = require('../lib/chat');
const dir = path.join(tmp, 'office');
G.writeOffice(dir, G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: D.STAFF.slice(0, 3).map(({ name, role, job }) => ({ name, role, job })) }));

const started = [], ended = [];
const tasks = new Tasks(dir, {
  access: (id, o) => access(dir, id, o), claude: resolveClaude, env: chatEnv,
  loadCfg: () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')),
  onStart: (t) => started.push(t.id), onEnd: (t, r) => ended.push([t.id, t.status, r]),
});
const put = (id, staff, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\nstaff: ${staff}\nproject:\nstatus: new\n---\n${text}\n`);
const until = (fn, ms = 15000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 50); });
const calls = () => fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };

(async () => {
  await test('a task runs as that staff, in their folder, and the report goes back into the file', async () => {
    put('t1', 'siti', 'Quote 50 t-shirts for Kedai Ali');
    tasks.scan();
    await until(() => ended.length === 1);
    const t = tasks.read('t1');
    assert.strictEqual(t.status, 'done'); assert.ok(t.started && t.finished);
    assert.strictEqual(t.result, 'Done: Quote 50 t-shirts for Kedai Ali');
    assert.strictEqual(t.task, 'Quote 50 t-shirts for Kedai Ali');
    const c = calls()[0];
    assert.strictEqual(path.resolve(c.cwd), path.resolve(dir, 'staff', 'siti'));
    assert.ok(!c.args[c.args.indexOf('--tools') + 1].includes('Agent'), 'staff cannot hand work on');
    assert.ok(!c.args.includes('--resume'), 'each task starts fresh');
  });

  await test('one at a time per staff, different staff in parallel', async () => {
    put('t2', 'nurul', 'LONG invoice one');
    put('t3', 'nurul', 'invoice two');
    put('t4', 'aina', 'LONG reply to Ali');
    tasks.scan(); tasks.scan(); // scanning twice must not start anything twice
    await until(() => ended.length === 4);
    const c = calls().slice(1);
    assert.strictEqual(c.length, 3);
    const at = (word) => c.find((x) => x.args[x.args.indexOf('-p') + 1].includes(word)).at;
    assert.ok(Math.abs(at('invoice one') - at('reply to Ali')) < 1500, 'nurul and aina started together');
    assert.ok(at('invoice two') - at('invoice one') >= 2000, 'nurul did her second task after the first');
  });

  await test('a staff can ask a colleague; the answer is for whoever asked', async () => {
    fs.writeFileSync(path.join(dir, 'tasks', 'q1.md'), '---\nstaff: nurul\nfrom: siti\nstatus: new\n---\nAny problems with the invoices?\n');
    tasks.scan();
    await until(() => ended.some(([id]) => id === 'q1'));
    const t = tasks.read('q1');
    assert.strictEqual(t.status, 'done'); assert.strictEqual(t.from, 'siti');
    const c = calls().find((x) => x.args[x.args.indexOf('-p') + 1].includes('Any problems'));
    assert.match(c.args[c.args.indexOf('-p') + 1], /^Task from Siti/);
    assert.match(c.args[c.args.indexOf('--append-system-prompt') + 1], /cannot ask colleagues from here/, 'no tasks from inside a task');
    fs.writeFileSync(path.join(dir, 'tasks', 'q2.md'), '---\nstaff: siti\nfrom: siti\nstatus: new\n---\nAsk myself\n');
    fs.writeFileSync(path.join(dir, 'tasks', 'q3.md'), '---\nstaff: siti\nfrom: ghost\nstatus: new\n---\nFrom nobody\n');
    tasks.scan();
    assert.match(tasks.read('q2').result, /cannot give a task to themselves/);
    assert.match(tasks.read('q3').result, /not on the team/);
  });

  await test('a task for someone who is not on the team fails with a plain reason', async () => {
    put('t5', 'ghost', 'Do something');
    tasks.scan();
    await until(() => ended.some(([id]) => id === 't5'));
    assert.strictEqual(tasks.read('t5').status, 'failed');
    assert.match(tasks.read('t5').result, /no active staff/);
  });

  await test('Stop: running and waiting tasks', async () => {
    put('t6', 'siti', 'LONG long quote');
    put('t7', 'siti', 'second quote');
    tasks.scan();
    await until(() => tasks.active().some((a) => a.id === 't6'));
    assert.deepStrictEqual(tasks.stop('t7'), { ok: true });
    assert.strictEqual(tasks.read('t7').status, 'stopped');
    tasks.stop('t6');
    await until(() => tasks.read('t6').status === 'stopped');
    assert.deepStrictEqual(tasks.active(), []);
  });

  await test('after a restart, a task left "working" is marked stopped', async () => {
    put('t8', 'aina', 'half done'); fs.writeFileSync(path.join(dir, 'tasks', 't8.md'), fs.readFileSync(path.join(dir, 'tasks', 't8.md'), 'utf8').replace('status: new', 'status: working'));
    const cut = tasks.recover();
    assert.strictEqual(tasks.read('t8').status, 'stopped');
    assert.deepStrictEqual(cut.map((t) => t.id), ['t8']);
    assert.deepStrictEqual(tasks.interrupted().map((t) => t.id), ['t8']);
  });

  await test('an interrupted task runs again as a new task with the same text, or is dismissed', async () => {
    const r = tasks.rerun('t8');
    assert.ok(r.ok && r.id !== 't8');
    const again = tasks.read(r.id);
    assert.strictEqual(again.staff, 'aina'); assert.strictEqual(again.again, 't8');
    assert.strictEqual(again.task, tasks.read('t8').task);
    assert.deepStrictEqual(tasks.interrupted(), [], 'no longer listed');
    await new Promise((ok) => { const w = setInterval(() => { if (tasks.read(r.id).status === 'done') { clearInterval(w); ok(); } }, 100); });
    assert.throws(() => tasks.rerun(r.id), /stopped or failed/); // a finished task is not run again
    put('t9', 'siti', 'also cut'); fs.writeFileSync(path.join(dir, 'tasks', 't9.md'), fs.readFileSync(path.join(dir, 'tasks', 't9.md'), 'utf8').replace('status: new', 'status: working'));
    tasks.recover(); tasks.dismiss('t9');
    assert.deepStrictEqual(tasks.interrupted(), []);
  });

  const putAfter = (id, staff, after, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\nstaff: ${staff}\nafter: ${after}\nstatus: new\n---\n${text}\n`);

  await test('a task with after: waits, then starts on its own when that task is done', async () => {
    put('d1', 'siti', 'LONG quote for the invoice');
    putAfter('d2', 'nurul', 'd1', 'invoice from the quote');
    tasks.scan();
    assert.strictEqual(tasks.read('d2').status, 'new');
    assert.strictEqual(tasks.list().find((t) => t.id === 'd2').waiting, true);
    assert.deepStrictEqual(tasks.list().find((t) => t.id === 'd2').after, ['d1']);
    assert.ok(!tasks.active().some((a) => a.id === 'd2'), 'nurul is free but the invoice waits for the quote');
    await until(() => tasks.read('d2').status === 'done');
    const c = calls().find((x) => x.args[x.args.indexOf('-p') + 1].includes('invoice from the quote'));
    assert.ok(c.args[c.args.indexOf('-p') + 1].includes(path.join(dir, 'tasks', 'd1.md')), 'told to read the earlier result');
    assert.ok(Date.parse(tasks.read('d2').started) >= Date.parse(tasks.read('d1').finished));
  });

  await test('a task waiting for a failed task fails too, with a plain reason', async () => {
    put('f1', 'ghost', 'nobody does this');
    putAfter('f2', 'nurul', 'f1', 'needs the ghost work');
    tasks.scan();
    assert.strictEqual(tasks.read('f2').status, 'failed');
    assert.match(tasks.read('f2').result, /waits for task "f1".*failed/);
    assert.ok(ended.some(([id, st]) => id === 'f2' && st === 'failed'));
  });

  await test('a task may be written before the task it waits for', async () => {
    putAfter('r2', 'nurul', 'r1', 'invoice written first');
    tasks.scan();
    assert.strictEqual(tasks.read('r2').status, 'new', 'still in the grace time, not failed');
    assert.strictEqual(tasks.list().find((t) => t.id === 'r2').waiting, true);
    put('r1', 'siti', 'quote written second');
    tasks.scan();
    await until(() => tasks.read('r2').status === 'done');
    assert.ok(Date.parse(tasks.read('r2').started) >= Date.parse(tasks.read('r1').finished));
  });

  await test('a task waiting for a task that does not exist fails', async () => {
    fs.writeFileSync(path.join(dir, 'tasks', 'm1.md'), '---\nstaff: nurul\nafter: nope\nstatus: new\ncreated: 2020-01-01T00:00:00.000Z\n---\nneeds nothing real\n'); // older than the grace time
    tasks.scan();
    assert.strictEqual(tasks.read('m1').status, 'failed');
    assert.match(tasks.read('m1').result, /no such task/);
  });

  await test('tasks that wait for each other (or themselves) fail', async () => {
    putAfter('c1', 'siti', 'c2', 'one');
    putAfter('c2', 'nurul', 'c1', 'two');
    putAfter('c3', 'aina', 'c3', 'myself');
    tasks.scan();
    for (const id of ['c1', 'c2', 'c3']) assert.strictEqual(tasks.read(id).status, 'failed');
    assert.match(tasks.read('c1').result, /circle/); assert.match(tasks.read('c3').result, /circle/);
  });

  await test('Stop cancels a waiting task', async () => {
    put('s1', 'siti', 'LONG long quote two');
    putAfter('s2', 'nurul', 's1', 'invoice two later');
    tasks.scan();
    assert.deepStrictEqual(tasks.stop('s2'), { ok: true });
    assert.strictEqual(tasks.read('s2').status, 'stopped');
    assert.strictEqual(tasks.read('s2').result, 'Cancelled by the boss before it started.');
    await until(() => tasks.read('s1').status === 'done');
    assert.strictEqual(tasks.read('s2').status, 'stopped', 'not started after the quote is done');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} task tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
