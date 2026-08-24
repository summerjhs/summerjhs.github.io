/* =======================================================================
   app.js — 상태 · 파일 로드 · 필터 · 그리드 · 검수 패널 · 내보내기
   ======================================================================= */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const cnum = n => n <= 20 ? String.fromCharCode(0x2460 + n - 1) : '(' + n + ')';
const todayYMD = () => { const d = new Date(), p = n => String(n).padStart(2,'0');
  return String(d.getFullYear()).slice(2) + p(d.getMonth()+1) + p(d.getDate()); };

/* 오류 종류·내보내기 문구는 영문 — 작업자 피드백이 영문으로 나가기 때문 */
const ERR_TYPES = ['Wrong class','Not a target','Missing object','Inaccurate shape','Consistency','Other'];
const ERR_NEEDS_CLASS = ['Wrong class','Missing object'];
/* 예전에 한글로 저장된 기록을 영문 종류로 옮긴다 */
const ERR_MIGRATE = {'잘못된 클래스':'Wrong class','작업 대상 아님':'Not a target','객체 누락':'Missing object',
                     '형상 부정확':'Inaccurate shape','일관성':'Consistency','그 외':'Other'};
const KIND_EN = {box:'box', polygon:'polygon', polyline:'polyline', point:'point', circle:'circle'};
const needsClass = t => ERR_NEEDS_CLASS.includes(t);
const ERR_KEY = 'unified_review_errors_v1';

const S = {
  images: new Map(),   // base -> {file, name}
  docs:   new Map(),   // base -> {fmt, file, text, doc, obj}
  shapes: new Map(),   // base -> Shape[]
  coco:   null,        // {json, file}
  labelit: null,       // {records, file} — labelit.pro 결과(JSONL)
  fmts:   new Set(),
  badFiles: [],        // 형식을 인식하지 못한 라벨 파일 {name, reason}
  namesFile: null,     // 사용자가 고른 클래스 이름 파일 (라벨을 새로 열어도 유지)
  items: [], objItems: [],
  page: 0, view: 'image',
  errors: new Map(),   // base -> [err]
  lbIdx: 0, selBase: null, sel: null,
  changed: new Set(),  // 수정(클래스 변경·삭제)된 base
  cocoChanged: false,
  labelitChanged: false,
  terms: []
};

/* ===================== 오류 기록 저장/복원 ===================== */
function loadErrors(){
  const m = new Map();
  try{
    const o = JSON.parse(localStorage.getItem(ERR_KEY) || 'null');
    if(o) for(const b in o) if(Array.isArray(o[b]) && o[b].length) m.set(b, o[b].map(migrateErr));
  }catch(e){}
  return m;
}
function migrateErr(e){ if(e && ERR_MIGRATE[e.type]) e.type = ERR_MIGRATE[e.type]; return e; }
function saveErrors(){
  const o = {};
  for(const [b, arr] of S.errors) if(arr && arr.length) o[b] = arr;
  try{ localStorage.setItem(ERR_KEY, JSON.stringify(o)); }catch(e){}
  updateErrStat();
}

/* ========================= 파일 불러오기 ========================= */
/* 폴더를 새로 열면 '그 폴더만' 보이도록 이전 것은 비운다 */
$('imgIn').addEventListener('change', async e => {
  const files = [...e.target.files].filter(f => IMG_EXT.includes(extOf(f.name)));
  if(!files.length){
    $('hint').textContent = '※ 고른 폴더에서 이미지를 찾지 못했습니다. (jpg·png·bmp·webp·tif)';
    e.target.value = ''; return;
  }
  S.images.clear(); releaseUrls(); thumbCache.clear();
  for(const f of files) S.images.set(baseOf(f.name), {file:f, name:f.name});
  if(lbOn()) closeLightbox();
  S.page = 0;
  await refresh();
  e.target.value = '';                 // 같은 폴더를 다시 골라도 반응하도록
});
$('lblIn').addEventListener('change', e => ingestLabels(e.target.files));
$('lblFiles').addEventListener('change', e => ingestLabels(e.target.files));

/* 불러온 라벨 상태 전체 비우기 */
function clearLabels(){
  S.docs.clear(); S.shapes.clear();
  S.coco = null; S.labelit = null;
  S.fmts.clear(); S.badFiles = [];
  S.changed.clear(); S.cocoChanged = false; S.labelitChanged = false;
  /* 이전 데이터셋의 클래스 이름·색이 남지 않도록 초기화.
     사용자가 직접 고른 클래스 이름 파일이 있으면 그것만 다시 적용한다. */
  CLS.reset();
  if(S.namesFile) CLS.setNames(S.namesFile);
  VIEW.classOff.clear(); VIEW.kindOff.clear();
}
function confirmDiscardEdits(){
  const n = S.changed.size;
  if(!n && !S.cocoChanged && !S.labelitChanged) return true;
  return confirm(`저장하지 않은 라벨 수정이 있습니다 (이미지 ${n}장).\n` +
                 `새로 열면 사라집니다. 계속할까요?\n\n[취소]를 누른 뒤 「💾 수정 라벨 저장」으로 내보낼 수 있습니다.`);
}
async function ingestLabels(fileList){
  const all = [...fileList];
  const files = all.filter(f => ['txt','xml','json','jsonl','ndjson'].includes(extOf(f.name)));
  if(!files.length){
    $('hint').textContent = all.length
      ? `※ 라벨 파일을 찾지 못했습니다. 고른 ${all.length}개는 .txt/.xml/.json/.jsonl 이 아닙니다.`
      : '※ .txt / .xml / .json 라벨 파일을 찾지 못했습니다.';
    return;
  }
  if(!confirmDiscardEdits()) return;
  clearLabels();                        // 새로 고른 라벨만 보이게 (이전 것은 비움)
  if(lbOn()) closeLightbox();
  S.page = 0;
  const CONC = 48;
  for(let i = 0; i < files.length; i += CONC){
    await Promise.all(files.slice(i, i + CONC).map(async f => {
      let text;
      try{ text = await f.text(); }
      catch(e){ S.badFiles.push({name:f.name, reason:'파일을 읽지 못했습니다'}); return; }
      const r = parseLabelFile(f.name, text);
      if(!r || r.fmt === 'unsupported'){
        S.badFiles.push({name:f.name, reason: (r && r.reason) || '형식을 알 수 없습니다'});
        return;
      }
      if(r.fmt === 'coco-global'){ S.coco = {json:r.json, file:f}; S.fmts.add('coco'); return; }
      if(r.fmt === 'labelit-global'){
        if(S.labelit) S.labelit.records = S.labelit.records.concat(r.records);   // 여러 파일 이어붙이기
        else S.labelit = {records:r.records, file:f};
        S.fmts.add('labelit'); return;
      }
      const b = baseOf(f.name);
      S.docs.set(b, {fmt:r.fmt, file:f, text, doc:r.doc, obj:r.obj});
      S.fmts.add(r.fmt);
    }));
    if(files.length > 300) $('hint').textContent = `라벨 읽는 중… ${Math.min(files.length, i+CONC)}/${files.length}`;
  }
  await refresh();
}

/* 클래스 이름 파일 */
$('clsIn').addEventListener('change', async e => {
  const f = e.target.files[0]; if(!f) return;
  let names;
  try{ names = parseNamesFile(await f.text(), f.name); }
  catch(err){ alert('클래스 파일을 읽지 못했습니다: ' + err.message); return; }
  if(!Object.keys(names).length){ alert('클래스 이름을 찾지 못했습니다. 한 줄에 하나씩 적어주세요.'); return; }
  S.namesFile = names;
  CLS.setNames(names);
  await refresh();
  $('hint').textContent = `클래스 이름 ${Object.keys(names).length}개 적용됨`;
});

/* 저장된 텍스트/객체로부터 모든 라벨 재파싱 (클래스 이름 변경 시에도 사용) */
function reparseAll(){
  S.shapes.clear();
  for(const [b, d] of S.docs){
    let shapes = [];
    if(d.fmt === 'yolo') shapes = parseYolo(d.text);
    else if(d.fmt === 'voc'){ const r = parseVoc(d.text); if(r){ shapes = r.shapes; d.doc = r.doc; } }
    else if(d.fmt === 'labelme'){ const r = parseLabelMe(d.obj); shapes = r.shapes; }
    S.shapes.set(b, shapes);
  }
  if(S.labelit){
    const r = parseLabelit(S.labelit.records);
    for(const [b, arr] of r.byBase){
      if(!S.shapes.has(b)) S.shapes.set(b, arr);
      else S.shapes.set(b, S.shapes.get(b).concat(arr));
      if(!S.docs.has(b)) S.docs.set(b, {fmt:'labelit'});
    }
  }
  if(S.coco){
    const r = parseCoco(S.coco.json);
    S.coco.rle = r.rle;
    for(const [b, arr] of r.byBase){
      if(!S.shapes.has(b)) S.shapes.set(b, arr);
      else S.shapes.set(b, S.shapes.get(b).concat(arr));
      if(!S.docs.has(b)) S.docs.set(b, {fmt:'coco'});
    }
  }
}

async function refresh(){
  reparseAll();
  S.changed.clear(); S.cocoChanged = false; S.labelitChanged = false;
  applyFilterSort();
  buildLegends();
  updateStats();
  S.page = 0;
  renderPage();
}

/* ========================= 필터 · 정렬 ========================= */
const shapesOf = b => S.shapes.get(b) || [];
const errsOf = b => S.errors.get(b) || [];

