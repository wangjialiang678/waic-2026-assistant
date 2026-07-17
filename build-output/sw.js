/* WAIC 2026 参展助手 Service Worker — 展馆弱网离线可用 */
const CACHE = 'waic-assistant-v20260718';
const PRECACHE = [
  '/',
  '/index.html',
  '/app.html',
  '/guide.html',
  '/about.html',
  '/activity.html',
  '/install.html',
  '/feedback.html',
  '/superbrain.html',
  '/manifest.webmanifest',
  '/assets/style.css',
  '/assets/app.js',
  '/assets/activity.js',
  '/assets/chat.js',
  '/assets/planner.js',
  '/assets/social.js',
  '/assets/sync.js',
  '/assets/pwa.js',
  '/assets/icon-192.png',
  '/assets/apple-touch-icon.png',
  '/data/activities.json',
  '/data/themes.json',
  '/data/exhibitors.json',
  '/data/intel.json',
  '/data/venues.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  // 页面导航：网络优先，弱网/离线回退缓存（保证数据新鲜，又能离线打开）
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
    );
    return;
  }
  // API 请求不缓存（保持实时）
  if (e.request.url.includes('/api/')) return;
  // 静态资源与数据：缓存优先，后台更新
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetching = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetching;
    })
  );
});
