// Plain Node tests for the office generator. Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../lib/generate');
const D = require('../lib/defaults');
const T = require('../lib/templates');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

const answers = {
  company: 'Kedai Ali', pa: 'Hana', invois: true,
  staff: [D.STAFF[0], { name: 'Mei Ling', role: 'Finance', job: 'Invoices' }, { name: 'Plan', role: 'Sales', job: 'Quotes' }, { name: 'Mei Ling', role: 'Ops', job: 'Stock' }]
    .map(({ name, role, job }) => ({ name, role, job })),
};
const cfg = G.buildConfig(answers);
const dir = path.join(tmp, 'office');

test('staff ids are unique, safe and avoid built-in agent names', () => {
  assert.deepStrictEqual(cfg.staff.map((s) => s.id), ['aina', 'mei-ling', 'plan-staff', 'mei-ling-2']);
});

test('invois tools allowed in dashboard runs: role tools, not the ask-first ones', () => {
  const T = require('../lib/templates');
  const sales = T.addonAllowed(cfg, 'plan-staff');
  assert.ok(sales.includes('mcp__invois-online__get_companies'));
  assert.ok(sales.includes('mcp__invois-online__create_quotation'));
  assert.ok(sales.includes('mcp__invois-online__authenticate'));
  assert.ok(sales.includes('mcp__claude_ai_Invois_Online__get_quotations'), 'claude.ai connector names too');
  assert.ok(!sales.includes('mcp__claude_ai_Invois_Online__send_quotation_email'));
  assert.ok(!sales.includes('mcp__invois-online__send_quotation_email'));
  const fin = T.addonAllowed(cfg, 'mei-ling');
  assert.ok(fin.includes('mcp__invois-online__create_invoice'));
  assert.ok(!fin.includes('mcp__invois-online__send_invoice_email') && !fin.includes('mcp__invois-online__create_payment'));
  const pa = T.addonAllowed(cfg, 'pa');
  assert.ok(pa.includes('mcp__invois-online__get_quotations'));
  assert.ok(!pa.some((t) => /create_|send_|update_|convert_/.test(t)));
  assert.deepStrictEqual(T.addonAllowed(cfg, 'aina'), []);
});

test('invois add-on goes to sales and finance staff only', () => {
  assert.deepStrictEqual(cfg.addons['invois-online'].staff, ['mei-ling', 'plan-staff']);
});

test('writes the office files', () => {
  G.writeOffice(dir, cfg);
  for (const f of ['office.json', 'CLAUDE.md', 'OFFICE.md', '.claude/settings.json', '.office/hook.js',
    'staff/aina/CLAUDE.md', 'staff/aina/.claude/settings.json', '.claude/agents/mei-ling.md',
    '.claude/skills/add-staff-tool/SKILL.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  for (const d of ['inbox', 'approvals', 'projects']) assert.ok(fs.statSync(path.join(dir, d)).isDirectory());
  assert.ok(G.isOffice(dir));
  assert.match(read(dir, '.claude/agents/plan-staff.md'), /mcp__invois-online__create_quotation/);
  assert.doesNotMatch(read(dir, '.claude/agents/aina.md'), /invois/);
});

test('no em or en dashes in generated text', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /[–—]/, f);
});

test('never overwrites existing files', () => {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'mine');
  const res = G.writeOffice(dir, cfg);
  assert.strictEqual(read(dir, 'CLAUDE.md'), 'mine');
  assert.ok(res.skipped.includes('CLAUDE.md'));
});

test('repairSettings fixes moved paths and keeps the user\'s own hooks and rules', () => {
  const moved = path.join(tmp, 'moved');
  fs.renameSync(dir, moved);
  const f = path.join(moved, '.claude/settings.json');
  const s = JSON.parse(read(f));
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo mine' }] });
  s.model = 'sonnet';
  s.permissions.allow.push('Bash(git status)');
  fs.writeFileSync(f, JSON.stringify(s));
  const fixed = G.repairSettings(moved);
  assert.ok(fixed.includes('.claude/settings.json'));
  const after = JSON.parse(read(f));
  assert.strictEqual(after.model, 'sonnet');
  assert.deepStrictEqual(after.permissions.allow, ['Bash(git status)', ...T.officeRules(moved)]);
  assert.ok(after.hooks.Stop.some((e) => e.hooks[0].command === 'echo mine'));
  const ours = after.hooks.Stop.filter((e) => e.hooks[0].command.includes('hook.js'));
  assert.strictEqual(ours.length, 1);
  assert.ok(ours[0].hooks[0].command.includes(path.join(moved, '.office', 'hook.js')));
  assert.deepStrictEqual(G.repairSettings(moved), [], 'second repair changes nothing');
});

