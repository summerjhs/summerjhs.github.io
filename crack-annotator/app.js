'use strict';
/* 배포용 정적 균열 어노테이터 — 백엔드 없음.
   섹션 폴더(SUPR 촬영폴더) 선택 → SUPR.JSON 파싱 → 전경격자/갤러리 → 캔버스 어노테이션
   → 선택 폴더의 labels/<stem>.txt (YOLO-seg)에 직접 저장(File System Access). */
const $ = s => document.querySelector(s);
const clamp01 = v => Math.max(0, Math.min(1, v));
const CLASSES = [
  { ko: '균열', en: 'crack', stroke: '#40dcc8', fill: 'rgba(64,220,200,.15)' },
  { ko: '창', en: 'window', stroke: '#4d9bff', fill: 'rgba(77,155,255,.16)' },
  { ko: '기타하자', en: 'defect', stroke: '#c77dff', fill: 'rgba(199,125,255,.16)' },
];
const clsInfo = c => CLASSES[c] || CLASSES[0];
const stemOf = f => f.replace(/\.[^.]+$/, '');
const msg = t => { const e = $('#sb-msg'); if (e) e.textContent = t || ''; };

// ===== 폴더/파일 (File System Access) =====
const F = { dir: null, labels: null, files: {}, urls: {} };
let SEC = null;   // {region,row_num,col_num,teles:[{sub,file,row,col,n_inst,annotated,polys}],w_image,dirName}
let viewMode = 'overlay';

function setInfo(html, err) {
  const e = $('#sec-info'); if (e) e.innerHTML = err ? `<span style="color:#ff8a8a">${html}</span>` : html;
}
async function openFolder() {
  if (!window.showDirectoryPicker) {
    setInfo('이 브라우저는 폴더 접근(File System Access) 미지원 — Chrome/Edge로 열어주세요.', true); return;
  }
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
  catch (e) {
    if (e && e.name === 'AbortError') return;                 // 사용자 취소
    setInfo('폴더 열기 실패: ' + (e && e.message) + ' — https 또는 localhost에서 열어야 합니다(file:// 직접 열기 불가).', true);
    return;
  }
  try {
    F.dir = dir; F.files = {}; F.urls = {}; F.labels = null;
    let jsonName = null, nf = 0, nd = 0;
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file') { F.files[name] = h; nf++; if (/_0000_SUPR\.JSON$/i.test(name)) jsonName = name; }
      else nd++;
    }
    if (!jsonName) {
      setInfo(`SUPR 매니페스트(*_0000_SUPR.JSON) 없음 (파일 ${nf}·폴더 ${nd}). SUPR 촬영(섹션) 폴더를 선택하세요.`, true); return;
    }
    parseSection(JSON.parse(await (await F.files[jsonName].getFile()).text()), dir.name);
    // 이미지 먼저 렌더(라벨 준비 실패해도 이미지는 보이도록)
    $('#viewtoggle').hidden = false; $('#legend').hidden = false; $('#nav').hidden = false; $('#anno').hidden = true;
    await renderStage();
    // 라벨 디렉토리/카운트는 비차단
    (async () => {
      try {
        F.labels = await dir.getDirectoryHandle('labels', { create: true });
        try { await writeToLabels('classes.txt', CLASSES.map(c => c.en).join('\n')); } catch (e) {}
        await loadAnnoCounts(); await renderStage();
      } catch (e) {
        console.error('labels 준비 실패', e);
        msg('labels 폴더 쓰기 실패(권한?) — 보기/그리기는 가능, 저장은 권한 허용 후 가능');
      }
    })();
  } catch (e) { console.error(e); setInfo('폴더 로드 오류: ' + (e && e.message), true); }
}

function parseSection(json, dirName) {
  const info = json.rsr_images_info;
  const cr = info.capture_region, cn = cr.column_num, rn = cr.row_num;
  const teles = (info.zoom_images || []).map(z => {
    const sub = z.sub_index, row = Math.floor((sub - 1) / cn), pos = (sub - 1) % cn;
    const col = row % 2 === 0 ? pos : (cn - 1 - pos);      // 뱀 스캔
    return { sub, file: z.file_name, row, col, n_inst: 0, annotated: false, polys: [] };
  });
  SEC = {
    region: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom },
    row_num: rn, col_num: cn, teles, w_image: info.fpv_image.file_name, dirName,
  };
  $('#sec-info').innerHTML = `<b>${dirName}</b> · 격자 ${rn}×${cn} · 텔레 ${teles.length}`;
}

