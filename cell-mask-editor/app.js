'use strict';
// 세포 마스크 편집기 — 채널 TIF + 인스턴스 마스크 TIF(0=배경, 1..N=세포 번호)를 브라우저에서 보고 고친다.
// 파일 규칙: <세트>_membrane.tif, <세트>_nucleus.tif, <세트>_membrane_mask_gt.tif, <세트>_nucleus_mask_gt.tif,
//           <세트>_초벌_membrane_mask.tif, <세트>_초벌_nucleus_mask.tif, (선택) <세트>_composite.png
// 수정본은 열린 폴더 안 수정본/ 에 같은 파일명으로 저장한다(원본은 건드리지 않음).

const SAVE_DIR = '수정본';
const CHANNELS = [
  { key: 'nucleus', name: '세포핵 채널', color: [40, 90, 255] },
  { key: 'membrane', name: '세포막 채널', color: [0, 230, 0] },
];
const MASKS = [
  { key: 'nucleus_mask_gt', name: '세포핵 정답', kind: 'nucleus', draft: false },
  { key: 'membrane_mask_gt', name: '세포막 정답', kind: 'membrane', draft: false },
  { key: '초벌_nucleus_mask', name: '세포핵 초벌', kind: 'nucleus', draft: true },
  { key: '초벌_membrane_mask', name: '세포막 초벌', kind: 'membrane', draft: true },
];

const $ = (id) => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');

const S = {
  files: new Map(),     // NFC 파일명 → File | FileSystemFileHandle (폴더 최상위)
  edited: new Map(),    // NFC 파일명 → 수정본/ 안의 파일
  dir: null,            // FileSystemDirectoryHandle (Chrome·Edge)
  sets: [], idx: -1, cur: null,
  cache: new Map(),     // 세트 → 불러온 데이터
  view: { s: 1, tx: 0, ty: 0 },
  mode: 'work',        // 'work' = 작업(마스크 수정) · 'review' = 검수(코멘트, review.js)
  tool: 'pan', brush: 10, label: 1, lastLabel: 1, preserve: false, showNumbers: true,
  active: null,         // 편집 대상 마스크 key
  layerUI: {},          // key → {visible, opacity, contour}  (세트를 넘겨도 유지)
  adjust: {},           // 채널 key → {b, c, g}
  shuffle: 0, colors: new Map(),
  masksHidden: false,   // Space 짧게 = 전체 마스크 끄기/켜기
  solo: false,          // O = 선택한 세포(와 짝인 핵)만 보기
  space: false, mouse: null, drag: null, poly: null, vx: null,
};

// ───────────────────────── 파일 읽기 / 쓰기 ─────────────────────────
const nfc = (s) => s.normalize('NFC');
async function asFile(f) { return f.getFile ? f.getFile() : f; }

async function readTiff(f) {
  const buf = await (await asFile(f)).arrayBuffer();
  const tiff = await GeoTIFF.fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const w = img.getWidth(), h = img.getHeight(), spp = img.getSamplesPerPixel();
  const r = await img.readRasters();
  let data = r[0];
  if (spp > 1) {  // RGB로 저장된 채널/마스크는 밝은 값(최대) 하나로
    data = new data.constructor(w * h);
    for (let c = 0; c < Math.min(spp, 3); c++) { const a = r[c]; for (let i = 0; i < a.length; i++) if (a[i] > data[i]) data[i] = a[i]; }
  }
  return { w, h, data };
}

function writeTiff(data, w, h) {  // 무압축 1채널 TIFF (uint16, 번호가 65535를 넘으면 uint32)
  let max = 0; for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  const bps = max > 65535 ? 32 : 16, bytes = bps / 8, n = 10, off = 136;
  const buf = new ArrayBuffer(off + w * h * bytes), dv = new DataView(buf);
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, n, true);
  let p = 10;
  const tag = (id, type, val) => { dv.setUint16(p, id, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, 1, true);
    type === 3 ? dv.setUint16(p + 8, val, true) : dv.setUint32(p + 8, val, true); p += 12; };
  tag(256, 4, w); tag(257, 4, h); tag(258, 3, bps); tag(259, 3, 1); tag(262, 3, 1);
  tag(273, 4, off); tag(277, 3, 1); tag(278, 4, h); tag(279, 4, w * h * bytes); tag(339, 3, 1);
  dv.setUint32(p, 0, true);
  const out = bps === 16 ? new Uint16Array(buf, off, w * h) : new Uint32Array(buf, off, w * h);
  out.set(data);
  return new Blob([buf], { type: 'image/tiff' });
}

function addFile(path, f) {  // path: 열린 폴더 기준 상대 경로
  const parts = nfc(path).split('/').filter(Boolean);
  if (parts.length === 1) S.files.set(parts[0], f);
  else if (parts.length === 2 && parts[0] === SAVE_DIR) S.edited.set(parts[1], f);
}

async function openFolder() {
  if (window.showDirectoryPicker) {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'cell-mask', mode: 'read' }); }
    catch (e) {
      // 사용자가 취소한 경우가 아니면(브라우저가 폴더 접근을 막은 경우 등) 일반 폴더 선택으로 대신 연다
      if (e.name !== 'AbortError') { msg('이 브라우저에서는 폴더에 직접 저장할 수 없어, 저장은 다운로드로 대신합니다.'); $('dir-input').click(); }
      return;
    }
    await loadFromDirHandle(dir);
  } else {
    $('dir-input').click();
  }
}

async function loadFromDirHandle(dir) {
  resetFolder(); S.dir = dir;
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'file') addFile(name, h);
    else if (nfc(name) === SAVE_DIR) for await (const [n2, h2] of h.entries()) if (h2.kind === 'file') addFile(`${SAVE_DIR}/${n2}`, h2);
  }
  await startFolder(dir.name);
}

async function loadFromFileList(list) {  // <input webkitdirectory> 또는 테스트용 [{path, file}]
  resetFolder();
  let root = '';
  for (const it of list) {
    const file = it.file || it, rel = it.path || file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    if (parts.length > 1) { root = root || parts[0]; parts.shift(); }
    addFile(parts.join('/'), file);
  }
  await startFolder(root || '선택한 파일');
}

function resetFolder() {
  S.files.clear(); S.edited.clear(); S.cache.clear(); S.dir = null; S.sets = []; S.idx = -1; S.cur = null;
  S.poly = null; S.vx = null;
}

