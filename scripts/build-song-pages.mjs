// Builds one small page per song in p/<number>.html, so that a link to a song shows its own
// title and first lines in messengers. The page sends a visitor straight on to the song on the site.
// Run: node scripts/build-song-pages.mjs  (GitHub Action "Song pages" runs it when the data changes)
// The 18+ songs (data-18*.js) get no pages. The pages carry noindex until the public launch.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// the site's full address, needed for the preview picture; change it when the site moves (e.g. to ludby.org)
const SITE = 'https://dimavak.github.io/muzhchynskija-pesni/';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'p');

function load(file, name) {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx);
  return ctx.window[name] || [];
}
const men = load('data.js', 'SONGS');
const rest = load('data-all.js', 'SONGS_ALL');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (s) => String(s || '').replace(/́/g, '').normalize('NFD').replace(/̀/g, '').normalize('NFC').replace(/\s*\((\d+ р\.|sic)\)/g, '').trim();

function page(s, isMen) {
  const title = '№ ' + s.id + ' ' + plain(s.title) + ' — Песні Федароўскага';
  const lines = (s.cyr || []).map(plain).filter(Boolean);
  const desc = (lines.length ? lines.slice(0, 3).join(' / ') + (lines.length > 3 ? ' …' : '') + ' · ' : '') +
    ('Федароўскі, «Lud białoruski», т. ' + s.vol + (s.region ? ', ' + plain(s.region) : '')).replace(/\.?$/, '.');
  const k = isMen ? '' : 'k=all';
  const fallback = '../' + (k ? '?' + k : '') + '#' + encodeURIComponent(s.id);
  return `<!doctype html>
<html lang="be">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Песні Федароўскага">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}p/${encodeURIComponent(s.id)}.html">
<meta property="og:image" content="${SITE}og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${esc(fallback)}">
<script>(function(){var q=new URLSearchParams(location.search);${k ? "q.set('k','all');" : ''}var s=q.toString();location.replace('../'+(s?'?'+s:'')+'#${encodeURIComponent(s.id)}');})();</script>
</head>
<body>
<p><a href="${esc(fallback)}">${esc(title)}</a></p>
</body>
</html>
`;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const s of men) { fs.writeFileSync(path.join(OUT, s.id + '.html'), page(s, true)); n++; }
for (const s of rest) { fs.writeFileSync(path.join(OUT, s.id + '.html'), page(s, false)); n++; }
console.log('song pages:', n);
