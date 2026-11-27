// Reads and writes the office folder for the dashboard. The files stay the source of
// truth: Claude, scripts and the user can edit them too, and the dashboard follows.

const fs = require('fs');
const path = require('path');
const md = require('./md');
const T = require('./templates');
const D = require('./defaults');
const { slug, linkedFolders, repairSettings } = require('./generate');
const os = require('os');
const crypto = require('crypto');

class OfficeError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const ID = /^[a-z0-9][a-z0-9-]{0,60}$/; // staff and project folders
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/; // inbox and approval files
const check = (re, id, what) => { if (!re.test(String(id || ''))) throw new OfficeError(`Bad ${what} id`); return id; };

const p = (dir, ...a) => path.join(dir, ...a);
const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);
function write(f, text) { // write a temp file, then swap it in
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}
const pad = (n) => String(n).padStart(2, '0');
function localIso(d = new Date()) {
  const o = -d.getTimezoneOffset(), s = o >= 0 ? '+' : '-', a = Math.abs(o);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(a / 60 | 0)}:${pad(a % 60)}`;
}
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const today = () => localIso().slice(0, 10);
const oneLine = (s, max = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------------- office.json
const loadCfg = (dir) => JSON.parse(read(p(dir, 'office.json')));
function saveCfg(dir, cfg) { write(p(dir, 'office.json'), JSON.stringify(cfg, null, 2) + '\n'); }

// Floor plans for the 3D office (dashboard/office3d.js LAYOUTS). Anything else falls back to the first one.
const LAYOUTS = ['pinwheel', 'horseshoe', 'triads'];
const layoutOf = (cfg) => (LAYOUTS.includes(cfg.layout) ? cfg.layout : 'pinwheel');

function info(dir) {
  const cfg = loadCfg(dir);
  const { key, ...pub } = cfg; // never send the key back out
  return { ...pub, layout: layoutOf(cfg), archived: cfg.archived || [], folder: dir };
}

// ---------------------------------------------------------------- staff
const staffMd = (dir, id) => p(dir, 'staff', id, 'CLAUDE.md');
const agentFile = (dir, id) => p(dir, '.claude', 'agents', `${id}.md`);

// Model and effort picked on the Staff page (only known values are kept).
function runChoice(ch) {
  const out = {};
  if (ch.model != null) { if (!D.MODELS.some(([k]) => k === ch.model)) throw new OfficeError('Unknown model'); out.model = ch.model; }
  if (ch.effort != null) { if (!D.EFFORTS.some(([k]) => k === ch.effort)) throw new OfficeError('Unknown effort'); out.effort = ch.effort; }
  return out;
}
function updateManager(dir, ch) {
  const cfg = loadCfg(dir);
  cfg.pa = { ...cfg.pa, ...runChoice(ch) };
  saveCfg(dir, cfg);
  return info(dir);
}
// Generated files that embed the company name, active and archived. Nothing else is rewritten.
function companyFiles(dir) {
  const folders = (base) => (exists(p(dir, base)) ? fs.readdirSync(p(dir, base)).map((id) => p(dir, base, id, 'CLAUDE.md')) : []);
  const agents = (base) => (exists(p(dir, base)) ? fs.readdirSync(p(dir, base)).filter((f) => f.endsWith('.md')).map((f) => p(dir, base, f)) : []);
  return [p(dir, 'CLAUDE.md'), ...folders('staff'), ...folders('.archive/staff'), ...agents('.claude/agents'), ...agents('.archive/agents')];
}
// PUT /api/office: { company?, layout? }. Either or both. A company-only body changes nothing else.
function updateCompany(dir, ch) {
  const cfg = loadCfg(dir);
  if (ch.layout !== undefined) {
    if (!LAYOUTS.includes(ch.layout)) throw new OfficeError(`Unknown layout. Use one of: ${LAYOUTS.join(', ')}`);
    cfg.layout = ch.layout;
  }
  if (ch.company !== undefined || ch.layout === undefined) {
    const name = oneLine(ch.company, 80);
    if (!name) throw new OfficeError('Company name cannot be empty');
    const old = cfg.company;
    if (old && name !== old) {
      for (const f of companyFiles(dir)) {
        if (!exists(f)) continue;
        const text = read(f);
        if (text.includes(old)) write(f, text.split(old).join(name));
      }
    }
    cfg.company = name;
  }
  saveCfg(dir, cfg); // last: if a rewrite fails, office.json keeps the old name and a retry finishes the job
  return info(dir);
}
// What the Staff page offers, and what each person runs on now.
function runSettings(dir) {
  const cfg = loadCfg(dir);
  return { models: D.MODELS, efforts: D.EFFORTS, defaults: D.RUN,
    people: Object.fromEntries([['pa', T.runOpts(cfg, 'pa')], ...cfg.staff.map((s) => [s.id, T.runOpts(cfg, s.id)])]) };
}

function getStaff(dir, id) {
  check(ID, id, 'staff');
  const cfg = loadCfg(dir);
  const s = cfg.staff.find((x) => x.id === id);
  if (!s) throw new OfficeError('No such staff', 404);
  const text = exists(staffMd(dir, id)) ? read(staffMd(dir, id)) : '';
  return {
    ...s,
    job: md.section(text, 'What you do') || '',
    rules: md.bullets(md.section(text, 'Rules')),
    tools: md.section(text, 'Tools') || '',
    notes: (md.section(text, 'Notes') || '').replace(/^\(Things worth remembering[^)]*\)$/, ''), // placeholder = empty
    file: `staff/${id}/CLAUDE.md`,
  };
}

const listStaff = (dir) => loadCfg(dir).staff.map((s) => getStaff(dir, s.id));

function updateStaff(dir, id, ch) {
  const cur = getStaff(dir, id);
  const name = ch.name != null ? oneLine(ch.name, 40) : cur.name;
  const role = ch.role != null ? oneLine(ch.role, 60) : cur.role;
  if (!name || !role) throw new OfficeError('Name and role cannot be empty');
  let text = read(staffMd(dir, id));
  if (name !== cur.name || role !== cur.role) {
    text = text.replace(/^# .*$/m, `# ${name}, ${role}`)
      .replace(/^You are \*\*.*?\*\*, the .*? staff of /m, `You are **${name}**, the ${role} staff of `)
      .replace(new RegExp(`answer as ${cur.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), `answer as ${name}.`);
  }
  if (ch.job != null) text = md.setSection(text, 'What you do', ch.job);
  if (ch.rules != null) text = md.setSection(text, 'Rules', ch.rules.map((r) => oneLine(r)).filter(Boolean).map((r) => `- ${r}`).join('\n'));
  if (ch.notes != null) text = md.setSection(text, 'Notes', ch.notes || '(Things worth remembering about this job. Keep it short.)');
  let cmds = null;
  if (ch.commands != null || ch.customCommands != null || ch.docs != null) {
    const { PRESETS } = require('../office-files/guard');
    cmds = {
      docs: ch.docs != null ? !!ch.docs : cur.docs !== false, // Office documents: on unless turned off
      commands: (ch.commands ?? cur.commands ?? []).filter((k) => PRESETS[k] && k !== 'docs'),
      customCommands: (ch.customCommands ?? cur.customCommands ?? []).map((c) => oneLine(c, 80)).filter(Boolean),
    };
    const bad = cmds.customCommands.find((c) => !/^[A-Za-z0-9][\w ./:=@+-]*$/.test(c));
    if (bad) throw new OfficeError(`"${bad}" is not a plain command. Use letters, numbers, spaces and . / : - _ only.`);
    // keep the "Commands you may run" line in the Tools section in step
    const tools = (md.section(text, 'Tools') || '').split('\n').filter((l) => !/^- Commands you may run/.test(l));
    const line = T.commandsLine({ ...cur, ...cmds });
    const firstBlank = tools.findIndex((l, i) => i > 0 && !l.startsWith('- ') && !l.startsWith('  '));
    if (line) tools.splice(firstBlank < 0 ? tools.length : firstBlank, 0, line);
    text = md.setSection(text, 'Tools', tools.join('\n'));
  }
  write(staffMd(dir, id), text);

  if (exists(agentFile(dir, id))) {
    const job = md.section(text, 'What you do') || '';
    let a = read(agentFile(dir, id));
    a = a.replace(/^description: .*$/m, `description: ${name}, ${role}. ${oneLine(job)} Use for any ${role.toLowerCase()} task.`)
      .replace(/^You are .*?, the .*? staff of /m, `You are ${name}, the ${role} staff of `);
    if (cmds) { // the shell tool only for staff with commands turned on; any tools the user added stay
      const on = T.hasCommands(cmds);
      a = a.replace(/^tools: (.*)$/m, (m, list) => {
        const t = list.split(',').map((x) => x.trim()).filter((x) => x && x !== 'Bash');
        if (on) t.splice(Math.min(5, t.length), 0, 'Bash');
        return `tools: ${t.join(', ')}`;
      });
    }
    write(agentFile(dir, id), a);
  }
  const cfg = loadCfg(dir);
  const s = cfg.staff.find((x) => x.id === id);
  Object.assign(s, { name, role });
  if (ch.colour && /^#[0-9a-fA-F]{6}$/.test(ch.colour)) s.colour = ch.colour;
  if (ch.look && typeof ch.look === 'object') s.look = { scarf: !!ch.look.scarf, skin: ch.look.skin || D.LOOK.skin, hair: ch.look.hair || D.LOOK.hair };
  if (cmds) { s.commands = cmds.commands; s.customCommands = cmds.customCommands; if (cmds.docs) delete s.docs; else s.docs = false; }
  if (ch.tokless != null) s.tokless = !!ch.tokless;
  Object.assign(s, runChoice(ch));
  saveCfg(dir, cfg);
  if (exists(agentFile(dir, id))) { // the terminal's subagent runs on the same model
    const a = read(agentFile(dir, id)), line = `model: ${T.agentModel(cfg, id)}`;
    write(agentFile(dir, id), /^model: .*$/m.test(a) ? a.replace(/^model: .*$/m, line) : a.replace(/^(tools: .*)$/m, `$1\n${line}`));
  }
  if (ch.tokless != null && exists(agentFile(dir, id))) { // tokless tools on or off in the tools line; any others stay
    const on = T.wantsTokless(cfg, id);
    write(agentFile(dir, id), read(agentFile(dir, id)).replace(/^tools: (.*)$/m, (m, list) => {
      const t = list.split(',').map((x) => x.trim()).filter((x) => x && !T.TOKLESS_TOOLS.includes(x) && !T.TOKLESS_AGENT_TOOLS.includes(x));
      return `tools: ${[...t, ...(on ? T.TOKLESS_AGENT_TOOLS : [])].join(', ')}`;
    }));
  }
  updateTeam(dir);
  return getStaff(dir, id);
}

function addStaff(dir, a) {
  const cfg = loadCfg(dir);
  if (cfg.staff.length >= 8) throw new OfficeError('An office has at most 8 active staff. Archive one first.');
  const name = oneLine(a.name, 40), role = oneLine(a.role, 60), job = oneLine(a.job, 400);
  if (!name || !role || !job) throw new OfficeError('A new staff needs a name, a role and what they do');
  const taken = new Set([...cfg.staff, ...(cfg.archived || [])].map((s) => s.id).concat([slug(cfg.pa.name)]));
  let id = slug(name); if (['claude', 'explore', 'general-purpose', 'plan', 'pa'].includes(id)) id += '-staff';
  for (let n = 2, base = id; taken.has(id); n++) id = `${base}-${n}`;
  const def = D.STAFF.find((d) => d.name === name && d.role === role);
  const used = new Set(cfg.staff.map((s) => s.colour));
  const colour = a.colour || (D.STAFF.find((d) => !used.has(d.colour)) || D.STAFF[0]).colour;
  const s = { id, name, role, job, colour, rules: def ? def.rules : D.GENERIC_RULES, look: def ? def.look : { ...D.LOOK } };
  const full = { company: cfg.company, pa: cfg.pa, addons: cfg.addons, staff: [...cfg.staff, s] };
  const put = (f, t) => { if (!exists(f)) write(f, t); };
  put(staffMd(dir, id), T.staffClaude(full, s));
  put(p(dir, 'staff', id, '.claude', 'settings.json'), T.settingsJson(process.execPath, dir));
  put(agentFile(dir, id), T.agentMd(full, s));
  cfg.staff.push({ id, name, role, colour, look: s.look });
  saveCfg(dir, cfg);
  updateTeam(dir);
  return getStaff(dir, id);
}

// Archive keeps everything; the staff just stops getting work.
function archiveStaff(dir, id) {
  check(ID, id, 'staff');
  const cfg = loadCfg(dir);
  const i = cfg.staff.findIndex((s) => s.id === id);
  if (i < 0) throw new OfficeError('No such staff', 404);
  if (cfg.staff.length === 1) throw new OfficeError('The office needs at least one staff');
  moveIf(p(dir, 'staff', id), p(dir, '.archive', 'staff', id));
  moveIf(agentFile(dir, id), p(dir, '.archive', 'agents', `${id}.md`));
  const [s] = cfg.staff.splice(i, 1);
  (cfg.archived = cfg.archived || []).push({ ...s, archivedAt: today() });
  saveCfg(dir, cfg);
  updateTeam(dir);
  return { ok: true };
}

function reactivateStaff(dir, id) {
  check(ID, id, 'staff');
  const cfg = loadCfg(dir);
  const i = (cfg.archived || []).findIndex((s) => s.id === id);
  if (i < 0) throw new OfficeError('No such archived staff', 404);
  if (cfg.staff.length >= 8) throw new OfficeError('An office has at most 8 active staff. Archive one first.');
  moveIf(p(dir, '.archive', 'staff', id), p(dir, 'staff', id));
  moveIf(p(dir, '.archive', 'agents', `${id}.md`), agentFile(dir, id));
  const [{ archivedAt, ...s }] = cfg.archived.splice(i, 1);
  cfg.staff.push(s);
  saveCfg(dir, cfg);
  updateTeam(dir);
  return getStaff(dir, id);
}

function deleteStaff(dir, id, confirm) {
  check(ID, id, 'staff');
  if (confirm !== 'DELETE') throw new OfficeError('Type DELETE to confirm');
  const cfg = loadCfg(dir);
  const i = (cfg.archived || []).findIndex((s) => s.id === id);
  if (i < 0) throw new OfficeError('Only archived staff can be deleted', 404);
  fs.rmSync(p(dir, '.archive', 'staff', id), { recursive: true, force: true });
  fs.rmSync(p(dir, '.archive', 'agents', `${id}.md`), { force: true });
  cfg.archived.splice(i, 1);
  saveCfg(dir, cfg);
  return { ok: true };
}

function moveIf(from, to) {
  if (!exists(from)) return;
  if (exists(to)) throw new OfficeError(`Cannot move: ${path.relative(path.dirname(path.dirname(to)), to)} already exists`, 409);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

// Keep the team table in Hana's CLAUDE.md in step with the active staff.
function updateTeam(dir) {
  const f = p(dir, 'CLAUDE.md');
  if (!exists(f)) return;
  const text = read(f);
  const head = '| Staff id | Name | Role | What they do |\n|---|---|---|---|\n';
  const at = text.indexOf(head);
  if (at < 0) return; // the user rewrote it; leave it alone
  const start = at + head.length;
  let end = text.indexOf('\n\n', start); if (end < 0) end = text.length;
  const rows = listStaff(dir).map((s) => `| ${s.id} | ${s.name} | ${s.role} | ${oneLine(s.job)} |`).join('\n');
  write(f, text.slice(0, start) + rows + text.slice(end));
}

// ---------------------------------------------------------------- projects
function projectSummary(dir, id) {
  const f = p(dir, 'projects', id, 'CLAUDE.md');
  const text = exists(f) ? read(f) : '';
  const { fields, body } = md.parse(text);
  const title = (/^# (.+)$/m.exec(body) || [])[1] || id;
  const files = fs.readdirSync(p(dir, 'projects', id), { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && e.name !== 'CLAUDE.md').map((e) => e.name + (e.isDirectory() ? '/' : ''));
  const st = exists(f) ? fs.statSync(f) : fs.statSync(p(dir, 'projects', id));
  return { id, title, customer: fields.customer || '', status: fields.status || 'active', deadline: fields.deadline || '', linked: fields.linked || '',
    notes: md.bullets(md.section(body, 'Notes')), files, updated: st.mtime.toISOString(), folder: `projects/${id}/` };
}

function listProjects(dir) {
  const root = p(dir, 'projects');
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && ID.test(e.name))
    .map((e) => projectSummary(dir, e.name)).sort((a, b) => b.updated.localeCompare(a.updated));
}

function getProject(dir, id) {
  check(ID, id, 'project');
  if (!exists(p(dir, 'projects', id))) throw new OfficeError('No such project', 404);
  const f = p(dir, 'projects', id, 'CLAUDE.md');
  return { ...projectSummary(dir, id), text: exists(f) ? read(f) : '' };
}

function createProject(dir, a) {
  const title = oneLine(a.title, 80);
  if (!title) throw new OfficeError('A project needs a name');
  let id = slug(title); for (let n = 2, base = id; exists(p(dir, 'projects', id)); n++) id = `${base}-${n}`;
  const body = `# ${title}\n\nWhat they want: ${oneLine(a.what) || '(fill in)'}\n\n## Notes\n`;
  write(p(dir, 'projects', id, 'CLAUDE.md'), md.make({ customer: oneLine(a.customer, 80), status: 'active', deadline: oneLine(a.deadline, 20) }, body));
  return getProject(dir, id);
}

function updateProject(dir, id, ch) {
  const pr = getProject(dir, id);
  const f = {};
  if (ch.status != null) { if (!['active', 'waiting', 'done'].includes(ch.status)) throw new OfficeError('Status is active, waiting or done'); f.status = ch.status; }
  if (ch.deadline != null) f.deadline = oneLine(ch.deadline, 20);
  if (ch.customer != null) f.customer = oneLine(ch.customer, 80);
  if (ch.linked != null) f.linked = ch.linked ? checkFolder(dir, ch.linked) : '';
  write(p(dir, 'projects', id, 'CLAUDE.md'), md.setFields(pr.text || `# ${pr.title}\n`, f));
  if (ch.linked != null) repairSettings(dir);
  return getProject(dir, id);
}

function addProjectNote(dir, id, note) {
  const pr = getProject(dir, id);
  const line = oneLine(note, 400);
  if (!line) throw new OfficeError('Empty note');
  const { body } = md.parse(pr.text);
  const cur = md.section(body, 'Notes') || '';
  const text = md.setSection(pr.text || `# ${pr.title}\n`, 'Notes', `${cur}\n- ${line} (boss, ${today()})`);
  write(p(dir, 'projects', id, 'CLAUDE.md'), text);
  return getProject(dir, id);
}

// ---------------------------------------------------------------- inbox
const INBOX_TYPES = ['enquiry', 'lead', 'order', 'message'];
const INBOX_STATUS = ['new', 'working', 'waiting', 'done'];

function readItems(dir, folder) {
  const root = p(dir, folder);
  if (!exists(root)) return [];
  return fs.readdirSync(root).filter((n) => n.endsWith('.md') && FILE_ID.test(n.slice(0, -3))).map((n) => {
    const text = read(p(root, n));
    const { fields, body } = md.parse(text);
    return { id: n.slice(0, -3), ...fields, text: body.trim(), _raw: text };
  });
}

function listInbox(dir) {
  const items = readItems(dir, 'inbox').sort((a, b) => (a.received || a.id).localeCompare(b.received || b.id));
  // give each item a short ticket number once, written back so it stays the same
  let max = items.reduce((m, x) => Math.max(m, Number(x.ticket) || 0), 100);
  for (const x of items) {
    if (!Number(x.ticket)) { x.ticket = String(++max); write(p(dir, 'inbox', `${x.id}.md`), md.setFields(x._raw, { ticket: x.ticket })); }
  }
  return items.map(({ _raw, ...x }) => x).reverse();
}

function addInbox(dir, a) {
  const from = oneLine(a.from, 80), text = String(a.text || '').trim().slice(0, 5000);
  if (!from || !text) throw new OfficeError('An inbox item needs "from" and "text"');
  const type = INBOX_TYPES.includes(a.type) ? a.type : 'message';
  const source = oneLine(a.source, 30).toLowerCase() || 'manual';
  const max = readItems(dir, 'inbox').reduce((m, x) => Math.max(m, Number(x.ticket) || 0), 100);
  let id = `${stamp()}-${slug(from).slice(0, 30)}`;
  for (let n = 2, base = id; exists(p(dir, 'inbox', `${id}.md`)); n++) id = `${base}-${n}`;
  write(p(dir, 'inbox', `${id}.md`), md.make({ from, source, type, status: 'new', received: localIso(), assigned: '', ticket: max + 1 }, text));
  return listInbox(dir).find((x) => x.id === id);
}

function updateInbox(dir, id, ch) {
  check(FILE_ID, id, 'inbox');
  const f = p(dir, 'inbox', `${id}.md`);
  if (!exists(f)) throw new OfficeError('No such inbox item', 404);
  const set = {};
  if (ch.status != null) { if (!INBOX_STATUS.includes(ch.status)) throw new OfficeError('Unknown status'); set.status = ch.status; }
  if (ch.assigned != null) {
    const cfg = loadCfg(dir);
    if (ch.assigned && !cfg.staff.some((s) => s.id === ch.assigned)) throw new OfficeError('No such staff');
    set.assigned = ch.assigned;
  }
  write(f, md.setFields(read(f), set));
  return listInbox(dir).find((x) => x.id === id);
}

// ---------------------------------------------------------------- approvals
function listApprovals(dir) {
  // note: what the boss said when deciding (decideApproval adds it as a last "Boss: ..." line)
  return readItems(dir, 'approvals').map(({ _raw, text, ...x }) => ({ ...x, details: text, note: x.status && x.status !== 'pending' ? ((/(?:^|\n)Boss: ([^\n]*)$/.exec(text) || [])[1] || '').trim() : '', status: x.status || 'pending' }))
    .sort((a, b) => (b.created || b.id).localeCompare(a.created || a.id));
}

function getApproval(dir, id) {
  check(FILE_ID, id, 'approval');
  const a = listApprovals(dir).find((x) => x.id === id);
  if (!a) throw new OfficeError('No such approval', 404);
  return a;
}

function addApproval(dir, a) {
  const from = oneLine(a.from, 40), action = oneLine(a.action, 200);
  if (!from || !action) throw new OfficeError('An approval needs "from" and "action"');
  let id = `${stamp()}-${slug(from).slice(0, 20)}-${slug(action).slice(0, 30)}`;
  for (let n = 2, base = id; exists(p(dir, 'approvals', `${id}.md`)); n++) id = `${base}-${n}`;
  // optional: the exact add-on call this approval is for (see OFFICE.md), so the office can run it once approved
  const { ASK_FIRST } = require('../office-files/guard');
  const tool = oneLine(a.tool, 80).split('__').pop(); // mcp__<server>__send_quotation_email -> send_quotation_email
  if (tool && !Object.keys(ASK_FIRST).some((t) => t.endsWith(`__${tool}`))) throw new OfficeError(`"${tool}" is not an action that needs approval`);
  let input = '';
  if (tool) { try { input = JSON.stringify(typeof a.input === 'string' ? JSON.parse(a.input) : a.input || {}); } catch { throw new OfficeError('"input" must be JSON'); } }
  // optional: a staff's plan for a task (plan: yes), which the office runs once approved (lib/tasks.js)
  const plan = !tool && a.kind === 'plan' && FILE_ID.test(String(a.task || '')) ? { kind: 'plan', task: a.task } : {};
  write(p(dir, 'approvals', `${id}.md`), md.make({ from, action, ...(tool ? { tool, input } : {}), ...plan, project: oneLine(a.project, 60), status: 'pending', created: localIso(), decided: '' },
    String(a.details || '').trim().slice(0, 5000)));
  return getApproval(dir, id);
}

function decideApproval(dir, id, decision, note) {
  const a = getApproval(dir, id);
  if (!['approved', 'rejected'].includes(decision)) throw new OfficeError('Decision is approved or rejected');
  if (a.status !== 'pending') throw new OfficeError(`Already ${a.status}`, 409);
  const f = p(dir, 'approvals', `${id}.md`);
  let text = md.setFields(read(f), { status: decision, decided: localIso() });
  if (oneLine(note)) text = `${text.replace(/\s+$/, '')}\n\nBoss: ${oneLine(note, 1000)}\n`;
  write(f, text);
  // An approved add-on action: the boss's OK goes where staff cannot write from the dashboard.
  // The guard checks it and uses it up (one OK, one action).
  if (decision === 'approved' && a.tool) {
    const gf = p(dir, '.office', 'grants.json');
    let grants = []; try { grants = JSON.parse(read(gf)); } catch { /* first one */ }
    let input = {}; try { input = JSON.parse(a.input || '{}'); } catch { /* bad JSON: matches nothing */ input = { invalid: true }; }
    const cfg = loadCfg(dir);
    const who = cfg.staff.find((s) => s.id === a.from || s.name.toLowerCase() === String(a.from || '').toLowerCase());
    grants.push({ id, from: who ? who.id : a.from, tool: a.tool, input, action: a.action, at: new Date().toISOString(), used: null });
    write(gf, JSON.stringify(grants.slice(-500), null, 2) + '\n');
  }
  addEvent(dir, { ev: 'Approval', staff: a.from, msg: `Boss ${decision}: ${a.action}` });
  return getApproval(dir, id);
}

// ---------------------------------------------------------------- add-on actions
// Ask-first add-on actions and the boss's choice for each: ask first (default) or always allow.
function listActions(dir) {
  const cfg = loadCfg(dir);
  const { ASK_FIRST } = require('../office-files/guard');
  const seen = new Set();
  return Object.entries(ASK_FIRST).filter(([, r]) => cfg.addons && cfg.addons[r.addon] && cfg.addons[r.addon].enabled)
    .map(([tool, r]) => { const short = tool.split('__').pop(); return { addon: r.addon, tool: short, label: r.label, always: (cfg.addons[r.addon].always || []).includes(short) }; })
    .filter((x) => !seen.has(x.tool) && seen.add(x.tool));
}

function setAction(dir, a) {
  const cfg = loadCfg(dir);
  const hit = listActions(dir).find((x) => x.tool === a.tool);
  if (!hit) throw new OfficeError('No such action', 404);
  const ad = cfg.addons[hit.addon];
  const set = new Set(ad.always || []);
  if (a.always === true) set.add(hit.tool); else set.delete(hit.tool);
  ad.always = [...set];
  saveCfg(dir, cfg);
  addEvent(dir, { ev: 'Setting', msg: `Boss set "${hit.label}" to ${a.always === true ? 'Always allow' : 'Ask me first'}` });
  return listActions(dir);
}

// ---------------------------------------------------------------- linked folders
// Folders outside the office that staff may use. Anything else on the computer stays off limits.
function checkFolder(dir, raw) {
  const f = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!f || !path.isAbsolute(f)) throw new OfficeError('Give the full folder path, for example D:\\Kedai Ali\\website or /Users/ali/website');
  const abs = path.resolve(f);
  if (!exists(abs) || !fs.statSync(abs).isDirectory()) throw new OfficeError('That folder does not exist on this computer');
  const home = path.resolve(os.homedir());
  if (abs === path.parse(abs).root || abs === home) throw new OfficeError('That is too wide (a whole drive or your home folder). Link the one folder staff need.');
  const office = path.resolve(dir);
  if (office === abs || office.startsWith(abs + path.sep)) throw new OfficeError('That folder contains the office itself. Link a folder inside it instead.');
  return abs;
}
function listLinked(dir) {
  const raw = loadCfg(dir).linked || [];
  const live = new Set(linkedFolders(dir).map((l) => path.resolve(l.path)));
  const projects = listProjects(dir).filter((x) => x.linked).map((x) => ({ path: x.linked, label: x.title, project: x.id, ok: live.has(path.resolve(x.linked)) }));
  return [...raw.map((l) => ({ path: l.path, label: l.label || '', project: '', ok: live.has(path.resolve(l.path)) })), ...projects];
}
function addLinked(dir, a) {
  const abs = checkFolder(dir, a.path);
  const cfg = loadCfg(dir);
  cfg.linked = (cfg.linked || []).filter((l) => path.resolve(l.path) !== abs);
  cfg.linked.push({ path: abs, label: oneLine(a.label, 60) || path.basename(abs) });
  saveCfg(dir, cfg);
  repairSettings(dir);
  return listLinked(dir);
}
function removeLinked(dir, raw) {
  const cfg = loadCfg(dir);
  const abs = path.resolve(String(raw || ''));
  cfg.linked = (cfg.linked || []).filter((l) => path.resolve(l.path) !== abs);
  saveCfg(dir, cfg);
  repairSettings(dir);
  return listLinked(dir);
}

