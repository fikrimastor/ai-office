// Quality-check hooks with a fake "claude": .office/hooks/task-completed.js can send work back (exit 2),
// .office/hooks/staff-idle.js can give an idle staff new work (exit 2). Both are off unless the file is there.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-gates-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const fake = `
const fs = require('fs');
const a = process.argv.slice(2);
const msg = a[a.indexOf('-p') + 1];
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))}, JSON.stringify({ msg }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
setTimeout(() => {
  const plan = msg.includes('Make a plan only') ? '1. Read the files' : '';
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: plan || 'Done: ' + msg.split('\\n')[2] }] } });
  out({ type: 'result', subtype: 'success', is_error: false });
}, 150);
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
assert.ok(!fs.existsSync(path.join(dir, '.office', 'hooks')), 'a new office has no hooks');

const ended = [], checks = [], plans = [];
const tasks = new Tasks(dir, {
  access: (id, o) => access(dir, id, o), claude: resolveClaude, env: chatEnv, checkMs: 1500,
  loadCfg: () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')),
  onStart: () => {}, onEnd: (t, r) => ended.push([t.id, t.status, r]),
  onCheck: (t, f) => checks.push([t.id, t.retries, f]),
  onPlan: (t) => { plans.push(t.id); return `ap-${t.id}`; },
});
const hooks = path.join(dir, '.office', 'hooks');
const log = path.join(tmp, 'hook.jsonl');
// a hook script: logs its stdin, then runs body (t = the input)
const hook = (name, body) => {
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, name), `let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const t = JSON.parse(s); require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ hook: ${JSON.stringify(name)}, ...t }) + '\\n');
  ${body}
});\n`);
};
const unhook = (name) => fs.rmSync(path.join(hooks, name), { force: true });
const seen = (name) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter((x) => x.hook === name);
const put = (id, staff, text, extra = '') => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\nstaff: ${staff}\n${extra}status: new\n---\n${text}\n`);
const until = (fn, ms = 15000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 50); });
const prompts = () => fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).msg);
const endOf = (id) => ended.find(([x]) => x === id);
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };

(async () => {
  await test('no hook: a task is done as before', async () => {
    put('g1', 'siti', 'Quote 50 t-shirts');
    tasks.scan();
    await until(() => endOf('g1'));
    const t = tasks.read('g1');
    assert.strictEqual(t.status, 'done'); assert.strictEqual(t.result, 'Done: Quote 50 t-shirts');
    assert.strictEqual(t.retries, undefined); assert.deepStrictEqual(checks, []);
  });

  await test('check exit 0: done, and the hook got the task as JSON in the office folder', async () => {
    hook('task-completed.js', "const fs = require('fs'); if (fs.realpathSync(process.cwd()) !== fs.realpathSync(" + JSON.stringify(dir) + ")) process.exit(1); process.exit(0);");
    put('g2', 'siti', 'Invoice for Ali', 'project: kedai-ali\n');
    tasks.scan();
    await until(() => endOf('g2'));
    assert.strictEqual(tasks.read('g2').status, 'done');
    assert.strictEqual(tasks.read('g2').result, 'Done: Invoice for Ali', 'no "could not run" note: cwd was the office');
    const x = seen('task-completed.js').find((y) => y.id === 'g2');
    assert.deepStrictEqual({ staff: x.staff, from: x.from, project: x.project, title: x.title, task: x.task, result: x.result },
      { staff: 'siti', from: 'pa', project: 'kedai-ali', title: 'Invoice for Ali', task: 'Invoice for Ali', result: 'Done: Invoice for Ali' });
  });

  await test('check exit 2: back to the same staff with the feedback in the next prompt, then done', async () => {
    hook('task-completed.js', `const f = require('path').join(${JSON.stringify(tmp)}, 'once-' + t.id);
  if (!require('fs').existsSync(f)) { require('fs').writeFileSync(f, ''); console.error('The quote has no total.\\nAdd it.'); process.exit(2); }`);
    put('g3', 'nurul', 'Quote for the school');
    tasks.scan();
    await until(() => endOf('g3'));
    const t = tasks.read('g3');
    assert.strictEqual(t.status, 'done'); assert.strictEqual(t.retries, '1');
    assert.deepStrictEqual(checks, [['g3', 1, 'The quote has no total. Add it.']]);
    const p = prompts().filter((m) => m.includes('Quote for the school'));
    assert.strictEqual(p.length, 2, 'the staff ran it twice');
    assert.ok(!p[0].includes('office check'));
    assert.match(p[1], /The office check said: The quote has no total\. Add it\./);
    assert.strictEqual(ended.filter(([id]) => id === 'g3').length, 1, 'the PA hears once, at the end');
  });

  await test('check keeps saying exit 2: after 2 retries the task fails with the last feedback', async () => {
    hook('task-completed.js', "console.error('Still no total'); process.exit(2);");
    put('g4', 'aina', 'Quote for the mosque');
    tasks.scan();
    await until(() => endOf('g4'));
    const t = tasks.read('g4');
    assert.strictEqual(t.status, 'failed'); assert.strictEqual(t.retries, '2');
    assert.match(t.result, /sent this back 3 times\. Last time it said: Still no total/);
    assert.strictEqual(prompts().filter((m) => m.includes('Quote for the mosque')).length, 3);
  });

  await test('a broken check (crash or timeout) does not block the work', async () => {
    hook('task-completed.js', "throw new Error('oops');");
    put('g5', 'siti', 'Reply to Ali');
    tasks.scan();
    await until(() => endOf('g5'));
    assert.strictEqual(tasks.read('g5').status, 'done');
    assert.match(tasks.read('g5').result, /^Done: Reply to Ali\n\n\(The office check could not run: exit code 1\./);
    hook('task-completed.js', 'setTimeout(() => process.exit(2), 10000);');
    put('g6', 'siti', 'Reply to Abu');
    tasks.scan();
    await until(() => endOf('g6'));
    assert.strictEqual(tasks.read('g6').status, 'done');
    assert.match(tasks.read('g6').result, /could not run: it took too long/);
  });

  await test('plan runs do not trigger the check; the real run after approval does', async () => {
    hook('task-completed.js', 'process.exit(0);');
    put('g7', 'nurul', 'Plan the big job', 'plan: yes\n');
    tasks.scan();
    await until(() => tasks.read('g7').status === 'plan-ready');
    assert.ok(!seen('task-completed.js').some((x) => x.id === 'g7'), 'no check on the plan');
    tasks.decidePlan('g7', tasks.read('g7').approval, 'approved');
    await until(() => endOf('g7'));
    assert.strictEqual(tasks.read('g7').status, 'done');
    assert.strictEqual(seen('task-completed.js').filter((x) => x.id === 'g7').length, 1);
    unhook('task-completed.js');
  });

  await test('idle hook exit 2: its stdout becomes a new task for that staff', async () => {
    hook('staff-idle.js', "if (t.staff === 'siti' && t.lastTask.title === 'Count the shirts') { console.log('  Tidy the inbox  '); process.exit(2); }");
    put('g8', 'siti', 'Count the shirts');
    tasks.scan();
    await until(() => tasks.list().some((t) => t.idle === 'yes' && t.status === 'done'));
    const made = tasks.list().filter((t) => t.idle === 'yes');
    assert.strictEqual(made.length, 1);
    assert.deepStrictEqual([made[0].staff, made[0].from, made[0].task], ['siti', 'pa', 'Tidy the inbox']);
    const x = seen('staff-idle.js').find((y) => y.lastTask.id === 'g8');
    assert.strictEqual(x.lastTask.status, 'done'); assert.strictEqual(x.lastTask.result, 'Done: Count the shirts');
    unhook('staff-idle.js');
  });

  await test('idle hook loop cap: at most 3 idle-made tasks in a row, until someone else gives work', async () => {
    hook('staff-idle.js', "if (t.staff === 'aina') { console.log('Busy work'); process.exit(2); }");
    put('g9', 'aina', 'First real job');
    tasks.scan();
    const mine = () => tasks.list().filter((t) => t.idle === 'yes' && t.staff === 'aina');
    await until(() => mine().length === 3 && mine().every((t) => t.status === 'done') && seen('staff-idle.js').filter((x) => x.staff === 'aina').length === 3);
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(mine().length, 3, 'no 4th idle task');
    assert.strictEqual(seen('staff-idle.js').filter((x) => x.staff === 'aina').length, 3, 'the hook is not even run after the cap');
    put('g10', 'aina', 'Second real job');
    tasks.scan();
    await until(() => mine().length === 4);
    unhook('staff-idle.js');
    await until(() => mine().every((t) => t.status === 'done') && tasks.active().length === 0);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} gate tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