async function startFolder(label) {
  S.sets = [...S.files.keys()].map((n) => n.match(/^(.+)_membrane\.tiff?$/i)).filter(Boolean).map((m) => m[1])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!S.sets.length) { alert('이 폴더에서 <세트>_membrane.tif 파일을 찾지 못했습니다.'); return; }
  const anyDraft = S.sets.some((s) => S.files.has(`${s}_초벌_membrane_mask.tif`) || S.files.has(`${s}_초벌_nucleus_mask.tif`));
  for (const m of MASKS) S.layerUI[m.key] = { visible: anyDraft ? m.draft && m.kind === 'membrane' : m.kind === 'membrane',
    opacity: anyDraft && !m.draft ? 0.9 : 0.45, contour: anyDraft ? !m.draft : m.kind === 'membrane', width: 1 };
  if (!anyDraft) S.layerUI.nucleus_mask_gt.visible = true;
  for (const c of CHANNELS) S.layerUI[c.key] = { visible: true }, S.adjust[c.key] = S.adjust[c.key] || { b: 0, c: 0, g: 1 };
  S.layerUI.composite = { visible: false };
  S.active = anyDraft ? '초벌_membrane_mask' : 'membrane_mask_gt';
  $('folder-info').innerHTML = `<b>${esc(label)}</b> · 세트 ${S.sets.length}개` + (S.edited.size ? ` · 수정본 ${S.edited.size}개 발견` : '') +
    (S.dir ? '' : ' · <span title="이 브라우저는 폴더에 직접 쓰지 못해 다운로드로 저장합니다">저장=다운로드</span>');
  $('set-select').innerHTML = S.sets.map((s, i) => `<option value="${i}">${esc(s)}</option>`).join('');
  $('empty').hidden = true; $('work').hidden = false;
  await goSet(0, true);
  await loadComments(label);
  await loadLinks(label);
}

async function loadSet(name) {
  if (S.cache.has(name)) return S.cache.get(name);
  const d = { name, w: 0, h: 0, ch: {}, masks: {}, composite: null };
  for (const c of CHANNELS) {
    const f = S.files.get(`${name}_${c.key}.tif`) || S.files.get(`${name}_${c.key}.tiff`);
    if (!f) continue;
    const t = await readTiff(f); d.w = t.w; d.h = t.h;
    d.ch[c.key] = { data: t.data, base: percentiles(t.data, 0.01, 0.998), max: maxOf(t.data) };
  }
  for (const m of MASKS) {
    const fn = `${name}_${m.key}.tif`, orig = S.files.get(fn), ed = S.edited.get(fn);
    if (!orig && !ed) continue;
    const t = await readTiff(ed || orig);
    if (!d.w) { d.w = t.w; d.h = t.h; }
    const data = Uint32Array.from(t.data);
    d.masks[m.key] = { data, opened: data.slice(), hist: [], fut: [], dirty: false, fromEdited: !!ed, cent: null, canvas: null, stale: true };
  }
  const png = S.files.get(`${name}_composite.png`);
  if (png) try { d.composite = await createImageBitmap(await asFile(png)); } catch { /* 합성 이미지는 없어도 됨 */ }
  d.base = document.createElement('canvas'); d.base.width = d.w; d.base.height = d.h; d.baseStale = true;
  S.cache.set(name, d);
  return d;
}

async function goSet(i, fit) {
  if (i < 0 || i >= S.sets.length) return;
  cancelVertex(); S.poly = null;
  S.idx = i; $('set-select').value = i;
  msg('불러오는 중…');
  S.cur = await loadSet(S.sets[i]);
  if (!S.cur.masks[S.active]) S.active = Object.keys(S.cur.masks).find((k) => S.layerUI[k].visible) || Object.keys(S.cur.masks)[0] || null;
  for (const c of CHANNELS) if (S.cur.ch[c.key]) S.cur.baseStale = true;
  if (fit) fitView();
  R.sel = null; renderReviewPanel();
  L.sel = null; L.pending = null; renderLinkPanel();
  buildLayers(); updateInfo(); syncLabelUI(); msg('');
  draw();
}

async function saveAll() {
  const jobs = [];
  for (const d of S.cache.values()) for (const [k, m] of Object.entries(d.masks)) if (m.dirty) jobs.push([d, k, m]);
  if (!jobs.length) { msg('저장할 수정 사항이 없습니다.'); return; }
  try {
    if (S.dir) {
      if ((await S.dir.requestPermission({ mode: 'readwrite' })) !== 'granted') { msg('폴더 쓰기 권한이 없어 저장하지 못했습니다.'); return; }
      const sub = await S.dir.getDirectoryHandle(SAVE_DIR, { create: true });
      for (const [d, k, m] of jobs) {
        const fn = `${d.name}_${k}.tif`, fh = await sub.getFileHandle(fn, { create: true });
        const w = await fh.createWritable(); await w.write(writeTiff(m.data, d.w, d.h)); await w.close();
        S.edited.set(fn, fh); m.dirty = false; m.fromEdited = true;
      }
      msg(`${jobs.length}개 마스크를 ${S.dir.name}/${SAVE_DIR}/ 에 저장했습니다.`);
    } else {
      for (const [d, k, m] of jobs) {
        const a = document.createElement('a'); a.href = URL.createObjectURL(writeTiff(m.data, d.w, d.h));
        a.download = `${d.name}_${k}.tif`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        m.dirty = false; await new Promise((r) => setTimeout(r, 300));
      }
      msg(`${jobs.length}개 마스크를 다운로드했습니다. 폴더 안 ${SAVE_DIR}/ 에 넣으면 다음에 이어서 열립니다.`);
    }
  } catch (e) { console.error(e); msg('저장 실패: ' + e.message); }
  buildLayers(); updateInfo();
}

// ───────────────────────── 계산 도우미 ─────────────────────────
function maxOf(a) { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
function percentiles(a, p1, p2) {
  const step = Math.max(1, Math.floor(a.length / 200000)), s = [];
  for (let i = 0; i < a.length; i += step) s.push(a[i]);
  s.sort((x, y) => x - y);
  return [s[Math.floor(p1 * (s.length - 1))], s[Math.floor(p2 * (s.length - 1))]];
}
function channelRange(key, d = S.cur) {
  const c = d.ch[key], a = S.adjust[key], [lo, hi] = c.base;
  const center = (lo + hi) / 2 - (a.b / 100) * (hi - lo) / 2;       // 밝기 ↑ = 표시 범위를 아래로
  const width = Math.max((hi - lo) * Math.pow(2, -2 * a.c / 100), 1); // 대비 ↑ = 표시 범위를 좁게
  return [center - width / 2, center + width / 2];
}
function hsl(h, s, l) {
  const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
function labelColor(id) {
  let c = S.colors.get(id);
  if (!c) { c = hsl(((id * 0.6180339887) + S.shuffle * 0.2137) % 1, 0.75, 0.56); S.colors.set(id, c); }
  return c;
}
const activeMask = () => (S.cur && S.active ? S.cur.masks[S.active] : null);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ───────────────────────── 그리기 ─────────────────────────
function renderBase(d) {
  const ctxb = d.base.getContext('2d'), img = ctxb.createImageData(d.w, d.h), px = img.data, n = d.w * d.h;
  const acc = new Float32Array(n * 3);
  for (const c of CHANNELS) {
    const ch = d.ch[c.key]; if (!ch || !S.layerUI[c.key].visible) continue;
    const [lo, hi] = channelRange(c.key), g = S.adjust[c.key].g, size = Math.min(ch.max, 65535) + 1;
    const lut = new Float32Array(size);
    for (let v = 0; v < size; v++) { const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo))); lut[v] = Math.pow(t, g); }
    const [r, gg, b] = c.color, a = ch.data;
    for (let i = 0; i < n; i++) { const t = lut[a[i]] ?? 1; acc[i * 3] += t * r; acc[i * 3 + 1] += t * gg; acc[i * 3 + 2] += t * b; }
  }
  for (let i = 0; i < n; i++) { px[i * 4] = acc[i * 3]; px[i * 4 + 1] = acc[i * 3 + 1]; px[i * 4 + 2] = acc[i * 3 + 2]; px[i * 4 + 3] = 255; }
  ctxb.putImageData(img, 0, 0);
  d.baseStale = false;
}