// ---------------------------------------------------------------- clean up (after testing)
// Clears only what the boss picked. Never touches the office setup: office.json, CLAUDE.md,
// OFFICE.md, .claude/, staff CLAUDE.md files and their settings, .office/hook.js.
const CLEAN = ['activity', 'chats', 'summaries', 'inbox', 'approvals', 'projects', 'staffFiles', 'tasks'];
function cleanup(dir, items, confirm) {
  if (confirm !== 'CLEAR') throw new OfficeError('Type CLEAR to confirm');
  const pick = new Set((items || []).filter((x) => CLEAN.includes(x)));
  if (!pick.size) throw new OfficeError('Pick at least one thing to clear');
  const cfg = loadCfg(dir);
  const emptyDir = (rel, keep = () => false) => {
    const d = p(dir, rel); if (!exists(d)) return 0;
    let n = 0;
    for (const e of fs.readdirSync(d)) { if (keep(e)) continue; fs.rmSync(p(d, e), { recursive: true, force: true }); n++; }
    return n;
  };
  const done = {};
  if (pick.has('activity')) { fs.mkdirSync(p(dir, '.office'), { recursive: true }); fs.writeFileSync(p(dir, '.office', 'events.jsonl'), ''); done.activity = true; }
  if (pick.has('chats')) done.chats = emptyDir('.office/chats');
  if (pick.has('summaries')) { write(p(dir, '.office', 'staff-chats.md'), T.staffChatsMd(cfg)); done.summaries = true; }
  if (pick.has('inbox')) done.inbox = emptyDir('inbox');
  if (pick.has('approvals')) done.approvals = emptyDir('approvals');
  if (pick.has('projects')) done.projects = emptyDir('projects');
  if (pick.has('tasks')) { // a plan waiting for the boss goes with its task: close its approval item first
    for (const a of listApprovals(dir)) if (a.kind === 'plan' && a.status === 'pending') try { decideApproval(dir, a.id, 'rejected', 'The task was cleared.'); } catch { /* removed meanwhile */ }
    done.tasks = emptyDir('tasks');
  }
  if (pick.has('staffFiles')) { // work files staff made; their job description and settings stay
    done.staffFiles = cfg.staff.reduce((n, s) => n + emptyDir(`staff/${s.id}`, (e) => e === 'CLAUDE.md' || e === '.claude'), 0);
  }
  return { ok: true, cleared: done };
}