function applyFilterSort(){
  const mode = $('fMode').value, sort = $('fSort').value, errMode = $('fErr').value;
  const clsSel = $('fClass').value, kindSel = $('fKind').value;
  const clsFilter = clsSel === 'all' ? null : +clsSel;
  const kindFilter = kindSel === 'all' ? null : kindSel;
  const terms = $('q').value.toLowerCase().split(/\s+/).filter(Boolean);
  S.terms = terms;
  const list = [];
  for(const [base, meta] of S.images){
    const shapes = shapesOf(base);
    const errs = errsOf(base);
    if(mode === 'labeled' && !shapes.length) continue;
    if(mode === 'empty' && shapes.length) continue;
    if(clsFilter != null && !shapes.some(s => s.cls === clsFilter)) continue;
    if(kindFilter && !shapes.some(s => s.kind === kindFilter)) continue;
    if(errMode === 'has' && !errs.length) continue;
    if(errMode === 'none' && errs.length) continue;
    if(errMode !== 'all' && errMode !== 'has' && errMode !== 'none' && !errs.some(e => e.type === errMode)) continue;
    if(terms.length){
      const n = meta.name.toLowerCase();
      if(!terms.every(t => n.includes(t))) continue;
    }
    list.push({base, name:meta.name, file:meta.file, count:shapes.length, errCount:errs.length});
  }
  if(sort === 'name') list.sort((a,b) => a.name.localeCompare(b.name));
  if(sort === 'objdesc') list.sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  if(sort === 'objasc') list.sort((a,b) => a.count - b.count || a.name.localeCompare(b.name));
  if(sort === 'errdesc') list.sort((a,b) => b.errCount - a.errCount || a.name.localeCompare(b.name));
  list.forEach((it, i) => it.idx = i);
  S.items = list;
  buildObjectItems(clsFilter, kindFilter);
  $('qInfo').textContent = terms.length ? `검색결과 ${list.length} / ${S.images.size}` : '';
}

/* 객체 모아보기용 목록 — 클래스별로 모아 정렬 */
function buildObjectItems(clsFilter, kindFilter){
  const out = [];
  for(const it of S.items){
    shapesOf(it.base).forEach((sh, si) => {
      if(clsFilter != null && sh.cls !== clsFilter) return;
      if(kindFilter && sh.kind !== kindFilter) return;
      if(VIEW.classOff.has(sh.cls) || VIEW.kindOff.has(sh.kind)) return;
      out.push({base:it.base, name:it.name, file:it.file, si, sh, imgIdx:it.idx});
    });
  }
  out.sort((a, b) => a.sh.cls - b.sh.cls || a.name.localeCompare(b.name) || a.si - b.si);
  S.objItems = out;
}

function highlight(name){
  const terms = S.terms || [];
  if(!terms.length) return esc(name);
  const lo = name.toLowerCase(), hits = [];
  for(const t of terms){ let i = 0; while((i = lo.indexOf(t, i)) !== -1){ hits.push([i, i + t.length]); i += t.length; } }
  if(!hits.length) return esc(name);
  hits.sort((a,b) => a[0] - b[0]);
  const merged = [hits[0]];
  for(const h of hits.slice(1)){ const last = merged[merged.length-1];
    if(h[0] <= last[1]) last[1] = Math.max(last[1], h[1]); else merged.push(h); }
  let out = '', pos = 0;
  for(const [s, e] of merged){ out += esc(name.slice(pos, s)) + '<mark>' + esc(name.slice(s, e)) + '</mark>'; pos = e; }
  return out + esc(name.slice(pos));
}

/* ========================= 상단 통계 · 범례 ========================= */
function updateStats(){
  let objs = 0, matched = 0;
  for(const [b] of S.images){ const n = shapesOf(b).length; objs += n; if(S.docs.has(b)) matched++; }
  $('sTotal').textContent = `이미지 ${S.images.size}`;
  $('sMatched').textContent = `라벨 매칭 ${matched}`;
  $('sObjs').textContent = `객체 ${objs}`;
  const FMT_LABEL = {yolo:'YOLO', voc:'VOC XML', labelme:'LabelMe', coco:'COCO', labelit:'labelit.pro'};
  $('sFmt').textContent = '포맷 ' + ([...S.fmts].map(f => FMT_LABEL[f] || f).join(' + ') || '–');
  const missImgs = [...S.docs.keys()].filter(b => !S.images.has(b)).length;
  let msg;
  if(S.badFiles && S.badFiles.length){       // 못 읽은 파일이 있으면 먼저 알린다
    const b = S.badFiles[0];
    $('hint').innerHTML = `<span style="color:var(--bad)">※ 인식하지 못한 라벨 파일 ${S.badFiles.length}개</span> — ` +
      `<b>${esc(b.name)}</b>: ${esc(b.reason)}` +
      (S.badFiles.length > 1 ? ` 외 ${S.badFiles.length - 1}개` : '') +
      ` <span class="muted">(도움말의 지원 포맷 확인)</span>`;
    updateErrStat();
    return;
  }
  if(S.images.size && !S.docs.size && !S.coco) msg = '※ 라벨 폴더/파일을 아직 선택하지 않았습니다.';
  else if(S.images.size && !matched) msg = '※ 이미지와 라벨 파일명이 매칭되지 않습니다 (예: abc.jpg ↔ abc.txt / abc.xml / abc.json).';
  else if(matched && !objs) msg = '※ 매칭은 됐지만 객체가 0개입니다. 라벨 내용 형식을 확인하세요.';
  else if(S.coco && S.coco.rle) msg = `※ COCO RLE 마스크 ${S.coco.rle}개는 bbox로 표시됩니다.`;
  else msg = missImgs ? `※ 이미지 없는 라벨 ${missImgs}개` : '폴더는 같아도 되고 달라도 됩니다.';
  $('hint').textContent = msg;
  updateErrStat();
}
function updateErrStat(){
  const s = errorStats();
  const base = s.total ? `오류 ${s.total} · 이미지 ${s.images}` : '오류 0';
  $('sErr').textContent = base + (s.other ? ` (다른 폴더 ${s.other})` : '');
  $('sErr').title = s.other
    ? `지금 열려 있지 않은 이미지의 오류 ${s.other}건도 기록에 남아 있습니다 (이미지 ${s.otherImages}장).`
    : '';
}

function classIds(){
  const set = new Set();
  for(const [, arr] of S.shapes) for(const sh of arr) set.add(sh.cls);
  for(const k of Object.keys(CLS.names)) set.add(+k);
  return [...set].sort((a,b) => a - b);
}
function countsByClass(){
  const c = {};
  for(const [, arr] of S.shapes) for(const sh of arr) c[sh.cls] = (c[sh.cls] || 0) + 1;
  return c;
}
function countsByKind(){
  const c = {};
  for(const [, arr] of S.shapes) for(const sh of arr) c[sh.kind] = (c[sh.kind] || 0) + 1;
  return c;
}

function buildLegends(){
  const ids = classIds(), cc = countsByClass(), kc = countsByKind();
  const lc = $('legendCls'); lc.innerHTML = '<span class="lbl">클래스</span>';
  for(const id of ids){
    const el = document.createElement('span');
    el.className = 'lg' + (VIEW.classOff.has(id) ? ' off' : '');
    el.title = '클릭 → 화면에서 숨기기/보이기';
    el.innerHTML = `<span class="sw" style="background:${colorFor(id)}"></span>${id}: ${esc(CLS.nameOf(id))} <span class="n">${cc[id] || 0}</span>`;
    el.onclick = () => { VIEW.classOff.has(id) ? VIEW.classOff.delete(id) : VIEW.classOff.add(id);
      buildLegends(); applyFilterSort(); renderPage(); if(lbOn()) drawLightbox(); };
    lc.appendChild(el);
  }
  const lk = $('legendKind'); lk.innerHTML = '<span class="lbl">유형</span>';
  for(const k of KINDS){
    if(!kc[k]) continue;
    const el = document.createElement('span');
    el.className = 'lg' + (VIEW.kindOff.has(k) ? ' off' : '');
    el.innerHTML = `${KIND_LABEL[k]} <span class="n">${kc[k]}</span>`;
    el.onclick = () => { VIEW.kindOff.has(k) ? VIEW.kindOff.delete(k) : VIEW.kindOff.add(k);
      buildLegends(); applyFilterSort(); renderPage(); if(lbOn()) drawLightbox(); };
    lk.appendChild(el);
  }
  /* 드롭다운 (선택 유지) */
  const sel = $('fClass'), cur = sel.value;
  sel.innerHTML = '<option value="all">전체</option>' +
    ids.map(id => `<option value="${id}">${id}: ${esc(CLS.nameOf(id))} (${cc[id] || 0})</option>`).join('');
  if([...sel.options].some(o => o.value === cur)) sel.value = cur;
  const ks = $('fKind'), kcur = ks.value;
  ks.innerHTML = '<option value="all">전체</option>' +
    KINDS.filter(k => kc[k]).map(k => `<option value="${k}">${KIND_LABEL[k]} (${kc[k]})</option>`).join('');
  if([...ks.options].some(o => o.value === kcur)) ks.value = kcur;
  /* 오류 종류 필터 */
  const es = $('fErr'), ecur = es.value;
  es.innerHTML = '<option value="all">전체</option><option value="has">오류 있음</option><option value="none">오류 없음</option>' +
    ERR_TYPES.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  if([...es.options].some(o => o.value === ecur)) es.value = ecur;
}

/* ========================= 이미지 로드 ========================= */
function loadImg(file){
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => res({im, url});
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('load fail')); };
    im.src = url;
  });
}

/* ========================= 그리드 렌더 ========================= */
let pageUrls = [];
function releaseUrls(){ pageUrls.forEach(u => URL.revokeObjectURL(u)); pageUrls = []; }

/* 렌더 도중 다시 렌더가 시작되면(토글 연타 등) 이전 렌더는 중단 — 카드가 섞이는 것을 방지 */
let renderSeq = 0;
async function renderPage(){
  const my = ++renderSeq;
  $('welcome').style.display = S.images.size ? 'none' : 'block';
  releaseUrls();
  const grid = $('grid'); grid.innerHTML = '';
  grid.style.setProperty('--card', $('cardSize').value + 'px');
  renderPager();
  if(S.view === 'object') await renderObjectGrid(grid, my);
  else await renderImageGrid(grid, my);
}

async function renderImageGrid(grid, my){
  const per = +$('perPage').value, start = S.page * per;
  const slice = S.items.slice(start, start + per);
  for(const it of slice){
    if(my !== renderSeq) return;
    const card = document.createElement('div'); card.className = 'card';
    const wrap = document.createElement('div'); wrap.className = 'cvwrap';
    const cv = document.createElement('canvas'); wrap.appendChild(cv);
    const cap = document.createElement('div'); cap.className = 'cap';
    cap.innerHTML = `<span class="nm" title="${esc(it.name)}">${highlight(it.name)}</span>` +
      `<span class="ct ${it.count ? '' : 'empty'}">${it.count} obj${it.errCount ? ` · <span class="badge-err">⚠${it.errCount}</span>` : ''}</span>`;
    card.appendChild(wrap); card.appendChild(cap); grid.appendChild(card);
    try{
      const {im, url} = await loadImg(it.file);
      if(my !== renderSeq){ URL.revokeObjectURL(url); return; }
      pageUrls.push(url);
      drawScene(cv, im, shapesOf(it.base), {errors: errsOf(it.base)});
    }catch(e){ wrap.innerHTML = '<div class="muted" style="padding:20px">이미지 로드 실패</div>'; }
    wrap.onclick = () => openLightbox(it.idx);
  }
  if(!slice.length && S.images.size && my === renderSeq)
    grid.innerHTML = '<div class="empty-state">조건에 맞는 이미지가 없습니다. 필터를 확인하세요.</div>';
}

