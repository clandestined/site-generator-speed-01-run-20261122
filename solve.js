// site-generator-speed-01-run-20261122 — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input, byte for byte: same front matter refusals,
// same slugs, same Markdown rendering, same template output, same report.
// It is a fresh implementation of the rules in makefun-site's README, written
// for speed: templates are compiled once per case into plain JavaScript,
// Markdown is rendered in a single pass that jumps between special
// characters instead of escaping every character through a regex, and slug /
// long-date results are cached inside one run (never across cases).

// ------------------------------------------------------------------ helpers

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_SPECIAL = /[&<>"']/;
const SPECIAL_G = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast path when nothing needs it. */
function esc(text) {
  if (!HAS_SPECIAL.test(text)) return text;
  return text.replace(SPECIAL_G, (c) => ESCAPES[c]);
}

/** The characters a backslash escapes in inline Markdown. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
/** The same characters, as code units, for the charCodeAt scans. */
const ESCAPABLE_CODES = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Whether code unit `c` is whitespace in the /\s/ sense. */
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 32) {
      // No ASCII whitespace is above 32; above 127 it may still be a
      // Unicode space, which the full check settles.
      if (c < 128 || !isSpaceCode(c)) {
        if (!inWord) { inWord = true; n++; }
      } else inWord = false;
    } else if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) inWord = false;
    else if (!inWord) { inWord = true; n++; } // other control characters are word characters
  }
  return n;
}

// ---------------------------------------------------------------------- slugs

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;
const COMBINING = /\p{M}/gu;

function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  // NFKD and the combining-mark drop are the identity on pure ASCII.
  if (!ascii) plain = text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The slug of `text`, cached in the run's `cx` (never across cases). */
function slugify(text, cx) {
  const hit = cx.slugCache.get(text);
  if (hit !== undefined) return hit;
  const s = slugifyRaw(text);
  cx.slugCache.set(text, s);
  return s;
}

/** A date in words, cached in the run's `cx` (never across cases). */
function longDate(date, cx) {
  const hit = cx.dateCache.get(date);
  if (hit !== undefined) return hit;
  const s = longDateRaw(date);
  cx.dateCache.set(date, s);
  return s;
}

