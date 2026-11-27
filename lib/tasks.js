// Staff tasks. In dashboard chats the PA hands out work by writing tasks/<id>.md; the office
// runs each task as the staff's own Claude Code run (in staff/<id>/), so the PA's chat is
// free again in seconds. One task at a time per staff; different staff work in parallel.
//
//   tasks/<id>.md   ---
//                   staff: shah | any               (any: a pool task, see below; no staff: line fails)
//                   role: sales                     (pool only, optional: who may take it)
//                   from: pa | office | <staff id>   (who asked; the answer goes back to them. office: the office itself, reported to pa.
//                                                    a staff id: not run, status forwarded, the manager decides (onForward))
//                   project: kedai-ali-website      (optional)
//                   after: <task id>, <task id>     (optional: start only when these tasks are done; a rerun of one counts)
//                   plan: yes                       (optional: plan first, work only after an OK (the manager's or the boss's); yes/true/y/1)
//                   status: new | planning | plan-ready | working | done | failed | stopped | forwarded
//                   created / started / finished: times
//                   ---
//                   <the task>
//                   ## Plan (office)  (plan: yes only, written by the office: the plan the boss approves or sends back)
//                   ## Result      (written by the office at the end: the staff's report. A "## Result" in the task text stays)
//
//   Pool task (staff: any): the first free staff whose role has one of the role: words (any staff when there is
//   no role:) takes it. The office writes staff: <id> and claimed: yes into the file; from then on it is a
//   normal task for that staff. Run again puts it back in the pool.
//
//   plan: yes runs the task twice. First a read-only plan run (status planning), then the plan waits for the
//   boss in Needs your OK (plan-ready, approval: <id>). Approve: plan: approved, the real run gets the plan. The boss's OK is kept in .office/plans.json
//   (approval id + sha256 of the plan): plan: approved without a matching OK there fails.
//   Reject with a note: a new plan run with that note (replans: n, at most 3 times). Reject with no note: stopped.
//   The manager may decide a plan for the boss (cfg.pa.planApprover 'hana', see lib/server.js): she writes
//   decisions/<approval id>.md (decision: approved | rejected | escalate, then her note). scanDecisions() checks that the
//   manager's own run wrote it (who: pa in .office/events.jsonl) and hands it to onDecision; decidedBy: hana | boss is kept.
//
//   Quality checks (off unless the boss puts the files there; staff file tools cannot edit .office/, see OFFICE.md for the limits):
//   .office/hooks/task-completed.js  runs when a task run ends done. exit 2: sent back to the same staff with its
//                   stderr (retries: n, at most 2, then failed). Any other non-zero exit or a crash: done, with a note.
//   .office/hooks/staff-idle.js      runs when a staff has nothing left to do. exit 2: its stdout is a new task
//                   for them (idle: yes; at most 3 in a row without a task from someone else).
//
//   mail/<to>/<YYYYMMDD-HHMMSS>-<from>.md   a short message to a colleague (or pa), not work:
//                   ---  from / to / sent / status: unread | read | failed / reason  ---  <the message>
//                   A staff gets their unread mail in their next task's prompt; pa gets it as an [Office update].
//                   Only mail the sender's own run wrote (with Claude's Write tool, logged by .office/hook.js) and whose
//                   file name ends in -<from> is delivered; anything else is marked failed with the reason.
//                   Staff to staff: not delivered. status: forwarded, and it goes to pa instead (onMail with for: <to>).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const md = require('./md');
const { describe } = require('./chat');

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const nowIso = () => new Date().toISOString();
const isPool = (t) => String(t.staff || '').trim().toLowerCase() === 'any';
// asked by the manager, or by the office itself (an approved action, the idle hook): both report to pa
const byOffice = (from) => !from || from === 'pa' || from === 'office';
// plan: 'yes' (plan first), 'approved', '' (no plan) or null (a value the office does not know)
const planOf = (v) => { const x = String(v ?? '').trim().toLowerCase(); return ['yes', 'true', 'y', '1'].includes(x) ? 'yes' : x === 'approved' ? 'approved' : ['', 'no'].includes(x) ? '' : null; };
// one header line: no line breaks and no " # " (that starts a comment and would hide the rest)
const headerSafe = (s, max = 1000) => { let x = String(s || '').replace(/\s+/g, ' '); while (/ # /.test(x)) x = x.replace(/ # /g, ' '); return x.trim().slice(0, max); };
const sha = (s) => crypto.createHash('sha256').update(String(s).replace(/\s+/g, ' ').trim()).digest('hex'); // of the plan text, blank lines aside
const demote = (s) => String(s || '').trim().replace(/^#{1,2} /gm, '### '); // a heading would end the office's section
// an after: id -> the newest rerun of it (again: <id>), and of that one, and so on
const follow = (id, next) => { const seen = new Set([id]); while (next.has(id) && !seen.has(next.get(id))) { id = next.get(id); seen.add(id); } return id; };
// does staff s fit a pool task's role: words? (no role: anyone fits)
const words = (x) => String(x || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const fits = (s, role) => { const w = words(role); return !w.length || words(s.role).some((x) => w.includes(x)); };

class Tasks {
  // hooks: { access(staffId) -> {allowed, paths, note, shell}, claude() -> {cmd, pre}, env(cwd), loadCfg(),
  //          onStart(task), onEnd(task, result), graceMs (how long an after: task may be missing: default 2 min),
  //          onCheck(task, feedback) (a check sent work back), node (path to node: default this one), checkMs (hook timeout) }
  constructor(dir, hooks) {
    this.dir = dir; this.h = hooks;
    this.grace = hooks.graceMs ?? 2 * 60 * 1000; // the PA may write the waiting task's file before the one it waits for
    this.timer = null; // one pending re-check for after: tasks that are still missing
    this.root = path.join(dir, 'tasks');
    this.running = new Map(); // staff id -> { id, child }
    this.queued = new Map(); // staff id -> [task id]
    this.mailRoot = path.join(dir, 'mail');
    this.decRoot = path.join(dir, 'decisions');
    this.idleMade = new Map(); // staff id -> idle-made tasks in a row
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.mailRoot, { recursive: true });
    fs.mkdirSync(this.decRoot, { recursive: true });
  }

  file(id) {
    if (!FILE_ID.test(String(id))) { const e = new Error('No such task'); e.status = 404; throw e; } // never a path out of tasks/
    return path.join(this.root, `${id}.md`);
  }
  read(id) {
    const text = fs.readFileSync(this.file(id), 'utf8');
    const { fields, body, head } = md.parse(text);
    // The office's own sections are not part of the task: "## Plan (office)" (older offices wrote "## Plan", with planned:),
    // and the last "## Result" once the office wrote one (finished: or retries:). The same headings in the task text stay.
    const reported = !!(fields.finished || fields.retries);
    let lastResult = -1; if (reported) for (const m of body.matchAll(/^## result[ \t]*$/gim)) lastResult = m.index;
    const own = body.search(/^## plan \(office\)[ \t]*$/im), legacy = own < 0 && fields.planned;
    const cuts = [own, legacy ? body.search(/^## plan[ \t]*$/im) : -1, lastResult].filter((x) => x >= 0);
    const task = (cuts.length ? body.slice(0, Math.min(...cuts)) : body).trim();
    const after = (fields.after || '').split(',').map((x) => x.trim()).filter(Boolean);
    const planText = (own >= 0 ? md.section(body, 'Plan (office)') : legacy ? md.section(body, 'Plan') : '') || '';
    return { id, ...fields, after, status: fields.status || 'new', task, title: task.split('\n')[0].slice(0, 120), result: (reported && md.section(body, 'Result', { last: true })) || '', planText, header: head, _text: text };
  }
  write(id, fields, result, plan) {
    let text = fs.readFileSync(this.file(id), 'utf8');
    const was = md.parse(text).fields;
    text = md.setFields(text, fields);
    if (plan != null) text = md.setSection(text, 'Plan (office)', demote(plan) || '(no plan)');
    if (result != null) { // the first report goes at the end; later ones replace it (never a "## Result" in the task text)
      const r = demote(result) || '(no report)';
      text = was.finished || was.retries ? md.setSection(text, 'Result', r, { last: true }) : `${text.replace(/\s+$/, '')}\n\n## Result\n\n${r}\n`;
    }
    const tmp = `${this.file(id)}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, this.file(id));
  }
  list() {
    let names = [];
    try { names = fs.readdirSync(this.root); } catch { return []; }
    const all = names.filter((n) => n.endsWith('.md') && FILE_ID.test(n.slice(0, -3))).map((n) => { try { return this.read(n.slice(0, -3)); } catch { return null; } })
      .filter(Boolean).map(({ _text, ...t }) => t).sort((a, b) => (b.created || b.id).localeCompare(a.created || a.id));
    // deps: the after: tasks, each followed to its newest rerun. waiting: a new task whose deps are not all done yet
    const next = new Map(); for (const t of [...all].reverse()) if (t.again) next.set(t.again, t.id); // oldest first: the newest rerun wins
    const status = new Map(all.map((t) => [t.id, t.status]));
    return all.map((t) => { const deps = t.after.map((a) => follow(a, next)); return { ...t, deps, waiting: t.status === 'new' && deps.some((a) => status.get(a) !== 'done'), pool: t.status === 'new' && isPool(t) }; });
  }

  // Why a new task with after: can never start ('' when it can, or may later).
  // A missing after: task gets a grace time; due.at is set to when to look again.
  // A dep a restart cut off (interrupted: yes) is waited for: the boss may run it again (then the rerun counts) or dismiss it.
  // Returns the reason, or { reason, by, why } when a dep failed or was stopped (out.by, out.why are set).
  blocked(t, byId, due = {}, out = {}) {
    for (const a of t.deps || t.after) {
      const d = FILE_ID.test(a) && byId.get(a);
      if (!d) {
        // never later than now: a created: time in the future would wait (and set a timer) for ever
        let mt = Infinity; try { mt = fs.statSync(this.file(t.id)).mtimeMs; } catch { /* gone */ }
        const c = Date.parse(t.created), born = Math.min(Number.isNaN(c) ? Infinity : c, mt, Date.now());
        if (Date.now() < born + this.grace) { due.at = Math.min(due.at || Infinity, born + this.grace); continue; }
        return `It waits for task "${a}", but there is no such task.`;
      }
      if (d.status === 'stopped' && d.interrupted === 'yes') continue;
      if (d.status === 'forwarded') { out.by = a; out.why = 'forwarded'; return `It waits for task "${a}" (${d.title}), which was sent to the manager instead of run.`; }
      if (d.status === 'failed' || d.status === 'stopped') {
        out.by = a; out.why = d.status;
        return `It waits for task "${a}" (${d.title}), which ${d.status === 'failed' ? 'failed' : d.interrupted === 'dismissed' ? 'was cut off by a restart and dismissed' : 'was stopped'}.`;
      }
    }
    // does it end up waiting for itself, through the new tasks it waits for?
    const seen = new Set();
    const waitsFor = (id) => { const d = byId.get(id); return d && d.status === 'new' ? d.deps || d.after : []; };
    const loops = (id) => waitsFor(id).some((a) => a === t.id || (!seen.has(a) && (seen.add(a), loops(a))));
    return loops(t.id) ? 'Its after: tasks wait for each other in a circle, so none of them can start.' : '';
  }

  // Mail: check every unread message (bad ones are marked failed with a reason) and hand
  // pa's to onMail. Mail for a staff stays unread until their next task starts.
  setMail(f, fields) {
    const text = md.setFields(fs.readFileSync(f, 'utf8'), fields);
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
  }
  // Who wrote file f, from .office/events.jsonl: the hook logs each Write/Edit with the run's AI_OFFICE_STAFF (who).
  writers(f) {
    if (!this.log) { // read once per scan, the last 4 MB only
      this.log = [];
      try {
        const lf = path.join(this.dir, '.office', 'events.jsonl'), size = fs.statSync(lf).size, fd = fs.openSync(lf, 'r');
        const n = Math.min(size, 4 * 1024 * 1024), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
        for (const l of buf.toString('utf8').split('\n')) {
          if (!l.includes('"PreToolUse"')) continue;
          try { const e = JSON.parse(l); if ((e.tool === 'Write' || e.tool === 'Edit') && e.file) this.log.push(e); } catch { /* a cut line */ }
        }
      } catch { /* no log yet */ }
    }
    const norm = (x) => { const r = path.resolve(String(x)); return process.platform === 'win32' ? r.toLowerCase() : r; };
    return this.log.filter((e) => norm(e.file) === norm(f)).map((e) => e.who || '');
  }
  // Did the sender's own run write this message (and nobody else)? Once proven it is kept in .office/mail-ok.json
  // (file -> sha256 of sender and text), so a staff's mail still counts when the log has moved on by their next task.
  mailProven(to, n, f, from, body) {
    const okFile = path.join(this.dir, '.office', 'mail-ok.json'), key = `${to}/${n}`, h = sha(`${from}\n${body}`);
    let ok = {}; try { ok = JSON.parse(fs.readFileSync(okFile, 'utf8')) || {}; } catch { /* none yet */ }
    if (ok[key] === h) return true;
    const w = this.writers(f);
    if (!w.length || w.some((x) => x !== from)) return false;
    ok[key] = h;
    try { const tmp = `${okFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(ok, null, 2) + '\n'); fs.renameSync(tmp, okFile); } catch { /* no .office: checked again next time */ }
    return true;
  }
  scanMail(only) {
    this.log = null;
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
            : !n.slice(0, -3).endsWith(`-${from}`) ? `The file name must end in -${from}.md for a message from ${from}.`
            : !body.trim() ? 'The message is empty.'
            : !this.mailProven(to, n, f, from, body) ? `The office cannot confirm that ${from} wrote this: only a message written by ${from}'s own Claude run (with its Write tool) is delivered.` : '';
          if (bad) { this.setMail(f, { status: 'failed', reason: bad }); continue; }
          const m = { id: n.slice(0, -3), file: f, from, to, name: name(from), sent: fields.sent || '', text: body.trim() };
          const forFor = to === 'pa' && fields.for && fields.for !== from && (cfg.staff || []).some((s) => s.id === fields.for) ? fields.for : '';
          if (to === 'pa') { this.setMail(f, { status: 'read', read: nowIso() }); if (this.h.onMail) this.h.onMail({ ...m, ...(forFor ? { for: forFor, forName: name(forFor) } : {}) }); } // read first: never twice
          else if (from !== 'pa') { // staff to staff: only through the manager. She gets it, with who it was meant for
            this.setMail(f, { status: 'forwarded', forwarded: nowIso() });
            if (this.h.onMail) this.h.onMail({ ...m, to: 'pa', for: to, forName: name(to), forwarded: true });
          } else out.push(m);
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
    fs.writeFileSync(this.file(id), md.make({ staff, from: 'office', project: '', status: 'new', created: nowIso(), ...fields }, text));
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
    const pool = t.claimed === 'yes' || isPool(t); // a claimed task goes back to the pool
    const deps = (this.list().find((x) => x.id === id) || {}).deps || t.after; // its after: tasks, or their newest reruns
    return { ok: true, id: this.add(pool ? 'any' : t.staff, t.task, { from: t.from || 'pa', project: t.project || '', ...(pool && t.role ? { role: t.role } : {}),
      ...(['yes', 'approved'].includes(planOf(t.plan)) ? { plan: 'yes' } : {}), ...(deps.length ? { after: deps.join(', ') } : {}), again: id }) };
  }
  // The boss is done with a stopped or failed task. A task a restart cut off: tasks waiting for it fail now.
  dismiss(id) {
    const t = this.read(id);
    this.write(id, { ...(t.interrupted === 'yes' ? { interrupted: 'dismissed' } : {}), ...(['stopped', 'failed', 'forwarded'].includes(t.status) ? { dismissed: 'yes' } : {}) });
    this.scan();
    return { ok: true };
  }

  // The boss's OKs for plans, kept where staff file tools cannot write (.office/plans.json): task id -> { approval, sha }.
  plansFile() { return path.join(this.dir, '.office', 'plans.json'); }
  plans() { try { return JSON.parse(fs.readFileSync(this.plansFile(), 'utf8')) || {}; } catch { return {}; } }
  okPlan(t) { const r = this.plans()[t.id]; return !!(r && t.approval && r.approval === t.approval && r.sha === sha(t.planText)); }

  // Pick up new task files (called when tasks/ changes).
  scan() {
    const cfg = this.h.loadCfg();
    const all = this.list(), byId = new Map(all.map((t) => [t.id, t])), due = {};
    let again = false;
    for (const t of all.reverse()) { // oldest first
      if (t.status !== 'new') continue;
      const busy = [...this.running.values()].some((r) => r.id === t.id) || [...this.queued.values()].some((q) => q.includes(t.id));
      if (busy) continue;
      const from = t.from || 'pa', plan = planOf(t.plan);
      const pool = isPool(t), fit = pool ? (cfg.staff || []).filter((s) => s.id !== from && fits(s, t.role)) : [];
      const bad = (!t.header ? 'This file has no "---" header, so the office cannot read it as a task (see OFFICE.md for the format).'
        : !String(t.staff || '').trim() ? 'The task has no staff: line. Write staff: <staff id>, or staff: any for whoever is free first.'
        : pool ? (fit.length ? '' : t.role ? `There is no active staff with the role "${t.role}" to take it.` : 'There is no other active staff to take it.')
        : !(cfg.staff || []).some((s) => s.id === t.staff) ? `There is no active staff with id "${t.staff || ''}".` : '')
        || (!byOffice(from) && !(cfg.staff || []).some((s) => s.id === from) ? `"${from}" is not on the team, so the task has nobody to report to.`
        : from === t.staff ? 'A staff cannot give a task to themselves.' : '')
        || (plan === null ? `"plan: ${t.plan}" is not understood. Write plan: yes to plan first, or leave the line out.` : '')
        || (plan === 'approved' && !this.okPlan(t) ? 'It says plan: approved, but there is no OK from the boss for this plan. Hand it out again with plan: yes.' : '');
      if (!bad && !byOffice(from)) { // a staff asked a colleague (or the pool): it goes to the manager, who decides
        this.write(t.id, { status: 'forwarded', forwarded: nowIso() });
        const nm = (id) => ((cfg.staff || []).find((s) => s.id === id) || {}).name || id;
        if (this.h.onForward) this.h.onForward({ ...t, from, status: 'forwarded', fromName: nm(from), toName: pool ? (t.role ? `a free ${t.role} staff` : 'anyone free') : nm(t.staff) });
        t.status = 'forwarded'; again = true; // tasks waiting for this one fail, on the next pass
        continue;
      }
      const by = {}, stuck = bad ? '' : this.blocked(t, byId, due, by);
      if (bad || stuck) {
        this.write(t.id, { status: 'failed', finished: nowIso(), ...(by.by ? { cancelledBy: by.by, cancelReason: by.why } : {}) }, bad || stuck);
        const who = (cfg.staff || []).find((s) => s.id === t.staff);
        this.h.onEnd({ ...t, from, status: 'failed', name: pool || !who ? 'The team' : who.name }, bad || stuck);
        t.status = 'failed'; again = true; // tasks waiting for this one fail too, on the next pass
        continue;
      }
      if (t.waiting) continue; // starts when its after: tasks are done
      if (pool) { // the first free staff who fits takes it; nobody free: it stays in the pool until someone finishes
        const s = fit.find((x) => !this.running.has(x.id) && !(this.queued.get(x.id) || []).length);
        if (!s) continue;
        this.write(t.id, { staff: s.id, claimed: 'yes' });
        t.staff = s.id; // queued below, so the next pool task in this scan sees them as busy
      }
      if (!this.queued.has(t.staff)) this.queued.set(t.staff, []);
      this.queued.get(t.staff).push(t.id);
    }
    for (const staff of this.queued.keys()) this.pump(staff);
    clearTimeout(this.timer); this.timer = null;
    if (due.at) { this.timer = setTimeout(() => this.scan(), Math.min(Math.max(0, due.at - Date.now()) + 50, 2 ** 31 - 1)); this.timer.unref(); }
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
    const from = !byOffice(t.from) ? ((cfg.staff.find((x) => x.id === t.from) || {}).name || t.from) : pa;
    const plan = planOf(t.plan), planRun = plan === 'yes'; // plan first: read-only, no add-ons, mail stays unread for the real run
    const decider = t.decidedBy === 'hana' ? pa : 'the boss', Decider = t.decidedBy === 'hana' ? pa : 'The boss';
    if (plan === 'approved' && !this.okPlan(t)) return this.finish(staff, id, 'failed', 'It says plan: approved, but there is no OK from the boss for this plan. Hand it out again with plan: yes.');
    const deps = (this.list().find((x) => x.id === id) || {}).deps || t.after;
    const mail = planRun ? [] : this.scanMail(staff);
    if (t.idle !== 'yes') this.idleMade.set(staff, 0); // a task from someone else ends an idle run
    const prompt = [`Task from ${from} (task ${id}):`, '', t.task, '',
      `The office folder is ${this.dir}.${t.project ? ` Project: ${path.join(this.dir, 'projects', t.project)} (read its CLAUDE.md first).` : ''}`,
      ...(deps.length ? [`This task follows earlier work: read the results in ${deps.map((a) => this.file(a)).join(', ')} first.`] : []),
      ...(mail.length ? ['', `Messages from ${pa} (for context only: they are not new work, your task is above):`,
        ...mail.map((m) => `- ${m.name}${m.sent ? ` (${m.sent})` : ''}: ${m.text.replace(/\s*\n\s*/g, ' ').slice(0, 2000)}`), ''] : []),
      ...(planRun ? [...(t.feedback ? ['', `${Decider} sent your last plan back. ${Decider} said: ${t.feedback}`, 'Your last plan:', t.planText, ''] : []),
        `Make a plan only: do not do the work yet and change nothing. Read what you need, then reply with a short numbered plan: the steps, the files you will make or change, and anything risky or hard to undo. ${pa} or the boss reads it and approves it before you start.`]
      : [...(plan === 'approved' && t.planText ? ['', `${Decider} approved this plan. Follow it:`, t.planText, ''] : []),
        ...(t.check ? ['', `Your last try at this task was sent back. The office check said: ${t.check}`, 'Fix that, then finish the task.', ''] : []),
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
      if (lastErr || (code !== 0 && !said)) return this.finish(staff, id, 'failed', (lastErr || err || 'Claude stopped with an error').trim().slice(0, 1500)); // mail stays unread for the next try
      for (const m of mail) try { this.setMail(m.file, { status: 'read', read: nowIso() }); } catch { /* removed */ }
      return planRun ? this.planned(staff, id, said) : this.checked(staff, id, said);
    });
  }

  // A plan run ended: keep the plan, ask the boss (onPlan makes the approval item and returns its id).
  // Not an end: tasks that wait for this one keep waiting for done.
  planned(staff, id, plan) {
    this.running.delete(staff);
    const text = demote(plan) || '(no plan)'; // a heading would end the Plan section
    try {
      this.write(id, { status: 'plan-ready', planned: nowIso() }, null, text);
      const t = this.read(id), cfg = this.h.loadCfg();
      const approval = this.h.onPlan ? this.h.onPlan({ ...t, from: t.from || 'pa', name: ((cfg.staff || []).find((x) => x.id === staff) || {}).name || staff }, text) : '';
      if (approval) this.write(id, { approval });
    } catch { /* file removed */ }
    this.pump(staff);
    this.scan();
  }

  // The manager's plan decisions: decisions/<approval id>.md (decision: approved | rejected | escalate, then her note).
  // Only a file her own dashboard run wrote (who: pa in .office/events.jsonl, nobody else) counts; onDecision does the rest
  // and throws to refuse. The office writes status: done, or failed with a reason, so each file is used once.
  scanDecisions() {
    this.log = null; // a fresh look at the log: the file was just written
    let names = [];
    try { names = fs.readdirSync(this.decRoot).filter((n) => n.endsWith('.md') && FILE_ID.test(n.slice(0, -3))).sort(); } catch { return; }
    for (const n of names) {
      const f = path.join(this.decRoot, n);
      try {
        const { fields, body } = md.parse(fs.readFileSync(f, 'utf8'));
        if (fields.status) continue; // already used (done or failed)
        const decision = String(fields.decision || '').trim().toLowerCase(), w = this.writers(f);
        let bad = !['approved', 'rejected', 'escalate'].includes(decision) ? 'Write decision: approved, rejected or escalate in the header.'
          : !w.length || w.some((x) => x !== 'pa') ? "The office cannot confirm that the manager wrote this: only a decision written by the manager's own dashboard run (with its Write tool) counts." : '';
        if (!bad) { try { if (this.h.onDecision) this.h.onDecision({ approval: n.slice(0, -3), decision, note: body.trim() }); } catch (e) { bad = e.message || 'Refused.'; } }
        this.setMail(f, bad ? { status: 'failed', reason: headerSafe(bad, 300) } : { status: 'done', used: nowIso() });
      } catch { /* half-written or removed: next scan */ }
    }
  }

  // The plan approval this task waits for, or a 409 when it moved on (stopped, re-planned, done).
  planCheck(id, approval) {
    let t; try { t = this.read(id); } catch { t = {}; } // the task file is gone: not waiting either
    if (t.status !== 'plan-ready' || !approval || t.approval !== approval) { const e = new Error('This plan is no longer waiting for your OK.'); e.status = 409; throw e; }
    return t;
  }
  // The boss (or the manager, by: 'hana') decided on a plan. Approved: the real run. Rejected with a note: a new plan
  // (at most 3 times). No note: stopped.
  decidePlan(id, approval, decision, note, by = 'boss') {
    const t = this.planCheck(id, approval);
    note = headerSafe(note);
    const hana = by === 'hana', who = hana ? ((this.h.loadCfg().pa || {}).name || 'the manager') : 'the boss';
    if (decision === 'approved') { // the OK goes to .office/plans.json first: start() checks it (the task file is writable by staff)
      const all = this.plans(); all[id] = { approval, sha: sha(t.planText), at: nowIso() };
      fs.mkdirSync(path.dirname(this.plansFile()), { recursive: true });
      const tmp = `${this.plansFile()}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n'); fs.renameSync(tmp, this.plansFile());
      this.write(id, { status: 'new', plan: 'approved', approved: nowIso(), decidedBy: by }); this.scan(); return { ok: true, status: 'working' };
    }
    const n = Number(t.replans) || 0;
    if (!note) return this.endPlan(t, `Stopped: ${who} rejected the plan.`);
    if (n >= 3) return this.endPlan(t, `Stopped: ${who} sent the plan back 3 times. Hand it out again with clearer details.`);
    this.write(id, { status: 'new', replans: n + 1, feedback: note, decidedBy: by });
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

  // Run an office hook (.office/hooks/<name>) with node: input as JSON on stdin. cb(null) when there is no hook,
  // else cb({ code, out, err, broken }). The staff stays busy meanwhile, and Stop stops the hook.
  hook(staff, id, name, input, cb) {
    const f = path.join(this.dir, '.office', 'hooks', name);
    if (!fs.existsSync(f)) return cb(null);
    let child, out = '', err = '', done = false;
    const end = (r) => { if (!done) { done = true; clearTimeout(timer); cb({ out: out.trim(), err: err.trim(), ...r }); } };
    try { child = spawn(this.h.node || process.execPath, [f], { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return cb({ code: null, out: '', err: '', broken: e.message }); }
    if (id) this.running.set(staff, { id, child, step: 'Office check' });
    const timer = setTimeout(() => { child.kill(); end({ code: null, broken: 'it took too long' }); }, this.h.checkMs ?? 60 * 1000);
    child.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    child.stdin.on('error', () => { /* the hook did not read it */ });
    child.on('error', (e) => end({ code: null, broken: e.message }));
    child.on('close', (code) => end(child.stopped ? { code: null, stopped: true } : { code }));
    child.stdin.end(JSON.stringify(input));
  }

  // A task run ended done: the office check (if any) passes it, or sends it back to the same staff.
  checked(staff, id, said) {
    let t; try { t = this.read(id); } catch { return this.finish(staff, id, 'done', said); }
    const input = { id, staff, from: t.from || 'pa', project: t.project || '', title: t.title, task: t.task, result: said };
    this.hook(staff, id, 'task-completed.js', input, (r) => {
      if (!r || r.code === 0) return this.finish(staff, id, 'done', said);
      if (r.stopped) return this.finish(staff, id, 'stopped', 'Stopped by the boss.');
      if (r.code !== 2) return this.finish(staff, id, 'done', `${said}\n\n(The office check could not run: ${r.broken || `exit code ${r.code}`}. The work was not checked.)`);
      const feedback = headerSafe(r.err || '(the check gave no reason)'); // one header line
      const n = Number(t.retries) || 0;
      if (n >= 2) return this.finish(staff, id, 'failed', `The office check sent this back ${n + 1} times. Last time it said: ${feedback}\n\nLast report:\n${said}`);
      this.running.delete(staff);
      try { this.write(id, { status: 'new', retries: n + 1, check: feedback }, said); } catch { /* file removed */ }
      const cfg = this.h.loadCfg();
      if (this.h.onCheck) this.h.onCheck({ ...t, from: t.from || 'pa', retries: n + 1, name: ((cfg.staff || []).find((x) => x.id === staff) || {}).name || staff }, feedback);
      this.scan(); // the same staff runs it again (ahead of nothing: it is theirs now)
    });
  }

  // Nobody gave this staff more work: the idle hook may give them some (at most 3 in a row).
  idle(staff, last) {
    if (this.running.has(staff) || (this.queued.get(staff) || []).length) return;
    if ((this.idleMade.get(staff) || 0) >= 3) return;
    this.hook(staff, null, 'staff-idle.js', { staff, lastTask: last }, (r) => {
      if (!r || r.code !== 2 || !r.out) return;
      if (this.running.has(staff) || (this.queued.get(staff) || []).length) return; // got work meanwhile
      this.idleMade.set(staff, (this.idleMade.get(staff) || 0) + 1);
      try { this.add(staff, r.out, { idle: 'yes' }); } catch { /* the staff left */ }
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
    if (status !== 'stopped') this.idle(staff, { id, title: t.title || '', status, result: String(result || '').slice(0, 4000) });
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
