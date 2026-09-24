/* 드론 비행구역 확인 앱 — app.js */
(function () {
'use strict';

const CFG = Object.assign({ VWORLD_KEY: '', CHECK_RADIUS_M: 5000, DEFAULT_CENTER: [37.5665, 126.978], DEFAULT_ZOOM: 11 }, window.APP_CONFIG || {});

/* ───────── 저장소 ───────── */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const vkey = () => (CFG.VWORLD_KEY || '').trim();
try { localStorage.removeItem('vworldKey'); } catch (e) {}

/* ───────── 공역 종류 ───────── */
// level: 3=승인 없이 비행 불가, 2=승인 필요, 1=주의, 0=비행 가능 공역
const ZONES = [
  { id: 'LT_C_AISPRHC', name: '비행금지구역', level: 3, color: '#e53935', note: '비행승인 없이 비행 불가' },
  { id: 'LT_C_AISCTRC', name: '관제권(공항 주변)', level: 3, color: '#d81b60', note: '원칙적으로 비행승인 필요' },
  { id: 'LT_C_AISRESC', name: '비행제한구역', level: 2, color: '#fb8c00', note: '비행승인 필요' },
  { id: 'LT_C_AISDNGC', name: '위험구역', level: 2, color: '#f4511e', note: '비행승인 필요' },
  { id: 'LT_C_AISMOAC', name: '군작전구역', level: 1, color: '#fdd835', note: '군 작전 공역 — 비행 전 확인 권장', off: true },
  { id: 'LT_C_AISUAC',  name: '초경량비행장치 공역', level: 0, color: '#43a047', note: '초경량비행장치 비행 공역' },
  // ↓ V-World에 있는지 확인되지 않은 레이어: 조회에 성공한 경우에만 사용·표시
  { id: 'LT_C_AISTEMP', name: '임시비행금지구역', level: 3, color: '#b71c1c', note: '행사·훈련 등으로 임시 지정 — 비행 불가', optional: true },
  { id: 'LT_C_AISATZC', name: '비행장교통구역', level: 2, color: '#8d6e63', note: '비행장 주변 — 비행승인 필요', optional: true },
  { id: 'LT_C_AISALTC', name: '경계구역', level: 1, color: '#a1887f', note: '훈련 등 경계 공역 — 비행 전 확인 권장', optional: true, off: true },
  { id: 'LT_C_WGISNPGUG', name: '국립공원', level: 1, color: '#2e7d32', note: '국립공원 — 공원사무소 사전 허가 필요', optional: true, off: true },
  { id: 'LT_C_AISDRONEZONE', name: '드론시범사업구역', level: 0, color: '#00897b', note: '드론 실증·시범사업 구역', optional: true, off: true }
];
const verified = new Set(LS.get('verifiedLayers', []));
function markVerified(z) {
  if (!z.optional || verified.has(z.id)) return;
  verified.add(z.id); LS.set('verifiedLayers', [...verified]);
  addZoneOverlay(z);
}

/* ───────── 공통 유틸 ───────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDist = m => m < 1000 ? Math.round(m) + 'm' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + 'km';
const pad = n => String(n).padStart(2, '0');

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// V-World는 CORS를 허용하지 않아 JSONP(callback)로 호출
let jsonpSeq = 0;
function jsonp(url, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const cb = '__vw' + (++jsonpSeq) + '_' + Date.now();
    const s = document.createElement('script');
    const timer = setTimeout(() => { finish(); reject(new Error('응답 시간 초과')); }, timeout);
    function finish() { clearTimeout(timer); window[cb] = function () {}; s.remove(); }
    window[cb] = data => { finish(); resolve(data); };
    s.onerror = () => { finish(); reject(new Error('네트워크 오류')); };
    s.src = url + '?' + new URLSearchParams(Object.assign({}, params, { callback: cb })).toString();
    document.head.appendChild(s);
  });
}
const vwBase = () => ({ key: vkey(), domain: location.origin, format: 'json', errorFormat: 'json' });

/* ───────── 기하 계산 ───────── */
function toLocal(lon, lat, lat0, lon0) {
  return [(lon - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320, (lat - lat0) * 110574];
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
function containsPoint(geom, lon, lat) {
  return polygonsOf(geom).some(poly => pointInRing(lon, lat, poly[0]) && !poly.slice(1).some(h => pointInRing(lon, lat, h)));
}
function distToBoundary(geom, lon, lat) {
  let best = Infinity;
  for (const poly of polygonsOf(geom)) for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = toLocal(ring[i][0], ring[i][1], lat, lon), b = toLocal(ring[i + 1][0], ring[i + 1][1], lat, lon);
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      let t = len2 ? -(a[0] * dx + a[1] * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
      const px = a[0] + t * dx, py = a[1] + t * dy, d = Math.hypot(px, py);
      if (d < best) best = d;
    }
  }
  return best;
}
function bboxAround(lat, lon, r) {
  const dLat = r / 110574, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map(v => v.toFixed(6));
}

/* 속성에서 구역 이름 추정 (데이터마다 컬럼명이 다를 수 있음) */
function featureLabel(props) {
  if (!props) return '';
  const keys = Object.keys(props);
  const pick = keys.filter(k => /nam|lbl|name|title|ident|id_/i.test(k) && typeof props[k] === 'string' && props[k].trim());
  const vals = [...new Set(pick.map(k => props[k].trim()))];
  return vals.slice(0, 2).join(' · ');
}
function propsTable(props) {
  const rows = Object.entries(props || {}).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object');
  if (!rows.length) return '';
  return '<details><summary>상세 속성</summary><table>' + rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table></details>';
}

/* ───────── 공역 판정 ───────── */
async function queryLayer(zone, bbox) {
  const res = await jsonp('https://api.vworld.kr/req/data', Object.assign(vwBase(), {
    service: 'data', request: 'GetFeature', version: '2.0', data: zone.id,
    size: '1000', page: '1', geometry: 'true', attribute: 'true', crs: 'EPSG:4326',
    geomFilter: `BOX(${bbox.join(',')})`
  }));
  const r = res && res.response;
  if (!r) throw new Error('잘못된 응답');
  if (r.status === 'NOT_FOUND') return [];
  if (r.status !== 'OK') throw new Error((r.error && (r.error.text || r.error.code)) || r.status);
  return (r.result && r.result.featureCollection && r.result.featureCollection.features) || [];
}

async function analyze(lat, lon) {
  const bbox = bboxAround(lat, lon, CFG.CHECK_RADIUS_M);
  const settled = await Promise.allSettled(ZONES.map(z => queryLayer(z, bbox)));
  const inside = [], nearby = [], failed = [];
  settled.forEach((s, i) => {
    const zone = ZONES[i];
    if (s.status === 'rejected') { if (!zone.optional) failed.push({ zone, error: s.reason && s.reason.message }); return; }
    markVerified(zone);
    for (const f of s.value) {
      const item = { zone, feature: f, label: featureLabel(f.properties) };
      if (containsPoint(f.geometry, lon, lat)) { item.dist = 0; inside.push(item); }
      else {
        item.dist = distToBoundary(f.geometry, lon, lat);
        if (item.dist <= CFG.CHECK_RADIUS_M && zone.level > 0) nearby.push(item);
      }
    }
  });
  inside.sort((a, b) => b.zone.level - a.zone.level);
  nearby.sort((a, b) => a.dist - b.dist);
  return { lat, lon, inside, nearby, failed, verdict: makeVerdict(inside, nearby, failed) };
}

function makeVerdict(inside, nearby, failed) {
  const top = inside.reduce((m, x) => Math.max(m, x.zone.level), -1);
  const has = id => inside.some(x => x.zone.id === id);
  const near = nearby[0];
  if (failed.length >= ZONES.filter(z => !z.optional).length) {
    const why = [...new Set(failed.map(f => f.error).filter(Boolean))].slice(0, 2).join(' / ');
    return { cls: 'v-gray', ico: '❔', title: '판정할 수 없음', desc: '공역 데이터를 불러오지 못했습니다. 잠시 후 ⟳ 새로고침으로 다시 시도하세요.' + (why ? ` (원인: ${why})` : ''), code: 'error' };
  }
  if (top === 3) {
    const names = [...new Set(inside.filter(x => x.zone.level === 3).map(x => x.zone.name))].join(', ');
    return { cls: 'v-red', ico: '⛔', title: '비행 불가 (승인 필요)', desc: `${names} 안입니다. 드론 원스톱에서 비행승인을 받아야 합니다. (승인 없이 비행 시 과태료 150만원, 1차 위반 기준)`, code: 'no' };
  }
  if (top === 2) {
    const names = [...new Set(inside.filter(x => x.zone.level === 2).map(x => x.zone.name))].join(', ');
    return { cls: 'v-orange', ico: '⚠️', title: '비행승인 필요', desc: `${names} 안입니다. 드론 원스톱에서 비행승인을 받아야 합니다. (승인 없이 비행 시 과태료 150만원, 1차 위반 기준)`, code: 'approval' };
  }
  if (top === 1) {
    const names = [...new Set(inside.filter(x => x.zone.level === 1).map(x => x.zone.name))].join(', ');
    const park = has('LT_C_WGISNPGUG') ? ' 국립공원 안에서는 공원사무소 허가가 필요합니다.' : '';
    return { cls: 'v-yellow', ico: '🟡', title: '주의 — 확인 후 비행', desc: `${names} 안입니다.${park} 비행 전 드론 원스톱에서 확인하세요.`, code: 'caution' };
  }
  const base = has('LT_C_AISUAC') ? '초경량비행장치 공역입니다.' : '확인된 비행금지·제한 공역이 없습니다.';
  const warn = ' 조종자 준수사항(주간·25kg 이하·150m 미만·가시권)을 지키면 비행할 수 있습니다.' + (near && near.dist < 1000 ? ` 단, ${fmtDist(near.dist)} 옆에 ${near.zone.name}이 있으니 넘어가지 않게 주의하세요.` : '');
  return { cls: 'v-green', ico: '✅', title: '비행 가능 · 비행승인 불필요', desc: base + warn, code: 'ok', nearNote: near && near.dist < 1000 ? `${fmtDist(near.dist)} 옆에 ${near.zone.name}이 있습니다.` : '' };
}

/* ───────── 주소 ───────── */
// 시·도 이름 줄이기 (서울특별시 → 서울, 충청북도 → 충북 …)
const SIDO_SHORT = [
  ['서울특별시', '서울'], ['부산광역시', '부산'], ['대구광역시', '대구'], ['인천광역시', '인천'], ['광주광역시', '광주'],
  ['대전광역시', '대전'], ['울산광역시', '울산'], ['세종특별자치시', '세종'], ['경기도', '경기'],
  ['강원특별자치도', '강원'], ['강원도', '강원'], ['충청북도', '충북'], ['충청남도', '충남'],
  ['전북특별자치도', '전북'], ['전라북도', '전북'], ['전라남도', '전남'], ['경상북도', '경북'], ['경상남도', '경남'],
  ['제주특별자치도', '제주']
];
function shortAddr(a) {
  if (!a) return '';
  for (const [full, short] of SIDO_SHORT) if (a.startsWith(full)) return short + a.slice(full.length);
  return a;
}
const SEARCH_PH = '주소·장소 검색 (예: 여의도 한강공원)';
let myAddrText = '';
function setMyAddress(addr) {
  const a = addr && (addr.road || addr.parcel);
  myAddrText = a ? '내 위치: ' + shortAddr(a) : '';
  const inp = $('#searchInput');
  if (document.activeElement !== inp) inp.placeholder = myAddrText || SEARCH_PH;
}
async function reverseGeocode(lat, lon) {
  try {
    const res = await jsonp('https://api.vworld.kr/req/address', Object.assign(vwBase(), {
      service: 'address', request: 'getAddress', version: '2.0', crs: 'epsg:4326', point: `${lon},${lat}`, type: 'both'
    }), 8000);
    const r = res && res.response;
    if (r && r.status === 'OK' && r.result && r.result.length) {
      const road = r.result.find(x => x.type === 'road'), parcel = r.result.find(x => x.type === 'parcel');
      return { road: road && road.text, parcel: parcel && parcel.text };
    }
  } catch (e) {}
  return null;
}

async function searchPlaces(q) {
  const common = Object.assign(vwBase(), { service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: '8', page: '1', query: q });
  const reqs = [
    jsonp('https://api.vworld.kr/req/search', Object.assign({}, common, { type: 'place' })),
    jsonp('https://api.vworld.kr/req/search', Object.assign({}, common, { type: 'address', category: 'road' })),
    jsonp('https://api.vworld.kr/req/search', Object.assign({}, common, { type: 'address', category: 'parcel' })),
    jsonp('https://api.vworld.kr/req/search', Object.assign({}, common, { type: 'district', category: 'L4' }))
  ];
  const out = [], seen = new Set();
  (await Promise.allSettled(reqs)).forEach((s, i) => {
    if (s.status !== 'fulfilled') return;
    const r = s.value && s.value.response;
    if (!r || r.status !== 'OK' || !r.result) return;
    for (const it of r.result.items || []) {
      const p = it.point || {};
      const lat = parseFloat(p.y), lon = parseFloat(p.x);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const title = i === 0 ? it.title : i === 3 ? it.title : (it.address && (it.address.road || it.address.parcel)) || it.title;
      const sub = i === 0 ? (it.address && (it.address.road || it.address.parcel)) || it.category : i === 3 ? '행정구역' : (it.address && it.address.bldnm) || (i === 1 ? '도로명주소' : '지번주소');
      const k = title + '|' + lat.toFixed(4) + lon.toFixed(4);
      if (seen.has(k)) continue; seen.add(k);
      out.push({ title: String(title || '').replace(/<[^>]+>/g, ''), sub: String(sub || ''), lat, lon });
    }
  });
  return out;
}

/* ───────── 날씨 (Open-Meteo, 키 불필요) ───────── */
const WX = { 0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림', 45: '안개', 48: '안개', 51: '이슬비', 53: '이슬비', 55: '이슬비', 61: '비', 63: '비', 65: '강한 비', 66: '어는 비', 67: '어는 비', 71: '눈', 73: '눈', 75: '강한 눈', 77: '싸락눈', 80: '소나기', 81: '소나기', 82: '강한 소나기', 85: '눈 소나기', 86: '눈 소나기', 95: '뇌우', 96: '뇌우·우박', 99: '뇌우·우박' };
async function fetchWeather(lat, lon) {
  const u = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    current: 'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    daily: 'sunrise,sunset', timezone: 'Asia/Seoul', wind_speed_unit: 'ms', forecast_days: '1'
  });
  const r = await fetch(u); if (!r.ok) throw new Error('날씨 오류');
  return r.json();
}
function windDir(deg) { return ['북', '북동', '동', '남동', '남', '남서', '서', '북서'][Math.round(((deg % 360) / 45)) % 8] + '풍'; }
function weatherIssues(w) {
  const c = w.current, d = w.daily;
  const sunrise = d.sunrise[0].slice(11, 16), sunset = d.sunset[0].slice(11, 16), nowHM = c.time.slice(11, 16);
  return {
    sunrise, sunset, nowHM,
    night: nowHM < sunrise || nowHM >= sunset,
    windStrong: c.wind_gusts_10m >= 10 || c.wind_speed_10m >= 8,
    windMid: !(c.wind_gusts_10m >= 10 || c.wind_speed_10m >= 8) && (c.wind_gusts_10m >= 7 || c.wind_speed_10m >= 5),
    rain: c.precipitation > 0 || [51, 53, 55, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99].includes(c.weather_code),
    fog: c.weather_code === 45 || c.weather_code === 48
  };
}
function weatherHtml(w) {
  const c = w.current;
  const { sunrise, sunset, nowHM, night } = weatherIssues(w);
  const notes = [];
  const iss = weatherIssues(w);
  if (iss.windStrong) notes.push('💨 바람이 강해 소형 드론 비행은 추천하지 않습니다.');
  else if (iss.windMid) notes.push('💨 바람이 다소 강합니다. 높이 올라갈수록 더 세질 수 있어요.');
  if (iss.rain) notes.push('🌧 강수가 있습니다. 방수 기체가 아니면 비행을 피하세요.');
  if (iss.fog) notes.push('🌫 안개로 가시권 확보가 어렵습니다.');
  if (night) notes.push(`🌙 지금은 야간(일몰 ${sunset} 이후~일출 ${sunrise} 전)이라 특별비행승인 없이는 비행할 수 없습니다.`);
  if (!notes.length) notes.push('👍 비행하기 괜찮은 날씨입니다.');
  return `<div class="section-title">현재 날씨 (${nowHM} 기준)</div>
    <div class="wx">
      <div><b>${c.wind_speed_10m.toFixed(1)}</b><span>풍속 m/s · ${windDir(c.wind_direction_10m)}</span></div>
      <div><b>${c.wind_gusts_10m.toFixed(1)}</b><span>돌풍 m/s</span></div>
      <div><b>${Math.round(c.temperature_2m)}°</b><span>${WX[c.weather_code] || '날씨'}</span></div>
      <div><b>${sunrise}</b><span>일출</span></div>
      <div><b>${sunset}</b><span>일몰</span></div>
      <div><b>${c.precipitation}</b><span>강수 mm</span></div>
    </div>
    <div class="wx-note">${notes.join('<br>')}</div>`;
}

/* ───────── 지도 ───────── */
const map = L.map('map', { zoomControl: false, attributionControl: false }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
L.control.zoom({ position: 'topleft' }).addTo(map);
let baseLayers = {}, overlayLayers = {}, layerCtl;

function buildLayers() {
  if (layerCtl) { map.removeControl(layerCtl); }
  Object.values(baseLayers).concat(Object.values(overlayLayers)).forEach(l => map.removeLayer(l));
  baseLayers = {}; overlayLayers = {};
  const key = vkey();
  if (key) {
    const vw = (name, ext) => L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/${name}/{z}/{y}/{x}.${ext}`, { maxZoom: 19, minZoom: 6, attribution: '© V-World' });
    baseLayers['기본지도'] = vw('Base', 'png');
    const sat = vw('Satellite', 'jpeg'), hyb = vw('Hybrid', 'png');
    baseLayers['위성지도'] = L.layerGroup([sat, hyb]);
  } else {
    baseLayers['OpenStreetMap'] = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  }
  const firstBase = Object.values(baseLayers)[0]; firstBase.addTo(map);
  layerCtl = L.control.layers(baseLayers, {}, { position: 'topright', collapsed: true }).addTo(map);
  if (key) for (const z of ZONES) if (!z.optional || verified.has(z.id)) addZoneOverlay(z);
}
function addZoneOverlay(z) {
  const key = vkey(); if (!key || !layerCtl) return;
  const label = `<span style="color:${z.color}">■</span> ${z.name}`;
  if (overlayLayers[label]) return;
  const wms = L.tileLayer.wms('https://api.vworld.kr/req/wms', {
    layers: z.id.toLowerCase(), styles: z.id.toLowerCase(), format: 'image/png', transparent: true,
    version: '1.3.0', key, domain: location.origin, opacity: z.level === 0 ? 0.45 : 0.55, maxZoom: 19
  });
  overlayLayers[label] = wms;
  layerCtl.addOverlay(wms, label);
  if (!z.off) wms.addTo(map); // 범위가 넓은 구역은 기본 꺼짐
}
buildLayers();

let pinMarker = null, meMarker = null, meCircle = null, zoneGeo = L.layerGroup().addTo(map);
let lastResult = null;

map.on('click', e => checkAt(e.latlng.lat, e.latlng.lng));
map.on('moveend', () => { const c = map.getCenter(); LS.set('mapView', { lat: c.lat, lng: c.lng, z: map.getZoom() }); });

/* ───────── 하단 시트 ───────── */
const sheet = $('#sheet');
// 결과 창 높이가 바뀌면(접기·펼치기·내용 변경) 보이는 지도 영역의 가운데가 그대로 유지되도록 지도를 같이 움직임
let lastSheetH = 0;
function setSheetHeight() {
  const h = sheet.offsetHeight;
  if (!h) return; // 다른 탭을 보는 중
  document.documentElement.style.setProperty('--sheet-h', h + 'px');
  if (lastSheetH && h !== lastSheetH) map.panBy([0, Math.round((h - lastSheetH) / 2)], { animate: true, duration: 0.25 });
  lastSheetH = h;
}
// 검색창 아래 ~ 결과 창 위, 실제로 보이는 지도 영역의 가운데에 지점이 오도록 이동
function setViewVisible(latlng, zoom) {
  const H = map.getSize().y;
  const sb = $('.searchbar');
  const top = sb.offsetTop + $('#searchForm').offsetHeight;
  const bottom = H - (sheet.offsetHeight || 0);
  const offset = bottom > top ? H / 2 - (top + bottom) / 2 : 0;
  const p = map.project(latlng, zoom).add([0, offset]);
  map.setView(map.unproject(p, zoom), zoom);
}
new ResizeObserver(setSheetHeight).observe(sheet);
// 결과 창 접기/펼치기: 버튼 누르기 또는 위·아래로 밀기
function setCollapsed(on) {
  sheet.classList.toggle('collapsed', on);
  LS.set('sheetCollapsed', on);
  $('#sheetHandleText').textContent = on ? '펼치기' : '접기';
  $('#sheetHandle').setAttribute('aria-label', on ? '결과 창 펼치기' : '결과 창 접기');
}
setCollapsed(LS.get('sheetCollapsed', false)); // 새로고침해도 접힌 상태 유지
let handleY = null, handleSwiped = false;
$('#sheetHandle').addEventListener('touchstart', e => { handleY = e.touches[0].clientY; handleSwiped = false; }, { passive: true });
$('#sheetHandle').addEventListener('touchmove', e => {
  if (handleY == null) return;
  const dy = e.touches[0].clientY - handleY;
  if (Math.abs(dy) > 25) { setCollapsed(dy > 0); handleSwiped = true; handleY = null; }
}, { passive: true });
$('#sheetHandle').addEventListener('click', () => { if (handleSwiped) { handleSwiped = false; return; } setCollapsed(!sheet.classList.contains('collapsed')); });
function sheetHtml(html) { $('#sheetBody').innerHTML = html; $('#sheetBody').scrollTop = 0; } // 접기/펼치기 상태는 사용자가 정한 대로 유지

/* ───────── 판정 실행 ───────── */
let checkSeq = 0;
async function checkAt(lat, lon, label) {
  const seq = ++checkSeq;
  if (label !== '내 위치') $('#btnLocate').classList.remove('found');
  if (!vkey()) {
    sheetHtml(`<div class="verdict v-gray"><div class="ico">🔑</div><div><b>인증키가 필요합니다</b><small>config.js에 V-World 인증키를 넣어주세요.</small></div></div>`);
    return;
  }
  if (pinMarker) pinMarker.setLatLng([lat, lon]); else pinMarker = L.marker([lat, lon]).addTo(map);
  zoneGeo.clearLayers();
  sheetHtml(`<div class="hint"><span class="spinner"></span>공역 정보를 확인하는 중…</div>`);

  const [res, addr] = await Promise.all([analyze(lat, lon), reverseGeocode(lat, lon)]);
  if (seq !== checkSeq) return;
  res.addr = addr; res.label = label || '';
  if (label === '내 위치') setMyAddress(addr);
  LS.set('lastPoint', { lat, lon, label: label || '' });
  lastResult = res;
  renderResult(res);
  drawZones(res);

  fetchWeather(lat, lon).then(w => {
    if (seq !== checkSeq) return;
    const box = $('#wxBox'); if (box) box.innerHTML = weatherHtml(w);
    applyWeatherToVerdict(res, weatherIssues(w));
  }).catch(() => { const box = $('#wxBox'); if (box) box.innerHTML = '<p class="muted small">날씨 정보를 불러오지 못했습니다.</p>'; });
}

// 공역 판정 + 현재 조건(야간·바람·비·안개)을 합쳐 맨 위 판정을 갱신
function applyWeatherToVerdict(r, iss) {
  const probs = [];
  if (iss.night) probs.push(`야간(일몰 ${iss.sunset}~일출 ${iss.sunrise})`);
  if (iss.windStrong) probs.push('강풍');
  if (iss.rain) probs.push('비·눈');
  if (iss.fog) probs.push('안개');
  if (!probs.length) return;
  const v = r.verdict, el = $('#sheetBody .verdict');
  if (!el) return;
  if (v.code === 'ok' || v.code === 'caution') {
    const what = probs.join(', ');
    const reason = iss.night ? '야간 비행은 특별비행승인 없이 할 수 없습니다.' : '지금은 안전한 비행이 어렵습니다.';
    r.verdict = Object.assign({}, v, {
      cls: 'v-yellow', ico: iss.night ? '🌙' : '🌬️',
      title: `공역은 ${v.code === 'ok' ? '비행 가능' : '주의'} · 지금은 ${iss.night ? '야간' : '비행 부적합'}`,
      desc: `${what} — ${reason} ${iss.night ? `일출(${iss.sunrise}) 이후 비행하세요.` : '날씨가 좋아진 뒤 비행하세요.'}${v.nearNote ? ' 참고로 ' + v.nearNote : ''}`,
      code: v.code, now: 'bad'
    });
  } else {
    r.verdict = Object.assign({}, v, { desc: v.desc + ` 또한 지금은 ${probs.join(', ')}입니다.` });
  }
  const nv = r.verdict;
  el.className = 'verdict ' + nv.cls;
  el.innerHTML = `<div class="ico">${nv.ico}</div><div><b>${esc(nv.title)}</b><small>${esc(nv.desc)}</small></div>`;
}

function zoneRow(x, showDist) {
  return `<div class="zone"><i style="background:${x.zone.color}"></i>
    <div class="z-main"><div class="z-name">${esc(x.zone.name)}</div>
      <div class="z-sub">${esc(x.label || x.zone.note)}</div>${propsTable(x.feature.properties)}</div>
    ${showDist ? `<div class="z-dist">${fmtDist(x.dist)}</div>` : ''}</div>`;
}

function renderResult(r) {
  const v = r.verdict;
  const addrLine = r.label || (r.addr && (r.addr.road || r.addr.parcel)) || '선택한 지점';
  const isMe = r.label === '내 위치';
  const sub = !isMe && r.addr && r.addr.road && r.addr.parcel ? r.addr.parcel : '';
  let h = `<div class="verdict ${v.cls}"><div class="ico">${v.ico}</div><div><b>${v.title}</b><small>${esc(v.desc)}</small></div></div>
    <p class="addr"><b>${esc(addrLine)}</b><br><span class="muted">${isMe ? '위도 ' + r.lat.toFixed(5) + ' · 경도 ' + r.lon.toFixed(5) : esc(sub) + ' ' + r.lat.toFixed(5) + ', ' + r.lon.toFixed(5)}</span></p>
    <div class="row-btns">
      <button class="btn sm" id="btnFav">☆ 장소 저장</button>
      <button class="btn sm" id="btnLogHere">📒 기록 추가</button>
      <button class="btn sm" id="btnFlyStart">⏱ 비행 시작</button>
      <button class="btn sm" id="btnCopy">📋 좌표·주소 복사</button>
      <a class="btn sm" href="https://drone.onestop.go.kr" target="_blank" rel="noopener">드론원스톱</a>
    </div>`;
  if (r.inside.length) h += `<div class="section-title">이 지점이 속한 공역</div>` + r.inside.map(x => zoneRow(x, false)).join('');
  const near = r.nearby.slice(0, 6);
  if (near.length) h += `<div class="section-title">반경 ${fmtDist(CFG.CHECK_RADIUS_M)} 내 주의 공역</div>` + near.map(x => zoneRow(x, true)).join('');
  if (r.failed.length && r.verdict.code !== 'error') h += `<p class="muted small">일부 데이터 조회 실패: ${r.failed.map(f => f.zone.name).join(', ')}</p>`;
  h += `<div id="wxBox"><div class="hint"><span class="spinner"></span>날씨 확인 중…</div></div>
    <p class="muted small" style="margin-top:12px">※ 참고용입니다. 임시 비행금지 등은 반영되지 않을 수 있으니 비행 전 드론 원스톱에서 최종 확인하세요.</p>`;
  sheetHtml(h);
  $('#btnFav').onclick = () => addFavorite(r);
  $('#btnLogHere').onclick = () => openLogForm({ fromResult: r });
  $('#btnFlyStart').onclick = () => startTimer();
  $('#btnCopy').onclick = () => copyPoint(r);
}

// 비행승인·촬영허가 신청서에 붙여넣기 좋게 정리
async function copyPoint(r) {
  const dms = v => { const t = Math.round(Math.abs(v) * 36000) / 10, d = Math.floor(t / 3600), m = Math.floor((t - d * 3600) / 60), sec = (t - d * 3600 - m * 60).toFixed(1); return `${d}°${m}'${sec}"`; };
  const zones = [...new Set(r.inside.map(x => x.zone.name + (x.label ? ` (${x.label})` : '')))].join(', ') || '해당 없음';
  const text = [
    `주소: ${(r.addr && (r.addr.road || r.addr.parcel)) || r.label || '-'}`,
    r.addr && r.addr.road && r.addr.parcel ? `지번: ${r.addr.parcel}` : '',
    `좌표: ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}`,
    `좌표(도분초): N ${dms(r.lat)} / E ${dms(r.lon)}`,
    `해당 공역: ${zones}`,
    `판정: ${r.verdict.title}`
  ].filter(Boolean).join('\n');
  if (window.NFZApp && window.NFZApp.share) { try { window.NFZApp.share(text); return; } catch (e) {} }
  try {
    if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) { await navigator.share({ title: '비행 지점', text }); return; }
    await navigator.clipboard.writeText(text); toast('복사했습니다. 비행승인 신청서에 붙여넣으세요.');
  } catch (e) {
    try { await navigator.clipboard.writeText(text); toast('복사했습니다.'); } catch (e2) { prompt('아래 내용을 복사하세요', text); }
  }
}

function drawZones(r) {
  zoneGeo.clearLayers();
  const items = r.inside.concat(r.nearby.slice(0, 6));
  for (const x of items) {
    L.geoJSON(x.feature, { style: { color: x.zone.color, weight: 2, fillOpacity: x.dist === 0 ? 0.18 : 0.06, dashArray: x.dist === 0 ? null : '6 4' }, interactive: false }).addTo(zoneGeo);
  }
}

/* ───────── 현재 위치 ───────── */
function showMe(lat, lon, accuracy) {
  if (meMarker) { meMarker.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]).setRadius(accuracy); }
  else {
    meCircle = L.circle([lat, lon], { radius: accuracy, color: '#1e88e5', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    meMarker = L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#1e88e5', fillOpacity: 1 }).addTo(map);
  }
}
// opt.quiet: 알림 없이 / opt.fallback: 실패하면 이 지점을 판정 / opt.keepView: 지도 위치 유지
function locateMe(opt = {}) {
  if (!navigator.geolocation) { if (opt.fallback) checkAt(opt.fallback.lat, opt.fallback.lon, opt.fallback.label); else toast('이 기기는 위치 기능을 지원하지 않습니다.'); return; }
  if (!opt.quiet) toast('현재 위치를 찾는 중…');
  const fab = $('#btnLocate'); fab.classList.add('locating');
  navigator.geolocation.getCurrentPosition(p => {
    fab.classList.remove('locating'); fab.classList.add('found');
    const { latitude: lat, longitude: lon, accuracy } = p.coords;
    showMe(lat, lon, accuracy);
    setViewVisible([lat, lon], opt.keepView ? map.getZoom() : Math.max(map.getZoom(), 14));
    checkAt(lat, lon, '내 위치');
  }, err => {
    fab.classList.remove('locating', 'found');
    if (opt.fallback) { checkAt(opt.fallback.lat, opt.fallback.lon, opt.fallback.label); return; }
    toast(err.code === 1 ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.' : '위치를 가져오지 못했습니다.');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}
$('#btnLocate').addEventListener('click', () => locateMe());

/* ───────── 검색 & 즐겨찾기 ───────── */
const resultsBox = $('#searchResults');
// 검색창을 누르면: 최근 검색 + 저장한 장소
function showFavorites() {
  const recent = LS.get('recentSearches', []), favs = LS.get('favorites', []);
  if (!recent.length && !favs.length) { resultsBox.innerHTML = '<div class="item"><span>최근 검색 기록이 없습니다.</span></div>'; resultsBox.classList.remove('hidden'); return; }
  let h = '';
  if (recent.length) {
    h += '<div class="head">🕘 최근 검색<button type="button" class="head-btn" data-clear="1">전체 삭제</button></div>';
    h += recent.map((x, i) => `<div class="item row" data-rec="${i}"><div class="grow"><b>${esc(x.title)}</b><span>${esc(x.sub || '')}</span></div><button type="button" class="x" data-delrec="${i}" aria-label="삭제">✕</button></div>`).join('');
  }
  if (favs.length) {
    h += '<div class="head">★ 저장한 장소</div>';
    h += favs.map((f, i) => `<div class="item row" data-fav="${i}"><div class="grow"><b>${esc(f.name)}</b><span>${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}</span></div><button type="button" class="x" data-delfav="${i}" aria-label="삭제">✕</button></div>`).join('');
  }
  resultsBox.innerHTML = h;
  resultsBox.classList.remove('hidden');
  resultsBox.querySelectorAll('[data-rec]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('.x')) return; const x = recent[+el.dataset.rec]; addRecent(x); goTo(x.lat, x.lon, x.title);
  }));
  resultsBox.querySelectorAll('[data-fav]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('.x')) return; const f = favs[+el.dataset.fav]; goTo(f.lat, f.lon, f.name);
  }));
  resultsBox.querySelectorAll('[data-delrec]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation(); recent.splice(+el.dataset.delrec, 1); LS.set('recentSearches', recent); showFavorites();
  }));
  resultsBox.querySelectorAll('[data-delfav]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation(); const f = favs[+el.dataset.delfav];
    if (confirm(`저장한 장소 '${f.name}'을(를) 삭제할까요?`)) { favs.splice(+el.dataset.delfav, 1); LS.set('favorites', favs); }
    showFavorites();
  }));
  const clr = resultsBox.querySelector('[data-clear]');
  if (clr) clr.addEventListener('click', e => { e.stopPropagation(); LS.set('recentSearches', []); showFavorites(); });
}
function addRecent(x) {
  const list = LS.get('recentSearches', []).filter(r => !(r.title === x.title && Math.abs(r.lat - x.lat) < 1e-5 && Math.abs(r.lon - x.lon) < 1e-5));
  list.unshift({ title: x.title, sub: x.sub || '', lat: x.lat, lon: x.lon });
  LS.set('recentSearches', list.slice(0, 15));
}
function addFavorite(r) {
  const def = r.label && r.label !== '내 위치' ? r.label : (r.addr && (r.addr.road || r.addr.parcel)) || '저장한 장소';
  const name = prompt('저장할 이름', def);
  if (!name) return;
  const favs = LS.get('favorites', []);
  favs.unshift({ name, lat: r.lat, lon: r.lon });
  LS.set('favorites', favs.slice(0, 50));
  toast('장소를 저장했습니다. 검색창을 누르면 볼 수 있어요.');
}
function goTo(lat, lon, name) {
  resultsBox.classList.add('hidden'); $('#searchInput').blur();
  setViewVisible([lat, lon], Math.max(map.getZoom(), 14));
  checkAt(lat, lon, name);
}
$('#searchInput').addEventListener('focus', () => { $('#searchInput').placeholder = '주소·장소 검색'; if (!$('#searchInput').value.trim()) showFavorites(); });
$('#searchInput').addEventListener('blur', () => { $('#searchInput').placeholder = myAddrText || SEARCH_PH; });
$('#searchInput').addEventListener('input', () => { if (!$('#searchInput').value.trim()) showFavorites(); });
document.addEventListener('click', e => { if (!e.target.closest('.searchbar')) resultsBox.classList.add('hidden'); });
$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (!q) return;
  if (!vkey()) return toast('검색하려면 V-World 인증키가 필요합니다.');
  resultsBox.innerHTML = '<div class="item"><span class="spinner"></span>검색 중…</div>';
  resultsBox.classList.remove('hidden');
  const list = await searchPlaces(q);
  if (!list.length) { resultsBox.innerHTML = '<div class="item"><span>검색 결과가 없습니다.</span></div>'; return; }
  resultsBox.innerHTML = list.map((x, i) => `<div class="item" data-i="${i}"><b>${esc(x.title)}</b><span>${esc(x.sub)}</span></div>`).join('');
  $$('.item', resultsBox).forEach(el => el.addEventListener('click', () => { const x = list[+el.dataset.i]; addRecent(x); goTo(x.lat, x.lon, x.title); }));
});

