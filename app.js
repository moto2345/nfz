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
    current: 'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl',
    hourly: 'precipitation_probability,precipitation', forecast_hours: '3',
    daily: 'sunrise,sunset', timezone: 'Asia/Seoul', wind_speed_unit: 'ms', forecast_days: '1'
  });
  const [r, kp] = await Promise.all([fetchT(u, {}, 12000), Promise.race([fetchKp(), new Promise(res => setTimeout(() => res(null), 6000))]).catch(() => null)]);
  if (!r.ok) throw new Error('날씨 오류');
  const w = await r.json();
  w.kp = kp;
  if (w.current) setPRef(w.current, lat, lon); // 기압계 고도 계산 기준으로도 씀
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
$('#kpBadge').addEventListener('click', () => {
  if (!kpShown) return;
  const k = kpShown.now, m = kpShown.max6;
  const what = k >= 5 ? '지자기 폭풍 — GPS·나침반이 불안정할 수 있어요. 수동(ATTI) 조종에 자신 없으면 비행을 미루세요.'
    : k >= 4 ? '약간 불안정 — GPS 위성 수와 홈포인트를 꼭 확인하세요.' : '안정 — GPS·나침반 영향이 거의 없어요.';
  toast(`지자기 Kp ${k} · ${what}${m != null && m >= 5 && k < 5 ? ` (6시간 안에 최대 Kp ${m} 예보)` : ''} (0~3 안정 · 4 주의 · 5 이상 폭풍)`, 6000);
});
// 기체별 최대 내풍 성능(제조사 공식 사양, m/s) — 강풍 판정 기준
const DRONES = [
  { id: 'std', name: '기체 선택 안 함 (250g급 기준)', wind: 10.7 },
  { id: 'mini3', name: 'DJI Mini 3', wind: 10.7, g: 248 },
  { id: 'mini3pro', name: 'DJI Mini 3 Pro', wind: 10.7, g: 249 },
  { id: 'mini4k', name: 'DJI Mini 4K', wind: 10.7, g: 249 },
  { id: 'mini4pro', name: 'DJI Mini 4 Pro', wind: 10.7, g: 249 },
  { id: 'mini5pro', name: 'DJI Mini 5 Pro', wind: 12, g: 249 },
  { id: 'neo', name: 'DJI Neo', wind: 8, g: 135 },
  { id: 'flip', name: 'DJI Flip', wind: 10.7, g: 249 },
  { id: 'air3', name: 'DJI Air 3', wind: 12, g: 720 },
  { id: 'air3s', name: 'DJI Air 3S', wind: 12, g: 724 },
  { id: 'mavic3', name: 'DJI Mavic 3 Classic', wind: 12, g: 895 },
  { id: 'mavic3pro', name: 'DJI Mavic 3 Pro', wind: 12, g: 958 },
  { id: 'mavic4pro', name: 'DJI Mavic 4 Pro', wind: 12, g: 1063 },
  { id: 'avata2', name: 'DJI Avata 2', wind: 10.7, g: 377 },
  { id: 'inspire2', name: 'DJI Inspire 2', wind: 10, g: 3440 },
  { id: 'inspire3', name: 'DJI Inspire 3', wind: 12, g: 3995, note: '이착륙 12m/s · 비행 중 14m/s' },
  { id: 'etc-s', name: '기타 소형 (250g 미만)', wind: 8 },
  { id: 'etc-m', name: '기타 중형 (250g~2kg)', wind: 10 }
];
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
    // 앞으로 3시간: 비 올 확률(최대)·예상 강수량(합)
    rainProb: w.hourly && w.hourly.precipitation_probability ? Math.max(...w.hourly.precipitation_probability.map(v => v || 0)) : null,
    rainMm: w.hourly && w.hourly.precipitation ? Math.round(w.hourly.precipitation.reduce((a, v) => a + (v || 0), 0) * 10) / 10 : 0
  };
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
    <p class="muted small">※ 날씨는 예보 모델 값이라 실제와 다를 수 있어요. 비가 오거나 바람이 세면 화면과 상관없이 비행하지 마세요.</p>
    <label class="drone-pick">내 기체
      <select id="dronePick">${DRONES.map(d => `<option value="${d.id}"${d.id === dr.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    </label>
    <p class="muted small">바람 기준: 돌풍 ${dr.wind}m/s 또는 평균 ${(dr.wind * 0.75).toFixed(1)}m/s 이상이면 강풍${dr.note ? ` (${dr.note})` : ''}${dr.g ? ` · ${dr.g >= 1000 ? (dr.g / 1000).toFixed(2) + 'kg' : dr.g + 'g'}` : ''}</p>`;
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
    const vw = (name, ext) => L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/${name}/{z}/{y}/{x}.${ext}`, { maxZoom: 19, minZoom: 6, attribution: '© V-World' });
    baseLayers['기본지도'] = vw('Base', 'png');
    const sat = vw('Satellite', 'jpeg'), hyb = vw('Hybrid', 'png');
    baseLayers['위성지도'] = L.layerGroup([sat, hyb]);
  } else {
    baseLayers['OpenStreetMap'] = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
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
    version: '1.3.0', key, opacity: z.level === 0 ? 0.45 : 0.55, maxZoom: 19,
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
  fitMapButtons();
}
// 오른쪽 버튼 줄: 위(레이어·확대축소)와 아래(Kp·내 위치)가 겹칠 만큼 지도가 좁으면 확대·축소 버튼을 숨김
function fitMapButtons() {
  const zc = document.querySelector('.leaflet-control-zoom'), col = $('.fab-col');
  if (!zc || !col || !col.offsetParent) return;
  zc.classList.remove('squeezed');
  const zb = zc.getBoundingClientRect();
  const colTop = col.offsetParent.getBoundingClientRect().bottom - sheet.offsetHeight - 10 - col.offsetHeight; // 움직이는 중에도 최종 위치로 계산
  if (zb.height && zb.bottom + 8 > colTop) zc.classList.add('squeezed');
}
window.addEventListener('resize', fitMapButtons);
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

function renderResult(r) {
  const v = r.verdict;
  const addrLine = r.label || (r.addr && (r.addr.road || r.addr.parcel)) || '선택한 지점';
  const isMe = r.label === '내 위치';
  const sub = !isMe && r.addr && r.addr.road && r.addr.parcel ? r.addr.parcel : '';
  let h = `<div class="verdict ${v.cls}"><div class="ico">${v.ico}</div><div><b>${v.title}</b><small>${esc(v.desc)}</small></div></div>
    ${v.code === 'partial' || v.code === 'error' ? `<div class="recheck"><button class="btn sm primary" id="btnRecheck">⟳ 다시 확인</button><span class="muted small" id="recheckNote"></span></div>` : ''}
    <p class="addr"><b>${esc(addrLine)}</b><br><span class="muted">${isMe ? '위도 ' + r.lat.toFixed(5) + ' · 경도 ' + r.lon.toFixed(5) : esc(sub) + ' ' + r.lat.toFixed(5) + ', ' + r.lon.toFixed(5)}</span></p>
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
  h += `<div id="wxBox"><div class="hint"><span class="spinner"></span>날씨 확인 중…</div></div>
    <p class="muted small" style="margin-top:12px">※ 참고용입니다. 항공고시보(임시 구역)는 드론 관련만 30분 간격으로 반영돼 늦을 수 있으니 비행 전 드론 원스톱에서 최종 확인하세요.</p>`;
  sheetHtml(h);
  $('#btnFav').onclick = () => addFavorite(r);
  $('#btnLogHere').onclick = () => openLogForm({ fromResult: r });
  $('#btnFlyStart').onclick = () => startTimer();
  $('#btnCopy').onclick = () => copyPoint(r);
  const rb = $('#btnRecheck'); if (rb) rb.onclick = () => checkAt(r.lat, r.lon, r.label || undefined, { retried: true });
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
    if (hiddenZones.has(x.zone.id)) continue; // 목록에서 끈 구역은 강조선도 숨김
    const inside = x.dist === 0;
    L.geoJSON(x.feature, { style: { color: x.zone.color, weight: inside ? 3 : 2, opacity: 0.95, fillOpacity: inside ? 0.06 : 0, dashArray: inside ? null : '6 4' }, interactive: false }).addTo(zoneGeo);
  }
}