async function getURL(name) {
  if (F.urls[name]) return F.urls[name];
  const h = F.files[name]; if (!h) return null;
  const url = URL.createObjectURL(await h.getFile());
  F.urls[name] = url; return url;
}
async function writeToLabels(name, text) {
  const h = await F.labels.getFileHandle(name, { create: true });
  const w = await h.createWritable(); await w.write(text); await w.close();
}
async function readLabelText(file) {
  try {
    const h = await F.labels.getFileHandle(stemOf(file) + '.txt');
    return await (await h.getFile()).text();
  } catch (e) { return null; }
}
function labelToPolys(text) {
  const out = [];
  for (const ln of (text || '').split('\n')) {
    const t = ln.trim().split(/\s+/); if (t.length < 7) continue;
    const nums = t.slice(1).map(parseFloat), pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    out.push({ cls: parseInt(parseFloat(t[0])) || 0, pts });
  }
  return out;
}
async function loadAnnoCounts() {
  const have = {};
  for await (const [name, h] of F.labels.entries()) {
    if (h.kind === 'file' && name.endsWith('.txt') && name !== 'classes.txt') {
      have[name.replace(/\.txt$/, '')] = labelToPolys(await (await h.getFile()).text());
    }
  }
  for (const t of SEC.teles) {
    const p = have[stemOf(t.file)];
    t.reviewed = (p !== undefined);       // 라벨 파일 존재 = 검토완료(빈 파일=무라벨)
    t.polys = p || [];
    t.n_inst = t.polys.length;
    t.annotated = t.n_inst > 0;           // 균열/창/기타 라벨 있음
  }
}
// 격자에서 우클릭: 검토완료(무라벨) 토글 — 균열 라벨 있는 칸은 대상 아님
async function quickReview(t) {
  if (!F.labels || t.annotated) return;
  const fn = stemOf(t.file) + '.txt';
  try {
    if (t.reviewed) { await F.labels.removeEntry(fn); t.reviewed = false; }
    else { await writeToLabels(fn, ''); t.reviewed = true; }
  } catch (e) { console.error(e); }
  renderStage();
}

