// Staff tasks. In dashboard chats the PA hands out work by writing tasks/<id>.md; the office
// runs each task as the staff's own Claude Code run (in staff/<id>/), so the PA's chat is
// free again in seconds. One task at a time per staff; different staff work in parallel.
//
//   tasks/<id>.md   ---
//                   staff: shah
//                   from: pa | <staff id>            (who asked; the answer goes back to them)
//                   project: kedai-ali-website      (optional)
//                   after: <task id>, <task id>     (optional: start only when these tasks are done)
//                   plan: yes                       (optional: plan first, work only after the boss's OK)
//                   status: new | planning | plan-ready | working | done | failed | stopped
//                   created / started / finished: times
//                   ---
//                   <the task>
//                   ## Plan        (plan: yes only, written by the office: the plan the boss approves or sends back)
//                   ## Result      (written by the office: the staff's report)
//
//   plan: yes runs the task twice. First a read-only plan run (status planning), then the plan waits for the
//   boss in Needs your OK (plan-ready, approval: <id>). Approve: plan: approved, the real run gets the plan.
//   Reject with a note: a new plan run with that note (replans: n, at most 3 times). Reject with no note: stopped.
//
//   mail/<to>/<YYYYMMDD-HHMMSS>-<from>.md   a short message to a colleague (or pa), not work:
//                   ---  from / to / sent / status: unread | read | failed / reason  ---  <the message>
//                   A staff gets their unread mail in their next task's prompt; pa gets it as an [Office update].

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const md = require('./md');
const { describe } = require('./chat');

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const nowIso = () => new Date().toISOString();