test('file rules use Claude Code path form on each OS', () => {
  assert.deepStrictEqual(T.officeRules('/home/a/my office', 'linux'), ['Read(//home/a/my office/**)', 'Edit(//home/a/my office/**)']);
  assert.deepStrictEqual(T.officeRules('C:\\Users\\Ali\\kedai\\', 'win32'), ['Read(//c/Users/Ali/kedai/**)', 'Edit(//c/Users/Ali/kedai/**)']);
  const st = JSON.parse(read(path.join(tmp, 'moved'), 'staff/aina/.claude/settings.json'));
  assert.deepStrictEqual(st.permissions.allow, T.officeRules(path.join(tmp, 'moved')), 'staff folders allow the whole office');
});

test('answers file: defaults fill gaps, errors are plain', () => {
  const bin = path.join(__dirname, '..', 'bin', 'ai-office.js');
  const run = (ans) => { const f = path.join(tmp, 'ans.json'); fs.writeFileSync(f, JSON.stringify(ans));
    return spawnSync(process.execPath, [bin, '--answers', f, '--skip-check'], { cwd: tmp, encoding: 'utf8' }); };
  let r = run({ company: 'Kedai Ali', staff: [{ name: 'Siti' }, { name: 'Zul', role: 'Driver', job: 'Deliveries' }] });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const o = JSON.parse(read(tmp, 'kedai-ali/office.json'));
  assert.deepStrictEqual(o.staff.map((x) => [x.id, x.role]), [['siti', 'Sales'], ['zul', 'Driver']]);
  assert.strictEqual(o.pa.name, 'Hana');
  r = run({ company: 'Kedai Ali' });
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /already has an office/);
  r = run({ folder: './x', staff: [{ name: 'Bob' }] });
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /needs a role/);
});

test('launcher: written once, refreshed only when it is ours', () => {
  const moved = path.join(tmp, 'moved');
  const name = T.launcher(process.execPath).name;
  const f = path.join(moved, name);
  assert.ok(fs.existsSync(f), 'setup wrote it');
  fs.rmSync(f);
  assert.strictEqual(G.writeLauncher(moved), name, 'first write');
  assert.match(read(f), /AI Office launcher/); assert.match(read(f), /github:fikrimastor\/ai-office#personal/);
  assert.strictEqual(G.writeLauncher(moved), null, 'unchanged');
  fs.writeFileSync(f, 'my own script');
  assert.strictEqual(G.writeLauncher(moved), null, 'user file kept');
  assert.strictEqual(read(f), 'my own script');
  const win = T.launcher('C:\\Users\\Ali\\.ai-office\\node\\node.exe', 'win32');
  assert.strictEqual(win.name, 'Start AI Office.cmd'); assert.match(win.text, /\r\ncd \/d "%~dp0"\r\n/); assert.match(win.text, /set "PATH=C:\\Users\\Ali\\.ai-office\\node;%PATH%"/);
});

test('hook.js appends one trimmed line per event', () => {
  const moved = path.join(tmp, 'moved');
  const input = { hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'a1', agent_type: 'siti', tool_name: 'Agent',
    tool_input: { description: 'Quote', subagent_type: 'siti', prompt: 'x'.repeat(5000) }, cwd: moved };
  const r = spawnSync(process.execPath, [path.join(moved, '.office/hook.js')], { input: JSON.stringify(input) });
  assert.strictEqual(r.status, 0);
  const line = JSON.parse(read(moved, '.office/events.jsonl').trim().split('\n').pop());
  assert.strictEqual(line.ev, 'PreToolUse');
  assert.strictEqual(line.staff, 'siti');
  assert.strictEqual(line.task, 'Quote');
  assert.ok(!('prompt' in line));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${n} tests passed`);
