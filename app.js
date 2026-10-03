/* 드론 비행구역 확인 앱 — app.js */
(function () {
'use strict';

const CFG = Object.assign({ VWORLD_KEY: '', CHECK_RADIUS_M: 5000, DEFAULT_CENTER: [37.5665, 126.978], DEFAULT_ZOOM: 11 }, window.APP_CONFIG || {});

/* ───────── 저장소 ───────── */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) {
    const str = JSON.stringify(v);
    try { localStorage.setItem(k, str); return true; } catch (e) {}
    try { // 용량 부족 → 언제든 다시 받을 수 있는 전국 공역 자료부터 비움
      Object.keys(localStorage).filter(x => x.startsWith('nat:') && x !== k).forEach(x => localStorage.removeItem(x));
      localStorage.setItem(k, str); return true;
    } catch (e) { return false; }
  }
};
const vkey = () => (CFG.VWORLD_KEY || '').trim();
try { localStorage.removeItem('vworldKey'); } catch (e) {}
// v1.55~1.56 교통 CCTV(철회) 때 저장된 자료 정리
try { Object.keys(localStorage).filter(k => k === 'cctvList' || k === 'itsUse' || k.startsWith('cctvU:') || k.startsWith('cctv:')).forEach(k => localStorage.removeItem(k)); } catch (e) {}

/* ───────── 공역 종류 ───────── */
// level: 3=승인 없이 비행 불가, 2=승인 필요, 1=주의, 0=비행 가능 공역
// color·pat: 지도에 실제로 그려지는 무늬(드론 원스톱 범례와 같음) — 빗금(hatch) / 채움(fill)
// level: 판정 등급 (판정 결과 상자 색은 이 등급으로 정해짐)
const ZONES = [
  { id: 'LT_C_AISPRHC', name: '비행금지구역', level: 3, color: '#d32f2f', pat: 'hatch', note: '비행승인 없이 비행 불가' },
  { id: 'LT_C_AISCTRC', name: '관제권(공항 주변)', level: 3, color: '#9fb596', pat: 'fill', note: '원칙적으로 비행승인 필요' },
  { id: 'LT_C_AISRESC', name: '비행제한구역', level: 2, color: '#43a047', pat: 'hatch', note: '비행승인 필요' },
  { id: 'LT_C_AISDNGC', name: '위험구역', level: 2, color: '#3cc8b4', pat: 'hatch', note: '비행승인 필요' },
  { id: 'LT_C_AISMOAC', name: '군작전구역', level: 0, color: '#f9a825', pat: 'hatch', note: '군 작전 공역 — 취미 비행은 조종자 준수사항만 지키면 비행 가능', off: true },
  { id: 'LT_C_AISUAC',  name: '초경량비행장치 공역', level: 0, color: '#f2a0a0', pat: 'fill', note: '초경량비행장치 비행 공역' },
  // ↓ V-World에 있는지 확인되지 않은 레이어: 조회에 성공한 경우에만 사용·표시
  { id: 'LT_C_AISTEMP', name: '임시비행금지구역', level: 3, color: '#c62828', pat: 'hatch', note: '행사·훈련 등으로 임시 지정 — 비행 불가', optional: true, noCache: true },
  { id: 'LT_C_AISATZC', name: '비행장교통구역', level: 2, color: '#9e9e9e', pat: 'hatch', note: '비행장 주변 — 비행승인 필요', optional: true },
  { id: 'LT_C_AISALTC', name: '경계구역', level: 1, color: '#b39b72', pat: 'hatch', note: '훈련 등 경계 공역 — 비행 전 확인 권장', optional: true, off: true },
  { id: 'LT_C_WGISNPGUG', name: '국립공원', level: 1, color: '#2ecc40', pat: 'fill', note: '국립공원 — 공원사무소 사전 허가 필요', optional: true, off: true },
  { id: 'LT_C_AISDRONEZONE', name: '드론시범사업구역', level: 0, color: '#ef6c00', pat: 'hatch', note: '드론 실증·시범사업 구역', optional: true, off: true }
];
const swatch = z => `<span class="sw ${z.pat}" style="--c:${z.color}"></span>`;
const verified = new Set(LS.get('verifiedLayers', []));
function markVerified(z) {
  if (!z.optional || verified.has(z.id)) return;
  verified.add(z.id); LS.set('verifiedLayers', [...verified]);
  addZoneOverlay(z);
  renderMapLegend();
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

// 응답이 너무 늦으면 포기하는 fetch (느린 서버 하나가 전체를 붙잡지 않게)
function fetchT(url, opts = {}, ms = 12000) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ac ? setTimeout(() => ac.abort(), ms) : 0;
  return fetch(url, Object.assign({}, opts, ac ? { signal: ac.signal } : {})).then(r => {
    // 본문(json)을 다 받을 때까지도 같은 시간 제한 안에서
    const json = r.json.bind(r);
    r.json = () => json().finally(() => clearTimeout(t));
    return r;
  }, e => { clearTimeout(t); throw e; });
}

// V-World는 CORS를 허용하지 않아 JSONP(callback)로 호출
let jsonpSeq = 0;
// 브이월드에 한꺼번에 너무 많이 요청하면 일부가 실패하므로 4개씩 나눠서 보내고, 실패하면 한 번 더 시도
const JSONP_MAX = 4; let jsonpActive = 0; const jsonpQueue = [];
function jsonp(url, params, timeout = 15000, retries = 1) {
  return new Promise((resolve, reject) => {
    const run = () => {
      jsonpActive++;
      jsonpRaw(url, params, timeout).then(resolve, err => {
        if (retries > 0) setTimeout(() => jsonp(url, params, timeout, retries - 1).then(resolve, reject), 500);
        else reject(err);
      }).finally(() => { jsonpActive--; const next = jsonpQueue.shift(); if (next) next(); });
    };
    if (jsonpActive < JSONP_MAX) run(); else jsonpQueue.push(run);
  });
}
function jsonpRaw(url, params, timeout) {
  return new Promise((resolve, reject) => {
    const cb = '__vw' + (++jsonpSeq) + '_' + Date.now();
    const s = document.createElement('script');
    const timer = setTimeout(() => { finish(); reject(new Error('응답 시간 초과')); }, timeout);
    let done = false;
    function finish() { done = true; clearTimeout(timer); window[cb] = function () {}; s.remove(); }
    window[cb] = data => { finish(); try { delete window[cb]; } catch (e) {} resolve(data); };
    s.onerror = () => { finish(); reject(new Error('네트워크 오류')); };
    s.onload = () => setTimeout(() => { if (!done) { finish(); reject(new Error('응답 형식 오류')); } }, 100);
    s.src = url + '?' + new URLSearchParams(Object.assign({}, params, { callback: cb })).toString();
    document.head.appendChild(s);
  });
}
// 브이월드는 인증키에 등록한 '서비스 주소'와 요청의 domain 값을 비교해서 다르면 INCORRECT_KEY로 거절함.
// 등록 주소가 경로까지 포함(moto2345.github.io/nfz)이라 이 페이지 주소(경로 포함)를 먼저 쓰고,
// 그래도 거절되면 다른 형식으로 바꿔 보고, 통한 형식을 기억해서 다음부터 그것으로 보냄
const PAGE_BASE = location.origin + location.pathname.replace(/[^/]*$/, '');
const VW_DOMS = { base: PAGE_BASE, none: null, origin: location.origin };
const VW_ORDER = ['base', 'none', 'origin'];
let vwDom = (d => (d in VW_DOMS ? d : 'base'))(LS.get('vwDom', 'base'));
function vwParams(extra, dom = vwDom) {
  const p = Object.assign({ key: vkey(), format: 'json', errorFormat: 'json' }, extra);
  if (VW_DOMS[dom]) p.domain = VW_DOMS[dom];
  return p;
}
const isKeyErr = res => { const r = res && res.response; return !!(r && r.status === 'ERROR' && r.error && r.error.code === 'INCORRECT_KEY'); };
async function vwCall(path, extra, timeout) {
  const url = 'https://api.vworld.kr/req/' + path;
  const res = await jsonp(url, vwParams(extra), timeout);
  if (!isKeyErr(res)) return res;
  for (const d of VW_ORDER) { // 인증키 거절 → 다른 domain 형식으로 한 번씩
    if (d === vwDom) continue;
    const r2 = await jsonp(url, vwParams(extra, d), timeout).catch(() => null);
    if (r2 && r2.response && !isKeyErr(r2)) { setVwDom(d); return r2; }
  }
  return res;
}
function setVwDom(d) {
  if (d === vwDom) return;
  vwDom = d; LS.set('vwDom', d);
  // 공역 지도 그림(WMS)도 같은 형식으로 다시 받기
  Object.values(overlayLayers).forEach(l => {
    if (!l.wmsParams) return;
    if (VW_DOMS[d]) l.wmsParams.domain = VW_DOMS[d]; else delete l.wmsParams.domain;
    l.redraw();
  });
}

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
// 필수 공역이 계속 실패하면 → 휴대폰에 저장해 둔 전국 자료(없으면 지금 받아서)로 대신 판정
const KOREA_BOX = ['124', '32.5', '132', '39'];
const NATIONAL_KEEP = ['LT_C_AISPRHC', 'LT_C_AISCTRC']; // 전국 자료를 미리 받아 둘 공역(수가 적고 가장 중요)
const NATIONAL_DAYS = 30;      // 이 기간이 지나면 새로 받음
const NATIONAL_MAX_DAYS = 120; // 이보다 오래된 자료는 판정에 쓰지 않음
const nationalMem = new Map();
function nationalGet(id) {
  let c = nationalMem.get(id);
  if (!c) { c = LS.get('nat:' + id, null); if (c && Array.isArray(c.f) && c.f.length && c.f.length < 1000) nationalMem.set(id, c); else c = null; }
  return c && Date.now() - c.t < NATIONAL_MAX_DAYS * 864e5 ? c : null;
}
async function nationalFetch(zone) {
  const f = await queryLayerOnce(zone, KOREA_BOX, 30000);
  // 전국에 이 공역이 하나도 없거나(0건) 1000건에서 잘렸다면 믿을 수 없는 결과
  if (!f.length || f.length >= 1000) throw new Error('전국 자료 이상(' + f.length + '건)');
  const c = { t: Date.now(), f };
  nationalMem.set(zone.id, c);
  try { localStorage.setItem('nat:' + zone.id, JSON.stringify(c)); } catch (e) {} // 용량이 넘치면 이번 실행 동안만 사용
  return c;
}
function geomBox(g) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const poly of polygonsOf(g)) for (const ring of poly) for (const [x, y] of ring) {
    if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
  }
  return [x1, y1, x2, y2];
}
function inBox(features, bbox) {
  const [bx1, by1, bx2, by2] = bbox.map(Number);
  return features.filter(f => { const [x1, y1, x2, y2] = geomBox(f.geometry); return x1 <= bx2 && x2 >= bx1 && y1 <= by2 && y2 >= by1; });
}
// 판정이 잘 끝난 뒤 조용히 전국 자료를 받아 둠 (30일에 한 번)
let nationalBusy = false;
function nationalRefresh() {
  if (nationalBusy) return;
  const todo = ZONES.filter(z => NATIONAL_KEEP.includes(z.id) && !(nationalGet(z.id) && Date.now() - nationalGet(z.id).t < NATIONAL_DAYS * 864e5));
  if (!todo.length) return;
  nationalBusy = true;
  setTimeout(async () => { for (const z of todo) { try { await nationalFetch(z); } catch (e) {} } nationalBusy = false; }, 5000);
}
const decisive = z => !z.optional || (verified.has(z.id) && z.level >= 2); // 판정에 꼭 필요한 공역
// V-World에 없는 것으로 보이는 선택 레이어는 3번 연속 실패하면 7일간 조회를 쉼
const optFail = LS.get('optFail', {});
const optSkipped = z => z.optional && !verified.has(z.id) && optFail[z.id] && optFail[z.id].n >= 3 && Date.now() - optFail[z.id].t < 7 * 864e5;
function optResult(z, ok, err) {
  if (!z.optional) return;
  if (ok) { if (optFail[z.id]) { delete optFail[z.id]; LS.set('optFail', optFail); } return; }
  if (!err || !err.vw || err.code === 'INCORRECT_KEY') return; // 통신 문제·인증키 거부는 '없는 레이어'의 근거가 아님
  optFail[z.id] = { n: ((optFail[z.id] && optFail[z.id].n) || 0) + 1, t: Date.now() };
  // 확인됐던 레이어라도 5번 연속 '없음' 류 오류면 확인 해제 (브이월드에서 없어진 경우)
  if (verified.has(z.id) && optFail[z.id].n >= 5) { verified.delete(z.id); LS.set('verifiedLayers', [...verified]); }
  LS.set('optFail', optFail);
}
async function queryLayer(zone, bbox) {
  if (optSkipped(zone)) throw new Error('건너뜀');
  try { const r = await queryLayerOnce(zone, bbox); optResult(zone, true); return r; }
  catch (e) {
    optResult(zone, false, e);
    if (!decisive(zone)) throw e;
    await new Promise(r => setTimeout(r, 800));
    try { const r2 = await queryLayerOnce(zone, bbox); optResult(zone, true); return r2; } // 필수 공역은 한 번 더
    catch (e2) {
      if (zone.level < 1 || zone.noCache) throw e2; // 판정에 영향 없는 공역·수시로 바뀌는 임시 구역은 대체하지 않음
      let c = nationalGet(zone.id);
      if (!c) { try { c = await nationalFetch(zone); } catch (e3) {} }
      else if (Date.now() - c.t > NATIONAL_DAYS * 864e5) nationalFetch(zone).catch(() => {}); // 뒤에서 새로 받아 둠
      if (!c) throw e2;
      const out = inBox(c.f, bbox);
      out.fromNational = c.t;
      return out;
    }
  }
}
async function queryLayerOnce(zone, bbox, timeout) {
  const res = await vwCall('data', {
    service: 'data', request: 'GetFeature', version: '2.0', data: zone.id,
    size: '1000', page: '1', geometry: 'true', attribute: 'true', crs: 'EPSG:4326',
    geomFilter: `BOX(${bbox.join(',')})`
  }, timeout);
  const r = res && res.response;
  if (!r) throw new Error('잘못된 응답');
  if (r.status === 'NOT_FOUND') return [];
  if (r.status !== 'OK') throw Object.assign(new Error((r.error && (r.error.text || r.error.code)) || r.status), { vw: true, code: r.error && r.error.code });
  return (r.result && r.result.featureCollection && r.result.featureCollection.features) || [];
}

// 받아 둔 공역 자료: 받은 지점에서 반경 5km 안의 모든 구역 모양. 3km 안에서 움직이면 그대로 재사용(주변 구역까지 거리도 정확)
let zoneCache = null;
const ZONE_CACHE_M = 3000, ZONE_CACHE_MS = 10 * 60e3;
function zoneCacheFor(lat, lon) {
  const c = zoneCache;
  if (!c || Date.now() - c.t > ZONE_CACHE_MS) return null;
  const d = toLocal(lon, lat, c.lat, c.lon);
  return Math.hypot(d[0], d[1]) <= ZONE_CACHE_M ? c : null;
}
async function analyze(lat, lon, opt = {}) {
  let settled;
  const cached = opt.cache && zoneCacheFor(lat, lon);
  if (cached) settled = cached.settled;
  else {
    const bbox = bboxAround(lat, lon, CFG.CHECK_RADIUS_M);
    settled = await Promise.allSettled(ZONES.map(z => queryLayer(z, bbox)));
    // 필수 공역을 모두 받았을 때만 보관 (빠진 게 있으면 다음에 다시 받음)
    if (!settled.some((x, i) => x.status === 'rejected' && decisive(ZONES[i]))) zoneCache = { lat, lon, t: Date.now(), settled };
  }
  const inside = [], nearby = [], failed = [], fromNational = [];
  settled.forEach((s, i) => {
    const zone = ZONES[i];
    if (s.status === 'rejected') { if (decisive(zone)) failed.push({ zone, error: s.reason && s.reason.message }); return; }
    if (s.value.fromNational) fromNational.push({ zone, t: s.value.fromNational });
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
  // 항공고시보(NOTAM): 지금 활성인 구역 안이면 종류별 판정, 시간제 비활성·예정이면 주의로 안내
  await Promise.race([notamReady, new Promise(r => setTimeout(r, 4000))]);
  const soonLimit = Date.now() + 864e5;
  for (const it of notamList()) {
    if (!it.geometry) continue;
    const st = notamStatus(it);
    if (st === 'upcoming' && Date.parse(it.start) > soonLimit) continue; // 하루 넘게 남은 예정은 판정에서 제외
    const zone = notamZone(it, st);
    const item = { zone, feature: notamFeature(it), label: `${it.no} · ${notamPeriod(it)}`, notam: it, notamSt: st };
    if (containsPoint(it.geometry, lon, lat)) { item.dist = 0; (st === 'active' ? inside : nearby).push(item); }
    else { item.dist = distToBoundary(it.geometry, lon, lat); if (item.dist <= CFG.CHECK_RADIUS_M) nearby.push(item); }
  }
  inside.sort((a, b) => b.zone.level - a.zone.level);
  nearby.sort((a, b) => a.dist - b.dist);
  const verdict = makeVerdict(inside, nearby, failed);
  const notamMissing = !notamData;
  const notamAge = notamData && notamData.fetchedAtUTC ? (Date.now() - Date.parse(notamData.fetchedAtUTC)) / 3600e3 : 0;
  if (verdict.code === 'ok' || verdict.code === 'caution') {
    const warn = notamMissing ? '항공고시보(임시 비행금지 등)를 아직 불러오지 못해 판정에 반영되지 않았어요.'
      : notamAge > 8 ? `항공고시보 자료가 ${Math.round(notamAge)}시간 전 것이라 최신이 아닐 수 있어요.` : '';
    if (warn) { verdict.desc += ' ⚠️ ' + warn; verdict.nearNote = [verdict.nearNote, warn].filter(Boolean).join(' '); }
  }
  return { lat, lon, inside, nearby, failed, fromNational, notamMissing, verdict };
}

function makeVerdict(inside, nearby, failed) {
  const top = inside.reduce((m, x) => Math.max(m, x.zone.level), -1);
  const has = id => inside.some(x => x.zone.id === id);
  const near = nearby[0];
  if (top === 3) {
    const names = [...new Set(inside.filter(x => x.zone.level === 3).map(x => x.zone.name))].join(', ');
    return { cls: 'v-red', ico: '⛔', title: '비행 불가 (승인 필요)', desc: `${names} 안입니다. 드론 원스톱에서 비행승인을 받아야 합니다.`, code: 'no' };
  }
  if (failed.filter(f => !f.zone.optional && f.zone.level >= 1).length >= ZONES.filter(z => !z.optional && z.level >= 1).length) {
    const why = [...new Set(failed.map(f => f.error).filter(Boolean))].slice(0, 2).join(' / ');
    return { cls: 'v-gray', ico: '❔', title: '판정할 수 없음', desc: '공역 데이터를 불러오지 못했습니다. 아래 [다시 확인]을 눌러 주세요.' + (why ? ` (원인: ${why})` : ''), code: 'error' };
  }
  // 불러오지 못한 공역이 지금 찾은 것보다 더 엄격할 수 있으면 판정을 확정하지 않음
  const critical = failed.filter(f => f.zone.level >= 1 && f.zone.level > Math.max(top, 0));
  if (critical.length) {
    const names = critical.map(f => f.zone.name).join(', ');
    const why = [...new Set(critical.map(f => f.error).filter(Boolean))].slice(0, 2).join(' / ');
    const tail = `${names} 데이터를 불러오지 못해 판정을 확정할 수 없습니다. 아래 [다시 확인]을 눌러 주세요.` + (why ? ` (원인: ${why})` : '');
    if (top === 2) {
      const n2 = [...new Set(inside.filter(x => x.zone.level === 2).map(x => x.zone.name))].join(', ');
      return { cls: 'v-orange', ico: '⚠️', title: '비행승인 필요 (일부 확인 불완전)', desc: `${n2} 안이라 최소한 비행승인이 필요합니다. ` + tail, code: 'partial' };
    }
    return { cls: 'v-gray', ico: '⚠️', title: '확인 불완전 — 다시 확인 필요', desc: tail, code: 'partial' };
  }
  if (top === 2) {
    const names = [...new Set(inside.filter(x => x.zone.level === 2).map(x => x.zone.name))].join(', ');
    return { cls: 'v-orange', ico: '⚠️', title: '비행승인 필요', desc: `${names} 안입니다. 드론 원스톱에서 비행승인을 받아야 합니다.`, code: 'approval' };
  }
  // 이 지점이 시간제(지금 비활성)·곧 시작될 항공고시보 구역 안이면 따로 알림
  const soon = nearby.find(x => x.notam && x.dist === 0);
  const soonNote = !soon ? '' : soon.notamSt === 'standby'
    ? `이 지점은 시간제 ${notamKind(soon.notam).name}(항공고시보 ${soon.notam.no}) 안이에요. 지금은 비활성이지만 활성 시간(${scheduleText(soon.notam)})에는 비행하면 안 됩니다.`
    : `이 지점은 ${notamPeriod(soon.notam)} ${notamKind(soon.notam).name}(항공고시보 ${soon.notam.no}) 예정입니다.`;
  if (top === 1) {
    const names = [...new Set(inside.filter(x => x.zone.level === 1).map(x => x.zone.name))].join(', ');
    const park = has('LT_C_WGISNPGUG') ? ' 국립공원 안에서는 공원사무소 허가가 필요합니다.' : '';
    return { cls: 'v-yellow', ico: '🟡', title: '주의 — 확인 후 비행', desc: `${names} 안입니다.${park} 비행 전 드론 원스톱에서 확인하세요.` + (soonNote ? ' ⚠️ ' + soonNote : ''), code: 'caution', nearNote: soonNote };
  }
  const base = has('LT_C_AISUAC') ? '초경량비행장치 공역입니다.' : '확인된 비행금지·제한 공역이 없습니다.';
  const near1 = nearby.find(x => !(x.notam && x.dist === 0));
  const nearTxt = near1 && near1.dist < 1000 ? `${fmtDist(near1.dist)} 옆에 ${near1.zone.name}이 있습니다.` : '';
  const warn = ' 조종자 준수사항(주간·25kg 이하·150m 미만·가시권)을 지키면 비행할 수 있습니다.' + (nearTxt ? ` 단, ${nearTxt.replace('있습니다.', '있으니 넘어가지 않게 주의하세요.')}` : '') + (soonNote ? ' ⚠️ ' + soonNote : '');
  return { cls: 'v-green', ico: '✅', title: '비행 가능 · 비행승인 불필요', desc: base + warn, code: 'ok', nearNote: [nearTxt, soonNote].filter(Boolean).join(' ') };
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
    const res = await vwCall('address', {
      service: 'address', request: 'getAddress', version: '2.0', crs: 'epsg:4326', point: `${lon},${lat}`, type: 'both'
    }, 8000);
    const r = res && res.response;
    if (r && r.status === 'OK' && r.result && r.result.length) {
      const road = r.result.find(x => x.type === 'road'), parcel = r.result.find(x => x.type === 'parcel');
      return { road: road && road.text, parcel: parcel && parcel.text };
    }
  } catch (e) {}
  return null;
}

async function searchPlaces(q) {
  const common = { service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: '8', page: '1', query: q };
  const reqs = [
    vwCall('search', Object.assign({}, common, { type: 'place' })),
    vwCall('search', Object.assign({}, common, { type: 'address', category: 'road' })),
    vwCall('search', Object.assign({}, common, { type: 'address', category: 'parcel' })),
    vwCall('search', Object.assign({}, common, { type: 'district', category: 'L4' }))
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
    current: 'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,wind_speed_120m',
    hourly: 'precipitation_probability,precipitation', forecast_hours: '3',
    daily: 'sunrise,sunset,weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max',
    timezone: 'Asia/Seoul', wind_speed_unit: 'ms', forecast_days: '7'
  });
  const [r, kp] = await Promise.all([fetchT(u, {}, 12000), Promise.race([fetchKp(), new Promise(res => setTimeout(() => res(null), 6000))]).catch(() => null)]);
  if (!r.ok) throw new Error('날씨 오류');
  const w = await r.json();
  w.kp = kp;
  if (w.current) { setPRef(w.current, lat, lon); setHudWx(w.current, lat, lon); } // 기압계 고도 기준·계기판 바람/기온으로도 씀
  if (kp) updateKpBadge(kp);
  return w;
}
// 지자기 Kp 지수 (미국 해양대기청 우주기상센터) — 지구 전체 값, 10분간 재사용
let kpCache = null;
async function fetchKp() {
  if (kpCache && Date.now() - kpCache.t < 600e3) return kpCache.v;
  const base = 'https://services.swpc.noaa.gov/';
  const [a, b] = await Promise.all([
    fetchT(base + 'json/planetary_k_index_1m.json', {}, 6000).then(r => r.ok ? r.json() : null).catch(() => null),
    fetchT(base + 'products/noaa-planetary-k-index-forecast.json', {}, 6000).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  let now = null, max6 = null;
  if (Array.isArray(a) && a.length) { const l = a[a.length - 1]; now = +(l.estimated_kp != null ? l.estimated_kp : l.kp_index); }
  if (Array.isArray(b) && b.length) {
    // 형식: 객체 배열 {time_tag, kp, observed} (예전 형식: 첫 줄이 머리글인 배열의 배열)
    const rows = Array.isArray(b[0]) ? b.slice(1).map(x => ({ time_tag: x[0], kp: x[1] })) : b;
    const t0 = Date.now() - 3 * 3600e3, t1 = Date.now() + 6 * 3600e3;
    for (const x of rows) {
      const t = Date.parse(String(x.time_tag).replace(' ', 'T') + (/[Z+]/.test(x.time_tag) ? '' : 'Z'));
      if (t >= t0 && t <= t1 && isFinite(+x.kp)) max6 = Math.max(max6 == null ? 0 : max6, +x.kp);
    }
    if (now == null) { const past = rows.filter(x => Date.parse(String(x.time_tag).replace(' ', 'T') + 'Z') <= Date.now()); if (past.length) now = +past[past.length - 1].kp; }
  }
  if (now == null || !isFinite(now)) throw new Error('Kp 없음');
  const v = { now: Math.round(now * 10) / 10, max6: max6 != null ? Math.round(max6 * 10) / 10 : null };
  kpCache = { t: Date.now(), v };
  return v;
}
const kpLevel = k => k >= 5 ? { cls: 'kp-bad', txt: '폭풍' } : k >= 4 ? { cls: 'kp-mid', txt: '약간 불안정' } : { cls: 'kp-ok', txt: '안정' };
// 지도 왼쪽 아래 Kp 표시 — 앱을 열면 바로 받아오고 10분마다 새로
let kpShown = null;
function updateKpBadge(v) {
  const el = $('#kpBadge'); if (!el) return;
  if (!v) return; // 못 받아오면 이전 값 유지(처음이면 숨김)
  kpShown = v;
  const lv = kpLevel(v.now);
  el.className = 'kp-badge ' + lv.cls;
  $('#kpVal').textContent = v.now;
  fitMapButtons();
}
function refreshKp() { if (!document.hidden) fetchKp().then(updateKpBadge).catch(() => {}); }
refreshKp();
setInterval(refreshKp, 600e3);
// Kp 버튼 → 안내 카드 (현재 값·단계·눈금·비행 조언·6시간 예보). 카드나 바깥을 누르면 닫힘, 15초 뒤 자동으로 닫힘
let kpCardTimer = null;
function closeKpCard() { $('#kpCard').classList.add('hidden'); clearTimeout(kpCardTimer); }
function openKpCard() {
  if (!kpShown) return;
  const k = kpShown.now, m = kpShown.max6, lv = kpLevel(k), card = $('#kpCard');
  card.className = 'kp-card ' + lv.cls;
  $('#kpcVal').textContent = k;
  $('#kpcLv').textContent = lv.txt;
  $('#kpcMark').style.left = `${Math.max(0, Math.min(9, k)) / 9 * 100}%`;
  $('#kpcMsg').textContent = k >= 5 ? '⛔ GPS·나침반이 불안정할 수 있어요. 수동(ATTI) 조종에 자신 없으면 비행을 미루세요.'
    : k >= 4 ? '⚠️ GPS 위성 수와 홈포인트 기록을 꼭 확인하고 비행하세요.' : '✅ GPS·나침반 영향이 거의 없어요. 평소처럼 비행해도 돼요.';
  const fc = $('#kpcFc');
  fc.classList.toggle('hidden', m == null);
  if (m != null) {
    fc.textContent = `🕒 앞으로 6시간 예보 최대 Kp ${m}` + (m >= 5 ? ' — 폭풍 예보, 긴 비행은 피하세요' : m >= 4 ? ' — 약간 불안정해질 수 있어요' : ' — 안정 예상');
    fc.classList.toggle('warn', m >= 5);
  }
  clearTimeout(kpCardTimer); kpCardTimer = setTimeout(closeKpCard, 15000);
}
$('#kpBadge').addEventListener('click', e => {
  e.stopPropagation();
  if (!$('#kpCard').classList.contains('hidden')) return closeKpCard();
  openKpCard();
});
$('#kpCard').addEventListener('click', closeKpCard);
document.addEventListener('pointerdown', e => { if (!e.target.closest('#kpCard, #kpBadge')) closeKpCard(); }, true);
// 기체별 공식 사양 (DJI 한국 사이트 스펙, 2026-09 확인)
// wind: 내풍 가능 최대 풍속(m/s) — 강풍 판정 / g: 표준 이륙 무게 / ft: 최대 비행시간(분) — 타이머 알림 / tmin: 최저 작동 온도(℃)
const DRONES = [
  { id: 'std', name: '기체 선택 안 함 (250g급 기준)', wind: 10.7 },
  { id: 'mini2se', name: 'DJI Mini 2 SE', wind: 10.7, g: 246, ft: 31, tmin: 0 },
  { id: 'mini3', name: 'DJI Mini 3', wind: 10.7, g: 248, ft: 38, tmin: -10 },
  { id: 'mini3pro', name: 'DJI Mini 3 Pro', wind: 10.7, g: 249, ft: 34, tmin: -10 },
  { id: 'mini4k', name: 'DJI Mini 4K', wind: 10.7, g: 249, ft: 31 },
  { id: 'mini4pro', name: 'DJI Mini 4 Pro', wind: 10.7, g: 249, ft: 34, tmin: -10 },
  { id: 'mini5pro', name: 'DJI Mini 5 Pro', wind: 12, g: 249.9, ft: 36, tmin: -10, gNote: '공식 무게 249.9g ±4g — 250g을 넘을 수 있어요' },
  { id: 'lito1', name: 'DJI Lito 1', wind: 10.7, g: 249, ft: 36, tmin: 0, gNote: '최대 이륙 무게는 약 340g' },
  { id: 'litox1', name: 'DJI Lito X1', wind: 10.7, g: 249, ft: 36, tmin: -10, gNote: '최대 이륙 무게는 약 340g' },
  { id: 'neo', name: 'DJI Neo', wind: 8, g: 135, ft: 18, tmin: -10 },
  { id: 'neo2', name: 'DJI Neo 2', wind: 10.7, g: 151, ft: 19, tmin: -10 },
  { id: 'flip', name: 'DJI Flip', wind: 10.7, g: 249, ft: 31, tmin: -10 },
  { id: 'air3', name: 'DJI Air 3', wind: 12, g: 720, ft: 46, tmin: -10 },
  { id: 'air3s', name: 'DJI Air 3S', wind: 12, g: 724, ft: 45, tmin: -10 },
  { id: 'mavic3', name: 'DJI Mavic 3 Classic', wind: 12, g: 895, ft: 46, tmin: -10 },
  { id: 'mavic3pro', name: 'DJI Mavic 3 Pro', wind: 12, g: 958, ft: 43, tmin: -10 },
  { id: 'mavic4pro', name: 'DJI Mavic 4 Pro', wind: 12, g: 1063, ft: 51, tmin: -10 },
  { id: 'avata2', name: 'DJI Avata 2', wind: 10.7, g: 377, ft: 23, tmin: -10 },
  { id: 'avata360', name: 'DJI Avata 360', wind: 10.7, g: 455, ft: 23, tmin: -10 },
  { id: 'inspire2', name: 'DJI Inspire 2', wind: 10, g: 3440, ft: 27, tmin: -20 },
  { id: 'inspire3', name: 'DJI Inspire 3', wind: 12, g: 3995, ft: 28, tmin: -20, note: '이착륙 12m/s · 비행 중 14m/s' },
  { id: 'etc-s', name: '기타 소형 (250g 미만)', wind: 8 },
  { id: 'etc-m', name: '기타 중형 (250g~2kg)', wind: 10 }
];
// 무게로 본 조종자 자격·기체 신고 (비사업용 기준, 2026-09 현재)
function droneRules(d) {
  if (!d.g) return '';
  const cert = d.g <= 250 ? '조종자 증명 불필요 (250g 이하)' : d.g <= 2000 ? '4종 조종자 증명 필요 (온라인 교육)' : d.g <= 7000 ? '3종 조종자 증명 필요' : d.g <= 25000 ? '2종 조종자 증명 필요' : '1종 조종자 증명 필요';
  const reg = d.g > 2000 ? ' · 기체 신고 필요' : '';
  return `🪪 ${cert}${reg}${d.gNote ? ` (${d.gNote}, 배터리·부착물로 무거워지면 기준이 바뀌어요)` : ''}${d.g <= 2000 ? ' · 2kg 이하 비사업용 기체도 신고 대상에 넣는 개정안이 입법예고 중이에요' : ''}`;
}
// 기온 판정: 기체 최저 작동 온도보다 낮으면 비행 불가, 10℃ 미만은 배터리 주의, 40℃ 이상은 작동 온도 밖
function tempIssue(tC, d = currentDrone()) {
  if (!isFinite(tC)) return null;
  const tmin = d.tmin != null ? d.tmin : null;
  if (tmin != null && tC < tmin) return { lv: 'bad', txt: `작동 온도 밖 (최저 ${tmin}℃)`, why: `작동 온도(최저 ${tmin}℃)보다 낮아` };
  if (tC >= 40) return { lv: 'bad', txt: '작동 온도 밖 (최고 40℃)', why: '작동 온도(최고 40℃)를 넘어' };
  if (tC < 10) return { lv: 'mid', txt: '배터리 주의' };
  if (tC >= 35) return { lv: 'mid', txt: '과열 주의' };
  return null;
}
const currentDrone = () => DRONES.find(d => d.id === LS.get('drone', 'std')) || DRONES[0];
const kstNowHM = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16);
// 일출·일몰(한국시간 HH:MM)을 휴대폰에서 직접 계산 — 날씨를 못 받아와도 야간 판정은 하도록
function sunTimesKST(lat, lon) {
  const rad = Math.PI / 180, k = new Date(Date.now() + 9 * 3600e3);
  const noon = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 3); // 한국 정오
  const n = Math.round(noon / 864e5 + 2440587.5 - 2451545.0 + 0.0008);
  const J = n - lon / 360, M = (357.5291 + 0.98560028 * J) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lam = (M + C + 180 + 102.9372) % 360;
  const Jt = 2451545.0 + J + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lam * rad);
  const dec = Math.asin(Math.sin(lam * rad) * Math.sin(23.4397 * rad));
  const w0 = Math.acos((Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec))) / rad;
  const hm = j => new Date((j - 2440587.5) * 864e5 + 9 * 3600e3).toISOString().slice(11, 16);
  return { sunrise: hm(Jt - w0 / 360), sunset: hm(Jt + w0 / 360) };
}
function windDir(deg) { return ['북', '북동', '동', '남동', '남', '남서', '서', '북서'][Math.round(((deg % 360) / 45)) % 8] + '풍'; }
function weatherIssues(w) {
  const c = w.current, d = w.daily, L = currentDrone().wind;
  const sunrise = d.sunrise[0].slice(11, 16), sunset = d.sunset[0].slice(11, 16), nowHM = kstNowHM();
  return {
    sunrise, sunset, nowHM,
    night: nowHM < sunrise || nowHM >= sunset,
    // 강풍: 돌풍이 기체 한계 이상 또는 평균 풍속이 한계의 75% 이상 / 다소 강함: 돌풍 65%·풍속 50% 이상
    windStrong: c.wind_gusts_10m >= L || c.wind_speed_10m >= L * 0.75,
    windMid: !(c.wind_gusts_10m >= L || c.wind_speed_10m >= L * 0.75) && (c.wind_gusts_10m >= L * 0.65 || c.wind_speed_10m >= L * 0.5),
    limit: L,
    rain: c.precipitation > 0 || (w.hourly && w.hourly.precipitation && (w.hourly.precipitation[0] || 0) >= 0.3) || [51, 53, 55, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99].includes(c.weather_code),
    fog: c.weather_code === 45 || c.weather_code === 48,
    temp: tempIssue(c.temperature_2m),
    // 앞으로 3시간: 비 올 확률(최대)·예상 강수량(합)
    rainProb: w.hourly && w.hourly.precipitation_probability ? Math.max(...w.hourly.precipitation_probability.map(v => v || 0)) : null,
    rainMm: w.hourly && w.hourly.precipitation ? Math.round(w.hourly.precipitation.reduce((a, v) => a + (v || 0), 0) * 10) / 10 : 0
  };
}
/* 주간 날씨 (7일) — 날마다 고른 기체 기준으로 비행 적합도 표시
   부적합: 최대 돌풍 ≥ 기체 한계 · 최대 풍속 ≥ 한계의 75% · 비 확률 60% 이상 · 최저기온 < 기체 작동 온도
   주의: 돌풍 ≥ 한계의 65% · 풍속 ≥ 한계의 50% · 비 확률 30% 이상 */