// ===== 탐색: 전경격자 / 이미지나열 =====
function renderStage() { if (!SEC) return; return viewMode === 'gallery' ? renderGallery() : renderOverlay(); }
function setViewMode(m) {
  if (viewMode === m) return; viewMode = m;
  $('#vm-overlay').classList.toggle('on', m === 'overlay');
  $('#vm-gallery').classList.toggle('on', m === 'gallery');
  renderStage();
}
async function renderOverlay() {
  $('#nav-empty').hidden = true;
  const stage = $('#stage'); stage.hidden = false; stage.className = 'as-overlay';
  const dbg = t => { const e = $('#sec-info'); if (e) e.innerHTML = `<b>${SEC.dirName}</b> · 격자 ${SEC.row_num}×${SEC.col_num} · 텔레 ${SEC.teles.length} · <span style="color:#8ff5e6">${t}</span>`; };
  const wurl = await getURL(SEC.w_image);
  console.log('[overlay] W=', SEC.w_image, 'url?', !!wurl, 'files=', Object.keys(F.files).length, F.files[SEC.w_image] ? 'handle:ok' : 'handle:MISSING');
  if (!wurl) { dbg('⚠ W 이미지 핸들 없음'); stage.innerHTML = `<div style="color:#ff8a8a;padding:24px">W 이미지(<b>${SEC.w_image}</b>)를 폴더 파일 목록(${Object.keys(F.files).length}개)에서 찾지 못했습니다.<br>폴더 내 파일: ${Object.keys(F.files).slice(0,6).join(', ')}…</div>`; return; }
  stage.innerHTML = `<img id="wimg" src="${wurl}" alt="W"><div id="overlay"></div>`;
  const wimg = $('#wimg');
  wimg.onload = () => { console.log('[overlay] W loaded', wimg.naturalWidth, wimg.naturalHeight); dbg(`W ${wimg.naturalWidth}×${wimg.naturalHeight} 로드됨`); };
  wimg.onerror = () => { console.error('[overlay] W load error'); dbg('⚠ W 로드 실패'); stage.innerHTML = `<div style="color:#ff8a8a;padding:24px">W 이미지 로드 실패: ${SEC.w_image}</div>`; };
  const ov = $('#overlay'), R = SEC.region, cn = SEC.col_num, rn = SEC.row_num;
  const spanX = R.right - R.left, spanY = R.bottom - R.top;
  const byCell = {}; for (const t of SEC.teles) byCell[t.row + '_' + t.col] = t;
  for (let r = 0; r < rn; r++) for (let c = 0; c < cn; c++) {
    const t = byCell[r + '_' + c], cell = document.createElement('div');
    cell.className = 'gcell' + (t ? '' : ' empty') + (t ? (t.annotated ? ' anno' : (t.reviewed ? ' reviewed' : '')) : '');
    cell.style.left = ((R.left + spanX * c / cn) * 100) + '%';
    cell.style.top = ((R.top + spanY * r / rn) * 100) + '%';
    cell.style.width = (spanX / cn * 100) + '%'; cell.style.height = (spanY / rn * 100) + '%';
    if (t) {
      cell.dataset.file = t.file;
      cell.title = `#${t.sub} (행${t.row + 1},열${t.col + 1}) — 클릭:어노테이션 · 우클릭:검토완료(무라벨) 토글`;
      cell.innerHTML = t.annotated ? `<span class="gb">✓${t.n_inst}</span>` : (t.reviewed ? `<span class="gb rv">✓</span>` : '');
      cell.onclick = () => openAnno(t.file);
      cell.oncontextmenu = (e) => { e.preventDefault(); quickReview(t); };
    }
    ov.appendChild(cell);
  }
}
const SVGNS = 'http://www.w3.org/2000/svg';
function cardPolys(cell, polys) {
  if (!polys || !polys.length) return;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'cardpoly'); svg.setAttribute('viewBox', '0 0 1 1'); svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = polys.map(p => `<polygon points="${p.pts.map(pt => pt[0].toFixed(4) + ',' + pt[1].toFixed(4)).join(' ')}" fill="${clsInfo(p.cls).stroke}" fill-opacity="0.14" stroke="${clsInfo(p.cls).stroke}"/>`).join('');
  cell.appendChild(svg);
}
function renderGallery() {
  $('#nav-empty').hidden = true;
  const stage = $('#stage'); stage.hidden = false; stage.className = 'as-gallery';
  stage.innerHTML = `<div id="gallery"></div>`;
  const g = $('#gallery'); g.style.gridTemplateColumns = `repeat(${SEC.col_num}, 1fr)`;
  const byCell = {}; for (const t of SEC.teles) byCell[t.row + '_' + t.col] = t;
  const io = new IntersectionObserver(async (ents, obs) => {
    for (const en of ents) if (en.isIntersecting) {
      const el = en.target, u = await getURL(el.dataset.name);
      if (u) el.style.backgroundImage = `url(${u})`;
      obs.unobserve(el);
    }
  }, { root: $('#nav'), rootMargin: '200px' });
  for (let r = 0; r < SEC.row_num; r++) for (let c = 0; c < SEC.col_num; c++) {
    const t = byCell[r + '_' + c], cell = document.createElement('div');
    cell.style.gridColumn = c + 1; cell.style.gridRow = r + 1;
    if (!t) { cell.className = 'gcard empty'; g.appendChild(cell); continue; }
    cell.className = 'gcard' + (t.annotated ? ' anno' : (t.reviewed ? ' reviewed' : ''));
    cell.dataset.file = t.file; cell.dataset.name = t.file;
    cell.title = `#${t.sub} (행${t.row + 1},열${t.col + 1}) — 클릭:어노테이션 · 우클릭:검토완료(무라벨) 토글`;
    cell.innerHTML = `<span class="sub">#${t.sub}</span>` + (t.annotated ? `<span class="gbc">✓${t.n_inst}</span>` : (t.reviewed ? `<span class="gbc rv">✓</span>` : ''));
    cardPolys(cell, t.polys);
    cell.onclick = () => openAnno(t.file);
    cell.oncontextmenu = (e) => { e.preventDefault(); quickReview(t); };
    g.appendChild(cell); io.observe(cell);
  }
}