/* 객체 하나를 여백과 함께 크롭해 그린다 */
function drawCrop(cv, img, shapes, target, W, H, outMax){
  const r = shapeRect(shapes[target], W, H);
  const pad = Math.max(12, Math.max(r.w, r.h) * 0.35);
  let sx = Math.max(0, r.x - pad), sy = Math.max(0, r.y - pad);
  let sw = Math.min(W - sx, r.w + pad*2), sh = Math.min(H - sy, r.h + pad*2);
  if(sw < 8){ sx = Math.max(0, sx - 8); sw = Math.min(W - sx, 16); }
  if(sh < 8){ sy = Math.max(0, sy - 8); sh = Math.min(H - sy, 16); }
  const s = Math.min(outMax / sw, outMax / sh, 6);
  const ow = Math.max(1, Math.round(sw * s)), oh = Math.max(1, Math.round(sh * s));
  cv.width = ow; cv.height = oh;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, ow, oh);
  if(!VIEW.show) return;
  ctx.save();
  ctx.scale(ow / sw, oh / sh); ctx.translate(-sx, -sy);
  ctx.lineWidth = VIEW.lineW * sw / ow;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  shapes.forEach((sp, i) => {
    if(!visibleShape(sp)) return;
    const rr = shapeRect(sp, W, H);
    if(rr.x > sx + sw || rr.x + rr.w < sx || rr.y > sy + sh || rr.y + rr.h < sy) return;  // 화면 밖
    ctx.globalAlpha = i === target ? 1 : 0.45;
    if(VIEW.fillAlpha > 0 && (sp.kind === 'polygon' || sp.kind === 'box' || sp.kind === 'circle')){
      ctx.globalAlpha = (i === target ? VIEW.fillAlpha * 1.4 : VIEW.fillAlpha * 0.5);
      ctx.fillStyle = colorFor(sp.cls); pathShape(ctx, sp, W, H); ctx.fill('evenodd');
      ctx.globalAlpha = i === target ? 1 : 0.45;
    }
    ctx.strokeStyle = i === target ? colorFor(sp.cls) : 'rgba(255,255,255,.75)';
    if(i === target) ctx.lineWidth = VIEW.lineW * 1.6 * sw / ow;
    pathShape(ctx, sp, W, H); ctx.stroke();
    ctx.lineWidth = VIEW.lineW * sw / ow;
  });
  ctx.restore();
}

async function renderObjectGrid(grid, my){
  const per = +$('perPage').value, start = S.page * per;
  const slice = S.objItems.slice(start, start + per);
  if(!slice.length){
    grid.innerHTML = S.images.size
      ? '<div class="empty-state">조건에 맞는 객체가 없습니다. 클래스·유형 필터를 확인하세요.</div>' : '';
    return;
  }
  /* 같은 이미지를 여러 번 디코드하지 않도록 base 단위로 묶어서 처리 */
  const order = [], byBase = new Map();
  slice.forEach(o => {
    if(!byBase.has(o.base)){ byBase.set(o.base, []); order.push(o.base); }
    byBase.get(o.base).push(o);
  });
  const cells = new Map();
  for(const o of slice){
    const card = document.createElement('div'); card.className = 'card ocard';
    const wrap = document.createElement('div'); wrap.className = 'cvwrap';
    const cv = document.createElement('canvas'); wrap.appendChild(cv);
    const cap = document.createElement('div'); cap.className = 'cap';
    const errs = errsOf(o.base).filter(e => e.kind === 'shape' && e.i === o.si);
    cap.innerHTML =
      `<div class="oc-cls"><span class="sw" style="background:${colorFor(o.sh.cls)}"></span>` +
      `${o.sh.cls}: ${esc(CLS.nameOf(o.sh.cls))}` +
      (errs.length ? ` <span class="badge-err">⚠</span>` : '') + `</div>` +
      `<div class="oc-sub" title="${esc(o.name)}">${KIND_LABEL[o.sh.kind]} · #${o.si + 1} · ${esc(o.name)}</div>`;
    card.appendChild(wrap); card.appendChild(cap); grid.appendChild(card);
    wrap.onclick = () => openLightbox(o.imgIdx, o.si);
    cells.set(o, cv);
  }
  const outMax = Math.max(160, +$('cardSize').value);
  for(const base of order){
    if(my !== renderSeq) return;
    let loaded; try{ loaded = await loadImg(S.images.get(base).file); }catch(e){ continue; }
    if(my !== renderSeq){ URL.revokeObjectURL(loaded.url); return; }
    pageUrls.push(loaded.url);
    const W = loaded.im.naturalWidth, H = loaded.im.naturalHeight;
    const shapes = shapesOf(base);
    for(const o of byBase.get(base)){
      const cv = cells.get(o); if(!cv || !shapes[o.si]) continue;
      try{ drawCrop(cv, loaded.im, shapes, o.si, W, H, outMax); }catch(e){}
    }
  }
}

function totalPages(){
  const per = +$('perPage').value;
  const n = S.view === 'object' ? S.objItems.length : S.items.length;
  return { pages: Math.max(1, Math.ceil(n / per)), n };
}
function renderPager(){
  const {pages, n} = totalPages();
  if(S.page >= pages) S.page = pages - 1;
  const p = $('pager'); p.innerHTML = '';
  if(!n) return;
  const mk = (t, fn, dis) => { const b = document.createElement('button'); b.className = 'btn';
    b.textContent = t; b.disabled = !!dis; b.onclick = fn; return b; };
  const go = fn => { fn(); renderPage(); window.scrollTo(0, 0); };
  p.appendChild(mk('« 처음', () => go(() => S.page = 0), S.page === 0));
  p.appendChild(mk('‹ 이전', () => go(() => S.page--), S.page === 0));
  const info = document.createElement('span'); info.className = 'pill stat';
  info.textContent = `${S.page+1} / ${pages}  (${n}${S.view === 'object' ? '객체' : '장'})`;
  p.appendChild(info);
  p.appendChild(mk('다음 ›', () => go(() => S.page++), S.page >= pages - 1));
  p.appendChild(mk('끝 »', () => go(() => S.page = pages - 1), S.page >= pages - 1));
}

/* ========================= 라이트박스 ========================= */
const lbOn = () => $('lb').classList.contains('on');
const LOUPE_SIZE = 260;
let loupeZoom = 3, loupeEnabled = true, lastMouse = null;   // 돋보기는 기본 켜짐 (마우스를 올리면 확대)

async function openLightbox(idx, focusSi){
  if(idx < 0 || idx >= S.items.length) return;
  S.lbIdx = idx; $('lb').classList.add('on'); $('side').classList.add('on');
  lastMouse = null; hideLoupe();
  $('lbcv').style.cursor = loupeEnabled ? 'none' : 'crosshair';
  const it = S.items[idx];
  S.selBase = it.base;
  S.sel = (focusSi != null && shapesOf(it.base)[focusSi]) ? {mode:'shape', i:focusSi} : null;
  renderSide(); await drawLightbox();
}
function closeLightbox(){
  $('lb').classList.remove('on'); $('side').classList.remove('on');
  hideLoupe(); renderPage();
}
async function drawLightbox(){
  const it = S.items[S.lbIdx]; if(!it) return;
  try{
    const {im, url} = await loadImg(it.file);
    const r = drawScene($('lbcv'), im, shapesOf(it.base), {
      errors: errsOf(it.base),
      sel: (S.selBase === it.base ? S.sel : null)
    });
    S.lbDim = {W:r.W, H:r.H, vp:r.vp};   // '라벨 영역만'으로 잘렸을 때 클릭 좌표 환산에 사용
    URL.revokeObjectURL(url);
  }catch(e){}
  const d = S.docs.get(it.base);
  const FMT_LABEL = {yolo:'YOLO', voc:'VOC XML', labelme:'LabelMe', coco:'COCO', labelit:'labelit.pro'};
  $('lbcap').textContent = `${it.name}  ·  ${shapesOf(it.base).length} obj  ·  ${d ? (FMT_LABEL[d.fmt] || d.fmt) : '라벨 없음'}  ·  ${S.lbIdx+1}/${S.items.length}`;
  if(loupeEnabled && lastMouse) drawLoupe();
}
function lbStep(d){
  const n = S.lbIdx + d;
  if(n < 0 || n >= S.items.length) return;
  S.lbIdx = n; S.selBase = S.items[n].base; S.sel = null;
  renderSide(); drawLightbox();
}

