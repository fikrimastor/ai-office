// AI Office dashboard. Plain JS, no build step. Every change goes through the local
// API to the office files; the server tells us when files change (Claude may edit them too).
import { icon } from './icons.js';
import { portrait } from './avatar.js';
import { markdown } from './markdown.js';

const KEY = document.querySelector('meta[name="office-key"]').content;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// Add-on cards (ids match lib/defaults.js ADDONS; the browser cannot load that file). Invois keeps its icon and wording.
const ADDON_CARDS = [
  { id: 'invois-online', name: 'invois.online', chip: 'Invois', title: 'Invois Online', img: 'assets/invois-icon.png',
    about: 'Real quotations, invoices and payments for your sales and finance staff. Made by the team behind AI Office.',
    login: 'log in to invois.online', off: `Free plan: 60 documents a month. To connect, ask Claude in the office folder: <i>"connect the invois.online MCP for my sales and finance staff"</i>.`,
    btn: ['Create free account', 'https://invois.online/?ref=ai-office'] },
  { id: 'github', name: 'GitHub', chip: 'GitHub', title: 'GitHub', about: 'Read code, issues and pull requests for your engineers, architect and QA. Read only for now.',
    login: 'log in to GitHub', off: 'To connect, ask Claude in the office folder: <i>"connect the GitHub MCP for my engineers"</i>.', btn: ['About the GitHub MCP', 'https://github.com/github/github-mcp-server'] },
  { id: 'figma', name: 'Figma', chip: 'Figma', title: 'Figma', about: 'Your designer works in Figma; engineers and the architect read the designs.',
    login: 'log in to Figma', off: 'To connect, ask Claude in the office folder: <i>"connect the Figma MCP for my designer"</i>.', btn: ['Open Figma', 'https://www.figma.com/'] },
  { id: 'context7', name: 'Context7', chip: 'Context7', title: 'Context7', about: 'Current library documentation for every staff, so they use real APIs. Read only, no login needed.',
    off:'To connect, ask Claude in the office folder: <i>"connect the Context7 MCP for my staff"</i>.', btn: ['About Context7', 'https://context7.com/'] },
];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SWATCH = ['#FF6B6B', '#FF9F1C', '#2EC4B6', '#3A86FF', '#06D6A0', '#F15BB5', '#8D6E63', '#118AB2', '#8338EC', '#E0524F'];
const SKINS = ['#F7D7B5', '#F3C7A2', '#F0C8A0', '#EDB98A', '#E3AE7C', '#C98E5E', '#A8724A', '#7A4E2E'];
const HAIRS = ['#1A1A1A', '#2B2233', '#6B4423', '#A0522D', '#C9A26B', '#8D93A5'];
const swatch = (c, what, on) => `<i style="background:${c}" data-v="${c}" class="${on ? 'on' : ''}" role="button" tabindex="0" aria-label="${what} ${c}" aria-pressed="${on}"></i>`;