// 외곽선 픽셀 표시: 객체 경계에서 안쪽으로 width 픽셀까지 1 (경계 = 상하좌우 이웃 중 번호가 다른 픽셀이 있음)
function edgeMap(a, w, h, width = 1) {
  const e = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = a[i];
    if (v && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || a[i - 1] !== v || a[i + 1] !== v || a[i - w] !== v || a[i + w] !== v)) e[i] = 1;
  }
  for (let t = 2; t <= width; t++) {  // 같은 객체 안쪽으로 한 겹씩 두껍게
    const add = [];
    for (let i = 0; i < a.length; i++) {
      const v = a[i]; if (!v || e[i]) continue;
      const x = i % w;
      if ((x > 0 && e[i - 1] === t - 1 && a[i - 1] === v) || (x < w - 1 && e[i + 1] === t - 1 && a[i + 1] === v) ||
          (i >= w && e[i - w] === t - 1 && a[i - w] === v) || (i + w < a.length && e[i + w] === t - 1 && a[i + w] === v)) add.push(i);
    }
    for (const i of add) e[i] = t;
  }
  return e;
}

function renderMask(d, key, only = null) {  // only: 이 번호들만 그린다 (선택 세포만 보기)
  const m = d.masks[key], ui = S.layerUI[key], w = d.w, h = d.h, a = m.data, prop = only ? 'soloCanvas' : 'canvas';
  if (!m[prop]) { m[prop] = document.createElement('canvas'); m[prop].width = w; m[prop].height = h; }
  const c2 = m[prop].getContext('2d'), img = c2.createImageData(w, h), px = img.data;
  const alpha = Math.round(255 * ui.opacity), contour = ui.contour, edge = contour ? edgeMap(a, w, h, ui.width || 1) : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = a[i];
    if (!v || (contour && !edge[i]) || (only && !only.has(v))) continue;
    const col = labelColor(v), o = i * 4;
    px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = contour ? 255 : alpha;
  }
  c2.putImageData(img, 0, 0);
  if (!only) m.stale = false;
  return m[prop];
}

// 선택 세포만 보기: {마스크 key → 보일 번호들}. 같은 그룹(초벌/정답)의 짝(세포↔핵)도 함께 보인다.
function soloIds(d) {
  let key = S.active, label = S.label;
  if (S.mode === 'review' && typeof R !== 'undefined' && R.sel?.label) { key = R.sel.key; label = R.sel.label; }
  const out = new Map(); if (!key || !label || !d.masks[key]) return out;
  out.set(key, new Set([label]));
  const def = MASKS.find((m) => m.key === key), g = def.draft ? '초벌' : '정답', lk = computeLinks(d, g);
  if (lk) {
    if (def.kind === 'membrane') out.set(lk.nk, new Set(lk.cells.get(label)?.nuclei || []));
    else { const c = lk.nuclei.get(label)?.cell; if (c) { out.set(lk.ck, new Set([c])); out.set(lk.nk, new Set(lk.cells.get(c)?.nuclei || [label])); } }
  }
  return out;
}
function toggleMasks() {
  S.masksHidden = !S.masksHidden; $('btn-masks').classList.toggle('on', S.masksHidden);
  msg(S.masksHidden ? '마스크 숨김 — Space를 한 번 더 누르면 다시 보입니다' : '마스크 보이기'); draw();
}
function toggleSolo() {
  S.solo = !S.solo; $('btn-solo').classList.toggle('on', S.solo);
  msg(S.solo ? '선택 세포만 보기 — 세포를 클릭해 고르세요 (이동 도구에서 클릭, 다른 도구는 스포이트 L)' : '전체 세포 보기'); draw();
}

function centroids(m, w) {
  const acc = new Map(), a = m.data;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (!v) continue; let e = acc.get(v); if (!e) acc.set(v, e = [0, 0, 0]); e[0] += i % w; e[1] += (i / w) | 0; e[2]++; }
  m.cent = [...acc].map(([id, [sx, sy, n]]) => [id, sx / n + 0.5, sy / n + 0.5]);
}

