'use strict';
// 검수 모드 — 세포막·세포핵 객체를 눌러 코멘트를 남기고, 코멘트가 있는 객체를 PPTX 리포트로 내보낸다.
// (app.js 다음에 읽힌다. app.js의 S·MASKS·CHANNELS·draw 등을 그대로 쓴다.)

const REVIEW_TYPES = ['경계 부정확', '분리 필요', '병합 필요', '대상 아님', '누락', '대응 오류', '기타'];
const REVIEW_FILE = '검수기록.json';
const cnum = (n) => (n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`);
const todayYMD = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };
const maskDef = (key) => MASKS.find((m) => m.key === key);

const R = { comments: [], sel: null, folder: '', selCanvas: null, selKey: '' };
// 코멘트: {id, set, key(마스크), label(번호, 누락 지점이면 0), x, y(누락 지점), type, note, at}

// ───────────────────────── 모드 전환 ─────────────────────────
function setMode(mode) {
  if (mode === S.mode) return;
  S.mode = mode;
  cancelVertex(true); S.poly = null; S.drag = null;
  document.body.classList.toggle('review', mode === 'review');
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (mode === 'review') { S.prevTool = S.tool; setTool('pan'); }
  else { R.sel = null; setTool(S.prevTool || 'pan'); }
  renderReviewPanel(); draw();
  msg(mode === 'review' ? '검수 모드 — 객체를 클릭해 코멘트를 남기세요. 마스크는 수정되지 않습니다.' : '작업 모드');
}

// ───────────────────────── 선택 ─────────────────────────
const setComments = (set) => R.comments.filter((c) => c.set === set);
const findComment = (sel) => sel && R.comments.find((c) => c.set === S.cur.name && (sel.id ? c.id === sel.id : c.key === sel.key && c.label === sel.label && sel.label));

function reviewClick(p, px, py, inside, e) {
  if (!inside) { R.sel = null; renderReviewPanel(); draw(); return; }
  // 1) 누락 지점 표시 근처를 누르면 그 코멘트 선택
  const near = setComments(S.cur.name).find((c) => !c.label && Math.hypot((c.x - p.ix) * S.view.s, (c.y - p.iy) * S.view.s) < 12);
  if (near) { R.sel = { id: near.id, key: near.key, label: 0 }; renderReviewPanel(); draw(); return; }
  // 2) 편집 대상 마스크 → 나머지 보이는 마스크 순서로 객체를 찾는다
  const order = [S.active, ...MASKS.map((m) => m.key).filter((k) => k !== S.active && S.layerUI[k]?.visible)];
  for (const key of order) {
    const m = S.cur.masks[key]; if (!m) continue;
    const label = m.data[py * S.cur.w + px];
    if (label) { R.sel = { key, label }; renderReviewPanel(); draw(); return; }
  }
  R.sel = null; renderReviewPanel(); draw();
  msg('객체가 없는 곳입니다. 빠진 세포를 표시하려면 더블클릭하세요.');
}

function reviewDblClick(p) {  // 빈 곳 더블클릭 = 누락 지점
  const px = Math.floor(p.ix), py = Math.floor(p.iy);
  if (px < 0 || py < 0 || px >= S.cur.w || py >= S.cur.h) return;
  const m = activeMask(); if (m && m.data[py * S.cur.w + px]) return;
  const c = addComment({ key: S.active, label: 0, x: p.ix, y: p.iy, type: '누락' });
  R.sel = { id: c.id, key: c.key, label: 0 }; renderReviewPanel(); draw();
  setTimeout(() => $('rv-note')?.focus(), 0);
}

function reviewKey(e) {  // 처리했으면 true
  const k = e.key;
  if (e.target instanceof Element && e.target.matches('textarea, input[type=text]')) {
    if (k === 'Escape') { e.target.blur(); return true; }
    return true;  // 메모 입력 중에는 단축키를 쓰지 않는다
  }
  const n = Number(k);
  if (n >= 1 && n <= REVIEW_TYPES.length && R.sel) { setType(REVIEW_TYPES[n - 1]); return true; }
  if ((k === 'Delete' || k === 'Backspace') && R.sel) { deleteComment(findComment(R.sel)); return true; }
  if (k === 'Escape') { R.sel = null; renderReviewPanel(); draw(); return true; }
  if (k === 'Enter' && R.sel) { $('rv-note')?.focus(); return true; }
  return false;
}

// ───────────────────────── 코멘트 기록 ─────────────────────────
function addComment(o) {
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), set: S.cur.name, type: null, note: '', at: new Date().toISOString(), ...o };
  R.comments.push(c); commentsChanged(); return c;
}
function snapLink(c) {  // 코멘트를 남긴 시점의 세포막↔세포핵 대응을 함께 기록 (PPT에 나감)
  const li = c.label ? linkInfo(S.cur, c.key, c.label) : null;
  c.link = li ? { text: li.text, ck: li.ck, nk: li.nk, cell: li.cell, nuclei: li.nuclei, problem: li.problem } : null;
}
function setType(type) {
  let c = findComment(R.sel);
  if (!c) c = addComment({ key: R.sel.key, label: R.sel.label });
  c.type = c.type === type ? null : type; snapLink(c); commentsChanged(); renderReviewPanel(); draw();
}
function setNote(text) {
  let c = findComment(R.sel);
  if (!c) { if (!text.trim()) return; c = addComment({ key: R.sel.key, label: R.sel.label }); }
  c.note = text; snapLink(c); commentsChanged(false);
}
function linkErrorComment() {  // 대응 오류로 기록 + 메모가 비어 있으면 현재 대응을 적어 둔다
  let c = findComment(R.sel);
  if (!c) c = addComment({ key: R.sel.key, label: R.sel.label });
  c.type = '대응 오류'; snapLink(c);
  if (!c.note.trim() && c.link) c.note = `${c.link.text.replace(/ · (자동|수동 연결|확인됨|확인 필요)$/, '')} — `;
  commentsChanged(); renderReviewPanel(); draw();
  const ta = $('rv-note'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
function deleteComment(c) {
  if (!c) return;
  R.comments = R.comments.filter((x) => x !== c);
  if (!c.label) R.sel = null;
  commentsChanged(); renderReviewPanel(); draw();
}
let saveTimer;
function commentsChanged(rerender = true) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem('cellMaskReview:' + R.folder, JSON.stringify(R.comments)); } catch { /* 저장 공간이 막힌 브라우저 */ } }, 400);
  $('rv-count').textContent = R.comments.length ? `코멘트 ${R.comments.length}개` : '';
  $('btn-pptx').disabled = $('btn-review-save').disabled = !R.comments.length;
  if (rerender) renderCommentList();
}

async function loadComments(folder) {  // 폴더를 열 때: 수정본/검수기록.json → 없으면 이 브라우저에 남은 기록
  R.folder = folder; R.comments = []; R.sel = null;
  const f = S.edited.get(REVIEW_FILE);
  if (f) try { R.comments = JSON.parse(await (await asFile(f)).text()).comments || []; } catch (e) { console.warn(e); }
  if (!R.comments.length) try { R.comments = JSON.parse(localStorage.getItem('cellMaskReview:' + folder) || '[]'); } catch { R.comments = []; }
  commentsChanged(); renderReviewPanel();
  if (R.comments.length) msg(`검수 코멘트 ${R.comments.length}개를 불러왔습니다.`);
}

async function saveReviewFile() {
  const json = new Blob([JSON.stringify({ version: 1, folder: R.folder, saved: new Date().toISOString(), comments: R.comments }, null, 2)], { type: 'application/json' });
  try {
    if (S.dir && (await S.dir.requestPermission({ mode: 'readwrite' })) === 'granted') {
      const sub = await S.dir.getDirectoryHandle(SAVE_DIR, { create: true }), fh = await sub.getFileHandle(REVIEW_FILE, { create: true });
      const w = await fh.createWritable(); await w.write(json); await w.close(); S.edited.set(REVIEW_FILE, fh);
      msg(`검수 기록을 ${S.dir.name}/${SAVE_DIR}/${REVIEW_FILE} 에 저장했습니다.`); return;
    }
  } catch (e) { console.warn(e); }
  download(json, REVIEW_FILE);
  msg(`검수 기록을 내려받았습니다. 폴더 안 ${SAVE_DIR}/ 에 넣으면 다음에 이어서 열립니다.`);
}
async function importReviewFile(file) {
  try {
    const list = JSON.parse(await file.text()).comments || [];
    const have = new Set(R.comments.map((c) => c.id));
    const add = list.filter((c) => !have.has(c.id));
    R.comments.push(...add); commentsChanged(); renderReviewPanel(); draw();
    msg(`검수 코멘트 ${add.length}개를 불러왔습니다.`);
  } catch (e) { alert('검수 기록 파일을 읽지 못했습니다: ' + e.message); }
}

// ───────────────────────── 화면 표시 ─────────────────────────
function selectionCanvas(d, key, label) {  // 선택한 객체: 노란 테두리 + 옅은 채움
  const tag = `${d.name}|${key}|${label}|${d.masks[key].hist.length}`;
  if (R.selKey === tag && R.selCanvas) return R.selCanvas;
  const a = d.masks[key].data, w = d.w, h = d.h, cvs = document.createElement('canvas'); cvs.width = w; cvs.height = h;
  const c2 = cvs.getContext('2d'), img = c2.createImageData(w, h), px = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (a[i] !== label) continue;
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || a[i - 1] !== label || a[i + 1] !== label || a[i - w] !== label || a[i + w] !== label;
    px[i * 4] = 255; px[i * 4 + 1] = 230; px[i * 4 + 2] = 0; px[i * 4 + 3] = edge ? 255 : 70;
  }
  c2.putImageData(img, 0, 0); R.selCanvas = cvs; R.selKey = tag; return cvs;
}
function commentPos(c, d) {
  if (!c.label) return [c.x, c.y];
  const m = d.masks[c.key]; if (!m) return null;
  if (!m.cent) centroids(m, d.w);
  const e = m.cent.find((x) => x[0] === c.label); return e ? [e[1], e[2]] : null;
}
function drawReviewOverlay(ctx) {
  const d = S.cur, { s, tx, ty } = S.view;
  if (S.mode === 'review' && R.sel && R.sel.label && d.masks[R.sel.key]) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(selectionCanvas(d, R.sel.key, R.sel.label), tx, ty, d.w * s, d.h * s);
  }
  const list = setComments(d.name);
  ctx.font = '700 12px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  list.forEach((c, i) => {  // 코멘트 표시: 빨간 번호 배지 (작업 모드에서도 보인다)
    const pos = commentPos(c, d); if (!pos) return;
    const X = tx + pos[0] * s, Y = ty + pos[1] * s - (c.label ? 16 : 0), on = R.sel && findComment(R.sel) === c;
    ctx.beginPath(); ctx.arc(X, Y, 10, 0, Math.PI * 2); ctx.fillStyle = on ? '#ffe600' : '#e5484d'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.fillStyle = on ? '#000' : '#fff'; ctx.fillText(String(i + 1), X, Y + 0.5);
    if (!c.label) { ctx.strokeStyle = on ? '#ffe600' : '#e5484d'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X, Y, 16, 0, Math.PI * 2); ctx.stroke(); }
  });
}

function renderReviewPanel() {
  const box = $('rv-selected'); if (!box || !S.cur) return;
  const sel = R.sel, c = findComment(sel);
  if (!sel) {
    box.innerHTML = `<div class="muted">객체(세포막·세포핵)를 <b>클릭</b>해 선택하세요.<br>빠진 세포는 빈 곳을 <b>더블클릭</b>해 표시합니다.<br>Tab = 세포막 ↔ 세포핵 선택 대상 전환</div>`;
  } else {
    const md = maskDef(sel.key), m = S.cur.masks[sel.key];
    let area = 0; if (sel.label && m) for (const v of m.data) if (v === sel.label) area++;
    const what = sel.label ? `${md.name} · <b>${sel.label}번</b> · ${area.toLocaleString()} px` : `${md.name} · <b>누락 지점</b> (${Math.round(c.x)}, ${Math.round(c.y)})`;
    const li = sel.label ? linkInfo(S.cur, sel.key, sel.label) : null;
    const linkHtml = li ? `<div class="rv-link${li.state === '확인 필요' ? ' warn' : ''}">🔗 ${esc(li.text)}</div>
      <button id="rv-linkerr" class="rv-linkerr" title="이 객체의 세포막↔세포핵 대응이 틀렸다고 기록">⚠ 대응 오류 코멘트</button>` : '';
    box.innerHTML = `<div class="rv-what">${what}</div>${linkHtml}
      <div class="muted rv-sub">오류 종류 (숫자키 1~${REVIEW_TYPES.length})</div>
      <div class="rv-types">${REVIEW_TYPES.map((t, i) => `<button class="rv-type${c && c.type === t ? ' on' : ''}" data-t="${esc(t)}">${i + 1}. ${esc(t)}</button>`).join('')}</div>
      <textarea id="rv-note" placeholder="코멘트 (예: 아래쪽 경계가 세포막 밖으로 나감)">${c ? esc(c.note) : ''}</textarea>
      <div class="row"><button id="rv-del" ${c ? '' : 'disabled'}>코멘트 삭제 (Del)</button><button id="rv-desel">선택 해제 (Esc)</button></div>`;
    box.querySelectorAll('.rv-type').forEach((b) => (b.onclick = () => setType(b.dataset.t)));
    $('rv-note').oninput = (ev) => { setNote(ev.target.value); renderCommentList(); draw(); };
    $('rv-del').onclick = () => deleteComment(findComment(R.sel));
    $('rv-desel').onclick = () => { R.sel = null; renderReviewPanel(); draw(); };
    $('rv-linkerr')?.addEventListener('click', linkErrorComment);
  }
  renderCommentList();
  renderLinkPanel();
}
function renderCommentList() {
  const ul = $('rv-list'); if (!ul || !S.cur) return;
  const here = setComments(S.cur.name), sel = findComment(R.sel);
  $('rv-list-title').textContent = `이 세트의 코멘트 (${here.length})` + (R.comments.length > here.length ? ` · 전체 ${R.comments.length}` : '');
  ul.innerHTML = here.map((c, i) => `<li data-id="${c.id}" class="${c === sel ? 'on' : ''}"><b>${cnum(i + 1)}</b> ${esc(maskDef(c.key)?.name || '')} ${c.label ? c.label + '번' : '누락'}
    · <span class="rv-t">${esc(c.type || '종류 미지정')}</span>${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}${c.type === '대응 오류' && c.link ? `<div class="muted">🔗 ${esc(c.link.text)}</div>` : ''}</li>`).join('');
  ul.querySelectorAll('li').forEach((li) => (li.onclick = () => {
    const c = R.comments.find((x) => x.id === li.dataset.id); R.sel = { id: c.id, key: c.key, label: c.label };
    if (S.layerUI[c.key] && !S.layerUI[c.key].visible) { S.layerUI[c.key].visible = true; buildLayers(); }
    const pos = commentPos(c, S.cur); if (pos) { const W = cv.clientWidth, H = cv.clientHeight; S.view.tx = W / 2 - pos[0] * S.view.s; S.view.ty = H / 2 - pos[1] * S.view.s; }
    renderReviewPanel(); draw();
  }));
}

// ───────────────────────── PPTX 내보내기 ─────────────────────────
const _enc = (s) => new TextEncoder().encode(s);
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function crc32(buf) { let c = ~0 >>> 0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function zipStore(entries, mime) {  // 무압축 ZIP
  const parts = [], central = []; let offset = 0;
  for (const e of entries) {
    const nameB = _enc(e.name), crc = crc32(e.data), size = e.data.length;
    const lh = new Uint8Array(30 + nameB.length), dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, size, true); dv.setUint32(22, size, true); dv.setUint16(26, nameB.length, true); lh.set(nameB, 30);
    parts.push(lh, e.data);
    const cd = new Uint8Array(46 + nameB.length), cvv = new DataView(cd.buffer);
    cvv.setUint32(0, 0x02014b50, true); cvv.setUint16(4, 20, true); cvv.setUint16(6, 20, true); cvv.setUint16(8, 0x0800, true);
    cvv.setUint32(16, crc, true); cvv.setUint32(20, size, true); cvv.setUint32(24, size, true); cvv.setUint16(28, nameB.length, true); cvv.setUint32(42, offset, true); cd.set(nameB, 46);
    central.push(cd); offset += lh.length + e.data.length;
  }
  let cdSize = 0; central.forEach((c) => (cdSize += c.length));
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: mime || 'application/zip' });
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 잘라낸 영역 그림: 'nucleus'·'membrane' = 흑백 원본, 'merge' = 세포핵(파랑)+세포막(초록), 'label' = 합성 + 마스크 외곽선 + 선택 객체
function lutOf(d, key) {
  const ch = d.ch[key], [lo, hi] = channelRange(key, d), g = S.adjust[key].g, n = Math.min(ch.max, 65535) + 1, lut = new Float32Array(n);
  for (let v = 0; v < n; v++) lut[v] = Math.pow(Math.min(1, Math.max(0, (v - lo) / (hi - lo))), g);
  return lut;
}
function regionCanvas(d, r, mode, c) {
  const cvs = document.createElement('canvas'); cvs.width = r.w; cvs.height = r.h;
  const c2 = cvs.getContext('2d'), img = c2.createImageData(r.w, r.h), px = img.data;
  const luts = {}; for (const ch of CHANNELS) if (d.ch[ch.key]) luts[ch.key] = lutOf(d, ch.key);
  const groupDraft = maskDef(c.key)?.draft;
  const masks = mode === 'label' ? MASKS.filter((m) => m.draft === groupDraft && d.masks[m.key])
    .map((m) => ({ a: d.masks[m.key].data, e: edgeMap(d.masks[m.key].data, d.w, d.h, S.layerUI[m.key]?.width || 1) })) : [];
  const selA = c.label && d.masks[c.key] ? d.masks[c.key].data : null, W = d.w, H = d.h;
  const partners = [];  // 대응 짝: 코멘트 객체가 세포면 그 핵들, 핵이면 그 세포
  if (mode === 'label' && c.link) {
    if (c.link.cell && c.key !== c.link.ck && d.masks[c.link.ck]) partners.push([d.masks[c.link.ck].data, new Set([c.link.cell])]);
    if (d.masks[c.link.nk]) partners.push([d.masks[c.link.nk].data, new Set(c.link.nuclei.filter((n) => !(c.key === c.link.nk && n === c.label)))]);
  }
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const gx = r.x + x, gy = r.y + y, i = gy * W + gx, o = (y * r.w + x) * 4;
    let R_ = 0, G = 0, B = 0;
    if (mode === 'nucleus' || mode === 'membrane') { const t = (luts[mode] ? luts[mode][d.ch[mode].data[i]] ?? 1 : 0) * 255; R_ = G = B = t; }
    else for (const ch of CHANNELS) { if (!luts[ch.key]) continue; const t = luts[ch.key][d.ch[ch.key].data[i]] ?? 1; R_ += t * ch.color[0]; G += t * ch.color[1]; B += t * ch.color[2]; }
    if (mode === 'label') {
      for (const { a, e } of masks) if (e[i]) [R_, G, B] = labelColor(a[i]);  // 다른 객체: 번호 색 외곽선 (화면의 두께 설정과 같게)
      for (const [pa, ids] of partners) {  // 짝 객체: 하늘색 테두리
        const v = pa[i]; if (!v || !ids.has(v)) continue;
        if (gx === 0 || gy === 0 || gx === W - 1 || gy === H - 1 || pa[i - 1] !== v || pa[i + 1] !== v || pa[i - W] !== v || pa[i + W] !== v) { R_ = 0; G = 230; B = 255; }
      }
      if (selA && selA[i] === c.label) {  // 코멘트 객체: 노란 채움 + 굵은 테두리
        const v = c.label, edge = gx === 0 || gy === 0 || gx === W - 1 || gy === H - 1 || selA[i - 1] !== v || selA[i + 1] !== v || selA[i - W] !== v || selA[i + W] !== v;
        if (edge) { R_ = 255; G = 230; B = 0; } else { R_ = R_ * 0.7 + 255 * 0.3; G = G * 0.7 + 230 * 0.3; B = B * 0.7; }
      }
    }
    px[o] = R_; px[o + 1] = G; px[o + 2] = B; px[o + 3] = 255;
  }
  c2.putImageData(img, 0, 0);
  return cvs;
}
function scaleUp(src, size) {  // 픽셀이 뭉개지지 않게 정수배 확대
  const k = Math.max(1, Math.floor(size / Math.max(src.width, src.height)));
  const out = document.createElement('canvas'); out.width = src.width * k; out.height = src.height * k;
  const c2 = out.getContext('2d'); c2.imageSmoothingEnabled = false; c2.drawImage(src, 0, 0, out.width, out.height);
  return { cvs: out, k };
}
function caption(cvs, text) {
  const c2 = cvs.getContext('2d'), fs = Math.max(16, Math.round(cvs.width / 22));
  c2.font = `700 ${fs}px "Apple SD Gothic Neo","Malgun Gothic",sans-serif`; c2.textBaseline = 'top';
  const tw = c2.measureText(text).width; c2.fillStyle = 'rgba(0,0,0,.72)'; c2.fillRect(0, 0, tw + 18, fs + 12);
  c2.fillStyle = '#fff'; c2.fillText(text, 9, 6);
}
function commentRect(c, d) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const m = c.label && d.masks[c.key];
  if (m) for (let i = 0; i < m.data.length; i++) if (m.data[i] === c.label) { const x = i % d.w, y = (i / d.w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) { x0 = x1 = Math.round(c.x ?? d.w / 2); y0 = y1 = Math.round(c.y ?? d.h / 2); }
  const side = Math.min(Math.max(d.w, d.h), Math.max(96, Math.round(Math.max(x1 - x0 + 1, y1 - y0 + 1) * 1.6)));
  const w = Math.min(side, d.w), h = Math.min(side, d.h), cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  const x = Math.max(0, Math.min(d.w - w, Math.round(cx - w / 2))), y = Math.max(0, Math.min(d.h - h, Math.round(cy - h / 2)));
  return { x, y, w, h, bbox: x1 >= 0 && m ? [x0, y0, x1, y1] : null };
}
async function toPng(cvs) { const b = await new Promise((r) => cvs.toBlob(r, 'image/png')); return new Uint8Array(await b.arrayBuffer()); }

async function renderCommentImages(c, d, idxInSet) {
  const r = commentRect(c, d), pics = [];
  for (const [mode, name] of [['nucleus', '세포핵 원본'], ['membrane', '세포막 원본'], ['merge', '세포핵 + 세포막'], ['label', '라벨링']]) {
    const src = regionCanvas(d, r, mode, c), { cvs, k } = scaleUp(src, 720);
    if (!c.label && mode === 'label') {  // 누락 지점: 원 표시
      const c2 = cvs.getContext('2d'); c2.strokeStyle = '#e5484d'; c2.lineWidth = Math.max(3, k);
      c2.beginPath(); c2.arc((c.x - r.x) * k, (c.y - r.y) * k, 18 * k / 2 + 10, 0, Math.PI * 2); c2.stroke();
    }
    caption(cvs, name);
    pics.push({ bytes: await toPng(cvs), w: cvs.width, h: cvs.height });
  }
  // 전체 이미지에서의 위치
  const full = regionCanvas(d, { x: 0, y: 0, w: d.w, h: d.h }, 'merge', c), ov = document.createElement('canvas');
  const s = Math.min(1, 640 / Math.max(d.w, d.h)); ov.width = Math.round(d.w * s); ov.height = Math.round(d.h * s);
  const o2 = ov.getContext('2d'); o2.drawImage(full, 0, 0, ov.width, ov.height);
  o2.strokeStyle = '#ffe600'; o2.lineWidth = 3; o2.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
  caption(ov, `전체 위치 · ${d.name}`);
  pics.push({ bytes: await toPng(ov), w: ov.width, h: ov.height });
  return { pics, rect: r, idxInSet };
}

const PPTX_NS = { a: 'http://schemas.openxmlformats.org/drawingml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', p: 'http://schemas.openxmlformats.org/presentationml/2006/main' };
const SLIDE_W = 12192000, SLIDE_H = 6858000;
const PP = { M: 228600, BAR_H: 760000, PANEL_W: 3900000, navy: '1F3A93', white: 'FFFFFF', soft: 'D2E0FB', panelBg: 'F7FAFF', panelLine: 'CCDAF2', red: 'C0392B', gray: '5A6B85', ink: '121C2E' };
const FONT = '<a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/>';
const ppRun = (t, o = {}) => `<a:r><a:rPr lang="ko-KR" altLang="en-US" sz="${o.sz || 1200}"${o.b ? ' b="1"' : ''}${o.i ? ' i="1"' : ''}>${o.color ? `<a:solidFill><a:srgbClr val="${o.color}"/></a:solidFill>` : ''}${FONT}</a:rPr><a:t>${xmlEsc(t)}</a:t></a:r>`;
const ppPara = (runs, o = {}) => `<a:p><a:pPr marL="${o.marL || 0}" indent="0"${o.algn ? ` algn="${o.algn}"` : ''}>${o.spcBef ? `<a:spcBef><a:spcPts val="${o.spcBef}"/></a:spcBef>` : ''}<a:buNone/></a:pPr>${runs}</a:p>`;
const ppTx = (paras, o = {}) => `<p:txBody><a:bodyPr wrap="square" lIns="${o.ins ?? 91440}" tIns="${o.ins ?? 91440}" rIns="${o.ins ?? 91440}" bIns="${o.ins ?? 91440}" anchor="${o.anchor || 't'}" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody>`;
function ppShape(id, name, x, y, w, h, o = {}) {
  const fill = o.fill ? `<a:solidFill><a:srgbClr val="${o.fill}"/></a:solidFill>` : '<a:noFill/>';
  const line = o.line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${o.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const geom = o.prst === 'roundRect' ? '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 3500"/></a:avLst></a:prstGeom>' : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${o.txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>${geom}${fill}${line}</p:spPr>${o.tx || ppTx('')}</p:sp>`;
}
function ppPic(id, rid, x, y, w, h, im) {  // (x,y,w,h) 칸 안에 비율 유지해 가운데 배치
  const s = Math.min(w / im.w, h / im.h), dw = Math.round(im.w * s), dh = Math.round(im.h * s), dx = Math.round(x + (w - dw) / 2), dy = Math.round(y + (h - dh) / 2);
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="image${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${dx}" y="${dy}"/><a:ext cx="${dw}" cy="${dh}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:srgbClr val="${PP.panelLine}"/></a:solidFill></a:ln></p:spPr></p:pic>`;
}
/* 슬라이드: 제목 바(세트·객체) / 왼쪽 2×2(세포핵·세포막·합성·라벨링) / 오른쪽 코멘트 패널 + 전체 위치 */
function commentSlide(c, info, rids, pics, k, total) {
  const { M, BAR_H, PANEL_W } = PP, top = BAR_H + M, contentH = SLIDE_H - top - M, panelX = SLIDE_W - M - PANEL_W;
  const gridW = panelX - M * 2, gap = M * 0.6, cellW = (gridW - gap) / 2, cellH = (contentH - gap) / 2;
  let xml = '';
  for (let q = 0; q < 4; q++) xml += ppPic(20 + q, rids[q], M + (q % 2) * (cellW + gap), top + Math.floor(q / 2) * (cellH + gap), cellW, cellH, pics[q]);
  const md = maskDef(c.key), obj = c.label ? `${md?.name || c.key} ${c.label}번` : `${md?.name || c.key} · 누락 지점`;
  const title = `${cnum(info.idxInSet)}  ${c.set} · ${obj}`;
  xml += ppShape(2, 'titlebar', 0, 0, SLIDE_W, BAR_H, { fill: PP.navy, tx: ppTx(ppPara(ppRun(title, { sz: 1900, b: true, color: PP.white })), { anchor: 'ctr', ins: M }) });
  xml += ppShape(3, 'titleinfo', panelX - M, 0, PANEL_W + M, BAR_H, { txBox: true, tx: ppTx(ppPara(ppRun(`${c.type || '종류 미지정'}   ·   ${k}/${total}`, { sz: 1300, color: PP.soft }), { algn: 'r' }), { anchor: 'ctr', ins: M }) });
  const textH = Math.round(contentH * 0.5), r = info.rect;
  let paras = ppPara(ppRun('검수 코멘트', { sz: 1050, b: true, color: PP.gray }));
  paras += ppPara(ppRun(c.type || '종류 미지정', { sz: 1600, b: true, color: PP.red }), { spcBef: 600 });
  paras += ppPara(ppRun(c.note && c.note.trim() ? `“${c.note.trim()}”` : '(메모 없음)', { sz: 1300, i: !!c.note, color: c.note ? PP.ink : PP.gray }), { spcBef: 500 });
  const where = c.label ? `${md?.name} · ${c.label}번 객체 · ${info.area.toLocaleString()} px` : `${md?.name} · 누락 지점 (${Math.round(c.x)}, ${Math.round(c.y)})`;
  paras += ppPara(ppRun(where, { sz: 1050, color: PP.gray }), { spcBef: 700 });
  if (c.link) paras += ppPara(ppRun(`대응: ${c.link.text}`, { sz: 1050, b: c.type === '대응 오류', color: c.type === '대응 오류' ? PP.red : PP.gray }), { spcBef: 120 });
  paras += ppPara(ppRun(`잘라낸 영역 x ${r.x}–${r.x + r.w}, y ${r.y}–${r.y + r.h}`, { sz: 1000, color: PP.gray }), { spcBef: 120 });
  xml += ppShape(4, 'panel', panelX, top, PANEL_W, contentH, { fill: PP.panelBg, line: PP.panelLine, prst: 'roundRect', tx: ppTx(paras, { ins: 182880 }) });
  xml += ppPic(30, rids[4], panelX + M, top + textH, PANEL_W - M * 2, contentH - textH - M, pics[4]);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${PPTX_NS.a}" xmlns:r="${PPTX_NS.r}" xmlns:p="${PPTX_NS.p}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${xml}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
function pptxPackage(slides, media) {
  const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', n = slides.length, X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const theme = `${X}<a:theme xmlns:a="${PPTX_NS.a}" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const grp = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const master = `${X}<p:sldMaster xmlns:a="${PPTX_NS.a}" xmlns:r="${PPTX_NS.r}" xmlns:p="${PPTX_NS.p}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${grp}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
  const layout = `${X}<p:sldLayout xmlns:a="${PPTX_NS.a}" xmlns:r="${PPTX_NS.r}" xmlns:p="${PPTX_NS.p}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${grp}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  let ct = `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`;
  for (let i = 1; i <= n; i++) ct += `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  ct += '</Types>';
  let presRels = `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`, ids = '';
  for (let i = 0; i < n; i++) { presRels += `<Relationship Id="rId${i + 2}" Type="${RT}/slide" Target="slides/slide${i + 1}.xml"/>`; ids += `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`; }
  presRels += '</Relationships>';
  const entries = [
    { name: '[Content_Types].xml', data: _enc(ct) },
    { name: '_rels/.rels', data: _enc(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`) },
    { name: 'ppt/presentation.xml', data: _enc(`${X}<p:presentation xmlns:a="${PPTX_NS.a}" xmlns:r="${PPTX_NS.r}" xmlns:p="${PPTX_NS.p}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`) },
    { name: 'ppt/_rels/presentation.xml.rels', data: _enc(presRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: _enc(master) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: _enc(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${RT}/theme" Target="../theme/theme1.xml"/></Relationships>`) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: _enc(layout) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: _enc(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`) },
    { name: 'ppt/theme/theme1.xml', data: _enc(theme) },
  ];
  slides.forEach((s, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: _enc(s.xml) });
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: _enc(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      s.rels.map((r) => `<Relationship Id="${r.rid}" Type="${RT}/image" Target="${r.target}"/>`).join('') + '</Relationships>') });
  });
  media.forEach((m) => entries.push(m));
  return zipStore(entries, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
}

async function buildReviewPptx() {
  const order = (s) => S.sets.indexOf(s);
  const list = [...R.comments].sort((a, b) => order(a.set) - order(b.set) || a.at.localeCompare(b.at));
  const slides = [], media = []; let mn = 0;
  for (let k = 0; k < list.length; k++) {
    const c = list[k]; msg(`PPT 만드는 중… ${k + 1}/${list.length}`);
    if (!S.sets.includes(c.set)) continue;
    const d = await loadSet(c.set);
    if (!d.masks[c.key]) continue;
    const idxInSet = setComments(c.set).indexOf(c) + 1;
    const { pics, rect } = await renderCommentImages(c, d, idxInSet);
    let area = 0; if (c.label) for (const v of d.masks[c.key].data) if (v === c.label) area++;
    const rels = [], rids = [];
    pics.forEach((p, q) => { mn++; media.push({ name: `ppt/media/image${mn}.png`, data: p.bytes }); rids.push(`rId${q + 2}`); rels.push({ rid: `rId${q + 2}`, target: `../media/image${mn}.png` }); });
    slides.push({ xml: commentSlide(c, { idxInSet, rect, area }, rids, pics, k + 1, list.length), rels });
  }
  return { blob: pptxPackage(slides, media), count: slides.length };
}
async function exportReviewPptx() {
  if (!R.comments.length) { alert('코멘트가 없습니다. 검수 모드에서 객체를 클릭해 코멘트를 남기세요.'); return; }
  const btn = $('btn-pptx'); btn.disabled = true;
  try {
    const { blob, count } = await buildReviewPptx();
    download(blob, `세포검수_${R.folder}_${todayYMD()}.pptx`);
    msg(`코멘트 ${count}개를 슬라이드 ${count}장으로 내보냈습니다.`);
  } catch (e) { console.error(e); alert('PPT 만들기 실패: ' + e.message); }
  btn.disabled = false;
}

// ───────────────────────── 버튼 연결 ─────────────────────────
document.querySelectorAll('.mode-btn').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$('btn-pptx').onclick = exportReviewPptx;
$('btn-review-save').onclick = saveReviewFile;
$('btn-review-load').onclick = () => $('review-input').click();
$('review-input').onchange = (e) => { if (e.target.files[0]) importReviewFile(e.target.files[0]); e.target.value = ''; };
Object.assign(window.cellMaskEditor, { R, setMode, reviewClick, buildReviewPptx, addComment });