const WX_ICO = c => c === 0 ? '☀️' : c <= 2 ? '🌤' : c === 3 ? '☁️' : c <= 48 ? '🌫' : c <= 57 ? '🌦' : c <= 67 ? '🌧' : c <= 77 ? '🌨' : c <= 82 ? '🌧' : c <= 86 ? '🌨' : '⛈';
function weekHtml(w) {
  const d = w.daily; if (!d || !d.time || d.time.length < 2 || !d.temperature_2m_max) return '';
  const dr = currentDrone(), L = dr.wind, DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const rows = d.time.map((t, i) => {
    const dt = new Date(t + 'T12:00:00+09:00'), dow = DOW[dt.getUTCDay()];
    const name = i === 0 ? '오늘' : i === 1 ? '내일' : dow;
    const g = d.wind_gusts_10m_max[i], ws = d.wind_speed_10m_max[i], rp = d.precipitation_probability_max ? d.precipitation_probability_max[i] : null;
    const tmx = d.temperature_2m_max[i], tmn = d.temperature_2m_min[i], code = d.weather_code[i];
    const cold = dr.tmin != null && tmn < dr.tmin;
    const bad = g >= L || ws >= L * 0.75 || rp >= 60 || cold || code >= 95;
    const mid = !bad && (g >= L * 0.65 || ws >= L * 0.5 || rp >= 30 || tmn < 10);
    const why = bad ? (g >= L || ws >= L * 0.75 ? '강풍' : cold ? '저온' : code >= 95 ? '뇌우' : '비') : mid ? (g >= L * 0.65 || ws >= L * 0.5 ? '바람' : rp >= 30 ? '비' : '추위') : '좋음';
    return `<tr class="${dow === '일' ? 'sun' : dow === '토' ? 'sat' : ''}">
      <td class="wk-day"><b>${name}</b><small>${dt.getUTCMonth() + 1}/${dt.getUTCDate()}</small></td>
      <td class="wk-ico" title="${esc(WX[code] || '')}">${WX_ICO(code)}</td>
      <td class="wk-t"><span class="lo">${Math.round(tmn)}°</span> / <span class="hi">${Math.round(tmx)}°</span></td>
      <td class="wk-rain">${rp != null ? '💧' + rp + '%' : '-'}</td>
      <td class="wk-wind ${g >= L ? 'q-bad' : g >= L * 0.65 ? 'q-mid' : ''}">${g.toFixed(1)}</td>
      <td><span class="wk-fly ${bad ? 'bad' : mid ? 'mid' : 'ok'}">${bad ? '✕' : mid ? '△' : '○'} ${why}</span></td></tr>`;
  }).join('');
  return `<div class="section-title">주간 날씨 · 비행 적합도 <small>(${esc(dr.id === 'std' ? '250g급' : dr.name)} 기준)</small></div>
    <table class="week"><thead><tr><th>날짜</th><th></th><th>최저/최고</th><th>비</th><th>돌풍<br>m/s</th><th>비행</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">○ 좋음 · △ 주의 · ✕ 부적합 — 하루 중 가장 센 바람·가장 높은 비 확률 기준이라, 시간대에 따라 날릴 수 있는 때가 있을 수 있어요.</p>`;
}
function weatherHtml(w) {
  const c = w.current;
  const { sunrise, sunset, nowHM, night } = weatherIssues(w);
  const notes = [];
  const iss = weatherIssues(w);
  const dr = currentDrone(), who = dr.id === 'std' ? '250g급 기체' : dr.name;
  if (iss.windStrong) notes.push(`💨 강풍 — ${who}의 내풍 한계(${dr.wind}m/s) 기준으로 지금 바람이 너무 강합니다.`);
  else if (iss.windMid) notes.push(`💨 바람이 다소 강합니다(${who} 한계 ${dr.wind}m/s). 높이 올라갈수록 더 세질 수 있어요.`);
  if (iss.rain) notes.push('🌧 강수가 있습니다. 방수 기체가 아니면 비행을 피하세요.');
  else if (iss.rainProb >= 40 || iss.rainMm >= 0.3) notes.push(`🌦 3시간 안에 비 올 확률 ${iss.rainProb != null ? iss.rainProb + '%' : '있음'}${iss.rainMm ? ` (예상 ${iss.rainMm}mm)` : ''} — 비행 전 하늘을 꼭 확인하세요.`);
  if (iss.fog) notes.push('🌫 안개로 가시권 확보가 어렵습니다.');
  if (iss.temp && iss.temp.lv === 'bad') notes.push(`🥶 기온 ${Math.round(c.temperature_2m)}℃ — ${who}의 ${iss.temp.why} 비행하면 안 돼요.`);
  else if (iss.temp && iss.temp.txt === '배터리 주의') notes.push(`🔋 기온 ${Math.round(c.temperature_2m)}℃ — 추우면 배터리 전압이 급격히 떨어져요. 이륙 전 배터리를 따뜻하게(20℃ 이상) 두고, 평소보다 일찍 복귀하세요.`);
  else if (iss.temp) notes.push(`🌡 기온 ${Math.round(c.temperature_2m)}℃ — 기체·배터리 과열에 주의하세요.`);
  if (w.kp) {
    const k = w.kp.now, m = w.kp.max6;
    if (k >= 5) notes.push(`🧲 지자기 폭풍(Kp ${k}) — GPS·나침반이 불안정할 수 있어요. 수동(ATTI) 조종에 자신 없으면 비행을 미루세요.`);
    else if (k >= 4) notes.push(`🧲 지자기가 약간 불안정합니다(Kp ${k}). GPS 위성 수와 홈포인트를 꼭 확인하세요.`);
    else if (m != null && m >= 5) notes.push(`🧲 몇 시간 안에 지자기 폭풍이 예보돼 있어요(최대 Kp ${m}). 긴 비행은 피하세요.`);
  }
  if (night) notes.push(`🌙 지금은 야간(일몰 ${sunset} 이후~일출 ${sunrise} 전)이라 특별비행승인 없이는 비행할 수 없습니다.`);
  if (!notes.length) notes.push('👍 비행하기 괜찮은 날씨입니다.');
  return `<div class="section-title">현재 날씨 (${nowHM} 기준)</div>
    <div class="wx">
      <div><b>${c.wind_speed_10m.toFixed(1)}</b><span>풍속 m/s · ${windDir(c.wind_direction_10m)}</span></div>
      <div><b>${c.wind_gusts_10m.toFixed(1)}</b><span>돌풍 m/s</span></div>
      <div><b>${Math.round(c.temperature_2m)}°</b><span>${WX[c.weather_code] || '날씨'}</span></div>
      <div><b>${sunrise}~${sunset}</b><span>일출~일몰</span></div>
      ${w.kp ? `<div class="${kpLevel(w.kp.now).cls}"><b>Kp ${w.kp.now}</b><span>지자기 ${kpLevel(w.kp.now).txt}</span></div>` : '<div><b>-</b><span>지자기 Kp</span></div>'}
      <div><b>${iss.rainProb != null ? iss.rainProb + '%' : c.precipitation}</b><span>${iss.rainProb != null ? '비 올 확률 (3시간)' : '강수 mm'}</span></div>
    </div>
    <div class="wx-note">${notes.join('<br>')}</div>
    ${weekHtml(w)}
    <p class="muted small">※ 날씨는 예보 모델 값이라 실제와 다를 수 있어요. 비가 오거나 바람이 세면 화면과 상관없이 비행하지 마세요.</p>
    <label class="drone-pick">내 기체
      <select id="dronePick">${DRONES.map(d => `<option value="${d.id}"${d.id === dr.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    </label>
    <p class="muted small">바람 기준: 돌풍 ${dr.wind}m/s 또는 평균 ${(dr.wind * 0.75).toFixed(1)}m/s 이상이면 강풍${dr.note ? ` (${dr.note})` : ''}${dr.g ? ` · ${dr.g >= 1000 ? (dr.g / 1000).toFixed(2) + 'kg' : dr.g + 'g'}` : ''}${dr.ft ? ` · 최대 비행 ${dr.ft}분` : ''}${dr.tmin != null ? ` · 작동 ${dr.tmin}~40℃` : ''}</p>
    ${dr.g ? `<p class="muted small">${droneRules(dr)}</p>` : ''}`;
}

/* ───────── 지도 ───────── */
const map = L.map('map', { zoomControl: false, attributionControl: false }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
const zoomCtl = L.control.zoom({ position: 'topright' }); // 오른쪽 레이어 버튼 아래
let baseLayers = {}, overlayLayers = {}, layerCtl;

function buildLayers() {
  if (layerCtl) { map.removeControl(layerCtl); }
  quietToggle = true;
  Object.values(baseLayers).concat(Object.values(overlayLayers)).forEach(l => map.removeLayer(l));
  quietToggle = false;
  baseLayers = {}; overlayLayers = {};
  const key = vkey();
  if (key) {
    const vw = (name, ext) => L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/${name}/{z}/{y}/{x}.${ext}`, { maxZoom: 20, maxNativeZoom: 19, minZoom: 6, attribution: '© V-World' });
    baseLayers['기본지도'] = vw('Base', 'png');
    const sat = vw('Satellite', 'jpeg'), hyb = vw('Hybrid', 'png');
    baseLayers['위성지도'] = L.layerGroup([sat, hyb]);
  } else {
    baseLayers['OpenStreetMap'] = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
  }
  const firstBase = Object.values(baseLayers)[0]; firstBase.addTo(map);
  layerCtl = L.control.layers(baseLayers, {}, { position: 'topright', collapsed: true }).addTo(map);
  map.removeControl(zoomCtl); zoomCtl.addTo(map); // 레이어 버튼을 다시 만들어도 확대·축소가 늘 그 아래에 오도록
  setTimeout(fitMapButtons, 0);
  if (key) for (const z of ZONES) if (!z.optional || verified.has(z.id)) addZoneOverlay(z);
}
// 지도 무늬 칸(타일)을 못 받아오면 잠시 뒤 최대 3번 다시 요청 → 빈 네모 칸 방지
function retryTiles(layer, max = 3) {
  layer.on('tileerror', e => {
    const img = e.tile;
    if (!img || !img.src || img.src.startsWith('data:')) return;
    const n = (img._retry || 0) + 1;
    if (n > max) return;
    img._retry = n;
    setTimeout(() => {
      if (!img.isConnected || !img.src || img.src.startsWith('data:')) return; // 이미 화면에서 빠진 칸
      const base = img.src.replace(/[?&]_r=\d+$/, '');
      img.src = base + (base.includes('?') ? '&' : '?') + '_r=' + n;
    }, 500 * n + Math.random() * 400);
  });
}
function addZoneOverlay(z) {
  const key = vkey(); if (!key || !layerCtl) return;
  const label = `${swatch(z)} ${z.name}`;
  if (overlayLayers[label]) return;
  const wms = L.tileLayer.wms('https://api.vworld.kr/req/wms', Object.assign({
    layers: z.id.toLowerCase(), styles: z.id.toLowerCase(), format: 'image/png', transparent: true,
    version: '1.3.0', key, opacity: z.level === 0 ? 0.45 : 0.55, maxZoom: 20,
    tileSize: 512,            // 큰 칸으로 받아 요청 수를 1/4로 줄임
    updateWhenZooming: false, // 확대·축소 중간 단계는 받지 않음
    keepBuffer: 1
  }, VW_DOMS[vwDom] ? { domain: VW_DOMS[vwDom] } : {}));
  retryTiles(wms);
  overlayLayers[label] = wms;
  overlayZone.set(wms, z);
  layerCtl.addOverlay(wms, label);
  const saved = LS.get('layerOn', {});
  const on = z.id in saved ? saved[z.id] : !z.off; // 사용자가 정한 값 우선, 없으면 기본값(범위가 넓은 구역은 꺼짐)
  if (on) { quietToggle = true; wms.addTo(map); quietToggle = false; }
  else hiddenZones.add(z.id);
}
// 오른쪽 위 구역 목록에서 켜고 끄면: 선택을 기억하고, 판정 때 그린 강조선도 같이 숨기거나 보이게
const overlayZone = new Map(), hiddenZones = new Set();
let quietToggle = false;
function onOverlayToggle(e, on) {
  const z = overlayZone.get(e.layer); if (!z) return;
  if (on) hiddenZones.delete(z.id); else hiddenZones.add(z.id);
  if (quietToggle) return;
  const saved = LS.get('layerOn', {}); saved[z.id] = on; LS.set('layerOn', saved);
  if (lastResult) drawZones(lastResult);
}
map.on('overlayadd', e => onOverlayToggle(e, true));
map.on('overlayremove', e => onOverlayToggle(e, false));
buildLayers();

let pinMarker = null, meMarker = null, meCircle = null, zoneGeo = L.layerGroup().addTo(map);
let lastResult = null;

map.on('click', e => { pauseTrackFollow(); checkAt(e.latlng.lat, e.latlng.lng); });
map.on('moveend', () => { const c = map.getCenter(); LS.set('mapView', { lat: c.lat, lng: c.lng, z: map.getZoom() }); });

/* ───────── 화면 배율 (글자·버튼·창 크기) ─────────
   지도 그림은 그대로 선명하게 두고, 그 위의 버튼·글자·결과창·창들만 키우거나 줄임 (CSS zoom).
   CSS zoom이 표준대로 동작하는 브라우저(크롬·삼성인터넷·앱 화면엔진 128 이상, 파이어폭스 126 이상)에서만 켬 */
const UIZ_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
const UIZ_OK = (() => { const ua = navigator.userAgent, c = ua.match(/Chrom(?:e|ium)\/(\d+)/), f = ua.match(/Firefox\/(\d+)/);
  return !!(c ? +c[1] >= 128 : f ? +f[1] >= 126 : false) && CSS.supports('zoom', '1.2'); })();