let drawQueued = false;
function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawNow); } }
function drawNow() {
  drawQueued = false;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const d = S.cur; if (!d) return;
  const { s, tx, ty } = S.view;
  ctx.imageSmoothingEnabled = false;
  if (S.layerUI.composite.visible && d.composite) ctx.drawImage(d.composite, tx, ty, d.w * s, d.h * s);
  else { if (d.baseStale) renderBase(d); ctx.drawImage(d.base, tx, ty, d.w * s, d.h * s); }
  const solo = S.solo && !S.masksHidden ? soloIds(d) : null;
  if (!S.masksHidden) for (const mdef of MASKS) {
    const m = d.masks[mdef.key]; if (!m || !S.layerUI[mdef.key].visible) continue;
    if (solo) {  // 선택 세포만: 이 마스크에서 보일 번호가 없으면 건너뜀
      const only = solo.get(mdef.key); if (!only || !only.size) continue;
      const tag = `${[...only]}|${m.hist.length}|${m.fut.length}|${S.layerUI[mdef.key].opacity}|${S.layerUI[mdef.key].contour}|${S.layerUI[mdef.key].width}|${S.shuffle}`;
      if (m.soloTag !== tag || m.stale) { renderMask(d, mdef.key, only); m.soloTag = tag; }
      ctx.drawImage(m.soloCanvas, tx, ty, d.w * s, d.h * s); continue;
    }
    if (m.stale) renderMask(d, mdef.key);
    ctx.drawImage(m.canvas, tx, ty, d.w * s, d.h * s);
  }
  const am = activeMask();
  if (S.showNumbers && am && S.layerUI[S.active].visible && !S.masksHidden && !solo) {
    if (!am.cent) centroids(am, d.w);
    ctx.font = '600 12px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.fillStyle = '#fff';
    for (const [id, cx, cy] of am.cent) { const X = tx + cx * s, Y = ty + cy * s; if (X < -20 || Y < -20 || X > W + 20 || Y > H + 20) continue; ctx.strokeText(id, X, Y); ctx.fillText(id, X, Y); }
  }
  if (S.poly && S.poly.length) {  // 그리는 중인 폴리곤
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.5; ctx.beginPath();
    S.poly.forEach(([x, y], k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, tx + x * s, ty + y * s));
    if (S.mouse) ctx.lineTo(tx + S.mouse.ix * s, ty + S.mouse.iy * s);
    ctx.stroke();
    ctx.fillStyle = '#ffd166'; for (const [x, y] of S.poly) ctx.fillRect(tx + x * s - 2.5, ty + y * s - 2.5, 5, 5);
  }
  if (S.vx) {  // 꼭짓점 편집 중인 도형
    const P = S.vx.pts;
    ctx.fillStyle = 'rgba(255,230,0,.12)'; ctx.strokeStyle = '#ffe600'; ctx.lineWidth = 1.5; ctx.beginPath();
    P.forEach(([x, y], k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, tx + x * s, ty + y * s)); ctx.closePath(); ctx.fill(); ctx.stroke();
    for (let k = 0; k < P.length; k++) { const X = tx + P[k][0] * s, Y = ty + P[k][1] * s;
      ctx.fillStyle = k === S.vx.hover ? '#ff5d5d' : '#ffe600'; ctx.fillRect(X - 3.5, Y - 3.5, 7, 7); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(X - 3.5, Y - 3.5, 7, 7); }
  }
  drawLinkOverlay(ctx);    // 세포막↔세포핵 연결선·선택 (link.js)
  drawReviewOverlay(ctx);  // 검수 코멘트 번호·선택 객체 (review.js)
  if (S.mouse && (S.tool === 'brush' || S.tool === 'eraser') && !S.space) {  // 붓 크기 표시
    ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.arc(S.mouse.sx, S.mouse.sy, Math.max(1, (S.brush / 2) * s), 0, Math.PI * 2); ctx.stroke();
  }
}

function fitView() {
  const d = S.cur; if (!d) return;
  const W = cv.clientWidth, H = cv.clientHeight, s = Math.min(W / d.w, H / d.h) * 0.95;
  S.view = { s, tx: (W - d.w * s) / 2, ty: (H - d.h * s) / 2 };
  draw();
}

// ───────────────────────── 편집 기록 (되돌리기) ─────────────────────────
function beginEdit(m) { m.snap = m.data.slice(); }
function endEdit(m) {
  const a = m.data, b = m.snap; m.snap = null; if (!b) return 0;
  let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  if (!n) return 0;
  const idx = new Int32Array(n), before = new Uint32Array(n), after = new Uint32Array(n);
  for (let i = 0, k = 0; i < a.length; i++) if (a[i] !== b[i]) { idx[k] = i; before[k] = b[i]; after[k] = a[i]; k++; }
  m.hist.push({ idx, before, after }); if (m.hist.length > 100) m.hist.shift(); m.fut = [];
  maskChanged(m); return n;
}
function maskChanged(m) { m.dirty = true; m.stale = true; m.cent = null; updateDirty(); linkStale(); draw(); }
function undo(redo) {
  const m = activeMask(); if (!m) return;
  const e = (redo ? m.fut : m.hist).pop(); if (!e) { msg(redo ? '다시 실행할 것이 없습니다.' : '되돌릴 것이 없습니다.'); return; }
  const vals = redo ? e.after : e.before;
  for (let k = 0; k < e.idx.length; k++) m.data[e.idx[k]] = vals[k];
  (redo ? m.hist : m.fut).push(e);
  maskChanged(m); msg(redo ? '다시 실행' : '되돌리기');
}

// ───────────────────────── 편집 도구 ─────────────────────────
function canWrite(m, i, label) { return !S.preserve || label === 0 || m.data[i] === 0 || m.data[i] === label; }
function paintDisc(m, cx, cy, label) {
  const d = S.cur, r = S.brush / 2, r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(d.w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(d.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    if (dx * dx + dy * dy <= r2 || (r < 1 && x === Math.floor(cx) && y === Math.floor(cy))) { const i = y * d.w + x; if (canWrite(m, i, label)) m.data[i] = label; }
  }
}
function paintLine(m, a, b, label) {
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]), step = Math.max(0.5, S.brush / 4), n = Math.ceil(dist / step);
  for (let k = 0; k <= n; k++) { const t = n ? k / n : 0; paintDisc(m, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, label); }
  m.stale = true; m.cent = null; draw();
}
function floodFill(m, x, y, label) {
  const d = S.cur, w = d.w, h = d.h, a = m.data, start = y * w + x, target = a[start];
  if (target === label) return;
  const stack = [start]; a[start] = label;
  while (stack.length) {
    const i = stack.pop(), px = i % w, py = (i / w) | 0;
    if (px > 0 && a[i - 1] === target) { a[i - 1] = label; stack.push(i - 1); }
    if (px < w - 1 && a[i + 1] === target) { a[i + 1] = label; stack.push(i + 1); }
    if (py > 0 && a[i - w] === target) { a[i - w] = label; stack.push(i - w); }
    if (py < h - 1 && a[i + w] === target) { a[i + w] = label; stack.push(i + w); }
  }
}
function rasterPolygon(P, w, h, cb) {  // 픽셀 중심(+0.5)이 다각형 안이면 cb(i)
  let y0 = Infinity, y1 = -Infinity; for (const p of P) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(h - 1, Math.ceil(y1));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5, xs = [];
    for (let k = 0, j = P.length - 1; k < P.length; j = k++) {
      const [xa, ya] = P[j], [xb, yb] = P[k];
      if ((ya <= yc) !== (yb <= yc)) xs.push(xa + (yc - ya) / (yb - ya) * (xb - xa));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) cb(y * w + x);
    }
  }
}
function finishPolygon() {
  const m = activeMask(); if (!m || !S.poly || S.poly.length < 3) { S.poly = null; draw(); return; }
  const label = S.label; beginEdit(m);
  rasterPolygon(S.poly, S.cur.w, S.cur.h, (i) => { if (canWrite(m, i, label)) m.data[i] = label; });
  const n = endEdit(m); S.poly = null; msg(`폴리곤 적용 (${n}픽셀)`); draw();
}
function newLabel() {
  const m = activeMask(); if (!m) return;
  setLabel(maxOf(m.data) + 1); msg(`새 번호 ${S.label}`);
}
function setLabel(v) {
  v = Math.max(0, Math.floor(Number(v) || 0));
  if (v !== 0) S.lastLabel = v;
  S.label = v; syncLabelUI();
}
function swapLabel() { setLabel(S.label === 0 ? S.lastLabel : 0); msg(S.label === 0 ? '번호 0 (지우기)' : `번호 ${S.label}`); }