async function api(path, method = 'GET', body) {
  const res = await fetch(`/api/${path}`, {
    method, headers: { 'X-Office-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ state
const S = {
  office: null, staff: [], projects: [], inbox: [], approvals: [],
  view: 'office', staffSeg: 'active', settings: 'general',
  sel: { staff: null, project: null, inbox: null },
  okOpen: false, dirty: new Set(), project: null,
  status: { people: {}, banner: null },
};
const views = ['office', 'staff', 'projects', 'inbox', 'settings'];

async function load(areas = ['office', 'staff', 'projects', 'inbox', 'approvals']) {
  const map = { office: 'office', staff: 'staff', projects: 'projects', inbox: 'inbox', approvals: 'approvals' };
  areas = areas.filter((a) => map[a]); // tasks and mail have their own handlers: no /api/undefined
  await Promise.all(areas.map(async (a) => { S[a] = await api(map[a]); }));
  if (areas.includes('projects') && S.sel.project) S.project = await api(`projects/${encodeURIComponent(S.sel.project)}`).catch(() => null);
}

// ------------------------------------------------------------------ helpers
const pa = () => S.office.pa;
const staffById = (id) => S.staff.find((s) => s.id === id) || (S.office.archived || []).find((s) => s.id === id);
const av = (s, cls = '') => `<span class="av ${cls}">${portrait(s.colour, s.look)}</span>`;
const paAv = () => av({ colour: pa().colour, look: pa().look || { scarf: true, skin: '#F2C9A0' } });
const MGR = '<span class="mgr" title="Manager: oversees all staff"><img src="assets/emoji/star.png" alt="">Manager</span>';
const nameOf = (id) => (id === 'boss' ? 'You' : (staffById(id) || {}).name || id || '');
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return esc(iso);
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
let toastT;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast on${err ? ' err' : ''}`;
  (err ? $('#liveErr') : $('#live')).textContent = msg; // screen readers: the toast is not a live region itself
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, err ? 5000 : 2200);
}
async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); throw e; }
}
// One close path for every way out (Cancel, Escape, backdrop click): focus goes back to whatever opened the dialog.
let modalOpener = null;
function closeModal() {
  const m = $('#modal'); if (!m.classList.contains('on')) return;
  m.classList.remove('on');
  const o = modalOpener; modalOpener = null;
  if (o && o.isConnected) o.focus({ preventScroll: true });
}
function modal(html, wire) {
  if (!$('#modal').classList.contains('on')) modalOpener = document.activeElement;
  const box = $('#mbox');
  box.innerHTML = html; $('#modal').classList.add('on');
  const h = $('.mh b', box);
  if (h) { h.id = 'mTitle'; box.setAttribute('aria-labelledby', 'mTitle'); } else box.removeAttribute('aria-labelledby');
  $$('[data-close]', box).forEach((b) => { b.onclick = closeModal; });
  wire && wire(closeModal);
  const first = $('input,textarea', box) || $('button:not([disabled])', box); first && first.focus();
}
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (!$('#modal').classList.contains('on')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
  if (e.key !== 'Tab') return;
  // keep Tab inside the dialog: wrap at both ends, and pull focus back in if it strayed
  const box = $('#mbox');
  const f = $$('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])', box);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1], at = document.activeElement;
  if (e.shiftKey && (at === first || !box.contains(at))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (at === last || !box.contains(at))) { e.preventDefault(); first.focus(); }
});

// Keys for clickable cards, rows and chat heads (they are divs or rows, not buttons): Enter and Space click them.
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches('[role="button"][tabindex="0"], tr[tabindex="0"]')) return;
  e.preventDefault(); e.target.click();
});

// Drawing a list again replaces its elements, which drops keyboard focus. Put focus back on the element
// with the same data-* attributes (a tab, a chat head, a row, a button in a list).
const dataKey = (x) => [...x.attributes].filter((y) => y.name.startsWith('data-')).map((y) => `${y.name}=${y.value}`).join('|');
function redraw(el, html) {
  const a = document.activeElement, key = a && a !== el && el.contains(a) ? dataKey(a) : '';
  el.innerHTML = html;
  const n = key && [...el.querySelectorAll('*')].find((x) => dataKey(x) === key);
  if (n) n.focus({ preventScroll: true });
}

// Each label.lbl gets the field right after it (group labels such as swatches are left alone).
let labelSeq = 0;
function labelControls(root = document) {
  $$('label.lbl:not([for])', root).forEach((l) => {
    const c = l.nextElementSibling;
    if (!c || !/^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName)) return;
    if (!c.id) c.id = `field-${++labelSeq}`;
    l.htmlFor = c.id;
  });
}
for (const el of [$('#views'), $('#mbox'), $('#okDrawer')]) new MutationObserver(() => labelControls(el)).observe(el, { childList: true, subtree: true });

// Resizable split panes; the fixed pane's width is remembered.
function wireSplits(root) {
  $$('.gutter', root).forEach((g) => {
    const pane = g.dataset.side === 'prev' ? g.previousElementSibling : g.nextElementSibling;
    const key = `aio.pane.${g.dataset.key}`;
    const saved = Number(localStorage.getItem(key)); if (saved) pane.style.flexBasis = `${saved}px`;
    g.onpointerdown = (e) => {
      const x0 = e.clientX, w0 = pane.getBoundingClientRect().width, dir = g.dataset.side === 'prev' ? 1 : -1;
      g.setPointerCapture(e.pointerId); g.classList.add('drag'); document.body.classList.add('dragging');
      g.onpointermove = (ev) => { const w = Math.max(220, Math.min(760, w0 + dir * (ev.clientX - x0))); pane.style.flexBasis = `${w}px`; };
      g.onpointerup = () => { g.onpointermove = null; g.classList.remove('drag'); document.body.classList.remove('dragging'); localStorage.setItem(key, parseInt(pane.style.flexBasis, 10)); };
    };
  });
}

// ------------------------------------------------------------------ top bar + routing
function renderTop() {
  $('#company').textContent = S.office.company;
  document.title = `${S.office.company}: AI Office`;
  const newIn = S.inbox.filter((x) => x.status === 'new').length;
  const activeP = S.projects.filter((p) => p.status !== 'done').length;
  const tabs = [['office', 'layout-grid', 'Office', ''], ['staff', 'users', 'Staff', S.staff.length],
    ['projects', 'folder', 'Projects', activeP || ''], ['inbox', 'inbox', 'Inbox', newIn || '']];
  redraw($('#tabs'), tabs.map(([v, ic, label, n]) => `<button class="tab ${S.view === v ? 'on' : ''}" data-go="${v}" aria-label="${label}" title="${label}">${icon(ic)}<span class="tl">${label}</span>${n !== '' ? ` <span class="n ${v === 'inbox' ? 'warn' : ''}">${n}</span>` : ''}</button>`).join(''));
  const st = Object.entries(S.status.people).filter(([k]) => k !== 'pa').map(([, x]) => x); // staff only, like the work board
  const cnt = (k) => st.filter((x) => x.status === k).length;
  $('#stat').innerHTML = `<span class="d working" style="background:#4ADE80"></span><b>${cnt('working')}</b><span class="tl"> working</span> <span class="d" style="background:rgba(255,255,255,.55);margin-left:8px"></span><b>${cnt('sleeping')}</b><span class="tl"> sleeping</span>${cnt('waiting') ? ` <span class="d" style="background:#FFB020;margin-left:8px"></span><b>${cnt('waiting')}</b><span class="tl"> waiting</span>` : ''}`;
  $('#stat').title = 'Staff working now (not counting the manager)';
  $('#where').textContent = location.host;
  $('#gear').innerHTML = icon('settings');
}

function renderSub() {
  const t = {
    office: `<span class="livebadge"><i class="d working"></i>Live</span><span class="legend2"><span><i class="d working"></i>Working</span><span><i class="d sleeping"></i>Sleeping</span><span><i class="d waiting"></i>Waiting for OK</span></span>
      <span class="faint hint" style="margin-left:10px">Click anyone to chat. Drag to move, scroll to zoom.</span>
      <div class="zoom"><button class="ibtn" id="zOut" title="Zoom out" aria-label="Zoom out">${icon('minus')}</button><span id="zPct">${Math.round(V.zoom * 100)}%</span><button class="ibtn" id="zIn" title="Zoom in" aria-label="Zoom in">${icon('plus')}</button><button class="ibtn" id="zFit" title="Fit to screen" aria-label="Fit to screen">${icon('maximize')}</button></div><button class="okbtn" id="okStat"></button>`,
    staff: `<b>Team</b><span class="muted">${esc(pa().name)} + ${S.staff.length} staff. Changes save to each staff's CLAUDE.md.</span>`,
    projects: `<b>Projects</b><span class="muted">One folder per project, each with its own notes that staff read before working.</span>`,
    inbox: `<b>Inbox</b><span class="muted">Customer requests waiting for your team. One file each in inbox/.</span>`,
    settings: `<b>Settings</b><span class="muted">Saved in office.json in your office folder.</span>`,
  };
  const hadPillFocus = document.activeElement?.id === 'okStat'; // the pill is rebuilt on each render: keep keyboard focus on it
  $('#sub').innerHTML = t[S.view];
  if (hadPillFocus) $('#okStat')?.focus();
  if (S.view === 'office') {
    $('#zIn').onclick = () => zoomAt(V.zoom * 1.25);
    $('#zOut').onclick = () => zoomAt(V.zoom / 1.25);
    $('#zFit').onclick = () => { V.zoom = 1; V.panX = 0; V.panY = 0; fitOffice(true); };
  }
}

function go(view) {
  if (!views.includes(view)) view = 'office';
  S.view = view;
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  render();
}

function render() {
  renderTop(); renderSub();
  const main = $('#views');
  if (!$('.view', main)) main.innerHTML = views.map((v) => `<section class="view" id="v-${v}"></section>`).join('');
  $$('.view', main).forEach((el) => el.classList.toggle('on', el.id === `v-${S.view}`));
  ({ office: renderOffice, staff: renderStaff, projects: renderProjects, inbox: renderInbox, settings: renderSettings })[S.view]();
  renderOk();
  renderChats();
  renderUsage();
}

// ------------------------------------------------------------------ office: live 3D office
// View (zoom, drag) is kept for this tab, so a normal refresh keeps it; a hard refresh
// (Ctrl+Shift+R) or a new tab starts at the default: zoomed in a little.
const VKEY = 'aio.view';
if ($('meta[name="fresh"]').content === '1') sessionStorage.removeItem(VKEY);
const firstVisit = !sessionStorage.getItem(VKEY);
const V = Object.assign({ zoom: 1.4, panX: 0, panY: 0, open: ['pa'], min: [] }, JSON.parse(sessionStorage.getItem(VKEY) || '{}'));
if (firstVisit && innerWidth < 1200) V.min = ['pa']; // narrow screens: the manager chat starts as a bar so it does not cover the page
const saveView = () => sessionStorage.setItem(VKEY, JSON.stringify(V));
let office3d = null, scene = null, sceneKey = '', building = false, again = false;

function renderOffice() {
  const v = $('#v-office');
  if (!$('#officeWrap', v)) {
    v.innerHTML = `<div class="officeWrap live" id="officeWrap"><div id="termBar"></div>
      <div class="officeStage" id="officeStage"></div><div class="loading" id="oLoad">Opening the office...</div></div>`;
    wireOffice();
  }
  const b = S.status.banner;
  document.body.classList.toggle('term', !!b);
  $('#termBar').innerHTML = b ? `<div class="termbar">${icon('circle-alert')}${esc(nameOf(b.who === 'pa' ? '' : b.who) || pa().name)} needs you in the terminal: ${esc(b.msg)}</div>` : '';
  renderOkButton();
  draw3d();
}

// "Siti: quote for Kedai Ali" -> "Quote for Kedai Ali" (the tag already shows the name)
function taskText(id, t) {
  const n = id === 'pa' ? pa().name : (staffById(id) || {}).name;
  const out = n && t ? t.replace(new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:,-]\\s*`, 'i'), '') : t || '';
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// Rebuild the 3D office only when something it shows has changed.
async function draw3d() {
  const open = S.inbox.filter((x) => x.status !== 'done').sort((a, b) => Number(a.ticket) - Number(b.ticket));
  const opts = {
    company: S.office.company,
    layout: S.office.layout || 'pinwheel', // a change rebuilds the scene (the layout is part of the scene key)
    pa: { name: pa().name, colour: pa().colour, look: pa().look || { scarf: true, skin: '#F2C9A0' } },
    staff: S.staff.map(({ id, name, role, colour, look }) => ({ id, name, role, colour, look })),
    status: Object.fromEntries(Object.entries(S.status.people).map(([k, x]) => [k, { status: x.status, task: (x.status === 'working' && ((S.tasks || []).find((t) => t.staff === k) || {}).step) || taskText(k, x.task) }])),
    queue: open.slice(0, 3).map((x) => ({ text: (x.text || '').split('\n')[0], ticket: x.ticket })),
    queueCount: open.length,
  };
  const { status, queue, queueCount, ...layout } = opts;
  const key = JSON.stringify(layout); // people or company: a rebuild. Status and the queue: the live scene updates.
  if (key === sceneKey) { if (scene && !building) { scene.setStatus(status); scene.setQueue(queue, queueCount); walks(); } return; }
  if (building) { again = true; return; }
  building = true; sceneKey = key;
  try {
    office3d = office3d || await import('./office3d.js');
    const inner = document.createElement('div');
    const r = await office3d.renderOffice(inner, { ...opts, width: 900, dpr: pixelRatio(scene ? stageScale() : 1.6), onRestore: () => { sceneKey = ''; draw3d(); } });
    const stage = $('#officeStage'); if (!stage) return;
    if (scene) scene.dispose();
    stage.replaceChildren(inner); scene = r;
    prevPeople = null; walks();
    stage.style.width = `${r.width}px`; stage.style.height = `${r.height}px`;
    $$('.tag[data-id]', inner).forEach((t) => { t.onclick = () => openChat(t.dataset.id); t.tabIndex = 0; t.setAttribute('role', 'button'); });
    const l = $('#oLoad'); if (l) l.remove();
    fitOffice();
  } catch (e) {
    console.error(e);
    const l = $('#oLoad'); if (l) l.textContent = 'This browser cannot show the 3D office. Everything else works.';
  } finally {
    building = false;
    if (again) { again = false; draw3d(); }
  }
}

// Someone starts a task Hana handed out: she walks over. Someone finishes: they walk to her and report.
let prevPeople = null;
function walks() {
  const now = S.status.people;
  const handed = (x) => x && x.status === 'working' && x.task !== 'Talking with you';
  if (prevPeople && scene && S.view === 'office') {
    for (const s of S.staff) {
      const a = prevPeople[s.id], b = now[s.id];
      if (!handed(a) && handed(b) && now.pa && now.pa.status === 'working') scene.delegate(s.id);
      if (handed(a) && (!b || b.status !== 'working')) scene.report(s.id);
    }
  }
  prevPeople = JSON.parse(JSON.stringify(now));
}

// The office is drawn at the size it is shown (zoom x screen sharpness), capped: no bigger buffer than needed.
const pixelRatio = (k) => Math.max(1, Math.min(2.5, Math.round(k * (window.devicePixelRatio || 1) * 4) / 4));
function stageScale() {
  const wrap = $('#officeWrap'); if (!scene || !wrap || !wrap.offsetWidth) return 1.6;
  return Math.min(wrap.clientWidth / scene.width, wrap.clientHeight / scene.height) * 0.94 * V.zoom;
}
let prTimer = null;
function fitOffice(animate) {
  const stage = $('#officeStage'), wrap = $('#officeWrap');
  if (!stage || !scene || !wrap.offsetWidth) return;
  const k = stageScale(), occ = ($('#wins') || {}).offsetWidth || 0;
  const shift = occ ? -Math.min(occ / 3, Math.max(0, (wrap.clientWidth - scene.width * k) / 2)) : 0; // never off the left edge
  stage.style.transition = animate ? 'transform .25s ease' : 'none';
  stage.style.transform = `translate(calc(-50% + ${(V.panX + shift).toFixed(1)}px), calc(-50% + ${V.panY.toFixed(1)}px)) scale(${k.toFixed(4)})`;
  const pct = $('#zPct'); if (pct) pct.textContent = `${Math.round(V.zoom * 100)}%`;
  clearTimeout(prTimer); prTimer = setTimeout(() => { if (scene) scene.setPixelRatio(pixelRatio(stageScale())); }, 300);
  saveView();
}
function zoomAt(z, cx, cy) { // keep the point under the cursor still
  const r = $('#officeWrap').getBoundingClientRect();
  const nz = Math.max(0.5, Math.min(4, z)); if (nz === V.zoom) return;
  const ox = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2) - V.panX, oy = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2) - V.panY;
  V.panX -= ox * (nz / V.zoom - 1); V.panY -= oy * (nz / V.zoom - 1); V.zoom = nz; fitOffice();
}
function wireOffice() {
  const wrap = $('#officeWrap');
  wrap.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(V.zoom * Math.pow(1.0015, -e.deltaY), e.clientX, e.clientY); }, { passive: false });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tag[data-id],.okbtn,.termbar')) return;
    const sx = e.clientX - V.panX, sy = e.clientY - V.panY;
    wrap.setPointerCapture(e.pointerId); wrap.classList.add('panning');
    const mv = (ev) => { V.panX = ev.clientX - sx; V.panY = ev.clientY - sy; fitOffice(); };
    const up = () => { wrap.classList.remove('panning'); wrap.removeEventListener('pointermove', mv); wrap.removeEventListener('pointerup', up); };
    wrap.addEventListener('pointermove', mv); wrap.addEventListener('pointerup', up);
  });
  new ResizeObserver(() => fitOffice()).observe(wrap);
}

// ------------------------------------------------------------------ approvals drawer
const pendingOks = () => S.approvals.filter((a) => a.status === 'pending');
// A plan the manager decides for the boss (approver: hana): shown dimmed, the boss can still decide first. Not counted.
const hanaDeciding = (a) => a.status === 'pending' && a.kind === 'plan' && a.approver === 'hana';
const bossOks = () => pendingOks().filter((a) => !hanaDeciding(a));
function renderOkButton() {
  const b = $('#okStat'); if (!b) return;
  const n = bossOks().length;
  b.className = `okbtn${S.okOpen ? ' on' : ''}${n ? '' : ' clear'}`;
  b.setAttribute('aria-label', n ? `${n} need your OK` : 'All clear'); // the label span hides at 639px and below
  b.innerHTML = n ? `${icon('hand')}<b>${n}</b><span class="oklbl"> need your OK</span>${icon(S.okOpen ? 'chevron-right' : 'chevron-left')}`
    : `${icon('check')}<span class="oklbl">All clear</span>${icon(S.okOpen ? 'chevron-right' : 'chevron-left')}`;
}
// Plan notes the boss is typing, by approval id: they survive every redraw of the drawer.
const notes = {};
// The boss's note on a decided item: a "Boss: ..." line the office adds (or a note field, if the API sends one).
// "The task was stopped." is the office closing a plan whose task was stopped, not a note from the boss.
const bossNote = (a) => { const n = a.note || ((String(a.details || '').match(/(?:^|\n)(?:Boss|Manager): (.+)/) || [])[1] || ''); return n.trim() === 'The task was stopped.' ? '' : n.trim(); };
const byWhom = (a) => (a.decidedBy === 'hana' ? ` by ${pa().name}` : '');
// Reject on a plan: with a note it sends the plan back; with no note it stops the task.
const rejectBtn = (a) => (a.kind !== 'plan' ? `<button class="btn" data-ok="${esc(a.id)}" data-d="rejected">${icon('x')}Reject</button>`
  : (notes[a.id] || '').trim() ? `<button class="btn" data-ok="${esc(a.id)}" data-d="rejected">${icon('rotate-ccw')}Send back with note</button>`
    : `<button class="btn danger" data-ok="${esc(a.id)}" data-d="rejected">${icon('x')}Reject and stop</button>`);
function okItem(a) {
  const who = staffById(a.from);
  const done = a.status !== 'pending';
  const sentBack = a.kind === 'plan' && a.status === 'rejected' && bossNote(a), hana = hanaDeciding(a);
  return `<div class="oki ${done ? 'done' : ''}${hana ? ' hana' : ''}" data-oki="${esc(a.id)}">
    <div class="okh2">${who ? av(who) : ''}<b>${esc(who ? who.name : a.from)}</b><span class="faint">${when(a.created)}</span>${hana ? `<span class="hanatag">${icon('clock')}${esc(pa().name)} is deciding</span>` : ''}${a.project ? `<span class="proj">${esc(a.project)}</span>` : ''}</div>
    ${a.escalated === 'yes' && !done ? `<div class="okc esc">${icon('hand')}${esc(pa().name)} passed this to you${a.escalateNote ? `: ${esc(a.escalateNote)}` : '.'}</div>` : ''}
    <div class="okq">${esc(a.action)}</div>${a.details ? `<div class="okc${a.kind === 'plan' ? ' plan' : ''}">${esc(a.details)}</div>` : ''}
    ${hana ? `<div class="okc faint">${esc(pa().name)} decides this plan for you. You can still decide first: the first decision counts.</div>` : ''}
    ${a.kind === 'plan' && !done ? `<div class="okc faint">If you approve, ${esc(who ? who.name : a.from)} does the work with this plan. Want a new plan? Write what to change, then Send back. With no note, Reject stops the task.</div><textarea class="in oknote" data-note="${esc(a.id)}" rows="2" aria-label="What to change in this plan (optional)" placeholder="What to change (optional)">${esc(notes[a.id] || '')}</textarea>` : ''}
    ${a.tool ? `<div class="okc faint">${done ? '' : `If you approve, ${esc(who ? who.name : a.from)} does it right away. `}Exact action: <span class="mono">${esc(a.tool)} ${esc(a.input || '')}</span></div>` : ''}
    ${done ? `<div class="okdone ${sentBack ? 'sentback' : a.status}">${icon(a.status === 'approved' ? 'check' : sentBack ? 'rotate-ccw' : 'x')}${a.status === 'approved' ? 'Approved' : sentBack ? 'Sent back for a new plan' : 'Rejected'}${byWhom(a)} ${when(a.decided)}${a.used ? `, done ${when(a.used)}` : ''}</div>`
    : `<div class="okb"><button class="btn ok" data-ok="${esc(a.id)}" data-d="approved">${icon('check')}Approve</button>${rejectBtn(a)}${who ? `<button class="btn ghost" style="margin-left:auto" data-ask="${esc(a.id)}">${icon('message-circle')}Ask</button>` : ''}</div>`}
  </div>`;
}
document.addEventListener('input', (e) => {
  const ta = e.target.closest('[data-note]'); if (!ta) return;
  const id = ta.dataset.note, had = !!(notes[id] || '').trim();
  notes[id] = ta.value;
  if (had === !!ta.value.trim()) return; // the button only changes when the note goes from empty to written, or back
  const a = S.approvals.find((x) => x.id === id), old = ta.closest('.oki') && ta.closest('.oki').querySelector('[data-d="rejected"]');
  if (a && old) old.outerHTML = rejectBtn(a);
});
function renderOk() {
  document.body.classList.toggle('ok-open', S.okOpen);
  const n = bossOks().length, all = [...bossOks(), ...pendingOks().filter(hanaDeciding)]; // the boss's own first
  // newest decision first; only what still needs the boss stays on the first tab
  const decided = S.approvals.filter((a) => a.status !== 'pending').sort((a, b) => String(b.decided || '').localeCompare(String(a.decided || '')));
  const tab = S.okTab || 'waiting';
  const body = tab === 'waiting'
    ? ((n ? '' : `<div class="okempty">${icon('party-popper')}All clear. Nothing waiting for you.</div>`) + all.map(okItem).join(''))
    : (decided.length ? decided.slice(0, 100).map(okItem).join('') + (decided.length > 100 ? `<div class="okempty">Showing the latest 100. All decisions are kept in approvals/.</div>` : '') : `<div class="okempty">${icon('clock')}No decisions yet.</div>`);
  $('#okDrawer').inert = !S.okOpen; // closed, it slides off screen: keep its buttons out of the Tab order
  // a redraw must not move the boss: keep the list's scroll and the caret in the note being typed
  const ae = document.activeElement, caret = ae && ae.matches('#okDrawer [data-note]') ? [ae.selectionStart, ae.selectionEnd, ae.selectionDirection] : null;
  const top = ($('#okDrawer .okbody') || {}).scrollTop || 0;
  redraw($('#okDrawer'), `<div class="okhead"><span class="okicon">${icon('hand')}</span>Needs your OK<span class="okn ${n ? '' : 'zero'}">${n}</span><button class="ibtn" data-oktoggle title="Close" aria-label="Close">${icon('x')}</button></div>
    <div class="oktabs"><div class="seg"><button class="${tab === 'waiting' ? 'on' : ''}" data-oktab="waiting">Waiting <span>${n}</span></button><button class="${tab === 'history' ? 'on' : ''}" data-oktab="history">History <span>${decided.length}</span></button></div></div>
    <div class="okbody">${body}</div>`);
  $('#okDrawer .okbody').scrollTop = top;
  if (caret && document.activeElement && document.activeElement.matches('[data-note]')) try { document.activeElement.setSelectionRange(...caret); } catch { /* gone */ }
  $$('[data-oktab]', $('#okDrawer')).forEach((b) => { b.onclick = () => { S.okTab = b.dataset.oktab; renderOk(); }; });
  renderOkButton();
}
// Open the drawer at one waiting item (a plan from a chat strip or the work board) and put the caret in its note.
function openOkAt(id) {
  S.okOpen = true; S.okTab = 'waiting'; renderOk(); renderChats();
  const it = id && $(`#okDrawer [data-oki="${CSS.escape(id)}"]`);
  if (!it) { const dr = $('#okDrawer'); dr.tabIndex = -1; dr.focus(); return; }
  it.scrollIntoView({ block: 'start' });
  ($('[data-note]', it) || $('button', it)).focus({ preventScroll: true });
}
function closeOk() { S.okOpen = false; renderOk(); renderChats(); ($('#okStat') || document.body).focus(); }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !S.okOpen || $('#modal').classList.contains('on')) return;
  e.preventDefault(); closeOk();
});

