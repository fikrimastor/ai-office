// Tiny helpers for the office's Markdown files: a "---" header of "key: value"
// lines, and "## Heading" sections. Edits change only the lines they touch.

const NL = /\r?\n/;

// "value   # comment" -> "value" (a # only starts a comment after a space and before a space)
const clean = (v) => v.replace(/\s+#\s.*$/, '').trim();

// A header value may also be a YAML list: "after:" then "  - id" lines (read as "id, id").
function parse(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(NL); // a BOM (Windows Notepad) is not part of the header
  const fields = {};
  if (lines[0] !== '---') return { fields, body: text, head: false };
  let i = 1, last = null;
  for (; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(lines[i]);
    const item = last && /^\s+-\s+(.*)$/.exec(lines[i]);
    if (m) { fields[m[1]] = clean(m[2]); last = fields[m[1]] ? null : m[1]; }
    else if (item) fields[last] = [fields[last], clean(item[1])].filter(Boolean).join(', ');
    else last = null;
  }
  return { fields, body: lines.slice(i + 1).join('\n').replace(/^\n+/, ''), head: true };
}

// Set header fields, keeping every other line (and its comments) as it was.
function setFields(text, fields) {
  let lines = String(text).replace(/^\uFEFF/, '').split(NL);
  if (lines[0] !== '---') lines = ['---', '---', ...lines];
  let end = lines.indexOf('---', 1);
  for (const [k, v] of Object.entries(fields)) {
    const line = `${k}: ${v == null ? '' : String(v).replace(NL, ' ')}`.trimEnd();
    const at = lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${k}:`).test(l));
    if (at > 0) {
      lines[at] = line;
      let items = 0; while (at + 1 + items < end && /^\s+-\s/.test(lines[at + 1 + items])) items++; // its old YAML list items
      if (items) { lines.splice(at + 1, items); end -= items; }
    } else { lines.splice(end, 0, line); end++; }
  }
  return lines.join('\n');
}

function make(fields, body) {
  const head = Object.entries(fields).map(([k, v]) => `${k}: ${v == null ? '' : String(v).replace(NL, ' ')}`.trimEnd());
  return ['---', ...head, '---', String(body || '').trim(), ''].join('\n');
}

// "## Heading" section content (without the heading line), or null. { last: true }: the last such heading.
const headAt = (lines, heading, last) => {
  const is = (l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase();
  return last ? lines.map(is).lastIndexOf(true) : lines.findIndex(is);
};
function section(text, heading, { last } = {}) {
  const lines = text.split(NL);
  const start = headAt(lines, heading, last);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function setSection(text, heading, content, { last } = {}) {
  const lines = text.split(NL);
  const start = headAt(lines, heading, last);
  const block = ['', String(content).trim(), ''];
  if (start < 0) return `${text.replace(/\s+$/, '')}\n\n## ${heading}\n${block.join('\n')}`;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

// "- item" lines of a section
const bullets = (s) => (s || '').split(NL).map((l) => /^\s*[-*]\s+(.*)$/.exec(l)).filter(Boolean).map((m) => m[1].trim());

module.exports = { parse, setFields, make, section, setSection, bullets };