/* ---- 선택 · 오류 편집 ---- */
function curErr(){
  const sel = S.sel, arr = S.errors.get(S.selBase);
  if(!sel || !arr) return null;
  if(sel.mode === 'shape') return arr.find(e => e.kind === 'shape' && e.i === sel.i) || null;
  return arr.find(e => e.kind === 'point' && e.x === sel.x && e.y === sel.y) || null;
}
function ensureArr(base){ let a = S.errors.get(base); if(!a){ a = []; S.errors.set(base, a); } return a; }
function selectShape(base, i){ S.selBase = base; S.sel = {mode:'shape', i}; renderSide(); drawLightbox(); }
function selectPointAt(base, nx, ny){
  let best = null, bd = 0.03*0.03;
  for(const e of errsOf(base)){
    if(e.kind !== 'point') continue;
    const d = (e.x-nx)**2 + (e.y-ny)**2; if(d < bd){ bd = d; best = e; }
  }
  S.selBase = base;
  S.sel = best ? {mode:'point', x:best.x, y:best.y} : {mode:'point', x:nx, y:ny};
  renderSide(); drawLightbox();
}
function selectErrIdx(base, n){
  const e = errsOf(base)[n]; if(!e) return;
  S.selBase = base;
  S.sel = e.kind === 'shape' ? {mode:'shape', i:e.i} : {mode:'point', x:e.x, y:e.y};
  renderSide(); drawLightbox();
}
function setError(base, type){
  const sel = S.sel; if(!sel) return;
  let e = curErr();
  if(!e){
    e = sel.mode === 'shape' ? {kind:'shape', i:sel.i, type, note:''} : {kind:'point', x:sel.x, y:sel.y, type, note:''};
    ensureArr(base).push(e);
  } else if(e.type === type){        // 같은 버튼을 다시 누르면 해제
    clearError(base); return;
  } else e.type = type;
  if(!needsClass(type)) delete e.correct;
  if(type !== 'Consistency') delete e.refs;
  saveErrors(); renderSide(); drawLightbox();
}
function setCorrect(base, clsId){ const e = curErr(); if(!e) return; e.correct = clsId; saveErrors(); renderSide(); drawLightbox(); }
function updateNote(base, val){ const e = curErr(); if(!e) return; e.note = val; saveErrors(); }
function toggleRef(base, refBase){
  const e = curErr(); if(!e) return;
  if(!e.refs) e.refs = [];
  const i = e.refs.indexOf(refBase);
  if(i >= 0) e.refs.splice(i, 1); else e.refs.push(refBase);
  saveErrors(); renderSide();
}
function clearError(base){
  const e = curErr(), arr = S.errors.get(base); if(!e || !arr) return;
  const i = arr.indexOf(e); if(i >= 0) arr.splice(i, 1);
  if(!arr.length) S.errors.delete(base);
  saveErrors(); renderSide(); drawLightbox();
}
/* 클래스만 변경 — 좌표·형상은 그대로 */
function changeClass(base, i, newCls){
  const sh = shapesOf(base)[i]; if(!sh || sh.cls === newCls) return;
  sh.cls = newCls;
  markChanged(base);
  applyFilterSort(); syncLbIdx(base);
  buildLegends(); renderSide(); drawLightbox();
}
/* 필터를 다시 적용한 뒤에도 같은 이미지를 계속 보고 있도록 인덱스를 맞춘다 */
function syncLbIdx(base){
  if(!lbOn()) return true;
  const i = S.items.findIndex(it => it.base === base);
  if(i < 0){ closeLightbox(); return false; }
  S.lbIdx = i; return true;
}
/* 객체 삭제 (+오류 인덱스 재매핑) */
function deleteShape(base, i){
  const arr = S.shapes.get(base); if(!arr || !arr[i]) return;
  arr.splice(i, 1);
  const errs = S.errors.get(base);
  if(errs){
    const na = [];
    for(const e of errs){
      if(e.kind === 'shape'){ if(e.i === i) continue; if(e.i > i) e.i--; }
      na.push(e);
    }
    if(na.length) S.errors.set(base, na); else S.errors.delete(base);
    saveErrors();
  }
  markChanged(base);
  S.sel = null;
  applyFilterSort(); syncLbIdx(base);
  buildLegends(); renderSide(); drawLightbox();
}
function markChanged(base){
  const d = S.docs.get(base);
  if(d && (d.fmt === 'coco' || shapesOf(base).some(s => s.src && s.src.fmt === 'coco'))) S.cocoChanged = true;
  if(d && (d.fmt === 'labelit' || shapesOf(base).some(s => s.src && s.src.fmt === 'labelit'))) S.labelitChanged = true;
  S.changed.add(base);
}