let UI_Z = 1;
function applyUiZoom(z, quiet) {
  UI_Z = UIZ_OK ? z : 1;
  document.documentElement.style.setProperty('--ui', UI_Z);
  LS.set('uiZoom', UI_Z);
  const v = $('#uizVal'); if (v) v.textContent = Math.round(UI_Z * 100) + '%';
  $('#uizMinus').disabled = UI_Z <= UIZ_STEPS[0]; $('#uizPlus').disabled = UI_Z >= UIZ_STEPS[UIZ_STEPS.length - 1];
  if (typeof zFitCache !== 'undefined') zFitCache = null;
  requestAnimationFrame(() => { try { map.invalidateSize(false); } catch (e) {} if (typeof setSheetHeight === 'function') setSheetHeight(); });
  if (!quiet) toast(`화면 배율 ${Math.round(UI_Z * 100)}%`, 900);
}
{
  const box = $('#uiZoom'); let t = null;
  const open = () => { box.classList.add('open'); clearTimeout(t); t = setTimeout(() => box.classList.remove('open'), 4000); }; // 4초 동안 안 만지면 접힘
  const step = d => { const i = UIZ_STEPS.findIndex(x => Math.abs(x - UI_Z) < 0.01); const j = Math.max(0, Math.min(UIZ_STEPS.length - 1, (i < 0 ? 2 : i) + d)); applyUiZoom(UIZ_STEPS[j]); open(); };
  $('#uizPlus').addEventListener('click', e => { e.stopPropagation(); step(1); });
  $('#uizMinus').addEventListener('click', e => { e.stopPropagation(); step(-1); });
  $('#uizVal').addEventListener('click', e => { e.stopPropagation(); if (box.classList.contains('open')) applyUiZoom(1); open(); });
  ['pointerdown', 'touchstart', 'dblclick', 'wheel'].forEach(ev => box.addEventListener(ev, e => e.stopPropagation(), { passive: true })); // 지도까지 눌리지 않게
  if (UIZ_OK) box.classList.remove('hidden');
  const z0 = +LS.get('uiZoom', 1);
  UI_Z = UIZ_OK && UIZ_STEPS.some(x => Math.abs(x - z0) < 0.01) ? z0 : 1;
  document.documentElement.style.setProperty('--ui', UI_Z);
  $('#uizVal').textContent = Math.round(UI_Z * 100) + '%';
  $('#uizMinus').disabled = UI_Z <= UIZ_STEPS[0]; $('#uizPlus').disabled = UI_Z >= UIZ_STEPS[UIZ_STEPS.length - 1];
}

/* ───────── 하단 시트 ───────── */
const sheet = $('#sheet');
// 결과 창 높이가 바뀌면(접기·펼치기·내용 변경) 보이는 지도 영역의 가운데가 그대로 유지되도록 지도를 같이 움직임
let lastSheetH = 0;
// 화면 배율(--ui)을 쓰면 offsetHeight는 배율 전 값이라, 실제로 보이는 크기(getBoundingClientRect)로 계산
const sheetVisH = () => Math.round(sheet.getBoundingClientRect().height || 0);
function visTop() { const m = $('#map').getBoundingClientRect(), f = $('#searchForm').getBoundingClientRect(); return f.height ? f.bottom - m.top : 56 * UI_Z; }
function setSheetHeight() {
  const h = sheetVisH();
  if (!h) return; // 다른 탭을 보는 중
  document.documentElement.style.setProperty('--sheet-h', h + 'px');
  if (lastSheetH && h !== lastSheetH) map.panBy([0, Math.round((h - lastSheetH) / 2)], { animate: true, duration: 0.25 });
  lastSheetH = h;
  fitMapButtons();
}
// 오른쪽 버튼 줄: 위(레이어·확대축소)와 아래(Kp·내 위치)가 겹칠 만큼 지도가 좁으면 확대·축소 버튼을 숨김
function fitMapButtons() {
  const zc = document.querySelector('.leaflet-control-zoom'), col = $('.fab-col');
  if (!zc || !col || !col.offsetParent) return;
  zc.classList.remove('squeezed');
  const zb = zc.getBoundingClientRect();
  const colTop = col.offsetParent.getBoundingClientRect().bottom - sheetVisH() - 10 * UI_Z - col.getBoundingClientRect().height; // 움직이는 중에도 최종 위치로 계산
  if (zb.height && zb.bottom + 8 > colTop) zc.classList.add('squeezed');
}
window.addEventListener('resize', fitMapButtons);
// 검색창 아래 ~ 결과 창 위, 실제로 보이는 지도 영역의 가운데에 지점이 오도록 이동
function setViewVisible(latlng, zoom) {
  const H = map.getSize().y;
  const top = visTop();
  const bottom = H - sheetVisH();
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
// 조용한 다시 확인: 그 사이 사용자가 다른 지점을 확인 중이면 하지 않음
let lastRecheck = 0;
function recheckLast() {
  const r = lastResult;
  if (!r || r.seq !== checkSeq || Date.now() - lastRecheck < 3000) return;
  lastRecheck = Date.now();
  checkAt(r.lat, r.lon, r.label || undefined, { retried: true, silent: true, acc: r.acc });
}
async function checkAt(lat, lon, label, opt = {}) {
  const seq = ++checkSeq;
  if (label !== '내 위치') $('#btnLocate').classList.remove('found');
  if (!vkey()) {
    sheetHtml(`<div class="verdict v-gray"><div class="ico">🔑</div><div><b>인증키가 필요합니다</b><small>config.js에 V-World 인증키를 넣어주세요.</small></div></div>`);
    return;
  }
  if (pinMarker) pinMarker.setLatLng([lat, lon]);
  else {
    pinMarker = L.marker([lat, lon], { bubblingMouseEvents: false }).addTo(map);
    pinMarker.on('click', e => { if (e && e.originalEvent && L.DomEvent) L.DomEvent.stopPropagation(e); if (sheet.classList.contains('collapsed')) setCollapsed(false); });
  }
  if (!opt.silent) pinLabel(null); // 조용한 재확인(실시간 추적 등)은 말풍선을 깜빡이지 않음
  if (!opt.silent) {
    zoneGeo.clearLayers();
    sheetHtml(`<div class="hint"><span class="spinner"></span>공역 정보를 확인하는 중…</div>`);
  }

  const prev = lastResult;
  const near = (m) => prev && prev.addr && Math.hypot(...toLocal(lon, lat, prev.lat, prev.lon)) < m;
  const [res, addr] = await Promise.all([
    analyze(lat, lon, { cache: opt.cache }),
    opt.cache && near(150) ? Promise.resolve(prev.addr) : reverseGeocode(lat, lon) // 150m 안이면 주소도 그대로
  ]);
  if (seq !== checkSeq) return;
  res.addr = addr; res.label = label || ''; res.acc = opt.acc; res.seq = seq;
  if (label === '내 위치') setMyAddress(addr);
  LS.set('lastPoint', { lat, lon, label: label || '' });
  lastResult = res;
  renderResult(res);
  drawZones(res);
  pinLabel(res);
  const incomplete = res.verdict.code === 'partial' || res.verdict.code === 'error';
  if (incomplete && !opt.retried) {
    // 브이월드가 잠깐 응답하지 않은 경우가 많아서 몇 초 뒤 한 번 자동으로 다시 확인
    const note = $('#recheckNote'); if (note) note.textContent = '잠시 후 자동으로 한 번 더 확인해요…';
    setTimeout(() => { if (seq === checkSeq) checkAt(lat, lon, label, { retried: true, silent: true, acc: opt.acc }); }, 4000);
  }
  if (!incomplete) nationalRefresh();
  if (notamData) { updateNotamButton(); autoOpenNotams(); }

  res.baseVerdict = res.verdict;
  const wxReuse = opt.cache && prev && prev.wx && prev.wxAt && Date.now() - prev.wxAt < 10 * 60e3 && near(5000);
  (wxReuse ? Promise.resolve(prev.wx) : fetchWeather(lat, lon)).then(w => {
    if (seq !== checkSeq) return;
    res.wx = w; res.wxAt = wxReuse ? prev.wxAt : Date.now(); // 날씨는 10분 안·5km 안이면 재사용
    showWeather(res);
  }).catch(() => {
    if (seq !== checkSeq) return;
    const st = sunTimesKST(lat, lon), nowHM = kstNowHM();
    const box = $('#wxBox');
    if (box) box.innerHTML = `<div class="section-title">현재 날씨</div><p class="muted small">날씨 정보를 불러오지 못했습니다. 바람·비는 직접 확인하세요. (오늘 일출 ${st.sunrise} · 일몰 ${st.sunset}, 휴대폰에서 계산)</p>`;
    applyWeatherToVerdict(res, { sunrise: st.sunrise, sunset: st.sunset, nowHM, night: nowHM < st.sunrise || nowHM >= st.sunset });
  });
}

// 날씨는 상단 [현재날씨] 버튼의 창에 표시 (결과창을 짧게). 같은 지점을 다시 확인할 땐 깜빡이지 않게 그대로 둠
let wxFor = null;
function wxPrepare(r, where) {
  $('#wxWhere').textContent = '📍 ' + where;
  const same = wxFor && Math.hypot(...toLocal(r.lon, r.lat, wxFor.lat, wxFor.lon)) < 150;
  if (!same) $('#wxBox').innerHTML = `<div class="hint"><span class="spinner"></span>날씨 확인 중…</div>`;
  wxFor = { lat: r.lat, lon: r.lon };
}
function openWx() {
  if (!lastResult) { $('#wxWhere').textContent = ''; $('#wxBox').innerHTML = '<p class="muted small">지도를 누르거나 내 위치(⌖)를 확인하면 그 지점의 날씨가 나와요.</p>'; }
  $('#wxModal').classList.remove('hidden'); $('#wxModal .modal-box').scrollTop = 0;
}
const closeWx = () => $('#wxModal').classList.add('hidden');
$('#btnWx').addEventListener('click', openWx);
$('#btnWxClose').addEventListener('click', closeWx);
$('#btnWxX').addEventListener('click', closeWx);
$('#wxModal').addEventListener('click', e => { if (e.target.id === 'wxModal') closeWx(); });
/* ───────── 물때(밀물·썰물) ─────────
   Open-Meteo 해양 예보의 '조석이 포함된 해수면 높이'(약 8km 격자, 1시간 간격)로 만조·간조 시각을 계산.
   공식 조석표(국립해양조사원)가 아니라 모델 예측이라 항구·만·섬 사이에선 실제와 차이가 날 수 있음 → 화면에 안내 */
const tideCache = new Map();
async function fetchTide(lat, lon) {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2), c = tideCache.get(key);
  if (c && Date.now() - c.t < 3 * 3600e3) return c.d;
  const r = await fetchT('https://marine-api.open-meteo.com/v1/marine?' + new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), hourly: 'sea_level_height_msl',
    timezone: 'Asia/Seoul', past_days: '1', forecast_days: '4', cell_selection: 'sea' }), {}, 12000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const T = (j.hourly && j.hourly.time) || [], V = (j.hourly && j.hourly.sea_level_height_msl) || [];
  const pts = T.map((t, i) => ({ t: Date.parse(t + ':00+09:00'), v: V[i] })).filter(x => isFinite(x.t) && x.v != null && isFinite(x.v));
  const d = { pts, ext: tideExtremes(pts), glat: j.latitude, glon: j.longitude };
  tideCache.set(key, { t: Date.now(), d });
  return d;
}
// 1시간 값에서 만조·간조를 찾고, 앞뒤 3점으로 포물선을 맞춰 분 단위 시각·높이를 추정
function tideExtremes(pts) {
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1].v, b = pts[i].v, c = pts[i + 1].v;
    const hi = b > a && b >= c, lo = b < a && b <= c;
    if (!hi && !lo) continue;
    const den = a - 2 * b + c, dx = den ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0;
    const e = { hi, t: pts[i].t + dx * 3600e3, v: b - (a - c) * dx / 4 };
    const last = out[out.length - 1];
    if (last && last.hi === e.hi) { if (e.hi ? e.v > last.v : e.v < last.v) out[out.length - 1] = e; continue; } // 같은 종류가 연달아 나오면 더 극단인 것만
    if (last && Math.abs(e.v - last.v) < 0.04) { out.pop(); continue; } // 아주 작은 출렁임은 무시
    out.push(e);
  }
  return out;
}
function tideAt(pts, t) {
  for (let i = 1; i < pts.length; i++) if (pts[i].t >= t) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t); }
  return null;
}
// 달 나이로 사리(조차 큼)·조금(조차 작음) 무렵 판단 (조석은 달보다 1~2일 늦게 따라옴)
function tidePhase(t) {
  const age = (((t - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % 29.530589 + 29.530589) % 29.530589;
  const dist = x => Math.min(...[x, x + 14.765, x + 29.53].map(c => Math.abs(age - c)));
  if (dist(1.5) <= 2.5) return { txt: '사리 무렵 · 물 높이 차이가 커요', cls: 'q-bad' };
  if (dist(8.9) <= 2.5) return { txt: '조금 무렵 · 물 높이 차이가 작아요', cls: 'q-good' };
  return { txt: '사리와 조금 사이', cls: '' };
}
const hm = t => { const d = new Date(t + 9 * 3600e3); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const kstDay = t => Math.floor((t + 9 * 3600e3) / 864e5);
const tideH = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}m`;
function tideSvg(d, now) {
  const t0 = now - 6 * 3600e3, t1 = now + 24 * 3600e3, P = d.pts.filter(p => p.t >= t0 - 3600e3 && p.t <= t1 + 3600e3);
  if (P.length < 4) return '';
  const W = 320, H = 110, pad = 14, vs = P.map(p => p.v), mn = Math.min(...vs), mx = Math.max(...vs), rg = (mx - mn) || 1;
  const X = t => ((t - t0) / (t1 - t0)) * W, Y = v => pad + (1 - (v - mn) / rg) * (H - 2 * pad - 12);
  const line = P.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const area = line + `L${X(P[P.length - 1].t).toFixed(1)},${H - 12}L${X(P[0].t).toFixed(1)},${H - 12}Z`;
  let marks = '';
  for (const e of d.ext) if (e.t > t0 && e.t < t1) {
    const x = X(e.t), y = Y(e.v);
    marks += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" class="${e.hi ? 'th' : 'tl'}"/><text x="${x.toFixed(1)}" y="${(e.hi ? y - 5 : y + 11).toFixed(1)}" text-anchor="middle">${hm(e.t)}</text>`;
  }
  // 자정 구분선
  let mid = '';
  for (let k = kstDay(t0) + 1; k <= kstDay(t1); k++) { const t = k * 864e5 - 9 * 3600e3, x = X(t); mid += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="0" y2="${H - 12}" class="tmid"/><text x="${(x + 3).toFixed(1)}" y="${H - 2}" class="tday">${k === kstDay(now) + 1 ? '내일' : '모레'}</text>`; }
  const nx = X(now), nv = tideAt(d.pts, now);
  return `<svg class="tide-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" class="tarea"/><path d="${line}" class="tline"/>${mid}
    <line x1="${nx.toFixed(1)}" x2="${nx.toFixed(1)}" y1="0" y2="${H - 12}" class="tnow"/>${nv != null ? `<circle cx="${nx.toFixed(1)}" cy="${Y(nv).toFixed(1)}" r="4" class="tnowdot"/>` : ''}
    <text x="${(nx + 3).toFixed(1)}" y="${H - 2}" class="tday now">지금</text>${marks}</svg>`;
}
function tideHtml(d, lat, lon) {
  const now = Date.now();
  if (!d.pts.length) return '<p class="muted small">이 지점은 바다에서 멀어 물때 정보가 없어요. 해안 가까운 곳을 눌러 확인해 보세요.</p>';
  const far = isFinite(d.glat) ? distM([lat, lon], [d.glat, d.glon]) : 0;
  const next = d.ext.find(e => e.t > now), cur = tideAt(d.pts, now), ph = tidePhase(now);
  const left = next ? next.t - now : 0, lh = Math.floor(left / 3600e3), lm = Math.round((left % 3600e3) / 60e3);
  let h = `<div class="tide-now ${next ? (next.hi ? 'rising' : 'falling') : ''}">
    <b>${next ? (next.hi ? '▲ 지금 밀물(들물) 중' : '▼ 지금 썰물(날물) 중') : '물때 계산 중'}</b>
    ${next ? `<span>${next.hi ? '만조' : '간조'} <b>${hm(next.t)}</b> · ${lh ? lh + '시간 ' : ''}${lm}분 뒤</span>` : ''}
    <small>지금 해수면 ${cur != null ? tideH(cur) : '-'} (평균해수면 기준) · <b class="${ph.cls}">${ph.txt}</b></small></div>`;
  h += tideSvg(d, now);
  const days = [kstDay(now), kstDay(now) + 1, kstDay(now) + 2, kstDay(now) + 3], names = ['오늘', '내일', '모레', '글피'];
  h += '<table class="tide-tbl"><tbody>' + days.map((k, i) => {
    const es = d.ext.filter(e => kstDay(e.t) === k);
    if (!es.length) return '';
    const dd = new Date(k * 864e5), lab = `${names[i]} <small>${dd.getUTCMonth() + 1}/${dd.getUTCDate()}</small>`;
    const hs = es.filter(e => e.hi), ls = es.filter(e => !e.hi);
    const rng = hs.length && ls.length ? Math.max(...hs.map(e => e.v)) - Math.min(...ls.map(e => e.v)) : null;
    return `<tr><th>${lab}${rng != null ? `<small class="trng">차이 ${rng.toFixed(1)}m</small>` : ''}</th><td>${es.map(e =>
      `<span class="tx ${e.hi ? 'hi' : 'lo'}${e.t < now ? ' past' : ''}">${e.hi ? '▲만조' : '▼간조'} <b>${hm(e.t)}</b> <small>${tideH(e.v)}</small></span>`).join('')}</td></tr>`;
  }).join('') + '</tbody></table>';
  h += `<p class="muted small tide-note">⚠️ 해양 예보 모델(약 8km 격자)로 계산한 참고값이에요${far > 3000 ? ` · 가장 가까운 바다 격자가 약 ${(far / 1000).toFixed(0)}km 떨어져 있어요` : ''}.
    항구·만·섬 사이에선 실제와 30분 이상 다를 수 있으니, 갯벌·해안에서 이착륙할 땐
    <a href="https://www.khoa.go.kr/swtc/mobile.do" target="_blank" rel="noopener">국립해양조사원 조석 예보</a>로 꼭 확인하세요.
    물이 들어오는 속도가 빠른 서해안 갯벌은 특히 주의하세요.</p>`;
  return h;
}
let tideSeq = 0;
async function openTide() {
  const [lat, lon] = refPoint();
  $('#tideWhere').textContent = '📍 ' + (lastResult ? (lastResult.label === '내 위치' ? '내 위치' : (lastResult.addr && (lastResult.addr.road || lastResult.addr.parcel)) || lastResult.label || '확인한 지점') : meMarker ? '내 위치' : '지도 가운데') + ` (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
  $('#tideBox').innerHTML = '<div class="hint"><span class="spinner"></span>물때 확인 중…</div>';
  $('#tideModal').classList.remove('hidden'); $('#tideModal .modal-box').scrollTop = 0;
  const my = ++tideSeq;
  try { const d = await fetchTide(lat, lon); if (my === tideSeq) $('#tideBox').innerHTML = tideHtml(d, lat, lon); }
  catch (e) { if (my === tideSeq) $('#tideBox').innerHTML = '<p class="muted small">물때 정보를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.</p>'; }
}
const closeTide = () => $('#tideModal').classList.add('hidden');
$('#btnTide').addEventListener('click', openTide);
$('#btnTideClose').addEventListener('click', closeTide);
$('#btnTideX').addEventListener('click', closeTide);
$('#tideModal').addEventListener('click', e => { if (e.target.id === 'tideModal') closeTide(); });

function showWeather(r) {
  const box = $('#wxBox'); if (!box || !r.wx) return;
  box.innerHTML = weatherHtml(r.wx);
  r.verdict = r.baseVerdict || r.verdict;
  applyWeatherToVerdict(r, weatherIssues(r.wx));
  $('#dronePick').addEventListener('change', e => { LS.set('drone', e.target.value); showWeather(r); });
}
// 공역 판정 + 현재 조건(야간·바람·비·안개)을 합쳐 맨 위 판정을 갱신
function applyWeatherToVerdict(r, iss) {
  const el0 = $('#sheetBody .verdict'), v0 = r.verdict;
  if (r === lastResult) pinLabel(r);
  if (el0) { el0.className = 'verdict ' + v0.cls; el0.innerHTML = `<div class="ico">${v0.ico}</div><div><b>${esc(v0.title)}</b><small>${esc(v0.desc)}</small></div>`; }
  const probs = [];
  if (iss.night) probs.push(`야간(일몰 ${iss.sunset}~일출 ${iss.sunrise})`);
  if (iss.windStrong) probs.push(`강풍(${currentDrone().id === 'std' ? '250g급' : currentDrone().name} 기준)`);
  if (iss.rain) probs.push('비·눈');
  if (iss.fog) probs.push('안개');
  if (iss.temp && iss.temp.lv === 'bad') probs.push('기온(' + iss.temp.txt + ')');
  if (r === lastResult) { const b = $('#btnWx'); b.classList.toggle('warn', probs.length > 0); b.title = probs.length ? '지금: ' + probs.join(', ') : '현재 날씨'; }
  if (!probs.length) return;
  const v = r.verdict, el = $('#sheetBody .verdict');
  if (!el) return;
  if (v.code === 'ok' || v.code === 'caution') {
    const what = probs.join(', ');
    const reason = iss.night ? '야간 비행은 특별비행승인 없이 할 수 없습니다.' : '지금은 안전한 비행이 어렵습니다.';
    r.verdict = Object.assign({}, v, {
      cls: 'v-yellow', ico: iss.night ? '🌙' : '🌬️',
      title: `공역은 ${v.code === 'ok' ? '비행 가능' : '주의'} · 지금은 ${iss.night ? '야간' : '비행 부적합'}`,
      desc: `${what} — ${reason} ${iss.night ? `일출(${iss.sunrise}) 이후 비행하세요.` : '날씨가 좋아진 뒤 비행하세요.'}${v.code === 'caution' ? ' 공역: ' + v.desc : v.nearNote ? ' 참고로 ' + v.nearNote : ''}`,
      code: v.code, now: 'bad'
    });
  } else {
    r.verdict = Object.assign({}, v, { desc: v.desc + ` 또한 지금은 ${probs.join(', ')}입니다.` });
  }
  const nv = r.verdict;
  pinLabel(r);
  el.className = 'verdict ' + nv.cls;
  el.innerHTML = `<div class="ico">${nv.ico}</div><div><b>${esc(nv.title)}</b><small>${esc(nv.desc)}</small></div>`;
}

/* 지도 핀 위 말풍선: 이 지점의 구역과 판정을 한눈에 */
const PIN_SHORT = { no: '비행 불가 · 승인 필요', approval: '비행승인 필요', caution: '주의 · 확인 후 비행', ok: '비행 가능', partial: '다시 확인 필요', error: '판정할 수 없음' };
function pinLabel(r) {
  if (!pinMarker || !pinMarker.bindTooltip) return;
  let ico = '⏳', cls = 'v-gray', t1 = '확인 중…', t2 = '';
  if (r) {
    const v = r.verdict, top = r.inside.filter(x => x.zone.level > 0).sort((a, b) => b.zone.level - a.zone.level)[0];
    const ua = r.inside.find(x => x.zone.id === 'LT_C_AISUAC');
    t1 = top ? top.zone.name.replace(/\(항공고시보\)$/, ' (항공고시보)') : (v.code === 'partial' || v.code === 'error') ? '공역 확인 불완전' : ua ? '초경량비행장치 공역' : '비행금지·제한 구역 아님';
    t2 = PIN_SHORT[v.code] || v.title;
    if (v.now === 'bad') t2 += v.ico === '🌙' ? ' · 지금은 야간' : ' · 지금은 날씨 나쁨';
    const near = r.nearby.find(x => x.dist > 0 && x.dist < 1000 && x.zone.level >= 2);
    if (v.code === 'ok' && near) t2 += ` · ${fmtDist(near.dist)} 옆 ${near.zone.name}`;
    ico = { 'v-red': '⛔', 'v-orange': '⚠️', 'v-yellow': v.now === 'bad' ? v.ico : '🟡', 'v-green': '✅', 'v-gray': '❔' }[v.cls] || v.ico;
    cls = v.cls;
  }
  const html = `<div class="pin-tip-in pt-${cls.slice(2)}"><span class="pt-ico">${ico}</span><span><b>${esc(t1)}</b>${t2 ? `<small>${esc(t2)}</small>` : ''}</span></div>`;
  if (pinMarker.getTooltip && pinMarker.getTooltip()) pinMarker.setTooltipContent(html);
  else {
    pinMarker.bindTooltip(html, { permanent: true, direction: 'top', offset: [-16, -16], className: 'pin-tip', interactive: true });
    const tt = pinMarker.getTooltip && pinMarker.getTooltip();
    if (tt && tt.on) tt.on('click', () => { if (sheet.classList.contains('collapsed')) setCollapsed(false); });
  }
}

function zoneRow(x, showDist) {
  return `<div class="zone">${swatch(x.zone)}
    <div class="z-main"><div class="z-name">${esc(x.zone.name)}</div>
      <div class="z-sub">${esc(x.label || x.zone.note)}</div>${propsTable(x.feature.properties)}</div>
    ${showDist ? `<div class="z-dist">${x.dist === 0 ? '이 지점' : fmtDist(x.dist)}</div>` : ''}</div>`;
}

/* ───────── 담당 연락처 (드론원스톱 '처리부서안내' 기준 · contacts.json) ─────────
   판정은 브이월드 공역 그대로, 이 카드는 '누구에게 문의하나'만 알려줌.
   구역: 브이월드 구역 번호(P61A·R75 등)나 이름(관제권)으로 연결 / 지역: 지번 주소(시도·시군구·읍면동·리)로 연결 */
let CONTACTS = null, ctOpenPref = null;
const APP_V = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch (e) { return ''; } })();
fetch('contacts.json' + (APP_V ? '?v=' + APP_V : '')).then(r => r.ok ? r.json() : null).then(j => {
  if (!j || !Array.isArray(j.zones)) return;
  CONTACTS = j;
  if (lastResult) fillContacts(lastResult);
  renderMiscContacts();
}).catch(() => {});
const SIDO_KEYS = [['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종'],
  ['경기', '경기'], ['강원', '강원'], [/충청북|충북/, '충북'], [/충청남|충남/, '충남'], [/전라북|전북/, '전북'], [/전라남|전남/, '전남'], [/경상북|경북/, '경북'], [/경상남|경남/, '경남'], ['제주', '제주']];
