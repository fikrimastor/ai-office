// AI Office hook. Claude Code runs this on session, tool and staff events.
// It only appends one line to events.jsonl in this same folder, so the
// dashboard can show who is working. It sends nothing anywhere.
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let h;
  try { h = JSON.parse(raw); } catch { return; }
  const input = h.tool_input || {};
  const resp = h.tool_response || {};
  const cut = (s) => (typeof s === 'string' ? s.slice(0, 300) : undefined);
  const line = {
    at: new Date().toISOString(),
    ev: h.hook_event_name,
    sid: h.session_id,
    aid: h.agent_id || resp.agentId,
    staff: h.agent_type || input.subagent_type,
    tool: h.tool_name,
    task: cut(input.description),
    file: input.file_path,
    msg: cut(input.message || h.last_assistant_message || h.message || h.prompt),
    cwd: h.cwd,
    who: process.env.AI_OFFICE_STAFF, // which office run (pa or a staff id): the office uses it to check who wrote a message
  };
  for (const k of Object.keys(line)) if (line[k] == null || line[k] === '') delete line[k];
  fs.appendFileSync(path.join(__dirname, 'events.jsonl'), JSON.stringify(line) + '\n');
});