class Tasks {
  // hooks: { access(staffId) -> {allowed, paths, note, shell}, claude() -> {cmd, pre}, env(cwd), loadCfg(),
  //          onStart(task), onEnd(task, result), graceMs (how long an after: task may be missing: default 2 min) }
  constructor(dir, hooks) {
    this.dir = dir; this.h = hooks;
    this.grace = hooks.graceMs ?? 2 * 60 * 1000; // the PA may write the waiting task's file before the one it waits for
    this.timer = null; // one pending re-check for after: tasks that are still missing
    this.root = path.join(dir, 'tasks');
    this.running = new Map(); // staff id -> { id, child }
    this.queued = new Map(); // staff id -> [task id]
    this.mailRoot = path.join(dir, 'mail');
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.mailRoot, { recursive: true });
  }

  file(id) { return path.join(this.root, `${id}.md`); }
  read(id) {
    const text = fs.readFileSync(this.file(id), 'utf8');
    const { fields, body } = md.parse(text);
    const cut = body.search(/^## (plan|result)\s*$/im); // the office's own sections are not part of the task
    const task = (cut >= 0 ? body.slice(0, cut) : body).trim();
    const after = (fields.after || '').split(',').map((x) => x.trim()).filter(Boolean);
    return { id, ...fields, after, status: fields.status || 'new', task, title: task.split('\n')[0].slice(0, 120), result: md.section(body, 'Result') || '', planText: md.section(body, 'Plan') || '', _text: text };
  }
  write(id, fields, result, plan) {
    let text = md.setFields(fs.readFileSync(this.file(id), 'utf8'), fields);
    if (plan != null) text = md.setSection(text, 'Plan', plan);
    if (result != null) text = md.setSection(text, 'Result', result || '(no report)');
    const tmp = `${this.file(id)}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, this.file(id));
  }
  list() {
    let names = [];
    try { names = fs.readdirSync(this.root); } catch { return []; }
    const all = names.filter((n) => n.endsWith('.md') && FILE_ID.test(n.slice(0, -3))).map((n) => { try { return this.read(n.slice(0, -3)); } catch { return null; } })
      .filter(Boolean).map(({ _text, ...t }) => t).sort((a, b) => (b.created || b.id).localeCompare(a.created || a.id));
    // waiting: a new task whose after: tasks are not all done yet
    const status = new Map(all.map((t) => [t.id, t.status]));
    return all.map((t) => ({ ...t, waiting: t.status === 'new' && t.after.some((a) => status.get(a) !== 'done') }));
  }

  // Why a new task with after: can never start ('' when it can, or may later).
  // A missing after: task gets a grace time; due.at is set to when to look again.
  blocked(t, byId, due = {}) {
    for (const a of t.after) {
      const d = FILE_ID.test(a) && byId.get(a);
      if (!d) {
        let born = Date.parse(t.created);
        if (Number.isNaN(born)) try { born = fs.statSync(this.file(t.id)).mtimeMs; } catch { born = 0; }
        if (Date.now() < born + this.grace) { due.at = Math.min(due.at || Infinity, born + this.grace); continue; }
        return `It waits for task "${a}", but there is no such task.`;
      }
      if (d.status === 'failed' || d.status === 'stopped') return `It waits for task "${a}" (${d.title}), which ${d.status === 'failed' ? 'failed' : 'was stopped'}.`;
    }
    // does it end up waiting for itself, through the new tasks it waits for?
    const seen = new Set();
    const waitsFor = (id) => { const d = byId.get(id); return d && d.status === 'new' ? d.after : []; };
    const loops = (id) => waitsFor(id).some((a) => a === t.id || (!seen.has(a) && (seen.add(a), loops(a))));
    return loops(t.id) ? 'Its after: tasks wait for each other in a circle, so none of them can start.' : '';
  }

  // Mail: check every unread message (bad ones are marked failed with a reason) and hand
  // pa's to onMail. Mail for a staff stays unread until their next task starts.
  setMail(f, fields) {
    const text = md.setFields(fs.readFileSync(f, 'utf8'), fields);
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
  }
  scanMail(only) {
    const cfg = this.h.loadCfg();
    const name = (id) => (id === 'pa' ? (cfg.pa && cfg.pa.name) || 'the manager' : ((cfg.staff || []).find((s) => s.id === id) || {}).name || id);
    const known = (id) => id === 'pa' || (cfg.staff || []).some((s) => s.id === id);
    const out = [];
    let tos = [];
    try { tos = only ? [only] : fs.readdirSync(this.mailRoot); } catch { return out; }
    for (const to of tos) {
      let names = [];
      try { names = fs.readdirSync(path.join(this.mailRoot, to)).filter((n) => n.endsWith('.md') && FILE_ID.test(n.slice(0, -3))).sort(); } catch { continue; }
      for (const n of names) {
        const f = path.join(this.mailRoot, to, n);
        try {
          const { fields, body } = md.parse(fs.readFileSync(f, 'utf8'));
          if ((fields.status || 'unread') !== 'unread') continue;
          const from = fields.from || '';
          const bad = !known(to) ? `There is nobody with id "${to}" to send this to.`
            : fields.to && fields.to !== to ? `The header says to: ${fields.to}, but the message is in mail/${to}/.`
            : !known(from) ? `"${from}" is not on the team, so nobody sent this.`
            : from === to ? 'A message to yourself is not delivered.'
            : !body.trim() ? 'The message is empty.' : '';
          if (bad) { this.setMail(f, { status: 'failed', reason: bad }); continue; }
          const m = { id: n.slice(0, -3), file: f, from, to, name: name(from), sent: fields.sent || '', text: body.trim() };
          if (to === 'pa') { this.setMail(f, { status: 'read', read: nowIso() }); if (this.h.onMail) this.h.onMail(m); } // read first: never twice
          else out.push(m);
        } catch { /* half-written or removed: next scan */ }
      }
    }
    return out;
  }

  // The office itself gives a staff a task (for example: do what the boss just approved).
  add(staff, text, fields = {}) {
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    let id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${staff}`;
    for (let n = 2, base = id; fs.existsSync(this.file(id)); n++) id = `${base}-${n}`;
    fs.writeFileSync(this.file(id), md.make({ staff, from: 'pa', project: '', status: 'new', created: nowIso(), ...fields }, text));
    this.scan();
    return id;
  }

  // After a restart nothing is running any more: say so in the file, and mark it so the boss can run it again.
  recover() {
    const out = [];
    for (const t of this.list()) if (t.status === 'working' || t.status === 'planning') { // plan-ready keeps waiting for the boss
      this.write(t.id, { status: 'stopped', finished: nowIso(), interrupted: 'yes' }, 'Stopped: the office was restarted while this task was running.');
      out.push({ id: t.id, staff: t.staff, title: t.title });
    }
    return out;
  }
  // Tasks a restart cut off that the boss has not run again or dismissed yet.
  interrupted() { return this.list().filter((t) => t.interrupted === 'yes').map(({ id, staff, from, title, finished }) => ({ id, staff, from, title, finished })); }
  // Run a stopped or failed task again, as a new task with the same text; the old one stays as it was.
  rerun(id) {
    const t = this.read(id);
    if (!['stopped', 'failed'].includes(t.status)) { const e = new Error('Only a stopped or failed task can run again.'); e.status = 409; throw e; }
    if (t.interrupted === 'yes') this.write(id, { interrupted: 'rerun' });
    return { ok: true, id: this.add(t.staff, t.task, { from: t.from || 'pa', project: t.project || '', ...(t.plan ? { plan: 'yes' } : {}), again: id }) };
  }
  dismiss(id) { const t = this.read(id); if (t.interrupted === 'yes') this.write(id, { interrupted: 'dismissed' }); return { ok: true }; }

  // Pick up new task files (called when tasks/ changes).
  scan() {
    const cfg = this.h.loadCfg();
    const all = this.list(), byId = new Map(all.map((t) => [t.id, t])), due = {};
    let again = false;
    for (const t of all.reverse()) { // oldest first
      if (t.status !== 'new') continue;
      const busy = [...this.running.values()].some((r) => r.id === t.id) || [...this.queued.values()].some((q) => q.includes(t.id));
      if (busy) continue;
      const from = t.from || 'pa';
      const bad = !(cfg.staff || []).some((s) => s.id === t.staff) ? `There is no active staff with id "${t.staff || ''}".`
        : from !== 'pa' && !(cfg.staff || []).some((s) => s.id === from) ? `"${from}" is not on the team, so the task has nobody to report to.`
        : from === t.staff ? 'A staff cannot give a task to themselves.' : '';
      const stuck = bad ? '' : this.blocked(t, byId, due);
      if (bad || stuck) {
        this.write(t.id, { status: 'failed', finished: nowIso() }, bad || stuck);
        this.h.onEnd({ ...t, from, status: 'failed' }, bad || stuck);
        t.status = 'failed'; again = true; // tasks waiting for this one fail too, on the next pass
        continue;
      }
      if (t.waiting) continue; // starts when its after: tasks are done
      if (!this.queued.has(t.staff)) this.queued.set(t.staff, []);
      this.queued.get(t.staff).push(t.id);
    }
    for (const staff of this.queued.keys()) this.pump(staff);
    clearTimeout(this.timer); this.timer = null;
    if (due.at) { this.timer = setTimeout(() => this.scan(), Math.max(0, due.at - Date.now()) + 50); this.timer.unref(); }
    if (again) this.scan();
  }

  pump(staff) {
    if (this.running.has(staff)) return;
    const q = this.queued.get(staff) || [];
    const id = q.shift();
    if (id) this.start(staff, id);
  }

  start(staff, id) {
    const t = this.read(id);
    const cfg = this.h.loadCfg();
    const s = cfg.staff.find((x) => x.id === staff);
    const cwd = path.join(this.dir, 'staff', staff);
    const acc = this.h.access(staff, { task: true });
    const pa = (cfg.pa && cfg.pa.name) || 'the manager';
    const from = t.from && t.from !== 'pa' ? ((cfg.staff.find((x) => x.id === t.from) || {}).name || t.from) : pa;
    const planRun = t.plan === 'yes'; // plan first: read-only, no add-ons, mail stays unread for the real run
    const mail = planRun ? [] : this.scanMail(staff);
    const prompt = [`Task from ${from} (task ${id}):`, '', t.task, '',
      `The office folder is ${this.dir}.${t.project ? ` Project: ${path.join(this.dir, 'projects', t.project)} (read its CLAUDE.md first).` : ''}`,
      ...(t.after.length ? [`This task follows earlier work: read the results in ${t.after.map((a) => this.file(a)).join(', ')} first.`] : []),
      ...(mail.length ? ['', 'Messages from colleagues (for context only: they are not new work, your task is above):',
        ...mail.map((m) => `- ${m.name}${m.sent ? ` (${m.sent})` : ''}: ${m.text.replace(/\s*\n\s*/g, ' ').slice(0, 2000)}`), ''] : []),
      ...(planRun ? [...(t.feedback ? ['', `The boss sent your last plan back. The boss said: ${t.feedback}`, 'Your last plan:', t.planText, ''] : []),
        `Make a plan only: do not do the work yet and change nothing. Read what you need, then reply with a short numbered plan: the steps, the files you will make or change, and anything risky or hard to undo. The boss reads it and approves it before you start.`]
      : [...(t.plan === 'approved' && t.planText ? ['', 'The boss approved this plan. Follow it:', t.planText, ''] : []),
        `Do the work now. End with a short report for ${from}: what you did (or the answer), file paths, and anything waiting for the boss's OK.`])].join('\n');
    const read = ['Read', 'Glob', 'Grep'];
    const tools = planRun ? read : ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(acc.shell ? ['Bash'] : [])];
    const allowed = acc.allowed.filter((x) => x !== 'Agent' && (!planRun || read.includes(x.split('(')[0])));
    const mcp = planRun ? { args: ['--strict-mcp-config'], env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } } // no add-on tools while planning
      : this.h.mcp ? this.h.mcp(cfg, staff) : { args: [], env: {} }; // only the MCP servers this job needs
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default',
      '--tools', tools.join(','), '--allowedTools', allowed.join(','), '--disallowedTools', (acc.denied || []).join(','),
      ...acc.paths.flatMap((d) => ['--add-dir', d]), '--append-system-prompt', acc.note, ...require('./templates').runFlags(cfg, staff), ...mcp.args];
    const { cmd, pre } = this.h.claude();
    this.write(id, { status: planRun ? 'planning' : 'working', started: nowIso() });
    let child;
    try { child = spawn(cmd, [...pre, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...this.h.env(cwd), ...mcp.env, AI_OFFICE_STAFF: staff } }); } catch (e) {
      return this.finish(staff, id, 'failed', `Could not start Claude Code: ${e.message}`);
    }
    this.running.set(staff, { id, child });
    for (const m of mail) try { this.setMail(m.file, { status: 'read', read: nowIso() }); } catch { /* removed */ }
    this.h.onStart({ ...t, from: t.from || 'pa', status: planRun ? 'planning' : 'working', name: s ? s.name : staff });
    let buf = '', said = '', err = '', lastErr = '';
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const j = JSON.parse(line);
          if (this.h.onUsage) this.h.onUsage(j, staff, 'task', id);
          if (j.type === 'assistant' && !j.parent_tool_use_id) {
            const x = (j.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(); if (x) said = x;
            for (const c of j.message.content || []) if (c.type === 'tool_use') this.step(staff, describe(c.name, c.input, (sid) => ((cfg.staff || []).find((y) => y.id === sid) || {}).name || sid));
          }
          if (j.type === 'result' && j.is_error) lastErr = String(j.result || j.subtype || 'error');
        } catch { /* not ours */ }
      }
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { lastErr = e.message; });
    child.on('close', (code) => {
      if (child.stopped) return this.finish(staff, id, 'stopped', 'Stopped by the boss.');
      if (lastErr || (code !== 0 && !said)) return this.finish(staff, id, 'failed', (lastErr || err || 'Claude stopped with an error').trim().slice(0, 1500));
      return planRun ? this.planned(staff, id, said) : this.finish(staff, id, 'done', said);
    });
  }

  // A plan run ended: keep the plan, ask the boss (onPlan makes the approval item and returns its id).
  // Not an end: tasks that wait for this one keep waiting for done.
  planned(staff, id, plan) {
    this.running.delete(staff);
    const text = String(plan || '').trim().replace(/^#{1,2} /gm, '### ') || '(no plan)'; // a heading would end the Plan section
    try {
      this.write(id, { status: 'plan-ready', planned: nowIso() }, null, text);
      const t = this.read(id), cfg = this.h.loadCfg();
      const approval = this.h.onPlan ? this.h.onPlan({ ...t, from: t.from || 'pa', name: ((cfg.staff || []).find((x) => x.id === staff) || {}).name || staff }, text) : '';
      if (approval) this.write(id, { approval });
    } catch { /* file removed */ }
    this.pump(staff);
    this.scan();
  }

  // The plan approval this task waits for, or a 409 when it moved on (stopped, re-planned, done).
  planCheck(id, approval) {
    const t = this.read(id);
    if (t.status !== 'plan-ready' || !approval || t.approval !== approval) { const e = new Error('This plan is no longer waiting for your OK.'); e.status = 409; throw e; }
    return t;
  }
  // The boss decided on a plan. Approved: the real run. Rejected with a note: a new plan (at most 3 times). No note: stopped.
  decidePlan(id, approval, decision, note) {
    const t = this.planCheck(id, approval);
    note = String(note || '').replace(/\s+/g, ' ').replace(/ # /g, ' ').trim().slice(0, 1000); // one header line; " # " would start a comment
    if (decision === 'approved') { this.write(id, { status: 'new', plan: 'approved', approved: nowIso() }); this.scan(); return { ok: true, status: 'working' }; }
    const n = Number(t.replans) || 0;
    if (!note) return this.endPlan(t, 'Stopped: the boss rejected the plan.');
    if (n >= 3) return this.endPlan(t, 'Stopped: the boss sent the plan back 3 times. Hand it out again with clearer details.');
    this.write(id, { status: 'new', replans: n + 1, feedback: note });
    this.scan();
    return { ok: true, status: 'planning' };
  }
  endPlan(t, reason) {
    this.write(t.id, { status: 'stopped', finished: nowIso() }, reason);
    const cfg = this.h.loadCfg();
    this.h.onEnd({ ...this.read(t.id), from: t.from || 'pa', name: ((cfg.staff || []).find((x) => x.id === t.staff) || {}).name || t.staff }, reason);
    this.scan(); // tasks waiting for this one fail
    return { ok: true, status: 'stopped' };
  }

  finish(staff, id, status, result) {
    this.running.delete(staff);
    try { this.write(id, { status, finished: nowIso() }, result); } catch { /* file removed */ }
    let t = { id, staff, status };
    try { t = { ...this.read(id), status }; } catch { /* gone */ }
    const cfg = this.h.loadCfg();
    this.h.onEnd({ ...t, from: t.from || 'pa', name: ((cfg.staff || []).find((x) => x.id === staff) || {}).name || staff }, result);
    this.pump(staff);
    this.scan(); // tasks that waited for this one may start now (or fail, if it did not finish)
  }

  stop(id) {
    for (const [staff, r] of this.running) {
      if (r.id !== id) continue;
      r.child.stopped = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(r.child.pid), '/t', '/f'], { windowsHide: true });
      else r.child.kill('SIGTERM');
      return { ok: true };
    }
    for (const q of this.queued.values()) { const i = q.indexOf(id); if (i >= 0) { q.splice(i, 1); this.write(id, { status: 'stopped', finished: nowIso() }, 'Cancelled by the boss before it started.'); return { ok: true }; } }
    // a task still waiting for other tasks
    try {
      const t = this.read(id);
      if (t.status === 'plan-ready') { // its approval item is closed by onPlanDrop
        this.endPlan(t, 'Stopped by the boss before the plan was approved.');
        if (this.h.onPlanDrop) try { this.h.onPlanDrop(t); } catch { /* already decided */ }
        return { ok: true };
      }
      if (t.status === 'new') { this.write(id, { status: 'stopped', finished: nowIso() }, 'Cancelled by the boss before it started.'); this.scan(); return { ok: true }; }
    } catch { /* no such task */ }
    return { ok: false };
  }

  stopAll() { for (const r of this.running.values()) this.stop(r.id); }
  active() { return [...this.running.entries()].map(([staff, r]) => ({ staff, id: r.id, step: r.step || '' })); }
  // what the staff is doing right now ("Writing index.html")
  step(staff, text) {
    const r = this.running.get(staff); if (!r) return;
    r.step = text;
    if (this.h.onStep) this.h.onStep({ staff, id: r.id, step: text });
  }
}

module.exports = { Tasks };