// --------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z or _
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // [
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45) {
        const digits = (a, b) => {
          let v = 0;
          for (let i = a; i < b; i++) {
            const c = raw.charCodeAt(i);
            if (c < 48 || c > 57) return -1;
            v = v * 10 + (c - 48);
          }
          return v;
        };
        y = digits(0, 4);
        mo = digits(5, 7);
        d = digits(8, 10);
        ok = y >= 0 && mo >= 0 && d >= 0;
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let ok = true;
      let prevDash = true; // a slug may not open on -
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
        if (c === 45) {
          if (prevDash) { ok = false; break; }
          prevDash = true;
        } else if (alnum) prevDash = false;
        else { ok = false; break; }
      }
      if (!ok || prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are found with
 * indexOf instead of splitting the whole text, and the body is one slice.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing --- line; lineNo is its 0-based line index.
  let lineStart = nl0 === -1 ? text.length : nl0 + 1;
  let lineNo = 1;
  let close = -1;
  let closeEnd = -1;
  while (lineStart <= text.length) {
    const e = text.indexOf('\n', lineStart);
    const end = e === -1 ? text.length : e;
    if (end - lineStart === 3 && text.charCodeAt(lineStart) === 45 && text.charCodeAt(lineStart + 1) === 45 && text.charCodeAt(lineStart + 2) === 45) {
      close = lineNo;
      closeEnd = end;
      break;
    }
    if (e === -1) break;
    lineStart = e + 1;
    lineNo++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let ls = nl0 === -1 ? text.length : nl0 + 1;
  for (let li = 1; li < close; li++) {
    const e = text.indexOf('\n', ls);
    const end = e === -1 ? text.length : e;
    const line = text.slice(ls, end);
    ls = end + 1;
    // Blank (spaces and tabs only) or a comment: skip.
    if (line === '') continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 35) continue; // #
    if (c0 === 32 || c0 === 9) {
      let blank = true;
      for (let j = 0; j < line.length; j++) {
        const c = line.charCodeAt(j);
        if (c !== 32 && c !== 9) { blank = false; break; }
      }
      if (blank) continue;
    }
    // key: value — key of a-z and _, a colon, one space, the value.
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: `line ${li + 1} is not "key: value"` };
    let keyOk = true;
    for (let j = 0; j < ci; j++) {
      if (!isKeyChar(line.charCodeAt(j))) { keyOk = false; break; }
    }
    if (!keyOk) return { error: `line ${li + 1} is not "key: value"` };
    const key = line.slice(0, ci);
    let raw;
    if (ci === line.length - 1) raw = '';
    else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
    else return { error: `line ${li + 1} is not "key: value"` };
    let en = raw.length;
    while (en > 0) {
      const c = raw.charCodeAt(en - 1);
      if (c !== 32 && c !== 9) break;
      en--;
    }
    if (en !== raw.length) raw = raw.slice(0, en);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ----------------------------------------------------------------- markdown

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlank(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return false;
  for (let j = 1; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces/tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c === 0 || c > 6) return null;
  if (c >= line.length) return null;
  const n = line.charCodeAt(c);
  if (n !== 32 && n !== 9) return null;
  const text = trimLine(line.slice(c));
  if (text === '') return null;
  return { depth: c, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces/tabs only. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false; // - or *
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/**
 * A list item's start: { ordered, num, rest } for a bullet line ("- "/"* ")
 * or an ordered line ("1. " ... "999999999. "), else null.
 */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, num: 1, rest: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let d = 0;
    while (d < 9 && d < line.length) {
      const c = line.charCodeAt(d);
      if (c < 48 || c > 57) break;
      d++;
    }
    if (d === 0) return null;
    // A tenth digit means the run is longer than 9: not an ordered marker.
    if (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) return null;
    if (line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
      return { ordered: true, num: Number(line.slice(0, d)), rest: line.slice(d + 2) };
    }
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isSpaceCode(line.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside an escape. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE_CODES.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE_CODES.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*\[]|[&<>"']/g;
const HAS_WS = /\s/;

/**
 * `s` rendered inline; `link(target)` is a link's href. One scan finds both
 * the Markdown specials and the characters the HTML escape names, so a plain
 * run is copied once and never re-scanned for escaping.
 */
function inline(s, link) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) {
      out += s.slice(i);
      break;
    }
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '&') { out += '&amp;'; i = j + 1; continue; }
    if (c === '<') { out += '&lt;'; i = j + 1; continue; }
    if (c === '>') { out += '&gt;'; i = j + 1; continue; }
    if (c === '"') { out += '&quot;'; i = j + 1; continue; }
    if (c === "'") { out += '&#39;'; i = j + 1; continue; }
    if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        // '>' is the only HTML special a backslash can escape, so this is
        // the escape table's answer for it without calling esc.
        out += d === '>' ? '&gt;' : d;
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${esc(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), link)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), link)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !HAS_WS.test(target)) {
      out += `<a href="${esc(link(target))}">${inline(s.slice(j + 1, k), link)}</a>`;
      i = mm + 1;
    } else {
      out += '[';
      i = j + 1;
    }
  }
  return out;
}

/**
 * `src` rendered: its HTML, its table of contents (every level 2 and 3
 * heading) and its excerpt (the first paragraph's inline HTML, or "").
 * `cx` carries the run's slug cache; `link` resolves link targets.
 */
