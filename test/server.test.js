// Office server + API tests against a temporary office. Run: npm test
process.env.AI_OFFICE_NO_DOCTOOLS = '1'; // never download the document tools in tests
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const G = require('../lib/generate');
const D = require('../lib/defaults');
const { createServer } = require('../lib/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-srv-'));
// a fake "claude", so briefing the PA (after an approval) never runs the real one in tests
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const fake = "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n');";
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
  fs.mkdirSync(path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), fake);
} else fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const dir = path.join(tmp, 'office');
const cfg = G.buildConfig({ company: 'Kedai Ali', pa: 'Hana', staff: D.STAFF.slice(0, 3).map(({ name, role, job }) => ({ name, role, job })) });
G.writeOffice(dir, cfg);
{ // the old behaviour: the boss decides plans (the manager deciding: proxy.test.js)
  const f = path.join(dir, 'office.json'), c = JSON.parse(fs.readFileSync(f, 'utf8')); c.pa.planApprover = 'boss'; fs.writeFileSync(f, JSON.stringify(c, null, 2));
}
const read = (...p) => fs.readFileSync(path.join(dir, ...p), 'utf8');

let port;
function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    // like the dashboard page: a browser sends its Origin (pass origin: undefined to leave it out, as a script would)
    const h = Object.fromEntries(Object.entries({ host: `localhost:${port}`, 'x-office-key': cfg.key, origin: `http://localhost:${port}`, ...headers }).filter(([, v]) => v !== undefined));
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; });
      res.on('end', () => { let j = s; try { j = JSON.parse(s); } catch { /* html */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
}

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} ${name}`); };

(async () => {
  const srv = createServer(dir);
  port = await srv.listen(0);
  try {
    await test('page has the key; API needs it; wrong host and origin are refused', async () => {
      const page = await req('GET', '/', null, { 'x-office-key': '' });
      assert.strictEqual(page.status, 200); assert.ok(page.body.includes(cfg.key));
      assert.strictEqual((await req('GET', '/api/office', null, { 'x-office-key': 'nope' })).status, 401);
      assert.strictEqual((await req('GET', '/api/office', null, { host: 'evil.example:80' })).status, 421);
      assert.strictEqual((await req('POST', '/api/inbox', { from: 'x', text: 'y' }, { origin: 'https://evil.example' })).status, 403);
      const o = await req('GET', '/api/office');
      assert.strictEqual(o.status, 200); assert.strictEqual(o.body.company, 'Kedai Ali'); assert.ok(!('key' in o.body));
      assert.strictEqual((await req('GET', '/../office.json')).status, 404);
      assert.strictEqual((await req('GET', '/api/staff/..%2F..%2Fx')).status, 400);
    });

    await test('edit staff: CLAUDE.md sections, agent description and team table follow', async () => {
      const r = await req('PUT', '/api/staff/siti', { name: 'Siti Aisyah', role: 'Sales Lead', job: 'Quotes and follow ups.', rules: ['Reply fast', '', 'No discounts'], colour: '#3A86FF' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const t = read('staff/siti/CLAUDE.md');
      assert.match(t, /^# Siti Aisyah, Sales Lead$/m); assert.match(t, /You are \*\*Siti Aisyah\*\*, the Sales Lead staff/);
      assert.match(t, /## Rules\n\n- Reply fast\n- No discounts\n/); assert.match(t, /## Tools/);
      assert.match(read('.claude/agents/siti.md'), /^description: Siti Aisyah, Sales Lead\. Quotes and follow ups\./m);
      assert.match(read('CLAUDE.md'), /\| siti \| Siti Aisyah \| Sales Lead \| Quotes and follow ups\. \|/);
      assert.strictEqual(JSON.parse(read('office.json')).staff.find((s) => s.id === 'siti').colour, '#3A86FF');
    });

    await test('add, archive, reactivate, delete staff', async () => {
      const a = await req('POST', '/api/staff', { name: 'Farah', role: 'Marketing', job: 'Posts and promos' });
      assert.strictEqual(a.status, 200, JSON.stringify(a.body));
      assert.ok(fs.existsSync(path.join(dir, '.claude/agents/farah.md')));
      assert.ok(fs.existsSync(path.join(dir, 'staff/farah/.claude/settings.json')));
      assert.match(read('CLAUDE.md'), /\| farah \| Farah \| Marketing \|/);
      assert.strictEqual((await req('POST', '/api/staff/farah/archive')).status, 200);
      assert.ok(fs.existsSync(path.join(dir, '.archive/staff/farah/CLAUDE.md')));
      assert.doesNotMatch(read('CLAUDE.md'), /\| farah \|/);
      assert.strictEqual((await req('POST', '/api/staff/farah/delete', { confirm: 'yes' })).status, 400);
      assert.strictEqual((await req('POST', '/api/staff/farah/reactivate')).status, 200);
      assert.ok(fs.existsSync(path.join(dir, 'staff/farah/CLAUDE.md')));
      await req('POST', '/api/staff/farah/archive');
      assert.strictEqual((await req('POST', '/api/staff/farah/delete', { confirm: 'DELETE' })).status, 200);
      assert.ok(!fs.existsSync(path.join(dir, '.archive/staff/farah')));
    });

    await test('projects: create, update header, add note', async () => {
      const p = await req('POST', '/api/projects', { title: 'Kedai Ali website', customer: 'Kedai Ali', deadline: '2026-12-01', what: 'Shop site' });
      assert.strictEqual(p.body.id, 'kedai-ali-website');
      const u = await req('PUT', '/api/projects/kedai-ali-website', { status: 'waiting' });
      assert.strictEqual(u.body.status, 'waiting'); assert.strictEqual(u.body.deadline, '2026-12-01');
      const nn = await req('POST', '/api/projects/kedai-ali-website/notes', { note: 'Budget RM3,000' });
      assert.strictEqual(nn.body.notes.length, 1); assert.match(nn.body.notes[0], /^Budget RM3,000 \(boss, \d{4}-\d{2}-\d{2}\)$/);
      // a project Claude wrote by hand, without a header, still lists
      fs.mkdirSync(path.join(dir, 'projects/syarikat-jaya')); fs.writeFileSync(path.join(dir, 'projects/syarikat-jaya/CLAUDE.md'), '# Syarikat Jaya shirts\n\nNotes go here.\n');
      const all = await req('GET', '/api/projects');
      assert.deepStrictEqual(all.body.map((x) => x.title).sort(), ['Kedai Ali website', 'Syarikat Jaya shirts']);
    });

    await test('inbox: add, tickets for hand-written items, assign', async () => {
      const a = await req('POST', '/api/inbox', { from: 'Puan Rosnah', source: 'whatsapp', type: 'order', text: '30 kotak nasi lemak' });
      assert.strictEqual(a.body.ticket, '101'); assert.strictEqual(a.body.status, 'new');
      fs.writeFileSync(path.join(dir, 'inbox/20261124-090000-ali.md'), '---\nfrom: Ali\nsource: email\ntype: enquiry  # comment\nstatus: new\nreceived: 2026-11-24T09:00:00+08:00\nassigned:\n---\nPrice?\n');
      const list = await req('GET', '/api/inbox');
      const ali = list.body.find((x) => x.from === 'Ali');
      assert.strictEqual(ali.ticket, '102'); assert.strictEqual(ali.type, 'enquiry');
      assert.match(read('inbox/20261124-090000-ali.md'), /^ticket: 102$/m);
      const u = await req('PUT', `/api/inbox/${ali.id}`, { assigned: 'aina', status: 'working' });
      assert.strictEqual(u.body.assigned, 'aina');
      assert.strictEqual((await req('PUT', `/api/inbox/${ali.id}`, { assigned: 'nobody' })).status, 400);
    });

    await test('approvals: ask, decide once, event logged', async () => {
      const a = await req('POST', '/api/approvals', { from: 'siti', action: 'Give 10% discount to Kedai Ali', details: 'RM125 off', project: 'kedai-ali-website' });
      assert.strictEqual(a.body.status, 'pending');
      const d = await req('POST', `/api/approvals/${a.body.id}/decide`, { decision: 'approved', note: 'OK this once' });
      assert.strictEqual(d.body.status, 'approved'); assert.ok(d.body.decided);
      assert.match(read(`approvals/${a.body.id}.md`), /Boss: OK this once/);
      assert.strictEqual((await req('POST', `/api/approvals/${a.body.id}/decide`, { decision: 'rejected' })).status, 409);
      const ev = read('.office/events.jsonl').trim().split('\n').map(JSON.parse).pop();
      assert.strictEqual(ev.ev, 'Approval'); assert.match(ev.msg, /approved/);
    });

    await test('ask-first action: approve saves the OK for the guard and starts the staff; setting can be Always allow', async () => {
      const o = JSON.parse(read('office.json'));
      o.addons = { 'invois-online': { enabled: true, mcp: 'invois-online', staff: ['siti'] } };
      fs.writeFileSync(path.join(dir, 'office.json'), JSON.stringify(o, null, 2));
      assert.strictEqual((await req('POST', '/api/approvals', { from: 'siti', action: 'x', tool: 'rm_everything', input: {} })).status, 400);
      const a = await req('POST', '/api/approvals', { from: 'siti', action: 'Email QA000123 to Kedai Ali', tool: 'mcp__invois-online__send_quotation_email', input: { company_id: 1, quotation_id: 'QA000123' } });
      assert.strictEqual(a.body.tool, 'send_quotation_email');
      await req('POST', `/api/approvals/${a.body.id}/decide`, { decision: 'approved' });
      const g = JSON.parse(read('.office/grants.json')).pop();
      assert.deepStrictEqual([g.from, g.tool, g.input.quotation_id, g.used], ['siti', 'send_quotation_email', 'QA000123', null]);
      const t = fs.readdirSync(path.join(dir, 'tasks')).filter((f) => f.endsWith('-siti.md')).map((f) => read(`tasks/${f}`)).find((x) => x.includes(a.body.id));
      assert.ok(t && /send_quotation_email/.test(t) && /QA000123/.test(t), 'siti got a task to do it');
      const r = await req('POST', '/api/approvals', { from: 'siti', action: 'Email QA000124', tool: 'send_quotation_email', input: { company_id: 1, quotation_id: 'QA000124' } });
      await req('POST', `/api/approvals/${r.body.id}/decide`, { decision: 'rejected' });
      assert.strictEqual(JSON.parse(read('.office/grants.json')).length, 1, 'a rejection grants nothing');
      const acts = await req('GET', '/api/actions');
      assert.deepStrictEqual(acts.body.map((x) => x.tool), ['send_quotation_email', 'send_invoice_email', 'create_payment']);
      await req('POST', '/api/actions', { tool: 'send_quotation_email', always: true });
      assert.deepStrictEqual(JSON.parse(read('office.json')).addons['invois-online'].always, ['send_quotation_email']);
      await req('POST', '/api/actions', { tool: 'send_quotation_email', always: false });
      assert.deepStrictEqual(JSON.parse(read('office.json')).addons['invois-online'].always, []);
    });

    await test('plan: yes task: the plan waits in Needs your OK, Approve runs the work, a stale plan cannot be decided', async () => {
      const until = (fn, ms = 15000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 50); });
      const put = (id, text) => fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\nstaff: nurul\nplan: yes\nstatus: new\n---\n${text}\n`);
      const planOf = async (id) => (await req('GET', '/api/approvals')).body.find((x) => x.task === id);
      put('plan1', 'Big invoice clean up');
      await until(() => /^status: plan-ready$/m.test(read('tasks/plan1.md')));
      const a = await planOf('plan1');
      assert.deepStrictEqual([a.kind, a.from, a.status, a.action], ['plan', 'nurul', 'pending', 'Plan: Big invoice clean up']);
      assert.match(read('tasks/plan1.md'), new RegExp(`^approval: ${a.id}$`, 'm'));
      assert.strictEqual((await req('POST', `/api/approvals/${a.id}/decide`, { decision: 'approved' })).status, 200);
      await until(() => /^status: done$/m.test(read('tasks/plan1.md')));
      assert.match(read('tasks/plan1.md'), /^plan: approved$/m);
      put('plan2', 'Another big job');
      await until(() => /^status: plan-ready$/m.test(read('tasks/plan2.md')));
      const b = await planOf('plan2');
      assert.strictEqual((await req('POST', '/api/tasks/plan2/stop')).status, 200);
      assert.strictEqual((await planOf('plan2')).status, 'rejected', 'Stop closes its approval item');
      assert.strictEqual((await req('POST', `/api/approvals/${b.id}/decide`, { decision: 'approved' })).status, 409);
      put('plan3', 'Third big job');
      await until(() => /^status: plan-ready$/m.test(read('tasks/plan3.md')));
      const c = await planOf('plan3');
      fs.writeFileSync(path.join(dir, 'tasks/plan3.md'), read('tasks/plan3.md').replace('status: plan-ready', 'status: stopped'));
      const r = await req('POST', `/api/approvals/${c.id}/decide`, { decision: 'approved' });
      assert.strictEqual(r.status, 409, 'the task moved on'); assert.match(r.body.error, /no longer waiting/);
      assert.strictEqual((await planOf('plan3')).status, 'pending', 'nothing decided');
    });

    await test('clean up: needs CLEAR, clears only what was picked, never the staff setup', async () => {
      await new Promise((res) => setTimeout(res, 800)); // the PA's short briefing after the approval ends first
      fs.writeFileSync(path.join(dir, 'staff/siti/quote.md'), 'x');
      fs.appendFileSync(path.join(dir, '.office/events.jsonl'), '{"ev":"Stop"}\n');
      assert.strictEqual((await req('POST', '/api/cleanup', { items: ['inbox'], confirm: 'yes' })).status, 400);
      const r = await req('POST', '/api/cleanup', { items: ['activity', 'inbox', 'staffFiles', 'nonsense'], confirm: 'CLEAR' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(fs.readdirSync(path.join(dir, 'inbox')).length, 0);
      assert.strictEqual(read('.office/events.jsonl'), '');
      assert.ok(!fs.existsSync(path.join(dir, 'staff/siti/quote.md')));
      assert.ok(fs.existsSync(path.join(dir, 'staff/siti/CLAUDE.md')) && fs.existsSync(path.join(dir, 'staff/siti/.claude/settings.json')));
      assert.ok(fs.readdirSync(path.join(dir, 'approvals')).length > 0, 'approvals not picked, so kept');
      assert.ok(fs.existsSync(path.join(dir, 'office.json')) && fs.existsSync(path.join(dir, '.claude/agents/siti.md')));
    });

    await test('linked folders: checked, saved, put in the terminal settings, removed again', async () => {
      const ext = path.join(tmp, 'shop website'); fs.mkdirSync(ext);
      assert.match((await req('POST', '/api/linked', { path: 'relative/dir' })).body.error, /full folder path/);
      assert.match((await req('POST', '/api/linked', { path: path.join(tmp, 'nope') })).body.error, /does not exist/);
      assert.match((await req('POST', '/api/linked', { path: os.homedir() })).body.error, /too wide/);
      assert.match((await req('POST', '/api/linked', { path: tmp })).body.error, /contains the office/);
      const r = await req('POST', '/api/linked', { path: ext, label: 'Website' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.map((l) => [l.label, l.ok]), [['Website', true]]);
      const T = require('../lib/templates');
      const allow = () => JSON.parse(read('staff/siti/.claude/settings.json')).permissions.allow;
      assert.ok(T.officeRules(ext).every((x) => allow().includes(x)), 'staff terminal settings allow the linked folder');
      // a project's own linked folder
      const pr = await req('PUT', '/api/projects/kedai-ali-website', { linked: ext });
      assert.strictEqual(pr.body.linked, ext);
      await req('PUT', '/api/projects/kedai-ali-website', { linked: '' });
      const after = await req('POST', '/api/linked/remove', { path: ext });
      assert.deepStrictEqual(after.body, []);
      assert.ok(!T.officeRules(ext).some((x) => allow().includes(x)), 'unlinked folder rules are gone');
      assert.ok(T.officeRules(dir).every((x) => allow().includes(x)), 'office rules stay');
    });

    await test('staff commands: saved, shell tool only while on, Tools line kept in step', async () => {
      const r = await req('PUT', '/api/staff/aina', { commands: ['git', 'nope'], customCommands: ['php vendor/bin/pint'] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.commands, ['git']);
      assert.match(read('.claude/agents/aina.md'), /^tools: Read, Write, Edit, Glob, Grep, Bash$/m);
      assert.match(read('staff/aina/CLAUDE.md'), /^- Commands you may run, in the office or a linked folder: Office documents \(.*\); Git \(.*\); `php vendor\/bin\/pint`\./m);
      assert.strictEqual((await req('PUT', '/api/staff/aina', { customCommands: ['ls; rm -rf /'] })).status, 400);
      await req('PUT', '/api/staff/aina', { commands: [], customCommands: [] }); // Office documents stays on by default
      assert.match(read('.claude/agents/aina.md'), /Bash/);
      assert.match(read('staff/aina/CLAUDE.md'), /Commands you may run.*Office documents/);
      await req('PUT', '/api/staff/aina', { docs: false });
      assert.strictEqual(JSON.parse(read('office.json')).staff.find((x) => x.id === 'aina').docs, false);
      assert.doesNotMatch(read('.claude/agents/aina.md'), /Bash/);
      assert.doesNotMatch(read('staff/aina/CLAUDE.md'), /Commands you may run/);
      await req('PUT', '/api/staff/aina', { docs: true });
      assert.strictEqual(JSON.parse(read('office.json')).staff.find((x) => x.id === 'aina').docs, undefined);
      const T = require('../lib/templates');
      // model and effort: defaults, changed per staff and for the manager, used by the terminal subagent too
      let run = (await req('GET', '/api/run')).body;
      assert.deepStrictEqual(run.people.pa, { model: 'opus', effort: 'medium' });
      assert.deepStrictEqual(run.people.aina, { model: 'sonnet', effort: 'medium' });
      assert.match(read('.claude/agents/aina.md'), /^model: sonnet$/m);
      assert.strictEqual((await req('PUT', '/api/staff/aina', { model: 'haiku', effort: 'low' })).status, 200);
      assert.match(read('.claude/agents/aina.md'), /^model: haiku$/m);
      assert.strictEqual((await req('PUT', '/api/staff/aina', { model: 'gpt-9' })).status, 400);
      assert.strictEqual((await req('PUT', '/api/manager', { model: 'fable', effort: 'high' })).status, 200);
      run = (await req('GET', '/api/run')).body;
      assert.deepStrictEqual(run.people.pa, { model: 'fable', effort: 'high' });
      assert.deepStrictEqual(run.people.aina, { model: 'haiku', effort: 'low' });
      assert.deepStrictEqual(T.runFlags(JSON.parse(read('office.json')), 'aina'), ['--model', 'haiku', '--effort', 'low']);
      await req('PUT', '/api/staff/aina', { model: 'default', effort: 'default' });
      assert.deepStrictEqual(T.runFlags(JSON.parse(read('office.json')), 'aina'), []);
      assert.match(read('.claude/agents/aina.md'), /^model: inherit$/m);
      // outside MCP servers: none without an add-on job; with one, the user's own servers but no claude.ai connectors
      const oc = JSON.parse(read('office.json'));
      assert.deepStrictEqual(T.mcpRun(oc, 'aina', true), { args: ['--strict-mcp-config'], env: {} });
      const withInv = { ...oc, addons: { 'invois-online': { enabled: true } } };
      assert.deepStrictEqual(T.mcpRun(withInv, 'pa', true), { args: [], env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } });
      assert.deepStrictEqual(T.mcpRun(withInv, 'pa', false), { args: [], env: {} }, 'only the connector: keep it');
      const settings = JSON.parse(read('staff/aina/.claude/settings.json'));
      assert.ok(settings.hooks.PreToolUse.some((e) => e.matcher === 'Bash' && /guard\.js"$/.test(e.hooks[0].command)), 'guard hook registered');
      assert.ok(fs.existsSync(path.join(dir, '.office/guard.js')));
    });

    await test('live stream says what changed', async () => {
      await new Promise((r) => setTimeout(r, 400)); // let earlier changes settle
      const got = await new Promise((resolve, reject) => {
        let t1, t2;
        const done = (fn, v) => { clearTimeout(t1); clearTimeout(t2); r.destroy(); fn(v); };
        const r = http.get({ host: '127.0.0.1', port, path: `/api/stream?key=${cfg.key}`, headers: { host: `localhost:${port}` } }, (res) => {
          let s = '';
          res.on('data', (d) => { s += d; const m = /event: changed\ndata: (.*)\n/.exec(s); if (m && JSON.parse(m[1]).includes('approvals')) done(resolve, JSON.parse(m[1])); });
          t1 = setTimeout(() => fs.writeFileSync(path.join(dir, 'approvals/x.md'), '---\nfrom: nurul\naction: Send invoice\nstatus: pending\n---\n'), 200);
        });
        r.on('error', () => {});
        t2 = setTimeout(() => done(reject, new Error('no change event')), 5000);
      });
      assert.ok(got.includes('approvals'));
    });

    await test('office layout: saved in office.json, unknown id refused, company-only body still works', async () => {
      assert.strictEqual((await req('GET', '/api/office')).body.layout, 'pinwheel');
      const ok = await req('PUT', '/api/office', { layout: 'horseshoe' });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.layout, 'horseshoe');
      assert.strictEqual(JSON.parse(read('office.json')).layout, 'horseshoe');
      const bad = await req('PUT', '/api/office', { layout: 'spaceship' });
      assert.ok(bad.status >= 400 && bad.status < 500, `invalid layout gives ${bad.status}`);
      assert.strictEqual(JSON.parse(read('office.json')).layout, 'horseshoe');
      const co = await req('PUT', '/api/office', { company: 'Kedai Ali' });
      assert.strictEqual(co.status, 200);
      assert.strictEqual(JSON.parse(read('office.json')).layout, 'horseshoe', 'company-only save keeps the layout');
      assert.strictEqual((await req('PUT', '/api/office', { layout: 'pinwheel' })).status, 200);
    });

    await test('rename company: office.json, generated files and archived copies', async () => {
      const oldName = 'Kedai Ali';
      const newName = 'Kedai $& Ali Sdn Bhd'; // $& must stay literal
      const [active, archived] = JSON.parse(read('office.json')).staff.map((s) => s.id);
      assert.strictEqual((await req('POST', `/api/staff/${archived}/archive`)).status, 200);
      const res = await req('PUT', '/api/office', { company: newName });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.company, newName);
      assert.strictEqual(JSON.parse(read('office.json')).company, newName);
      const files = ['CLAUDE.md', `staff/${active}/CLAUDE.md`, `.claude/agents/${active}.md`, `.archive/staff/${archived}/CLAUDE.md`, `.archive/agents/${archived}.md`];
      for (const f of files) {
        assert.ok(read(f).includes(newName), `${f} has new name`);
        assert.ok(!read(f).includes(oldName), `${f} has no old name`);
      }
      assert.ok((await req('PUT', '/api/office', { company: '   ' })).status >= 400, 'empty name rejected');
      assert.strictEqual(JSON.parse(read('office.json')).company, newName, 'empty name changed nothing');
    });

    // pasted or dropped images: saved in attachments/ under a generated name, type checked by magic bytes
    const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const MAX_IMG = 10 * 1024 * 1024;
    await test('attachments: a PNG is saved under attachments/ with a generated name', async () => {
      const r = await req('POST', '/api/attachments', { type: 'image/png', data: PNG_1PX });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(path.isAbsolute(r.body.path), 'absolute path, readable from staff folders too');
      assert.ok(r.body.path.startsWith(path.join(dir, 'attachments') + path.sep), r.body.path);
      assert.match(path.basename(r.body.path), /^\d{8}-\d{6}-[0-9a-f]{4}\.png$/);
      assert.ok(fs.readFileSync(r.body.path).equals(Buffer.from(PNG_1PX, 'base64')));
    });

    await test('attachments: non-image bytes sent as an image are refused', async () => {
      const count = () => (fs.existsSync(path.join(dir, 'attachments')) ? fs.readdirSync(path.join(dir, 'attachments')).length : 0);
      const before = count();
      const r = await req('POST', '/api/attachments', { type: 'image/png', data: Buffer.from('hello').toString('base64') });
      assert.strictEqual(r.status, 415, JSON.stringify(r.body));
      assert.strictEqual(count(), before, 'nothing saved');
    });

    await test('attachments: a file over 10 MB is refused', async () => {
      const big = Buffer.alloc(MAX_IMG + 1); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
      const r = await req('POST', '/api/attachments', { type: 'image/png', data: big.toString('base64') });
      assert.strictEqual(r.status, 413, JSON.stringify(r.body));
    });

    await test('attachments: needs the office key', async () => {
      assert.strictEqual((await req('POST', '/api/attachments', { type: 'image/png', data: PNG_1PX }, { 'x-office-key': '' })).status, 401);
    });
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${n} server tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
