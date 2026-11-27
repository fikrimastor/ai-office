// Pool tasks (staff: any) with a fake "claude": the first free staff whose role fits claims the task,
// busy staff leave it in the pool, a role nobody has fails, and a claimed task stays with its staff.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-claim-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const fake = `
const fs = require('fs');
const a = process.argv.slice(2);
const msg = a[a.indexOf('-p') + 1];
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))}, JSON.stringify({ msg, cwd: process.cwd(), at: Date.now() }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
setTimeout(() => {
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done: ' + msg.split('\\n')[2] }] } });
  out({ type: 'result', subtype: 'success', is_error: false });
}, msg.includes('LONG') ? 2000 : 300);
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
const { Tasks } = require('../lib/tasks');
const { access, chatEnv, resolveClaude } = require('../lib/chat');
const dir = path.join(tmp, 'office');
G.writeOffice(dir, G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: [
  { name: 'Siti', role: 'Sales', job: 'Sells' }, { name: 'Ali', role: 'Sales Lead', job: 'Sells' }, { name: 'Nurul', role: 'Finance', job: 'Invoices' }] }));

const ended = [];
const tasks = new Tasks(dir, {
  access: (id, o) => access(dir, id, o), claude: resolveClaude, env: chatEnv, checkMs: 5000,
  loadCfg: () => JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')),
  onStart: () => {}, onEnd: (t, r) => ended.push([t.id, t.status, r, t.name]),
});
const put = (id, head, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\n${head}status: new\n---\n${text}\n`);
const until = (fn, ms = 15000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 50); });
const calls = (word) => fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((c) => c.msg.includes(word));
const who = (c) => path.basename(c.cwd);
const st = (id) => tasks.read(id).status;
const idle = () => tasks.active().length === 0;
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };

(async () => {
  await test('a free staff whose role fits claims a pool task and runs it', async () => {
    put('p1', 'staff: any\nrole: sales\n', 'Quote 50 t-shirts');
    assert.strictEqual(tasks.list().find((t) => t.id === 'p1').pool, true);
    tasks.scan();
    const t = tasks.read('p1');
    assert.strictEqual(t.staff, 'siti', 'first fitting staff in office order'); assert.strictEqual(t.claimed, 'yes');
    assert.strictEqual(tasks.list().find((x) => x.id === 'p1').pool, false);
    await until(() => st('p1') === 'done');
    assert.deepStrictEqual(calls('Quote 50').map(who), ['siti']);
  });

  await test('all fitting staff busy: it waits in the pool, then the first one free claims it', async () => {
    put('b1', 'staff: siti\n', 'LONG busy one');
    put('b2', 'staff: ali\n', 'LONG busy two');
    tasks.scan();
    put('p2', 'staff: any\nrole: Sales\n', 'Follow up Kedai Ali');
    tasks.scan();
    assert.strictEqual(tasks.read('p2').staff, 'any', 'nobody free: stays in the pool');
    assert.strictEqual(tasks.list().find((t) => t.id === 'p2').pool, true);
    assert.ok(!calls('Follow up').length, 'Nurul is free but not sales');
    await until(() => st('p2') === 'done');
    const t = tasks.read('p2');
    assert.ok(['siti', 'ali'].includes(t.staff)); assert.strictEqual(t.claimed, 'yes');
    const freed = Math.min(...calls('LONG busy').map((c) => c.at)) + 2000;
    assert.ok(calls('Follow up')[0].at >= freed - 100, 'started only after a sales staff was free');
    await until(idle);
  });

  await test('a role nobody on the team has fails with a plain reason', async () => {
    put('p3', 'staff: any\nrole: driver\n', 'Deliver the shirts');
    tasks.scan();
    const t = tasks.read('p3');
    assert.strictEqual(t.status, 'failed');
    assert.match(t.result, /no active staff with the role "driver"/);
    assert.strictEqual(ended.find(([id]) => id === 'p3')[3], 'The team');
  });

  await test('two pool tasks never claim the same staff at once', async () => {
    put('p4', 'staff: any\nrole: sales\n', 'LONG sales one');
    put('p5', 'staff:\nrole: sales\n', 'LONG sales two');
    put('p6', 'staff: any\nrole: finance\n', 'invoice one');
    put('p7', 'staff: any\nrole: finance\n', 'invoice two');
    tasks.scan();
    assert.deepStrictEqual(['p4', 'p5'].map((id) => tasks.read(id).staff).sort(), ['ali', 'siti']);
    assert.strictEqual(tasks.read('p6').staff, 'nurul');
    assert.strictEqual(tasks.read('p7').staff, 'any', 'Nurul is taken by p6');
    await until(() => ['p4', 'p5', 'p6', 'p7'].every((id) => st(id) === 'done'));
    assert.strictEqual(tasks.read('p7').staff, 'nurul');
    assert.ok(calls('invoice two')[0].at >= calls('invoice one')[0].at + 300, 'one after the other');
    await until(idle);
  });

  await test('a pool task with after: waits for those tasks before anyone claims it', async () => {
    put('d1', 'staff: nurul\n', 'LONG price list');
    put('p8', 'staff: any\nrole: sales\nafter: d1\n', 'quote from the price list');
    tasks.scan();
    assert.strictEqual(tasks.read('p8').staff, 'any', 'sales staff are free, but it waits for d1');
    assert.strictEqual(tasks.list().find((t) => t.id === 'p8').waiting, true);
    await until(() => st('p8') === 'done');
    assert.strictEqual(tasks.read('p8').staff, 'siti');
    assert.ok(calls('quote from the price')[0].at >= calls('LONG price list')[0].at + 2000);
    await until(idle);
  });

  await test('Stop cancels a pool task; Run again of a claimed task puts it back in the pool', async () => {
    put('b3', 'staff: siti\n', 'LONG busy three');
    put('b4', 'staff: ali\n', 'LONG busy four');
    put('p9', 'staff: any\nrole: sales\n', 'never runs');
    tasks.scan();
    assert.deepStrictEqual(tasks.stop('p9'), { ok: true });
    assert.strictEqual(st('p9'), 'stopped');
    await until(idle);
    assert.strictEqual(st('p9'), 'stopped'); assert.ok(!calls('never runs').length);

    put('p10', 'staff: any\nrole: sales\n', 'LONG claimed then stopped');
    tasks.scan();
    assert.strictEqual(tasks.read('p10').staff, 'siti');
    await until(() => tasks.active().some((a) => a.id === 'p10'));
    tasks.stop('p10');
    await until(() => st('p10') === 'stopped');
    const r = tasks.rerun('p10');
    const again = tasks.read(r.id);
    assert.strictEqual(again.again, 'p10'); assert.strictEqual(again.role, 'sales');
    assert.ok(again.claimed === 'yes' && again.staff === 'siti', 'claimed again from the pool');
    assert.match(fs.readFileSync(tasks.file(r.id), 'utf8'), /^claimed: yes$/m);
    assert.match(r.id, /-any$/, 'made as a pool task');
    await until(() => st(r.id) === 'done');
  });

  await test('a claimed task keeps its staff when the office check sends it back', async () => {
    const hooks = path.join(dir, '.office', 'hooks'), seen = path.join(tmp, 'seen');
    fs.mkdirSync(hooks, { recursive: true });
    // first check of a task: wait a bit (so Siti is free again), then send it back
    fs.writeFileSync(path.join(hooks, 'task-completed.js'), `let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const t = JSON.parse(s), fs = require('fs'), f = ${JSON.stringify(seen)} + '-' + t.id;
  if (fs.existsSync(f)) process.exit(0);
  fs.writeFileSync(f, '1'); setTimeout(() => { process.stderr.write('Add the total'); process.exit(2); }, 800);
});\n`);
    put('b5', 'staff: siti\n', 'short busy');
    put('p11', 'staff: any\nrole: sales\n', 'Quote with a total');
    tasks.scan();
    assert.strictEqual(tasks.read('p11').staff, 'ali', 'Siti is busy, so Ali takes it');
    await until(() => st('p11') === 'done');
    const t = tasks.read('p11');
    assert.strictEqual(t.staff, 'ali'); assert.strictEqual(t.retries, '1');
    const runs = calls('Quote with a total');
    assert.strictEqual(runs.length, 2); assert.deepStrictEqual(runs.map(who), ['ali', 'ali']);
    assert.match(runs[1].msg, /Add the total/);
    fs.rmSync(path.join(hooks, 'task-completed.js'));
    await until(idle);
  });

  console.log(`all ${n} claim tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
