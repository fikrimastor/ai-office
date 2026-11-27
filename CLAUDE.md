# AI Office

Free public tool: `npx github:fikrimastor/ai-office#personal` runs a setup wizard, creates an office folder
(a PA called Hana + 1 to 8 AI staff as Claude Code subagents), and starts a local dashboard at
http://localhost:4747 (Office view, Talk to Hana, Needs your OK, Staff, Projects, Inbox).
Users run it on their own Claude account through their own Claude Code.

## Status

- 2026-11-23: v1 design agreed (purple top bar, Messenger-style chat dock, approvals drawer, archive with reactivate or delete). No build until the owner says "build it".
- 2026-11-24: design tweaks agreed. Approvals button floats top right of the Office view only (not in the top bar). Hana = PA = manager (one role, oversees all work), shown with a black Manager badge. Office: glass Boss Room, Hana's desk outside it, Customer Service (Aina) and the queue outside on the pavement. First load: 140% zoom, only Hana's chat; view remembered per tab until a hard refresh.
- 2026-11-24: owner said "build it". Milestone 1 (tests) done: docs/milestone-1-findings.md. Milestone 2 (wizard + folder generator) done: bin/, lib/, office-files/, npm test.
- 2026-11-24: install is Claude-first (INSTALL.md, private Node in ~/.ai-office/node, --answers), file tools pre-allowed inside the office. Milestone 3 (server + dashboard: Staff, Projects, Inbox, Needs your OK, Settings, live refresh, Start AI Office launcher) done: lib/server.js, lib/office.js, dashboard/.
- 2026-11-24: Milestone 4 (live office) done: lib/status.js turns hook events into who is working; dashboard/office3d.js builds the 3D office from office.json (PA by the boss room, customer-service role at the outside booth, up to 8 desks), three.js and fonts bundled.
- 2026-11-24: Milestone 5 (Talk to Hana) done: lib/chat.js runs claude -p per message (resume per person, stream-json, fixed tool list), dashboard dock + windows, staff chat summaries to .office/staff-chats.md. Next: Milestone 6 (README + landing page, owner tests on Windows).
- 2026-11-24 (after M5, from owner testing on Windows): animated office, approvals history, linked folders (chats locked to office + linked), allowed commands per staff via .office/guard.js, task-based delegation (tasks/ + lib/tasks.js, Hana free while staff work), staff-to-colleague requests, live chat steps + streaming. Open: warm Claude per chat, launcher redesign (EBUSY/offline), office in WSL, Milestone 6.
- 2026-11-25 (fresh-install tests on Windows): setup asks one question at a time, invois.online MCP at user scope + login step, staff tasks get invois tools (also via the claude.ai connector names), Ask first / Always allow for send and pay actions (grants in .office/grants.json, checked by the guard, staff auto-started on Approve), PA renamed Manager, role badges. Next: owner's fresh install test, then email channel (Gmail connector) and a Chrome-browser channel spike.
- 2026-11-25 (after the fresh install): staff work list moved out of the chat into a work board (top-left of the office, dropdown from the top bar count). Owner's tab crashed with Out of Memory; no leak found in tests, 3D made lighter: one WebGL renderer for the page's life, shared geometry, canvases freed after upload, shadows redrawn only on movement, customer queue updated in place (no rebuild), drawing buffer follows zoom. Team desks in a 3-per-row grid with gaps. Slim scrollbars.
- 2026-11-25 (afternoon): usage bar (bottom left), clickable file paths, attached name tags, WSL support (files open via Explorer, start with ./start-office.sh), Office documents on by default (lib/doctools.js installs pptxgenjs, exceljs, docx, resvg-js into .office/doc-tools; PDF/PNG via Edge or Chrome), model/effort per person (Manager Opus, staff Sonnet, medium), token use cut ~14x, cost ~6x (--strict-mcp-config or no claude.ai connectors, fresh chat with recap past 100k), LICENSE, README for beta. Fresh Windows install from GitHub verified. Next: announce as beta v0.1.
- Design doc and mock-ups live in `design/` (gitignored, local only).

## Rules for this repo

- Plain Node, no shell-specific tricks: must run on Windows and Mac (Mac untested).
- Keep dependencies near zero. The office server listens on localhost only.
- Never store or send user credentials. Everything stays in the user's office folder.
- Hooks scripts stay tiny and readable: users must be able to trust them.
- It is a base, not a closed app: keep the file contracts (inbox/, approvals/, staff Tools section, events, local API) stable and documented in the generated OFFICE.md, so users can extend their office with their own Claude.
