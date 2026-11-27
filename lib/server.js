// The office server: serves the dashboard and a small local API over the office files.
// Listens on 127.0.0.1 only. Every API call needs the office key (from office.json).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./office');
const { Status } = require('./status');
const { Chats, access, chatEnv, mcpFor, resolveClaude } = require('./chat');
const { Tasks } = require('./tasks');
const { Usage } = require('./usage');
const DocTools = require('./doctools');

const DASH = path.join(__dirname, '..', 'dashboard');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };

// Open a file or folder the way a double-click would (resolveOpen already checked it).
// In WSL the boss sits at Windows: open it with Windows Explorer (its Windows apps), not a Linux app.
const isWsl = () => { try { return process.platform === 'linux' && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; } };
function openOnComputer({ path: f, how }) {
  const { spawn, execFileSync } = require('child_process');
  const win = process.platform === 'win32', mac = process.platform === 'darwin';
  let wsl = null;
  if (!win && !mac && isWsl()) { try { wsl = execFileSync('wslpath', ['-w', f], { encoding: 'utf8' }).trim(); } catch { /* no wslpath: fall back */ } }
  const [cmd, args, extra] = win ? ['explorer.exe', [how === 'reveal' ? `/select,"${f}"` : `"${f}"`], { windowsVerbatimArguments: true }]
    : mac ? ['open', how === 'reveal' ? ['-R', f] : [f]]
    : wsl ? ['explorer.exe', [how === 'reveal' ? `/select,${wsl}` : wsl]]
    : ['xdg-open', [how === 'reveal' ? path.dirname(f) : f]];
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: false, ...(extra || {}) }); c.on('error', () => {}); c.unref(); } catch { /* nothing to open with */ }
  return { ok: true, how };
}