// ---------------------------------------------------------------- events
function addEvent(dir, a) {
  const line = { at: new Date().toISOString(), ev: oneLine(a.ev, 30) || 'Extension', staff: oneLine(a.staff, 40) || undefined, msg: oneLine(a.msg, 500) };
  if (!line.msg) throw new OfficeError('An event needs "msg"');
  fs.mkdirSync(p(dir, '.office'), { recursive: true });
  fs.appendFileSync(p(dir, '.office', 'events.jsonl'), JSON.stringify(line) + '\n');
  return line;
}

// ---------------------------------------------------------------- open a file from a chat
// The boss clicks a file path in a chat: open it like a double-click. Only inside the office or a
// linked folder, only if it exists. Documents and pictures open in their app; anything else (a
// program or script) is only shown in its folder, never run.
const OPEN_EXT = new Set(['html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'txt', 'md', 'csv', 'json', 'log',
  'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'rtf', 'mp4', 'mov', 'mp3', 'wav', 'm4a']);
function resolveOpen(dir, raw) {
  const s = String(raw || '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!s) throw new OfficeError('No file given');
  const abs = path.resolve(dir, s);
  const roots = [path.resolve(dir), ...listLinked(dir).map((l) => path.resolve(l.path))];
  const sep = path.sep, low = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  if (!roots.some((r) => low(abs) === low(r) || low(abs).startsWith(low(r) + sep))) throw new OfficeError('That file is outside the office and its linked folders', 403);
  if (!exists(abs)) throw new OfficeError('That file is not there (moved or deleted?)', 404);
  if (fs.statSync(abs).isDirectory()) return { path: abs, how: 'folder' };
  return { path: abs, how: OPEN_EXT.has(path.extname(abs).slice(1).toLowerCase()) ? 'open' : 'reveal' };
}

// Pasted or dropped chat images: kept in attachments/. The type is taken from the bytes, never from the name or the client.
const IMG_MAX = 10 * 1024 * 1024;
const IMG_KINDS = {
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', magic: (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};
function saveAttachment(dir, { type, data } = {}) {
  const kind = IMG_KINDS[type];
  if (!kind) throw new OfficeError('Only PNG, JPEG, GIF or WebP images', 415);
  if (typeof data !== 'string' || !data) throw new OfficeError('No image sent');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > IMG_MAX) throw new OfficeError('Image is bigger than 10 MB', 413);
  if (!kind.magic(buf)) throw new OfficeError('That is not a PNG, JPEG, GIF or WebP image', 415);
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const name = `${stamp}-${crypto.randomBytes(2).toString('hex')}.${kind.ext}`;
  fs.mkdirSync(p(dir, 'attachments'), { recursive: true });
  const file = p(dir, 'attachments', name);
  fs.writeFileSync(file, buf, { flag: 'wx' });
  return { name, path: file }; // absolute: a staff run works in staff/<id>/, so a relative path would not resolve there
}

module.exports = {
  OfficeError, info, loadCfg, resolveOpen, saveAttachment, updateManager, updateCompany, runSettings,
  listStaff, getStaff, updateStaff, addStaff, archiveStaff, reactivateStaff, deleteStaff,
  listProjects, getProject, createProject, updateProject, addProjectNote,
  listInbox, addInbox, updateInbox,
  listApprovals, getApproval, addApproval, decideApproval, listActions, setAction,
  addEvent, cleanup, CLEAN,
  listLinked, addLinked, removeLinked,
};