// ============================ 캔버스 어노테이션 ============================
const cv = $('#cv'), ctx = cv.getContext('2d'), wrap = $('#canvas-wrap');
const HANDLE = 5, HIT = 9;
const S = {
  img: null, natW: 0, natH: 0, insts: [], curFile: null,
  tool: 'pan', view: { scale: 1, ox: 0, oy: 0 }, draft: null, annoView: 0,
  sel: -1, selVtx: -1, pan: null, drag: null, box: null, activeCls: 0, dirty: false,
};
const toS = (x, y) => [S.view.ox + S.view.scale * x, S.view.oy + S.view.scale * y];
const toImg = (sx, sy) => [(sx - S.view.ox) / S.view.scale, (sy - S.view.oy) / S.view.scale];
function evPt(e) {
  const r = cv.getBoundingClientRect(); if (!r.width || !r.height) return [0, 0];
  const dpr = window.devicePixelRatio || 1;
  return [(e.clientX - r.left) * (cv.width / r.width) / dpr, (e.clientY - r.top) * (cv.height / r.height) / dpr];
}
function resize() {
  const dpr = window.devicePixelRatio || 1, w = wrap.clientWidth, h = wrap.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); render();
}
function fit() {
  if (!S.img) return;
  const w = wrap.clientWidth, h = wrap.clientHeight, m = 20;
  const s = Math.min((w - m) / S.natW, (h - m) / S.natH);
  S.view.scale = s; S.view.ox = (w - S.natW * s) / 2; S.view.oy = (h - S.natH * s) / 2; render();
}
function focusInst(i) {
  const ins = S.insts[i]; if (!ins || !ins.pts.length) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  ins.pts.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const bw = Math.max(x1 - x0, 30), bh = Math.max(y1 - y0, 30);
  const s = Math.max(0.05, Math.min(30, Math.min(w / (bw * 1.9), h / (bh * 1.9))));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  S.view.scale = s; S.view.ox = w / 2 - cx * s; S.view.oy = h / 2 - cy * s; render();
}
function render() {
  const w = wrap.clientWidth, h = wrap.clientHeight; ctx.clearRect(0, 0, w, h);
  if (!S.img) return;
  ctx.imageSmoothingEnabled = S.view.scale < 2;
  ctx.drawImage(S.img, S.view.ox, S.view.oy, S.natW * S.view.scale, S.natH * S.view.scale);
  S.insts.forEach((ins, i) => drawPoly(ins, i === S.sel));
  if (S.draft) drawDraft(S.draft);
  if (S.box) drawBox(S.box);
  $('#sb-zoom').textContent = (S.view.scale * 100).toFixed(0) + '%';
}
function drawPoly(ins, sel) {
  const pts = ins.pts; if (pts.length < 2) return;
  const ci = clsInfo(ins.cls || 0);
  const av = S.annoView;                 // 0 채움+선 / 1 선만 / 2 숨김
  if (av === 2 && !sel) return;          // 숨김(선택된 것은 편집 위해 표시)
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = toS(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
  if (av === 0) {                        // 채움 모드에서만 내부 채움(선택도 마찬가지 → 외곽선/숨김 모드에선 원본 보임)
    ctx.fillStyle = sel ? 'rgba(255,214,64,.22)' : ci.fill; ctx.fill();
  }
  ctx.lineWidth = sel ? 2.5 : 1.6; ctx.strokeStyle = sel ? '#ffd640' : ci.stroke; ctx.stroke();
  if (sel) pts.forEach((p, i) => handle(p, i === S.selVtx));
}
function handle(p, hot) {
  const [x, y] = toS(p[0], p[1]), rr = hot ? HANDLE + 3 : HANDLE;
  ctx.beginPath(); ctx.arc(x, y, rr, 0, 7);
  ctx.fillStyle = hot ? '#ff3b6b' : '#ffd640'; ctx.fill();
  ctx.lineWidth = hot ? 2.5 : 1.5; ctx.strokeStyle = hot ? '#fff' : '#111'; ctx.stroke();
}
function drawDraft(pts) {
  ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = toS(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.lineWidth = 2; ctx.strokeStyle = '#ff7ac6'; ctx.stroke(); pts.forEach((p, i) => handle(p, i === 0));
}
function drawBox(b) {
  const [x0, y0] = toS(b.x0, b.y0), [x1, y1] = toS(b.x1, b.y1);
  ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.strokeStyle = '#7ac6ff';
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
}
function hitVtx(ix, iy) {
  if (S.sel < 0) return -1;
  const pts = S.insts[S.sel].pts, R = HIT / S.view.scale;
  for (let i = 0; i < pts.length; i++) if (Math.hypot(pts[i][0] - ix, pts[i][1] - iy) < R) return i;
  return -1;
}
function hitInst(ix, iy) {
  for (let i = S.insts.length - 1; i >= 0; i--) {
    const p = S.insts[i].pts; let inside = false;
    for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
      if (((p[a][1] > iy) !== (p[b][1] > iy)) &&
          (ix < (p[b][0] - p[a][0]) * (iy - p[a][1]) / (p[b][1] - p[a][1]) + p[a][0])) inside = !inside;
    }
    if (inside) return i;
  }
  return -1;
}
function mark() { S.dirty = true; $('#dirty').textContent = '● 미저장'; render(); }
function selectInst(i) { S.sel = i; S.selVtx = -1; renderInsts(); syncClassPalette(); render(); }

cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('mousedown', e => {
  const [sx, sy] = evPt(e), [ix, iy] = toImg(sx, sy);
  if (e.button === 2) { S.pan = { sx: e.clientX, sy: e.clientY, ox: S.view.ox, oy: S.view.oy }; return; }
  if (S.tool === 'draw') {
    if (!S.draft) S.draft = [];
    if (S.draft.length >= 3 && Math.hypot(...toS(S.draft[0][0], S.draft[0][1]).map((v, k) => v - [sx, sy][k])) < HIT) { commitDraft(); return; }
    S.draft.push([ix, iy]); render(); return;
  }
  if (S.tool === 'box') { S.box = { x0: ix, y0: iy, x1: ix, y1: iy }; return; }
  // pan/select
  const hv = hitVtx(ix, iy);
  if (hv >= 0) { S.selVtx = hv; S.drag = { vtx: hv }; render(); return; }
  const hi = hitInst(ix, iy);
  if (hi >= 0) { if (hi !== S.sel) selectInst(hi); S.drag = { move: true, lx: ix, ly: iy }; return; }
  // 빈 영역 좌클릭 드래그 = 화면 이동(팬), 안 움직이면 선택 해제
  S.pan = { sx: e.clientX, sy: e.clientY, ox: S.view.ox, oy: S.view.oy, deselect: true };
});
window.addEventListener('mousemove', e => {
  if (S.pan) { S.pan.moved = true; cv.style.cursor = 'grabbing'; S.view.ox = S.pan.ox + (e.clientX - S.pan.sx); S.view.oy = S.pan.oy + (e.clientY - S.pan.sy); render(); return; }
  const [sx, sy] = evPt(e), [ix, iy] = toImg(sx, sy);
  if (S.box) { S.box.x1 = ix; S.box.y1 = iy; render(); return; }
  if (S.drag && S.drag.vtx != null && S.sel >= 0) { S.insts[S.sel].pts[S.drag.vtx] = [ix, iy]; mark(); return; }
  if (S.drag && S.drag.move && S.sel >= 0) {
    const dx = ix - S.drag.lx, dy = iy - S.drag.ly; S.insts[S.sel].pts.forEach(p => { p[0] += dx; p[1] += dy; });
    S.drag.lx = ix; S.drag.ly = iy; mark(); return;
  }
});
window.addEventListener('mouseup', () => {
  if (S.box) {
    const b = S.box; S.box = null;
    const x0 = Math.min(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), x1 = Math.max(b.x0, b.x1), y1 = Math.max(b.y0, b.y1);
    if (x1 - x0 > 3 && y1 - y0 > 3) { S.insts.push({ cls: S.activeCls, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }); selectInst(S.insts.length - 1); mark(); setTool('pan'); }
    else render();
  }
  if (S.pan && S.pan.deselect && !S.pan.moved) selectInst(-1);   // 드래그 안 했으면 선택 해제
  cv.style.cursor = S.tool === 'pan' ? 'grab' : 'crosshair';
  S.pan = null; S.drag = null;
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const [sx, sy] = evPt(e), [ix, iy] = toImg(sx, sy);
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  S.view.scale = Math.max(0.02, Math.min(40, S.view.scale * f));
  S.view.ox = sx - ix * S.view.scale; S.view.oy = sy - iy * S.view.scale; render();
}, { passive: false });
function commitDraft() {
  if (S.draft && S.draft.length >= 3) { S.insts.push({ cls: S.activeCls, pts: S.draft }); S.draft = null; selectInst(S.insts.length - 1); mark(); setTool('pan'); }
  else { S.draft = null; render(); }
}
function setTool(t) { S.tool = t; document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); cv.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; }
// 라벨 표시 순환: 채움+선 → 외곽선만(원본 확인) → 숨김
const ANNO_LBL = ['👁 라벨', '◇ 외곽선', '🚫 숨김'];
function cycleAnnoView() {
  S.annoView = (S.annoView + 1) % 3;
  const b = $('#btn-anno');
  if (b) { b.textContent = ANNO_LBL[S.annoView]; b.classList.toggle('on', S.annoView !== 0); }
  msg(['라벨 채움+외곽선', '라벨 외곽선만(원본 보임)', '라벨 숨김(선택항목만 표시)'][S.annoView]);
  render();
}