// ── 꼭짓점 편집: 세포 하나의 외곽선을 다각형으로 바꿔 점을 끌어 고친 뒤 마스크에 반영 ──
function pieceAt(m, x, y) {  // (x,y)가 속한 같은 번호의 4-연결 조각
  const d = S.cur, w = d.w, h = d.h, a = m.data, label = a[y * w + x], inP = new Uint8Array(w * h), list = [];
  const stack = [y * w + x]; inP[y * w + x] = 1;
  while (stack.length) {
    const i = stack.pop(); list.push(i); const px = i % w, py = (i / w) | 0;
    for (const j of [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, py > 0 ? i - w : -1, py < h - 1 ? i + w : -1])
      if (j >= 0 && !inP[j] && a[j] === label) { inP[j] = 1; stack.push(j); }
  }
  return { label, inP, list };
}
function outline(inP, w, h) {  // 픽셀 경계선을 따라 바깥 외곽선(모서리 좌표) 추적
  const W1 = w + 1, out = new Map(), add = (x0, y0, x1, y1) => { const k = y0 * W1 + x0; (out.get(k) || out.set(k, []).get(k)).push(y1 * W1 + x1); };
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && inP[y * w + x];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inP[y * w + x]) continue;
    if (!on(x, y - 1)) add(x, y, x + 1, y);
    if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!on(x - 1, y)) add(x, y + 1, x, y);
  }
  const loops = [];
  for (const [startK] of out) {
    if (!out.get(startK)?.length) continue;
    const loop = []; let k = startK, prev = null;
    for (let guard = 0; guard < 4 * w * h; guard++) {
      const list = out.get(k); if (!list || !list.length) break;
      let pick = 0;
      if (list.length > 1 && prev !== null) {  // 갈림길: 오른쪽으로 꺾는 쪽 우선
        const px = prev % W1, py = (prev / W1) | 0, cx = k % W1, cy = (k / W1) | 0, dx = cx - px, dy = cy - py;
        pick = list.findIndex((n) => { const nx = n % W1 - cx, ny = ((n / W1) | 0) - cy; return dx * ny - dy * nx > 0; });
        if (pick < 0) pick = 0;
      }
      const nk = list.splice(pick, 1)[0];
      loop.push([k % W1, (k / W1) | 0]); prev = k; k = nk;
      if (k === startK) break;
    }
    if (loop.length > 2) loops.push(loop);
  }
  const area = (L) => { let s = 0; for (let i = 0, j = L.length - 1; i < L.length; j = i++) s += (L[j][0] * L[i][1] - L[i][0] * L[j][1]); return Math.abs(s / 2); };
  return loops.sort((p, q) => area(q) - area(p))[0] || [];
}
function simplify(P, tol) {  // 닫힌 외곽선 Douglas–Peucker
  if (P.length < 8) return P;
  const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  const dp = (pts) => { let md = 0, mi = 0; for (let i = 1; i < pts.length - 1; i++) { const dd = segDist(pts[i], pts[0], pts[pts.length - 1]); if (dd > md) { md = dd; mi = i; } }
    return md > tol ? dp(pts.slice(0, mi + 1)).slice(0, -1).concat(dp(pts.slice(mi))) : [pts[0], pts[pts.length - 1]]; };
  let far = 0, fd = 0; for (let i = 1; i < P.length; i++) { const dd = Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]); if (dd > fd) { fd = dd; far = i; } }
  const a = dp(P.slice(0, far + 1)), b = dp(P.slice(far).concat([P[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}
function startVertex(x, y) {
  const m = activeMask(); if (!m) return;
  if (!m.data[y * S.cur.w + x]) { vxStatus('배경을 클릭했습니다. 세포 안쪽을 클릭하세요.'); return; }
  const pc = pieceAt(m, x, y), P = simplify(outline(pc.inP, S.cur.w, S.cur.h), Number($('vx-density').value));
  if (P.length < 3) { vxStatus('이 세포는 너무 작아 꼭짓점 편집을 할 수 없습니다.'); return; }
  S.vx = { key: S.active, label: pc.label, list: pc.list, inP: pc.inP, pts: P, start: P.map((p) => p.slice()), hover: -1 };
  $('vx-apply').disabled = $('vx-cancel').disabled = false;
  vxStatus(`<b>${pc.label}번</b> 세포 편집 중 · 점 ${P.length}개<br>점 끌기 = 이동 · Shift+선 클릭 = 점 추가 · Alt+점 클릭 = 점 삭제<br>Enter = 적용 · Esc = 취소`);
  draw();
}
function applyVertex() {
  const v = S.vx; if (!v) return;
  // 처음 도형과 고친 도형의 차이만 반영 — 건드리지 않은 테두리는 원래 픽셀 그대로 남는다
  const m = S.cur.masks[v.key], label = v.label, protect = $('vx-protect').checked, w = S.cur.w, h = S.cur.h;
  const was = new Uint8Array(w * h), now = new Uint8Array(w * h);
  rasterPolygon(v.start, w, h, (i) => (was[i] = 1));
  rasterPolygon(v.pts, w, h, (i) => (now[i] = 1));
  beginEdit(m);
  for (let i = 0; i < was.length; i++) {
    if (now[i] && !was[i]) { if (!protect || m.data[i] === 0 || m.data[i] === label) m.data[i] = label; }
    else if (was[i] && !now[i] && v.inP[i]) m.data[i] = 0;
  }
  const n = endEdit(m); cancelVertex(true);
  vxStatus(`${label}번 세포에 적용했습니다 (${n}픽셀 변경). 되돌리기: Cmd/Ctrl+Z`);
}
function cancelVertex(silent) {
  if (!S.vx) return; S.vx = null; $('vx-apply').disabled = $('vx-cancel').disabled = true;
  if (!silent) vxStatus('편집을 취소했습니다. 마스크는 그대로입니다.');
  draw();
}
function vxStatus(h) { $('vx-status').innerHTML = h; }
function nearestVertex(sx, sy) {
  const { s, tx, ty } = S.view; let best = -1, bd = 8;
  S.vx.pts.forEach(([x, y], k) => { const dd = Math.hypot(tx + x * s - sx, ty + y * s - sy); if (dd < bd) { bd = dd; best = k; } });
  return best;
}
function nearestEdge(ix, iy) {
  const P = S.vx.pts; let best = -1, bd = Infinity, bp = null;
  for (let k = 0; k < P.length; k++) {
    const a = P[k], b = P[(k + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((ix - a[0]) * dx + (iy - a[1]) * dy) / L)), qx = a[0] + t * dx, qy = a[1] + t * dy, dd = Math.hypot(ix - qx, iy - qy);
    if (dd < bd) { bd = dd; best = k; bp = [qx, qy]; }
  }
  return bd * S.view.s < 10 ? { k: best, p: bp } : null;
}

// ───────────────────────── 마우스 ─────────────────────────
function toImage(e) {
  const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, { s, tx, ty } = S.view;
  return { sx, sy, ix: (sx - tx) / s, iy: (sy - ty) / s };
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  if (!S.cur) return;
  const p = toImage(e); S.mouse = p; cv.setPointerCapture(e.pointerId);
  const px = Math.floor(p.ix), py = Math.floor(p.iy), inside = px >= 0 && py >= 0 && px < S.cur.w && py < S.cur.h;
  if (S.mode === 'review' && e.button === 0 && !S.space) {  // 검수: 클릭 = 객체 선택, 끌기 = 화면 이동
    S.drag = { type: 'rv', sx: p.sx, sy: p.sy, tx: S.view.tx, ty: S.view.ty, moved: false, p, px, py, inside }; return;
  }
  if (S.space) S.spaceUsed = true;
  if (e.button === 2 || e.button === 1 || S.space || (e.button === 0 && S.tool === 'pan')) {
    S.drag = { type: 'pan', sx: p.sx, sy: p.sy, tx: S.view.tx, ty: S.view.ty, pick: e.button === 0 && !S.space && S.tool === 'pan', px, py, inside };
    cv.style.cursor = 'grabbing'; return;
  }
  if (e.button !== 0 || S.mode === 'review') return;
  const m = activeMask();
  if (S.tool === 'link') { linkClick(px, py, inside); return; }
  if (S.tool === 'vertex') {
    if (S.vx) {
      if (e.shiftKey) { const ed = nearestEdge(p.ix, p.iy); if (ed) { S.vx.pts.splice(ed.k + 1, 0, ed.p); S.drag = { type: 'vertex', k: ed.k + 1 }; draw(); } return; }
      const k = nearestVertex(p.sx, p.sy);
      if (k >= 0 && e.altKey) { if (S.vx.pts.length > 3) S.vx.pts.splice(k, 1); draw(); return; }
      if (k >= 0) S.drag = { type: 'vertex', k };
      return;
    }
    if (inside && m) startVertex(px, py);
    return;
  }
  if (!m) { msg('편집할 마스크가 없습니다.'); return; }
  if (!S.layerUI[S.active].visible) { S.layerUI[S.active].visible = true; buildLayers(); }
  if (S.tool === 'brush' || S.tool === 'eraser') {
    const label = S.tool === 'eraser' ? 0 : S.label;
    beginEdit(m); paintLine(m, [p.ix, p.iy], [p.ix, p.iy], label);
    S.drag = { type: 'paint', last: [p.ix, p.iy], label, m };
  } else if (S.tool === 'fill' && inside) {
    beginEdit(m); floodFill(m, px, py, S.label); const n = endEdit(m); msg(`채우기 (${n}픽셀)`);
  } else if (S.tool === 'picker' && inside) {
    setLabel(m.data[py * S.cur.w + px]); msg(`번호 ${S.label} 선택`);
  } else if (S.tool === 'polygon') {
    (S.poly = S.poly || []).push([p.ix, p.iy]); draw();
  }
});
cv.addEventListener('pointermove', (e) => {
  if (!S.cur) return;
  const p = toImage(e); S.mouse = p; updateStatus(p);
  const dr = S.drag;
  if (dr?.type === 'rv' && !dr.moved && Math.hypot(p.sx - dr.sx, p.sy - dr.sy) > 4) { dr.moved = true; cv.style.cursor = 'grabbing'; }
  if (dr?.type === 'pan' || dr?.moved) { S.view.tx = dr.tx + p.sx - dr.sx; S.view.ty = dr.ty + p.sy - dr.sy; draw(); return; }
  if (dr?.type === 'paint') { paintLine(dr.m, dr.last, [p.ix, p.iy], dr.label); dr.last = [p.ix, p.iy]; return; }
  if (dr?.type === 'vertex') { S.vx.pts[dr.k] = [Math.max(0, Math.min(S.cur.w, p.ix)), Math.max(0, Math.min(S.cur.h, p.iy))]; draw(); return; }
  if (S.vx) { const k = nearestVertex(p.sx, p.sy); if (k !== S.vx.hover) S.vx.hover = k; }
  draw();
});
const endDrag = () => {
  const dr = S.drag; S.drag = null; cv.style.cursor = '';
  if (dr?.type === 'paint') endEdit(dr.m);
  if (dr?.type === 'rv' && !dr.moved) reviewClick(dr.p, dr.px, dr.py, dr.inside);
  if (dr?.type === 'pan' && dr.pick && S.solo && dr.inside && Math.abs(S.view.tx - dr.tx) + Math.abs(S.view.ty - dr.ty) < 3) {
    const m = activeMask(); if (m) { setLabel(m.data[dr.py * S.cur.w + dr.px]); msg(S.label ? `${S.label}번 세포만 보기` : '배경을 클릭했습니다 — 세포를 클릭하세요'); draw(); }
  }
};
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('pointerleave', () => { S.mouse = null; draw(); });
cv.addEventListener('dblclick', (e) => {
  if (S.mode === 'review') { reviewDblClick(toImage(e)); return; }
  if (S.tool !== 'polygon' || !S.poly) return;
  S.poly.pop();  // 더블클릭으로 들어간 중복 점 제거
  finishPolygon();
});
cv.addEventListener('wheel', (e) => {
  if (!S.cur) return; e.preventDefault();
  const p = toImage(e), f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), v = S.view;
  const s = Math.min(80, Math.max(0.05, v.s * f)), k = s / v.s;
  S.view = { s, tx: p.sx - (p.sx - v.tx) * k, ty: p.sy - (p.sy - v.ty) * k }; draw();
}, { passive: false });
new ResizeObserver(() => draw()).observe(cv);

// ───────────────────────── 키보드 ─────────────────────────
const TOOL_KEYS = { 1: 'eraser', e: 'eraser', 2: 'brush', p: 'brush', 3: 'polygon', 4: 'fill', f: 'fill', 5: 'picker', l: 'picker', 6: 'pan', z: 'pan', v: 'vertex', k: 'link' };
document.addEventListener('keydown', (e) => {
  if (!S.cur || (e.target instanceof Element && e.target.matches('input[type=number], select'))) return;
  const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
  if (S.mode === 'review') {  // 검수 모드: 마스크를 바꾸는 단축키는 막고 검수 단축키를 먼저 처리
    if (!mod && reviewKey(e)) return;
    if (mod && (k === 'z' || k === 'y' || k === 's')) { e.preventDefault(); return; }
    if (!mod && (TOOL_KEYS[k] || 'xm[]bc'.includes(k) || e.key === 'Enter' || e.key === 'Backspace')) return;
  }
  if (mod && k === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
  if (mod && k === 'y') { e.preventDefault(); undo(true); return; }
  if (mod && k === 's') { e.preventDefault(); saveAll(); return; }
  if (mod) return;
  if (e.key === ' ') { if (!S.space) { S.space = true; S.spaceAt = performance.now(); S.spaceUsed = false; cv.style.cursor = 'grab'; draw(); } e.preventDefault(); return; }
  if (k === 'o') { toggleSolo(); return; }
  if (e.key === 'Enter') { if (S.vx) applyVertex(); else if (S.poly) finishPolygon(); return; }
  if (e.key === 'Escape') { if (S.vx) cancelVertex(); else if (S.poly) { S.poly = null; draw(); } else if (L.pending) { L.pending = null; msg('연결 취소'); draw(); } $('help').hidden = true; return; }
  if (e.key === 'Backspace' && S.poly) { S.poly.pop(); draw(); return; }
  if (e.key === 'Tab') { e.preventDefault(); toggleKind(); return; }
  if (TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
  if (k === 'x') swapLabel();
  else if (k === 'm') newLabel();
  else if (k === '[') setBrush(S.brush - 1);
  else if (k === ']') setBrush(S.brush + 1);
  else if (k === 'b') { S.preserve = !S.preserve; $('preserve').checked = S.preserve; msg(`옆 세포 침범 안 함: ${S.preserve ? '켬' : '끔'}`); }
  else if (k === 'n') { S.showNumbers = !S.showNumbers; $('show-numbers').checked = $('show-numbers-rv').checked = S.showNumbers; draw(); }
  else if (k === 'c' && S.active) { const u = S.layerUI[S.active]; u.contour = !u.contour; activeMask().stale = true; buildLayers(); draw(); }
  else if (k === ',') goSet(S.idx - 1);
  else if (k === '.') goSet(S.idx + 1);
  else if (k === '0') fitView();
  else if (k === '?') $('help').hidden = false;
});
document.addEventListener('keyup', (e) => {
  if (e.key !== ' ' || !S.space) return;
  S.space = false; cv.style.cursor = '';
  if (!S.spaceUsed && performance.now() - S.spaceAt < 400 && S.cur) toggleMasks();  // 끌지 않고 짧게 눌렀다 떼면 = 마스크 끄기/켜기
  draw();
});

function setTool(t) {
  if (t !== 'polygon') S.poly = null;
  if (t !== 'vertex') cancelVertex(true);
  if (t !== 'link') L.pending = null;
  S.tool = t;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  draw();
}
function setBrush(v) { S.brush = Math.max(1, Math.min(60, v)); $('brush-size').value = S.brush; $('brush-val').textContent = S.brush; draw(); }
function toggleKind() {  // 같은 종류(초벌/정답)에서 세포막 ↔ 세포핵
  const cur = MASKS.find((m) => m.key === S.active); if (!cur) return;
  const other = MASKS.find((m) => m.draft === cur.draft && m.kind !== cur.kind);
  if (other && S.cur.masks[other.key]) selectActive(other.key);
}
function selectActive(key) {
  cancelVertex(true); S.poly = null; S.active = key; S.layerUI[key].visible = true;
  buildLayers(); updateInfo(); renderLinkPanel(); msg(`편집 대상: ${MASKS.find((m) => m.key === key).name}`); draw();
}

// ───────────────────────── 패널 UI ─────────────────────────
function buildLayers() {
  const d = S.cur, ul = $('layers'); ul.innerHTML = '';
  const rows = [...MASKS].reverse().filter((m) => d.masks[m.key]).map((m) => ({ ...m, mask: true }))
    .concat(CHANNELS.filter((c) => d.ch[c.key]).map((c) => ({ ...c, mask: false })));
  if (d.composite) rows.push({ key: 'composite', name: '합성 이미지 (PNG)', mask: false });
  for (const r of rows) {
    const ui = S.layerUI[r.key], li = document.createElement('li'), m = d.masks[r.key];
    li.className = (r.mask ? 'mask' : '') + (r.key === S.active ? ' active' : '');
    li.innerHTML = `<div class="lhead"><span class="eye ${ui.visible ? '' : 'off'}" title="보이기/숨기기">👁</span>
      <span class="lname">${esc(r.name)}</span>${m ? `<span class="dirty">${m.dirty ? '● 수정됨' : m.fromEdited ? '수정본' : ''}</span>` : ''}</div>` +
      (r.mask ? `<div class="lctl"><span class="muted">투명도</span><input type="range" min="0.05" max="1" step="0.05" value="${ui.opacity}">
        <button title="외곽선 ↔ 채움 (C)">${ui.contour ? '외곽선' : '채움'}</button></div>` +
        (ui.contour ? `<div class="lctl"><span class="muted">두께</span><input class="lwidth" type="range" min="1" max="6" step="1" value="${ui.width}"><span class="wval">${ui.width}px</span></div>` : '') : '');
    if (!r.mask && r.key !== 'composite') {
      li.classList.add('chan');
      const a = S.adjust[r.key], changed = a.b || a.c || a.g !== 1;
      li.querySelector('.lhead').insertAdjacentHTML('beforeend', `<span class="muted adj-hint">${changed ? '밝기 조정됨' : '밝기 ▾'}</span>`);
      li.appendChild(channelAdjust(r.key));
    }
    li.querySelector('.eye').onclick = () => { ui.visible = !ui.visible; if (!r.mask) d.baseStale = true; buildLayers(); draw(); };
    if (r.mask) {
      li.querySelector('.lname').onclick = () => selectActive(r.key);
      li.querySelector('input').oninput = (ev) => { ui.opacity = Number(ev.target.value); m.stale = true; draw(); };
      li.querySelector('button').onclick = () => { ui.contour = !ui.contour; m.stale = true; buildLayers(); draw(); };
      const wIn = li.querySelector('.lwidth');
      if (wIn) wIn.oninput = (ev) => { ui.width = Number(ev.target.value); li.querySelector('.wval').textContent = `${ui.width}px`;
        for (const dd of S.cache.values()) if (dd.masks[r.key]) dd.masks[r.key].stale = true; draw(); };
    }
    ul.appendChild(li);
  }
}

// 채널 하나의 밝기·대비·감마 조절 — 레이어 목록의 채널 칸에 마우스를 올리면 펼쳐진다.
// 세트를 넘기면 각 세트의 기준 밝기 범위(1~99.8%)에 같은 설정이 적용된다.
function channelAdjust(key) {
  const a = S.adjust[key], div = document.createElement('div'); div.className = 'adj';
  const sign = (v) => (v > 0 ? '+' : '') + Math.round(v), g2 = (v) => Number(v).toFixed(2);
  const slider = (k, name, min, max, step, fmt) => `<div class="row"><span>${name}</span>
    <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${a[k]}"><span class="val" data-v="${k}">${fmt(a[k])}</span></div>`;
  const render = () => {
    div.innerHTML = slider('b', '밝기', -100, 100, 1, sign) + slider('c', '대비', -100, 100, 1, sign) +
      slider('g', '감마', 0.2, 3, 0.05, g2) + '<button>자동 맞춤 / 초기화</button>';
    div.querySelectorAll('input').forEach((inp) => inp.oninput = () => {
      const k = inp.dataset.k; a[k] = Number(inp.value); div.querySelector(`[data-v="${k}"]`).textContent = (k === 'g' ? g2 : sign)(a[k]);
      if (S.cur) { S.cur.baseStale = true; draw(); }
      hint();
    });
    div.querySelector('button').onclick = () => { Object.assign(a, { b: 0, c: 0, g: 1 }); render(); hint(); if (S.cur) { S.cur.baseStale = true; draw(); } };
  };
  const hint = () => { const h = div.parentElement?.querySelector('.adj-hint'); if (h) h.textContent = a.b || a.c || a.g !== 1 ? '밝기 조정됨' : '밝기 ▾'; };
  render();
  return div;
}

function syncLabelUI() {
  $('label-num').value = S.label;
  const [r, g, b] = S.label ? labelColor(S.label) : [0, 0, 0];
  $('label-swatch').style.background = S.label ? `rgb(${r},${g},${b})` : 'repeating-conic-gradient(#444 0 25%, #222 0 50%) 0 0/8px 8px';
  $('label-swatch').title = S.label ? `${S.label}번 색` : '0 = 배경(지우기)';
}

function updateInfo() {
  const d = S.cur; if (!d) return;
  const lines = [`${S.idx + 1} / ${S.sets.length} · ${d.name}`, `이미지 ${d.w}×${d.h}`];
  for (const m of MASKS) { const mm = d.masks[m.key]; if (!mm) continue;
    const n = new Set(mm.data).size - 1; lines.push(`${m.name} ${n}개${m.key === S.active ? '  ← 편집 대상' : ''}`); }
  $('info').textContent = lines.join('\n');
}

function updateDirty() {
  let n = 0; for (const d of S.cache.values()) for (const m of Object.values(d.masks)) if (m.dirty) n++;
  $('btn-save').disabled = !n; $('save-state').textContent = n ? `수정된 마스크 ${n}개 (저장 안 됨)` : '';
  [...$('set-select').options].forEach((o, i) => { const d = S.cache.get(S.sets[i]);
    const dirty = d && Object.values(d.masks).some((m) => m.dirty); o.textContent = (dirty ? '● ' : '') + S.sets[i]; });
  clearTimeout(updateDirty.t); updateDirty.t = setTimeout(() => { buildLayers(); updateInfo(); }, 300);
}

function updateStatus(p) {
  const d = S.cur, x = Math.floor(p.ix), y = Math.floor(p.iy);
  if (x < 0 || y < 0 || x >= d.w || y >= d.h) { $('sb-pos').textContent = ''; return; }
  const i = y * d.w + x, parts = [`x ${x}, y ${y}`];
  for (const c of CHANNELS) if (d.ch[c.key]) parts.push(`${c.name.replace(' 채널', '')} ${d.ch[c.key].data[i]}`);
  for (const m of MASKS) if (d.masks[m.key] && S.layerUI[m.key].visible) parts.push(`${m.name} #${d.masks[m.key].data[i]}`);
  parts.push(`확대 ${Math.round(S.view.s * 100)}%`);
  $('sb-pos').textContent = parts.join('  ·  ');
}
let msgTimer;
function msg(t) { $('sb-msg').textContent = t; clearTimeout(msgTimer); if (t) msgTimer = setTimeout(() => ($('sb-msg').textContent = ''), 5000); }

// ───────────────────────── 버튼 연결 ─────────────────────────
$('btn-open').onclick = openFolder;
$('dir-input').onchange = (e) => e.target.files.length && loadFromFileList([...e.target.files]);
$('btn-save').onclick = saveAll;
$('btn-help').onclick = () => ($('help').hidden = false);
$('help-close').onclick = () => ($('help').hidden = true);
$('help').onclick = (e) => { if (e.target.id === 'help') $('help').hidden = true; };
document.querySelectorAll('.tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$('btn-undo').onclick = () => undo(false);
$('btn-redo').onclick = () => undo(true);
$('btn-fit').onclick = fitView;
$('btn-masks').onclick = toggleMasks;
$('btn-solo').onclick = toggleSolo;
$('set-select').onchange = (e) => goSet(Number(e.target.value));
$('btn-prev').onclick = () => goSet(S.idx - 1);
$('btn-next').onclick = () => goSet(S.idx + 1);
$('label-num').onchange = (e) => setLabel(e.target.value);
$('btn-new-label').onclick = newLabel;
$('brush-size').oninput = (e) => setBrush(Number(e.target.value));
$('preserve').onchange = (e) => (S.preserve = e.target.checked);
['show-numbers', 'show-numbers-rv'].forEach((id) => ($(id).onchange = (e) => { S.showNumbers = $('show-numbers').checked = $('show-numbers-rv').checked = e.target.checked; draw(); }));
$('btn-shuffle').onclick = () => { S.shuffle++; S.colors.clear(); for (const d of S.cache.values()) for (const m of Object.values(d.masks)) m.stale = true; syncLabelUI(); draw(); };
$('btn-revert').onclick = () => {
  const m = activeMask(); if (!m || !confirm('편집 대상 마스크를 이 폴더에서 열었을 때 상태로 되돌릴까요? (Cmd/Ctrl+Z로 다시 취소 가능)')) return;
  beginEdit(m); m.data.set(m.opened); const n = endEdit(m); msg(`원래대로 되돌렸습니다 (${n}픽셀).`);
};
$('vx-apply').onclick = applyVertex;
$('vx-cancel').onclick = () => cancelVertex();

// 폴더 끌어다 놓기
const empty = $('empty');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); empty.classList.add('drag'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, () => empty.classList.remove('drag')));
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const item = [...e.dataTransfer.items].find((it) => it.kind === 'file');
  if (item?.getAsFileSystemHandle) { const h = await item.getAsFileSystemHandle(); if (h?.kind === 'directory') { await loadFromDirHandle(h); return; } }
  if (e.dataTransfer.files.length) await loadFromFileList([...e.dataTransfer.files]);
});

window.addEventListener('beforeunload', (e) => { for (const d of S.cache.values()) for (const m of Object.values(d.masks)) if (m.dirty) { e.preventDefault(); e.returnValue = ''; return; } });

// 시험·자동화를 위한 진입점
window.cellMaskEditor = { S, loadFromFileList, goSet, setTool, writeTiff, readTiff, startVertex, applyVertex, undo, saveAll };