/* ───────── 현재 위치 ───────── */
function showMe(lat, lon, accuracy) {
  if (meMarker) { meMarker.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]).setRadius(accuracy); }
  else {
    meCircle = L.circle([lat, lon], { radius: accuracy, stroke: false, fillColor: '#1e88e5', fillOpacity: 0.16, interactive: false }).addTo(map); // GPS 정확도 반경
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
    const z = opt.keepView ? map.getZoom() : Math.max(map.getZoom(), 14);
    setViewVisible([lat, lon], z);
    // 결과 창이 다 그려진 뒤, 내 위치를 보이는 지도 영역의 정중앙에 한 번 더 맞춤
    Promise.resolve(checkAt(lat, lon, '내 위치', { acc: accuracy })).then(() => setTimeout(() => {
      if (!$('#tab-map').classList.contains('active')) return;
      if (!lastResult || lastResult.lat !== lat || lastResult.lon !== lon) return; // 그 사이 다른 지점을 눌렀으면 옮기지 않음
      lastSheetH = sheet.offsetHeight || lastSheetH;
      setViewVisible([lat, lon], map.getZoom());
    }, 80));
  }, err => {
    fab.classList.remove('locating', 'found');
    if (opt.fallback) { checkAt(opt.fallback.lat, opt.fallback.lon, opt.fallback.label === '내 위치' ? '마지막으로 확인한 내 위치' : opt.fallback.label); return; }
    toast(err.code === 1 ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.' : '위치를 가져오지 못했습니다.');
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
$('#btnLocate').addEventListener('click', () => { if (trackId != null && !trackFollow) { trackFollow = true; trackLast = null; trackUI(); } locateMe(); });

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
  gpsHeading = spd != null && spd > 1 && c.heading != null && !isNaN(c.heading) ? c.heading : null; // 걷는 속도 이상일 때만 진행 방향 사용
  $('#hudSpd').textContent = spd == null || isNaN(spd) ? '-' : `${(spd * 3.6).toFixed(spd * 3.6 < 10 ? 1 : 0)} km/h`;
  gpsAlt = c.altitude == null || isNaN(c.altitude) ? null : c.altitude;
  lastPos = [c.latitude, c.longitude];
  renderAlt();
  setAcc(c.accuracy);
  renderHeading();
}
/* 고도: 기압계가 있는 폰(안드로이드 앱)은 기압계 + 그 지역 해면기압(Open-Meteo)으로 계산 — GPS보다 훨씬 덜 흔들림.
   없으면 GPS 고도. GPS 고도는 타원체 기준이라 우리나라에선 해발보다 20~30m 높게 나오므로, 앱(안드로이드 14+)이 알려 주는 지오이드 높이만큼 뺌 */
let gpsAlt = null, lastPos = null, baroHpa = null, geoidN = null, pRef = null, pRefBusy = false, pRefTry = 0;
function setPRef(cur, lat, lon) {
  if (!(cur.pressure_msl > 900 && cur.pressure_msl < 1100)) return;
  pRef = { p0: cur.pressure_msl, tC: isFinite(cur.temperature_2m) ? cur.temperature_2m : 15, lat, lon, t: Date.now() };
}
function pRefOk(pos) { return pRef && Date.now() - pRef.t < 3 * 3600e3 && (!pos || distM(pos, [pRef.lat, pRef.lon]) < 30000); }
async function fetchPRef(lat, lon) {
  if (pRefBusy) return; pRefBusy = true; pRefTry = Date.now();
  try {
    const r = await fetchT('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({ latitude: lat.toFixed(3), longitude: lon.toFixed(3), current: 'pressure_msl,temperature_2m' }), {}, 10000);
    if (r.ok) { const j = await r.json(); if (j.current) setPRef(j.current, lat, lon); }
  } catch (e) {} finally { pRefBusy = false; }
}
function baroAltitude(p) { // 측고 공식(현지 기온 반영)
  return (Math.pow(pRef.p0 / p, 1 / 5.257) - 1) * (pRef.tC + 273.15) / 0.0065;
}
function renderAlt() {
  let h = null, src = '';
  if (baroHpa != null) {
    if (pRefOk(lastPos)) { h = baroAltitude(baroHpa); src = '기압'; }
    else if (lastPos && !pRefBusy && Date.now() - pRefTry > 60e3) fetchPRef(lastPos[0], lastPos[1]); // 1분에 한 번까지만 시도
  }
  if (h == null && gpsAlt != null) { h = gpsAlt - (geoidN || 0); src = 'GPS'; }
  if (h == null) { $('#hudAlt').textContent = '-'; $('#hudAltSrc').textContent = ''; return; }
  $('#hudAlt').textContent = `${Math.round(h)} m`;
  $('#hudAltSrc').textContent = src;
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
  baroHpa = null; geoidN = null;
  if (!has) return;
  try { on ? window.NFZApp.gnssStart() : window.NFZApp.gnssStop(); } catch (e) {}
  if (!on) return;
  const tick = () => {
    let g = null; try { g = JSON.parse(window.NFZApp.gnss()); } catch (e) {}
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

/* 부드러운 이동: 새 위치가 오면 이전 위치에서 새 위치까지 다음 위치가 올 때까지(보통 1초) 미끄러지듯 옮기고, 지도도 같은 속도로 따라감 */
let meAnim = null, lastFixAt = 0;
function animateMe(lat, lon, acc, dur) {
  if (!meMarker) { showMe(lat, lon, acc); return; }
  const from = meMarker.getLatLng(), t0 = performance.now(), ms = dur * 1000;
  if (meAnim) cancelAnimationFrame(meAnim);
  meCircle.setRadius(acc);
  const step = now => {
    const k = Math.min(1, (now - t0) / ms);
    const ll = [from.lat + (lat - from.lat) * k, from.lng + (lon - from.lng) * k];
    meMarker.setLatLng(ll); meCircle.setLatLng(ll); if (headingMarker) headingMarker.setLatLng(ll);
    meAnim = k < 1 ? requestAnimationFrame(step) : null;
  };
  meAnim = requestAnimationFrame(step);
}
// 결과창·검색창을 피해 보이는 지도 한가운데로, 같은 시간 동안 일정한 속도로 이동
function followTo(latlng, dur) {
  const z = map.getZoom(), H = map.getSize().y;
  const top = $('.searchbar').offsetTop + $('#searchForm').offsetHeight, bottom = H - (sheet.offsetHeight || 0);
  const offset = bottom > top ? H / 2 - (top + bottom) / 2 : 0;
  const c = map.unproject(map.project(latlng, z).add([0, offset]), z);
  map.panTo(c, { animate: true, duration: dur, easeLinearity: 1, noMoveStart: true });
}
function onTrackPos(p) {
  const { latitude: lat, longitude: lon, accuracy } = p.coords;
  const now = Date.now(), gap = lastFixAt ? (now - lastFixAt) / 1000 : 1;
  lastFixAt = now;
  const dur = Math.max(0.25, Math.min(1.5, gap * 0.95)); // 위치가 오는 간격에 맞춰 이동 시간을 정함
  const jump = meMarker && distM([meMarker.getLatLng().lat, meMarker.getLatLng().lng], [lat, lon]) > 2000; // 순간이동급이면 애니메이션 없이
  if (jump || !meMarker) showMe(lat, lon, accuracy); else animateMe(lat, lon, accuracy, dur);
  updateHud(p.coords, p.timestamp || now);
  $('#btnLocate').classList.add('found');
  if (trackFollow && $('#tab-map').classList.contains('active')) { if (jump) setViewVisible([lat, lon], map.getZoom()); else followTo([lat, lon], dur); }
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
  if (!navigator.geolocation) return toast('이 기기는 위치 기능을 지원하지 않습니다.');
  trackFollow = true; trackLast = null; trackAt = 0; trackCode = lastResult && lastResult.label === '내 위치' ? lastResult.verdict.code : null;
  trackId = navigator.geolocation.watchPosition(onTrackPos, err => {
    if (err.code === 1) { stopTrack(); toast('위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.'); }
    else toast('위치 신호가 약합니다. 계속 찾는 중…');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }); // 저장된 옛 위치 말고 늘 새 위치
  keepAwake(true);
  compass(true); // 버튼을 누른 순간에 켜야 아이폰에서 권한을 물을 수 있음
  gpsHeading = null; prevFix = null; lastFixAt = 0;
  $('#navHud').classList.remove('hidden');
  satPoll(true);
  trackUI();
  toast('실시간 위치 추적을 켰어요. 움직이면 판정이 바로 바뀌고, 더 엄격한 구역에 들어가면 진동으로 알려줘요.', 4000);
}
function stopTrack(quiet) {
  if (trackId != null) navigator.geolocation.clearWatch(trackId);
  trackId = null; keepAwake(false); compass(false); gpsHeading = null;
  $('#navHud').classList.add('hidden');
  satPoll(false);
  if (meAnim) { cancelAnimationFrame(meAnim); meAnim = null; }
  if (headingMarker) { map.removeLayer(headingMarker); headingMarker = null; }
  trackUI();
  if (!quiet) toast('실시간 위치 추적을 껐어요.');
}
$('#btnTrack').addEventListener('click', () => {
  if (trackId == null) startTrack();
  else if (!trackFollow) { trackFollow = true; trackLast = null; trackAt = 0; trackUI(); if (meMarker) { const q = meMarker.getLatLng(); setViewVisible([q.lat, q.lng], map.getZoom()); onTrackPos({ coords: { latitude: q.lat, longitude: q.lng, accuracy: meCircle ? meCircle.getRadius() : 30 } }); } }
  else stopTrack();
});
// 지도를 손으로 옮기거나 다른 지점을 누르면 따라가기·자동 판정을 잠시 멈춤 (추적 버튼을 누르면 다시)
function pauseTrackFollow() { if (trackId != null && trackFollow) { trackFollow = false; trackUI(); } }
map.on('dragstart', pauseTrackFollow);
// 화면이 꺼졌다 다시 켜지면 화면 켜짐 유지를 다시 요청
document.addEventListener('visibilitychange', () => { if (!document.hidden && trackId != null) keepAwake(true); });

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
  for (const it of notamList()) {
    if (!it.geometry) continue;
    const on = notamStatus(it) === 'active';
    L.geoJSON(it.geometry, { interactive: false, style: {
      color: on ? '#c62828' : '#ef6c00', weight: 2, dashArray: on ? '5 4' : '2 6',
      fillColor: on ? '#e53935' : '#ef6c00', fillOpacity: on ? 0.14 : 0.05 } }).addTo(notamLayer);
  }
}
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
window.__dz = { startTrack, stopTrack, get tracking() { return trackId != null; }, runDiag, sunTimesKST, nationalGet, containsPoint, distToBoundary, makeVerdict, ZONES, hiddenZones, overlayZone, drawZones, notamStatus, scheduleText, scheduleState, kstDayWindows, get notamData() { return notamData; } };
})();