// ------------------------------------------------------------------ staff
function renderStaff(fromStatus) {
  const v = $('#v-staff');
  if (!$('.split', v)) {
    v.innerHTML = `<div class="split">
      <div class="pane" style="flex:1 1 auto"><div class="ph"><div class="seg" id="staffSeg"></div><div class="acts"><button class="btn sm pri" id="addStaff">${icon('plus')}Add staff</button></div></div><div class="pb" id="staffList"></div></div>
      <div class="gutter" data-side="next" data-key="staff"></div>
      <div class="pane" style="flex:0 0 400px" id="staffForm"></div></div>`;
    wireSplits(v);
    $('#addStaff').onclick = addStaffModal;
  }
  const arch = S.office.archived || [];
  redraw($('#staffSeg'), `<button class="${S.staffSeg === 'active' ? 'on' : ''}" data-seg="active">Active <span>${S.staff.length + 1}</span></button><button class="${S.staffSeg === 'archived' ? 'on' : ''}" data-seg="archived">Archived <span>${arch.length}</span></button>`);
  $$('#staffSeg button').forEach((b) => { b.onclick = () => { S.staffSeg = b.dataset.seg; renderStaff(); }; });
  $('#addStaff').disabled = S.staff.length >= 8;
  $('#addStaff').title = S.staff.length >= 8 ? 'At most 8 staff. Archive one first.' : '';
  const invChip = (id) => ADDON_CARDS.map((c) => {
    const a = S.office.addons && S.office.addons[c.id];
    return a && a.enabled && (a.staff || []).includes(id) ? `<span class="ichip" title="Works with ${c.title}">${c.img ? `<img src="${c.img}" alt="">` : ''}${c.chip}</span>` : '';
  }).join('');

  if (S.staffSeg === 'active') {
    const LAB = { working: 'Working', sleeping: 'Sleeping', waiting: 'Waiting for OK' };
    const stCells = (id) => { const x = S.status.people[id] || { status: 'sleeping' };
      return `<td><span class="badge ${x.status}"><i class="d ${x.status}"></i>${LAB[x.status]}</span></td><td class="muted" style="max-width:260px">${esc(x.status === 'working' ? taskText(id, x.task) : '') || '-'}</td><td class="muted">${x.last ? when(x.last) : '-'}</td>`; };
    redraw($('#staffList'), `<table class="stafftbl"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Now doing</th><th>Last active</th></tr></thead><tbody>
      <tr data-who="pa" tabindex="0" class="${S.sel.staff === 'pa' ? 'sel' : ''}"><td><span class="who">${paAv()}${esc(pa().name)} ${MGR}</span></td><td>Manager</td>${stCells('pa')}</tr>
      ${S.staff.map((s) => `<tr data-who="${esc(s.id)}" tabindex="0" class="${S.sel.staff === s.id ? 'sel' : ''}" title="${esc(s.job)}"><td><span class="who">${av(s)}${esc(s.name)}</span></td><td><span style="display:inline-flex;align-items:center;gap:6px"><i class="d" style="border-radius:var(--rs);background:${esc(s.colour)}"></i>${esc(s.role)}</span>${invChip(s.id)}</td>${stCells(s.id)}</tr>`).join('')}
      </tbody></table>`);
    $$('#staffList tr[data-who]').forEach((tr) => { tr.onclick = () => { if (S.dirty.has('staff') && !confirm('Discard your unsaved changes?')) return; S.dirty.delete('staff'); S.sel.staff = tr.dataset.who; renderStaff(); }; });
  } else {
    redraw($('#staffList'), `<div class="arcnote">${icon('archive')}<div>Archived staff keep their folder, notes and history. They don't get work and don't show in the office.</div></div>
      ${arch.length ? `<table><thead><tr><th>Name</th><th>Role</th><th>Archived</th><th>Folder</th><th></th></tr></thead><tbody>${arch.map((s) => `<tr style="cursor:default"><td><span class="who">${av(s, 'grey')}${esc(s.name)}</span></td><td class="muted">${esc(s.role)}</td><td class="muted">${esc(s.archivedAt || '')}</td><td class="mono muted">.archive/staff/${esc(s.id)}/</td>
        <td style="text-align:right"><button class="btn sm" data-react="${esc(s.id)}">${icon('rotate-ccw')}Reactivate</button> <button class="btn sm danger" data-del="${esc(s.id)}">${icon('trash-2')}Delete permanently</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No archived staff.</div>'}`);
    $$('[data-react]').forEach((b) => { b.onclick = () => act(() => api(`staff/${b.dataset.react}/reactivate`, 'POST'), 'Reactivated').then(() => refresh(['office', 'staff'])); });
    $$('[data-del]').forEach((b) => { b.onclick = () => deleteStaffModal(staffById(b.dataset.del)); });
  }
  // a live status update (fromStatus) must not rebuild the form under the keyboard user's focus
  if (!S.dirty.has('staff') && !(fromStatus && $('#staffForm').contains(document.activeElement))) renderStaffForm();
}

// Model and effort pickers (Staff page). Defaults come from the office until the boss changes them.
function runFields(who) {
  const r = S.run || { models: [], efforts: [], people: {} }, cur = r.people[who] || {};
  const opt = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  return `<div class="grid2"><div><label class="lbl">Model</label><select class="in" name="model">${opt(r.models, cur.model)}</select></div>
    <div><label class="lbl">Effort</label><select class="in" name="effort">${opt(r.efforts, cur.effort)}</select></div></div>
    <div class="faint" style="font-size:12px;margin-top:4px;line-height:1.5">A stronger model or more effort thinks harder and uses more of your Claude plan.</div>`;
}
// The office document tools install themselves on the first start; this says how that went.
function docToolsLine() {
  const d = S.doctools || {};
  const txt = d.ready ? `${icon('check')}Ready` : d.state === 'installing' ? 'Getting ready (first start only, about a minute)...'
    : d.state === 'failed' ? `Could not install: ${esc(d.error || 'unknown error')} <button class="btn sm" data-dtretry>Try again</button>` : `Not installed yet <button class="btn sm" data-dtretry>Install</button>`;
  return `<div class="dtline">Office documents tools: ${txt}</div>`;
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-dtretry]')) api('doctools/install', 'POST').then((d) => { S.doctools = d; const l = $('.dtline'); if (l) l.outerHTML = docToolsLine(); }, (er) => toast(er.message, true)); });

function renderStaffForm() {
  const f = $('#staffForm');
  const id = S.sel.staff;
  if (id === 'pa') {
    f.innerHTML = `<div class="ph">${paAv()}<h3>${esc(pa().name)}</h3>${MGR}<div class="acts"><button class="ibtn" data-x aria-label="Close">${icon('x')}</button></div></div>
      <div class="pb pre">${esc(pa().name)} is your manager. Every task goes through ${esc(pa().name)}, who hands it to the right staff, checks the result and reports back to you.

${esc(pa().name)}'s instructions are in <span class="mono">CLAUDE.md</span> in the office folder. The team table in it updates by itself when you add, edit or archive staff.</div>
      <div class="pb form" id="pf">${runFields('pa')}</div>
      <div class="formfoot"><button class="btn pri" id="pSave">${icon('save')}Save</button></div>`;
    $('#pSave').onclick = () => act(() => api('manager', 'PUT', { model: $('[name=model]', f).value, effort: $('[name=effort]', f).value }), 'Saved')
      .then(async () => { S.run = await api('run'); renderStaffForm(); });
  } else {
    const s = S.staff.find((x) => x.id === id);
    if (!s) { f.innerHTML = `<div class="empty"><b>Pick a staff</b>Click a row to edit their job, rules and look.</div>`; S.sel.staff = null; return; }
    const look = s.look || {};
    f.innerHTML = `<div class="ph"><span id="fAv">${av(s)}</span><h3>${esc(s.name)}</h3><span class="cnt">Edit</span><div class="acts"><button class="ibtn" data-x title="Close" aria-label="Close">${icon('x')}</button></div></div>
      <div class="pb form" id="sf">
        <div class="grid2"><div><label class="lbl">Name</label><input class="in" name="name" value="${esc(s.name)}" maxlength="40"></div>
        <div><label class="lbl">Role</label><input class="in" name="role" value="${esc(s.role)}" maxlength="60"></div></div>
        <label class="lbl">What does ${esc(s.name)} do?</label><textarea class="in" name="job" rows="3">${esc(s.job)}</textarea>
        <label class="lbl">Rules (one per line)</label><textarea class="in" name="rules" rows="6">${esc(s.rules.join('\n'))}</textarea>
        <label class="lbl">Notes</label><textarea class="in" name="notes" rows="3" placeholder="Things worth remembering about this job">${esc(s.notes)}</textarea>
        <label class="lbl">Colour</label><div class="swatches" data-pick="colour">${SWATCH.map((c) => swatch(c, 'Colour', c.toLowerCase() === String(s.colour).toLowerCase())).join('')}</div>
        <label class="lbl">Look</label>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" name="scarf" ${look.scarf ? 'checked' : ''}> Headscarf</label>
        <div class="swatches" data-pick="skin" style="margin-bottom:6px">${SKINS.map((c) => swatch(c, 'Skin tone', c === look.skin)).join('')}</div>
        <div class="swatches" data-pick="hair">${HAIRS.map((c) => swatch(c, 'Hair colour', c === look.hair)).join('')}</div>
        ${runFields(id)}
        <label class="lbl">Commands ${esc(s.name)} may run</label>
        <div class="cmdgrid">${(S.presets || []).map((p) => `<label class="cmd"><input type="checkbox" name="cmd" value="${esc(p.id)}" ${(p.id === 'docs' ? s.docs !== false : (s.commands || []).includes(p.id)) ? 'checked' : ''}><span><b>${esc(p.label)}</b><br><span class="faint">${esc(p.about)}</span></span></label>`).join('')}</div>
        ${docToolsLine()}
        <textarea class="in mono" name="customCommands" rows="2" aria-label="Other commands, one per line" placeholder="Other commands, one per line, e.g. php vendor/bin/pint" style="margin-top:8px">${esc((s.customCommands || []).join('\n'))}</textarea>
        <div class="faint" style="font-size:12px;margin-top:4px;line-height:1.5">Only in the office folder and linked folders. Never from the dashboard: git push, reset --hard, migrate:fresh, db:wipe, deleting with rm. You run those yourself.</div>
        <label class="lbl">Tools</label><div class="pre" style="padding:0;color:var(--muted)">${esc(s.tools.replace(/<!--[\s\S]*?-->/g, '').replace(/^- Commands you may run.*$/m, '').trim())}</div>
        <div class="arcnote" style="margin:10px 0 0">${icon('plug')}<div>To give ${esc(s.name)} a new tool (email, WhatsApp, an API), ask Claude in the office folder, for example <i>"let ${esc(s.name)} send WhatsApp messages"</i>.</div></div>
        <label class="lbl">Saved to</label><div class="mono muted">${esc(s.file)}</div>
      </div>
      <div class="formfoot"><button class="btn pri" id="sSave">${icon('save')}Save</button><button class="btn" id="sCancel">Cancel</button><button class="btn danger" style="margin-left:auto" id="sArch">${icon('archive')}Archive</button></div>`;
    const pick = { colour: s.colour, skin: look.skin, hair: look.hair };
    const preview = () => { const sc = $('[name=scarf]', f).checked; $('#fAv').innerHTML = av({ colour: pick.colour, look: { scarf: sc, skin: pick.skin, hair: pick.hair } }); };
    $$('[data-pick]', f).forEach((g) => { g.onclick = (e) => { const v = e.target.dataset.v; if (!v) return; pick[g.dataset.pick] = v; $$('i', g).forEach((i) => { i.classList.toggle('on', i === e.target); i.setAttribute('aria-pressed', String(i === e.target)); }); S.dirty.add('staff'); preview(); }; });
    $('#sf').oninput = () => { S.dirty.add('staff'); preview(); };
    $('#sCancel').onclick = () => { S.dirty.delete('staff'); renderStaffForm(); };
    $('#sSave').onclick = () => {
      const val = (n) => $(`[name=${n}]`, f).value;
      act(() => api(`staff/${id}`, 'PUT', { name: val('name'), role: val('role'), job: val('job'), rules: val('rules').split('\n'), notes: val('notes'),
        commands: $$('[name=cmd]:checked', f).map((x) => x.value).filter((x) => x !== 'docs'), docs: $$('[name=cmd]:checked', f).some((x) => x.value === 'docs'),
        customCommands: val('customCommands').split('\n').map((x) => x.trim()).filter(Boolean), model: val('model'), effort: val('effort'),
        colour: pick.colour, look: { scarf: $('[name=scarf]', f).checked, skin: pick.skin, hair: pick.hair } }), 'Saved')
        .then(async () => { S.dirty.delete('staff'); S.run = await api('run'); return refresh(['office', 'staff']); });
    };
    $('#sArch').onclick = () => modal(`<div class="mh">${icon('archive')}<b>Archive ${esc(s.name)}?</b></div>
      <p>${esc(s.name)} stops getting work and leaves the office. The folder, notes and history are kept, and you can reactivate any time.</p>
      <div class="mfoot"><button class="btn" data-close>Cancel</button><button class="btn pri" id="mGo">${icon('archive')}Archive</button></div>`,
    (close) => { $('#mGo').onclick = () => act(() => api(`staff/${id}/archive`, 'POST'), `${s.name} archived`).then(() => { close(); S.dirty.delete('staff'); S.sel.staff = null; return refresh(['office', 'staff']); }); });
  }
  const x = $('[data-x]', f); if (x) x.onclick = () => { S.dirty.delete('staff'); S.sel.staff = null; renderStaff(); };
}

function addStaffModal() {
  modal(`<div class="mh">${icon('user-plus')}<b>Add staff</b></div>
    <div class="grid2"><div><label class="lbl">Name</label><input class="in" id="nName" maxlength="40" placeholder="Farah"></div><div><label class="lbl">Role</label><input class="in" id="nRole" maxlength="60" placeholder="Marketing"></div></div>
    <label class="lbl">What do they do?</label><textarea class="in" id="nJob" rows="3" placeholder="Social media posts, promos, captions."></textarea>
    <p style="margin-top:10px;font-size:12px">${esc(pa().name)} can hand them work right away. You can change their rules and look after.</p>
    <div class="mfoot"><button class="btn" data-close>Cancel</button><button class="btn pri" id="mGo">${icon('plus')}Add</button></div>`,
  (close) => {
    $('#mGo').onclick = () => act(() => api('staff', 'POST', { name: $('#nName').value, role: $('#nRole').value, job: $('#nJob').value }), 'Added')
      .then((s) => { close(); S.sel.staff = s.id; S.staffSeg = 'active'; return refresh(['office', 'staff']); });
  });
}

function deleteStaffModal(s) {
  modal(`<div class="mh">${icon('trash-2')}<b>Delete ${esc(s.name)} permanently?</b></div>
    <p>This removes the folder, job description and notes:</p>
    <div class="mono" style="background:var(--line2);border-radius:var(--rs);padding:6px 8px;margin:8px 0">.archive/staff/${esc(s.id)}/</div>
    <p>This cannot be undone. Project notes they wrote stay in the projects.</p>
    <label class="lbl">Type <b>DELETE</b> to confirm</label><input class="in" id="mConf" autocomplete="off">
    <div class="mfoot"><button class="btn" data-close>Cancel</button><button class="btn dangerSolid" id="mGo" disabled>${icon('trash-2')}Delete permanently</button></div>`,
  (close) => {
    $('#mConf').oninput = (e) => { $('#mGo').disabled = e.target.value !== 'DELETE'; };
    $('#mGo').onclick = () => act(() => api(`staff/${s.id}/delete`, 'POST', { confirm: $('#mConf').value }), 'Deleted').then(() => { close(); return refresh(['office', 'staff']); });
  });
}

// ------------------------------------------------------------------ projects
const PSTAT = { active: 'In progress', waiting: 'Waiting', done: 'Done' };
function renderProjects() {
  const v = $('#v-projects');
  if (!$('.split', v)) {
    v.innerHTML = `<div class="split">
      <div class="pane" style="flex:0 0 300px"><div class="ph"><h3>Projects</h3><span class="cnt" id="pCnt"></span><div class="acts"><button class="btn sm pri" id="newProj">${icon('plus')}New</button></div></div><div class="pb" id="projList"></div></div>
      <div class="gutter" data-side="prev" data-key="projects"></div>
      <div class="pane" style="flex:1 1 auto" id="projMain"></div>
      <div class="gutter" data-side="next" data-key="projmem"></div>
      <div class="pane" style="flex:0 0 360px" id="projMem"></div></div>`;
    wireSplits(v);
    $('#newProj').onclick = newProjectModal;
  }
  $('#pCnt').textContent = S.projects.length;
  redraw($('#projList'), S.projects.length ? S.projects.map((p) => `<div class="row ${S.sel.project === p.id ? 'sel' : ''}" data-p="${esc(p.id)}" role="button" tabindex="0">${icon(p.status === 'done' ? 'check' : 'folder', 'faint')}<span class="txt"><b style="font-weight:600">${esc(p.title)}</b>${p.customer ? ` <span class="muted">${esc(p.customer)}</span>` : ''}</span><span class="badge ${esc(p.status)}">${esc(PSTAT[p.status] || p.status)}</span></div>`).join('')
    : `<div class="empty"><b>No projects yet</b>${esc(pa().name)} creates one when you start work for a customer, or press New.</div>`);
  $$('#projList [data-p]').forEach((r) => { r.onclick = async () => { S.sel.project = r.dataset.p; S.project = await api(`projects/${encodeURIComponent(r.dataset.p)}`); renderProjects(); }; });
  const p = S.project && S.project.id === S.sel.project ? S.project : null;
  if (!p) {
    $('#projMain').innerHTML = `<div class="empty"><b>Pick a project</b>Each project is a folder in projects/ with a CLAUDE.md that staff read before working.</div>`;
    $('#projMem').innerHTML = ''; return;
  }
  if (!S.dirty.has('project')) {
    $('#projMain').innerHTML = `<div class="ph">${icon('folder-open', 'faint')}<h3>${esc(p.title)}</h3><span class="badge ${esc(p.status)}">${esc(PSTAT[p.status] || p.status)}</span></div>
      <div class="pb form" id="pf">
        <div class="grid2"><div><label class="lbl">Status</label><select class="in" name="status">${Object.entries(PSTAT).map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="lbl">Deadline</label><input class="in" name="deadline" type="date" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(p.deadline) ? p.deadline : '')}"></div></div>
        <label class="lbl">Customer</label><input class="in" name="customer" value="${esc(p.customer)}">
        <label class="lbl">Linked folder (optional)</label><input class="in mono" name="linked" value="${esc(p.linked)}" placeholder="D:\\Kedai Ali\\website">
        <div class="faint" style="font-size:12px;margin-top:4px;line-height:1.5">A folder outside the office where this project's files live. Staff may work there. Paste its full path (in File Explorer, click the address bar and copy).</div>
        <label class="lbl">Files</label>${p.files.length ? `<div class="mono muted" style="line-height:1.7">${p.files.map(esc).join('<br>')}</div>` : '<div class="muted">No files yet.</div>'}
        <label class="lbl">Folder</label><div class="mono muted">${esc(p.folder)}</div>
      </div>
      <div class="formfoot"><button class="btn pri" id="pSave">${icon('save')}Save</button></div>`;
    $('#pf').oninput = () => S.dirty.add('project');
    $('#pSave').onclick = () => {
      const val = (n) => $(`#pf [name=${n}]`).value;
      act(() => api(`projects/${p.id}`, 'PUT', { status: val('status'), deadline: val('deadline'), customer: val('customer'), linked: val('linked') }), 'Saved')
        .then((np) => { S.dirty.delete('project'); S.project = np; return refresh(['projects']); });
    };
  }
  $('#projMem').innerHTML = `<div class="ph">${icon('brain', 'faint')}<h3>Notes</h3><span class="cnt">${p.notes.length}</span></div>
    <div class="pb">${p.notes.map((n) => `<div class="note">${icon(/\((?:boss|you),/i.test(n) ? 'pin' : 'bot')}<div>${esc(n)}</div></div>`).join('')}
      <div class="muted" style="padding:10px 12px;font-size:12px">Staff read these before working on the project and add new ones. Saved in <span class="mono">${esc(p.folder)}CLAUDE.md</span>.</div></div>
    <div class="formfoot"><input class="in" id="noteIn" aria-label="Add a note for the team" placeholder="Add a note for the team" maxlength="400"><button class="btn" id="noteAdd">${icon('plus')}Add</button></div>`;
  const addNote = () => { const t = $('#noteIn').value.trim(); if (!t) return; act(() => api(`projects/${p.id}/notes`, 'POST', { note: t })).then((np) => { S.project = np; renderProjects(); }); };
  $('#noteAdd').onclick = addNote;
  $('#noteIn').onkeydown = (e) => { if (e.key === 'Enter') addNote(); };
}

function newProjectModal() {
  modal(`<div class="mh">${icon('folder')}<b>New project</b></div>
    <label class="lbl">Project name</label><input class="in" id="nT" placeholder="Kedai Ali website" maxlength="80">
    <div class="grid2"><div><label class="lbl">Customer</label><input class="in" id="nC" maxlength="80"></div><div><label class="lbl">Deadline</label><input class="in" id="nD" type="date"></div></div>
    <label class="lbl">What do they want?</label><textarea class="in" id="nW" rows="3"></textarea>
    <div class="mfoot"><button class="btn" data-close>Cancel</button><button class="btn pri" id="mGo">${icon('plus')}Create</button></div>`,
  (close) => {
    $('#mGo').onclick = () => act(() => api('projects', 'POST', { title: $('#nT').value, customer: $('#nC').value, deadline: $('#nD').value, what: $('#nW').value }), 'Project created')
      .then(async (p) => { close(); S.sel.project = p.id; S.project = p; await refresh(['projects']); });
  });
}

// ------------------------------------------------------------------ inbox
const TYPE_COL = { lead: 'var(--acc)', order: 'var(--teal)', enquiry: 'var(--blue)', message: 'var(--muted)' };
function renderInbox() {
  const v = $('#v-inbox');
  if (!$('.split', v)) {
    v.innerHTML = `<div class="split">
      <div class="pane" style="flex:1 1 auto"><div class="ph"><h3>Customer queue</h3><span class="cnt" id="iCnt"></span><div class="acts"><button class="btn sm pri" id="iAdd">${icon('plus')}Add a request</button></div></div><div class="pb" id="inList"></div></div>
      <div class="gutter" data-side="next" data-key="inbox"></div>
      <div class="pane" style="flex:0 0 380px" id="inSide"></div></div>`;
    wireSplits(v);
    $('#iAdd').onclick = () => { S.sel.inbox = 'new'; renderInbox(); };
  }
  $('#iCnt').textContent = `${S.inbox.length} request${S.inbox.length === 1 ? '' : 's'}`;
  redraw($('#inList'), S.inbox.length ? `<table><thead><tr><th>Ticket</th><th>Type</th><th>From</th><th>Source</th><th>Request</th><th>Who</th><th>Status</th><th>Received</th></tr></thead><tbody>
    ${S.inbox.map((x) => { const w = staffById(x.assigned); return `<tr data-i="${esc(x.id)}" tabindex="0" class="${S.sel.inbox === x.id ? 'sel' : ''}"><td class="mono">#${esc(x.ticket)}</td>
      <td><span style="color:${TYPE_COL[x.type] || 'var(--muted)'};font-weight:600">${esc(x.type || 'message')}</span></td><td>${esc(x.from)}</td><td class="muted">${esc(x.source)}</td>
      <td style="max-width:280px">${esc((x.text || '').split('\n')[0])}</td><td>${w ? `<span class="who">${av(w)}${esc(w.name)}</span>` : '<span class="faint">-</span>'}</td>
      <td><span class="badge ${esc(x.status)}">${esc(x.status || 'new')}</span></td><td class="muted">${when(x.received)}</td></tr>`; }).join('')}</tbody></table>`
    : `<div class="empty"><b>The inbox is empty</b>Add a request by hand, or ask Claude to connect email, WhatsApp or your shop so requests arrive here by themselves.</div>`);
  $$('#inList tr[data-i]').forEach((tr) => { tr.onclick = () => { S.sel.inbox = tr.dataset.i; renderInbox(); }; });
  if (!S.dirty.has('inbox')) renderInboxSide();
}

function renderInboxSide() {
  const f = $('#inSide');
  const x = S.inbox.find((i) => i.id === S.sel.inbox);
  if (!x) {
    f.innerHTML = `<div class="ph"><h3>Add a request</h3></div>
      <div class="pb form" id="nf">
        <div class="grid2"><div><label class="lbl">Type</label><select class="in" name="type">${['enquiry', 'order', 'lead', 'message'].map((t) => `<option>${t}</option>`).join('')}</select></div>
        <div><label class="lbl">Source</label><select class="in" name="source">${['whatsapp', 'email', 'phone', 'walk-in', 'manual'].map((t) => `<option>${t}</option>`).join('')}</select></div></div>
        <label class="lbl">From</label><input class="in" name="from" maxlength="80" placeholder="Customer name">
        <label class="lbl">Request</label><textarea class="in" name="text" rows="6" placeholder="Paste the customer's message"></textarea>
        <div class="arcnote" style="margin:16px 0 0">${icon('plug')}<div>Want email, WhatsApp, your shop or a webhook to add requests here by themselves? Ask Claude in the office folder: <i>"connect my Gmail enquiries to the inbox"</i>.</div></div>
      </div>
      <div class="formfoot"><button class="btn pri" id="nAdd">${icon('plus')}Add to queue</button></div>`;
    $('#nf').oninput = () => S.dirty.add('inbox');
    $('#nAdd').onclick = () => {
      const val = (n) => $(`#nf [name=${n}]`).value;
      act(() => api('inbox', 'POST', { type: val('type'), source: val('source'), from: val('from'), text: val('text') }), `Added. Ask ${pa().name} to check the inbox.`)
        .then((it) => { S.dirty.delete('inbox'); S.sel.inbox = it.id; return refresh(['inbox']); });
    };
    return;
  }
  f.innerHTML = `<div class="ph"><span class="mono">#${esc(x.ticket)}</span><h3>${esc(x.from)}</h3><span class="badge ${esc(x.status)}">${esc(x.status)}</span><div class="acts"><button class="ibtn" data-x title="Close" aria-label="Close">${icon('x')}</button></div></div>
    <div class="pb form">
      <div class="grid2"><div><label class="lbl">Who handles it</label><select class="in" id="iWho"><option value="">Not assigned</option>${S.staff.map((s) => `<option value="${esc(s.id)}" ${x.assigned === s.id ? 'selected' : ''}>${esc(s.name)} (${esc(s.role)})</option>`).join('')}</select></div>
      <div><label class="lbl">Status</label><select class="in" id="iSt">${['new', 'working', 'waiting', 'done'].map((t) => `<option ${x.status === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
      <label class="lbl">${esc(x.type)} from ${esc(x.source)}, ${when(x.received)}</label>
      <div class="pre" style="border:1px solid var(--line2);border-radius:var(--r)">${esc(x.text)}</div>
      <label class="lbl">File</label><div class="mono muted">inbox/${esc(x.id)}.md</div>
    </div>
    <div class="formfoot"><button class="btn pri" id="iAsk">${icon('message-circle')}Ask ${esc(pa().name)} to handle it</button></div>`;
  $('#iAsk').onclick = () => sendChat('pa', `Please handle inbox item #${x.ticket} from ${x.from} (inbox/${x.id}.md).`);
  const save = () => act(() => api(`inbox/${encodeURIComponent(x.id)}`, 'PUT', { assigned: $('#iWho').value, status: $('#iSt').value }), 'Saved').then(() => refresh(['inbox']));
  $('#iWho').onchange = save; $('#iSt').onchange = save;
  $('[data-x]', f).onclick = () => { S.sel.inbox = null; renderInbox(); };
}

// ------------------------------------------------------------------ settings
// Office floor plans: id, label, one-line description (dashboard/office3d.js LAYOUTS)
const LAYOUTS_UI = [
  ['pinwheel', 'Pinwheel Studio', 'Two blocks of four desks around plant hubs, with a pairing station in the north strip.'],
  ['horseshoe', 'Horseshoe War Room', 'Eight desks in a U facing one big shared burndown screen. The manager sits at the open end.'],
  ['triads', 'Triads and Harvest Table', 'Two groups of three desks around round hubs, and a long harvest table with stools for stand-ups.'],
];
function renderSettings() {
  const nav = [['general', 'info', 'General'], ['manager', 'brain', 'Manager'], ['addons', 'plug', 'Add-ons'], ['api', 'file-text', 'Office key and API'], ['linked', 'folder-open', 'Linked folders'], ['cleanup', 'trash-2', 'Clean up']];
  const CLEAN = [
    ['activity', true, 'Live activity log', 'Who worked on what (.office/events.jsonl). The office starts quiet again.'],
    ['chats', true, 'Dashboard chats', 'All chat windows and their Claude conversations (.office/chats/). Everyone starts fresh.'],
    ['summaries', true, `Staff chat summaries for ${pa().name}`, '.office/staff-chats.md is reset to empty.'],
    ['inbox', false, 'Inbox items', 'Every customer request in inbox/.'],
    ['approvals', false, 'Approvals', 'Waiting and decided approvals in approvals/.'],
    ['tasks', false, 'Task history', 'Finished and stopped tasks in tasks/ (running ones are stopped first by you).'],
    ['projects', false, 'Projects', 'Every project folder in projects/, with its files and notes.'],
    ['staffFiles', false, 'Staff work files', "Files staff made in their folders (quotes, drafts, price lists). Their job description and rules stay."],
  ];
  const card = (c) => {
    const a = (S.office.addons || {})[c.id];
    return `<div class="featured"${c.img ? '' : ' style="margin-top:16px"'}><div class="fhead">${c.img ? `<img src="${c.img}" alt="">` : icon('plug')}<div><h2>${c.name}</h2><div class="muted">${c.about}</div></div></div>
      <div class="fbody">${a && a.enabled ? `Turned on for: <b>${(a.staff || []).map((id) => esc(nameOf(id))).join(', ') || 'no staff yet'}</b>.${c.login ? `<br>Not logged in yet? Ask ${esc(pa().name)} in chat: <i>"${c.login}"</i>, and sign in in your browser.` : ''}
        <h3 style="margin:18px 0 6px">Actions that leave your office</h3>
        <p class="muted" style="line-height:1.6;margin-bottom:10px">Ask me first: the staff asks in Needs your OK, and does it right after you approve. Always allow: the staff does it without asking.</p>
        <div class="actList muted" data-addon="${c.id}">Loading...</div>`
      : `Not connected. ${c.off}`}</div>
      <div class="ffoot"><a class="btn ${c.img ? 'inv' : ''}" href="${c.btn[1]}" target="_blank" rel="noopener">${c.btn[0]}</a></div></div>`;
  };
  const body = {
    general: `<h3 style="margin-bottom:12px">General</h3><div class="kv">
      <span class="muted">Company</span><span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input class="in" id="coName" aria-label="Company name" maxlength="80" value="${esc(S.office.company)}" style="max-width:320px"><button class="btn sm" id="coSave">Save</button></span>
      <span class="muted">Office layout</span><span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><select class="in" id="lyPick" aria-label="Office layout" style="max-width:320px">${LAYOUTS_UI.map(([k, l]) => `<option value="${k}" ${(S.office.layout || 'pinwheel') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><button class="btn sm" id="lySave">Save layout</button></span>
      <span></span><span class="muted" id="lyNote" style="max-width:520px;line-height:1.5">${esc(LAYOUTS_UI.find(([k]) => k === (S.office.layout || 'pinwheel'))[2])}</span>
      <span class="muted">Manager</span><span>${esc(pa().name)}</span>
      <span class="muted">Office folder</span><span class="mono">${esc(S.office.folder)}</span>
      <span class="muted">Dashboard</span><span class="mono">http://${esc(location.host)}</span></div>
      <p class="muted" style="margin-top:16px;line-height:1.6">To change the manager's name, ask Claude in the office folder, for example <i>"rename the manager to Hana"</i>. Everything is plain files: OFFICE.md explains each one.</p>`,
    manager: `<h3 style="margin-bottom:6px">${esc(pa().name)}, your manager</h3>
      <p class="muted" style="line-height:1.6;margin-bottom:14px;max-width:720px">${esc(pa().name)} acts for you as another you. Tell ${esc(pa().name)} how you think, and choose who approves staff plans.
      Sending, payments and Always allow stay with you only. Plans about money, sending or deleting, plans sent back twice, and work in a linked folder always come to you.</p>
      <label class="lbl" for="mgApprover">Who approves staff plans</label>
      <select class="in" id="mgApprover" style="max-width:420px"><option value="hana">${esc(pa().name)} decides for me (I can still decide first)</option><option value="boss">I decide every plan myself</option></select>
      <label class="lbl" for="mgProfile" style="margin-top:16px">How I think (${esc(pa().name)} reads this; staff never see it)</label>
      <textarea class="in" id="mgProfile" rows="9" maxlength="4096" style="max-width:720px;line-height:1.5" placeholder="For example: Keep quotes short. Never give more than 5% discount. Customers in Penang get free delivery. Ask me before anything for a new customer."></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px;max-width:720px"><button class="btn pri" id="mgSave">${icon('save')}Save</button><span class="faint" id="mgCount" style="margin-left:auto;font-size:12px"></span></div>
      <p class="faint" style="font-size:12px;margin-top:8px">Saved in .office/boss.md in the office folder.</p>`,
    addons: `${ADDON_CARDS.map(card).join('')}
      <p class="muted" style="margin-top:20px;line-height:1.6">More: email, WhatsApp, your shop, any API. Ask Claude in the office folder, for example <i>"connect my Gmail enquiries to the inbox"</i> or <i>"let Siti send WhatsApp messages"</i>.</p>`,
    api: `<h3 style="margin-bottom:8px">Office key and local API</h3>
      <p class="muted" style="line-height:1.6;margin-bottom:12px">Scripts and connectors you set up can add inbox items, ask for approvals and log activity while the dashboard runs. Every call needs the office key. It only works on this computer.</p>
      <div class="kv"><span class="muted">Office key</span><span><span class="mono" id="keyV">••••••••••••••••</span> <button class="btn sm" id="keyShow">Show</button></span></div>
      <div class="pre mono" style="background:var(--line2);border-radius:var(--r);margin-top:14px">curl -X POST http://${esc(location.host)}/api/inbox \\
  -H "X-Office-Key: &lt;office key&gt;" -H "Content-Type: application/json" \\
  -d '{"from":"Kedai Ali","source":"webhook","type":"order","text":"50 t-shirts, size L"}'</div>
      <p class="muted" style="margin-top:12px">All calls are listed in OFFICE.md. Keep the key secret.</p>`,
    linked: `<h3 style="margin-bottom:6px">Linked folders</h3>
      <p class="muted" style="line-height:1.6;margin-bottom:14px;max-width:720px">${esc(pa().name)} and the staff can only touch files in the office folder, plus the folders you link here. Everything else on this computer stays off limits. Link only what they need, for example your shop's website folder or a documents folder.</p>
      <div id="lkList" class="muted">Loading...</div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:8px;max-width:820px;margin-top:14px;align-items:end">
        <div><label class="lbl">Name</label><input class="in" id="lkLabel" placeholder="Company documents" maxlength="60"></div>
        <div><label class="lbl">Full folder path</label><input class="in mono" id="lkPath" placeholder="D:\\Kedai Ali\\documents"></div>
        <button class="btn pri" id="lkAdd" style="height:32px">${icon('plus')}Link</button></div>
      <p class="faint" style="font-size:12px;margin-top:8px">Windows: in File Explorer, click the address bar and copy. Mac: right-click the folder while holding Option, then "Copy as Pathname". A project can also have its own linked folder (Projects, then the project).</p>`,
    cleanup: `<h3 style="margin-bottom:6px">Clean up</h3>
      <p class="muted" style="line-height:1.6;margin-bottom:14px">Clear test or old data. Your team stays as it is: ${esc(pa().name)}'s instructions, every staff's job, rules and settings, and office.json are never touched.</p>
      <div style="display:flex;flex-direction:column;gap:10px;max-width:640px">${CLEAN.map(([k, on, l, d]) => `<label style="display:flex;gap:10px;align-items:flex-start;line-height:1.45"><input type="checkbox" name="cl" value="${k}" ${on ? 'checked' : ''} style="margin-top:3px"><span><b style="font-weight:600">${esc(l)}</b><br><span class="muted">${esc(d)}</span></span></label>`).join('')}</div>
      <div class="arcnote" style="margin:16px 0 0;max-width:640px">${icon('circle-alert')}<div>Cleared files cannot be brought back. Tip: copy the office folder first if you might need them.</div></div>
      <label class="lbl">Type <b>CLEAR</b> to confirm</label>
      <div style="display:flex;gap:8px;max-width:640px"><input class="in" id="clConf" aria-label="Type CLEAR to confirm" autocomplete="off" style="max-width:200px"><button class="btn dangerSolid" id="clGo" disabled>${icon('trash-2')}Clear selected</button></div>`,
  };
  $('#v-settings').innerHTML = `<div class="split"><div class="pane" style="flex:0 0 220px"><div class="pb" style="padding:8px">${nav.map(([k, ic, l]) => `<button class="snav ${S.settings === k ? 'on' : ''}" data-s="${k}">${icon(ic)}${l}</button>`).join('')}</div></div>
    <div class="gutter" data-side="prev" data-key="settings"></div><div class="pane" style="flex:1 1 auto"><div class="pb" style="padding:20px 24px;max-width:900px">${body[S.settings]}</div></div></div>`;
  wireSplits($('#v-settings'));
  $$('[data-s]').forEach((b) => { b.onclick = () => { S.settings = b.dataset.s; renderSettings(); }; });
  const ks = $('#keyShow'); if (ks) ks.onclick = () => { $('#keyV').textContent = KEY; ks.remove(); };
  const ly = $('#lySave'), lyPick = $('#lyPick');
  if (lyPick) lyPick.onchange = () => { $('#lyNote').textContent = LAYOUTS_UI.find(([k]) => k === lyPick.value)[2]; };
  if (ly) ly.onclick = () => act(() => api('office', 'PUT', { layout: lyPick.value }), 'Layout saved').then(() => refresh(['office']));
  if (S.settings === 'manager') {
    const pick = $('#mgApprover'), prof = $('#mgProfile'), cnt = () => { $('#mgCount').textContent = `${new Blob([prof.value]).size} / 4096 bytes`; };
    prof.oninput = cnt;
    api('manager').then((m) => { pick.value = m.planApprover; prof.value = m.bossProfile || ''; cnt(); }).catch((e) => toast(e.message, true));
    $('#mgSave').onclick = () => act(() => api('manager', 'PUT', { planApprover: pick.value, bossProfile: prof.value }), 'Saved').then((m) => { if (m) { pick.value = m.planApprover; prof.value = m.bossProfile || ''; cnt(); } });
  }
  const co = $('#coSave');
  if (co) co.onclick = () => act(() => api('office', 'PUT', { company: $('#coName').value }), 'Company saved').then(() => refresh(['office']));
  if (S.settings === 'linked') {
    const show = (list) => {
      $('#lkList').innerHTML = list.length ? `<table style="max-width:820px"><thead><tr><th>Name</th><th>Folder</th><th></th></tr></thead><tbody>${list.map((l) => `<tr style="cursor:default"><td>${esc(l.project ? `Project: ${l.label}` : l.label)}</td><td class="mono" style="max-width:460px">${esc(l.path)}${l.ok ? '' : ' <span class="badge waiting">not found</span>'}</td>
        <td style="text-align:right">${l.project ? `<button class="btn sm" data-go="projects">Change in project</button>` : `<button class="btn sm danger" data-unlink="${esc(l.path)}">Unlink</button>`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="text-align:left;padding:4px 0">No linked folders. Staff work only inside the office folder.</div>';
      $$('[data-unlink]').forEach((b) => { b.onclick = () => act(() => api('linked/remove', 'POST', { path: b.dataset.unlink }), 'Unlinked').then(show); });
    };
    api('linked').then(show).catch((e) => { $('#lkList').textContent = e.message; });
    $('#lkAdd').onclick = () => act(() => api('linked', 'POST', { path: $('#lkPath').value, label: $('#lkLabel').value }), 'Linked').then((list) => { $('#lkPath').value = ''; $('#lkLabel').value = ''; show(list); });
  }
  if ($('.actList')) {
    const showActs = (list) => {
      $$('.actList').forEach((box) => {
        const mine = list.filter((x) => x.addon === box.dataset.addon);
        box.innerHTML = mine.length ? `<table style="max-width:640px"><tbody>${mine.map((x) => `<tr style="cursor:default"><td>${esc(x.label)}</td><td style="text-align:right">
        <select class="in" data-act="${esc(x.tool)}" aria-label="${esc(x.label)}" style="width:auto"><option value="ask" ${x.always ? '' : 'selected'}>Ask me first</option><option value="always" ${x.always ? 'selected' : ''}>Always allow</option></select></td></tr>`).join('')}</tbody></table>` : 'Nothing here needs your OK.';
      });
      $$('[data-act]').forEach((sel) => { sel.onchange = () => act(() => api('actions', 'POST', { tool: sel.dataset.act, always: sel.value === 'always' }), sel.value === 'always' ? 'Set to Always allow' : 'Set to Ask me first').then(showActs); });
    };
    api('actions').then(showActs).catch((e) => { $$('.actList').forEach((box) => { box.textContent = e.message; }); });
  }
  const cg = $('#clGo');
  if (cg) {
    $('#clConf').oninput = (e) => { cg.disabled = e.target.value !== 'CLEAR'; };
    cg.onclick = () => {
      const items = $$('[name=cl]:checked').map((x) => x.value);
      act(() => api('cleanup', 'POST', { items, confirm: $('#clConf').value }), 'Cleared').then(() => { $('#clConf').value = ''; cg.disabled = true; });
    };
  }
}


// ------------------------------------------------------------------ chats (dock + windows)
// Each message runs Claude Code on the user's own account (in the office folder for the PA,
// in staff/<id>/ for a staff). Replies stream in over the live connection.
const C = {}; // id -> { messages, running, loaded, unread }
const chatOf = (id) => (C[id] = C[id] || { messages: [], running: false, loaded: false, unread: 0 });
const personOf = (id) => (id === 'pa' ? { id: 'pa', name: pa().name, colour: pa().colour, look: pa().look || { scarf: true, skin: '#F2C9A0' } } : S.staff.find((s) => s.id === id));
const RING = { working: 'var(--green)', sleeping: '#C9CDD8', waiting: 'var(--amber)' };
const SLAB = { working: 'Working', sleeping: 'Sleeping', waiting: 'Waiting for OK' };

// One expanded chat at a time: id opens, every other open chat is minimised (its conversation stays).
function focusChat(id) {
  V.open = [id, ...V.open.filter((x) => x !== id)];
  V.min = V.open.filter((x) => x !== id);
}
async function openChat(id, draft) {
  if (!personOf(id)) return;
  focusChat(id);
  const c = chatOf(id); c.unread = 0;
  saveView(); renderChats();
  if (!c.loaded) { const h = await api(`chat/${id}`).catch(() => null); if (h) { c.messages = h.messages; c.running = h.running; c.loaded = true; renderChats(); } }
  const ta = $(`.win[data-win="${id}"] textarea`);
  if (ta) { if (draft) { ta.value = draft; ta.setSelectionRange(draft.length, draft.length); } ta.focus(); }
}
function closeChat(id) { V.open = V.open.filter((x) => x !== id); V.min = V.min.filter((x) => x !== id); saveView(); renderChats(); }
function toggleMin(id) {
  if (V.min.includes(id)) focusChat(id); else V.min = [...V.min, id];
  if (!V.min.includes(id)) chatOf(id).unread = 0;
  saveView(); renderChats();
}

async function sendChat(id, text) {
  const t = String(text || '').trim(); if (!t) return;
  await openChat(id);
  try { const r = await api(`chat/${id}`, 'POST', { text: t }); chatOf(id).running = true; if (r.queued) toast(`${personOf(id).name} will read it right after this reply`); renderChats(); return true; } catch (e) { toast(e.message, true); return false; }
}

// Pasted or dropped images: each one is saved in the office, and its path goes into the message as a line.
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMG_MAX = 10 * 1024 * 1024;
const toBase64 = (f) => new Promise((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]);
  r.onerror = () => no(r.error);
  r.readAsDataURL(f);
});
function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
  const pre = ta.value.slice(0, s), post = ta.value.slice(e);
  const at = pre + (pre && !pre.endsWith('\n') ? '\n' : '') + text + '\n';
  ta.value = at + post;
  ta.setSelectionRange(at.length, at.length);
  ta.dispatchEvent(new Event('input'));
}
async function attachImages(ta, files) {
  const imgs = [...files].filter((f) => IMG_TYPES.includes(f.type));
  if (!imgs.length) { toast('Only PNG, JPEG, GIF or WebP images can be added', true); return; }
  const box = ta.closest('.box');
  box.classList.add('up');
  try {
    for (const f of imgs) {
      if (f.size > IMG_MAX) { toast(`${f.name || 'That image'} is bigger than 10 MB`, true); continue; }
      try {
        const r = await api('attachments', 'POST', { type: f.type, data: await toBase64(f) });
        insertAtCursor(ta, `[image: ${r.path}]`);
      } catch (e) { toast(e.message, true); }
    }
  } finally { box.classList.remove('up'); ta.focus(); }
}

function msgHtml(id, m) {
  const time = m.at ? new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  if (m.from === 'boss') return `<div class="bm me">${esc(m.text)}<span class="t">${time}</span></div>`;
  if (m.from === 'system') {
    if (m.kind === 'error') return `<div class="wact err">${icon('circle-alert')}${esc(m.text)}</div>`;
    if (m.kind === 'new') return `<div class="wnew">${esc(m.text)}${time ? `, ${time}` : ''}</div>`;
    return `<div class="wact">${icon(m.done ? 'check' : 'chevron-right')}${esc(m.text)}</div>`;
  }
  return `<div class="bm">${linkPaths(markdown(m.text))}<span class="t">${time}</span></div>`;
}

// File paths in a reply (in backticks) become links: a click opens the file on this computer, like a
// double-click. The server only opens files inside the office or a linked folder.
const unesc = (h) => h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function isPath(t) {
  if (/^[A-Za-z]:[\\/]/.test(t) || /^\\\\[^\\]/.test(t)) return true; // C:\... or \\server\...
  const roots = [S.office.folder, ...(S.linked || []).map((l) => l.path)].filter(Boolean);
  if (t.startsWith('/')) return roots.some((r) => t === r || t.startsWith(`${r}/`));
  return /^(projects|inbox|staff|tasks|approvals)[\\/][^\s]/.test(t); // relative to the office folder
}
function linkPaths(html) {
  return html.replace(/<code>([^<]{3,400})<\/code>/g, (all, inner) => (isPath(unesc(inner).trim()) ? `<a class="fpath" data-open="${inner}" title="Open this file">${icon('file-text')}${inner}</a>` : all));
}

// What is happening right now in a chat: the step in plain words, seconds so far, and the
// answer as it is being written. Updated on its own, many times a second, without redrawing the chat.
function renderLive(id, keepScroll) {
  const w = $(`.win[data-win="${id}"]`); if (!w) return;
  const el = $('.live', w), body = $('.wb', w), c = chatOf(id), p = personOf(id);
  if (!el || !p) return;
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  if (!c.running) { el.innerHTML = ''; return; }
  const live = c.live || {};
  const secs = c.since ? Math.max(0, Math.round((Date.now() - c.since) / 1000)) : 0;
  redraw(el, `${live.text ? `<div class="bm streaming">${markdown(live.text)}<span class="caret"></span></div>` : ''}
    <div class="typing"><span class="dots"><i></i><i></i><i></i></span><span class="step">${esc(live.step || `${p.name} is starting`)}</span><span class="secs">${secs}s</span><button class="btn sm" data-stop="${esc(id)}">Stop</button></div>`);
  if (atEnd || keepScroll) body.scrollTop = body.scrollHeight;
}
setInterval(() => { for (const [id, c] of Object.entries(C)) if (c.running && c.since) { const el = $(`.win[data-win="${id}"] .live .secs`); if (el) el.textContent = `${Math.round((Date.now() - c.since) / 1000)}s`; } }, 1000);

function renderChats() {
  let dock = $('#dock'), wins = $('#wins');
  if (!dock) { dock = document.createElement('div'); dock.id = 'dock'; document.body.append(dock); }
  if (!wins) { wins = document.createElement('div'); wins.id = 'wins'; document.body.append(wins); }
  const people = [personOf('pa'), ...S.staff];
  // at most one expanded window: the first open chat that is not minimised; the rest stay open as bars
  V.open = V.open.filter((id) => personOf(id));
  V.min = V.min.filter((id) => V.open.includes(id));
  const exp = V.open.find((id) => !V.min.includes(id));
  if (exp) V.open = [exp, ...V.open.filter((id) => id !== exp)];
  V.min = V.open.filter((id) => id !== exp);
  saveView();
  const shown = V.open;
  // the expanded window is 430px wide. On desktop (1200px+) it takes that room from the page; below that it overlays the page.
  const reserve = innerWidth >= 1200 && exp ? 430 : 0;
  document.documentElement.style.setProperty('--chat-w', `${reserve}px`);
  document.body.classList.toggle('chat-res', reserve > 0);

  redraw(dock, people.map((p) => {
    const st = (S.status.people[p.id] || {}).status || 'sleeping', c = chatOf(p.id);
    return `<div class="head ${shown.includes(p.id) ? 'open' : ''} ${c.running ? 'busy' : ''}" data-chat="${esc(p.id)}" role="button" tabindex="0" aria-label="${esc(p.name)}${p.id === 'pa' ? ' (Manager)' : ''}, ${SLAB[st]}${c.unread ? `, ${c.unread} unread` : ''}" aria-pressed="${shown.includes(p.id)}" style="--ring:${RING[st]}">${av(p)}${c.unread ? `<span class="ub">${c.unread}</span>` : ''}${p.id === 'pa' ? '<span class="mstar"><img src="assets/emoji/star.png" alt=""></span>' : ''}<span class="nmtip">${esc(p.name)}${p.id === 'pa' ? ' (Manager)' : ''} . ${SLAB[st]}</span></div>`;
  }).join(''));

  // keep windows (and what the boss is typing) between renders
  for (const w of $$('.win', wins)) if (!shown.includes(w.dataset.win)) w.remove();
  shown.forEach((id, i) => {
    let w = $(`.win[data-win="${id}"]`, wins);
    if (!w) {
      w = document.createElement('div'); w.className = 'win'; w.dataset.win = id;
      w.innerHTML = `<div class="wh" data-min="${esc(id)}"></div><div class="wstrips"></div><div class="wb"></div>
        <div class="wf"><div class="box"><textarea rows="1" aria-label="Message ${esc(personOf(id).name)}" placeholder="Message ${esc(personOf(id).name)}..."></textarea><button class="btn pri send" title="Send" aria-label="Send">${icon('arrow-up')}</button></div>
        ${id !== 'pa' ? `<div class="cc">${icon('eye')}${esc(pa().name)} gets a summary of this chat</div>` : ''}</div>`;
      const ta = $('textarea', w);
      const send = async () => { const t = ta.value; if (!t.trim()) return; ta.value = ''; ta.style.height = ''; if (!(await sendChat(id, t))) ta.value = t; };
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
      ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(120, ta.scrollHeight)}px`; };
      $('.send', w).onclick = send;
      ta.onpaste = (e) => {
        const files = [...(e.clipboardData ? e.clipboardData.items : [])].filter((i) => i.kind === 'file' && IMG_TYPES.includes(i.type)).map((i) => i.getAsFile());
        if (!files.length) return; // text paste stays as it is
        e.preventDefault(); attachImages(ta, files);
      };
      const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
      w.ondragover = (e) => { if (!hasFiles(e)) return; e.preventDefault(); w.classList.add('drop'); };
      w.ondragleave = (e) => { if (!w.contains(e.relatedTarget)) w.classList.remove('drop'); };
      w.ondrop = (e) => {
        if (!hasFiles(e)) return; // text dropped into the box works as usual
        e.preventDefault(); w.classList.remove('drop');
        attachImages(ta, e.dataTransfer.files);
      };
    }
    if (wins.children[i] !== w) wins.insertBefore(w, wins.children[i] || null);
    const p = personOf(id), c = chatOf(id);
    const st = c.running ? 'working' : ((S.status.people[id] || {}).status || 'sleeping');
    w.classList.toggle('min', V.min.includes(id));
    redraw($('.wh', w), `${av(p)}<b>${esc(p.name)}</b>${id === 'pa' ? MGR : ''}<span class="badge ${st}"><i class="d ${st}"></i>${SLAB[st]}</span><div class="acts"><button class="ibtn" data-newchat="${esc(id)}" title="New conversation (${esc(p.name)} starts fresh; this chat stays above)" aria-label="New conversation with ${esc(p.name)}">${icon('refresh-cw')}</button><button class="ibtn" data-min="${esc(id)}" title="Minimise" aria-label="Minimise">${icon('minus')}</button><button class="ibtn" data-close="${esc(id)}" title="Close" aria-label="Close">${icon('x')}</button></div>`);
    const waits = id === 'pa' ? [] : pendingOks().filter((a) => a.from === id);
    const work = id === 'pa' ? (S.tasks || []) : (S.tasks || []).filter((t) => t.staff === id || t.from === id); // their own work, and what they asked a colleague
    redraw($('.wstrips', w), workLine(work) + waits.map((a) => `<div class="wstrip${hanaDeciding(a) ? ' hana' : ''}">${icon('hand')}<div class="sq"><b>${hanaDeciding(a) ? `${esc(pa().name)} is deciding` : 'Waiting for your OK'}</b>${esc(a.action)}</div>${a.kind === 'plan'
      ? `<button class="btn sm ok" data-review="${esc(a.id)}">Review plan</button>` // a plan is read (and maybe sent back with a note) in the drawer
      : `<button class="btn sm ok" data-ok="${esc(a.id)}" data-d="approved">Approve</button><button class="btn sm" data-ok="${esc(a.id)}" data-d="rejected">Reject</button>`}</div>`).join(''));
    const body = $('.wb', w);
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    const intro = id === 'pa' ? `${esc(p.name)} is your manager. Tell them what you need; they hand it to the right staff.` : `Direct chat with ${esc(p.name)} (${esc(p.role)}).`;
    const last = c.messages[c.messages.length - 1] || {};
    const sig = `${c.messages.length}|${last.at || ''}|${(last.text || '').length}|${intro}`;
    if (body.dataset.sig !== sig) { body.dataset.sig = sig; body.innerHTML = `<div class="wsys">${intro}</div>${c.messages.map((m) => msgHtml(id, m)).join('')}<div class="live"></div>`; }
    renderLive(id, true);
    if (atEnd || !body.dataset.seen) { body.scrollTop = body.scrollHeight; body.dataset.seen = '1'; }
    $('textarea', w).placeholder = c.running ? `Message ${p.name}... (goes next, after this reply)` : `Message ${p.name}...`;
  });
  if (S.view === 'office') fitOffice();
  renderWork();
}

// ------------------------------------------------------------------ work board: what staff are doing now
// Office view: a panel in the top-left corner that folds to a slim bar. Other pages: a dropdown under
// the "working" count in the top bar. Chat windows only get one thin line, so the chat stays visible.
const WKEY = 'aio.workMin';
let workMin = false, workPop = false;
try { workMin = localStorage.getItem(WKEY) === '1'; } catch { /* private window: start open */ }
const nameOfStaff = (id) => (personOf(id) || { name: id }).name;
// tasks that wait for other tasks (after:), with what they wait for: "Waiting for Siti" or the task's title
// pool tasks (staff: any) wait for whoever is free first: "Waiting for a free Sales"
const waitingOf = (list = []) => list.filter((t) => t.waiting || t.pool || t.status === 'plan-ready' || (t.status === 'forwarded' && !t.dismissed && !gone.includes(t.id))).map((t) => {
  if (t.status === 'forwarded') return { ...t, waitFor: '', forwarded: true }; // a staff asked a colleague: it went to the manager
  if (t.status === 'plan-ready') { const a = S.approvals.find((x) => x.id === t.approval); return { ...t, waitFor: a && hanaDeciding(a) ? `${pa().name} to decide the plan` : 'your OK on the plan' }; }
  if (t.pool && !t.waiting) return { ...t, waitFor: '' }; // worked out when drawn: who is busy changes all the time
  const deps = (t.after || []).map((a) => list.find((x) => x.id === a));
  const d = deps.find((x) => x && x.status !== 'done');
  return { ...t, waitFor: d ? (d.status === 'working' ? nameOfStaff(d.staff) : d.title || d.id) : deps.some((x) => !x) ? 'a task that is not there yet' : '' };
});
const isPoolId = (x) => !x || String(x).toLowerCase() === 'any';
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const roleWords = (x) => String(x || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// pool task: "a free Sales staff (Siti, Zul are busy)", same role match as lib/tasks.js fits()
function poolWait(t) {
  const w = roleWords(t.role), fit = S.staff.filter((s) => s.id !== t.from && (!w.length || roleWords(s.role).some((x) => w.includes(x))));
  const busy = fit.filter((s) => (S.tasks || []).some((x) => x.staff === s.id)).map((s) => s.name);
  const who = busy.length ? ` (${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} busy)` : '';
  return `${t.role ? `a free ${cap(t.role)} staff` : 'anyone free'}${who}`;
}
// Failed tasks the boss has not run again or dismissed. Dismissed ones are also kept in this browser, because
// the server's dismiss only marks restart-stopped tasks for now.
const FKEY = 'aio.dismissed';
let gone = [];
try { gone = JSON.parse(localStorage.getItem(FKEY) || '[]'); } catch { /* private window: none */ }
const failedOf = (list = []) => list.filter((t) => t.status === 'failed' && !t.dismissed && t.interrupted !== 'dismissed' && !gone.includes(t.id) && !list.some((x) => x.again === t.id))
  .map((t) => ({ ...t, why: String(t.result || '').split('\n').map((l) => l.trim()).find(Boolean) || 'No reason given.' }));
// a failed task that never started because the boss stopped a task before it (also down a chain: A stopped,
// so B failed, so C failed): nothing went wrong, it shows grey
const stoppedBefore = (t, list = S.taskList || [], seen = new Set()) => {
  if (/which was stopped/.test(t.why || t.result || '')) return true;
  const m = /waits for task "([^"]+)".*which failed/.exec(t.why || t.result || ''), d = m && !seen.has(m[1]) && list.find((x) => x.id === m[1]);
  return !!d && (seen.add(m[1]), stoppedBefore(d, list, seen));
};
function applyTasks(r) {
  S.taskList = r.list || [];
  S.tasks = (r.active || []).map((a) => ({ ...a, ...(S.taskList.find((t) => t.id === a.id) || {}) }));
  S.waiting = waitingOf(S.taskList);
  S.interrupted = r.interrupted || [];
  S.failed = failedOf(S.taskList);
}
const loadTasks = () => api('tasks').then(applyTasks);
// how many waiting tasks start only after this one (also through each other): they are cancelled when it stops
function downstream(id) {
  const list = S.taskList || [], out = new Set(), walk = (x) => list.forEach((t) => { if (t.status === 'new' && (t.after || []).includes(x) && !out.has(t.id)) { out.add(t.id); walk(t.id); } });
  walk(id); return out.size;
}
const since = (iso) => { const m = Math.floor((Date.now() - Date.parse(iso)) / 60000); return Number.isNaN(m) ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
function workLine(work) {
  if (!work.length) return '';
  if (work.length === 1) {
    const t = work[0];
    return `<div class="wstrip work one" data-task="${esc(t.id)}">${icon('clock')}<div class="sq"><b>${esc(nameOfStaff(t.staff))}:</b> ${esc(t.title || t.id)}<span class="now">${t.status === 'planning' ? 'Planning: ' : ''}${esc(t.step || 'Starting')}</span></div><button class="btn sm" data-stoptask="${esc(t.id)}">Stop</button></div>`;
  }
  return `<div class="wstrip work one link" data-work="open" role="button" tabindex="0">${icon('clock')}<div class="sq"><b>${work.length} staff working:</b> ${esc(work.map((t) => nameOfStaff(t.staff)).join(', '))}</div><span class="more">Show</span></div>`;
}
function renderWork() {
  let el = $('#work');
  if (!el) { el = document.createElement('div'); el.id = 'work'; document.body.append(el); }
  const work = S.tasks || [], cut = S.interrupted || [], wait = S.waiting || [], fail = S.failed || [], office = S.view === 'office';
  if (!work.length && !cut.length && !wait.length && !fail.length) workPop = false;
  el.hidden = !((work.length || cut.length || wait.length || fail.length) && (office || workPop));
  if (el.hidden) return;
  el.className = office ? `board${workMin ? ' min' : ''}` : 'pop';
  if (office) el.style.left = '';
  else { const r = $('#stat').getBoundingClientRect(); el.style.left = `${Math.max(8, Math.min(r.left - 10, innerWidth - 338))}px`; }
  const heads = [...new Set(work.map((t) => t.staff))].map(personOf).filter(Boolean).slice(0, 5).map((p) => av(p)).join('');
  const open = !office || !workMin;
  const real = fail.filter((t) => !stoppedBefore(t)).length;
  const label = [work.length ? `${work.length} working` : '', wait.length ? `${wait.length} waiting` : '', cut.length ? `${cut.length} interrupted` : '', real ? `${real} could not finish` : ''].filter(Boolean).join(', ') || `${fail.length} not started`;
  redraw(el, `<div class="wkh" data-work="${office ? 'fold' : 'close'}" role="button" tabindex="0" aria-expanded="${open}" title="${office ? (open ? 'Fold' : 'Show the list') : 'Close'}"><i class="d ${work.length ? 'working' : 'waiting'}"></i><b>${label}</b><span class="heads">${heads}</span>${icon(office ? 'chevron-down' : 'x')}</div>`
    + (open ? `<div class="wkl">${work.map((t) => {
      const p = personOf(t.staff) || { name: t.staff }, asked = t.from && t.from !== 'pa' && t.from !== t.staff ? personOf(t.from) : null;
      const by = asked ? asked.name : t.from === 'office' ? 'the office' : ''; // office: work the office made by itself (an approved action, the idle hook)
      return `<div class="wk" data-task="${esc(t.id)}">${p.colour ? av(p) : ''}<div class="sq"><div class="l1"><b>${esc(p.name)}</b><span class="faint">${since(t.created)}</span></div><div class="ti">${esc(t.title || t.id)}${by ? ` <span class="faint">(${asked ? 'asked by' : 'from'} ${esc(by)})</span>` : ''}</div><span class="now">${t.status === 'planning' ? 'Planning: ' : ''}${esc(t.step || 'Starting')}</span></div><button class="btn sm" data-stoptask="${esc(t.id)}">Stop</button></div>`;
    }).join('')}${wait.map((t) => {
      const p = (!t.pool && personOf(t.staff)) || { name: t.pool ? (t.role ? `${cap(t.role)} team` : 'Anyone free') : t.staff };
      const review = t.status === 'plan-ready' && t.approval ? ` data-review="${esc(t.approval)}" role="button" tabindex="0" title="Open the plan in Needs your OK"` : '';
      if (t.forwarded) { const f = personOf(t.from) || { name: t.from }; // not run: the manager decides what to do with it
        return `<div class="wk wait fwd" data-task="${esc(t.id)}">${f.colour ? av(f, 'grey') : ''}<div class="sq"><div class="l1"><b>${esc(f.name)}</b><span class="faint">${since(t.created)}</span></div><div class="ti">${esc(t.title || t.id)}</div><span class="now">Sent to ${esc(pa().name)} (asked for ${esc(isPoolId(t.staff) ? 'anyone free' : nameOfStaff(t.staff))})</span></div><button class="btn sm" data-dismiss="${esc(t.id)}">Dismiss</button></div>`; }
      return `<div class="wk wait${t.pool ? ' pool' : ''}${review ? ' link' : ''}" data-task="${esc(t.id)}"${review}>${p.colour ? av(p, 'grey') : ''}<div class="sq"><div class="l1"><b>${esc(p.name)}</b><span class="faint">${since(t.created)}</span></div><div class="ti">${esc(t.title || t.id)}</div><span class="now">Waiting for ${esc(t.pool && !t.waiting ? poolWait(t) : t.waitFor || 'another task')}</span></div><button class="btn sm" data-stoptask="${esc(t.id)}">Stop</button></div>`;
    }).join('')}${fail.length ? `<div class="wkcut">Could not finish</div>${fail.map((t) => {
      const p = personOf(t.staff) || { name: isPoolId(t.staff) ? (t.role ? `${cap(t.role)} team` : 'The team') : t.staff }, grey = stoppedBefore(t);
      return `<div class="wk fail${grey ? ' cut' : ''}" data-task="${esc(t.id)}">${p.colour ? av(p, 'grey') : ''}<div class="sq"><div class="l1"><b>${esc(p.name)}</b><span class="faint">${t.finished ? when(t.finished) : ''}</span></div><div class="ti">${esc(t.title || t.id)}</div><span class="why">${grey ? 'Not started: the task before it was stopped.' : esc(t.why)}</span></div><div class="wkb"><button class="btn sm ok" data-rerun="${esc(t.id)}">Run again</button><button class="btn sm" data-dismiss="${esc(t.id)}">Dismiss</button></div></div>`;
    }).join('')}` : ''}${cut.length ? `<div class="wkcut">Stopped by a restart</div>${cut.map((t) => {
      const p = personOf(t.staff) || { name: t.staff };
      return `<div class="wk cut">${p.colour ? av(p, 'grey') : ''}<div class="sq"><div class="l1"><b>${esc(p.name)}</b><span class="faint">${t.finished ? when(t.finished) : ''}</span></div><div class="ti">${esc(t.title || t.id)}</div></div><div class="wkb"><button class="btn sm ok" data-rerun="${esc(t.id)}">Run again</button><button class="btn sm" data-dismiss="${esc(t.id)}">Dismiss</button></div></div>`;
    }).join('')}` : ''}</div>` : ''));
}
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-rerun],[data-dismiss]'); if (!r) return;
  r.disabled = true;
  const id = r.dataset.rerun || r.dataset.dismiss;
  const hide = () => { S.interrupted = (S.interrupted || []).filter((t) => t.id !== id); S.failed = (S.failed || []).filter((t) => t.id !== id); S.waiting = (S.waiting || []).filter((t) => t.id !== id); renderWork(); };
  api(`tasks/${encodeURIComponent(id)}/${r.dataset.rerun ? 'rerun' : 'dismiss'}`, 'POST')
    .then(() => {
      if (r.dataset.dismiss && [...(S.failed || []), ...(S.waiting || [])].some((t) => t.id === id)) { gone = [...gone.slice(-199), id]; try { localStorage.setItem(FKEY, JSON.stringify(gone)); } catch { /* this tab only */ } }
      hide(); toast(r.dataset.rerun ? 'Started again' : 'Dismissed');
    }, (er) => { r.disabled = false; toast(er.message, true); });
});
setInterval(() => { if ($('#work') && !$('#work').hidden) renderWork(); renderUsage(); }, 30000);

// ------------------------------------------------------------------ usage: plan limits and tokens (bottom left)
// Every dashboard run reports the account's 5-hour and weekly limits and its own tokens; the server keeps the latest.
let usageOpen = false;
const fmtN = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const fmtUsd = (n) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;
const until = (iso) => { const m = Math.round((Date.parse(iso) - Date.now()) / 60000); if (!(m > 0)) return 'now'; const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`; };
const level = (pct) => (pct >= 95 ? 'red' : pct >= 80 ? 'amber' : 'ok');
function renderUsage() {
  let el = $('#usage');
  if (!el) { el = document.createElement('div'); el.id = 'usage'; document.body.append(el); el.addEventListener('click', (e) => { if (e.target.closest('.ubar')) { usageOpen = !usageOpen; renderUsage(); } }); }
  const u = S.usage || {}, L = u.limits || {}, five = L.five_hour, week = L.seven_day, today = (u.today || { tokens: 0, cost: 0, people: {} });
  const meter = (label, w) => (w ? `<span class="um ${level(w.used)}"><b>${label}</b><i><s style="width:${Math.min(100, w.used)}%"></s></i>${w.used}%</span>` : '');
  const worst = Math.max(five ? five.used : 0, week ? week.used : 0);
  const bar = `<div class="ubar ${level(worst)}${usageOpen ? ' open' : ''}" data-usage="plan" role="button" tabindex="0" aria-expanded="${usageOpen}" title="Claude plan use. Click for details.">${five || week ? meter('5h', five) + meter('Week', week) : '<span class="faint">Plan use shows after the first chat or task</span>'}${five && five.resets ? `<span class="faint">resets ${until(five.resets)}</span>` : ''}<span class="sep2"></span><span>Today <b>${fmtN(today.tokens)}</b> tokens</span>${icon('chevron-down')}</div>`;
  let panel = '';
  if (usageOpen) {
    const lim = (label, w) => (w ? `<div class="ul"><div class="ulh"><b>${label}</b><span>${w.used}% used</span><span class="faint">${w.resets ? `resets in ${until(w.resets)}` : ''}</span></div><i class="${level(w.used)}"><s style="width:${Math.min(100, w.used)}%"></s></i></div>` : '');
    const rows = (t) => Object.entries(t.people || {}).sort((a, b) => b[1].tokens - a[1].tokens).map(([id, p]) => `<tr><td>${esc(nameOf(id === 'pa' ? '' : id) || pa().name)}</td><td>${p.runs}</td><td>${fmtN(p.tokens)}</td><td>${fmtUsd(p.cost)}</td></tr>`).join('') || '<tr><td colspan="4" class="faint">Nothing yet</td></tr>';
    const table = (title, t) => `<div class="ut"><div class="uth"><b>${title}</b><span>${fmtN(t.tokens || 0)} tokens, ${fmtUsd(t.cost || 0)}</span></div><table><tr><th>Who</th><th>Runs</th><th>Tokens</th><th>Cost</th></tr>${rows(t)}</table></div>`;
    panel = `<div class="upanel">
      ${five || week ? `${lim('5-hour limit', five)}${lim('Weekly limit', week)}<div class="faint unote">For your whole Claude account. Last updated ${L.at ? when(L.at) : 'never'} (updates when someone works).</div>` : '<div class="faint unote">Plan limits show after the first chat or staff task.</div>'}
      ${table('Today', today)}${table('Last 7 days', u.week || {})}
      <div class="faint unote">Counts chats and staff tasks run from this dashboard. Cost is the API price; on a Claude subscription you are not billed this.</div></div>`;
  }
  redraw(el, panel + bar);
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-work],#stat');
  if (!t) { if (workPop && !e.target.closest('#work')) { workPop = false; renderWork(); } return; }
  if (![S.tasks, S.interrupted, S.waiting, S.failed].some((x) => (x || []).length)) { toast('Nobody is working on a task right now'); return; }
  const want = t.id === 'stat' ? 'toggle' : t.dataset.work;
  if (S.view === 'office') workMin = want === 'open' ? false : !workMin;
  else workPop = want === 'open' ? true : want === 'close' ? false : !workPop;
  try { localStorage.setItem(WKEY, workMin ? '1' : '0'); } catch { /* not saved, fine */ }
  renderWork();
});

document.addEventListener('click', (e) => {
  const f = e.target.closest('a.fpath[data-open]');
  if (f) { e.preventDefault(); api('open', 'POST', { path: f.dataset.open }).then((r) => toast(r.how === 'reveal' ? 'Shown in its folder (it is a program, so it was not run)' : 'Opening on your computer'), (er) => toast(er.message, true)); }
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-chat],[data-close],[data-min],[data-stop],[data-ask],[data-newchat],[data-copy],[data-stoptask]');
  if (!t) return;
  if (t.dataset.chat) { const id = t.dataset.chat; if (V.open[0] === id && !V.min.includes(id)) closeChat(id); else openChat(id); }
  else if (t.dataset.close) { e.stopPropagation(); closeChat(t.dataset.close); }
  else if (t.dataset.min) { e.stopPropagation(); toggleMin(t.dataset.min); }
  else if (t.dataset.stop) { t.disabled = true; api(`chat/${t.dataset.stop}/stop`, 'POST').catch((er) => { t.disabled = false; toast(er.message, true); }); }
  else if (t.dataset.stoptask) {
    const id = t.dataset.stoptask, n = downstream(id);
    if (n && !confirm(`Stop this task? ${n} ${n === 1 ? 'task is' : 'tasks are'} waiting for this one and will be cancelled.`)) return;
    t.disabled = true; // one click, one stop
    api(`tasks/${encodeURIComponent(id)}/stop`, 'POST').then((r) => {
      if (!r.ok) { t.disabled = false; toast('This task already ended.'); return; }
      S.waiting = (S.waiting || []).filter((x) => x.id !== id); renderWork(); toast('Task stopped');
    }, (er) => { t.disabled = false; toast(er.message, true); });
  }
  else if (t.dataset.newchat) { e.stopPropagation(); api(`chat/${t.dataset.newchat}/new`, 'POST').then(() => toast('New conversation started'), (er) => toast(er.message, true)); }
  else if (t.hasAttribute('data-copy')) {
    const code = t.parentElement.querySelector('code').textContent;
    const done = () => { t.textContent = 'Copied'; setTimeout(() => { t.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, () => toast('Could not copy. Select the text instead.', true));
  }
  else if (t.dataset.ask) { const a = S.approvals.find((x) => x.id === t.dataset.ask); if (a) openChat(a.from, `About "${a.action}": `); }
});
window.addEventListener('resize', () => renderChats());

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-review]');
  if (r && !e.target.closest('[data-stoptask]')) openOkAt(r.dataset.review);
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go],[data-oktoggle],#okStat,[data-ok]');
  if (!t) return;
  if (t.dataset.go) go(t.dataset.go);
  else if (t.id === 'okStat' || t.hasAttribute('data-oktoggle')) {
    // the pill is hidden while the drawer is open, so focus goes to the drawer on open and back to the pill on close
    S.okOpen = !S.okOpen; renderOk(); renderChats();
    const dr = $('#okDrawer'); dr.tabIndex = -1;
    if (S.okOpen) dr.focus(); else ($('#okStat') || document.body).focus();
  }
  else if (t.dataset.ok) {
    t.disabled = true;
    const note = t.dataset.d === 'rejected' ? notes[t.dataset.ok] || '' : ''; // plan items: a note sends it back for a new plan
    act(() => api(`approvals/${encodeURIComponent(t.dataset.ok)}/decide`, 'POST', { decision: t.dataset.d, ...(note.trim() ? { note: note.trim() } : {}) }), t.dataset.d === 'approved' ? 'Approved. The staff will see it.' : note.trim() ? 'Sent back for a new plan.' : 'Rejected.')
      .then(() => { delete notes[t.dataset.ok]; return refresh(['approvals']); }, () => { t.disabled = false; });
  }
});
window.addEventListener('hashchange', () => go(location.hash.slice(1)));
window.addEventListener('beforeunload', (e) => { if (S.dirty.size) { e.preventDefault(); e.returnValue = ''; } });

