// Уносіць прынятыя праўкі тэксту з Supabase у data*.js / texts-lat*.js.
// Запускаецца з GitHub Actions (.github/workflows/apply-corrections.yml), можна і рукамі:
//   SUPABASE_SECRET_KEY=... node scripts/apply-corrections.mjs [--dry]
// Без ключа можна праверыць на файле:  node scripts/apply-corrections.mjs --input rows.json --dry
//
// Што робіць з кожнай праўкай са статусам «прынята», дзе ёсць выдзелены тэкст і прапанова:
//   * шукае ў тэксце песні выдзелены кавалак разам з тэкстам вакол яго (націскі не ўлічваюцца,
//     бо на сайце іх можна схаваць); калі месца адно, замяняе выдзеленае на прапанову;
//   * калі на гэтым месцы ўжо стаіць прапанова (PR злілі), ставіць праўцы статус «выпраўлена»;
//   * інакш пакідае «прынята» і піша прычыну ў нататку: такія праўкі ўносіць чалавек.
// Справаздача ідзе ў corrections-report.md (з яе бярэцца апісанне PR).

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const INPUT = args.includes('--input') ? args[args.indexOf('--input') + 1] : null;

// ---------- адрас і ключ ----------
function config() {
  const s = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  const block = s.slice(s.indexOf('corrections:'));
  const url = (block.match(/url:\s*'([^']*)'/) || [])[1] || '';
  return { url: url.replace(/\/+$/, '') };
}
const { url: URL0 } = config();
const KEY = process.env.SUPABASE_SECRET_KEY || '';
function headers(extra = {}) {
  const h = { apikey: KEY, 'Content-Type': 'application/json', ...extra };
  if (KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + KEY;   // стары service_role JWT; новы sb_secret_ ідзе толькі ў apikey
  return h;
}
async function fetchAccepted() {
  if (INPUT) return JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  if (!URL0 || !KEY) throw new Error('Няма corrections.url у config.js або SUPABASE_SECRET_KEY');
  const r = await fetch(`${URL0}/rest/v1/corrections?status=eq.${encodeURIComponent('прынята')}&order=id&limit=1000`, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
async function update(id, body) {
  if (DRY || INPUT) return;
  const r = await fetch(`${URL0}/rest/v1/corrections?id=eq.${id}`, { method: 'PATCH', headers: headers({ Prefer: 'return=minimal' }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
}

// ---------- файлы з тэкстамі ----------
// data*.js: радок «window.SONGS = [...];» / «window.SONGS_ALL = [...];» перазапісваецца цалкам (JSON.stringify дае той жа выгляд);
// texts-lat*.js: замяняецца толькі масіў радкоў адной песні, каб не мяняць парадак ключоў.
const SONG_FILES = { main: ['data.js', 'data-all.js'], '18': ['data-18.js', 'data-18-all.js'] };
const LAT_FILES = { main: ['texts-lat.js', 'texts-lat-all.js'], '18': ['texts-lat-18.js', 'texts-lat-18-all.js'] };
const files = {};   // name -> { text, lines, dirty }
function file(name) {
  if (!files[name]) {
    const p = path.join(ROOT, name);
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    files[name] = { text, lines: text.split('\n'), dirty: false };
  }
  return files[name];
}
function findSong(section, id) {
  for (const name of SONG_FILES[section] || []) {
    const f = file(name);
    for (let i = 0; i < f.lines.length; i++) {
      const m = f.lines[i].match(/^(window\.SONGS(?:_ALL)? = )(\[.*\]);$/);
      if (!m) continue;
      f.parsed = f.parsed || {};
      const arr = f.parsed[i] || (f.parsed[i] = JSON.parse(m[2]));
      const song = arr.find((s) => s.id === id);
      if (song) return { name, i, prefix: m[1], arr, song };
    }
  }
  return null;
}
function findLat(section, id) {
  for (const name of LAT_FILES[section] || []) {
    const f = file(name);
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.lines[i];
      if (!line.startsWith('window.SONGS_LAT')) continue;
      const key = JSON.stringify(id) + ':[';
      const at = line.indexOf(key);
      if (at < 0) continue;
      // канец масіва: першая «]», што стаіць не ўнутры радка
      let j = at + key.length, inStr = false;
      for (; j < line.length; j++) {
        const c = line[j];
        if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === ']') break;
      }
      const arr = JSON.parse(line.slice(at + key.length - 1, j + 1));
      return { name, i, at: at + key.length - 1, end: j + 1, arr };
    }
  }
  return null;
}

// ---------- пошук без уліку націскаў ----------
const strip = (ch) => ch.normalize('NFD').replace(/[̀́]/g, '').replace(/ /g, ' ');
function normMap(s) {
  let out = '';
  const map = [];   // для кожнага сімвала out — індэкс у s
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i), ch = String.fromCodePoint(cp), d = strip(ch);
    for (let k = 0; k < d.length; k++) map.push(i);
    out += d;
    i += ch.length;
  }
  map.push(s.length);
  return { out, map };
}
const norm = (s) => normMap(s || '').out;
function occurrences(hay, needle) {
  const res = [];
  if (!needle) return res;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) res.push(i);
  return res;
}
// канец зыходнага сімвала разам з яго націскамі
function origEnd(s, map, nEnd) {
  let e = map[nEnd];
  while (e < s.length && /[̀́]/.test(s[e])) e++;
  return e;
}

function locate(text, c, what) {
  const n = normMap(text);
  const before = norm(c.context_before), after = norm(c.context_after), q = norm(what);
  let hits = occurrences(n.out, before + q + after).map((p) => p + before.length);
  if (hits.length !== 1) {
    // запасны шлях: толькі выдзелены кавалак у сваім радку
    const lines = text.split('\n');
    const ln = (c.line_no || 0) - 1;
    if (ln >= 0 && ln < lines.length) {
      const off = lines.slice(0, ln).reduce((a, l) => a + l.length + 1, 0);
      const nl = normMap(lines[ln]);
      const h = occurrences(nl.out, q);
      if (h.length === 1) {
        const s = nl.map[h[0]], e = origEnd(lines[ln], nl.map, h[0] + q.length);
        return { start: off + s, end: off + e, how: 'радок' };
      }
    }
    return { count: hits.length };
  }
  const p = hits[0];
  return { start: n.map[p], end: origEnd(text, n.map, p + q.length), how: 'кантэкст' };
}

// ---------- асноўная частка ----------
const rows = await fetchAccepted();
const applied = [], done = [], skipped = [];
for (const c of rows) {
  const tag = `#${c.id} · № ${c.song_id}${c.section === '18' ? ' (18+)' : ''}`;
  if (!c.quote || !c.suggestion || !c.script) { skipped.push({ c, tag, why: c.kind === 'notes' ? 'праўка нот' : 'няма выдзеленага тэксту або прапановы' }); continue; }
  const song = findSong(c.section, c.song_id);
  if (!song) { skipped.push({ c, tag, why: 'песня не знойдзена' }); continue; }
  const lat = c.script === 'lat' ? findLat(c.section, c.song_id) : null;
  const lines = c.script === 'lat' ? lat && lat.arr : song.song.cyr;
  if (!lines) { skipped.push({ c, tag, why: 'няма тэксту лацінкай' }); continue; }
  const text = lines.join('\n');
  const loc = locate(text, c, c.quote);
  if (loc.start == null) {
    const was = locate(text, c, c.suggestion);
    if (was.start != null) { done.push({ c, tag }); continue; }
    skipped.push({ c, tag, why: loc.count ? `выдзелены тэкст сустракаецца некалькі разоў (${loc.count})` : 'выдзелены тэкст не знойдзены' });
    continue;
  }
  const oldPart = text.slice(loc.start, loc.end);
  if (oldPart === c.suggestion) { done.push({ c, tag }); continue; }
  const newText = text.slice(0, loc.start) + c.suggestion + text.slice(loc.end);
  const newLines = newText.split('\n');
  const ln = text.slice(0, loc.start).split('\n').length - 1;
  if (c.script === 'lat') {
    const f = file(lat.name);
    const line = f.lines[lat.i];
    f.lines[lat.i] = line.slice(0, lat.at) + JSON.stringify(newLines) + line.slice(lat.end);
    f.dirty = true;
    lat.arr = newLines;
  } else {
    song.song.cyr = newLines;
    const f = file(song.name);
    f.lines[song.i] = song.prefix + JSON.stringify(song.arr) + ';';
    f.dirty = true;
  }
  applied.push({ c, tag, before: lines.slice(ln, ln + Math.max(1, oldPart.split('\n').length)).join(' / '), after: newLines.slice(ln, ln + Math.max(1, c.suggestion.split('\n').length)).join(' / '), how: loc.how });
}

for (const [name, f] of Object.entries(files)) if (f.dirty && !DRY) fs.writeFileSync(path.join(ROOT, name), f.lines.join('\n'));

// статусы: тое, што ўжо ў main, — «выпраўлена»; прычыну пропуску — у нататку
for (const d of done) await update(d.c.id, { status: 'выпраўлена' });
for (const s of skipped) { const note = 'аўта: ' + s.why; if (!(s.c.admin_note || '').includes(note)) await update(s.c.id, { admin_note: s.c.admin_note ? s.c.admin_note + ' · ' + note : note }); }

const md = [];
md.push('Прынятыя праўкі тэксту з сайта, унесеныя аўтаматычна (`scripts/apply-corrections.mjs`).', '');
md.push(`Унесена: **${applied.length}**. Ужо былі ў тэксце (пазначаныя «выпраўлена»): ${done.length}. Трэба ўнесці рукамі: ${skipped.length}.`, '');
if (applied.length) {
  md.push('| Праўка | Было | Стала |', '|---|---|---|');
  for (const a of applied) md.push(`| ${a.tag} ${a.c.script === 'lat' ? 'лац.' : 'кір.'} | ${a.before.replace(/\|/g, '\\|')} | ${a.after.replace(/\|/g, '\\|')} |`);
  md.push('', 'Праверце націскі: калі на сайце націскі былі схаваныя, прапанова можа быць без іх.', '');
}
if (skipped.length) {
  md.push('### Не ўнесена', '');
  for (const s of skipped) md.push(`- ${s.tag}: ${s.why}. «${(s.c.quote || s.c.comment || '').slice(0, 80)}» → «${(s.c.suggestion || '').slice(0, 80)}»`);
  md.push('');
}
md.push('Пасля зліцця гэтыя праўкі наступным запускам атрымаюць статус «выпраўлена».');
fs.writeFileSync(path.join(ROOT, 'corrections-report.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `applied=${applied.length}\n`);
