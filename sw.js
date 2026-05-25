const CACHE = 'velocom-v3';
const APP_SHELL = [
  './splash.html',
  './login.html',
  './register.html',
  './index.html',
  './rides.html',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './splash-bg.png',
  './icon-192.png',
  './icon-512.png',
];

// Domaines externes — toujours réseau, jamais cache
const NETWORK_ONLY = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'gstatic.com',
  'firebasejs',
  'firebase',
  'googleapis.com',
  'overpass-api.de',
  'openstreetmap.org',
  'basemaps.cartocdn.com',
  'tile.',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(APP_SHELL.map(url =>
        c.add(new Request(url, { cache: 'reload' })).catch(() => {})
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Toujours réseau pour ressources externes
  const isExternal = NETWORK_ONLY.some(d => url.includes(d));
  if (isExternal) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache first pour app shell local
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