const ADDR_ALIAS = { '문무대왕면': '양북면', '세종대왕면': '능서면', '양촌읍': '양촌면', '퇴계원읍': '퇴계원면' }; // 이름이 바뀐 곳(표는 옛 이름)
function addrInfo(addr) {
  const t = addr && (addr.parcel || addr.road);
  if (!t) return null;
  const toks = String(t).trim().split(/\s+/), first = toks[0] || '';
  const sd = new Set(SIDO_KEYS.filter(([k]) => typeof k === 'string' ? first.includes(k) : k.test(first)).map(x => x[1])); // 통합 시·도(예: 전남광주)는 둘 다
  const set = new Set(toks.slice(1));
  toks.slice(1).forEach(x => { if (ADDR_ALIAS[x]) set.add(ADDR_ALIAS[x]); });
  return sd.size ? { sd, set } : null;
}
// '시도 시군구 읍면동 리' 형식(여러 개는 |). 맞으면 구체적인 정도(1~4), 아니면 0
function specMatch(spec, a) {
  const p = spec.split(' ');
  if (!a.sd.has(p[0])) return 0;
  for (let i = 1; i < p.length; i++) if (!p[i].split('|').some(x => a.set.has(x))) return 0;
  return p.length;
}
function bestByAddr(list, a) {
  if (!a) return { hits: [], partial: false };
  const ok = e => !(e.except || []).some(sp => specMatch(sp, a));
  let best = 0, hits = [];
  for (const e of list) {
    if (!ok(e)) continue;
    const sc = Math.max(0, ...(e.where || []).map(sp => specMatch(sp, a)));
    if (!sc) continue;
    if (sc > best) { best = sc; hits = [e]; } else if (sc === best) hits.push(e);
  }
  if (hits.length) return { hits, partial: false };
  // 리·읍면까지 딱 맞는 줄이 없으면, 가장 깊게(시군구 → 읍면동) 맞는 후보들을 보여줌
  const depth = sp => { const p = sp.split(' '); if (!a.sd.has(p[0])) return 0; let d = 1; while (d < p.length && p[d].split('|').some(x => a.set.has(x))) d++; return d; };
  let top = 1, cand = [];
  for (const e of list) {
    if (!ok(e)) continue;
    const d = Math.max(0, ...(e.where || []).map(depth));
    if (d < 2) continue;
    if (d > top) { top = d; cand = [e]; } else if (d === top) cand.push(e);
  }
  return { hits: cand, partial: cand.length > 0 };
}
const propText = props => Object.values(props || {}).filter(v => typeof v === 'string').join(' ').toUpperCase();
function zoneCodes(props) {
  const out = new Set();
  for (const m of propText(props).matchAll(/(?:^|[^A-Z0-9]|RK)([PRA])\s?-?\s?(\d{1,3}[A-Z]{0,2})(?![A-Z0-9])/g)) out.add(m[1] + m[2]);
  return out;
}
const codeHit = (k, codes) => [...codes].some(c => c === k || (c.startsWith(k) && /^[A-Z]+$/.test(c.slice(k.length)))); // P518 → P518W 도 인정, R7 ≠ R75
function zoneContacts(item, a) {
  const kid = item.zone.id.replace('LT_C_AIS', '');
  const cand = CONTACTS.zones.filter(e => String(e.kind).split('|').includes(kid));
  if (!cand.length) return [];
  const props = item.feature && item.feature.properties, codes = zoneCodes(props), up = propText(props);
  let hits = cand.filter(e => e.any || (e.codes && e.codes.some(k => codeHit(k, codes))));
  if (!hits.length) hits = cand.filter(e => e.names && e.names.some(n => /^[A-Z]+$/.test(n) && new RegExp('(^|[^A-Z])' + n + '([^A-Z]|$)').test(up))); // 영문·공항코드 우선
  if (!hits.length) hits = cand.filter(e => e.names && e.names.some(n => /[가-힣]/.test(n) && up.includes(n)));
  if (hits.length > 1 && hits.every(e => e.where)) { const r = bestByAddr(hits, a); if (r.hits.length && !r.partial) hits = r.hits; } // 같은 번호를 지역으로 나눈 경우(P518·P61A)
  return hits;
}
function telHtml(t) {
  const m = String(t).match(/0\d{1,3}-\d{3,4}-\d{4}/);
  if (!m) return esc(t);
  return `<span class="tn">${esc(t.slice(0, m.index))}<a class="tel" href="tel:${m[0].replace(/-/g, '')}">${esc(m[0])}</a>${esc(t.slice(m.index + m[0].length))}</span>`;
}
function ctItem(e, org) {
  const cs = e.contacts || [{ org, tel: e.tel }];
  return `<div class="ct-item"><div class="ct-area">${esc(e.area)}</div>
    ${cs.map(c => `<div class="ct-org">${c.org ? `<span>${esc(c.org)}</span>` : ''}${(c.tel || []).length ? `<span class="ct-tels">${c.tel.map(telHtml).join('<i>·</i>')}</span>` : ''}${c.fax ? `<small>팩스 ${esc(c.fax)}</small>` : ''}</div>`).join('')}
    ${e.note ? `<div class="ct-note">※ ${esc(e.note)}</div>` : ''}${e.link ? `<a class="ct-link" href="${esc(e.link)}" target="_blank" rel="noopener">드론원스톱 공지사항 보기 ↗</a>` : ''}</div>`;
}
function ctGroup(icon, title, desc, items, tail) {
  return `<div class="ct-group"><div class="ct-title">${icon} ${title}${desc ? `<small>${desc}</small>` : ''}</div>${items}${tail || ''}</div>`;
}
function fillContacts(r) {
  const box = $('#contactBox');
  if (!box || !CONTACTS || !r) return;
  const a = addrInfo(r.addr);
  let h = '', autoOpen = false;
  // ① 이 지점이 속한 구역의 비행승인 담당
  const zoneItems = [], seen = new Set();
  for (const x of r.inside) {
    if (x.zone.id === 'NOTAM' || x.zone.level < 1) continue;
    if (x.zone.level >= 2) autoOpen = true;
    const hits = zoneContacts(x, a);
    if (!hits.length) { zoneItems.push(`<div class="ct-item"><div class="ct-area">${esc(x.zone.name)}${x.label ? ' · ' + esc(x.label) : ''}</div><div class="ct-note">연락처 표에서 찾지 못했어요 — 아래 지역 관할 기관에 문의하세요.</div></div>`); continue; }
    for (const e of hits) if (!seen.has(e)) { seen.add(e); zoneItems.push(ctItem(e)); }
  }
  if (zoneItems.length) h += ctGroup('🛑', '구역 비행승인', '이 지점이 속한 공역의 담당', zoneItems.join(''), zoneItems.length > 1 ? '<div class="ct-note">여러 곳이 나오면 해당 구역마다 승인이 필요할 수 있어요.</div>' : '');
  if (!a) h += `<p class="muted small">주소를 찾지 못해 지역별 연락처는 표시할 수 없어요 (바다 위 등).</p>`;
  else {
    // ② 지역 관할(특별비행·150m 초과 등)  ③ 항공촬영(군)
    const f = bestByAddr(CONTACTS.flight, a), ph = bestByAddr(CONTACTS.photo, a);
    const tail = x => x.partial ? '<div class="ct-note">⚠️ 읍·면까지 딱 맞는 줄이 없어 같은 시·군의 후보를 모두 보여줘요. 전화로 확인하세요.</div>'
      : x.hits.length > 1 ? '<div class="ct-note">⚠️ 여러 곳이 해당될 수 있어요 — 전화로 확인하세요.</div>' : '';
    const fh = f.hits.length ? f : { hits: CONTACTS.flight.filter(e => e.where.some(sp => a.sd.has(sp.split(' ')[0]))), partial: true };
    if (fh.hits.length) h += ctGroup('✈️', '특별비행·지역 비행승인', '야간·가시권 밖, 150m 초과, 25kg 초과 등', fh.hits.map(e => ctItem(e)).join(''), tail(fh));
    if (ph.hits.length) h += ctGroup('📷', '항공촬영 허가 (군)', '촬영 목적 비행 시 — 국가·군사 보안시설 확인', ph.hits.map(e => ctItem(e, '항공촬영 민원처리 책임부대')).join(''), tail(ph));
  }
  if (!h) { box.innerHTML = ''; return; }
  const open = ctOpenPref != null ? ctOpenPref : autoOpen;
  box.innerHTML = `<details class="contacts"${open ? ' open' : ''}><summary>📞 담당 연락처 <small>비행승인·특별비행·항공촬영</small></summary>${h}
    <p class="ct-foot">기준 ${esc(CONTACTS.updated)} · 드론원스톱 '처리부서안내' · 번호가 바뀌었을 수 있으니 신청 전 <a href="https://drone.onestop.go.kr" target="_blank" rel="noopener">드론원스톱</a>에서 최종 확인하세요.</p></details>`;
  box.querySelector('details').addEventListener('toggle', e => { ctOpenPref = e.target.open; });
}
// 안내 탭: 장치신고·사업등록
function renderMiscContacts() {
  const el = $('#miscContacts');
  if (!el || !CONTACTS || !CONTACTS.misc) return;
  el.innerHTML = CONTACTS.misc.map(e => `<div class="ct-org"><span>${esc(e.area)} · ${esc(e.org)}</span><span class="ct-tels">${e.tel.map(telHtml).join('<i>·</i>')}</span>${e.note ? `<small>${esc(e.note)}</small>` : ''}</div>`).join('');
}

// 좌표 표기: 도분초 (N 35°07'34.1")
function dmsOf(v) { const t = Math.round(Math.abs(v) * 36000) / 10, d = Math.floor(t / 3600), m = Math.floor((t - d * 3600) / 60), sec = (t - d * 3600 - m * 60).toFixed(1); return `${d}°${String(m).padStart(2, '0')}'${sec.padStart(4, '0')}"`; }
const coordDec = r => `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`;
const coordDms = r => `${r.lat >= 0 ? 'N' : 'S'} ${dmsOf(r.lat)} ${r.lon >= 0 ? 'E' : 'W'} ${dmsOf(r.lon)}`;
// 클립보드 복사 (앱·옛 브라우저는 예전 방식으로 한 번 더)
async function copyToClip(text, msg) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
  if (!ok) try {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
  } catch (e) {}
  if (ok) toast(msg || '복사했어요'); else prompt('아래 내용을 복사하세요', text);
}
function renderResult(r) {
  const v = r.verdict;
  const addrLine = r.label || (r.addr && (r.addr.road || r.addr.parcel)) || '선택한 지점';
  const isMe = r.label === '내 위치';
  const sub = !isMe && r.addr && r.addr.road && r.addr.parcel ? r.addr.parcel : '';
  let h = `<div class="verdict ${v.cls}"><div class="ico">${v.ico}</div><div><b>${v.title}</b><small>${esc(v.desc)}</small></div></div>
    ${v.code === 'partial' || v.code === 'error' ? `<div class="recheck"><button class="btn sm primary" id="btnRecheck">⟳ 다시 확인</button><span class="muted small" id="recheckNote"></span></div>` : ''}
    <p class="addr"><b>${esc(addrLine)}</b>${sub ? `<br><span class="muted">${esc(sub)}</span>` : ''}</p>
    <div class="coords">
      <button type="button" class="coord" data-copy="${coordDec(r)}" title="눌러서 복사"><span>위경도</span>${coordDec(r)}<i>⧉</i></button>
      <button type="button" class="coord" data-copy="${esc(coordDms(r))}" title="눌러서 복사"><span>도분초</span>${esc(coordDms(r))}<i>⧉</i></button>
    </div>
    <div class="row-btns">
      <button class="btn sm" id="btnFav">☆ 장소 저장</button>
      <button class="btn sm" id="btnLogHere">📒 기록 추가</button>
      <button class="btn sm" id="btnFlyStart">⏱ 비행 시작</button>
      <button class="btn sm" id="btnCopy">📋 좌표·주소 복사</button>
      <a class="btn sm" href="https://drone.onestop.go.kr" target="_blank" rel="noopener">드론원스톱</a>
    </div>`;
  if (isMe && r.acc > 300) h += `<p class="acc-warn">📍 위치 오차가 약 ${fmtDist(r.acc)}예요. 휴대폰 설정에서 <b>정확한 위치</b>(GPS)를 켜면 판정이 정확해져요. 경계 근처라면 지도에서 직접 지점을 눌러 확인하세요.</p>`;
  if (r.inside.length) h += `<div class="section-title">이 지점이 속한 공역</div>` + r.inside.map(x => zoneRow(x, false)).join('');
  const near = r.nearby.slice(0, 6);
  if (near.length) h += `<div class="section-title">반경 ${fmtDist(CFG.CHECK_RADIUS_M)} 내 주의 공역</div>` + near.map(x => zoneRow(x, true)).join('');
  // 판정에 영향 없는 공역(군작전구역·초경량비행장치 공역)은 조회에 실패해도 표시하지 않음
  const failShow = r.failed.filter(f => f.zone.level >= 1);
  if (failShow.length && r.verdict.code !== 'error') h += `<p class="muted small">일부 데이터 조회 실패: ${failShow.map(f => esc(f.zone.name) + (f.error ? ` (${esc(f.error)})` : '')).join(', ')}</p>`;
  if (r.fromNational && r.fromNational.length) {
    const d = t => { const k = new Date(t); return `${k.getMonth() + 1}/${k.getDate()}`; };
    h += `<p class="muted small">ℹ️ ${r.fromNational.map(x => esc(x.zone.name)).join('·')}은 저장된 전국 자료(${d(Math.min(...r.fromNational.map(x => x.t)))})로 확인했어요.</p>`;
  }
  h += `<div id="contactBox"></div>`;
  wxPrepare(r, addrLine);
  h += `<p class="muted small" style="margin-top:12px">※ 참고용입니다. 항공고시보(임시 구역)는 드론 관련만 30분 간격으로 반영돼 늦을 수 있으니 비행 전 드론 원스톱에서 최종 확인하세요.</p>`;
  sheetHtml(h);
  $('#btnFav').onclick = () => addFavorite(r);
  $('#btnLogHere').onclick = () => openLogForm({ fromResult: r });
  $('#btnFlyStart').onclick = () => startTimer();
  $('#btnCopy').onclick = () => copyPoint(r);
  fillContacts(r);
  const rb = $('#btnRecheck'); if (rb) rb.onclick = () => checkAt(r.lat, r.lon, r.label || undefined, { retried: true });
}

// 비행승인·촬영허가 신청서에 붙여넣기 좋게 정리
async function copyPoint(r) {
  const zones = [...new Set(r.inside.map(x => x.zone.name + (x.label ? ` (${x.label})` : '')))].join(', ') || '해당 없음';
  const text = [
    `주소: ${(r.addr && (r.addr.road || r.addr.parcel)) || r.label || '-'}`,
    r.addr && r.addr.road && r.addr.parcel ? `지번: ${r.addr.parcel}` : '',
    `좌표: ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}`,
    `좌표(도분초): ${coordDms(r)}`,
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
    if (hiddenZones.has(x.zone.id)) continue; // 목록에서 끈 구역은 강조선도 숨김
    const inside = x.dist === 0;
    L.geoJSON(x.feature, { style: { color: x.zone.color, weight: inside ? 3 : 2, opacity: 0.95, fillOpacity: inside ? 0.06 : 0, dashArray: inside ? null : '6 4' }, interactive: false }).addTo(zoneGeo);
  }
}

/* ───────── 위치 받기: 웹 위치 기능 → 안 되면 앱이 기기 GPS에서 직접 (옛 기종·차량용 기기 대비) ───────── */
const NATIVE_GEO = !!(window.NFZApp && window.NFZApp.locStart);
let geoNative = NATIVE_GEO && (() => { try { return localStorage.getItem('geoNative') === '1'; } catch (e) { return false; } })();
const nativeSubs = new Map(); let nativeSeq = 0;
function appLocPerm() { try { return window.NFZApp && window.NFZApp.locPerm ? JSON.parse(window.NFZApp.locPerm()) : null; } catch (e) { return null; } }
function rememberNative() { geoNative = true; try { localStorage.setItem('geoNative', '1'); } catch (e) {} }
window.nfzNativeLoc = o => {
  const p = { coords: { latitude: o.lat, longitude: o.lon, accuracy: o.acc != null ? o.acc : 50, altitude: o.alt, altitudeAccuracy: null, speed: o.spd, heading: o.hdg }, timestamp: o.t || Date.now() };
  [...nativeSubs.values()].forEach(s => s.ok(p, o));
};
window.nfzNativeErr = (code, why) => { [...nativeSubs.values()].forEach(s => s.fail({ code, why, native: true })); };
function nativeSub(ok, fail) {
  const id = ++nativeSeq; nativeSubs.set(id, { ok, fail });
  try { window.NFZApp.locStart(); } catch (e) {}
  return id;
}
function nativeUnsub(id) { nativeSubs.delete(id); if (!nativeSubs.size) try { window.NFZApp.locStop(); } catch (e) {} }
// 웹 위치가 이렇게 실패하면 앱 직접 위치로 넘어감 (권한 거부는 앱 권한이 실제로 있을 때만 — 다시 묻지 않게)
function webGeoBroken(err) { if (!NATIVE_GEO) return false; if (err.code !== 1) return true; const lp = appLocPerm(); return !!(lp && (lp.fine || lp.coarse)); }
function geoGet(ok, fail, opt) {
  const viaNative = (remember) => {
    let done = false, stale = null, tm = null;
    const end = () => { done = true; clearTimeout(tm); nativeUnsub(id); };
    const id = nativeSub((p, o) => {
      if (done) return;
      if (o.age > 60000) { if (!stale) stale = p; return; } // 오래된 위치는 새 위치를 기다리는 동안 보관만
      end(); if (remember) rememberNative(); ok(p);
    }, e => { if (done || (e.code === 2 && stale)) return; end(); fail(e); });
    tm = setTimeout(() => { if (done) return; end(); stale ? ok(stale) : fail({ code: 3, native: true }); }, 25000);
  };
  if (geoNative || !navigator.geolocation) return NATIVE_GEO ? viaNative() : fail({ code: 2 });
  navigator.geolocation.getCurrentPosition(ok, err => {
    if (!webGeoBroken(err)) return fail(err);
    viaNative(err.code !== 3); // 앱 쪽이 실제로 잡히면 다음부터 바로 앱으로 (시간 초과는 신호 탓일 수 있어 기억 안 함)
  }, opt);
}
function geoWatch(ok, fail, opt) {
  const h = { web: null, nat: null };
  const goNative = (remember) => {
    if (h.nat) return;
    if (h.web != null) { navigator.geolocation.clearWatch(h.web); h.web = null; }
    let last = null, lastGps = 0;
    h.nat = nativeSub((p, o) => {
      if (o.age > 30000) return;
      // 같은 위치가 겹쳐 오거나, GPS가 잡히는 중에 덜 정확한 통신망 위치가 끼어들면 무시 (계기판 깜빡임 방지)
      if (last && Math.abs(p.timestamp - last.timestamp) < 400 && p.coords.latitude === last.coords.latitude && p.coords.longitude === last.coords.longitude) return;
      if (o.prov === 'gps') lastGps = Date.now(); else if (Date.now() - lastGps < 10000) return;
      last = p;
      if (remember) { rememberNative(); remember = false; }
      ok(p);
    }, fail);
  };
  if (geoNative || !navigator.geolocation) { if (NATIVE_GEO) goNative(); else setTimeout(() => fail({ code: 2 })); return h; }
  let got = false;
  h.web = navigator.geolocation.watchPosition(p => { got = true; ok(p); }, err => {
    if (!got && webGeoBroken(err)) goNative(err.code !== 3);
    else fail(err);
  }, opt);
  return h;
}
function geoClear(h) { if (!h) return; if (h.web != null) navigator.geolocation.clearWatch(h.web); if (h.nat) nativeUnsub(h.nat); h.web = h.nat = null; }
// 실패 이유를 알기 쉽게
function geoErrText(err) {
  const lp = appLocPerm();
  if (err.code === 1) return lp ? '위치 권한이 꺼져 있어요. 휴대폰 설정 → 애플리케이션 → 하코 NFZ → 권한에서 위치를 허용해 주세요.' : '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.';
  if (err.why === 'nogps' || (lp && lp.hasGps === false && !lp.net)) return '이 기기는 GPS가 없어 위치를 알 수 없어요. 지도를 눌러 지점을 직접 골라 주세요.';
  if (err.why === 'off' || (lp && !lp.gps && !lp.net)) return '기기의 위치(GPS)가 꺼져 있어요. 설정에서 위치를 켠 뒤 다시 눌러 주세요.';
  if (err.code === 3) return '위치를 찾는 데 너무 오래 걸려요. 하늘이 트인 곳에서 다시 시도해 주세요.';
  return '위치를 가져오지 못했습니다. 기기의 위치(GPS)가 켜져 있는지 확인해 주세요.';
}