// 라벨 리스트 + 클래스 팔레트
function renderInsts() {
  const ul = $('#instlist'); ul.innerHTML = ''; $('#ip-count').textContent = S.insts.length;
  S.insts.forEach((ins, i) => {
    const li = document.createElement('li'); li.className = (i === S.sel ? 'sel' : '');
    const ci = clsInfo(ins.cls || 0);
    li.innerHTML = `<span class="idot" style="background:${ci.stroke}"></span><span class="it">#${i + 1} ${ci.ko}</span><span class="ix" title="삭제">✕</span>`;
    li.querySelector('.it').onclick = () => { selectInst(i); focusInst(i); };
    li.querySelector('.ix').onclick = (e) => { e.stopPropagation(); S.insts.splice(i, 1); (S.sel === i ? selectInst(-1) : (S.sel > i && S.sel--, renderInsts())); mark(); };
    ul.appendChild(li);
  });
}
function syncClassPalette() {
  const c = (S.sel >= 0) ? (S.insts[S.sel].cls || 0) : S.activeCls;
  document.querySelectorAll('.clsbtn').forEach(b => b.classList.toggle('on', +b.dataset.cls === c));
}
function setActiveClass(c) {
  S.activeCls = c;
  if (S.sel >= 0) { S.insts[S.sel].cls = c; mark(); renderInsts(); }
  syncClassPalette();
}

