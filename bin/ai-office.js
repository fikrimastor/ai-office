#!/usr/bin/env node
// AI Office: run the setup wizard, or start the office if this folder is one.

const path = require('path');
const pkg = require('../package.json');

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`AI Office needs Node.js 18 or newer (you have ${process.versions.node}). Get it at https://nodejs.org`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

if (flag('--help') || flag('-h')) {
  console.log(`AI Office ${pkg.version}

  npx github:fikrimastor/ai-office            Set up a new office (wizard), or start the office
                                          when run inside an office folder
Options:
  --dir <folder>    Office folder (default: ask)
  --yes             Accept every default, no questions
  --port <n>        Dashboard port (default: from office.json, 4747)
  --no-open         Do not open the browser
  --no-start        After setup, do not start the dashboard
  --answers <file>  Take the answers from a JSON file (see INSTALL.md)
  --version         Show the version`);
  process.exit(0);
}
if (flag('--version')) { console.log(pkg.version); process.exit(0); }

const G = require('../lib/generate');

// Open the dashboard in the default browser. Best effort: the URL is printed anyway.
function openBrowser(url) {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const wsl = process.platform === 'linux' && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  const [cmd, args, extra] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
    : process.platform === 'darwin' ? ['open', [url]]
    : wsl ? ['cmd.exe', ['/c', 'start', url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true, ...(extra || {}) }); c.on('error', () => {}); c.unref(); } catch { /* print only */ }
}
const here = path.resolve(value('--dir') || '.');

(async () => {
  if (G.isOffice(here)) {
    const fixed = [...G.refreshScripts(here), ...G.repairSettings(here)];
    const l = G.writeLauncher(here); if (l) fixed.push(l);
    if (fixed.length) console.log(`Updated office paths in: ${fixed.join(', ')}`);
    const { start } = require('../lib/server');
    const r = await start(here, { port: Number(value('--port')) || undefined });
    const url = `http://localhost:${r.port}`;
    if (r.already) console.log(`Your office is already running: ${url}`);
    else console.log(`\nAI Office is running: ${url}\nKeep this window open. Press Ctrl+C to stop.\n`);
    if (!flag('--no-open')) openBrowser(url);
    if (r.already) return 0;
    const stop = async () => { console.log('\nStopped.'); if (r.close) await r.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return new Promise(() => {}); // keep running
  }
  const { wizard } = require('../lib/wizard');
  return wizard({ yes: flag('--yes'), dir: value('--dir'), answers: value('--answers'), skipCheck: flag('--skip-check'), noStart: flag('--no-start'), openBrowser: flag('--no-open') ? null : openBrowser });
})().then((code) => { process.exitCode = code || 0; }, (e) => { console.error(e.stack || e); process.exitCode = 1; });
