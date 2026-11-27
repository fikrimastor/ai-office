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
  const plan = msg.includes('Make a plan only') ? '1. Read the files\\n2. Write the quote\\n## Risky bit' : '';
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: plan || 'Done: ' + msg.split('\\n')[2] }] } });
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

const started = [], ended = [], plans = [], drops = [];
const tasks = new Tasks(dir, {
  access: (id, o) => access(dir, id, o), claude: resolveClaude, env: chatEnv,
  loadCfg: () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')),
  onStart: (t) => started.push(t.id), onEnd: (t, r) => ended.push([t.id, t.status, r]),
  onPlan: (t, plan) => { plans.push([t.id, plan]); return `ap-${t.id}-${plans.length}`; }, onPlanDrop: (t) => drops.push(t.id),
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

  await test('a staff asking a colleague in a task file is not run: it is forwarded to the manager', async () => {
    fs.writeFileSync(path.join(dir, 'tasks', 'q1.md'), '---\nstaff: nurul\nfrom: siti\nstatus: new\n---\nAny problems with the invoices?\n');
    tasks.scan();
    const t = tasks.read('q1');
    assert.strictEqual(t.status, 'forwarded'); assert.strictEqual(t.from, 'siti');
    assert.ok(!calls().some((x) => x.args[x.args.indexOf('-p') + 1].includes('Any problems')), 'never run');
    assert.ok(!ended.some(([id]) => id === 'q1'), 'not an end: the manager decides');
    assert.match(access(dir, 'siti', { task: true }).note, /cannot ask colleagues from here/, 'no tasks from inside a task');
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

  const putPlan = (id, staff, text, after) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\nstaff: ${staff}\nplan: yes\n${after ? `after: ${after}\n` : ''}status: new\n---\n${text}\n`);
  const prompt = (c) => c.args[c.args.indexOf('-p') + 1];
  const callFor = (word, plan) => calls().filter((x) => prompt(x).includes(word) && prompt(x).includes('Make a plan only') === plan).pop();

  await test('plan: yes first runs read-only, stores the plan and asks the boss; dependents keep waiting', async () => {
    putPlan('p1', 'siti', 'Plan quote for Kedai Ali');
    putAfter('p2', 'nurul', 'p1', 'invoice after the planned quote');
    tasks.scan();
    await until(() => tasks.read('p1').status === 'plan-ready');
    const t = tasks.read('p1');
    assert.strictEqual(t.task, 'Plan quote for Kedai Ali', 'the plan is not part of the task');
    assert.match(t.planText, /^1\. Read the files\n2\. Write the quote\n### Risky bit$/, 'stored under ## Plan, headings made smaller');
    assert.strictEqual(t.approval, 'ap-p1-1');
    assert.deepStrictEqual(plans.map(([id]) => id), ['p1'], 'one approval item');
    assert.ok(!ended.some(([id]) => id === 'p1'), 'a plan is not the end of the task');
    const c = callFor('Plan quote for Kedai Ali', true);
    assert.strictEqual(c.args[c.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.ok(c.args[c.args.indexOf('--allowedTools') + 1].split(',').filter(Boolean).every((x) => /^(Read|Glob|Grep)(\(|$)/.test(x)), 'only read tools allowed');
    assert.ok(c.args.includes('--strict-mcp-config') && !c.args.includes('--mcp-config'), 'no add-on tools while planning');
    assert.strictEqual(tasks.read('p2').status, 'new');
    assert.strictEqual(tasks.list().find((x) => x.id === 'p2').waiting, true, 'waits for done, not plan-ready');
    assert.deepStrictEqual(tasks.recover(), [], 'a plan waiting for the boss survives a restart');
    assert.strictEqual(tasks.read('p1').status, 'plan-ready');
  });

  await test('Approve: the staff does the work with the approved plan; dependents start after done', async () => {
    assert.throws(() => tasks.decidePlan('p1', 'ap-other', 'approved'), (e) => e.status === 409, 'only its own approval');
    assert.deepStrictEqual(tasks.decidePlan('p1', 'ap-p1-1', 'approved'), { ok: true, status: 'working' });
    await until(() => tasks.read('p2').status === 'done');
    assert.strictEqual(tasks.read('p1').status, 'done');
    const c = callFor('Plan quote for Kedai Ali', false);
    assert.ok(prompt(c).includes('The boss approved this plan. Follow it:\n1. Read the files'), 'plan in the prompt');
    assert.ok(c.args[c.args.indexOf('--tools') + 1].includes('Write'), 'real run can write');
    assert.ok(Date.parse(tasks.read('p2').started) >= Date.parse(tasks.read('p1').finished));
    assert.throws(() => tasks.decidePlan('p1', 'ap-p1-1', 'approved'), (e) => e.status === 409, 'decided once');
  });

  await test('Reject with a note: a new plan with the note; after 3 re-plans the task stops', async () => {
    putPlan('p3', 'aina', 'Plan reply to Ali');
    tasks.scan();
    await until(() => tasks.read('p3').status === 'plan-ready');
    for (let i = 1; i <= 3; i++) {
      const ap = tasks.read('p3').approval;
      assert.deepStrictEqual(tasks.decidePlan('p3', ap, 'rejected', `Use RM20\nplease ${i}`), { ok: true, status: 'planning' });
      await until(() => tasks.read('p3').status === 'plan-ready' && tasks.read('p3').approval !== ap);
      const c = callFor('Plan reply to Ali', true);
      assert.ok(prompt(c).includes(`The boss said: Use RM20 please ${i}`), 'the note is in the new plan run');
      assert.ok(prompt(c).includes('Your last plan:\n1. Read the files'));
      assert.strictEqual(c.args[c.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
      assert.strictEqual(tasks.read('p3').replans, String(i));
    }
    assert.strictEqual(tasks.decidePlan('p3', tasks.read('p3').approval, 'rejected', 'Still wrong').status, 'stopped');
    assert.strictEqual(tasks.read('p3').status, 'stopped');
    assert.match(tasks.read('p3').result, /sent the plan back 3 times/);
    assert.ok(!calls().some((x) => prompt(x).includes('Plan reply to Ali') && !prompt(x).includes('Make a plan only')), 'never did the work');
  });

  await test('Reject with no note stops the task; tasks waiting for it fail', async () => {
    putPlan('p4', 'siti', 'Plan discount');
    putAfter('p5', 'nurul', 'p4', 'invoice with discount');
    tasks.scan();
    await until(() => tasks.read('p4').status === 'plan-ready');
    assert.strictEqual(tasks.decidePlan('p4', tasks.read('p4').approval, 'rejected', '  ').status, 'stopped');
    assert.match(tasks.read('p4').result, /rejected the plan/);
    assert.ok(ended.some(([id, st]) => id === 'p4' && st === 'stopped'));
    assert.strictEqual(tasks.read('p5').status, 'failed');
  });

  await test('Stop works while planning and while the plan waits; restart stops a planning task', async () => {
    putPlan('p6', 'siti', 'LONG plan for the big job');
    tasks.scan();
    await until(() => tasks.read('p6').status === 'planning' && tasks.active().some((a) => a.id === 'p6'));
    tasks.stop('p6');
    await until(() => tasks.read('p6').status === 'stopped');
    putPlan('p7', 'siti', 'Plan for the waiting job');
    tasks.scan();
    await until(() => tasks.read('p7').status === 'plan-ready');
    assert.deepStrictEqual(tasks.stop('p7'), { ok: true });
    assert.strictEqual(tasks.read('p7').status, 'stopped');
    assert.deepStrictEqual(drops, ['p7'], 'its approval item is closed');
    putPlan('p8', 'aina', 'cut while planning');
    fs.writeFileSync(path.join(dir, 'tasks', 'p8.md'), fs.readFileSync(path.join(dir, 'tasks', 'p8.md'), 'utf8').replace('status: new', 'status: planning'));
    assert.deepStrictEqual(tasks.recover().map((t) => t.id), ['p8']);
    assert.strictEqual(tasks.read('p8').status, 'stopped');
    const again = tasks.read(tasks.rerun('p8').id);
    assert.strictEqual(again.plan, 'yes', 'run again: plans first again');
    await until(() => tasks.read(again.id).status === 'plan-ready');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} task tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