/* ───────── 새로고침 버튼 ───────── */
$('#btnRefresh').addEventListener('click', () => {
  const btn = $('#btnRefresh');
  if (btn.classList.contains('loading')) return;
  btn.classList.add('loading');
  setTimeout(() => location.reload(), 600); // 이전 화면·지점은 복원 기능으로 다시 판정됨
});

/* ───────── 탭 ───────── */
$$('.tabbar button').forEach(b => b.addEventListener('click', () => {
  $$('.tabbar button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === b.dataset.tab));
  if (b.dataset.tab === 'tab-map') setTimeout(() => map.invalidateSize(), 50);
  if (b.dataset.tab === 'tab-log') renderLogs();
  LS.set('lastTab', b.dataset.tab);
}));
function switchTab(id) { $(`.tabbar button[data-tab="${id}"]`).click(); }

/* ───────── 비행 타이머 ───────── */
let timerInt;
function startTimer() {
  if (LS.get('flightStart', null)) { toast('이미 비행 타이머가 켜져 있습니다.'); switchTab('tab-map'); return; }
  LS.set('flightStart', { t: Date.now(), result: lastResult ? slimResult(lastResult) : null });
  runTimer(); switchTab('tab-map'); toast('비행 타이머를 시작했습니다. 안전 비행하세요!');
}
function runTimer() {
  const st = LS.get('flightStart', null);
  if (!st) { $('#timerBanner').classList.add('hidden'); clearInterval(timerInt); return; }
  $('#timerBanner').classList.remove('hidden');
  const tick = () => { const s = Math.floor((Date.now() - st.t) / 1000); $('#timerText').textContent = (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); };
  tick(); clearInterval(timerInt); timerInt = setInterval(tick, 1000);
}
$('#btnTimerStop').addEventListener('click', () => {
  const st = LS.get('flightStart', null); if (!st) return;
  LS.set('flightStart', null); runTimer();
  const minutes = Math.max(1, Math.round((Date.now() - st.t) / 60000));
  openLogForm({ fromResult: st.result, minutes, date: new Date(st.t) });
});
$('#btnTimerStart').addEventListener('click', startTimer);
runTimer();

/* ───────── 비행 기록 ───────── */
function slimResult(r) {
  return { lat: r.lat, lon: r.lon, label: r.label, addr: r.addr, verdict: { code: r.verdict.code, title: r.verdict.title, cls: r.verdict.cls } };
}
const VCOLOR = { 'v-red': '#e53935', 'v-orange': '#fb8c00', 'v-yellow': '#f9a825', 'v-green': '#2e7d32', 'v-gray': '#78909c' };
function toLocalInput(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function openLogForm(opt = {}) {
  const f = $('#logForm'); f.reset();
  const logs = LS.get('flights', []);
  $('#droneList').innerHTML = [...new Set(logs.map(l => l.drone).filter(Boolean))].map(d => `<option value="${esc(d)}">`).join('');
  let rec = opt.edit;
  if (rec) {
    $('#logFormTitle').textContent = '기록 수정';
    f.rid.value = rec.id;
    ['lat', 'lng', 'date', 'place', 'drone', 'minutes', 'alt', 'batteries', 'memo'].forEach(k => { if (f[k]) f[k].value = rec[k] == null ? '' : rec[k]; });
    f.verdict.value = rec.verdict ? JSON.stringify(rec.verdict) : '';
  } else {
    $('#logFormTitle').textContent = '비행 기록 추가';
    f.date.value = toLocalInput(opt.date || new Date());
    const r = opt.fromResult;
    if (r) {
      f.lat.value = r.lat; f.lng.value = r.lon;
      f.place.value = (r.label && r.label !== '내 위치' ? r.label : '') || (r.addr && (r.addr.road || r.addr.parcel)) || '';
      f.verdict.value = JSON.stringify({ code: r.verdict.code, title: r.verdict.title, cls: r.verdict.cls });
    }
    if (opt.minutes) f.minutes.value = opt.minutes;
    const lastDrone = logs[0] && logs[0].drone; if (lastDrone) f.drone.value = lastDrone;
  }
  $('#logCoord').textContent = f.lat.value ? `위치: ${(+f.lat.value).toFixed(5)}, ${(+f.lng.value).toFixed(5)}${f.verdict.value ? ' · 판정: ' + JSON.parse(f.verdict.value).title : ''}` : '위치 정보 없음 (지도에서 지점을 확인한 뒤 기록하면 자동으로 들어갑니다)';
  $('#logModal').classList.remove('hidden');
}
$('#btnNewLog').addEventListener('click', () => openLogForm({ fromResult: lastResult }));
$('#btnLogCancel').addEventListener('click', () => $('#logModal').classList.add('hidden'));
$('#logModal').addEventListener('click', e => { if (e.target.id === 'logModal') $('#logModal').classList.add('hidden'); });
$('#logForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, logs = LS.get('flights', []);
  const num = v => v === '' ? null : Number(v);
  const rec = {
    id: f.rid.value || String(Date.now()), date: f.date.value, place: f.place.value.trim(), drone: f.drone.value.trim(),
    minutes: num(f.minutes.value), alt: num(f.alt.value), batteries: num(f.batteries.value), memo: f.memo.value.trim(),
    lat: f.lat.value ? Number(f.lat.value) : null, lng: f.lng.value ? Number(f.lng.value) : null,
    verdict: f.verdict.value ? JSON.parse(f.verdict.value) : null
  };
  const i = logs.findIndex(l => l.id === rec.id);
  if (i >= 0) logs[i] = rec; else logs.push(rec);
  logs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  LS.set('flights', logs);
  $('#logModal').classList.add('hidden');
  toast('비행 기록을 저장했습니다.');
  renderLogs();
});

function renderLogs() {
  const logs = LS.get('flights', []);
  const total = logs.reduce((s, l) => s + (l.minutes || 0), 0);
  const ym = toLocalInput(new Date()).slice(0, 7);
  const month = logs.filter(l => (l.date || '').startsWith(ym)).length;
  $('#logStats').innerHTML = `<div><b>${logs.length}</b><span>총 비행</span></div>
    <div><b>${total >= 60 ? Math.floor(total / 60) + 'h ' + (total % 60) + 'm' : total + 'm'}</b><span>총 비행시간</span></div>
    <div><b>${month}</b><span>이번 달</span></div>`;
  if (!logs.length) { $('#logList').innerHTML = '<div class="empty">아직 기록이 없습니다.<br>비행 후 기록을 남겨보세요 ✈️</div>'; return; }
  $('#logList').innerHTML = logs.map(l => {
    const d = l.date ? l.date.replace('T', ' ') : '';
    const meta = [l.drone, l.minutes != null ? l.minutes + '분' : '', l.alt != null ? '최고 ' + l.alt + 'm' : '', l.batteries != null ? '배터리 ' + l.batteries + '개' : ''].filter(Boolean).join(' · ');
    const tag = l.verdict ? `<span class="tag" style="background:${VCOLOR[l.verdict.cls] || '#78909c'}">${esc(l.verdict.title)}</span>` : '';
    return `<div class="log" data-id="${esc(l.id)}">
      <div class="log-top"><b>${esc(l.place || '장소 미입력')}</b>${tag}</div>
      <div class="meta">${esc(d)}${meta ? ' · ' + esc(meta) : ''}</div>
      ${l.memo ? `<div class="memo">${esc(l.memo)}</div>` : ''}
      <div class="row-btns">${l.lat != null ? '<button class="btn sm" data-act="map">🗺 지도</button>' : ''}
        <button class="btn sm" data-act="edit">수정</button><button class="btn sm danger" data-act="del">삭제</button></div></div>`;
  }).join('');
  $$('#logList .log').forEach(el => {
    const l = logs.find(x => x.id === el.dataset.id);
    $$('button', el).forEach(b => b.addEventListener('click', () => {
      if (b.dataset.act === 'map') { switchTab('tab-map'); goTo(l.lat, l.lng, l.place); }
      if (b.dataset.act === 'edit') openLogForm({ edit: l });
      if (b.dataset.act === 'del' && confirm('이 기록을 삭제할까요?')) { LS.set('flights', logs.filter(x => x.id !== l.id)); renderLogs(); }
    }));
  });
}

// 안드로이드 앱 안에서 실행 중이면 앱 기능(NFZApp)으로 저장·공유
const inApp = !!(window.NFZApp && window.NFZApp.saveFile);
function download(name, text, type) {
  if (inApp) { try { window.NFZApp.saveFile(name, text, type.split(';')[0]); return; } catch (e) {} }
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
$('#btnCsv').addEventListener('click', () => {
  const logs = LS.get('flights', []);
  if (!logs.length) return toast('내보낼 기록이 없습니다.');
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['일시', '장소', '위도', '경도', '판정', '기체', '비행시간(분)', '최대고도(m)', '배터리(개)', '메모'];
  const rows = logs.map(l => [l.date && l.date.replace('T', ' '), l.place, l.lat, l.lng, l.verdict && l.verdict.title, l.drone, l.minutes, l.alt, l.batteries, l.memo].map(q).join(','));
  download(`비행기록_${toLocalInput(new Date()).slice(0, 10)}.csv`, '\uFEFF' + [head.map(q).join(',')].concat(rows).join('\r\n'), 'text/csv;charset=utf-8');
});
$('#btnBackup').addEventListener('click', () => {
  const data = { app: 'dronezone', version: 1, exported: new Date().toISOString(), flights: LS.get('flights', []), favorites: LS.get('favorites', []) };
  download(`드론구역_백업_${toLocalInput(new Date()).slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
});
$('#fileRestore').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.flights)) throw new Error();
    const cur = LS.get('flights', []), ids = new Set(cur.map(x => x.id));
    const merged = cur.concat(data.flights.filter(x => x && !ids.has(x.id))).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    LS.set('flights', merged);
    if (Array.isArray(data.favorites)) {
      const favs = LS.get('favorites', []), keys = new Set(favs.map(f => f.name + f.lat + f.lon));
      LS.set('favorites', favs.concat(data.favorites.filter(f => f && !keys.has(f.name + f.lat + f.lon))));
    }
    toast(`기록 ${merged.length - cur.length}건을 불러왔습니다.`); renderLogs();
  } catch (err) { toast('백업 파일을 읽을 수 없습니다.'); }
  e.target.value = '';
});

/* ───────── 비행 전 점검 ───────── */
const CHECKS = [
  ['공역·허가', [
    '비행 지점이 비행금지·제한구역, 관제권이 아닌지 확인',
    '필요하면 드론 원스톱에서 비행승인·촬영허가 받음',
    '기체 무게에 맞는 조종자 증명·기체 신고 여부 확인',
    '사유지·공원·문화재 등은 관리자와 사전 협의'
  ]],
  ['날씨·현장', [
    '풍속·돌풍이 기체 한계 이내인지 확인',
    '비·안개가 없고 일출 후~일몰 전인지 확인',
    '주변에 사람이 모여 있지 않고, 전선·나무 등 장애물 확인',
    '이착륙 장소가 평평하고 안전한지 확인'
  ]],
  ['기체 점검', [
    '기체·조종기·휴대폰 배터리 충분히 충전',
    '프로펠러 손상·체결 상태 확인',
    '펌웨어·앱 최신 상태, 컴퍼스·IMU 이상 없음',
    'GPS 위성 충분히 수신 후 이륙',
    '자동귀환(RTH) 고도를 주변 장애물보다 높게 설정',
    '메모리카드 여유 공간 확인'
  ]],
  ['비행 중', [
    '고도 150m 미만, 눈으로 보이는 범위에서 비행',
    '배터리 30% 이하가 되면 귀환 시작'
  ]]
];
function renderChecks() {
  const st = LS.get('checks', {});
  let n = 0, done = 0, h = '';
  CHECKS.forEach(([g, items], gi) => {
    h += `<div class="chk-group">${g}</div>`;
    items.forEach((t, ii) => {
      const k = gi + '-' + ii; n++; if (st[k]) done++;
      h += `<label class="chk ${st[k] ? 'done' : ''}"><input type="checkbox" data-k="${k}" ${st[k] ? 'checked' : ''}><span>${esc(t)}</span></label>`;
    });
  });
  $('#checkList').innerHTML = h;
  $('#checkBar').style.width = (done / n * 100) + '%';
  $('#checkCount').textContent = done === n ? `모든 항목 완료! 안전 비행하세요 ✈️` : `${done} / ${n} 완료`;
  $$('#checkList input').forEach(i => i.addEventListener('change', () => { const s = LS.get('checks', {}); s[i.dataset.k] = i.checked; LS.set('checks', s); renderChecks(); }));
}
$('#btnCheckReset').addEventListener('click', () => { LS.set('checks', {}); renderChecks(); });
renderChecks();

/* ───────── 새로고침 시 이전 상태 복원 ───────── */
(function restore() {
  const tab = LS.get('lastTab', 'tab-map');
  if (tab !== 'tab-map' && $(`.tabbar button[data-tab="${tab}"]`)) switchTab(tab);
  const v = LS.get('mapView', null);
  if (v && isFinite(v.lat) && isFinite(v.lng)) map.setView([v.lat, v.lng], v.z || CFG.DEFAULT_ZOOM, { animate: false });
  const lp = LS.get('lastPoint', null);
  if (lp && vkey()) {
    if (lp.label === '내 위치') locateMe({ quiet: true, fallback: lp, keepView: !!v });
    else checkAt(lp.lat, lp.lon, lp.label);
  }
})();

/* ───────── 앱에서 실행 중이면 배지를 '앱버전'으로 ───────── */
if (window.NFZApp) {
  const bd = $('.appbar .badge');
  if (bd) bd.textContent = bd.textContent.replace('웹버전', '앱버전');
  const dl = $('#androidApp'); if (dl) dl.classList.add('hidden');
}

/* ───────── PWA ───────── */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// 테스트용 노출
window.__dz = { containsPoint, distToBoundary, makeVerdict, ZONES };
})();