/* ---- 이웃 썸네일 (일관성 비교 대상 고르기) ---- */
const thumbCache = new Map();
async function ensureThumb(base){
  if(thumbCache.has(base)) return thumbCache.get(base);
  const meta = S.images.get(base); if(!meta) return null;
  try{
    const {im, url} = await loadImg(meta.file);
    const W = im.naturalWidth, H = im.naturalHeight, s = Math.min(1, 200 / W);
    const w = Math.max(1, Math.round(W*s)), h = Math.max(1, Math.round(H*s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0, w, h);
    ctx.save(); ctx.scale(s, s); ctx.lineWidth = 1/s;
    for(const sh of shapesOf(base)){
      if(!visibleShape(sh)) continue;
      ctx.strokeStyle = colorFor(sh.cls); pathShape(ctx, sh, W, H); ctx.stroke();
    }
    ctx.restore();
    URL.revokeObjectURL(url);
    const data = c.toDataURL('image/jpeg', 0.7);
    thumbCache.set(base, data);
    return data;
  }catch(e){ return null; }
}

/* ========================= 우측 검수 패널 ========================= */
function renderSide(){
  const p = $('side');
  const it = S.items[S.lbIdx];
  if(!it || !lbOn()){ p.classList.remove('on'); return; }
  p.classList.add('on');
  const base = it.base, shapes = shapesOf(base), arr = errsOf(base);
  const ids = classIds();
  let sel = (S.selBase === base) ? S.sel : null;
  if(sel && sel.mode === 'shape' && !shapes[sel.i]) sel = null;
  const e = curErr();

  let html = `<div class="ep-h"><span>검수</span><span class="muted" style="font-size:11px">${esc(it.name)}</span></div>`;

  /* 객체 목록 */
  html += `<div class="ep-corr-label muted">객체 ${shapes.length}개 — 클릭해서 선택</div><div class="ob-list">`;
  if(!shapes.length) html += `<div class="ob-row muted">라벨 없음</div>`;
  shapes.forEach((sh, i) => {
    const on = sel && sel.mode === 'shape' && sel.i === i;
    const hasErr = arr.some(x => x.kind === 'shape' && x.i === i);
    const hidden = !visibleShape(sh);
    html += `<div class="ob-row${on ? ' on' : ''}" data-oi="${i}" style="${hidden ? 'opacity:.4' : ''}">
      <span class="sw" style="background:${colorFor(sh.cls)}"></span>
      <span class="nm">#${i+1} ${esc(CLS.nameOf(sh.cls))}</span>
      <span class="kd">${KIND_LABEL[sh.kind]}${sh.pts.length > 2 ? ' ' + sh.pts.length + 'p' : ''}</span>
      ${hasErr ? '<span class="er">⚠</span>' : ''}</div>`;
  });
  html += `</div>`;

  if(!sel){
    html += `<div class="ep-hint ep-div">객체를 클릭해 선택하거나, 빈 곳을 <b>더블클릭</b>해 누락된 객체 위치를 표시한 뒤 오류 종류를 고르세요.<br>(오류 종류·메모는 영문으로 기록되어 리포트에 그대로 나갑니다.)</div>`;
  } else {
    let selLabel;
    if(sel.mode === 'shape'){
      const sh = shapes[sel.i];
      selLabel = `#${sel.i+1} · <b>${sh.cls}: ${esc(CLS.nameOf(sh.cls))}</b> · ${KIND_LABEL[sh.kind]}` +
                 (sh.kind === 'polygon' || sh.kind === 'polyline' ? ` · 점 ${sh.pts.length}개` : '');
      const at = Object.entries(sh.attrs || {});
      if(at.length) selLabel += `<br><span class="muted">${at.map(([k,v]) => esc(k+'='+v)).join(' · ')}</span>`;
    } else selLabel = `Point (${Math.round(sel.x*100)}%, ${Math.round(sel.y*100)}%)`;
    html += `<div class="ep-sel ep-div">Selected: ${selLabel}</div>`;

    if(sel.mode === 'shape'){
      const sh = shapes[sel.i];
      html += `<div class="ep-corr-label muted">✎ 클래스 수정 (형상 유지):</div><div class="ep-types">` +
        ids.map(id => `<button class="ep-chg${sh.cls === id ? ' on' : ''}" data-cc="${id}">${id}: ${esc(CLS.nameOf(id))}</button>`).join('') +
        `</div><div class="ep-btns"><button class="btn danger" id="delShape">🗑 이 객체 삭제</button></div>`;
    }
    html += `<div class="ep-corr-label muted ep-div">Error check <span style="font-size:10px">(숫자키 1~${ERR_TYPES.length})</span>:</div>`;
    html += `<div class="ep-types">` +
      ERR_TYPES.map((t, i) => `<button class="ep-type${e && e.type === t ? ' on' : ''}" data-t="${esc(t)}">${i+1}. ${esc(t)}</button>`).join('') + `</div>`;
    if(e && needsClass(e.type)){
      html += `<div class="ep-corr-label muted">Correct class:</div><div class="ep-types">` +
        ids.map(id => `<button class="ep-cls${e.correct === id ? ' on' : ''}" data-c="${id}">${id}: ${esc(CLS.nameOf(id))}</button>`).join('') + `</div>`;
    }
    if(e && e.type === 'Consistency'){
      const refs = e.refs || [];
      html += `<div class="ep-corr-label muted">Compare with (neighbors) — 썸네일 클릭:</div><div class="ep-refs">`;
      for(let o = -5; o <= 5; o++){
        if(!o) continue;
        const j = S.lbIdx + o; if(j < 0 || j >= S.items.length) continue;
        const rb = S.items[j].base, on = refs.includes(rb);
        html += `<button class="ep-ref${on ? ' on' : ''}" data-r="${esc(rb)}" title="${esc(S.items[j].name)}">
          <img class="ep-thumb" data-tb="${esc(rb)}" alt=""><span>${o < 0 ? '◀' : '▶'}${Math.abs(o)}</span></button>`;
      }
      html += `</div>`;
      if(refs.length) html += `<div class="ep-refnames muted">↔ ${refs.map(b => esc(S.images.get(b) ? S.images.get(b).name : b)).join('<br>')}</div>`;
    }
    if(e){
      html += `<textarea id="errnote" placeholder="Note (optional) — 영문으로 쓰면 리포트에 그대로 나갑니다">${e.note ? esc(e.note) : ''}</textarea>`;
      html += `<div class="ep-btns"><button id="errClear" class="btn">Delete this error</button></div>`;
    }
  }
  if(arr.length){
    html += `<div class="ep-list"><div class="ep-corr-label muted">Errors in this image (${arr.length})</div>` + arr.map((x, n) => {
      const loc = x.kind === 'shape' ? `#${x.i+1}` : 'point';
      let corr = '';
      if(needsClass(x.type) && x.correct != null){
        const c = `${x.correct}: ${esc(CLS.nameOf(x.correct))}`;
        if(x.kind === 'shape' && shapes[x.i]){ const oc = shapes[x.i].cls; corr = ` ${oc}: ${esc(CLS.nameOf(oc))} → ${c}`; }
        else corr = ` → ${c}`;
      }
      const isSel = sel && ((sel.mode === 'shape' && x.kind === 'shape' && x.i === sel.i) ||
                            (sel.mode === 'point' && x.kind === 'point' && x.x === sel.x && x.y === sel.y));
      return `<div class="ep-item${isSel ? ' on' : ''}" data-i="${n}"><b>${cnum(n+1)}</b> <span class="muted">[${loc}]</span> ${esc(x.type || '')}${corr}${x.note ? ' — ' + esc(x.note) : ''}</div>`;
    }).join('') + `</div>`;
  }
  p.innerHTML = html;

  p.querySelectorAll('.ob-row[data-oi]').forEach(el => el.onclick = () => selectShape(base, +el.dataset.oi));
  p.querySelectorAll('.ep-type').forEach(b => b.onclick = () => setError(base, b.dataset.t));
  p.querySelectorAll('.ep-chg').forEach(b => b.onclick = () => { if(sel && sel.mode === 'shape') changeClass(base, sel.i, +b.dataset.cc); });
  p.querySelectorAll('.ep-cls').forEach(b => b.onclick = () => setCorrect(base, +b.dataset.c));
  p.querySelectorAll('.ep-ref').forEach(b => b.onclick = () => toggleRef(base, b.dataset.r));
  p.querySelectorAll('.ep-thumb').forEach(img => {
    const b = img.dataset.tb;
    if(thumbCache.has(b)) img.src = thumbCache.get(b);
    else ensureThumb(b).then(u => { if(u) img.src = u; });
  });
  p.querySelectorAll('.ep-item').forEach(el => el.onclick = () => selectErrIdx(base, +el.dataset.i));
  const note = $('errnote'); if(note) note.oninput = () => updateNote(base, note.value);
  const clr = $('errClear'); if(clr) clr.onclick = () => clearError(base);
  const del = $('delShape');
  if(del) del.onclick = () => {
    if(!sel || sel.mode !== 'shape') return;
    if(!confirm(`객체 #${sel.i+1} (${CLS.nameOf(shapes[sel.i].cls)})를 삭제할까요?\n「수정 라벨 저장」으로 내보내야 원본에 반영됩니다.`)) return;
    deleteShape(base, sel.i);
  };
}

/* ---- 돋보기 ---- */
function hideLoupe(){ $('loupe').classList.remove('on'); }
function drawLoupe(){
  if(!loupeEnabled || !lastMouse){ hideLoupe(); return; }
  const cv = $('lbcv'), lp = $('loupe'), r = cv.getBoundingClientRect();
  const mx = lastMouse.x - r.left, my = lastMouse.y - r.top;
  if(mx < 0 || my < 0 || mx > r.width || my > r.height){ hideLoupe(); return; }
  const sx = mx * cv.width / r.width, sy = my * cv.height / r.height;
  if(lp.width !== LOUPE_SIZE) lp.width = lp.height = LOUPE_SIZE;
  const g = lp.getContext('2d');
  const src = LOUPE_SIZE / loupeZoom;
  g.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  g.imageSmoothingEnabled = false;
  g.drawImage(cv, sx - src/2, sy - src/2, src, src, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
  g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1;
  g.beginPath();
  g.moveTo(LOUPE_SIZE/2, LOUPE_SIZE/2 - 8); g.lineTo(LOUPE_SIZE/2, LOUPE_SIZE/2 + 8);
  g.moveTo(LOUPE_SIZE/2 - 8, LOUPE_SIZE/2); g.lineTo(LOUPE_SIZE/2 + 8, LOUPE_SIZE/2);
  g.stroke();
  const stage = $('lbstage').getBoundingClientRect();
  lp.style.left = (lastMouse.x - stage.left - LOUPE_SIZE/2) + 'px';
  lp.style.top  = (lastMouse.y - stage.top  - LOUPE_SIZE/2) + 'px';
  lp.classList.add('on');
}
function setLoupe(on){
  loupeEnabled = on;
  $('lbcv').style.cursor = on ? 'none' : 'crosshair';
  on ? drawLoupe() : hideLoupe();
}
function setZoom(z){
  loupeZoom = Math.max(2, Math.min(12, z));
  $('loupeZoom').value = loupeZoom; $('loupeZoomV').textContent = loupeZoom + '×';
  drawLoupe();
}
$('loupeOn').addEventListener('change', e => setLoupe(e.target.checked));
$('loupeZoom').addEventListener('input', e => setZoom(+e.target.value));
$('lbcv').addEventListener('mousemove', e => { lastMouse = {x:e.clientX, y:e.clientY}; if(loupeEnabled) drawLoupe(); });
$('lbcv').addEventListener('mouseleave', () => { lastMouse = null; hideLoupe(); });
/* 캔버스 위 좌표 → 원본 이미지 픽셀 좌표 (잘라 보기 상태를 반영) */
function lbPoint(e){
  const cv = $('lbcv'), r = cv.getBoundingClientRect();
  const d = S.lbDim || {W:cv.width, H:cv.height, vp:{x:0, y:0, w:cv.width, h:cv.height}};
  const vp = d.vp || {x:0, y:0, w:cv.width, h:cv.height};
  const inX = (e.clientX - r.left) / r.width, inY = (e.clientY - r.top) / r.height;
  return {x: vp.x + inX*vp.w, y: vp.y + inY*vp.h, W:d.W, H:d.H, inside: inX >= 0 && inY >= 0 && inX <= 1 && inY <= 1};
}
$('lbcv').addEventListener('click', e => {
  const it = S.items[S.lbIdx]; if(!it) return;
  const p = lbPoint(e); if(!p.inside) return;
  const i = hitTest(shapesOf(it.base), p.x, p.y, p.W, p.H);
  if(i >= 0) selectShape(it.base, i);
});
$('lbcv').addEventListener('dblclick', e => {
  const it = S.items[S.lbIdx]; if(!it) return;
  const p = lbPoint(e); if(!p.inside) return;
  selectPointAt(it.base, p.x / p.W, p.y / p.H);
});
$('lb').querySelector('.close').onclick = closeLightbox;
$('lb').querySelector('.prev').onclick = () => lbStep(-1);
$('lb').querySelector('.next').onclick = () => lbStep(1);
$('lb').onclick = e => { if(e.target.id === 'lb' || e.target.id === 'lbmain') closeLightbox(); };

/* ---- 키보드 ---- */
function redrawAll(){ renderPage(); if(lbOn()) drawLightbox(); }
document.addEventListener('keydown', e => {
  const t = e.target;
  if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if(e.code === 'KeyH'){
    const on = !$('showShapes').checked;
    $('showShapes').checked = on; VIEW.show = on;
    $('labelMode').value = on ? 'class' : 'off'; VIEW.labelMode = on ? 'class' : 'off';
    redrawAll(); e.preventDefault(); return;
  }
  if(e.code === 'KeyA'){   // 라벨 영역만 크게 보기 토글
    $('fitAnn').checked = !$('fitAnn').checked;
    VIEW.fitAnn = $('fitAnn').checked; redrawAll(); e.preventDefault(); return;
  }
  if(!lbOn()) return;
  if(e.code === 'KeyD'){ lbStep(-1); e.preventDefault(); return; }
  if(e.code === 'KeyF'){ lbStep(1);  e.preventDefault(); return; }
  if(e.code === 'KeyZ'){ $('loupeOn').checked = !$('loupeOn').checked; setLoupe($('loupeOn').checked); e.preventDefault(); return; }
  if(e.key === 'Escape'){ closeLightbox(); return; }
  if(e.key === 'ArrowLeft'){ lbStep(-1); return; }
  if(e.key === 'ArrowRight'){ lbStep(1); return; }
  if(e.key === '+' || e.key === '='){ setZoom(loupeZoom + 1); e.preventDefault(); return; }
  if(e.key === '-' || e.key === '_'){ setZoom(loupeZoom - 1); e.preventDefault(); return; }
  if(e.key === 'Tab'){                       // 다음 객체로 선택 이동
    const it = S.items[S.lbIdx]; if(!it) return;
    const n = shapesOf(it.base).length; if(!n) return;
    const cur = (S.sel && S.sel.mode === 'shape') ? S.sel.i : -1;
    selectShape(it.base, (cur + (e.shiftKey ? n - 1 : 1)) % n);
    e.preventDefault(); return;
  }
  if(e.key === 'Delete' || e.key === 'Backspace'){
    if(S.sel && curErr()){ clearError(S.selBase); e.preventDefault(); }
    return;
  }
  const num = parseInt(e.key, 10);
  if(num >= 1 && num <= ERR_TYPES.length && S.sel){ setError(S.selBase, ERR_TYPES[num-1]); e.preventDefault(); }
});

/* ========================= 통계 ========================= */
function errorStats(){
  let total = 0, shapeErr = 0, pointErr = 0, images = 0, objsInErrored = 0;
  let other = 0, otherImages = 0;       // 지금 열려 있지 않은 이미지의 오류 (기록은 남아 있음)
  const byType = {}, byClass = {};
  for(const [base, arr] of S.errors){
    if(!arr || !arr.length) continue;
    if(S.images.size && !S.images.has(base)){ other += arr.length; otherImages++; continue; }
    images++; total += arr.length;
    const shapes = shapesOf(base);
    objsInErrored += shapes.length;
    for(const e of arr){
      if(e.kind === 'shape'){ shapeErr++; const sh = shapes[e.i]; if(sh) byClass[sh.cls] = (byClass[sh.cls] || 0) + 1; }
      else pointErr++;
      byType[e.type || '(미지정)'] = (byType[e.type || '(미지정)'] || 0) + 1;
    }
  }
  return {total, shapeErr, pointErr, images, objsInErrored, byType, byClass, other, otherImages,
          ratio: objsInErrored ? shapeErr / objsInErrored : 0};
}
function renderStats(){
  const el = $('stBody');
  if(!S.images.size){ el.innerHTML = '<span class="muted">먼저 이미지·라벨을 선택하세요.</span>'; return; }
  const cc = countsByClass(), kc = countsByKind(), E = errorStats();
  let labeled = 0, objs = 0;
  for(const [b] of S.images){ const n = shapesOf(b).length; if(n) labeled++; objs += n; }
  const ids = classIds().filter(id => cc[id]);
  const maxC = Math.max(1, ...ids.map(id => cc[id] || 0));
  const clsRows = ids.map(id => {
    const c = cc[id] || 0, pct = objs ? c/objs*100 : 0;
    return `<tr><td><span class="sw" style="background:${colorFor(id)}"></span>${id}: ${esc(CLS.nameOf(id))}</td>
      <td style="width:42%"><div class="st-bar"><span style="width:${Math.round(c/maxC*100)}%;background:${colorFor(id)}"></span></div></td>
      <td class="num">${c}</td><td class="num muted">${pct.toFixed(1)}%</td>
      <td class="num ${E.byClass[id] ? 'badge-err' : 'muted'}">${E.byClass[id] || 0}</td></tr>`;
  }).join('');
  const kinds = KINDS.filter(k => kc[k]);
  const maxK = Math.max(1, ...kinds.map(k => kc[k]));
  const kindRows = kinds.map(k =>
    `<tr><td>${KIND_LABEL[k]}</td>
      <td style="width:42%"><div class="st-bar"><span style="width:${Math.round(kc[k]/maxK*100)}%;background:var(--blue-2)"></span></div></td>
      <td class="num">${kc[k]}</td><td class="num muted">${objs ? (kc[k]/objs*100).toFixed(1) : 0}%</td></tr>`).join('');
  const typeRows = Object.keys(E.byType).length
    ? Object.entries(E.byType).sort((a,b) => b[1]-a[1]).map(([t, n]) =>
        `<tr><td>${esc(t)}</td><td class="num">${n}</td><td class="num muted">${E.total ? (n/E.total*100).toFixed(1) : 0}%</td></tr>`).join('')
    : '<tr><td class="muted" colspan="3">기록된 오류가 없습니다.</td></tr>';

  el.innerHTML = `
    <div class="st-h">라벨 현황</div>
    <div class="st-kpis">
      <div class="st-kpi"><div class="v">${S.images.size}</div><div class="l">이미지</div></div>
      <div class="st-kpi"><div class="v">${labeled}</div><div class="l">라벨 있는 이미지</div></div>
      <div class="st-kpi"><div class="v">${S.images.size - labeled}</div><div class="l">라벨 없는 이미지</div></div>
      <div class="st-kpi"><div class="v">${objs}</div><div class="l">전체 객체</div></div>
      <div class="st-kpi"><div class="v">${labeled ? (objs/labeled).toFixed(2) : '0.00'}</div><div class="l">이미지당 평균 객체</div></div>
    </div>
    <div class="st-h">클래스별</div>
    <table><tr><th>클래스</th><th></th><th class="num">객체</th><th class="num">비율</th><th class="num">오류</th></tr>${clsRows}</table>
    <div class="st-h">도형 유형별</div>
    <table><tr><th>유형</th><th></th><th class="num">객체</th><th class="num">비율</th></tr>${kindRows}</table>
    <div class="st-h">검수 오류</div>
    <div class="st-kpis">
      <div class="st-kpi"><div class="v">${E.total}</div><div class="l">오류 노트 (객체 ${E.shapeErr} · 지점 ${E.pointErr})</div></div>
      <div class="st-kpi"><div class="v">${E.images}</div><div class="l">오류 있는 이미지</div></div>
      <div class="st-kpi"><div class="v">${Math.round(E.ratio*100)}%</div><div class="l">오류 객체 비율 (${E.shapeErr}/${E.objsInErrored})</div></div>
    </div>
    <table><tr><th>오류 종류</th><th class="num">건수</th><th class="num">비율</th></tr>${typeRows}</table>
    <div class="muted" style="margin-top:6px">· 오류 객체 비율 = 오류를 기록한 이미지들의 전체 객체 수 대비 오류로 표시한 객체 수.` +
      (E.other ? `<br>· 지금 열려 있지 않은 이미지의 오류 <b>${E.other}건</b>(이미지 ${E.otherImages}장)은 집계에서 제외했습니다. 기록은 남아 있습니다.` : '') +
    `</div>`;
}

/* ========================= ZIP (무압축) ========================= */
const _enc = s => new TextEncoder().encode(s);
function crc32(buf){
  let c = ~0 >>> 0;
  for(let i = 0; i < buf.length; i++){ c ^= buf[i]; for(let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function zipStore(entries, mime){
  const parts = [], central = []; let offset = 0;
  for(const e of entries){
    const nameB = _enc(e.name), crc = crc32(e.data), size = e.data.length;
    const lh = new Uint8Array(30 + nameB.length), dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, size, true); dv.setUint32(22, size, true);
    dv.setUint16(26, nameB.length, true); lh.set(nameB, 30);
    parts.push(lh, e.data);
    const cd = new Uint8Array(46 + nameB.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true); cd.set(nameB, 46);
    central.push(cd);
    offset += lh.length + e.data.length;
  }
  let cdSize = 0; central.forEach(c => cdSize += c.length);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], {type: mime || 'application/zip'});
}
function download(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ========================= 수정 라벨 내보내기 ========================= */
function exportLabels(){
  if(!S.changed.size && !S.cocoChanged && !S.labelitChanged){
    alert('변경된 라벨이 없습니다.\n(클래스 수정 또는 객체 삭제 후 저장하세요.)'); return;
  }
  const entries = [];
  for(const base of S.changed){
    const d = S.docs.get(base); if(!d || d.fmt === 'coco' || d.fmt === 'labelit') continue;
    const shapes = shapesOf(base).filter(s => !s.src || (s.src.fmt !== 'coco' && s.src.fmt !== 'labelit'));
    let text = '', name = d.file ? d.file.name : base;
    if(d.fmt === 'yolo') text = shapes.map(yoloLine).join('\n') + (shapes.length ? '\n' : '');
    else if(d.fmt === 'voc') text = serializeVoc(d.doc, shapes);
    else if(d.fmt === 'labelme') text = serializeLabelMe(d.obj, shapes);
    else continue;
    entries.push({name, data:_enc(text)});
  }
  if(S.labelitChanged && S.labelit){
    const kept = new Set(), clsOf = new Map(), fieldOf = new Map();
    for(const [, arr] of S.shapes) for(const sh of arr)
      if(sh.src && sh.src.fmt === 'labelit'){ kept.add(sh.src.ref); clsOf.set(sh.src.ref, sh.cls); fieldOf.set(sh.src.ref, sh.src.field); }
    const text = serializeLabelit(S.labelit.records, kept, clsOf, fieldOf);
    const nm = S.labelit.file ? S.labelit.file.name.replace(/\.(json|jsonl|ndjson)$/i, '') : 'labelit';
    entries.push({name: nm + '_edited.json', data:_enc(text)});
  }
  if(S.cocoChanged && S.coco){
    const kept = new Set(), clsOf = new Map();
    for(const [, arr] of S.shapes) for(const sh of arr)
      if(sh.src && sh.src.fmt === 'coco'){ kept.add(sh.src.ann); clsOf.set(sh.src.ann, sh.cls); }
    const text = serializeCoco(S.coco.json, kept, clsOf);
    entries.push({name: (S.coco.file ? S.coco.file.name.replace(/\.json$/i, '') : 'coco') + '_edited.json', data:_enc(text)});
  }
  if(!entries.length){ alert('내보낼 라벨이 없습니다.'); return; }
  if(entries.length === 1){
    download(new Blob([entries[0].data], {type:'application/json'}), entries[0].name);
  } else {
    download(zipStore(entries), `labels_edited_${todayYMD()}.zip`);
  }
  alert(`수정된 라벨 ${entries.length}개를 내보냈습니다.\n원본 라벨을 이 파일로 교체하세요. (클래스 수정·객체 삭제 반영)`);
}

/* ========================= 오류 CSV ========================= */
function exportCsv(){
  const rows = [['Image','Location','Shape','Current class','Error type','Correct class','Compared with','Note']];
  const withErr = [...S.errors.keys()].filter(b => (S.errors.get(b) || []).length);
  /* 지금 열려 있는 이미지만 (다른 폴더의 기록은 제외하고 안내) */
  const bases = S.images.size ? withErr.filter(b => S.images.has(b)) : withErr;
  const skipped = withErr.length - bases.length;
  bases.sort((a, b) => (S.images.get(a)?.name || a).localeCompare(S.images.get(b)?.name || b));
  if(!bases.length){
    alert(skipped ? `지금 열려 있는 이미지에는 오류 기록이 없습니다.\n(다른 폴더 이미지의 기록 ${skipped}장분은 제외됩니다.)`
                  : '기록된 오류가 없습니다.');
    return;
  }
  for(const base of bases){
    const name = S.images.get(base) ? S.images.get(base).name : base;
    const shapes = shapesOf(base);
    for(const e of S.errors.get(base)){
      const sh = e.kind === 'shape' ? shapes[e.i] : null;
      rows.push([
        name,
        e.kind === 'shape' ? `#${e.i+1}` : `point ${Math.round(e.x*1000)/10}%,${Math.round(e.y*1000)/10}%`,
        sh ? KIND_EN[sh.kind] : '',
        sh ? `${sh.cls}: ${CLS.nameOf(sh.cls)}` : '',
        e.type || '',
        e.correct != null ? `${e.correct}: ${CLS.nameOf(e.correct)}` : '',
        (e.refs || []).map(b => S.images.get(b) ? S.images.get(b).name : b).join(' | '),
        e.note || ''
      ]);
    }
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'}), `review_errors_${todayYMD()}.csv`);
  if(skipped) alert(`현재 폴더에 없는 이미지 ${skipped}장의 오류는 제외했습니다.\n(기록은 남아 있으며, 해당 폴더를 열면 다시 보입니다.)`);
}

/* ========================= 검수 기록 저장/불러오기 ========================= */
function saveReview(){
  const o = {};
  for(const [b, arr] of S.errors) if(arr && arr.length) o[b] = arr;
  if(!Object.keys(o).length){ alert('저장할 검수 기록이 없습니다.'); return; }
  download(new Blob([JSON.stringify({tool:'unified-review', version:1, savedAt:new Date().toISOString(), errors:o}, null, 2)],
    {type:'application/json'}), `review_log_${todayYMD()}.json`);
}
$('loadReview').addEventListener('change', async e => {
  const f = e.target.files[0]; if(!f) return;
  let j; try{ j = JSON.parse(await f.text()); }catch(err){ alert('JSON을 읽지 못했습니다.'); return; }
  const src = j.errors || j;
  if(typeof src !== 'object'){ alert('형식이 올바르지 않습니다.'); return; }
  let n = 0;
  const merge = confirm('기존 검수 기록에 합칠까요?\n[확인] 합치기 · [취소] 기존 기록을 지우고 불러오기');
  if(!merge) S.errors.clear();
  for(const b in src){
    if(!Array.isArray(src[b]) || !src[b].length) continue;
    const cur = merge ? (S.errors.get(b) || []) : [];
    S.errors.set(b, cur.concat(src[b].map(migrateErr))); n += src[b].length;
  }
  saveErrors(); applyFilterSort(); renderPage();
  if(lbOn()){ renderSide(); drawLightbox(); }
  alert(`검수 기록 ${n}건을 불러왔습니다.`);
  e.target.value = '';
});

/* ========================= PPTX 리포트 ========================= */
const PPTX_NS = {
  a:'http://schemas.openxmlformats.org/drawingml/2006/main',
  r:'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p:'http://schemas.openxmlformats.org/presentationml/2006/main'
};
const SLIDE_W = 12192000, SLIDE_H = 6858000;   // 16:9 (EMU)
let PPTX_MAX_PX = 1920;                        // 슬라이드에 넣을 이미지의 긴 변 최대 픽셀
function pptxTheme(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${PPTX_NS.a}" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}
function pptxMaster(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${PPTX_NS.a}" xmlns:r="${PPTX_NS.r}" xmlns:p="${PPTX_NS.p}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
}
function pptxLayout(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${PPTX_NS.a}" xmlns:r="${PPTX_NS.r}" xmlns:p="${PPTX_NS.p}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}
/* -----------------------------------------------------------------------
   슬라이드 레이아웃 (16:9)
     ┌───────────────────────────────────────────────┐
     │ 파일명                          N error(s)    │  제목 바
     ├──────────────────────────┬────────────────────┤
     │  이미지(오류 번호 배지)    │  ① Wrong class     │
     │                          │    box #3 · polygon │
     │                          │    0: Crack → 2: … │
     │                          │    "note"          │
     └──────────────────────────┴────────────────────┘
   ----------------------------------------------------------------------- */
const PP = {
  M: 274320,          // 여백 0.3"
  BAR_H: 900000,      // 제목 바 높이
  PANEL_W: 4400000,   // 오른쪽 오류 패널 폭
  navy:'1F3A93', white:'FFFFFF', soft:'D2E0FB',
  panelBg:'F7FAFF', panelLine:'CCDAF2', imgBg:'E9EEF7',
  red:'C0392B', gray:'5A6B85', ink:'121C2E', blue:'1F6FB2'
};
/* --- OOXML 조각 헬퍼 --- */
function ppRun(t, o){
  o = o || {};
  const fill = o.color ? `<a:solidFill><a:srgbClr val="${o.color}"/></a:solidFill>` : '';
  return `<a:r><a:rPr lang="en-US" altLang="ko-KR" sz="${o.sz || 1200}"${o.b ? ' b="1"' : ''}${o.i ? ' i="1"' : ''}>${fill}</a:rPr><a:t>${xmlEsc(t)}</a:t></a:r>`;
}
function ppPara(runs, o){
  o = o || {};
  const spc = o.spcBef ? `<a:spcBef><a:spcPts val="${o.spcBef}"/></a:spcBef>` : '';
  return `<a:p><a:pPr marL="${o.marL || 0}" indent="0"${o.algn ? ` algn="${o.algn}"` : ''}>${spc}<a:buNone/></a:pPr>${runs}</a:p>`;
}
function ppTx(paras, o){
  o = o || {};
  const ins = o.ins != null ? o.ins : 91440;
  return `<p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" anchor="${o.anchor || 't'}" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody>`;
}
function ppShape(id, name, x, y, w, h, o){
  o = o || {};
  const fill = o.fill ? `<a:solidFill><a:srgbClr val="${o.fill}"/></a:solidFill>` : '<a:noFill/>';
  const line = o.line ? `<a:ln w="${o.lineW || 12700}"><a:solidFill><a:srgbClr val="${o.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const geom = o.prst === 'roundRect'
    ? '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 4500"/></a:avLst></a:prstGeom>'
    : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${o.txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>` +
         `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>${geom}${fill}${line}</p:spPr>` +
         (o.tx || ppTx('')) + `</p:sp>`;
}

/* 오류 하나가 패널에서 차지하는 줄 수(대략) — 슬라이드 분할 기준 */
function errLines(e){
  let n = 2;                                             // 오류 종류 + 위치
  if(e.correct != null || e.kind === 'shape') n += 1;     // 클래스 줄
  if(e.note && e.note.trim()) n += Math.ceil(e.note.trim().length / 38);
  if(Array.isArray(e.refs) && e.refs.length) n += 1;
  return n + 0.6;                                        // 항목 사이 여백
}
/* 패널 높이에 맞게 오류 목록을 슬라이드 단위로 자른다 (넘치면 같은 이미지로 다음 장) */
function chunkErrors(list, budget){
  budget = budget || 21;
  const out = []; let cur = [], used = 0;
  for(const e of list){
    const L = errLines(e);
    if(cur.length && used + L > budget){ out.push(cur); cur = []; used = 0; }
    cur.push(e); used += L;
  }
  if(cur.length) out.push(cur);
  return out.length ? out : [[]];
}

/* pics: [{rid,w,h}] (0번이 현재 이미지)
   meta: {index,total,fmt, offset,part,parts,errTotal} — offset은 이미지 위 번호 배지와 맞추기 위한 시작 번호 */
function pptxSlide(pics, name, errList, shapes, meta){
  meta = meta || {};
  const off = meta.offset || 0, parts = meta.parts || 1;
  const M = PP.M, barH = PP.BAR_H, panelW = PP.PANEL_W;
  const contentY = barH + M, contentH = SLIDE_H - contentY - M;
  const panelX = SLIDE_W - M - panelW;
  const imgX = M, imgW = panelX - M*2, imgH = contentH;

  /* --- 이미지 배치 (여러 장이면 격자) --- */
  const n = pics.length;
  const cols = n <= 1 ? 1 : (n <= 2 ? 2 : (n <= 4 ? 2 : 3)), rows = Math.ceil(n / cols);
  const gap = M * 0.6;
  const cellW = (imgW - gap*(cols-1)) / cols, cellH = (imgH - gap*(rows-1)) / rows;
  let picsXml = '';
  pics.forEach((im, idx) => {
    const gx = idx % cols, gy = Math.floor(idx / cols);
    const cellX = imgX + gx*(cellW + gap), cellY = contentY + gy*(cellH + gap);
    const s = Math.min(cellW/im.w, cellH/im.h);
    const dw = Math.round(im.w*s), dh = Math.round(im.h*s);
    const dx = Math.round(cellX + (cellW-dw)/2), dy = Math.round(cellY + (cellH-dh)/2);
    picsXml += `<p:pic><p:nvPicPr><p:cNvPr id="${20+idx}" name="image${idx+1}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${im.rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${dx}" y="${dy}"/><a:ext cx="${dw}" cy="${dh}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:srgbClr val="${PP.panelLine}"/></a:solidFill></a:ln></p:spPr></p:pic>`;
  });

  /* --- 제목 바: 파일명(좌) · 오류 수/포맷(우) --- */
  const title = name + (parts > 1 ? `   (${meta.part}/${parts})` : '');
  const bar = ppShape(2, 'titlebar', 0, 0, SLIDE_W, barH, {fill: PP.navy,
    tx: ppTx(ppPara(ppRun(title, {sz:1900, b:true, color:PP.white})), {anchor:'ctr', ins:M})});
  const errTotal = meta.errTotal != null ? meta.errTotal : errList.length;
  const right = `${errTotal} error${errTotal === 1 ? '' : 's'}` +
                (parts > 1 ? `   ·   #${off+1}–${off+errList.length}` : '') +
                (meta.total ? `   ·   ${meta.index}/${meta.total}` : '') +
                (meta.fmt ? `   ·   ${meta.fmt}` : '');
  const barRight = ppShape(3, 'titleinfo', panelX - M, 0, panelW + M, barH, {txBox:true,
    tx: ppTx(ppPara(ppRun(right, {sz:1300, color:PP.soft}), {algn:'r'}), {anchor:'ctr', ins:M})});

  /* --- 오른쪽 오류 패널 --- */
  const used = errList.reduce((s, e) => s + errLines(e), 0);
  const k = used <= 11 ? 1 : (used <= 15 ? 0.92 : 0.85);
  const sz = v => Math.round(v * k);
  const IND = 320000;
  let paras = ppPara(ppRun('ERROR CHECK', {sz:sz(1050), b:true, color:PP.gray}));
  errList.forEach((e, i) => {
    const sh = e.kind === 'shape' ? shapes[e.i] : null;
    /* ① 오류 종류 — 이미지 위 빨간 번호 배지와 같은 번호 */
    paras += ppPara(ppRun(`${cnum(off + i + 1)}  ${e.type || '(unspecified)'}`, {sz:sz(1500), b:true, color:PP.red}),
                    {spcBef: i ? 1000 : 700});
    /* 위치 · 도형 종류 */
    const loc = e.kind === 'shape'
      ? `object #${e.i+1}${sh ? ' · ' + KIND_EN[sh.kind] : ''}`
      : `missing at (${Math.round(e.x*100)}%, ${Math.round(e.y*100)}%)`;
    paras += ppPara(ppRun(loc, {sz:sz(1050), color:PP.gray}), {marL:IND, spcBef:120});
    /* 클래스: 현재 → 정답 */
    if(sh || (needsClass(e.type) && e.correct != null)){
      let runs = '';
      if(sh) runs += ppRun(`${sh.cls}: ${CLS.nameOf(sh.cls)}`, {sz:sz(1300), color:PP.ink});
      /* 정답 클래스가 현재와 같으면 화살표는 군더더기라 생략 */
      if(needsClass(e.type) && e.correct != null && !(sh && sh.cls === e.correct)){
        if(sh) runs += ppRun('   →   ', {sz:sz(1300), color:PP.gray});
        runs += ppRun(`${e.correct}: ${CLS.nameOf(e.correct)}`, {sz:sz(1300), b:true, color:PP.blue});
      }
      paras += ppPara(runs, {marL:IND, spcBef:120});
    }
    /* 메모 */
    if(e.note && e.note.trim())
      paras += ppPara(ppRun('“' + e.note.trim() + '”', {sz:sz(1200), i:true, color:PP.ink}), {marL:IND, spcBef:160});
    /* 비교 대상 */
    if(Array.isArray(e.refs) && e.refs.length)
      paras += ppPara(ppRun('↔ compared with: ' + e.refs.map(b => S.images.get(b) ? S.images.get(b).name : b).join(', '),
                            {sz:sz(1000), color:PP.gray}), {marL:IND, spcBef:160});
  });
  const panel = ppShape(4, 'errpanel', panelX, contentY, panelW, contentH,
    {fill: PP.panelBg, line: PP.panelLine, prst:'roundRect', tx: ppTx(paras, {ins:228600})});

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${PPTX_NS.a}" xmlns:r="${PPTX_NS.r}" xmlns:p="${PPTX_NS.p}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${picsXml}${bar}${barRight}${panel}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function labelCanvas(cv, text, isCurrent){
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  const fs = Math.max(14, Math.round(Math.min(W,H)/24));
  ctx.save();
  ctx.font = `700 ${fs}px sans-serif`; ctx.textBaseline = 'top';
  const label = (isCurrent ? '▶ ' : '') + text;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = isCurrent ? 'rgba(31,58,147,.92)' : 'rgba(0,0,0,.72)';
  ctx.fillRect(0, 0, Math.min(W, tw + 16), fs + 10);
  ctx.fillStyle = '#fff'; ctx.fillText(label, 8, 5);
  if(isCurrent){ const lw = Math.max(4, Math.min(W,H)/100);
    ctx.strokeStyle = '#ffd400'; ctx.lineWidth = lw; ctx.strokeRect(lw/2, lw/2, W-lw, H-lw); }
  ctx.restore();
}
async function exportPptx(){
  const bases = [...S.errors.keys()].filter(b => (S.errors.get(b) || []).length && S.images.has(b));
  if(!bases.length){ alert('오류가 기록된 이미지가 없습니다.\n확대 화면에서 객체를 클릭하거나 빈 곳을 더블클릭해 오류를 지정하세요.'); return; }
  bases.sort((a, b) => S.images.get(a).name.localeCompare(S.images.get(b).name));
  const btn = $('exportPptx'), old = btn.textContent; btn.disabled = true;

  async function renderImg(ib, withBanner, isCurrent){
    const meta = S.images.get(ib);
    let cv = document.createElement('canvas');
    const {im, url} = await loadImg(meta.file);
    drawScene(cv, im, shapesOf(ib), {errors: errsOf(ib), force:true});
    URL.revokeObjectURL(url);
    /* 슬라이드 폭이 13.3인치라 원본 그대로 넣으면 파일만 커진다 → 긴 변 기준 축소 */
    const big = Math.max(cv.width, cv.height);
    if(big > PPTX_MAX_PX){
      const s = PPTX_MAX_PX / big, out = document.createElement('canvas');
      out.width = Math.round(cv.width*s); out.height = Math.round(cv.height*s);
      const c = out.getContext('2d');
      c.imageSmoothingQuality = 'high';
      c.drawImage(cv, 0, 0, out.width, out.height);
      cv = out;
    }
    if(withBanner) labelCanvas(cv, meta.name, isCurrent);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
    return {bytes:new Uint8Array(await blob.arrayBuffer()), w:cv.width, h:cv.height};
  }

  const slides = [], media = []; let mediaN = 0;
  for(let i = 0; i < bases.length; i++){
    const base = bases[i], errList = S.errors.get(base) || [];
    btn.textContent = `내보내는 중… ${i+1}/${bases.length}`;
    const refSet = new Set();
    for(const e of errList) if(Array.isArray(e.refs))
      for(const rb of e.refs) if(rb !== base && S.images.has(rb)) refSet.add(rb);
    const involved = [base, ...refSet].slice(0, 6);
    const multi = involved.length > 1;
    const pics = [], rels = [];
    for(let k = 0; k < involved.length; k++){
      let r; try{ r = await renderImg(involved[k], multi, involved[k] === base); }catch(e){ continue; }
      mediaN++;
      media.push({name:`ppt/media/image${mediaN}.jpeg`, data:r.bytes});
      const rid = 'rId' + (k + 2);
      rels.push({rid, target:`../media/image${mediaN}.jpeg`});
      pics.push({rid, w:r.w, h:r.h});
    }
    if(!pics.length) continue;
    const d = S.docs.get(base);
    const FMT_LABEL = {yolo:'YOLO', voc:'VOC XML', labelme:'LabelMe', coco:'COCO', labelit:'labelit.pro'};
    /* 오류가 많으면 패널을 넘치므로 같은 이미지를 여러 슬라이드로 나눠 싣는다 */
    const chunks = chunkErrors(errList);
    let off = 0;
    chunks.forEach((chunk, ci) => {
      slides.push({xml: pptxSlide(pics, S.images.get(base).name, chunk, shapesOf(base),
        {index:i+1, total:bases.length, fmt: d ? (FMT_LABEL[d.fmt] || d.fmt) : '',
         offset:off, part:ci+1, parts:chunks.length, errTotal:errList.length}), rels});
      off += chunk.length;
    });
  }

  const n = slides.length;
  let ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`;
  for(let i = 1; i <= n; i++) ct += `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  ct += `</Types>`;
  const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  let presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`;
  let sldIds = '';
  for(let i = 0; i < n; i++){
    const rid = 'rId' + (i + 2);
    presRels += `<Relationship Id="${rid}" Type="${RT}/slide" Target="slides/slide${i+1}.xml"/>`;
    sldIds += `<p:sldId id="${256+i}" r:id="${rid}"/>`;
  }
  presRels += `</Relationships>`;
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${PPTX_NS.a}" xmlns:r="${PPTX_NS.r}" xmlns:p="${PPTX_NS.p}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const masterRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${RT}/theme" Target="../theme/theme1.xml"/></Relationships>`;
  const layoutRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  const entries = [
    {name:'[Content_Types].xml', data:_enc(ct)},
    {name:'_rels/.rels', data:_enc(rootRels)},
    {name:'ppt/presentation.xml', data:_enc(presentation)},
    {name:'ppt/_rels/presentation.xml.rels', data:_enc(presRels)},
    {name:'ppt/slideMasters/slideMaster1.xml', data:_enc(pptxMaster())},
    {name:'ppt/slideMasters/_rels/slideMaster1.xml.rels', data:_enc(masterRels)},
    {name:'ppt/slideLayouts/slideLayout1.xml', data:_enc(pptxLayout())},
    {name:'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data:_enc(layoutRels)},
    {name:'ppt/theme/theme1.xml', data:_enc(pptxTheme())}
  ];
  for(let i = 0; i < n; i++){
    entries.push({name:`ppt/slides/slide${i+1}.xml`, data:_enc(slides[i].xml)});
    let relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;
    for(const r of slides[i].rels) relsXml += `<Relationship Id="${r.rid}" Type="${RT}/image" Target="${r.target}"/>`;
    relsXml += `</Relationships>`;
    entries.push({name:`ppt/slides/_rels/slide${i+1}.xml.rels`, data:_enc(relsXml)});
  }
  media.forEach(m => entries.push(m));
  download(zipStore(entries, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
           `feedback_${todayYMD()}.pptx`);
  btn.disabled = false; btn.textContent = old;
  alert(`오류 이미지 ${bases.length}장 · 슬라이드 ${n}장을 PPTX로 내보냈습니다.`);
}

/* ========================= 컨트롤 배선 ========================= */
function refilter(){ applyFilterSort(); S.page = 0; renderPage(); }
$('viewSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  [...$('viewSeg').children].forEach(x => x.classList.toggle('on', x === b));
  S.view = b.dataset.v; S.page = 0; renderPage();
});
['fClass','fKind','fMode','fErr','fSort'].forEach(id => $(id).addEventListener('change', refilter));
$('perPage').addEventListener('change', () => { S.page = 0; renderPage(); });
$('cardSize').addEventListener('input', () => {
  $('grid').style.setProperty('--card', $('cardSize').value + 'px');
  if(S.view === 'object'){ clearTimeout(cardTimer); cardTimer = setTimeout(renderPage, 250); }
});
let cardTimer, styleTimer;
function applyStyle(){ if(lbOn()) drawLightbox(); clearTimeout(styleTimer); styleTimer = setTimeout(renderPage, 140); }
$('lineW').addEventListener('input', e => { VIEW.lineW = +e.target.value; applyStyle(); });
$('labelSize').addEventListener('input', e => { VIEW.labelScale = +e.target.value; applyStyle(); });
$('fillA').addEventListener('input', e => { VIEW.fillAlpha = +e.target.value; applyStyle(); });
$('labelMode').addEventListener('change', e => { VIEW.labelMode = e.target.value; redrawAll(); });
$('showShapes').addEventListener('change', e => { VIEW.show = e.target.checked; redrawAll(); });
$('showVerts').addEventListener('change', e => { VIEW.vertices = e.target.checked; redrawAll(); });
$('fitAnn').addEventListener('change', e => { VIEW.fitAnn = e.target.checked; redrawAll(); });
let qTimer;
$('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(refilter, 180); });
$('q').addEventListener('keydown', e => { if(e.key === 'Escape'){ $('q').value = ''; refilter(); } });
$('statsBtn').addEventListener('click', () => { $('statsmodal').classList.add('on'); renderStats(); });
$('helpBtn').addEventListener('click', () => $('helpmodal').classList.add('on'));
document.querySelectorAll('.modal').forEach(m => {
  m.querySelector('.tm-close').addEventListener('click', () => m.classList.remove('on'));
  m.addEventListener('click', e => { if(e.target === m) m.classList.remove('on'); });
});
$('exportLabels').addEventListener('click', exportLabels);
$('exportPptx').addEventListener('click', exportPptx);
$('exportCsv').addEventListener('click', exportCsv);
$('saveReview').addEventListener('click', saveReview);
$('clearErrors').addEventListener('click', () => {
  const total = [...S.errors.values()].reduce((s, a) => s + (a ? a.length : 0), 0);
  if(!total){ alert('삭제할 오류가 없습니다.'); return; }
  if(!confirm(`기록된 모든 오류 ${total}건을 삭제할까요?\n되돌릴 수 없습니다.`)) return;
  S.errors.clear(); saveErrors();
  S.sel = null;
  applyFilterSort(); S.page = 0; renderPage();
  if(lbOn()){ renderSide(); drawLightbox(); }
});

/* ========================= 초기화 ========================= */
S.errors = loadErrors();
updateErrStat();
buildLegends();