function renderMarkdown(src, link, cx) {
  const lines = src.split('\n');
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    // One dispatch on the first character: a line can only open the block
    // its first character names, so the other tests are never run for it.
    // A blank line is skipped; anything that matches nothing is a paragraph.
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '';
        for (let k = 0; k < body.length; k++) code += esc(body[k]) + '\n';
        // The language is only [A-Za-z0-9_+-], so the escape table is the
        // identity on it and esc is skipped.
        html += `<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${code}</code></pre>\n`;
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, cx), ids);
        const h = inline(heading.text, link);
        html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
        i++;
        continue;
      }
    } else if (c0 === 62) { // >
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      html += body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    } else if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      if ((c0 === 45 || c0 === 42) && isHR(line)) {
        html += '<hr>\n';
        i++;
        continue;
      }
      const lst = listStart(line);
      if (lst !== null) {
        const ordered = lst.ordered;
        const tag = ordered ? 'ol' : 'ul';
        let b = `${ordered && lst.num !== 1 ? `<ol start="${lst.num}">` : `<${tag}>`}\n`;
        let parts = null; // the current item's lines
        while (i < n) {
          const l2 = lines[i];
          let rest = null;
          if (ordered) {
            if (l2.charCodeAt(0) >= 48 && l2.charCodeAt(0) <= 57) {
              const m = listStart(l2);
              if (m !== null && m.ordered) rest = m.rest;
            }
          } else if (l2.length >= 2 && (l2.charCodeAt(0) === 45 || l2.charCodeAt(0) === 42) && l2.charCodeAt(1) === 32) {
            rest = l2.slice(2);
          }
          if (rest !== null) {
            if (parts !== null) b += `<li>${inline(parts.join('\n'), link)}</li>\n`;
            parts = [trimLine(rest)];
            i++;
          } else if (isContinued(l2)) {
            parts.push(trimLine(l2));
            i++;
          } else break;
        }
        if (parts !== null) b += `<li>${inline(parts.join('\n'), link)}</li>\n`;
        b += `</${tag}>\n`;
        html += b;
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const p = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = p;
    html += `<p>${p}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain (fallback renderer only). */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text (fallback renderer only, and the compiled code's txt). */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i !== 0) s += ', ';
      s += txt(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The first name's value in the scope chain (compiled code's lk). */
function lk(sc, name) {
  while (sc !== null) {
    if (Object.hasOwn(sc.vars, name)) return sc.vars[name];
    sc = sc.parent;
  }
  return undefined;
}

/** A compiled template's nodes rendered by walking the tree (only used when compiling fails). */
function renderNodesFallback(nodes, scope, F, nameToIndex, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += esc(txt(lookup(scope, n.path)));
        break;
      case 'raw':
        out += txt(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodesFallback(branch, scope, F, nameToIndex, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodesFallback(n.body, { vars, parent: scope }, F, nameToIndex, depth);
        });
        break;
      }
      case 'include': {
        const idx = nameToIndex.get(n.name);
        const f = idx === undefined ? undefined : F[idx];
        if (f !== undefined && depth < 8) out += f(scope, F, depth + 1, lk, txt, esc, truthy);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------- template compilation

/** A value expression for `path` in scope variable `scopeVar`. */
function genValue(path, scopeVar, ctx) {
  let expr = `lk(${scopeVar},${JSON.stringify(path[0])})`;
  for (let k = 1; k < path.length; k++) {
    const t = `_t${ctx.uid++}`;
    ctx.temps.push(t);
    const seg = JSON.stringify(path[k]);
    expr = `((${t}=${expr})!=null&&typeof ${t}==='object'&&Object.hasOwn(${t},${seg})?${t}[${seg}]:undefined)`;
  }
  return expr;
}

/** JavaScript for `nodes`, appending to `out`, in scope variable `scopeVar`. */
function genNodes(nodes, scopeVar, ctx) {
  for (const n of nodes) {
    if (n.kind === 'text') ctx.code.push(`out+=${JSON.stringify(n.text)};`);
    else if (n.kind === 'var') ctx.code.push(`out+=esc(txt(${genValue(n.path, scopeVar, ctx)}));`);
    else if (n.kind === 'raw') ctx.code.push(`out+=txt(${genValue(n.path, scopeVar, ctx)});`);
    else if (n.kind === 'if') {
      ctx.code.push(`if(truthy(${genValue(n.path, scopeVar, ctx)})!==${n.not}){`);
      genNodes(n.then, scopeVar, ctx);
      if (n.else !== null) {
        ctx.code.push('}else{');
        genNodes(n.else, scopeVar, ctx);
      }
      ctx.code.push('}');
    } else if (n.kind === 'for') {
      const xs = `_x${ctx.uid++}`;
      const nn = `_n${ctx.uid++}`;
      const kk = `_k${ctx.uid++}`;
      const lp = `_l${ctx.uid++}`;
      const sc2 = `_s${ctx.uid++}`;
      // One scope object and one loop object per execution, mutated per
      // iteration: rendering inside an iteration is synchronous, so no
      // template can ever observe the reuse. The element is bound first and
      // `loop` after it, so a loop variable named `loop` still reads as the
      // loop object, as the reference's {[name]: x, loop: {...}} literal does.
      ctx.code.push(`{const ${xs}=${genValue(n.path, scopeVar, ctx)};if(Array.isArray(${xs})){const ${nn}=${xs}.length;const ${lp}={index:0,first:true,last:false,length:${nn}};const ${sc2}={vars:{},parent:${scopeVar}};for(let ${kk}=0;${kk}<${nn};${kk}++){${sc2}.vars[${JSON.stringify(n.name)}]=${xs}[${kk}];${sc2}.vars.loop=${lp};${lp}.index=${kk}+1;${lp}.first=${kk}===0;${lp}.last=${kk}===${nn}-1;`);
      genNodes(n.body, sc2, ctx);
      ctx.code.push('}}}');
    } else if (n.kind === 'include') {
      const idx = ctx.nameToIndex.get(n.name);
      if (idx !== undefined) {
        ctx.code.push(`{const _f=F[${idx}];if(_f!==undefined&&depth<8)out+=_f(${scopeVar},F,depth+1,lk,txt,esc,truthy);}`);
      }
    }
  }
}

/**
 * `nodes` compiled to (sc, F, depth, lk, txt, esc, truthy) => string, the
 * template's output. It builds the string with +=, so V8 keeps it a rope
 * and the copy to a flat string happens once, when the caller uses it,
 * instead of once per render in a join. Falls back to the tree walker when
 * compiling fails.
 */
function compileTemplate(nodes, nameToIndex) {
  const ctx = { code: [], temps: [], uid: 0, nameToIndex };
  genNodes(nodes, 'sc', ctx);
  const decl = ctx.temps.length === 0 ? '' : `let ${ctx.temps.join(',')};`;
  try {
    return new Function('sc', 'F', 'depth', 'lk', 'txt', 'esc', 'truthy', `${decl}let out="";${ctx.code.join('')}return out;`);
  } catch {
    return (sc, F, depth) => renderNodesFallback(nodes, sc, F, nameToIndex, depth);
  }
}

// -------------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Per-case caches: slug and long-date results repeat heavily inside one
  // site and are never carried into the next case.
  const cx = { slugCache: new Map(), dateCache: new Map() };

  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const output = {};

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out.
  const parsed = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const nameToIndex = new Map();
  let idx = 0;
  for (const name of parsed.keys()) nameToIndex.set(name, idx++);
  const F = new Array(parsed.size);
  const compiled = new Map();
  for (const [name, nodes] of parsed) {
    const fn = compileTemplate(nodes, nameToIndex);
    F[nameToIndex.get(name)] = fn;
    compiled.set(name, fn);
  }

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter, in the checks' order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, cx), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      const c0 = target.charCodeAt(0);
      if (c0 === 47 || c0 === 35) return target; // / or #
      if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
        let j = 1;
        while (j < target.length) {
          const c = target.charCodeAt(j);
          if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46) j++;
          else break;
        }
        if (j < target.length && target.charCodeAt(j) === 58) return target; // scheme:
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, cx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name, cx);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, cx);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, cx);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    // A post's card is already built above; spreading it is identical to
    // building it again, and skips a second word count.
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // One root scope for the whole case, reused across renders: rendering is
  // synchronous, and a key set to undefined reads exactly like an absent key
  // (the lookup walks to the same undefined).
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const rootScope = { vars: rootVars, parent: null };
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    rootVars.page = vars.page;
    rootVars.posts = vars.posts;
    rootVars.pager = vars.pager;
    rootVars.tag = vars.tag;
    return fn(rootScope, F, 0, lk, txt, esc, truthy);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