/* ───────── 현재 위치 ───────── */
// 내 위치 점·오차 원은 공역 경계와 다른 층에 그림 — 점이 움직일 때마다 복잡한 경계선까지 다시 그리지 않게(화면 하얗게 깜빡임 방지)
let meRenderer = null;
function showMe(lat, lon, accuracy) {
  if (meMarker) { meMarker.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]); if (meCircle.getRadius() !== accuracy) meCircle.setRadius(accuracy); }
  else {
    if (!meRenderer) { map.createPane('mePane').style.zIndex = 590; meRenderer = L.svg({ pane: 'mePane', padding: 0.1 }); }
    meCircle = L.circle([lat, lon], { radius: accuracy, stroke: false, fillColor: '#1e88e5', fillOpacity: 0.16, interactive: false, renderer: meRenderer }).addTo(map); // GPS 정확도 반경
    meMarker = L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#1e88e5', fillOpacity: 1, renderer: meRenderer }).addTo(map);
  }
}
// opt.quiet: 알림 없이 / opt.fallback: 실패하면 이 지점을 판정 / opt.keepView: 지도 위치 유지
function locateMe(opt = {}) {
  if (!navigator.geolocation && !NATIVE_GEO) { if (opt.fallback) checkAt(opt.fallback.lat, opt.fallback.lon, opt.fallback.label); else toast('이 기기는 위치 기능을 지원하지 않습니다.'); return; }
  if (!opt.quiet) toast('현재 위치를 찾는 중…');
  const fab = $('#btnLocate'); fab.classList.add('locating');
  geoGet(p => {
    fab.classList.remove('locating'); fab.classList.add('found');
    const { latitude: lat, longitude: lon, accuracy } = p.coords;
    showMe(lat, lon, accuracy);
    const z = opt.keepView ? map.getZoom() : Math.max(map.getZoom(), 14);
    setViewVisible([lat, lon], z);
    // 결과 창이 다 그려진 뒤, 내 위치를 보이는 지도 영역의 정중앙에 한 번 더 맞춤
    Promise.resolve(checkAt(lat, lon, '내 위치', { acc: accuracy })).then(() => setTimeout(() => {
      if (!$('#tab-map').classList.contains('active')) return;
      if (!lastResult || lastResult.lat !== lat || lastResult.lon !== lon) return; // 그 사이 다른 지점을 눌렀으면 옮기지 않음
      lastSheetH = sheetVisH() || lastSheetH;
      setViewVisible([lat, lon], map.getZoom());
    }, 80));
  }, err => {
    fab.classList.remove('locating', 'found');
    if (opt.fallback) { checkAt(opt.fallback.lat, opt.fallback.lon, opt.fallback.label === '내 위치' ? '마지막으로 확인한 내 위치' : opt.fallback.label); return; }
    toast(geoErrText(err), 4500);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}
// 나침반·드론 컴퍼스 보정 안내
function openCompassHelp() { $('#compassModal').classList.remove('hidden'); $('#compassModal .modal-box').scrollTop = 0; }
$('#btnCompassHelp').addEventListener('click', openCompassHelp);
// 실시간 추적 정보창을 눌러도 뒤의 지도가 반응하지 않게 막음(보정 버튼은 그대로 동작)
['click','dblclick','mousedown','pointerdown','touchstart','wheel','contextmenu'].forEach(t => $('#navHud').addEventListener(t, e => e.stopPropagation(), { passive: true }));
$('#btnCompassHelp2').addEventListener('click', openCompassHelp);
$('#btnCompassClose').addEventListener('click', () => $('#compassModal').classList.add('hidden'));
$('#compassModal').addEventListener('click', e => { if (e.target.id === 'compassModal') $('#compassModal').classList.add('hidden'); });
$('#btnLocate').addEventListener('click', () => { if (trackId != null) { appZoomUntil = Date.now() + 1500; manualZoomAt = 0; if (!trackFollow) { trackFollow = true; trackLast = null; trackUI(); } } locateMe(); });

/* ───────── 실시간 위치 추적 (켜고 끌 수 있음) ─────────
   켜면: 내 위치 점이 움직임을 따라가고 지도도 따라감. 20m 움직일 때마다 받아 둔 공역 자료로 휴대폰에서 바로 다시 판정
   (서버에는 받아 둔 범위 3km를 벗어나거나 10분이 지났을 때만 다시 요청, 주소는 150m·날씨는 10분마다),
   더 엄격한 구역에 들어가면 진동+알림. 지도를 손으로 옮기면 따라가기만 잠시 멈춤(버튼을 누르면 다시 따라감). */
const TRACK_MOVE_M = 20, TRACK_MIN_MS = 3000; // 판정은 휴대폰에서 하므로 자주 해도 부담 없음
let trackId = null, trackFollow = true, trackLast = null, trackAt = 0, trackCode = null, wakeLock = null;
const VERDICT_RANK = { ok: 0, caution: 1, approval: 2, partial: 2, no: 3 };
function distM(a, b) { const p = toLocal(b[1], b[0], a[0], a[1]); return Math.hypot(p[0], p[1]); }
function trackUI() {
  const b = $('#btnTrack');
  b.classList.toggle('on', trackId != null && trackFollow);
  b.classList.toggle('paused', trackId != null && !trackFollow);
  b.setAttribute('aria-pressed', trackId != null ? 'true' : 'false');
  b.setAttribute('aria-label', trackId == null ? '실시간 위치 추적 켜기' : trackFollow ? '실시간 위치 추적 끄기' : '다시 따라가기');
}
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}
/* 계기판: 방향(이동 중엔 GPS 진행 방향, 멈춰 있으면 휴대폰 나침반)·속도·고도(기압계 또는 GPS, 해발)·GPS 정확도 */
const DIR16 = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
let gpsHeading = null, compassHeading = null, prevFix = null, headingMarker = null, compassOn = false;
function currentHeading() { return gpsHeading != null ? gpsHeading : compassHeading; }
let rotShown = null;
function smoothRot(h) { // 가장 가까운 쪽으로 돌도록 누적 각도 사용
  if (rotShown == null) return (rotShown = h);
  let d = ((h - rotShown) % 360 + 540) % 360 - 180;
  return (rotShown += d);
}
function renderHeading() {
  const h0 = currentHeading();
  const h = h0 == null ? null : h0;
  const rot = h == null ? 0 : smoothRot(h);
  $('#hudDir').textContent = h == null ? '방향 -' : `${DIR16[Math.round(h / 22.5) % 16]} ${Math.round(h)}°`;
  $('#hudArrow').style.transform = `rotate(${rot}deg)`;
  if (!meMarker) return;
  if (h == null) { if (headingMarker) { map.removeLayer(headingMarker); headingMarker = null; } return; }
  const html = `<svg viewBox="0 0 40 40" style="transform:rotate(${rot}deg)"><path d="M20 1.5 25.5 8.5H14.5z" fill="#1a73e8" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  if (!headingMarker) headingMarker = L.marker(meMarker.getLatLng(), { icon: L.divIcon({ className: 'me-heading', html, iconSize: [40, 40], iconAnchor: [20, 20] }), interactive: false, keyboard: false }).addTo(map);
  else { headingMarker.setLatLng(meMarker.getLatLng()); const svg = headingMarker.getElement() && headingMarker.getElement().querySelector('svg'); if (svg) svg.style.transform = `rotate(${rot}deg)`; }
}
function updateHud(c, t) {
  let spd = c.speed;
  if ((spd == null || isNaN(spd)) && prevFix && c.accuracy < 30) { // 속도를 안 주는 기기: 두 위치 사이 거리÷시간
    const dt = (t - prevFix.t) / 1000;
    if (dt >= 2) { spd = distM([prevFix.lat, prevFix.lon], [c.latitude, c.longitude]) / dt; if (spd > 60) spd = null; } // 너무 짧은 간격·튀는 값은 버림
    else spd = undefined; // 아직 계산 안 함 → 이전 표시 유지
  }
  if (spd === undefined) { renderHeading(); setAcc(c.accuracy); return; }
  prevFix = { lat: c.latitude, lon: c.longitude, t };
  if (spd != null && !isNaN(spd)) { kmhHist.push(spd * 3.6); if (kmhHist.length > 3) kmhHist.shift(); trackKmh = kmhHist.reduce((a, b) => a + b, 0) / kmhHist.length; } // 튀는 값 완화
  gpsHeading = spd != null && spd > 1 && c.heading != null && !isNaN(c.heading) ? c.heading : null; // 걷는 속도 이상일 때만 진행 방향 사용
  $('#hudSpd').textContent = spd == null || isNaN(spd) ? '-' : `${(spd * 3.6).toFixed(1)} km/h`;
  setSpdQuality();
  gpsAlt = c.altitude == null || isNaN(c.altitude) ? null : c.altitude;
  lastPos = [c.latitude, c.longitude];
  renderAlt();
  setAcc(c.accuracy);
  renderHeading();
}
/* 고도: 기압계가 있는 폰(안드로이드 앱)은 기압계 + 그 지역 해면기압(Open-Meteo)으로 계산 — GPS보다 훨씬 덜 흔들림.
   없으면 GPS 고도. GPS 고도는 타원체 기준이라 우리나라에선 해발보다 20~30m 높게 나오므로, 앱(안드로이드 14+)이 알려 주는 지오이드 높이만큼 뺌 */
let gpsAlt = null, lastPos = null, baroHpa = null, geoidN = null, pRef = null;
function setPRef(cur, lat, lon) {
  if (!(cur.pressure_msl > 900 && cur.pressure_msl < 1100)) return;
  pRef = { p0: cur.pressure_msl, tC: isFinite(cur.temperature_2m) ? cur.temperature_2m : 15, lat, lon, t: Date.now() };
}
function pRefOk(pos) { return pRef && Date.now() - pRef.t < 3 * 3600e3 && (!pos || distM(pos, [pRef.lat, pRef.lon]) < 30000); }
// 계기판용 날씨(해면기압·바람·기온): 결과창 날씨를 받을 때 같이 저장하고, 15분 넘었거나 5km 넘게 이동하면 따로 가볍게 받음(1분에 한 번까지)
let hudWx = null, hudWxBusy = false, hudWxTry = 0;
function setHudWx(cur, lat, lon) {
  if (!cur || !isFinite(cur.wind_speed_10m)) return;
  hudWx = { ws: cur.wind_speed_10m, wg: cur.wind_gusts_10m, wu: cur.wind_speed_120m, tC: cur.temperature_2m, lat, lon, t: Date.now() };
}
const hudWxOk = pos => hudWx && Date.now() - hudWx.t < 15 * 60e3 && (!pos || distM(pos, [hudWx.lat, hudWx.lon]) < 5000);
async function fetchHudWx(lat, lon) {
  if (hudWxBusy) return; hudWxBusy = true; hudWxTry = Date.now();
  try {
    const r = await fetchT('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({ latitude: lat.toFixed(3), longitude: lon.toFixed(3),
      current: 'pressure_msl,temperature_2m,wind_speed_10m,wind_gusts_10m,wind_speed_120m', wind_speed_unit: 'ms' }), {}, 10000);
    if (r.ok) { const j = await r.json(); if (j.current) { setPRef(j.current, lat, lon); setHudWx(j.current, lat, lon); renderAlt(); renderHudExtra(); } }
  } catch (e) {} finally { hudWxBusy = false; }
}
function hudWxNeed() {
  if (!lastPos || hudWxBusy || Date.now() - hudWxTry < 60e3) return;
  if (!hudWxOk(lastPos) || (baroHpa != null && !pRefOk(lastPos))) fetchHudWx(lastPos[0], lastPos[1]);
}
function baroAltitude(p) { // 측고 공식(현지 기온 반영)
  return (Math.pow(pRef.p0 / p, 1 / 5.257) - 1) * (pRef.tC + 273.15) / 0.0065;
}
function renderAlt() {
  $('#hudBaroRow').classList.toggle('hidden', baroHpa == null); // 기압계 값(hPa) — 기압계 있는 폰의 앱에서만
  if (baroHpa != null) $('#hudBaro').textContent = `${baroHpa.toFixed(1)} hPa`;
  let h = null, src = '';
  if (baroHpa != null) {
    if (pRefOk(lastPos)) { h = baroAltitude(baroHpa); src = '기압'; }
    else hudWxNeed();
  }
  if (h == null && gpsAlt != null) { h = gpsAlt - (geoidN || 0); src = 'GPS'; }
  if (h == null) { $('#hudAlt').textContent = '-'; $('#hudAltSrc').textContent = ''; return; }
  const txt = src === '기압' ? h.toFixed(1) : String(Math.round(h)); // 기압은 소수점 한 자리, GPS는 정수
  $('#hudAlt').textContent = `${/^-0(\.0)?$/.test(txt) ? txt.slice(1) : txt} m`; // '-0.0' 대신 '0.0'
  $('#hudAltSrc').textContent = src;
}
/* 계기판 추가 정보: 일몰(일출)까지 · 바람(지상/120m 상공) · 기온(배터리) · 가까운 제한구역 */
const fmtMin = m => m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
function sunLeft(lat, lon) { // 한국시간 기준, 휴대폰에서 계산
  const st = sunTimesKST(lat, lon), toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const now = toMin(kstNowHM()), rise = toMin(st.sunrise), set = toMin(st.sunset);
  if (now >= rise && now < set) return { night: false, min: set - now };
  return { night: true, min: (now < rise ? rise : rise + 1440) - now };
}
// 받아 둔 공역 모양으로 지금 위치에서 가장 가까운 '승인 필요 이상' 구역 계산 (서버 조회 없음)
function nearZone(lat, lon) {
  const c = zoneCache;
  if (!c || Date.now() - c.t > 60 * 60e3) return null;
  const reach = CFG.CHECK_RADIUS_M - distM([c.lat, c.lon], [lat, lon]); // 이 거리 안의 구역은 모두 받아 둔 상태
  if (reach < 500) return null;
  let inside = null, near = null;
  const see = (zone, g) => {
    if (!g || zone.level < 2) return;
    if (containsPoint(g, lon, lat)) { if (!inside || zone.level > inside.level) inside = zone; return; }
    const d = distToBoundary(g, lon, lat);
    if (d <= reach && (!near || d < near.d)) near = { zone, d };
  };
  c.settled.forEach((x, i) => { if (x.status === 'fulfilled') for (const f of x.value) see(ZONES[i], f.geometry); });
  for (const it of notamList()) if (it.geometry && notamStatus(it) === 'active') see(notamZone(it, 'active'), it.geometry);
  return { inside, near, reach };
}
const shortZone = z => z.name.replace(/\(.*\)$/, '');
function hudRow(id, html, cls) {
  const row = $('#' + id + 'Row'), el = $('#' + id);
  row.classList.toggle('hidden', html == null);
  if (html == null) return;
  el.innerHTML = html; el.className = cls || '';
}
function renderHudExtra() {
  if (!lastPos) return;
  const [lat, lon] = lastPos;
  // 일몰까지 (야간이면 일출까지)
  const s = sunLeft(lat, lon);
  $('#hudSunLbl').textContent = s.night ? '야간·일출까지' : '일몰까지';
  hudRow('hudSun', fmtMin(s.min), s.night ? 'q-bad' : s.min <= 10 ? 'q-bad' : s.min <= 30 ? 'q-mid' : 'q-good');
  // 바람·기온 (예보 모델 값) — 색은 고른 기체의 내풍 한계 기준(결과창 강풍 판정과 같음)
  hudWxNeed();
  const w = hudWxOk(lastPos) ? hudWx : null, L = currentDrone().wind;
  if (w) {
    const strong = w.wg >= L || w.ws >= L * 0.75, mid = w.wg >= L * 0.65 || w.ws >= L * 0.5;
    hudRow('hudWind', `${w.ws.toFixed(1)} m/s`, strong ? 'q-bad' : mid ? 'q-mid' : 'q-good');
    hudRow('hudWindUp', isFinite(w.wu) ? `${w.wu.toFixed(1)} m/s` : null, w.wu >= L * 0.75 ? 'q-bad' : w.wu >= L * 0.5 ? 'q-mid' : 'q-good');
    const t = Math.round(w.tC), ti = tempIssue(w.tC);
    hudRow('hudTemp', isFinite(w.tC) ? `${t}℃` + (ti ? ` <small>${ti.lv === 'bad' ? '작동 온도 밖' : ti.txt}</small>` : '') : null,
      ti ? (ti.lv === 'bad' ? 'q-bad' : 'q-mid') : '');
  } else ['hudWind', 'hudWindUp', 'hudTemp'].forEach(id => hudRow(id, null));
  // 가장 가까운 제한구역 (비행승인 필요 이상)
  const z = nearZone(lat, lon);
  if (!z) hudRow('hudZone', '확인 중', 'q-mid');
  else if (z.inside) hudRow('hudZone', `${esc(shortZone(z.inside))} 안`, 'q-bad');
  else if (z.near) hudRow('hudZone', `${esc(shortZone(z.near.zone))} ${fmtDist(z.near.d)}`, z.near.d < 1000 ? 'q-mid' : '');
  else hudRow('hudZone', `${fmtDist(z.reach)} 안에 없음`, 'q-good');
}
/* 속도 신뢰도(안드로이드 앱): 폰이 알려 주는 속도 오차로 색 표시 — ±2km/h 이하 초록 · ±5km/h 이하 주황 · 그 이상 빨강 */
let spdAccMs = null, spdAccAt = 0;
function setSpdQuality() {
  const el = $('#hudSpd'); if (!el) return;
  if (el.classList.contains('stale') || DR.on) return;
  const fresh = spdAccMs != null && Date.now() - spdAccAt < 5000;
  el.className = !fresh ? '' : spdAccMs * 3.6 <= 2 ? 'q-good' : spdAccMs * 3.6 <= 5 ? 'q-mid' : 'q-bad';
  el.title = fresh ? `속도 오차 ±${(spdAccMs * 3.6).toFixed(1)} km/h` : '';
}
/* GPS 끊김(터널·지하차도): 5초 넘게 새 위치가 없으면 알리고, 마지막 속도·축척·위치를 그대로 유지 */
let gpsWatch = null;
function gpsWatchdog(on) {
  clearInterval(gpsWatch); gpsWatch = null;
  $('#hudLostRow').classList.add('hidden'); $('#hudSpd').classList.remove('stale');
  if (!on) return;
  gpsWatch = setInterval(() => {
    if (!lastFixAt) return; // 첫 위치를 찾는 중
    const gap = Math.round((Date.now() - lastFixAt) / 1000), lost = gap >= 5;
    drWatch((Date.now() - lastFixAt) / 1000);
    $('#hudLostRow').classList.toggle('hidden', !lost);
    $('#hudSpd').classList.toggle('stale', lost && !DR.on);
    if (lost) $('#hudLost').textContent = gap < 60 ? `${gap}초` : `${Math.floor(gap / 60)}분 ${gap % 60}초`;
    else setSpdQuality();
  }, 1000);
}
// GPS 오차 색: 10m 이하 초록 · 30m 이하 주황 · 그 이상 빨강
function setAcc(a) {
  const el = $('#hudAcc');
  el.textContent = `±${Math.round(a)} m`;
  el.className = a <= 10 ? 'q-good' : a <= 30 ? 'q-mid' : 'q-bad';
}
// 위성 수(안드로이드 앱에서만): 위치 계산에 쓰는 위성 10개 이상 초록 · 6~9 주황 · 5 이하 빨강
let satTimer = null;
function satPoll(on) {
  const has = !!(window.NFZApp && window.NFZApp.gnss);
  $('#hudSatRow').classList.toggle('hidden', !has || !on);
  clearInterval(satTimer); satTimer = null;
  baroHpa = null; geoidN = null; $('#hudBaroRow').classList.add('hidden');
  if (!has) return;
  try { on ? window.NFZApp.gnssStart() : window.NFZApp.gnssStop(); } catch (e) {}
  if (!on) return;
  const tick = () => {
    let g = null; try { g = JSON.parse(window.NFZApp.gnss()); } catch (e) {}
    if (g && g.spdAcc != null && isFinite(g.spdAcc)) { spdAccMs = +g.spdAcc; spdAccAt = Date.now(); setSpdQuality(); }
    const nb = g && g.hpa > 300 ? +g.hpa : null, ng = g && g.geoid != null && isFinite(g.geoid) && Math.abs(g.geoid) < 120 ? +g.geoid : null;
    baroHpa = nb; geoidN = ng; renderAlt(); // 기압은 앱에서 약 2초 평균한 값
    const el = $('#hudSat');
    if (!g || g.used < 0) { el.textContent = '찾는 중'; el.className = 'q-mid'; return; }
    el.textContent = `${g.used}개` + (g.seen > 0 ? ` / ${g.seen}` : '');
    el.className = g.used >= 10 ? 'q-good' : g.used >= 6 ? 'q-mid' : 'q-bad';
  };
  tick(); satTimer = setInterval(tick, 1000);
}
// 휴대폰 나침반 (멈춰 있을 때 방향)
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // 아이폰
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;                 // 안드로이드 (자북 기준)
  if (h == null) return;
  const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0; // 화면을 가로로 돌렸을 때 보정
  compassHeading = (h + so + 360) % 360;
  if (gpsHeading == null) renderHeading();
}
async function compass(on) {
  const ev = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  if (on && !compassOn) {
    try { if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function' && (await DeviceOrientationEvent.requestPermission()) !== 'granted') return; } catch (e) { return; }
    window.addEventListener(ev, onOrient); compassOn = true;
  } else if (!on && compassOn) { window.removeEventListener(ev, onOrient); compassOn = false; compassHeading = null; }
}

// 창이 열리는 순간 진행 중인 지도·마커 움직임을 바로 멈추고, 창이 닫히면 현재 위치로 한 번 맞춤
{
  let wasOpen = false;
  const mo = new MutationObserver(() => {
    const open = anyModalOpen();
    if (open && !wasOpen) {
      if (meAnim) { cancelAnimationFrame(meAnim); meAnim = null; }
      try { map.stop(); } catch (e) {}
    } else if (!open && wasOpen && trackId != null && trackFollow && lastPos && $('#tab-map').classList.contains('active')) {
      setViewVisible(lastPos, map.getZoom());
    }
    wasOpen = open;
  });
  document.querySelectorAll('.modal').forEach(m => mo.observe(m, { attributes: true, attributeFilter: ['class'] }));
}
/* 부드러운 이동: 새 위치가 오면 이전 위치에서 새 위치까지 다음 위치가 올 때까지(보통 1초) 미끄러지듯 옮기고, 지도도 같은 속도로 따라감 */
let meAnim = null, lastFixAt = 0;
function animateMe(lat, lon, acc, dur) {
  if (!meMarker) { showMe(lat, lon, acc); return; }
  const from = meMarker.getLatLng(), t0 = performance.now(), ms = dur * 1000;
  if (meAnim) cancelAnimationFrame(meAnim);
  if (meCircle.getRadius() !== acc) meCircle.setRadius(acc);
  const step = now => {
    const k = Math.min(1, (now - t0) / ms);
    const ll = [from.lat + (lat - from.lat) * k, from.lng + (lon - from.lng) * k];
    meMarker.setLatLng(ll); meCircle.setLatLng(ll); if (headingMarker) headingMarker.setLatLng(ll);
    meAnim = k < 1 ? requestAnimationFrame(step) : null;
  };
  meAnim = requestAnimationFrame(step);
}
// 결과창·검색창을 피해 보이는 지도 한가운데로, 같은 시간 동안 일정한 속도로 이동
function followTo(latlng, dur, zWant) {
  const z = zWant != null ? zWant : map.getZoom(), H = map.getSize().y;
  const top = visTop(), bottom = H - sheetVisH();
  const offset = bottom > top ? H / 2 - (top + bottom) / 2 : 0;
  const c = map.unproject(map.project(latlng, z).add([0, offset]), z);
  if (z !== map.getZoom()) { appZoomUntil = Date.now() + 1500; map.setView(c, z, { animate: true }); } // 축척이 바뀔 땐 확대·축소 애니메이션
  else map.panTo(c, { animate: true, duration: dur, easeLinearity: 1, noMoveStart: true });
}
/* 속도에 맞춘 자동 축척 (내비처럼): 느리면 크게, 빠르면 넓게. 지도 그림이 선명하도록 정수 단계만 사용.
   화면 깜빡임 방지: 최근 3번 속도의 평균으로 판단 · 빨라질 땐 2초, 느려질 땐 5초 이어져야 바꿈 · 한 번 바꾸면 8초는 유지 ·
   경계보다 15% 이상 느려져야 확대. 손으로 확대·축소하면 30초 동안 멈춤 */
const AUTO_ZOOM = [[5, 20], [25, 19], [50, 18], [80, 17], [100, 16], [Infinity, 15]]; // [이 속도(km/h) 미만, 줌] — 20은 19 그림을 2배 확대
let trackKmh = null, autoZ = null, zCand = null, zCandAt = 0, zChangedAt = 0, manualZoomAt = 0, appZoomUntil = 0, kmhHist = [];
// 화면 크기 보정: 위 단계는 '세로 스마트폰'(보이는 지도 폭 약 412px) 기준.
// 실제로 보이는 지도(검색창·접힌 결과창을 뺀 영역)의 짧은 변이 2배면 +1단계(더 확대), 절반이면 −1단계 —
// 그래서 어떤 화면이든 같은 속도에서 비슷한 거리(주변 범위)가 보임
const AZ_REF_PX = 412;
function zoomFit() {
  const sz = map.getSize(), top = visTop();
  const px = Math.max(120, Math.min(sz.x, sz.y - top - 96 * UI_Z)); // 96 = 접힌 결과창 높이
  return { px: Math.round(px), off: Math.max(-2, Math.min(2, Math.round(Math.log2(px / AZ_REF_PX)))) };
}
let zFitCache = null, zFitAt = 0;
function zoomOff() { if (!zFitCache || Date.now() - zFitAt > 3000) { zFitCache = zoomFit(); zFitAt = Date.now(); } return zFitCache.off; }
window.addEventListener('resize', () => { // 화면을 돌리면 다시 계산하고, 단계가 바뀌면 바로 적용
  const old = zFitCache ? zFitCache.off : null; zFitCache = null;
  setTimeout(() => { if (old != null && zoomOff() !== old) autoZ = null; }, 300);
});
function bandZoom(kmh) { for (const [lim, z] of AUTO_ZOOM) if (kmh < lim) return Math.max(10, Math.min(20, z + zoomOff())); }
function autoZoomTarget() {
  if (trackKmh == null || Date.now() - manualZoomAt < 30000) return null; // null = 지금 축척 유지
  let want = bandZoom(trackKmh);
  if (autoZ == null) return (autoZ = want);
  if (want > autoZ && bandZoom(trackKmh * 1.15) <= autoZ) want = autoZ; // 경계보다 15% 이상 느려져야 확대
  if (want === autoZ) { zCand = null; return autoZ; }
  if (zCand !== want) { zCand = want; zCandAt = Date.now(); }
  if (Date.now() - zCandAt >= (want < autoZ ? 2000 : 5000) && Date.now() - zChangedAt >= 8000) { autoZ = want; zCand = null; zChangedAt = Date.now(); }
  return autoZ;
}
map.on('zoomstart', () => {
  if (trackId == null || Date.now() < appZoomUntil) return;
  if (Date.now() - manualZoomAt > 30000) toast('직접 축척을 바꿔서 자동 축척을 30초 동안 멈춰요', 2500);
  manualZoomAt = Date.now(); autoZ = null; zCand = null; // 다시 켜질 땐 그때 속도에 맞는 축척으로 바로
});
// 결과창 좌표를 누르면 복사
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('.coord[data-copy]');
  if (!b) return;
  copyToClip(b.dataset.copy, `복사했어요: ${b.dataset.copy}`);
  b.classList.add('copied'); setTimeout(() => b.classList.remove('copied'), 1200);
});
// 창(날씨·고시보·앱 정보 등)이 열려 있거나 다른 탭을 보는 중이면 지도 움직임을 멈춤 —
// 차량용 안드로이드처럼 그래픽이 약한 기기에서 지도가 계속 움직이면 새 창을 못 그려 하얗게 멈추는 문제 방지
const anyModalOpen = () => !!document.querySelector('.modal:not(.hidden)');
const mapPaused = () => anyModalOpen() || !$('#tab-map').classList.contains('active');
/* ───────── 터널 추정 이동 (추측 항법 · Dead Reckoning) ─────────
   내비게이션 앱처럼 GPS가 끊겨도(터널·지하차도) 점이 멈추지 않게:
   ① 주행 중 주변 터널 도로 모양을 미리 받아 둠 (OpenStreetMap, 3km 반경 · 터널만이라 데이터가 작음)
   ② 끊기면 마지막 위치·진행 방향으로 들어선 터널 도로를 찾아 그 선을 따라 이동 (맵 매칭)
   ③ 이동 속도 = 끊기기 직전 속도. 가속도계가 '차의 앞 방향'을 미리 학습했으면 가감속을 반영
      (휴대폰을 거치대에 고정했을 때만 의미 있음 · 학습이 안 됐거나 폰 자세가 바뀌면 일정 속도)
   ④ GPS가 다시 잡히면 바로 실제 위치로. 추정 중에는 점을 회색으로, 오차 원을 점점 크게, 공역 판정은 하지 않음 */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const DR = { on: false, path: null, s: 0, v: 0, v0: 0, t: 0, startAt: 0, timer: null, name: '', tunLen: 0, imu: false, done: false, P: null, hdg: null, fetching: false };
let tun = { c: null, at: 0, ways: [], busy: false };
let lastGood = null, goodHist = []; // 정확한 마지막 위치들 (진행 방향 계산용)
const bearingOf = (a, b) => { const d = toLocal(b[1], b[0], a[0], a[1]); return (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360; };
const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
async function fetchTunnels(lat, lon) {
  if (tun.busy) return;
  tun.busy = true;
  const q = `[out:json][timeout:15];way(around:3000,${lat.toFixed(5)},${lon.toFixed(5)})[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"][tunnel][tunnel!=no];out body geom qt;`;
  try {
    for (const ep of OVERPASS) {
      try {
        const r = await fetchT(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 15000);
        if (!r.ok) continue;
        const j = await r.json();
        const ways = (j.elements || []).filter(e => e.type === 'way' && e.geometry && e.geometry.length > 1).map(e => {
          const t = e.tags || {}, ow = t.oneway === '-1' ? -1 : (t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || /^motorway/.test(t.highway) || t.junction === 'roundabout') ? 1 : 0;
          const ms = parseInt(t.maxspeed, 10);
          return { id: e.id, nodes: e.nodes || [], pts: e.geometry.map(g => [g.lat, g.lon]), ow, name: t.name || t['tunnel:name'] || t.ref || '', vmax: ms > 0 && ms < 200 ? ms / 3.6 : null };
        });
        tun = { c: [lat, lon], at: Date.now(), ways, busy: false };
        return true;
      } catch (e) {}
    }
  } finally { tun.busy = false; }
  tun.c = [lat, lon]; tun.at = Date.now(); // 실패해도 같은 곳에서 계속 다시 묻지 않게
  return false;
}
function maybePrefetchTunnels(lat, lon) {
  if (trackKmh == null || trackKmh < 25) return; // 차로 달릴 때만
  if (tun.c && distM(tun.c, [lat, lon]) < 1500 && Date.now() - tun.at < 20 * 60e3) return;
  fetchTunnels(lat, lon);
}
// 경로(점 목록) → 누적 거리 포함
function mkPath(pts) {
  const out = [{ lat: pts[0][0], lon: pts[0][1], cum: 0 }];
  for (let i = 1; i < pts.length; i++) { const d = distM(pts[i - 1], pts[i]); if (d < 0.5) continue; out.push({ lat: pts[i][0], lon: pts[i][1], cum: out[out.length - 1].cum + d }); }
  return out;
}
function pathAt(path, s) {
  if (s >= path[path.length - 1].cum - 0.5 && path.length > 1) { const a = path[path.length - 2], e = path[path.length - 1]; return { ll: [e.lat, e.lon], hdg: bearingOf([a.lat, a.lon], [e.lat, e.lon]), end: true }; }
  if (s <= 0) return { ll: [path[0].lat, path[0].lon], hdg: path.length > 1 ? bearingOf([path[0].lat, path[0].lon], [path[1].lat, path[1].lon]) : null };
  for (let i = 1; i < path.length; i++) if (path[i].cum >= s) {
    const a = path[i - 1], b = path[i], k = (s - a.cum) / (b.cum - a.cum);
    return { ll: [a.lat + (b.lat - a.lat) * k, a.lon + (b.lon - a.lon) * k], hdg: bearingOf([a.lat, a.lon], [b.lat, b.lon]) };
  }
  const a = path[path.length - 2] || path[0], b = path[path.length - 1];
  return { ll: [b.lat, b.lon], hdg: bearingOf([a.lat, a.lon], [b.lat, b.lon]), end: true };
}
// 마지막 위치·방향으로 들어선 터널 도로를 찾아 따라갈 경로를 만듦
function drMatch(P, hdg) {
  let best = null;
  for (const w of tun.ways) for (const dir of (w.ow === 1 ? [1] : w.ow === -1 ? [-1] : [1, -1])) {
    const pts = dir === 1 ? w.pts : w.pts.slice().reverse(), nodes = dir === 1 ? w.nodes : w.nodes.slice().reverse();
    // (가) 이미 터널 도로 위 — 선분에 수선을 내려 가까운 곳
    for (let i = 0; i < pts.length - 1; i++) {
      const A = toLocal(pts[i][1], pts[i][0], P[0], P[1]), B = toLocal(pts[i + 1][1], pts[i + 1][0], P[0], P[1]);
      const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy; if (!L2) continue;
      const k = Math.max(0, Math.min(1, -(A[0] * dx + A[1] * dy) / L2)), qx = A[0] + dx * k, qy = A[1] + dy * k, d = Math.hypot(qx, qy);
      const da = angDiff(bearingOf(pts[i], pts[i + 1]), hdg);
      if (d <= 60 && da <= 40) { const sc = d + da * 2; if (!best || sc < best.sc) best = { sc, w, nodes, pts, i, q: [P[0] + qy / 110574, P[1] + qx / (Math.cos(P[0] * Math.PI / 180) * 111320)] }; }
    }
    // (나) 터널 입구가 앞쪽 400m 안에 있음
    const dE = distM(P, pts[0]);
    if (dE > 5 && dE <= 400 && angDiff(bearingOf(P, pts[0]), hdg) <= 25 && angDiff(bearingOf(pts[0], pts[1]), hdg) <= 35) {
      const sc = dE * 0.4 + angDiff(bearingOf(pts[0], pts[1]), hdg) * 2 + 10;
      if (!best || sc < best.sc) best = { sc, w, nodes, pts, i: -1, q: null };
    }
  }
  if (!best) return null;
  let pts = [P].concat(best.i >= 0 ? [best.q].concat(best.pts.slice(best.i + 1)) : best.pts);
  let name = best.w.name, vmax = best.w.vmax, used = new Set([best.w.id]), endNode = best.nodes[best.nodes.length - 1], lastHdg = bearingOf(pts[pts.length - 2], pts[pts.length - 1]);
  for (let n = 0; n < 12; n++) { // 같은 끝점으로 이어지는 다음 터널 구간 (긴 터널은 여러 조각)
    let nx = null;
    for (const w of tun.ways) if (!used.has(w.id)) for (const dir of (w.ow === 1 ? [1] : w.ow === -1 ? [-1] : [1, -1])) {
      const ns = dir === 1 ? w.nodes : w.nodes.slice().reverse(), ps = dir === 1 ? w.pts : w.pts.slice().reverse();
      if (ns[0] !== endNode) continue;
      const da = angDiff(bearingOf(ps[0], ps[1]), lastHdg);
      if (da <= 45 && (!nx || da < nx.da)) nx = { w, ns, ps, da };
    }
    if (!nx) break;
    used.add(nx.w.id); pts = pts.concat(nx.ps.slice(1)); endNode = nx.ns[nx.ns.length - 1]; if (nx.w.vmax) vmax = Math.max(vmax || 0, nx.w.vmax);
    lastHdg = bearingOf(pts[pts.length - 2], pts[pts.length - 1]); if (!name) name = nx.w.name;
  }
  const tunLen = mkPath(pts).slice(-1)[0].cum;
  // 출구 뒤로 400m 직진 연장 (출구를 나와 GPS가 다시 잡힐 때까지)
  const last = pts[pts.length - 1], rad = lastHdg * Math.PI / 180;
  pts.push([last[0] + 400 * Math.cos(rad) / 110574, last[1] + 400 * Math.sin(rad) / (Math.cos(last[0] * Math.PI / 180) * 111320)]);
  return { path: mkPath(pts), name, tunLen, vmax };
}
function drStraight(P, hdg, v) { // 터널 도로를 못 찾으면 진행 방향 직진 (짧은 지하차도 등) — 최대 30초·800m
  const L = Math.min(800, v * 30), rad = hdg * Math.PI / 180;
  return { path: mkPath([P, [P[0] + L * Math.cos(rad) / 110574, P[1] + L * Math.sin(rad) / (Math.cos(P[0] * Math.PI / 180) * 111320)]]), name: '', tunLen: 0 };
}
/* 가속도계: GPS가 잡히는 동안 'GPS 속도 변화'와 '폰이 느낀 가속도'를 비교해 차의 앞 방향(폰 기준)을 학습 */
const IMU = { acc: [0, 0, 0], sq: 0, db: [0, 0, 0], vib: null, vibMove: null, vibStop: null, n: 0, grav: null, g0: null, sx: 0, sxx: 0, sm: [0, 0, 0], smx: [0, 0, 0], w: 0, prevV: null, prevT: 0, on: false };
function onMotion(e) {
  let a = e.acceleration, x, y, z;
  const g = e.accelerationIncludingGravity;
  if (g && g.x != null) { const gv = [g.x, g.y, g.z]; IMU.grav = IMU.grav ? IMU.grav.map((v, i) => v + (gv[i] - v) * 0.02) : gv; }
  if (a && a.x != null) { x = a.x; y = a.y; z = a.z; }
  else if (g && g.x != null && IMU.grav) { x = g.x - IMU.grav[0]; y = g.y - IMU.grav[1]; z = g.z - IMU.grav[2]; }
  else return;
  if (!isFinite(x + y + z)) return;
  IMU.acc[0] += x; IMU.acc[1] += y; IMU.acc[2] += z; IMU.sq += x * x + y * y + z * z; IMU.n++;
}
// 구간 평균 가속도(벡터) + 진동 세기(흔들림의 분산) — 진동은 '차가 섰는지' 판단에 씀 (서 있으면 노면 진동이 사라짐)
function imuTake() {
  if (!IMU.n) { IMU.vib = null; return null; }
  const m = IMU.acc.map(v => v / IMU.n);
  IMU.vib = Math.max(0, IMU.sq / IMU.n - (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]));
  IMU.acc = [0, 0, 0]; IMU.sq = 0; IMU.n = 0; return m;
}
async function imuOn(on) {
  if (on && !IMU.on) {
    try { if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function' && (await DeviceMotionEvent.requestPermission()) !== 'granted') return; } catch (e) { return; }
    window.addEventListener('devicemotion', onMotion); IMU.on = true;
  } else if (!on && IMU.on) { window.removeEventListener('devicemotion', onMotion); IMU.on = false; }
  Object.assign(IMU, { acc: [0, 0, 0], sq: 0, n: 0, sx: 0, sxx: 0, sm: [0, 0, 0], smx: [0, 0, 0], w: 0, prevV: null, prevT: 0, g0: null, db: [0, 0, 0], vib: null, vibMove: null, vibStop: null });
}
function imuLearn(spd, t) { // GPS 위치가 올 때마다
  const m = imuTake();
  if (spd == null || isNaN(spd) || !m) { IMU.prevV = null; return; }
  // 달릴 때·서 있을 때의 진동 세기를 따로 배워 둠
  if (IMU.vib != null) {
    if (spd > 5) IMU.vibMove = IMU.vibMove == null ? IMU.vib : IMU.vibMove + (IMU.vib - IMU.vibMove) * 0.1;
    else if (spd < 0.5) IMU.vibStop = IMU.vibStop == null ? IMU.vib : IMU.vibStop + (IMU.vib - IMU.vibStop) * 0.2;
  }
  if (IMU.prevV != null) {
    const dt = (t - IMU.prevT) / 1000;
    if (dt >= 0.5 && dt <= 3) {
      const ag = (spd - IMU.prevV) / dt, lam = Math.exp(-dt / 180); // 3분 정도의 기억 (폰을 옮기면 다시 배움)
      IMU.sx = IMU.sx * lam + ag; IMU.sxx = IMU.sxx * lam + ag * ag; IMU.w = IMU.w * lam + 1;
      for (let i = 0; i < 3; i++) { IMU.sm[i] = IMU.sm[i] * lam + m[i]; IMU.smx[i] = IMU.smx[i] * lam + m[i] * ag; }
      if (IMU.grav) IMU.g0 = IMU.grav.slice();
    }
  }
  IMU.prevV = spd; IMU.prevT = t;
}
function imuModel() { // m = f·a + b  → 앞 방향 f, 치우침 b
  const varx = IMU.sxx - IMU.sx * IMU.sx / (IMU.w || 1);
  if (IMU.w < 15 || varx < 1.5) return null; // 가감속 경험이 부족하면 쓰지 않음
  const f = IMU.smx.map((v, i) => (v - IMU.sm[i] * IMU.sx / IMU.w) / varx), b = IMU.sm.map((v, i) => (v - f[i] * IMU.sx) / IMU.w);
  const fl = Math.hypot(...f);
  if (fl < 0.4 || fl > 2.5) return null; // 방향을 제대로 못 잡음
  return { f, b, f2: fl * fl };
}
function imuPoseSame() { // 학습 때와 폰 자세(중력 방향)가 비슷한지
  if (!IMU.g0 || !IMU.grav) return false;
  const a = IMU.g0, b = IMU.grav, c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return c > Math.cos(20 * Math.PI / 180);
}
function drWatch(gapS) {
  if (DR.on) return;
  if (DR.done || gapS < 3 || !lastGood || trackKmh == null || trackKmh < 15 || !trackId) return;
  if (Date.now() - lastGood.at > 20e3) return; // 이미 오래 끊긴 뒤면 시작 안 함
  drStart();
}
function drStart() {
  const P = [lastGood.lat, lastGood.lon];
  let hdg = lastGood.hdg;
  if (hdg == null) { const o = goodHist.find(h => distM([h.lat, h.lon], P) > 25); if (o) hdg = bearingOf([o.lat, o.lon], P); }
  if (hdg == null) return; // 방향을 모르면 추정하지 않음
  const v0 = trackKmh / 3.6;
  Object.assign(DR, { on: true, done: true, P, hdg, v0, v: v0, t: Date.now(), startAt: lastGood.at, imu: !!imuModel() && imuPoseSame(), quiet: 0, usedImu: false, zupt: false });
  IMU.db = [0, 0, 0];
  DR.s = v0 * (Date.now() - lastGood.at) / 1000; // 끊긴 뒤 지난 시간만큼 이미 갔다고 봄
  drSetPath();
  imuTake(); // 끊기기 전 값은 버림
  if ((!tun.c || distM(tun.c, P) > 2000 || !tun.ways.length) && !DR.fetching) { // 미리 받은 게 없으면 지금이라도 (터널에서 LTE가 되면)
    DR.fetching = true;
    fetchTunnels(P[0], P[1]).then(ok => { DR.fetching = false; if (ok && DR.on && !DR.name && !DR.tunLen) drSetPath(); });
  }
  if (meMarker) meMarker.setStyle({ fillColor: '#90a4ae', color: '#fff' });
  $('#hudDrRow').classList.remove('hidden');
  DR.timer = setInterval(drTick, 500);
  drTick();
}
function drSetPath() {
  const m = drMatch(DR.P, DR.hdg) || drStraight(DR.P, DR.hdg, DR.v0);
  DR.path = m.path; DR.name = m.name; DR.tunLen = m.tunLen; DR.vmax = m.vmax || null;
  $('#hudDrLab').textContent = m.tunLen ? '🚇 터널 추정' : '➡ 직진 추정';
}
function drTick() {
  if (!DR.on) return;
  const now = Date.now(), dt = (now - DR.t) / 1000; DR.t = now;
  // 속도: 가속도계로 터널 끝까지 계속 보정
  //  · 차 앞 방향 가속도를 적분 (치우침 b는 GPS가 있을 때 배운 값 + 정지 중 다시 맞춘 값)
  //  · 진동이 '서 있을 때' 수준으로 줄면 정지로 보고 속도 0 (막힌 터널) — 이때 센서 치우침도 다시 맞춰 오차가 쌓이지 않게
  //  · 속도 상한: 터널 제한속도(지도 정보)나 끊기기 전 속도의 1.25배
  //  · 폰을 만져 자세가 바뀌면 그때까지 추정한 속도를 유지
  const mod = DR.imu && imuPoseSame() ? imuModel() : null, m = imuTake(), vib = IMU.vib;
  const vCap = Math.max(DR.v0, DR.vmax || 0) * 1.25 + 3;
  const thr = IMU.vibMove == null ? null : IMU.vibStop != null && IMU.vibStop < IMU.vibMove * 0.6 ? (IMU.vibStop + IMU.vibMove) / 2 : IMU.vibMove * 0.3;
  if (thr != null && vib != null && vib < thr) DR.quiet += dt; else DR.quiet = 0;
  DR.zupt = DR.quiet >= (DR.v < 8.4 ? 2 : 5); // 30km/h 아래면 2초, 그 이상이면 5초 조용해야 정지로 봄
  if (mod && m) {
    if (DR.zupt) {
      DR.v = 0;
      for (let i = 0; i < 3; i++) IMU.db[i] += ((m[i] - mod.b[i]) - IMU.db[i]) * Math.min(1, dt / 4); // 서 있는 동안 재는 값 = 센서 치우침
    } else {
      const b = mod.b.map((v, i) => v + IMU.db[i]);
      let a = ((m[0] - b[0]) * mod.f[0] + (m[1] - b[1]) * mod.f[1] + (m[2] - b[2]) * mod.f[2]) / mod.f2;
      a = Math.max(-5, Math.min(4, a));
      DR.v = Math.max(0, Math.min(vCap, DR.v + a * dt));
    }
    DR.usedImu = true;
  } else if (DR.zupt) DR.v = 0; // 가속도 학습이 없어도 진동으로 정지는 알 수 있음
  else if (!DR.usedImu) DR.v = DR.v0; // 학습 없음: 다시 움직이면 끊기기 전 속도로
  const elapsed = (now - DR.startAt) / 1000, total = DR.path[DR.path.length - 1].cum;
  const maxT = DR.tunLen ? Math.min(2400, Math.max(300, DR.tunLen / 4 + 180)) : 30; // 터널: 길이에 맞춰(시속 14km로도 빠져나올 시간 + 3분, 최대 40분) · 직진 추정 30초
  if (elapsed <= maxT) DR.s = Math.min(total, DR.s + DR.v * dt);
  const at = pathAt(DR.path, DR.s), acc = Math.min(400, 15 + DR.s * 0.04);
  gpsHeading = at.hdg;
  const paused = mapPaused();
  if (!meMarker || paused) showMe(at.ll[0], at.ll[1], acc); else animateMe(at.ll[0], at.ll[1], acc, 0.5);
  if (meMarker) meMarker.setStyle({ fillColor: '#90a4ae' });
  lastPos = at.ll;
  renderHeading();
  if (trackFollow && !paused) followTo(at.ll, 0.5, null);
  $('#hudSpd').textContent = `~${(DR.v * 3.6).toFixed(1)} km/h`; $('#hudSpd').className = 'dr';
  const left = DR.tunLen ? Math.max(0, DR.tunLen - DR.s) : null;
  $('#hudDr').textContent = elapsed > maxT || at.end ? 'GPS 기다리는 중'
    : (DR.name ? DR.name.slice(0, 10) + ' · ' : '') + (left != null ? (left > 0 ? `출구까지 ${left >= 1000 ? (left / 1000).toFixed(1) + 'km' : Math.round(left / 10) * 10 + 'm'}` : '출구 지남') : `${Math.round(DR.s)}m`) + (DR.zupt ? ' · 정지' : mod ? ' · 가속도계' : '');
}
function drStop() {
  if (!DR.on) return;
  clearInterval(DR.timer); DR.timer = null; DR.on = false;
  $('#hudDrRow').classList.add('hidden'); $('#hudSpd').className = '';
  if (meMarker) meMarker.setStyle({ fillColor: '#1e88e5' });
}

function onTrackPos(p) {
  const { latitude: lat, longitude: lon, accuracy } = p.coords;
  // 터널 추정 중: 다시 따라가기 버튼(가짜 위치)은 무시, 오차가 큰 위치(기지국 위치 등)는 무시하고 계속 추정
  if (DR.on && p.synthetic) return;
  if (!p.synthetic && accuracy > 60 && lastGood && trackKmh != null && trackKmh >= 15 && Date.now() - lastGood.at < 120e3) return;
  if (DR.on) drStop();
  if (!p.synthetic && accuracy <= 60) {
    const sp = p.coords.speed;
    lastGood = { lat, lon, at: Date.now(), hdg: sp != null && sp > 3 && p.coords.heading != null && !isNaN(p.coords.heading) ? p.coords.heading : null };
    goodHist.unshift({ lat, lon, at: Date.now() }); goodHist = goodHist.filter(h => Date.now() - h.at < 15e3).slice(0, 20);
    DR.done = false; // 다음 끊김에서 다시 추정할 수 있게
    imuLearn(sp, Date.now());
    maybePrefetchTunnels(lat, lon);
  }
  const now = Date.now(), gap = lastFixAt ? (now - lastFixAt) / 1000 : 1;
  lastFixAt = now;
  const paused = mapPaused();
  const dur = Math.max(0.25, Math.min(1.5, gap * 0.95)); // 위치가 오는 간격에 맞춰 이동 시간을 정함
  const jump = meMarker && distM([meMarker.getLatLng().lat, meMarker.getLatLng().lng], [lat, lon]) > 2000; // 순간이동급이면 애니메이션 없이
  // 제자리(화면에서 3픽셀 미만 이동)면 점도 지도도 움직이지 않음 — 서 있을 때 GPS가 1~2m씩 흔들려 화면이 쉬지 않고 다시 그려지던 것 방지
  const moveM = meMarker ? distM([meMarker.getLatLng().lat, meMarker.getLatLng().lng], [lat, lon]) : Infinity;
  const slow = p.coords.speed == null || isNaN(p.coords.speed) || p.coords.speed < 1;
  const still = !!meMarker && !jump && (map.latLngToContainerPoint(meMarker.getLatLng()).distanceTo(map.latLngToContainerPoint([lat, lon])) < 3
    || (slow && moveM < Math.min(8, Math.max(2.5, (accuracy || 5) * 0.5)))); // 크게 확대하면 GPS 1~2m 흔들림도 여러 픽셀이라 거리로도 판단
  if (still) { if (meCircle.getRadius() !== accuracy) meCircle.setRadius(accuracy); }
  else if (jump || !meMarker || paused) showMe(lat, lon, accuracy); else animateMe(lat, lon, accuracy, dur);
  lastPos = [lat, lon];
  updateHud(p.coords, p.timestamp || now);
  if (!paused) renderHudExtra();
  $('#btnLocate').classList.add('found');
  if (trackFollow && !paused) {
    const zt = autoZoomTarget();
    if (jump) { if (zt != null && zt !== map.getZoom()) appZoomUntil = Date.now() + 1500; setViewVisible([lat, lon], zt != null ? zt : map.getZoom()); }
    else if (!still || (zt != null && zt !== map.getZoom())) followTo([lat, lon], dur, zt);
  }
  const moved = !trackLast || distM(trackLast, [lat, lon]) >= TRACK_MOVE_M;
  if (trackFollow && moved && // 다른 지점을 보고 있는 동안(잠시 멈춤)에는 판정을 덮어쓰지 않음
      Date.now() - trackAt >= (trackLast ? TRACK_MIN_MS : 0)) {
    trackLast = [lat, lon]; trackAt = Date.now();
    Promise.resolve(checkAt(lat, lon, '내 위치', { acc: accuracy, retried: true, silent: !!lastResult, cache: true })).then(() => {
      if (!lastResult || lastResult.lat !== lat || lastResult.lon !== lon) return;
      const code = lastResult.verdict.code;
      // 더 엄격한 구역으로 들어가면 알림
      if (trackCode != null && (VERDICT_RANK[code] || 0) > (VERDICT_RANK[trackCode] || 0) && code !== 'partial') {
        toast(`⚠️ ${lastResult.verdict.title} — 지금 위치가 바뀌었어요`, 5000);
        try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
      }
      trackCode = code;
    });
  }
}
function startTrack() {
  if (!navigator.geolocation && !NATIVE_GEO) return toast('이 기기는 위치 기능을 지원하지 않습니다.');
  trackFollow = true; trackLast = null; trackAt = 0; trackCode = lastResult && lastResult.label === '내 위치' ? lastResult.verdict.code : null;
  trackId = geoWatch(onTrackPos, err => {
    if (err.code === 1) { stopTrack(true); toast(geoErrText(err), 4500); }
    else if (err.native && err.code === 2) toast(geoErrText(err), 4500); // 위치 꺼짐·GPS 없음 (켜면 자동으로 다시 받음)
    else toast('위치 신호가 약합니다. 계속 찾는 중…');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }); // 저장된 옛 위치 말고 늘 새 위치
  keepAwake(true);
  compass(true); // 버튼을 누른 순간에 켜야 아이폰에서 권한을 물을 수 있음
  imuOn(true); // 터널 추정용 가속도계 (같은 이유로 여기서)
  drStop(); DR.done = false; lastGood = null; goodHist = [];
  gpsHeading = null; prevFix = null; lastFixAt = 0;
  trackKmh = null; autoZ = null; zCand = null; manualZoomAt = 0; kmhHist = []; zChangedAt = 0; lastPos = null; hudWxTry = Date.now() - 50e3;
  ['hudSun', 'hudWind', 'hudWindUp', 'hudTemp', 'hudZone'].forEach(id => $('#' + id + 'Row').classList.add('hidden'));
  $('#navHud').classList.remove('hidden');
  satPoll(true);
  gpsWatchdog(true);
  trackUI();
  toast('실시간 위치 추적을 켰어요. 움직이면 판정이 바로 바뀌고, 더 엄격한 구역에 들어가면 진동으로 알려줘요.', 4000);
}
function stopTrack(quiet) {
  if (trackId != null) geoClear(trackId);
  drStop(); imuOn(false);
  trackId = null; keepAwake(false); compass(false); gpsHeading = null;
  $('#navHud').classList.add('hidden');
  satPoll(false);
  gpsWatchdog(false);
  if (meAnim) { cancelAnimationFrame(meAnim); meAnim = null; }
  if (headingMarker) { map.removeLayer(headingMarker); headingMarker = null; }
  trackUI();
  if (!quiet) toast('실시간 위치 추적을 껐어요.');
}
$('#btnTrack').addEventListener('click', () => {
  if (trackId == null) startTrack();
  else if (!trackFollow) { trackFollow = true; trackLast = null; trackAt = 0; manualZoomAt = 0; trackUI(); if (meMarker) { const q = meMarker.getLatLng(); setViewVisible([q.lat, q.lng], map.getZoom()); if (!DR.on) onTrackPos({ synthetic: true, coords: { latitude: q.lat, longitude: q.lng, accuracy: meCircle ? meCircle.getRadius() : 30 } }); } }
  else stopTrack();
});
// 지도를 손으로 옮기거나 다른 지점을 누르면 따라가기·자동 판정을 잠시 멈춤 (추적 버튼을 누르면 다시)
function pauseTrackFollow() { if (trackId != null && trackFollow) { trackFollow = false; trackUI(); } }
map.on('dragstart', pauseTrackFollow);
// 화면이 꺼졌다 다시 켜지면 화면 켜짐 유지를 다시 요청
document.addEventListener('visibilitychange', () => { if (!document.hidden && trackId != null) keepAwake(true); });
// 다른 앱에 갔다 돌아오면 폰이 화면 그림을 비워 두는 경우가 있어(특히 결과창처럼 스크롤되는 부분이 하얗게 남음) 전체를 다시 그리게 함
function repaintAll() {
  try { map.invalidateSize(false); } catch (e) {}
  document.querySelectorAll('#sheetBody, .page, .modal:not(.hidden) .modal-box, #notamList, #kpCard, .dropdown').forEach(el => {
    const st = el.scrollTop; el.scrollTop = st + 1; el.scrollTop = st; // 스크롤 영역을 새로 그리게
    el.style.opacity = '0.999';
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('#sheetBody, .page, .modal-box, #notamList, #kpCard, .dropdown').forEach(el => { el.style.opacity = ''; });
  }));
}
window.nfzResume = () => { repaintAll(); setTimeout(repaintAll, 400); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) window.nfzResume(); });
window.addEventListener('pageshow', e => { if (e.persisted) window.nfzResume(); });