// 라벨 <-> 인스턴스
function labelToInsts(text, w, h) {
  return labelToPolys(text).map(p => ({ cls: p.cls, pts: p.pts.map(pt => [pt[0] * w, pt[1] * h]) }));
}
function instsToLabel(insts, w, h) {
  return insts.filter(x => x.pts.length >= 3).map(x => {
    const flat = []; for (const [px, py] of x.pts) flat.push(clamp01(px / w).toFixed(6), clamp01(py / h).toFixed(6));
    return (x.cls || 0) + ' ' + flat.join(' ');
  }).join('\n');
}

// 열기/저장/닫기
async function openAnno(file) {
  S.curFile = file; S.insts = []; S.sel = -1; S.selVtx = -1; S.draft = null; S.box = null; S.dirty = false;
  $('#dirty').textContent = ''; $('#anno-file').textContent = file;
  $('#nav').hidden = true; $('#anno').hidden = false; setTool('pan');
  const url = await getURL(file);
  const im = new Image();
  im.onload = async () => {
    S.img = im; S.natW = im.naturalWidth; S.natH = im.naturalHeight;
    const txt = await readLabelText(file);
    S.insts = txt ? labelToInsts(txt, S.natW, S.natH) : [];
    resize(); fit(); renderInsts(); syncClassPalette();
    $('#sb-file').textContent = `${file} · ${S.natW}×${S.natH}`;
    msg(txt ? '기존 라벨 로드됨' : '새 이미지');
  };
  im.src = url;
}
async function save() {
  if (!S.curFile || !F.labels) return;
  await writeToLabels(stemOf(S.curFile) + '.txt', instsToLabel(S.insts, S.natW, S.natH));
  S.dirty = false; $('#dirty').textContent = '';
  const t = SEC.teles.find(x => x.file === S.curFile);
  if (t) { const n = S.insts.filter(i => i.pts.length >= 3).length; t.n_inst = n; t.annotated = n > 0; t.reviewed = true; t.polys = S.insts.map(i => ({ cls: i.cls || 0, pts: i.pts.map(p => [clamp01(p[0] / S.natW), clamp01(p[1] / S.natH)]) })); }
  msg(`저장됨 → labels/${stemOf(S.curFile)}.txt (${t ? t.n_inst : 0} 라벨${t && !t.annotated ? ' · 검토완료(무라벨)' : ''})`);
}
async function closeAnno() {
  if (S.dirty) await save();
  $('#anno').hidden = true; $('#nav').hidden = false; renderStage();
}

