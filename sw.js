// 앱 화면(껍데기)만 캐시 — 공역·날씨 데이터는 항상 새로 받아옵니다.
const V = '43'; // index.html의 ?v= 숫자와 같게 유지
const CACHE = 'dronezone-v' + V;
const SHELL = ['./', 'manifest.webmanifest',
  'style.css?v=' + V, 'config.js?v=' + V, 'app.js?v=' + V,
  'icons/icon-192.png', 'icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isShell = url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com';
  if (!isShell) return; // V-World, 날씨 API는 캐시하지 않음
  // 네트워크 우선(코드 수정이 바로 반영되도록). 정상 응답만 캐시에 넣고,
  // 신호가 약해 7초 넘게 걸리면 저장해 둔 화면을 먼저 보여 줌
  const net = fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  });
  e.respondWith(new Promise(resolve => {
    let settled = false;
    const useCache = () => caches.match(e.request).catch(() => null).then(c => { if (c && !settled) { settled = true; resolve(c); } return c; });
    const timer = setTimeout(useCache, 7000);
    net.then(r => {
      clearTimeout(timer);
      if (settled) return;
      if (r.ok) { settled = true; resolve(r); return; }
      useCache().then(c => { if (!c && !settled) { settled = true; resolve(r); } }); // 404 등이면 저장본 우선
    }).catch(() => {
      clearTimeout(timer);
      useCache().then(c => { if (!c && !settled) { settled = true; resolve(Response.error()); } });
    });
  }));
});
