// Service worker: the site opens without internet (in a village with no signal, or as an app on the phone),
// and on a slow connection a repeat visit does not wait for the network.
// Strategy: network first (so changes arrive at once); if the network fails, or is slower than a few
// seconds and a saved copy exists, the saved copy is shown and the fresh one is saved for next time.
// Bump VERSION to drop old saved copies.
const VERSION = 'v1';
const CACHE = 'pesni-' + VERSION;
const CORE = ['./', 'index.html', 'config.js', 'data.js', 'data-all.js', 'melodies.js', 'melodies-all.js', 'places.js',
  'notators.js', 'folk-player.js', 'i18n.js', 'icon.svg', 'manifest.webmanifest', 'img/lachavicy-muzyki.jpg', 'img/lachavicy-muzyki-hero.jpg'];
const SLOW_MS = 3500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(CORE.map((u) => c.add(new Request(u, { cache: 'no-cache' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('pesni-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  // only this site's own files; the admin page, statistics and corrections always go to the network
  if (req.method !== 'GET' || url.origin !== self.location.origin || /admin\.html$/.test(url.pathname) || req.headers.has('range')) return;
  const nav = req.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = () => nav ? cache.match(req, { ignoreSearch: true }).then((r) => r || cache.match('index.html')) : cache.match(req);
    const net = fetch(req).then((r) => { if (r && r.ok && r.type === 'basic') cache.put(nav ? 'index.html' : req, r.clone()).catch(() => {}); return r; });
    const slow = new Promise((ok) => setTimeout(ok, SLOW_MS)).then(saved);
    try {
      const first = await Promise.race([net, slow.then((r) => r || net)]);
      return first || await net;
    } catch (err) {
      const r = await saved();
      if (r) return r;
      throw err;
    }
  })());
});