// ===== 배선 =====
$('#btn-open').onclick = openFolder;
$('#vm-overlay').onclick = () => setViewMode('overlay');
$('#vm-gallery').onclick = () => setViewMode('gallery');
$('#btn-back').onclick = closeAnno;
$('#btn-save').onclick = save;
$('#btn-review').onclick = async () => { if (!S.curFile) return; await save(); closeAnno(); };   // 검토완료(무라벨) 표시 + 격자로
$('#btn-fit').onclick = fit;
$('#btn-anno').onclick = cycleAnnoView;
$('#btn-del').onclick = () => { if (S.sel >= 0) { S.insts.splice(S.sel, 1); selectInst(-1); mark(); } };
$('#btn-vadd').onclick = () => {
  if (S.sel < 0) return; const pts = S.insts[S.sel].pts;
  const i = S.selVtx >= 0 ? S.selVtx : pts.length - 1, a = pts[i], b = pts[(i + 1) % pts.length];
  pts.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); S.selVtx = i + 1; mark();
};
document.querySelectorAll('.tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
document.querySelectorAll('.clsbtn').forEach(b => b.onclick = () => setActiveClass(+b.dataset.cls));
window.addEventListener('resize', () => { if (!$('#anno').hidden) resize(); });
if (window.ResizeObserver) new ResizeObserver(() => { if (!$('#anno').hidden) resize(); }).observe(wrap);
document.addEventListener('keydown', e => {
  if ($('#anno').hidden) return;
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'v') setTool('pan');
  else if (k === 'p') setTool('draw');
  else if (k === 'b') setTool('box');
  else if (k === 'f') fit();
  else if (k === 'h') cycleAnnoView();
  else if (e.key === '1') setActiveClass(0);
  else if (e.key === '2') setActiveClass(1);
  else if (e.key === '3') setActiveClass(2);
  else if (k === 's') { e.preventDefault(); save(); }
  else if (e.key === 'Enter') { if (S.tool === 'draw') commitDraft(); }
  else if (e.key === 'Escape') { S.draft = null; S.box = null; selectInst(-1); render(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.sel >= 0 && S.selVtx >= 0 && S.insts[S.sel].pts.length > 3) { S.insts[S.sel].pts.splice(S.selVtx, 1); S.selVtx = -1; mark(); }
    else if (S.sel >= 0) { S.insts.splice(S.sel, 1); selectInst(-1); mark(); }
  } else if (e.key === 'Insert') { $('#btn-vadd').onclick(); }
});
cv.addEventListener('dblclick', () => { if (S.tool === 'draw') commitDraft(); });