function createServer(dir) {
  const cfg = O.loadCfg(dir);
  const key = String(cfg.key || '');
  let port = 0; // set once listening
  const clients = new Set();

  const broadcast = (ev, data) => { const m = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(m); };
  // plan limits and tokens, from every run (told to the page at most twice a second)
  let usageTimer = null;
  const usage = new Usage(dir, () => { if (!usageTimer) usageTimer = setTimeout(() => { usageTimer = null; broadcast('usage', usage.summary()); }, 500); });
  const onUsage = (j, who, kind, id) => usage.see(j, who, kind, id);
  const chats = new Chats(dir, {
    onMessage: (id, msg) => broadcast('chat', { id, msg }),
    onState: (id, running) => broadcast('chatstate', { id, running }),
    onLive: (id, live) => broadcast('chatlive', { id, ...live }),
    loadCfg: () => O.loadCfg(dir), onUsage,
  });
  // staff tasks run on their own; the PA hears when they end
  const logEvent = (e) => { try { fs.appendFileSync(path.join(dir, '.office', 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); } catch { /* no .office */ } };
  const staffName = (id) => (O.loadCfg(dir).staff.find((s) => s.id === id) || {}).name || id;
  const tasks = new Tasks(dir, {
    access: (id, opts) => access(dir, id, opts), claude: resolveClaude, env: chatEnv, mcp: (cfg, id) => mcpFor(dir, cfg, id), loadCfg: () => O.loadCfg(dir), onUsage,
    onStart: (t) => {
      logEvent({ ev: 'TaskStart', aid: `task:${t.id}`, staff: t.staff, task: t.title });
      const asker = t.from !== 'pa' ? staffName(t.from) : '';
      // the PA always sees it; a staff who asked sees it in their own chat too
      const started = t.status === 'planning' ? 'is making a plan' : 'started';
      chats.add('pa', { from: 'system', kind: 'activity', staff: t.staff, task: t.id, text: asker ? `${asker} asked ${t.name}: ${t.title}` : `${t.name} ${started}: ${t.title}` });
      if (asker) chats.add(t.from, { from: 'system', kind: 'activity', staff: t.staff, task: t.id, text: `${t.name} ${started}: ${t.title}` });
      broadcast('tasks', tasks.active());
    },
    onStep: (x) => broadcast('taskstep', x),
    // a plan: yes task made its plan: it waits in Needs your OK (decided in the approvals route below)
    onPlan: (t, plan) => {
      logEvent({ ev: 'TaskEnd', aid: `task:${t.id}`, staff: t.staff });
      const a = O.addApproval(dir, { from: t.staff, action: `Plan: ${t.title || t.id}`, details: plan, project: t.project, kind: 'plan', task: t.id });
      chats.add('pa', { from: 'system', kind: 'activity', staff: t.staff, task: t.id, text: `${t.name} made a plan, waiting for the boss's OK: ${t.title || t.id}` });
      broadcast('tasks', tasks.active());
      return a.id;
    },
    // the boss stopped a task whose plan was waiting: close its approval item too
    onPlanDrop: (t) => { if (t.approval && O.getApproval(dir, t.approval).status === 'pending') O.decideApproval(dir, t.approval, 'rejected', 'The task was stopped.'); },
    onEnd: (t, result) => {
      logEvent({ ev: 'TaskEnd', aid: `task:${t.id}`, staff: t.staff });
      const word = { done: 'finished', failed: 'could not finish', stopped: 'stopped' }[t.status] || t.status;
      const to = t.from && t.from !== 'pa' && O.loadCfg(dir).staff.some((s) => s.id === t.from) ? t.from : 'pa';
      const line = (text) => ({ from: 'system', kind: t.status === 'failed' ? 'error' : 'activity', done: t.status === 'done', staff: t.staff, task: t.id, text });
      chats.add('pa', line(to === 'pa' ? `${t.name || t.staff} ${word}: ${t.title || t.id}` : `${t.name || t.staff} ${t.status === 'done' ? 'answered' : word} ${staffName(to)}: ${t.title || t.id}`));
      if (to !== 'pa') chats.add(to, line(`${t.name || t.staff} ${word}: ${t.title || t.id}`));
      broadcast('tasks', tasks.active());
      if (t.status === 'stopped') return;
      chats.notify(to, `[Office update, not from the boss] ${t.name || t.staff} ${word} ${to === 'pa' ? 'task' : 'your request'} ${t.id} ("${t.title || ''}").\n${t.status === 'done' ? 'Their answer / report' : 'What went wrong'}:\n${String(result || '').slice(0, 4000)}\n\n${to === 'pa' ? 'Check it, then tell the boss in a few short lines what is done and what is next. If more work is needed, hand it out with a task file.' : 'Tell the boss what they said, in a few short lines.'}`);
    },
    // a short message to the manager: a heads-up, not work
    onMail: (m) => {
      chats.add('pa', { from: 'system', kind: 'activity', staff: m.from, text: `${m.name} sent a message: ${m.text.split('\n')[0].slice(0, 80)}` });
      chats.notify('pa', `[Office update, not from the boss] Message from ${m.name}:\n${m.text.slice(0, 4000)}\n\nThis is a heads-up, not new work. Keep it in mind; tell the boss only if it matters to them, in one short line.`);
    },
  });
  // tasks a restart cut off: tell the boss (no Claude run needed), they can run them again from the work board
  const cut = tasks.recover();
  if (cut.length) {
    const short = (x) => (x.length > 60 ? `${x.slice(0, 57)}...` : x);
    const who = cut.map((t) => `${staffName(t.staff)}: ${short(t.title || t.id)}`).join('; ');
    chats.add('pa', { from: 'system', kind: 'error', text: `The office was restarted while ${cut.length === 1 ? 'a task was' : `${cut.length} tasks were`} running (${who}). Run ${cut.length === 1 ? 'it' : 'them'} again from the work board, top left of the Office.` });
  }

  const taskId = (id) => { if (!/^[\w.-]+$/.test(id) || !tasks.list().some((t) => t.id === id)) throw new O.OfficeError('No such task', 404); return id; };
  const chatId = (id) => {
    if (id === 'pa' || O.loadCfg(dir).staff.some((s) => s.id === id)) return id;
    throw new O.OfficeError('No such person to chat with', 404);
  };

  // ---- live status (who is working), from the hooks' event log and pending approvals
  const status = new Status(dir);
  let lastStatus = '';
  function computeStatus() {
    status.readNew();
    const c = O.loadCfg(dir);
    const people = [{ id: 'pa' }, ...c.staff.map((s) => ({ id: s.id }))];
    const pendingFrom = new Set(O.listApprovals(dir).filter((a) => a.status === 'pending').map((a) => a.from));
    return status.snapshot(people, pendingFrom);
  }
  function pushStatus(force) {
    let snap;
    try { snap = computeStatus(); } catch { return; }
    const json = JSON.stringify(snap);
    if (!force && json === lastStatus) return;
    lastStatus = json;
    for (const c of clients) c.write(`event: status\ndata: ${json}\n\n`);
  }

  const sameKey = (k) => typeof k === 'string' && k.length === key.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(key));
  const hostOk = (req) => [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(String(req.headers.host || '').toLowerCase());
  const originOk = (req) => !req.headers.origin || [`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin);

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > limit) { reject(new O.OfficeError('Too big', 413)); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new O.OfficeError('Body must be JSON')); } });
  });

  // ---- API routes: [method, pattern, handler(params, body)]
  const R = [
    ['GET', /^\/api\/office$/, () => O.info(dir)],
    ['GET', /^\/api\/staff$/, () => O.listStaff(dir)],
    ['POST', /^\/api\/staff$/, (m, b) => O.addStaff(dir, b)],
    ['GET', /^\/api\/staff\/([^/]+)$/, (m) => O.getStaff(dir, m[1])],
    ['PUT', /^\/api\/staff\/([^/]+)$/, (m, b) => O.updateStaff(dir, m[1], b)],
    ['POST', /^\/api\/staff\/([^/]+)\/archive$/, (m) => O.archiveStaff(dir, m[1])],
    ['POST', /^\/api\/staff\/([^/]+)\/reactivate$/, (m) => O.reactivateStaff(dir, m[1])],
    ['POST', /^\/api\/staff\/([^/]+)\/delete$/, (m, b) => O.deleteStaff(dir, m[1], b.confirm)],
    ['GET', /^\/api\/projects$/, () => O.listProjects(dir)],
    ['POST', /^\/api\/projects$/, (m, b) => O.createProject(dir, b)],
    ['GET', /^\/api\/projects\/([^/]+)$/, (m) => O.getProject(dir, m[1])],
    ['PUT', /^\/api\/projects\/([^/]+)$/, (m, b) => O.updateProject(dir, m[1], b)],
    ['POST', /^\/api\/projects\/([^/]+)\/notes$/, (m, b) => O.addProjectNote(dir, m[1], b.note)],
    ['GET', /^\/api\/inbox$/, () => O.listInbox(dir)],
    ['POST', /^\/api\/inbox$/, (m, b) => O.addInbox(dir, b)],
    ['PUT', /^\/api\/inbox\/([^/]+)$/, (m, b) => O.updateInbox(dir, m[1], b)],
    ['GET', /^\/api\/approvals$/, () => O.listApprovals(dir)],
    ['POST', /^\/api\/approvals$/, (m, b) => O.addApproval(dir, b)],
    ['GET', /^\/api\/approvals\/([^/]+)$/, (m) => O.getApproval(dir, m[1])],
    ['POST', /^\/api\/approvals\/([^/]+)\/decide$/, (m, b) => {
      const pre = O.getApproval(dir, m[1]);
      if (pre.kind === 'plan') { // a staff's plan: the task goes on (or plans again, or stops) by itself
        if (pre.status === 'pending' && ['approved', 'rejected'].includes(b.decision)) tasks.planCheck(pre.task, pre.id); // 409 when the task moved on
        const a = O.decideApproval(dir, m[1], b.decision, b.note);
        const r = tasks.decidePlan(a.task, a.id, a.status, b.note);
        const name = staffName(a.from);
        if (r.status !== 'stopped') chats.notify('pa', `[Office update, not from the boss] The boss ${r.status === 'working' ? 'approved' : 'sent back'} ${name}'s plan for task ${a.task} ("${a.action.replace(/^Plan: /, '')}").${b.note ? ` The boss said: ${b.note}` : ''}\n${r.status === 'working' ? `${name} is doing the work now` : `${name} makes a new plan`} by themselves: do not hand it out again. Acknowledge in one short line.`);
        broadcast('tasks', tasks.active());
        return a;
      }
      const a = O.decideApproval(dir, m[1], b.decision, b.note);
      const who = O.loadCfg(dir).staff.find((s) => s.id === a.from || s.name.toLowerCase() === String(a.from || '').toLowerCase());
      // An approved add-on action (send, pay): the staff who asked does it right away. The guard lets that exact call through once.
      let started = '';
      if (who && a.status === 'approved' && a.tool) {
        started = tasks.add(who.id, [`Do what the boss approved: ${a.action}`, '',
          `The boss approved this (approvals/${a.id}.md). Do it now: call ${a.tool} with exactly this input, nothing changed:`,
          a.input || '{}', ...(b.note ? ['', `The boss said: ${b.note}`] : []), '', 'Then report the result in one or two lines.'].join('\n'));
      }
      if (who) chats.notify('pa', `[Office update, not from the boss] The boss ${a.status} "${a.action}" (asked by ${who.name}).${b.note ? ` The boss said: ${b.note}` : ''}\n${started ? `${who.name} was started on it automatically: do not hand it out again. Acknowledge in one short line.` : 'If work was waiting for this, hand out the next step with a task file. Otherwise acknowledge in one short line.'}`);
      return a;
    }],
    ['GET', /^\/api\/actions$/, () => O.listActions(dir)],
    ['POST', /^\/api\/actions$/, (m, b) => O.setAction(dir, b)],
    ['GET', /^\/api\/usage$/, () => usage.summary()],
    ['GET', /^\/api\/run$/, () => O.runSettings(dir)],
    ['GET', /^\/api\/doctools$/, () => DocTools.status(dir)],
    ['POST', /^\/api\/doctools\/install$/, () => DocTools.ensure(dir, (st) => broadcast('doctools', st))],
    ['PUT', /^\/api\/manager$/, (m, b) => O.updateManager(dir, b)],
    ['PUT', /^\/api\/office$/, (m, b) => O.updateCompany(dir, b)],
    ['POST', /^\/api\/open$/, (m, b) => openOnComputer(O.resolveOpen(dir, b.path))],
    ['GET', /^\/api\/tasks$/, () => ({ active: tasks.active(), list: tasks.list().slice(0, 50), interrupted: tasks.interrupted() })],
    ['POST', /^\/api\/tasks\/([^/]+)\/stop$/, (m) => tasks.stop(m[1])],
    ['POST', /^\/api\/tasks\/([^/]+)\/rerun$/, (m) => { const r = tasks.rerun(taskId(m[1])); broadcast('tasks', tasks.active()); return r; }],
    ['POST', /^\/api\/tasks\/([^/]+)\/dismiss$/, (m) => { const r = tasks.dismiss(taskId(m[1])); broadcast('tasks', tasks.active()); return r; }],
    ['POST', /^\/api\/events$/, (m, b) => O.addEvent(dir, b)],
    ['GET', /^\/api\/presets$/, () => Object.entries(require('../office-files/guard').PRESETS).map(([id, p]) => ({ id, label: p.label, about: p.about }))],
    ['GET', /^\/api\/linked$/, () => O.listLinked(dir)],
    ['POST', /^\/api\/linked$/, (m, b) => O.addLinked(dir, b)],
    ['POST', /^\/api\/linked\/remove$/, (m, b) => O.removeLinked(dir, b.path)],
    ['POST', /^\/api\/cleanup$/, (m, b) => {
      if (chats.running().length) throw new O.OfficeError('A chat is still running. Wait for it to finish, or press Stop.', 409);
      const r = O.cleanup(dir, b.items, b.confirm);
      if (r.cleared.activity) { status.reset(); pushStatus(true); }
      broadcast('cleared', r.cleared);
      return r;
    }],
    ['GET', /^\/api\/status$/, () => computeStatus()],
    ['GET', /^\/api\/chats$/, () => ({ running: chats.running() })],
    ['GET', /^\/api\/chat\/([^/]+)$/, (m) => chats.history(chatId(m[1]))],
    ['POST', /^\/api\/chat\/([^/]+)$/, (m, b) => chats.send(chatId(m[1]), b.text)],
    ['POST', /^\/api\/chat\/([^/]+)\/stop$/, (m) => chats.stop(chatId(m[1]))],
    ['POST', /^\/api\/chat\/([^/]+)\/new$/, (m) => chats.reset(chatId(m[1]))],
    ['GET', /^\/api\/activity$/, () => { status.readNew(); return status.feed.slice(-50); }],
    // pasted or dropped image, base64 in JSON: 10 MB decoded is about 13.98 MB of text, so this route alone gets a bigger cap
    ['POST', /^\/api\/attachments$/, (m, b) => O.saveAttachment(dir, b), Math.ceil(10 * 1024 * 1024 * 4 / 3) + 4096],
  ];

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return send(res, 421, { error: 'Wrong host' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = url.pathname;

      if (route === '/api/ping') return send(res, 200, { app: 'ai-office' });
      if (route.startsWith('/api/')) {
        if (!originOk(req)) return send(res, 403, { error: 'Wrong origin' });
        if (!sameKey(req.headers['x-office-key'] || (route === '/api/stream' ? url.searchParams.get('key') : ''))) {
          return send(res, 401, { error: 'Office key missing or wrong. It is the "key" in office.json.' });
        }
        if (route === '/api/stream' && req.method === 'GET') return stream(req, res);
        for (const [method, re, fn, limit] of R) {
          const m = re.exec(route);
          if (m && req.method === method) {
            const body = ['POST', 'PUT'].includes(method) ? await readBody(req, limit) : {};
            return send(res, 200, await fn(m.map((x) => (x ? decodeURIComponent(x) : x)), body));
          }
        }
        return send(res, 404, { error: 'No such API call' });
      }
      return serveStatic(route, res, req);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? 'Something went wrong on the office server' : e.message });
    }
  });

  function serveStatic(route, res, req) {
    const rel = route === '/' ? 'index.html' : decodeURIComponent(route).replace(/^\/+/, '');
    const f = path.resolve(DASH, rel);
    if (!f.startsWith(DASH + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, 'Not found', 'text/plain');
    let body = fs.readFileSync(f);
    if (rel === 'index.html') {
      // A hard refresh (Ctrl+Shift+R) asks with "no-cache": the page then starts from the default view.
      const fresh = /no-cache/i.test(String(req.headers['cache-control'] || '') + String(req.headers.pragma || ''));
      body = body.toString('utf8').replace('%%OFFICE_KEY%%', key).replace('%%FRESH%%', fresh ? '1' : ''); // same-origin page only
    }
    return send(res, 200, body, TYPES[path.extname(f)] || 'application/octet-stream');
  }

  // ---- live refresh: tell open pages which part of the office changed
  function stream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    try { res.write(`event: status\ndata: ${JSON.stringify(computeStatus())}\n\n`); } catch { /* office being edited */ }
    req.on('close', () => clients.delete(res));
  }
  const pending = new Set(); let timer = null;
  function changed(area) {
    pending.add(area);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const msg = `event: changed\ndata: ${JSON.stringify([...pending])}\n\n`;
      const areas = [...pending];
      pending.clear();
      for (const c of clients) c.write(msg);
      if (areas.includes('tasks')) tasks.scan();
      if (areas.includes('mail')) tasks.scanMail();
      if (areas.some((a) => ['events', 'approvals', 'office', 'staff'].includes(a))) pushStatus();
    }, 150);
  }
  const areaOf = (rel) => {
    const [top, sub] = rel.split(/[\\/]/);
    if (rel.endsWith('.tmp')) return null;
    if (top === 'office.json') return 'office';
    if (['inbox', 'approvals', 'projects', 'staff', 'tasks', 'mail'].includes(top)) return top;
    if (top === '.office' && sub === 'events.jsonl') return 'events';
    if (top === 'CLAUDE.md' || top === '.archive') return 'staff';
    return null;
  };
  let watcher = null, poll = null;
  function watch() {
    try {
      watcher = fs.watch(dir, { recursive: true }, (ev, name) => { const a = name && areaOf(String(name)); if (a) changed(a); });
    } catch { // older Node on Linux: no recursive watch, so check file times every 1.5 s
      const seen = new Map();
      const scan = () => {
        for (const top of ['office.json', 'inbox', 'approvals', 'projects', 'staff', 'tasks', 'mail', '.office/events.jsonl']) {
          let sig = '';
          const walk = (f, depth) => { try { const st = fs.statSync(f); sig += st.mtimeMs; if (st.isDirectory() && depth < 3) for (const n of fs.readdirSync(f)) walk(path.join(f, n), depth + 1); } catch { /* gone */ } };
          walk(path.join(dir, top), 0);
          if (seen.has(top) && seen.get(top) !== sig) changed(areaOf(top));
          seen.set(top, sig);
        }
      };
      scan(); poll = setInterval(scan, 1500);
    }
  }
  const beat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); pushStatus(); }, 25000); // also ages out stale work

  return {
    server,
    listen(p) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => { port = server.address().port; watch(); tasks.scan(); tasks.scanMail(); resolve(port);
          // office document tools: copied and (first time) installed in the background; tests skip it
          if (process.env.AI_OFFICE_NO_DOCTOOLS !== '1') DocTools.ensure(dir, (st) => broadcast('doctools', st)); });
      });
    },
    close() {
      chats.stopAll(); tasks.stopAll();
      clearInterval(beat); clearInterval(poll); if (watcher) watcher.close();
      for (const c of clients) c.end();
      return new Promise((r) => server.close(r));
    },
  };
}

// Start on the office port, or the next free one. If this office is already running there, reuse it.
async function start(dir, { port } = {}) {
  const cfg = O.loadCfg(dir);
  const first = port || cfg.port || 4747;
  for (let p = first; p < first + 20; p++) {
    if (await isThisOffice(p, cfg.key, dir)) return { port: p, already: true };
    const s = createServer(dir);
    try { const got = await s.listen(p); return { port: got, already: false, close: s.close }; } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error(`No free port between ${first} and ${first + 19}`);
}

function isThisOffice(port, key, dir) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/office', headers: { 'x-office-key': key, host: `localhost:${port}` }, timeout: 800 }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(res.statusCode === 200 && path.resolve(JSON.parse(s).folder) === path.resolve(dir)); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

module.exports = { createServer, start };
