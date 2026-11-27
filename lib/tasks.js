// Staff tasks. In dashboard chats the PA hands out work by writing tasks/<id>.md; the office
// runs each task as the staff's own Claude Code run (in staff/<id>/), so the PA's chat is
// free again in seconds. One task at a time per staff; different staff work in parallel.
//
//   tasks/<id>.md   ---
//                   staff: shah
//                   from: pa | <staff id>            (who asked; the answer goes back to them)
//                   project: kedai-ali-website      (optional)
//                   after: <task id>, <task id>     (optional: start only when these tasks are done)
//                   status: new | working | done | failed | stopped
//                   created / started / finished: times
//                   ---
//                   <the task>
//                   ## Result      (written by the office: the staff's report)

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
    fs.mkdirSync(this.root, { recursive: true });
  }

  file(id) { return path.join(this.root, `${id}.md`); }
  read(id) {
    const text = fs.readFileSync(this.file(id), 'utf8');
    const { fields, body } = md.parse(text);
    const task = (md.section(`\n${body}`, 'Result') !== null ? body.slice(0, body.search(/^## Result/m)) : body).trim();
    const after = (fields.after || '').split(',').map((x) => x.trim()).filter(Boolean);
    return { id, ...fields, after, status: fields.status || 'new', task, title: task.split('\n')[0].slice(0, 120), result: md.section(body, 'Result') || '', _text: text };
  }
  write(id, fields, result) {
    let text = md.setFields(fs.readFileSync(this.file(id), 'utf8'), fields);
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
    for (const t of this.list()) if (t.status === 'working') {
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
    return { ok: true, id: this.add(t.staff, t.task, { from: t.from || 'pa', project: t.project || '', again: id }) };
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
    const prompt = [`Task from ${from} (task ${id}):`, '', t.task, '',
      `The office folder is ${this.dir}.${t.project ? ` Project: ${path.join(this.dir, 'projects', t.project)} (read its CLAUDE.md first).` : ''}`,
      ...(t.after.length ? [`This task follows earlier work: read the results in ${t.after.map((a) => this.file(a)).join(', ')} first.`] : []),
      `Do the work now. End with a short report for ${from}: what you did (or the answer), file paths, and anything waiting for the boss's OK.`].join('\n');
    const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(acc.shell ? ['Bash'] : [])];
    const mcp = this.h.mcp ? this.h.mcp(cfg, staff) : { args: [], env: {} }; // only the MCP servers this job needs
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default',
      '--tools', tools.join(','), '--allowedTools', acc.allowed.filter((x) => x !== 'Agent').join(','), '--disallowedTools', (acc.denied || []).join(','),
      ...acc.paths.flatMap((d) => ['--add-dir', d]), '--append-system-prompt', acc.note, ...require('./templates').runFlags(cfg, staff), ...mcp.args];
    const { cmd, pre } = this.h.claude();
    this.write(id, { status: 'working', started: nowIso() });
    let child;
    try { child = spawn(cmd, [...pre, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...this.h.env(cwd), ...mcp.env, AI_OFFICE_STAFF: staff } }); } catch (e) {
      return this.finish(staff, id, 'failed', `Could not start Claude Code: ${e.message}`);
    }
    this.running.set(staff, { id, child });
    this.h.onStart({ ...t, from: t.from || 'pa', status: 'working', name: s ? s.name : staff });
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
      return this.finish(staff, id, 'done', said);
    });
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
    try { if (this.read(id).status === 'new') { this.write(id, { status: 'stopped', finished: nowIso() }, 'Cancelled by the boss before it started.'); this.scan(); return { ok: true }; } } catch { /* no such task */ }
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