/* ───────── 검색 & 즐겨찾기 ───────── */
const resultsBox = $('#searchResults');
// 목록을 왼쪽 확대·축소 버튼과 오른쪽 레이어 버튼 사이에 같은 간격으로 맞춤 (기종마다 버튼 크기가 달라 실제로 재서 계산)
function fitDropdown() {
  const GAP = 8, sb = $('.searchbar').getBoundingClientRect();
  // 지도 버튼(레이어·확대축소)이 모두 오른쪽에 있으니 그 왼쪽 끝을 피하고, 좌우 여백은 같게
  const btns = ['.leaflet-control-layers', '.leaflet-control-zoom'].map(s => document.querySelector(s)).filter(Boolean);
  let mr = 50;
  if (btns.length) mr = Math.max(0, sb.right - (Math.min(...btns.map(b => b.getBoundingClientRect().left)) - GAP));
  let ml = mr;
  if (sb.width - ml - mr < 180) { ml = mr = 0; } // 화면이 너무 좁으면 전체 폭 사용
  resultsBox.style.marginLeft = ml + 'px'; resultsBox.style.marginRight = mr + 'px';
}
function openDropdown() { fitDropdown(); resultsBox.classList.remove('hidden'); }
// 검색창을 누르면: 최근 검색 + 저장한 장소
function showFavorites() {
  const recent = LS.get('recentSearches', []), favs = LS.get('favorites', []);
  if (!recent.length && !favs.length) { resultsBox.innerHTML = '<div class="item"><span>최근 검색 기록이 없습니다.</span></div>'; openDropdown(); return; }
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
  openDropdown();
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
  if (!LS.set('favorites', favs.slice(0, 50))) return toast('저장 공간이 부족해 장소를 저장하지 못했습니다.');
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
  openDropdown();
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
  const d = currentDrone();
  LS.set('flightStart', { t: Date.now(), result: lastResult ? slimResult(lastResult) : null, ft: d.ft || null, dn: d.ft ? d.name : '' });
  runTimer(); switchTab('tab-map');
  toast(d.ft ? `비행 타이머 시작 — ${d.name} 기준 ${Math.round(d.ft * 0.7)}분에 복귀 알림을 드려요.` : '비행 타이머를 시작했습니다. 안전 비행하세요! (날씨 창에서 기체를 고르면 복귀 알림을 받을 수 있어요)', 4000);
}
function runTimer() {
  const st = LS.get('flightStart', null);
  if (!st) { $('#timerBanner').classList.add('hidden'); clearInterval(timerInt); return; }
  $('#timerBanner').classList.remove('hidden');
  // 기체 최대 비행시간(무풍·새 배터리 기준)의 70%에 복귀 준비, 90%에 즉시 착륙 알림 (각 1번)
  const tick = () => {
    const s = Math.floor((Date.now() - st.t) / 1000);
    $('#timerText').textContent = (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + (st.ft ? ` / ${st.ft}분` : '');
    if (!st.ft) return;
    const k = s / (st.ft * 60), bn = $('#timerBanner');
    bn.classList.toggle('warn', k >= 0.7 && k < 0.9); bn.classList.toggle('danger', k >= 0.9);
    const alert = (key, msg, pat) => { if (st[key]) return; st[key] = 1; LS.set('flightStart', st); toast(msg, 8000); try { navigator.vibrate && navigator.vibrate(pat); } catch (e) {} };
    if (k >= 0.9) alert('a90', `🛬 ${st.dn} 최대 비행시간의 90% — 지금 바로 착륙하세요!`, [400, 150, 400, 150, 400]);
    else if (k >= 0.7) alert('a70', `🔋 ${st.dn} 최대 비행시간의 70% — 복귀를 준비하세요. 바람이 세거나 추우면 배터리가 더 빨리 닳아요.`, [250, 120, 250]);
  };
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
    const dr = currentDrone(), lastDrone = logs[0] && logs[0].drone;
    if (dr.id !== 'std' && !dr.id.startsWith('etc')) f.drone.value = dr.name; else if (lastDrone) f.drone.value = lastDrone;
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
  if (!LS.set('flights', logs)) { toast('저장 공간이 부족해 기록을 저장하지 못했습니다. 백업 후 오래된 기록을 지워 주세요.', 5000); return; }
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
  const q = v => { let t = String(v == null ? '' : v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
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
    const str = v => v == null ? '' : String(v).slice(0, 500);
    const numOrNull = v => v == null || v === '' || !isFinite(+v) ? null : +v;
    const cleanFlight = x => x && typeof x === 'object' ? {
      id: str(x.id) || String(Date.now() + Math.random()), date: str(x.date), place: str(x.place), drone: str(x.drone),
      minutes: numOrNull(x.minutes), alt: numOrNull(x.alt), batteries: numOrNull(x.batteries), memo: str(x.memo),
      lat: numOrNull(x.lat), lng: numOrNull(x.lng),
      verdict: x.verdict && typeof x.verdict === 'object' ? { code: str(x.verdict.code), title: str(x.verdict.title), cls: /^v-(red|orange|yellow|green|gray)$/.test(x.verdict.cls) ? x.verdict.cls : 'v-gray' } : null
    } : null;
    const cur = LS.get('flights', []), ids = new Set(cur.map(x => x.id));
    const incoming = data.flights.map(cleanFlight).filter(x => x && !ids.has(x.id));
    const merged = cur.concat(incoming).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!LS.set('flights', merged)) throw new Error('space');
    if (Array.isArray(data.favorites)) {
      const favs = LS.get('favorites', []), keys = new Set(favs.map(f => f.name + f.lat + f.lon));
      const cleanFav = f => f && isFinite(+f.lat) && isFinite(+f.lon) ? { name: str(f.name) || '저장한 장소', lat: +f.lat, lon: +f.lon } : null;
      LS.set('favorites', favs.concat(data.favorites.map(cleanFav).filter(f => f && !keys.has(f.name + f.lat + f.lon))).slice(0, 50));
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

/* ───────── 항공고시보(NOTAM) — 드론 관련만 ───────── */
// GitHub 자동 작업이 30분마다 국토부 xNOTAM에서 가져와 notam.json으로 저장해 둔 것을 읽음
const NOTAM_URLS = ['https://raw.githubusercontent.com/moto2345/nfz-android/main/notam.json'];
const NEAR_KM = 40;   // 알림창은 기준 위치에서 이 거리 안의 것만
const NOTAM_KIND = {  // 종류별 판정 등급
  P: { name: '임시비행금지구역', level: 3 },
  R: { name: '임시비행제한구역', level: 3 },
  D: { name: '임시위험구역', level: 2 },
  U: { name: '드론 활동 구역', level: 2 }
};
const NOTAM_ZONE = { id: 'NOTAM', name: '항공고시보 구역', level: 3, color: '#c62828', pat: 'hatch', note: '항공고시보(NOTAM)로 지정된 임시 구역' };
function notamZone(it, st) {
  const k = notamKind(it);
  if (st === 'active') return Object.assign({}, NOTAM_ZONE, { name: `${k.name}(항공고시보)`, level: k.level });
  const tail = st === 'standby' ? '지금은 비활성 · 시간제' : '예정';
  return Object.assign({}, NOTAM_ZONE, { name: `${k.name}(항공고시보 · ${tail})`, level: 1, color: '#ef6c00' });
}
let notamData = null, notamLayer = null, notamShowAll = false;
const kst = iso => new Date(Date.parse(iso) + 9 * 3600e3);
const fmtKST = iso => { const k = kst(iso); return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`; };
const todayKST = () => kst(new Date().toISOString()).toISOString().slice(0, 10);

// D)항목(시간대, UTC)을 해석해서 지금 활성인지 판단: 'on' | 'off' | 'unknown'
// 예) "2300-0900", "SEP 12-14 16 20-30 0000-0900, OCT 01-18 0000-0900", "16-20 0910-1204 1835-2119, 21-24 1835-2119"
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
// 해석 결과: 'always'(시간 제한 없음) | null(해석 불가) | [{days:[[월,일]…]|null, times:[[시작분,끝분]…]}] (UTC)
function parseSchedule(it) {
  if (it._sch === undefined) Object.defineProperty(it, '_sch', { value: parseScheduleRaw(it), enumerable: false });
  return it._sch;
}
function parseScheduleRaw(it) {
  const s = (it.schedule || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s) return 'always';
  const now = new Date();
  let month = it.start ? new Date(it.start).getUTCMonth() + 1 : now.getUTCMonth() + 1;
  let lastDay = it.start ? new Date(it.start).getUTCDate() : 0; // 첫 날짜가 시작일보다 앞이면 다음 달
  const wins = [];
  let days = [], times = [];
  const flush = () => {
    if (days.length || times.length) wins.push({ days: days.length ? days : null, times: times.length ? times : [[0, 1440]] });
    days = []; times = [];
  };
  const pushDays = (a, b) => {
    if (a < 1 || a > 31 || b < 1 || b > 31) return false;
    if (a < lastDay) month = month % 12 + 1;        // 날짜가 줄어들면 다음 달로 넘어간 것
    if (b < a) { for (let d = a; d <= 31; d++) days.push([month, d]); month = month % 12 + 1; a = 1; }
    for (let d = a; d <= b; d++) days.push([month, d]);
    lastDay = b; return true;
  };
  const toks = s.replace(/,/g, ' , ').split(' ').filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let m;
    if (t === ',') flush();
    else if ((m = t.match(/^(\d{2})(\d{2})-(\d{2})$/)) && /^\d{4}$/.test(toks[i + 1] || '')) {
      // "27 2300-28 0300" 처럼 날짜를 넘겨 이어지는 시간대
      if (days.length !== 1 || times.length) return null;
      const [sm, sd] = days[0], ed = +m[3], n = toks[++i];
      const em = ed < sd ? sm % 12 + 1 : sm;
      wins.push({ days: [[sm, sd]], times: [[+m[1] * 60 + +m[2], 1440]] });
      const mid = [];
      for (let mm = sm, dd = sd + 1; !(mm === em && dd >= ed); dd++) { if (dd > 31) { mm = mm % 12 + 1; dd = 0; continue; } mid.push([mm, dd]); }
      if (mid.length) wins.push({ days: mid, times: [[0, 1440]] });
      wins.push({ days: [[em, ed]], times: [[0, +n.slice(0, 2) * 60 + +n.slice(2)]] });
      days = []; month = em; lastDay = ed;
    }
    else if (MONTHS[t]) { if (times.length) flush(); month = MONTHS[t]; lastDay = 0; }
    else if ((m = t.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/))) times.push([+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
    else if ((m = t.match(/^(\d{2})(?:-(\d{2}))?$/))) {
      if (times.length) flush();                     // 시간 뒤에 날짜가 오면 새 묶음
      if (!pushDays(+m[1], m[2] ? +m[2] : +m[1])) return null;
    }
    else if (t === 'DAILY') { /* 매일 */ }
    else return null; // SR-SS, MON-FRI, EXC, H24 등 → 해석 불가 → 안전하게 '활성'으로 취급
  }
  flush();
  if (!wins.length) return null;
  if (it.start && it.end && wins.some(w => w.days)) {
    const s0 = Date.parse(it.start), e0 = Date.parse(it.end);
    let hit = !wins.every(w => w.days);
    for (let t = s0 - 864e5; !hit && t <= e0 + 864e5 && t - s0 < 400 * 864e5; t += 864e5) {
      const d = new Date(t), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
      hit = wins.some(w => w.days && w.days.some(x => x[0] === m && x[1] === dd));
    }
    if (!hit) return null;
  }
  return wins;
}
const schedHasDay = (w, m, d) => !w.days || w.days.some(x => x[0] === m && x[1] === d);
function schedOn(wins, now) {
  const cm = now.getUTCMonth() + 1, cd = now.getUTCDate(), cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  const y = new Date(now.getTime() - 864e5), ym = y.getUTCMonth() + 1, yd = y.getUTCDate();
  for (const w of wins) for (const [a, b] of w.times) {
    if (b > a) { if (schedHasDay(w, cm, cd) && cur >= a && cur < b) return true; }
    else { // 자정을 넘기는 시간대
      if (schedHasDay(w, cm, cd) && cur >= a) return true;
      if (schedHasDay(w, ym, yd) && cur < b) return true;
    }
  }
  return false;
}
function scheduleState(it, now = new Date()) {
  const w = parseSchedule(it);
  return w === 'always' ? 'on' : !w ? 'unknown' : schedOn(w, now) ? 'on' : 'off';
}
// 한국시간 하루(dayStart = 그날 0시의 UTC ms) 중 활성 시간대 → [[시작분, 끝분], …] (한국시간 기준 분)
function kstDayWindows(it, dayStart) {
  const w = parseSchedule(it), dayEnd = dayStart + 864e5;
  const lo = Math.max(dayStart, it.start ? Date.parse(it.start) : -Infinity), hi = Math.min(dayEnd, it.end ? Date.parse(it.end) : Infinity);
  if (hi <= lo) return [];
  const iv = [];
  if (w === 'always' || !w) iv.push([lo, hi]);
  else for (let u = dayStart - 2 * 864e5; u <= dayEnd; u += 864e5) { // 겹칠 수 있는 UTC 날짜들
    const ud = new Date(u), base = Date.UTC(ud.getUTCFullYear(), ud.getUTCMonth(), ud.getUTCDate());
    const m = ud.getUTCMonth() + 1, d = ud.getUTCDate();
    for (const x of w) if (schedHasDay(x, m, d)) for (const [a, b] of x.times) {
      const s0 = Math.max(lo, base + a * 6e4), e0 = Math.min(hi, base + (b > a ? b : b + 1440) * 6e4);
      if (e0 > s0) iv.push([s0, e0]);
    }
  }
  iv.sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of iv) { const l = out[out.length - 1]; if (l && a <= l[1]) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out.map(([a, b]) => [Math.round((a - dayStart) / 6e4), Math.round((b - dayStart) / 6e4)]);
}
// 사람이 읽기 쉬운 앞으로의 활성 시간 (한국시간): "9/25(오늘) 09:00~12:00, 13:00~18:00 · 9/26(내일) 종일"
function scheduleText(it) {
  const w = parseSchedule(it);
  if (w === 'always') return '';
  if (!w) return `원문(UTC) ${it.schedule}`;
  const k = kst(new Date().toISOString());
  const day0 = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - 9 * 3600e3;
  const last = Math.min(it.end ? Date.parse(it.end) : Infinity, day0 + 31 * 864e5);
  const hm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const parts = []; let more = false;
  const nowMin = Math.floor((Date.now() - day0) / 6e4);
  for (let d = day0; d < last; d += 864e5) {
    const ws = kstDayWindows(it, d).filter(([, b]) => d !== day0 || b > nowMin); // 오늘 이미 지난 시간대는 빼기
    if (!ws.length) continue;
    if (parts.length === 2) { more = true; break; }
    const kd = new Date(d + 9 * 3600e3);
    const label = `${kd.getUTCMonth() + 1}/${kd.getUTCDate()}` + (d === day0 ? '(오늘)' : d === day0 + 864e5 ? '(내일)' : '');
    parts.push(label + ' ' + ws.map(([a, b]) => a === 0 && b === 1440 ? '종일' : `${hm(a)}~${hm(b)}`).join(', '));
  }
  return parts.length ? parts.join(' · ') + (more ? ' …' : '') : '남은 활성 시간 없음';
}
function notamStatus(it, now = Date.now()) {
  const s = it.start ? Date.parse(it.start) : 0, e = it.end ? Date.parse(it.end) : Infinity;
  if (now < s) return 'upcoming';
  if (now > e) return 'ended';
  return scheduleState(it, new Date(now)) === 'off' ? 'standby' : 'active';
}
const QKIND = { QRP: 'P', QRR: 'R', QRT: 'R', QRD: 'D', QWU: 'U' };
const notamKind = it => NOTAM_KIND[it.kind || QKIND[(it.qcode || '').slice(0, 3)]] || NOTAM_KIND.R;
// 취소·대체 안내문(영역 없음)은 제외 — 수집 스크립트에서도 거르지만 한 번 더
const notamValid = it => !/(CN|XX)$/.test(it.qcode || '') && !/NOTAM\s+CNL|NEW NOTAM TO FLW/i.test(it.text || '');
function notamList() { return ((notamData && notamData.items) || []).filter(it => notamValid(it) && notamStatus(it) !== 'ended'); }
function notamPeriod(it) {
  return `${it.start ? fmtKST(it.start) : '지금'} ~ ${it.end ? fmtKST(it.end) + (it.endEst ? '(예상)' : '') : '별도 공지 시까지'}`;
}
function notamAlt(it) {
  if (it.fromTxt || it.toTxt) return `${it.fromTxt || 'SFC'} ~ ${it.toTxt || ''}`.trim();
  return `${it.lower ? it.lower * 100 + 'ft' : '지면'} ~ ${it.upper >= 999 ? '제한 없음' : it.upper * 100 + 'ft'}`;
}
function notamFeature(it) {
  return { type: 'Feature', geometry: it.geometry, properties: {
    번호: it.no, 기간: notamPeriod(it), 활성시간: scheduleText(it), 고도: notamAlt(it), 내용: it.text } };
}
async function loadNotams() {
  let got = null;
  for (const wait of [0, 3000, 10000, 30000]) { // 실패하면 3초·10초·30초 뒤 다시
    if (wait) await new Promise(r => setTimeout(r, wait));
    for (const u of NOTAM_URLS) {
      try {
        const r = await fetchT(u + '?t=' + Date.now(), { cache: 'no-store' }, 10000);
        if (r.ok) { const d = await r.json(); if (d && Array.isArray(d.items)) { got = d; break; } }
      } catch (e) {}
    }
    if (got) break;
  }
  if (!got) return;
  const wasMissing = !notamData;
  notamData = got;
  // 판정이 항공고시보 없이 먼저 나갔다면 조용히 다시 판정
  if (wasMissing && lastResult && lastResult.notamMissing) recheckLast();
  drawNotams();
  updateNotamButton();
  if (lastResult) autoOpenNotams();
  else setTimeout(autoOpenNotams, 8000); // 위치를 못 잡는 경우엔 지도 중심 기준으로
}
// 앱을 연 뒤 첫 판정(내 위치 등)이 나오면 그 주변 기준으로 한 번만 자동 알림
let notamAutoDone = false;
function autoOpenNotams() {
  if (!notamData || notamAutoDone) return;
  notamAutoDone = true;
  if (LS.get('notamHide', '') === todayKST()) return;
  if (nearbyNotams().length && $('#notamModal').classList.contains('hidden')) openNotamModal();
}
function drawNotams() {
  if (!layerCtl) return;
  if (!notamLayer) {
    notamLayer = L.layerGroup();
    overlayZone.set(notamLayer, NOTAM_ZONE);
    layerCtl.addOverlay(notamLayer, `${swatch(NOTAM_ZONE)} 항공고시보(임시 구역)`);
    const saved = LS.get('layerOn', {});
    if (saved.NOTAM === false) hiddenZones.add('NOTAM');
    else { quietToggle = true; notamLayer.addTo(map); quietToggle = false; }
  }
  notamLayer.clearLayers();
  notamShapes = [];
  for (const it of notamList()) {
    if (!it.geometry) continue;
    const on = notamStatus(it) === 'active';
    const lay = L.geoJSON(it.geometry, { interactive: false, style: {
      color: on ? '#c62828' : '#ef6c00', weight: 2, dashArray: on ? '5 4' : '2 6',
      fillColor: on ? '#e53935' : '#ef6c00', fillOpacity: on ? 0.14 : 0.05 } });
    notamShapes.push({ lay, b: lay.getBounds() });
  }
  syncNotamView();
}
// 전국 고시보(200개 넘음)를 한꺼번에 올려 두면 지도가 움직일 때마다(실시간 추적 중엔 1초마다) 전부 다시 그려져
// 화면이 하얗게 깜빡임 → 지금 보이는 화면(+주변 절반) 안의 것만 지도에 올림
let notamShapes = [];
function syncNotamView() {
  if (!notamLayer || !notamShapes.length) return;
  const vb = map.getBounds().pad(0.5);
  for (const s of notamShapes) {
    const want = s.b.isValid() && vb.intersects(s.b), has = notamLayer.hasLayer(s.lay);
    if (want && !has) notamLayer.addLayer(s.lay); else if (!want && has) notamLayer.removeLayer(s.lay);
  }
}
map.on('moveend', syncNotamView);
function refPoint() {
  if (lastResult) return [lastResult.lat, lastResult.lon];
  if (meMarker) { const p = meMarker.getLatLng(); return [p.lat, p.lng]; }
  const c = map.getCenter(); return [c.lat, c.lng];
}
function refName() {
  if (lastResult) return lastResult.label === '내 위치' ? '내 위치' : '확인한 지점';
  return meMarker ? '내 위치' : '지도 중심';
}
function notamRows(all) {
  const [rl, ro] = refPoint(), soon = Date.now() + 864e5;
  return notamList().map(it => ({
    it, st: notamStatus(it),
    d: it.geometry ? (containsPoint(it.geometry, ro, rl) ? 0 : distToBoundary(it.geometry, ro, rl)) : Infinity
  })).filter(r => all || (r.d <= NEAR_KM * 1000 && (r.st !== 'upcoming' || Date.parse(r.it.start) < soon)))
    .sort((a, b) => (a.st === 'active' ? 0 : 1) - (b.st === 'active' ? 0 : 1) || a.d - b.d);
}
function nearbyNotams() { return notamRows(false); }
function updateNotamButton() {
  const btn = $('#btnNotam'); if (!btn || !notamData) return;
  const near = nearbyNotams();
  btn.classList.remove('hidden');
  $('#notamCount').textContent = near.length;
  $('#notamCount').classList.toggle('hidden', !near.length);
  btn.classList.toggle('has-active', near.some(r => r.st === 'active'));
}
function openNotamModal() {
  const rows = notamRows(notamShowAll).slice(0, notamShowAll ? 200 : 100);
  const all = notamList().length, act = rows.filter(r => r.st === 'active').length;
  const age = notamData.fetchedAtUTC ? (Date.now() - Date.parse(notamData.fetchedAtUTC)) / 3600e3 : 99;
  $('#notamSummary').innerHTML = (notamShowAll
      ? `전국 드론 관련 <b>${all}</b>건 (가까운 순)`
      : `${refName()}에서 ${NEAR_KM}km 안 · 지금 활성 <b>${act}</b>건 · 시간제·예정 <b>${rows.length - act}</b>건`)
    + ` <button type="button" class="linkbtn" id="notamScope">${notamShowAll ? '내 주변만 보기' : `전국 ${all}건 보기`}</button><br>`
    + `<span class="muted">확인 시각 ${notamData.fetchedAtUTC ? fmtKST(notamData.fetchedAtUTC) : '-'}${age > 8 ? ' · ⚠️ 최신이 아닐 수 있어요' : ''}</span>`;
  const badge = st => st === 'active' ? '<span class="tag" style="background:#c62828">지금 활성</span>'
    : st === 'standby' ? '<span class="tag" style="background:#ef6c00">시간제 · 지금 비활성</span>'
    : '<span class="tag" style="background:#ef6c00">예정</span>';
  $('#notamList').innerHTML = rows.map((r, i) => {
    const it = r.it, k = notamKind(it);
    const where = !it.geometry ? '영역 정보 없음' : r.d === 0 ? `📍 ${refName()}가 이 구역 안` : `${refName()}에서 ${fmtDist(r.d)}`;
    return `<div class="notam-item ${r.st}">
      <div class="log-top"><b>${esc(k.name)} <span class="muted small">${esc(it.no)}</span></b>${badge(r.st)}</div>
      <div class="meta">🕘 ${esc(notamPeriod(it))}${it.schedule ? '<br>⏱ 활성 ' + esc(scheduleText(it)) : ''}<br>↕ ${esc(notamAlt(it))} · ${esc(where)}</div>
      <div class="notam-text">${esc(it.text)}</div>
      ${it.geometry ? `<button class="btn sm" data-ni="${i}">🗺 지도에서 보기</button>` : ''}
    </div>`;
  }).join('') || `<p class="muted">${refName()}에서 ${NEAR_KM}km 안에는 지금·오늘 해당하는 드론 관련 항공고시보가 없어요.</p>`;
  $('#notamScope').addEventListener('click', () => { notamShowAll = !notamShowAll; openNotamModal(); });
  $$('#notamList [data-ni]').forEach(b => b.addEventListener('click', () => {
    const it = rows[+b.dataset.ni].it;
    closeNotamModal();
    switchTab('tab-map');
    const z = it.radiusM ? (it.radiusM > 8000 ? 11 : it.radiusM > 3000 ? 12 : 13) : 12;
    setViewVisible([it.center[0], it.center[1]], z);
    checkAt(it.center[0], it.center[1], `${it.no} 항공고시보`);
  }));
  $('#notamModal').classList.remove('hidden');
  $('#notamList').scrollTop = 0;
}
function closeNotamModal() {
  if ($('#notamHideToday').checked) LS.set('notamHide', todayKST());
  $('#notamHideToday').checked = false;
  notamShowAll = false;
  $('#notamModal').classList.add('hidden');
}
$('#btnNotamClose').addEventListener('click', closeNotamModal);
$('#notamModal').addEventListener('click', e => { if (e.target.id === 'notamModal') closeNotamModal(); });
$('#btnNotam').addEventListener('click', () => { if (notamData) { notamShowAll = false; openNotamModal(); } });
const notamReady = loadNotams();
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!hiddenAt || Date.now() - hiddenAt < 600e3) return;
  hiddenAt = 0;
  loadNotams().then(recheckLast);
});

/* ───────── 새로고침 시 이전 상태 복원 ───────── */
(function restore() {
  const tab = LS.get('lastTab', 'tab-map');
  if (tab !== 'tab-map' && $(`.tabbar button[data-tab="${tab}"]`)) switchTab(tab);
  const v = LS.get('mapView', null);
  if (v && isFinite(v.lat) && isFinite(v.lng)) map.setView([v.lat, v.lng], v.z || CFG.DEFAULT_ZOOM, { animate: false });
  const lp = LS.get('lastPoint', null);
  if (lp && vkey()) {
    if (lp.label === '내 위치' || lp.label === '마지막으로 확인한 내 위치') locateMe({ quiet: true, fallback: Object.assign({}, lp, { label: '내 위치' }), keepView: !!v });
    else checkAt(lp.lat, lp.lon, lp.label);
  }
})();

/* ───────── 안내 탭: 지도 구역 표시 범례 ───────── */
function renderMapLegend() {
  const box = $('#mapLegend'); if (!box) return;
  box.innerHTML = ZONES.filter(z => !z.optional || verified.has(z.id))
    .map(z => `<li>${swatch(z)}<span>${esc(z.name)} <span class="muted">— ${esc(z.note)}</span></span></li>`).join('');
}
renderMapLegend();

/* ───────── 연결 점검: 인증키와 외부 서버를 실제로 시험 ───────── */
function diagVW(path, params, domain) {
  const p = Object.assign({ key: vkey(), format: 'json', errorFormat: 'json' }, params);
  const d = domain === undefined ? VW_DOMS[vwDom] : domain; // 따로 안 정하면 지금 앱이 쓰는 형식
  if (d) p.domain = d;
  return jsonpRaw('https://api.vworld.kr/req/' + path, p, 8000).then(res => {
    const r = res && res.response;
    if (!r) throw new Error('응답 형식이 이상함');
    if (r.status === 'OK' || r.status === 'NOT_FOUND') return r;
    const er = r.error || {};
    throw new Error([er.code, er.text].filter(Boolean).join(' · ') || r.status);
  });
}
function diagImg(url, ms = 8000) {
  return new Promise((ok, bad) => {
    const im = new Image(), t = setTimeout(() => { im.src = ''; bad(new Error('시간 초과')); }, ms);
    im.onload = () => { clearTimeout(t); im.naturalWidth > 0 ? ok(im.naturalWidth + 'px 이미지') : bad(new Error('빈 이미지')); };
    im.onerror = () => { clearTimeout(t); bad(new Error('이미지가 아님(인증키 거부·서버 오류 가능)')); };
    im.src = url;
  });
}
async function runDiag() {
  const out = $('#diagOut'), btn = $('#btnDiag'), rows = [];
  btn.disabled = true; btn.textContent = '점검 중…'; $('#btnDiagCopy').classList.add('hidden');
  const render = () => {
    out.innerHTML = rows.map(r => `<li class="${r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'warn'}"><span>${r.ok === true ? '✅' : r.ok === false ? '❌' : '⚠️'}</span><b>${esc(r.name)}</b><small>${esc(r.detail || '')}${r.ms != null ? ` · ${r.ms}ms` : ''}</small></li>`).join('');
    const bad = rows.filter(r => r.ok === false).length, warn = rows.filter(r => r.ok === 'warn').length;
    $('#diagSum').innerHTML = `<b>${bad ? `❌ 문제 ${bad}개` : '✅ 문제 없음'}</b>${warn ? ` · ⚠️ 주의 ${warn}개` : ''} · 항목 ${rows.length}개`;
  };
  const add = (ok, name, detail, ms) => { rows.push({ ok, name, detail, ms }); render(); };
  const step = async (name, fn, judge) => {
    const t0 = Date.now();
    try { const v = await fn(); const j = judge ? judge(v) : [true, String(v == null ? '' : v)]; add(j[0], name, j[1], Date.now() - t0); return v; }
    catch (e) { add(false, name, (e && e.message) || String(e), Date.now() - t0); return undefined; }
  };
  try {
    // 1) 사용 환경
    const ua = navigator.userAgent;
    const where = /KAKAOTALK/i.test(ua) ? '카카오톡 안 브라우저' : /NAVER\(inapp/i.test(ua) ? '네이버 앱 안 브라우저' : window.NFZApp ? '안드로이드 앱' : /SamsungBrowser/i.test(ua) ? '삼성 인터넷' : /Chrome/i.test(ua) ? '크롬' : /Safari/i.test(ua) ? '사파리' : '기타 브라우저';
    const inApp = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i.test(ua);
    add(inApp ? 'warn' : true, '사용 환경', `${where} · ${($('.appbar .badge') || {}).textContent || ''} · 주소 ${location.origin}${location.pathname}` + (inApp ? ' — 메신저 안 브라우저에서 문제가 계속되면 삼성 인터넷·크롬·앱에서 열어 보세요.' : ''));
    // 2) 인증키 형식
    const key = vkey();
    const keyOk = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(key);
    add(keyOk, '인증키 형식', key ? `${key.slice(0, 4)}…${key.slice(-4)} (${key.length}자)${keyOk ? '' : ' — 형식이 올바르지 않아요'}` : '인증키가 없어요');
    if (!key) return;
    const [lat, lon] = lastResult ? [lastResult.lat, lastResult.lon] : [map.getCenter().lat, map.getCenter().lng];
    const bbox = bboxAround(lat, lon, CFG.CHECK_RADIUS_M);
    add(true, '점검 기준 지점', `${lat.toFixed(4)}, ${lon.toFixed(4)} (${lastResult ? '마지막으로 확인한 지점' : '지도 중심'})`);
    const dataParams = id => ({ service: 'data', request: 'GetFeature', version: '2.0', data: id, size: '1000', page: '1', geometry: 'false', attribute: 'true', crs: 'EPSG:4326', geomFilter: `BOX(${bbox.join(',')})` });
    // 3) 공역 자료(데이터 API) — 층마다 한 번씩, 순서대로
    for (const z of ZONES.filter(z => !z.optional || verified.has(z.id))) {
      await step(`공역 자료 · ${z.name}`, () => diagVW('data', dataParams(z.id)),
        r => [true, r.status === 'NOT_FOUND' ? '정상 (주변에 없음)' : `정상 (${((r.result && r.result.featureCollection && r.result.featureCollection.features) || []).length}건)`]);
    }
    // 3-1) 실제 판정과 같은 방식(구역 모양 포함, 동시에 4개씩)으로 한 번
    await step('실제 판정 방식 (모양 포함·동시 요청)', async () => {
      const zs = ZONES.filter(z => !z.optional);
      const res = await Promise.allSettled(zs.map(z => queryLayerOnce(z, bbox)));
      const bad = res.map((r, i) => r.status === 'rejected' ? `${zs[i].name}: ${r.reason && r.reason.message}` : '').filter(Boolean);
      if (bad.length) throw new Error(`${zs.length}개 중 ${bad.length}개 실패 — ${bad.join(' / ')}`);
      return `${zs.length}개 모두 정상`;
    });
    // 4) 같은 요청을 5번 — 가끔만 실패하는지 확인
    let okN = 0; const errs = new Set(); const t0 = Date.now();
    for (let i = 0; i < 5; i++) { try { await diagVW('data', dataParams('LT_C_AISPRHC')); okN++; } catch (e) { errs.add(e.message); } }
    add(okN === 5 ? true : okN ? 'warn' : false, '반복 요청 안정성 (비행금지구역 5회)', `${okN}/5 성공${errs.size ? ' · 실패 원인: ' + [...errs].join(' / ') : ''}`, Date.now() - t0);
    // 5) domain 값 형식별로 인증키가 받아들여지는지 (형식마다 3번)
    const names = { base: '경로 포함', none: 'domain 없음', origin: '주소만(예전 방식)' };
    const vr = [], score = {};
    for (const d of VW_ORDER) {
      let n = 0, why = '';
      for (let i = 0; i < 3; i++) { try { await diagVW('data', dataParams('LT_C_AISUAC'), VW_DOMS[d]); n++; } catch (e) { why = e.message; } }
      score[d] = n;
      vr.push(`${names[d]} ${n}/3${d === vwDom ? '(사용 중)' : ''}${n < 3 && why ? ` — ${why}` : ''}`);
    }
    add(score[vwDom] === 3 ? true : score[vwDom] ? 'warn' : false, '인증키 도메인 확인', vr.join(' · ') + ` · 등록 주소는 ${PAGE_BASE.replace(/^https?:\/\//, '').replace(/\/$/, '')} 여야 해요`);
    const best = VW_ORDER.reduce((a, b) => (score[b] > score[a] ? b : a), vwDom);
    if (score[best] > score[vwDom]) { setVwDom(best); add(true, '형식 자동 변경', `앞으로 '${names[best]}' 형식으로 보냅니다`); }
    // 6) 주소·검색 API
    await step('주소 찾기 (좌표→주소)', () => diagVW('address', { service: 'address', request: 'getAddress', version: '2.0', crs: 'epsg:4326', point: `${lon},${lat}`, type: 'both' }),
      r => { const x = r.result && r.result[0]; return [true, x ? x.text : '정상 (주소 없음)']; });
    await step('장소 검색', () => diagVW('search', { service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: '1', page: '1', query: '서울시청', type: 'place' }),
      r => [true, r.status === 'OK' ? `정상 (${(r.result && r.result.items && r.result.items[0] && r.result.items[0].title) || '결과 있음'})` : '정상 (결과 없음)']);
    // 7) 지도 그림(배경지도 WMTS, 공역 WMS)
    await step('배경지도 그림', () => diagImg(`https://api.vworld.kr/req/wmts/1.0.0/${key}/Base/7/49/109.png`));
    const m = (x, y) => [x * 20037508.34 / 180, Math.log(Math.tan((90 + y) * Math.PI / 360)) * 20037508.34 / Math.PI];
    const [x1, y1] = m(126.9, 37.5), [x2, y2] = m(127.05, 37.65);
    await step('공역 지도 그림 (비행금지구역)', () => diagImg('https://api.vworld.kr/req/wms?' + new URLSearchParams(Object.assign({
      service: 'WMS', request: 'GetMap', version: '1.3.0', layers: 'lt_c_aisprhc', styles: 'lt_c_aisprhc', crs: 'EPSG:3857',
      bbox: [x1, y1, x2, y2].map(v => v.toFixed(1)).join(','), width: '256', height: '256', format: 'image/png', transparent: 'true', key }, VW_DOMS[vwDom] ? { domain: VW_DOMS[vwDom] } : {}))));
    // 8) 날씨·지자기·항공고시보
    await step('날씨 (Open-Meteo)', async () => { const r = await fetchT(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=wind_speed_10m&wind_speed_unit=ms`, {}, 12000); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); return j.current; },
      c => [true, `정상 (풍속 ${c.wind_speed_10m}m/s)`]);
    await step('지자기 Kp (NOAA)', () => { kpCache = null; return fetchKp(); }, v => [true, `정상 (Kp ${v.now})`]);
    await step('항공고시보 자료', async () => { const r = await fetchT(NOTAM_URLS[0] + '?t=' + Date.now(), { cache: 'no-store' }, 12000); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
      d => { const age = d.fetchedAtUTC ? (Date.now() - Date.parse(d.fetchedAtUTC)) / 3600e3 : 99; return [age > 8 ? 'warn' : true, `${(d.items || []).length}건 · ${d.fetchedAtUTC ? fmtKST(d.fetchedAtUTC) + ' 받음' : '받은 시각 모름'}${age > 8 ? ' — 자동 갱신이 멈췄을 수 있어요' : ''}`]; });
    // 9) 휴대폰 저장 공간·저장된 전국 자료
    let bytes = 0; const nat = [];
    try { for (const k of Object.keys(localStorage)) { const v = localStorage.getItem(k) || ''; bytes += (k.length + v.length) * 2; if (k.startsWith('nat:')) { const c = JSON.parse(v); nat.push(`${(ZONES.find(z => z.id === k.slice(4)) || {}).name || k} ${c.f.length}건(${new Date(c.t).getMonth() + 1}/${new Date(c.t).getDate()})`); } } } catch (e) {}
    add(bytes > 4e6 ? 'warn' : true, '휴대폰 저장 공간', `${(bytes / 1024).toFixed(0)}KB 사용 · 비행 기록 ${LS.get('flights', []).length}건 · 저장된 전국 공역: ${nat.join(', ') || '없음'}`);
    // 10) 오프라인용 화면 저장(서비스 워커)
    add(true, '화면 저장(오프라인)', 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? '사용 중' : '아직 준비 안 됨 (한 번 더 열면 켜져요)') : '이 브라우저는 지원 안 함');
  } finally {
    btn.disabled = false; btn.textContent = '다시 점검';
    $('#btnDiagCopy').classList.remove('hidden');
  }
}
$('#btnDiag').addEventListener('click', runDiag);
$('#btnDiagCopy').addEventListener('click', async () => {
  const text = ['[하코 NFZ 연결 점검] ' + new Date().toLocaleString('ko-KR'), $('#diagSum').textContent]
    .concat($$('#diagOut li').map(li => `${li.querySelector('span').textContent} ${li.querySelector('b').textContent} — ${li.querySelector('small').textContent}`)).join('\n');
  try { await navigator.clipboard.writeText(text); toast('점검 결과를 복사했습니다.'); }
  catch (e) { if (window.NFZApp && window.NFZApp.share) window.NFZApp.share(text); else prompt('아래 내용을 복사하세요', text); }
});

/* ───────── 앱 정보 창 (상단 버전 배지를 누르면) ─────────
   버전·업데이트 확인 / 데이터 상태 / 최근 바뀐 점 / 강제 새로고침·상태 복사·앱 설치·자세히 진단 */
const CHANGELOG = [
  ['v1.80', '휴대폰 브라우저에서 앱 정보·날씨 등 창의 윗부분이 주소창에 가려 잘리던 문제 수정'],
  ['v1.79', '터널 추정: 가속도계 보정을 출구까지 계속 (긴 터널 지원 · 정체로 멈추면 정지 감지 · 센서 치우침 자동 보정 · 제한속도 상한)'],
  ['v1.78', '화면 배율 조절 버튼 (지도 왼쪽 아래 · 80~160%) — 지도는 선명하게, 글자·버튼·창만 크게'],
  ['v1.77', '터널·지하차도에서 GPS가 끊겨도 터널 도로를 따라 추정 이동 (가속도계 보정) · 속도 소수점 한 자리'],
  ['v1.76', '상단 🌊 물때 버튼 — 만조·간조 시각, 밀물·썰물 흐름 그래프, 사리·조금 (4일)'],
  ['v1.75', '자동 축척 단계 변경: 5km/h 미만 20 · ~25 19 · ~50 18 · ~80 17 · ~100 16 · 그 이상 15 (지도 최대 20레벨)'],
  ['v1.74', '실시간 추적 자동 축척을 화면 크기에 맞춤 (가로·세로 폰, 태블릿, 차량용 화면)'],
  ['v1.73', '다른 앱에 갔다 돌아오면 결과창이 하얗게 비어 보이던 문제 수정'],
  ['v1.72', '지점 좌표를 위경도·도분초 두 가지로 표시 · 누르면 복사'],
  ['v1.71', '실시간 추적 화면이 하얗게 깜빡이던 문제 개선 (화면 밖 고시보는 그리지 않음 · 제자리에선 지도 고정 · 내 위치 점을 따로 그림)'],
  ['v1.70', '실시간 추적 중 창을 열면 지도 움직임을 멈춤 (차량용 기기에서 창이 하얗게 멈추던 문제)'],
  ['v1.69', '앱: 옛 기종에서 실시간 추적 중 계기판·위치 아이콘이 깜빡이던 문제 수정'],
  ['v1.68', '앱: 옛 기종·차량용 기기에서도 내 위치 (기기 GPS에서 직접) · 처음 켤 때 위치 권한 묻기 · 위치 실패 이유 안내'],
  ['v1.67', '앱 정보의 위치 권한을 앱 권한·GPS 켜짐까지 정확하게 확인'],
  ['v1.66', '앱 정보에서 설치된 앱(APK)도 최신인지 확인'],
  ['v1.65', '앱: 뒤로가기로 열린 창 닫기 · 두 번 눌러야 종료'],
  ['v1.64', '버전을 누르면 앱 정보(업데이트 확인·데이터 상태·바뀐 점)'],
  ['v1.63', '주간 날씨 7일 + 날마다 비행 적합도(○△✕)'],
  ['v1.62', '터널 등 GPS 끊김 표시 · 앱에서 속도 정확도 색 표시'],
  ['v1.61', '속도별 자동 축척 5단계 · 화면 깜빡임 줄임'],
  ['v1.58', 'DJI 새 기종(Lito·Neo 2·Avata 360) · 기체별 추위 경고 · 조종자 자격 안내 · 비행 타이머 복귀 알림']
];
const WEB_VER = ($('#btnVer') && $('#btnVer').textContent.trim()) || '';
let verStatusText = '';
// '1.0.22' 같은 버전 비교 (a가 새것이면 양수)
function verCmp(a, b) { const x = String(a).split('.').map(Number), y = String(b).replace(/^v/i, '').split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
function agoText(ms) { const m = Math.round(ms / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; }
async function openVer() {
  $('#verModal').classList.remove('hidden'); $('#verModal .modal-box').scrollTop = 0;
  const chromeVer = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '';
  const appVer = window.NFZApp && window.NFZApp.version ? (() => { try { return window.NFZApp.version(); } catch (e) { return ''; } })() : '';
  const row = (ico, name, val, lv) => `<div class="ver-row"><span>${ico} ${name}</span><b class="${lv === 'ok' ? 'q-good' : lv === 'mid' ? 'q-mid' : lv === 'bad' ? 'q-bad' : ''}">${val}</b></div>`;
  const render = (latest, geo, apkLatest) => {
    const lines = [];
    // ① 버전
    let upd;
    if (latest === undefined) upd = ['확인 중…', ''];
    else if (!latest) upd = ['확인 못 함 (오프라인?)', 'mid'];
    else if (latest === WEB_VER) upd = ['최신 버전이에요 ✅', 'ok'];
    else upd = [`새 버전 ${latest} 있어요 → 강제 새로고침`, 'bad'];
    // 앱(APK): GitHub 다운로드 페이지(Release)의 최신 버전과 비교
    let apk = null, apkNew = false;
    if (apkLatest === undefined) apk = ['확인 중…', ''];
    else if (!apkLatest) apk = ['확인 못 함', 'mid'];
    else if (appVer) { apkNew = verCmp(apkLatest, appVer) > 0; apk = apkNew ? [`새 앱 v${apkLatest} 있어요 → 📱 앱 설치`, 'bad'] : ['최신 앱이에요 ✅', 'ok']; }
    else apk = [`v${apkLatest}`, ''];
    $('#btnVerApk').classList.toggle('hidden', !!window.NFZApp && !apkNew);
    let h = `<div class="ver-sec">버전</div>` + row('🌐', '웹 화면', WEB_VER, '') + row('🔔', '웹 업데이트', upd[0], upd[1])
      + (appVer ? row('📱', '설치된 앱', 'v' + esc(appVer) + (chromeVer ? ` · 화면 엔진 ${chromeVer}` : ''), '') + row('🔔', '앱 업데이트', apk[0], apk[1]) : row('📱', '안드로이드 앱 최신', apk[0], apk[1]));
    lines.push(`하코 NFZ 조회 웹 ${WEB_VER} · 웹 업데이트: ${upd[0]}`, appVer ? `설치된 앱 v${appVer} (화면 엔진 ${chromeVer || '?'}) · 앱 업데이트: ${apk[0]}` : `안드로이드 앱 최신: ${apk[0]}`);
    // ② 데이터 상태
    const d = [];
    if (!lastResult) d.push(['🗺', '공역 자료(브이월드)', '아직 조회 전', '']);
    else if (lastResult.verdict.code === 'error') d.push(['🗺', '공역 자료(브이월드)', '불러오지 못함', 'bad']);
    else if (lastResult.failed.length) d.push(['🗺', '공역 자료(브이월드)', `일부 실패 (${lastResult.failed.map(f => f.zone.name).join(', ')})`, 'mid']);
    else d.push(['🗺', '공역 자료(브이월드)', '정상', 'ok']);
    if (!notamData) d.push(['📢', '항공고시보', '불러오지 못함', 'bad']);
    else { const age = notamData.fetchedAtUTC ? Date.now() - Date.parse(notamData.fetchedAtUTC) : null; d.push(['📢', '항공고시보', age == null ? '받음' : `${agoText(age)} 갱신`, age != null && age > 8 * 3600e3 ? 'mid' : 'ok']); }
    d.push(['📞', '담당 연락처', CONTACTS ? `기준 ${esc(CONTACTS.updated)}` : '불러오지 못함', CONTACTS ? 'ok' : 'mid']);
    d.push(['🧲', '지자기 Kp', kpShown ? `Kp ${kpShown.now}${kpCache ? ' · ' + agoText(Date.now() - kpCache.t) : ''}` : '받지 못함', kpShown ? 'ok' : 'mid']);
    d.push(['🌤', '날씨', lastResult && lastResult.wx ? `받음 · ${agoText(Date.now() - (lastResult.wxAt || Date.now()))}` : lastResult ? '받지 못함' : '아직 조회 전', lastResult && lastResult.wx ? 'ok' : lastResult ? 'mid' : '']);
    const acc = lastResult && lastResult.label === '내 위치' && lastResult.acc ? ` · 오차 ±${Math.round(lastResult.acc)}m` : '';
    // 위치: 앱이면 안드로이드 권한·위치 서비스를 직접 확인, 웹이면 브라우저 권한 + 이번에 위치를 실제로 받았는지
    const lp = appLocPerm();
    const gotFix = !!meMarker;
    let loc;
    if (lp) loc = !lp.fine && !lp.coarse ? ['거부됨 (폰 설정 → 앱 → 권한에서 허용)', 'bad']
      : lp.hasGps === false ? (lp.net ? ['허용됨 · GPS 없는 기기라 통신망 위치만 (오차 큼)', 'mid'] : ['허용됨 · 이 기기는 GPS가 없어요', 'bad'])
      : !lp.gps ? ['허용됨 · 폰 위치(GPS)가 꺼져 있어요', 'bad']
      : !lp.fine ? ['대략적 위치만 허용 (정확한 위치를 켜 주세요)', 'mid'] : ['허용됨 (정확한 위치)' + acc, 'ok'];
    else if (geo === 'denied') loc = ['거부됨 (브라우저 설정에서 허용)', 'bad'];
    else if (geo === 'granted' || gotFix) loc = ['허용됨' + acc, 'ok'];
    else if (geo === 'prompt') loc = ['아직 확인 전 (⌖ 내 위치를 누르면 확인돼요)', ''];
    else loc = ['확인 불가', ''];
    if (lp && geoNative) loc[0] += ' · 앱이 GPS에서 직접 받는 중';
    d.push(['📍', '위치 권한', loc[0], loc[1]]);
    { const f = zoomFit(); d.push(['🔍', '자동 축척 화면 보정', `${f.off > 0 ? '+' : ''}${f.off}단계 (보이는 지도 ${f.px}px · ${innerWidth}×${innerHeight})`, '']); }
    h += `<div class="ver-sec">데이터 상태</div>` + d.map(x => row(...x)).join('');
    lines.push(...d.map(x => `${x[1]}: ${x[2].replace(/<[^>]+>/g, '')}`));
    // ③ 바뀐 점
    h += `<div class="ver-sec">최근 바뀐 점</div><ul class="ver-log">${CHANGELOG.map(([v, t]) => `<li><b>${v}</b> ${esc(t)}</li>`).join('')}</ul>`;
    const ua = navigator.userAgent;
    lines.push('기기: ' + (/SamsungBrowser/i.test(ua) ? '삼성 인터넷' : window.NFZApp ? '안드로이드 앱' : /Chrome/i.test(ua) ? '크롬' : /Safari/i.test(ua) ? '사파리' : '기타') + ' · ' + new Date().toLocaleString('ko-KR'));
    verStatusText = lines.join('\n');
    $('#verBody').innerHTML = h;
  };
  render(undefined, null, undefined);
  const [latest, geo, apkLatest] = await Promise.all([
    fetchT('index.html?_=' + Date.now(), { cache: 'no-store' }, 8000).then(r => r.ok ? r.text() : null).then(t => { const m = t && t.match(/id="btnVer"[^>]*>\s*(v[\d.]+)\s*</); return m ? m[1] : null; }).catch(() => null),
    navigator.permissions && navigator.permissions.query ? navigator.permissions.query({ name: 'geolocation' }).then(p => p.state).catch(() => null) : Promise.resolve(null),
    fetchT('https://api.github.com/repos/moto2345/nfz-android/releases/latest', { headers: { Accept: 'application/vnd.github+json' } }, 8000)
      .then(r => r.ok ? r.json() : null).then(j => j && j.tag_name ? String(j.tag_name).replace(/^v/i, '') : null).catch(() => null)
  ]);
  if (!$('#verModal').classList.contains('hidden')) render(latest, geo, apkLatest);
}
const closeVer = () => $('#verModal').classList.add('hidden');
$('#btnVer').addEventListener('click', openVer);
$('#btnVerX').addEventListener('click', closeVer);
$('#btnVerClose').addEventListener('click', closeVer);
$('#verModal').addEventListener('click', e => { if (e.target.id === 'verModal') closeVer(); });
// 강제 새로고침: 저장해 둔 화면(서비스워커·캐시)을 지우고 최신으로 다시 받기 (비행 기록·즐겨찾기는 그대로)
$('#btnHardReload').addEventListener('click', async () => {
  toast('최신 버전을 받는 중…');
  try { if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch (e) {}
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch (e) {}
  location.replace(location.pathname + '?r=' + Date.now());
});
$('#btnCopyStatus').addEventListener('click', async () => {
  const t = verStatusText || '';
  try { await navigator.clipboard.writeText(t); toast('상태를 복사했어요. 카톡 등에 붙여넣기 하세요.'); }
  catch (e) { if (window.NFZApp && window.NFZApp.share) window.NFZApp.share(t); else prompt('아래 내용을 복사하세요', t); }
});
$('#btnVerDiag').addEventListener('click', () => {
  closeVer(); switchTab('tab-info');
  const c = $('#diagCard'); if (c) { c.open = true; setTimeout(() => c.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100); }
});

/* 안드로이드 뒤로가기: 열린 창 닫기 → 지도 탭으로 → (그래도 없으면 앱이 '한 번 더 누르면 종료' 처리) */
window.nfzBack = () => {
  const open = $$('.modal:not(.hidden)');
  if (open.length) { open[open.length - 1].classList.add('hidden'); return true; }
  const kc = $('#kpCard'); if (kc && !kc.classList.contains('hidden')) { kc.classList.add('hidden'); return true; }
  const act = $('.tab.active'); if (act && act.id !== 'tab-map') { switchTab('tab-map'); return true; }
  return false;
};

/* ───────── 앱에서 실행 중이면 앱 설치 안내 숨김 ───────── */
if (window.NFZApp) {
  const dl = $('#androidApp'); if (dl) dl.classList.add('hidden');
}

/* ───────── PWA ───────── */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// 테스트용 노출
window.__dz = { DR, IMU, get tun() { return tun; }, startTrack, stopTrack, zoomFit, tideExtremes, tidePhase, get tracking() { return trackId != null; }, runDiag, sunTimesKST, nationalGet, containsPoint, distToBoundary, makeVerdict, ZONES, hiddenZones, overlayZone, drawZones, notamStatus, scheduleText, scheduleState, kstDayWindows, get notamData() { return notamData; } };
})();