async function refresh(areas) {
  await load(areas.filter((a) => a !== 'events'));
  render();
}

// Live refresh: the server says which part of the office folder changed.
function live() {
  let fails = 0, bar = null;
  const es = new EventSource(`/api/stream?key=${encodeURIComponent(KEY)}`);
  es.addEventListener('status', (e) => {
    S.status = JSON.parse(e.data);
    renderTop();
    if (S.view === 'office') renderOffice();
    if (S.view === 'staff' && $('#staffList')) renderStaff(true);
    renderChats();
  });
  es.addEventListener('chat', (e) => {
    const { id, msg } = JSON.parse(e.data);
    const c = chatOf(id);
    if (c.loaded) c.messages.push(msg);
    if (msg.from === id) c.live = { ...(c.live || {}), text: '' };
    const visible = V.open.slice(0, 8).includes(id) && !V.min.includes(id);
    if (!visible && msg.from !== 'boss') c.unread++;
    renderChats();
  });
  es.addEventListener('cleared', () => {
    for (const k of Object.keys(C)) delete C[k];
    prevPeople = null;
    load().then(async () => {
      S.status = await api('status');
      await Promise.all(V.open.map(async (id) => { if (!personOf(id)) return; const h = await api(`chat/${id}`).catch(() => null); if (h) Object.assign(chatOf(id), { messages: h.messages, running: h.running, loaded: true }); }));
      render();
    });
  });
  es.addEventListener('doctools', (e) => { S.doctools = JSON.parse(e.data); const l = $('.dtline'); if (l) l.outerHTML = docToolsLine(); }); // in place: keeps unsaved edits
  es.addEventListener('usage', (e) => { S.usage = JSON.parse(e.data); renderUsage(); });
  es.addEventListener('tasks', (e) => { const act = JSON.parse(e.data); loadTasks().then(renderChats, (er) => console.warn('Could not refresh tasks:', er)); S.tasks = act; renderChats(); });
  es.addEventListener('chatlive', (e) => { const { id, step, text } = JSON.parse(e.data); const c = chatOf(id); c.live = { step, text }; if (c.running && !c.since) c.since = Date.now(); renderLive(id); });
  es.addEventListener('taskstep', (e) => {
    const x = JSON.parse(e.data);
    const t = (S.tasks || []).find((y) => y.id === x.id); if (t) t.step = x.step;
    for (const n of $$(`[data-task="${CSS.escape(x.id)}"] .now`)) n.textContent = x.step;
    if (S.view === 'office') draw3d();
  });
  es.addEventListener('chatstate', (e) => { const { id, running } = JSON.parse(e.data); const c = chatOf(id); c.running = running; c.since = running ? (c.since || Date.now()) : null; if (!running) c.live = null; renderChats(); });
  es.addEventListener('changed', (e) => {
    const areas = JSON.parse(e.data).map((a) => (a === 'office' ? ['office', 'staff'] : a === 'staff' ? ['staff', 'office'] : [a])).flat();
    if (areas.includes('tasks')) loadTasks().then(renderChats, (er) => console.warn('Could not refresh tasks:', er)); // a task file came or changed: waiting, failed
    const rest = [...new Set(areas)].filter((a) => !['events', 'tasks', 'mail'].includes(a));
    if (rest.length) refresh(rest).catch((er) => console.warn('Could not refresh the dashboard:', er));
  });
  es.onopen = () => { fails = 0; if (bar) { bar.remove(); bar = null; load().then(render); } };
  es.onerror = () => {
    if (++fails >= 2 && !bar) { bar = document.createElement('div'); bar.className = 'offline'; bar.setAttribute('role', 'alert'); bar.textContent = 'The office server stopped. Start it again from the office folder, then this page reconnects.'; document.body.append(bar); }
  };
}

