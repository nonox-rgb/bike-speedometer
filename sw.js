const CACHE = 'velocom-v2';
const ASSETS = [
  './',
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

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Toujours réseau pour Firebase et Overpass
  if (e.request.url.includes('firebasejs') ||
      e.request.url.includes('firebaseapp') ||
      e.request.url.includes('googleapis') ||
      e.request.url.includes('overpass-api') ||
      e.request.url.includes('tile')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Cache first pour le reste (app shell)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }))
  );
});
