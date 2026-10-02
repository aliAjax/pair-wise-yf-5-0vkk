// public/sw.js
// 离线缓存：应用外壳（HTML/CSS/JS）缓存，API 请求走网络
const CACHE_NAME = 'claims-survey-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/db.js',
  '/sync.js',
  '/app.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API 请求：网络优先，不缓存
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  // 应用外壳：缓存优先，后台更新
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request).then((resp) => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