(async () => {
  try { await load(); S.status = await api('status'); S.presets = await api('presets'); S.usage = await api('usage').catch(() => null); S.linked = await api('linked').catch(() => []); S.run = await api('run').catch(() => null); S.doctools = await api('doctools').catch(() => null); } catch (e) { document.body.innerHTML = `<div class="empty"><b>Cannot load the office</b>${esc(e.message)}</div>`; return; }
  const run = await api('chats').catch(() => ({ running: [] }));
  applyTasks(await api('tasks').catch(() => ({ active: [], list: [] })));
  run.running.forEach((id) => { chatOf(id).running = true; });
  go(location.hash.slice(1) || 'office');
  await Promise.all(V.open.map(async (id) => { if (!personOf(id)) return; const h = await api(`chat/${id}`).catch(() => null); if (h) Object.assign(chatOf(id), { messages: h.messages, running: h.running, loaded: true }); }));
  renderChats();
  live();
})();

// light/dark: follows macOS until the user picks one; the pick is remembered (try/catch: private windows)
const THEME_KEY = 'ai-office-theme';
const sysDark = matchMedia('(prefers-color-scheme: dark)');
const savedTheme = () => { try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; } };
const shownTheme = () => document.documentElement.dataset.theme || (sysDark.matches ? 'dark' : 'light');
function renderTheme() {
  const next = shownTheme() === 'dark' ? 'light' : 'dark';
  const b = $('#theme');
  b.innerHTML = next === 'light'
    ? '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
  b.setAttribute('aria-label', `Switch to ${next} mode`); b.title = `Switch to ${next} mode`;
}
$('#theme').onclick = () => {
  const next = shownTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* not saved, fine */ }
  renderTheme();
};
sysDark.addEventListener('change', () => { if (!savedTheme()) renderTheme(); });
renderTheme();
