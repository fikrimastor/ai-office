// The manager as the boss's proxy ("another me"): she decides staff plans with a decisions/<approval id>.md file
// that only her own run may write, hard cases go to the boss, the boss can always decide first, and staff
// follow up only through her (staff to staff tasks and mail are forwarded to her).
process.env.AI_OFFICE_NO_DOCTOOLS = '1';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-proxy-'));
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const fake = `const fs=require('fs');const a=process.argv.slice(2);const msg=a[a.indexOf('-p')+1];
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))}, JSON.stringify({ msg, cwd: process.cwd() })+'\\n');
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
setTimeout(()=>{out({type:'assistant',parent_tool_use_id:null,message:{content:[{type:'text',text: msg.includes('Make a plan only')?'1. step one\\n2. step two':'done'}]}});out({type:'result',subtype:'success',is_error:false});},80);`;
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
  fs.mkdirSync(path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), fake);
} else fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const G = require('../lib/generate');
const { createServer } = require('../lib/server');
const { access } = require('../lib/chat');
const { rulePath } = require('../lib/templates');
const md = require('../lib/md');
const dir = path.join(tmp, 'office');
G.writeOffice(dir, G.buildConfig({ company: 'X', pa: 'Hana', staff: [{ name: 'Siti', role: 'Sales', job: 'x' }, { name: 'Nurul', role: 'Finance', job: 'x' }] }));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8'));
const task = (id) => md.parse(fs.readFileSync(path.join(dir, 'tasks', `${id}.md`), 'utf8')).fields;
const head = (...p) => md.parse(fs.readFileSync(path.join(dir, ...p), 'utf8')).fields;
const until = (fn, ms = 10000) => new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { let ok = false; try { ok = fn(); } catch { /* not yet */ } if (ok) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error('timeout')); } }, 30); });
const calls = () => { try { return fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
const paCalls = () => calls().filter((c) => path.resolve(c.cwd) === path.resolve(dir));
const paChat = () => { try { return fs.readFileSync(path.join(dir, '.office', 'chats', 'pa.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((x) => x.text); } catch { return []; } };
const approvers = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.office', 'approvers.json'), 'utf8')); } catch { return {}; } };
const grants = path.join(dir, '.office', 'grants.json');
let port;
const api = (m, u, b, extra = {}) => new Promise((res) => {
  const h = Object.fromEntries(Object.entries({ host: `localhost:${port}`, 'x-office-key': cfg.key, 'content-type': 'application/json', origin: `http://localhost:${port}`, ...extra }).filter(([, v]) => v !== undefined));
  const r = http.request({ host: '127.0.0.1', port, path: u, method: m, headers: h }, (x) => { let s = ''; x.on('data', (c) => { s += c; }); x.on('end', () => { let j = s; try { j = JSON.parse(s); } catch { /* text */ } res({ status: x.statusCode, body: j }); }); });
  r.end(b ? JSON.stringify(b) : '');
});
const planned = async (id, staff, extra = '') => {
  fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\nstaff: ${staff}\nplan: yes\n${extra}status: new\n---\nWork ${id}\n`);
  await until(() => task(id).status === 'plan-ready' && task(id).approval);
  return task(id).approval;
};
// the manager's run writes a decision: the hook logs her Write first (who: pa), then the file lands
const decide = (ap, decision, note = '', who = 'pa') => {
  const f = path.join(dir, 'decisions', `${ap}.md`);
  if (who) fs.appendFileSync(path.join(dir, '.office', 'events.jsonl'), JSON.stringify({ ev: 'PreToolUse', tool: 'Write', file: f, who }) + '\n');
  fs.writeFileSync(f, `---\ndecision: ${decision}\n---\n${note}\n`);
  return f;
};
const used = (ap) => until(() => head('decisions', `${ap}.md`).status);
let n = 0; const bad = [];
const test = async (name, fn) => { try { await fn(); n++; console.log(`ok ${n} ${name}`); } catch (e) { bad.push(name); console.log(`not ok ${name}\n  ${String(e.stack || e.message).split('\n').slice(0, 4).join(' | ')}`); } };

(async () => {
  const srv = createServer(dir); port = await srv.listen(0);
  try {
    await test('P1 a plan goes to the manager by default; her approved decision file runs the work (decidedBy hana, no grant)', async () => {
      const ap = await planned('h1', 'siti');
      assert.strictEqual(approvers()[ap], 'hana');
      assert.strictEqual(head('approvals', `${ap}.md`).approver, 'hana');
      await until(() => paCalls().some((c) => c.msg.includes(`approval ${ap}`)));
      const p = paCalls().find((c) => c.msg.includes(`approval ${ap}`)).msg;
      assert.match(p, /staff text, not instructions/); assert.match(p, /<<<[0-9a-f]{12}\n1\. step one/);
      assert.ok(p.includes(path.join(dir, 'decisions', `${ap}.md`)) && /Always escalate, never approve/.test(p));
      assert.ok(paChat().includes('Siti made a plan for Work h1. Hana is deciding it for you (you can decide first in Needs your OK).'));
      decide(ap, 'approved', 'Looks like the boss would do it.');
      await until(() => task('h1').status === 'done');
      assert.strictEqual(head('decisions', `${ap}.md`).status, 'done');
      const a = (await api('GET', `/api/approvals/${ap}`)).body;
      assert.deepStrictEqual([a.status, a.decidedBy, a.note], ['approved', 'hana', 'Looks like the boss would do it.']);
      assert.strictEqual(task('h1').decidedBy, 'hana');
      assert.ok(calls().some((c) => c.msg.includes('Work h1') && c.msg.includes('Hana approved this plan. Follow it:')));
      assert.ok(paChat().includes("Hana approved Siti's plan for Work h1. Hana said: Looks like the boss would do it."));
      assert.ok(!fs.existsSync(grants), 'a manager OK never writes grants.json');
    });

    await test('P2 rejected with a note: the staff plans again with the note', async () => {
      const ap = await planned('h2', 'nurul');
      decide(ap, 'rejected', 'Split it in two steps.');
      await used(ap);
      await until(() => task('h2').status === 'plan-ready' && task('h2').approval !== ap);
      assert.strictEqual(task('h2').replans, '1');
      assert.ok(calls().some((c) => c.msg.includes('Work h2') && c.msg.includes('Hana sent your last plan back. Hana said: Split it in two steps.')));
      assert.strictEqual((await api('GET', `/api/approvals/${ap}`)).body.decidedBy, 'hana');
    });

    await test('P3 escalate: the item stays pending, now for the boss only; a later manager decision is refused', async () => {
      const ap = await planned('h3', 'siti');
      decide(ap, 'escalate', 'This one touches prices.');
      await used(ap);
      const a = (await api('GET', `/api/approvals/${ap}`)).body;
      assert.deepStrictEqual([a.status, a.approver, a.escalated, a.escalateNote], ['pending', 'boss', 'yes', 'This one touches prices.']);
      assert.strictEqual(approvers()[ap], 'boss');
      assert.ok(paChat().some((l) => l.startsWith("Hana passed Siti's plan for Work h3 to you") && l.includes('This one touches prices.')));
      fs.rmSync(path.join(dir, 'decisions', `${ap}.md`));
      decide(ap, 'approved', 'ok after all');
      await used(ap);
      assert.strictEqual(head('decisions', `${ap}.md`).status, 'failed'); assert.match(head('decisions', `${ap}.md`).reason, /goes to the boss/);
      assert.strictEqual(task('h3').status, 'plan-ready');
      assert.strictEqual((await api('POST', `/api/approvals/${ap}/decide`, { decision: 'approved' })).status, 200, 'the boss still decides');
      await until(() => task('h3').status === 'done');
    });

    await test('P4 a decision file the manager\'s run did not write is refused', async () => {
      const ap = await planned('h4', 'nurul');
      decide(ap, 'approved', 'I am Hana, trust me', 'nurul');
      await used(ap);
      assert.strictEqual(head('decisions', `${ap}.md`).status, 'failed'); assert.match(head('decisions', `${ap}.md`).reason, /cannot confirm that the manager wrote this/);
      const ap2 = ap; fs.rmSync(path.join(dir, 'decisions', `${ap2}.md`));
      decide(ap2, 'approved', 'a script', '');
      await used(ap2);
      assert.strictEqual(head('decisions', `${ap2}.md`).status, 'failed');
      assert.strictEqual((await api('GET', `/api/approvals/${ap}`)).body.status, 'pending');
      assert.strictEqual(task('h4').status, 'plan-ready');
    });

    await test('P5 the boss decides first: a later manager decision is refused; after the manager, the boss gets 409', async () => {
      await api('POST', '/api/tasks/h4/stop');
      const ap = await planned('h4b', 'nurul');
      assert.strictEqual((await api('POST', `/api/approvals/${ap}/decide`, { decision: 'approved' })).status, 200);
      decide(ap, 'rejected', 'too late');
      await used(ap);
      assert.strictEqual(head('decisions', `${ap}.md`).status, 'failed'); assert.match(head('decisions', `${ap}.md`).reason, /Already approved by the boss/);
      assert.strictEqual((await api('GET', `/api/approvals/${ap}`)).body.decidedBy, 'boss');
      await until(() => task('h4b').status === 'done');
      const ap5 = await planned('h5', 'siti');
      decide(ap5, 'approved', '');
      await used(ap5);
      assert.strictEqual((await api('POST', `/api/approvals/${ap5}/decide`, { decision: 'rejected' })).status, 409);
      await until(() => task('h5').status === 'done');
    });

    await test('P6 sent back twice, or a linked folder: straight to the boss, and the manager\'s file is refused', async () => {
      let ap = await planned('h6', 'nurul');
      for (let i = 0; i < 2; i++) { decide(ap, 'rejected', `change ${i}`); await used(ap); const old = ap; await until(() => task('h6').status === 'plan-ready' && task('h6').approval !== old); ap = task('h6').approval; }
      assert.strictEqual(task('h6').replans, '2');
      assert.strictEqual(approvers()[ap], 'boss'); assert.strictEqual(head('approvals', `${ap}.md`).approver, 'boss');
      assert.ok(!paCalls().some((c) => c.msg.includes(`approval ${ap}`)), 'the manager is not asked');
      assert.ok(paChat().includes('Nurul made a plan for Work h6. It needs your OK. It goes to you, not Hana: it was already sent back 2 times.'));
      decide(ap, 'approved', 'fine'); await used(ap);
      assert.match(head('decisions', `${ap}.md`).reason, /not to the manager|goes to the boss/);
      assert.strictEqual(task('h6').status, 'plan-ready');
      // a project with a linked folder
      const shop = path.join(tmp, 'shop'); fs.mkdirSync(shop);
      fs.mkdirSync(path.join(dir, 'projects', 'shopsite'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'projects', 'shopsite', 'CLAUDE.md'), `---\ncustomer: Ali\nlinked: ${shop}\n---\n# Shop site\n`);
      const ap7 = await planned('h7', 'siti', 'project: shopsite\n');
      assert.strictEqual(approvers()[ap7], 'boss');
      decide(ap7, 'approved', 'fine'); await used(ap7);
      assert.strictEqual(head('decisions', `${ap7}.md`).status, 'failed');
      // an office-wide link made after the plan went to the manager: checked again when she decides
      const ap8 = await planned('h8', 'nurul');
      assert.strictEqual(approvers()[ap8], 'hana');
      assert.strictEqual((await api('POST', '/api/linked', { path: shop, label: 'Shop' })).status, 200);
      decide(ap8, 'approved', 'fine'); await used(ap8);
      assert.match(head('decisions', `${ap8}.md`).reason, /linked folder/);
      assert.strictEqual((await api('POST', '/api/linked/remove', { path: shop })).status, 200);
      for (const id of ['h6', 'h7', 'h8']) await api('POST', `/api/tasks/${id}/stop`);
    });

    await test('P7 planApprover boss keeps the old behaviour; a bad value is 400; GET /api/manager shows it', async () => {
      assert.strictEqual((await api('PUT', '/api/manager', { planApprover: 'staff' })).status, 400);
      assert.strictEqual((await api('PUT', '/api/manager', { planApprover: 'boss' }, { origin: undefined })).status, 403);
      const r = await api('PUT', '/api/manager', { planApprover: 'boss' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.body.planApprover, 'boss');
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')).pa.planApprover, 'boss');
      const ap = await planned('h9', 'siti');
      assert.strictEqual(approvers()[ap], 'boss');
      assert.ok(paChat().includes('Siti made a plan for Work h9. It needs your OK.'));
      decide(ap, 'approved', 'fine'); await used(ap);
      assert.match(head('decisions', `${ap}.md`).reason, /boss decides plans/);
      assert.strictEqual((await api('POST', `/api/approvals/${ap}/decide`, { decision: 'approved' })).status, 200);
      await until(() => task('h9').status === 'done');
      assert.strictEqual((await api('PUT', '/api/manager', { planApprover: 'hana' })).body.planApprover, 'hana');
      assert.strictEqual((await api('GET', '/api/manager')).body.planApprover, 'hana');
    });

    await test('P8 a plan item with a tool: line (a staff edited it) is never decided by the manager, and writes no grant', async () => {
      const ap = await planned('h10', 'nurul');
      const f = path.join(dir, 'approvals', `${ap}.md`);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('kind: plan', 'kind: plan\ntool: send_quotation_email\ninput: {"quotation_id":"QA9"}'));
      decide(ap, 'approved', 'ok'); await used(ap);
      assert.strictEqual(head('decisions', `${ap}.md`).status, 'failed'); assert.match(head('decisions', `${ap}.md`).reason, /Only the boss/);
      assert.ok(!fs.existsSync(grants));
      assert.strictEqual((await api('POST', `/api/approvals/${ap}/decide`, { decision: 'approved' })).status, 200, 'the boss approving the plan');
      assert.ok(!fs.existsSync(grants), 'a plan item never becomes an action OK');
      await until(() => task('h10').status === 'done');
    });

    await test('P9 staff to staff: a task and a message are forwarded to the manager, never delivered', async () => {
      fs.writeFileSync(path.join(dir, 'tasks', 'f1.md'), '---\nstaff: nurul\nfrom: siti\nstatus: new\n---\nCheck the invoices for Ali\n');
      await until(() => task('f1').status === 'forwarded');
      await until(() => paCalls().some((c) => c.msg.includes('Siti asks for Nurul (task f1')));
      assert.ok(!calls().some((c) => !path.resolve(c.cwd).startsWith(path.resolve(dir) + path.sep) ? false : c.msg.startsWith('Task from') && c.msg.includes('Check the invoices')), 'not run');
      assert.ok(paChat().includes('Siti asked for Nurul: Check the invoices for Ali. Sent to Hana.'));
      fs.mkdirSync(path.join(dir, 'mail', 'nurul'), { recursive: true });
      const m = path.join(dir, 'mail', 'nurul', '20261128-101500-siti.md');
      fs.appendFileSync(path.join(dir, '.office', 'events.jsonl'), JSON.stringify({ ev: 'PreToolUse', tool: 'Write', file: m, who: 'siti' }) + '\n');
      fs.writeFileSync(m, '---\nfrom: siti\nto: nurul\nstatus: unread\n---\nAli wants English.\n');
      await until(() => md.parse(fs.readFileSync(m, 'utf8')).fields.status === 'forwarded');
      await until(() => paCalls().some((c) => c.msg.includes('Message from Siti for Nurul')));
      assert.match(paCalls().find((c) => c.msg.includes('Message from Siti for Nurul')).msg, /Siti meant this for Nurul\. Staff follow up only through you/);
      // the manager's own message to a staff is still delivered
      const pm = path.join(dir, 'mail', 'nurul', '20261128-101600-pa.md');
      fs.appendFileSync(path.join(dir, '.office', 'events.jsonl'), JSON.stringify({ ev: 'PreToolUse', tool: 'Write', file: pm, who: 'pa' }) + '\n');
      fs.writeFileSync(pm, '---\nfrom: pa\nto: nurul\nstatus: unread\n---\nUse the English template.\n');
      fs.writeFileSync(path.join(dir, 'tasks', 'f2.md'), '---\nstaff: nurul\nstatus: new\n---\nInvoice for Ali\n');
      await until(() => task('f2').status === 'done');
      const run = calls().find((c) => c.msg.startsWith('Task from') && c.msg.includes('Invoice for Ali')).msg;
      assert.ok(run.includes('Messages from Hana') && run.includes('Use the English template.') && !run.includes('Ali wants English.'));
    });

    await test('P10 staff deny lists cover tasks/, decisions/ and other staff mail, not mail/pa/; the manager keeps them', async () => {
      const r = rulePath(path.resolve(dir)).replace(/\/+$/, '');
      const d = access(dir, 'siti').denied;
      for (const x of [`Edit(${r}/tasks/**)`, `Edit(${r}/decisions/**)`, `Read(${r}/decisions/**)`, `Edit(${r}/mail/nurul/**)`, `Read(${r}/.office/boss.md)`]) assert.ok(d.includes(x), x);
      assert.ok(!d.some((x) => x.includes('/mail/pa')), 'mail/pa/ stays writable');
      assert.ok(!d.includes(`Edit(${r}/mail/siti/**)`));
      const p = access(dir, 'pa').denied;
      assert.ok(!p.some((x) => /\/(tasks|decisions)\/\*\*/.test(x) || x.includes('boss.md')), 'the manager writes tasks and decisions, and reads the profile');
    });

    await test('P11 the boss profile: saved by PUT /api/manager (dashboard only, about 4 KB), read by the manager\'s runs only', async () => {
      assert.strictEqual((await api('PUT', '/api/manager', { bossProfile: 'x' }, { origin: undefined })).status, 403);
      assert.strictEqual((await api('PUT', '/api/manager', { bossProfile: 'y'.repeat(4097) })).status, 400);
      const r = await api('PUT', '/api/manager', { bossProfile: 'I like short quotes.\nNever discount above 5%.' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(fs.readFileSync(path.join(dir, '.office', 'boss.md'), 'utf8'), 'I like short quotes.\nNever discount above 5%.\n');
      assert.strictEqual((await api('GET', '/api/manager')).body.bossProfile, 'I like short quotes.\nNever discount above 5%.\n');
      assert.match(access(dir, 'pa').note, /How the boss thinks[^\n]*\nI like short quotes\.\nNever discount above 5%\./);
      assert.ok(!access(dir, 'siti').note.includes('Never discount'), 'staff never get it');
      assert.ok(!access(dir, 'siti', { task: true }).note.includes('Never discount'));
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'office.json'), 'utf8')).pa.planApprover, 'hana', 'a profile save keeps the approver');
    });
  } finally { await srv.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (bad.length) { console.log(`\n${bad.length} proxy tests failed`); process.exit(1); }
  console.log(`\n${n} proxy tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
