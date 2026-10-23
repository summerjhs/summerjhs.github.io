'use strict';
// 세포막 ↔ 세포핵 대응 — 겹침으로 자동 연결하고, 애매한 것만 사람이 확인·수정한다. (app.js 다음에 읽힌다)
// 자동 규칙: 핵 면적의 50% 이상이 들어 있는 세포에 연결. 90% 미만이면 '걸침'으로 확인 필요.
// 사람이 바꾼 것(수동 연결·확인)은 수정본/대응확인.json 에, 결과 표는 수정본/<세트>_대응표_<초벌|정답>.csv 에 저장.

const LINK_FILE = '대응확인.json';
const LINK_MIN = 0.5, LINK_CLEAN = 0.9;
const L = { over: {}, sel: null, pending: null, filter: 'todo', lines: true, folder: '' };
// over[`${세트}|${초벌|정답}`] = { assign: {핵번호: 세포번호(0=연결 없음)}, okCells: [세포번호], okNuclei: [핵번호] }

const groupOf = () => (maskDef(S.active)?.draft ? '초벌' : '정답');
const groupKeys = (g) => (g === '초벌' ? ['초벌_membrane_mask', '초벌_nucleus_mask'] : ['membrane_mask_gt', 'nucleus_mask_gt']);
const overOf = (set, g) => (L.over[`${set}|${g}`] ||= { assign: {}, okCells: [], okNuclei: [] });

// ───────────────────────── 계산 ─────────────────────────
function computeLinks(d, g) {
  const [ck, nk] = groupKeys(g), cm = d.masks[ck], nm = d.masks[nk];
  if (!cm || !nm) return null;
  const tag = `${cm.hist.length}/${cm.fut.length}/${nm.hist.length}/${nm.fut.length}/${JSON.stringify(L.over[`${d.name}|${g}`] || {})}`;
  if (d.links?.[g]?.tag === tag && !d.links[g].stale) return d.links[g];
  const ca = cm.data, na = nm.data, cellArea = new Map(), nucArea = new Map(), pair = new Map();
  for (let i = 0; i < ca.length; i++) {
    const c = ca[i], n = na[i];
    if (c) cellArea.set(c, (cellArea.get(c) || 0) + 1);
    if (n) { nucArea.set(n, (nucArea.get(n) || 0) + 1); if (c) { const k = n * 4294967296 + c; pair.set(k, (pair.get(k) || 0) + 1); } }
  }
  const best = new Map();  // 핵 → [가장 많이 겹친 세포, 비율]
  for (const [k, cnt] of pair) {
    const n = Math.floor(k / 4294967296), c = k - n * 4294967296, b = best.get(n);
    if (!b || cnt > b[2]) best.set(n, [c, 0, cnt]);
  }
  const o = overOf(d.name, g), okC = new Set(o.okCells), okN = new Set(o.okNuclei);
  const nuclei = new Map(), cells = new Map();
  for (const [c, area] of cellArea) cells.set(c, { id: c, area, nuclei: [] });
  for (const [n, area] of nucArea) {
    const b = best.get(n), frac = b ? b[2] / area : 0, autoCell = b && frac >= LINK_MIN ? b[0] : 0;
    const manual = Object.prototype.hasOwnProperty.call(o.assign, n) && (o.assign[n] === 0 || cells.has(o.assign[n]));
    const cell = manual ? o.assign[n] : autoCell;
    nuclei.set(n, { id: n, area, frac, autoCell, cell, manual });
    if (cell && cells.has(cell)) cells.get(cell).nuclei.push(n);
  }
  for (const c of cells.values()) {
    const ns = c.nuclei.map((n) => nuclei.get(n)), straddle = ns.some((x) => !x.manual && x.frac < LINK_CLEAN);
    c.problem = !ns.length ? '핵 없음' : ns.length > 1 ? `핵 ${ns.length}개` : straddle ? '핵 걸침' : '';
    c.ok = okC.has(c.id);
    c.state = c.problem ? (c.ok ? '확인됨' : '확인 필요') : ns.some((x) => x.manual) ? '수동 연결' : '자동';
  }
  const orphans = [...nuclei.values()].filter((x) => !x.cell).map((x) => ({ ...x, ok: okN.has(x.id) }));
  const r = { tag, cells, nuclei, orphans, ck, nk, stale: false };
  (d.links ||= {})[g] = r;
  return r;
}
function linkStale() { for (const d of S.cache.values()) if (d.links) for (const g in d.links) d.links[g].stale = true; scheduleLinkPanel(); }
let linkTimer;
function scheduleLinkPanel() { clearTimeout(linkTimer); linkTimer = setTimeout(renderLinkPanel, 250); }

// ───────────────────────── 사람 확인 ─────────────────────────
function assignNucleus(n, cell) {
  const g = groupOf(), o = overOf(S.cur.name, g);
  const lk = computeLinks(S.cur, g), auto = lk?.nuclei.get(n)?.autoCell ?? 0;
  if (cell === auto) delete o.assign[n]; else o.assign[n] = cell;  // 자동 결과와 같아지면 수동 기록을 지운다
  linksChanged();
}
function toggleOk(kind, id) {
  const o = overOf(S.cur.name, groupOf()), list = kind === 'cell' ? o.okCells : o.okNuclei, i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
  linksChanged();
}
function resetSetLinks() {
  if (!confirm(`${S.cur.name} (${groupOf()})의 수동 연결·확인 기록을 모두 지우고 자동 연결로 되돌릴까요?`)) return;
  delete L.over[`${S.cur.name}|${groupOf()}`]; linksChanged();
}
let linkSaveTimer;
function linksChanged() {
  clearTimeout(linkSaveTimer);
  linkSaveTimer = setTimeout(() => { try { localStorage.setItem('cellMaskLinks:' + L.folder, JSON.stringify(L.over)); } catch { /* 저장 공간이 막힌 브라우저 */ } }, 300);
  renderLinkPanel(); draw();
}
async function loadLinks(folder) {
  L.folder = folder; L.over = {}; L.sel = null; L.pending = null;
  const f = S.edited.get(LINK_FILE);
  if (f) try { L.over = JSON.parse(await (await asFile(f)).text()).over || {}; } catch (e) { console.warn(e); }
  if (!Object.keys(L.over).length) try { L.over = JSON.parse(localStorage.getItem('cellMaskLinks:' + folder) || '{}'); } catch { L.over = {}; }
  renderLinkPanel();
}

function linkClick(px, py, inside) {  // 🔗 도구: 세포 클릭 → 핵 클릭 = 연결 (같은 연결을 다시 하면 해제)
  const g = groupOf(), [ck, nk] = groupKeys(g), cm = S.cur.masks[ck], nm = S.cur.masks[nk];
  if (!cm || !nm) { msg(`${g} 세포막·세포핵 마스크가 모두 있어야 연결할 수 있습니다.`); return; }
  if (!inside) { L.pending = null; renderLinkPanel(); draw(); return; }
  const i = py * S.cur.w + px, c = cm.data[i], n = nm.data[i];
  if (!L.pending) {
    if (c) { L.pending = { cell: c }; L.sel = { cell: c }; msg(`세포 ${c} 선택 — 연결할 핵을 클릭하세요 (Esc 취소)`); }
    else if (n) { L.pending = { nuc: n }; L.sel = { nuc: n }; msg(`핵 ${n} 선택 — 연결할 세포를 클릭하세요 (빈 곳 = 연결 끊기)`); }
    else msg('세포나 핵을 클릭하세요.');
  } else if (L.pending.cell) {
    if (!n) { msg('핵이 아닌 곳입니다. 핵을 클릭하세요.'); return; }
    const cur = computeLinks(S.cur, g).nuclei.get(n)?.cell;
    const target = cur === L.pending.cell ? 0 : L.pending.cell;
    assignNucleus(n, target); msg(target ? `핵 ${n} → 세포 ${target} 연결` : `핵 ${n} 연결 해제`);
    L.sel = { cell: L.pending.cell }; L.pending = null;
  } else {
    assignNucleus(L.pending.nuc, c || 0); msg(c ? `핵 ${L.pending.nuc} → 세포 ${c} 연결` : `핵 ${L.pending.nuc} 연결 해제`);
    L.sel = c ? { cell: c } : { nuc: L.pending.nuc }; L.pending = null;
  }
  renderLinkPanel(); draw();
}

// ───────────────────────── 화면 ─────────────────────────
function pairCanvas(d, lk, sel) {  // 선택한 세포(노랑)와 연결된 핵(하늘색) 강조
  const tag = `${d.name}|${lk.tag}|${JSON.stringify(sel)}`;
  if (L.hlTag === tag) return L.hl;
  const cell = sel.cell || lk.nuclei.get(sel.nuc)?.cell || 0, nucs = new Set(cell ? lk.cells.get(cell)?.nuclei || [] : [sel.nuc]);
  const ca = d.masks[lk.ck].data, na = d.masks[lk.nk].data, w = d.w, h = d.h, cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const c2 = cvs.getContext('2d'), img = c2.createImageData(w, h), px = img.data;
  const edge = (a, i, v, x, y) => x === 0 || y === 0 || x === w - 1 || y === h - 1 || a[i - 1] !== v || a[i + 1] !== v || a[i - w] !== v || a[i + w] !== v;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 4;
    if (cell && ca[i] === cell) { const e = edge(ca, i, cell, x, y); px[o] = 255; px[o + 1] = 230; px[o + 2] = 0; px[o + 3] = e ? 255 : 45; }
    if (nucs.has(na[i])) { const e = edge(na, i, na[i], x, y); if (e) { px[o] = 0; px[o + 1] = 230; px[o + 2] = 255; px[o + 3] = 255; } else if (!cell || ca[i] !== cell) { px[o] = 0; px[o + 1] = 230; px[o + 2] = 255; px[o + 3] = 60; } }
  }
  c2.putImageData(img, 0, 0); L.hl = cvs; L.hlTag = tag; return cvs;
}
// 객체 하나의 대응 정보 (검수 패널·코멘트·PPT에서 사용)
function linkInfo(d, key, label) {
  const def = maskDef(key); if (!def || !label) return null;
  const g = def.draft ? '초벌' : '정답', lk = computeLinks(d, g); if (!lk) return null;
  let cell, nuclei;
  if (def.kind === 'membrane') { cell = label; nuclei = lk.cells.get(label)?.nuclei || []; }
  else { cell = lk.nuclei.get(label)?.cell || 0; nuclei = cell ? lk.cells.get(cell)?.nuclei || [label] : [label]; }
  const c = cell ? lk.cells.get(cell) : null, orphan = !cell ? lk.orphans.find((o) => o.id === label) : null;
  const state = c ? c.state : orphan?.ok ? '확인됨' : '확인 필요', problem = c ? c.problem : '세포 없음';
  const text = `${g} 세포 ${cell || '없음'} ↔ ${nuclei.length ? nuclei.map((n) => '핵 ' + n).join(', ') : '핵 없음'}${problem ? ` · ${problem}` : ''} · ${state}`;
  return { group: g, ck: lk.ck, nk: lk.nk, cell, nuclei, problem, state, text };
}
function reviewLinkSel() {  // 검수 모드에서 선택한 객체 → 대응 강조용 선택
  if (!R.sel?.label) return null;
  const def = maskDef(R.sel.key); if (!def || (def.draft ? '초벌' : '정답') !== groupOf()) return null;
  return def.kind === 'membrane' ? { cell: R.sel.label } : { nuc: R.sel.label };
}

function drawLinkOverlay(ctx) {
  if (!S.cur || S.masksHidden) return;
  const g = groupOf(), lk = computeLinks(S.cur, g); if (!lk) return;
  const d = S.cur, { s, tx, ty } = S.view, cm = d.masks[lk.ck], nm = d.masks[lk.nk];
  if (!cm.cent) centroids(cm, d.w); if (!nm.cent) centroids(nm, d.w);
  const cc = new Map(cm.cent.map(([id, x, y]) => [id, [x, y]])), nc = new Map(nm.cent.map(([id, x, y]) => [id, [x, y]]));
  if (L.lines) {  // 세포 중심 → 핵 중심 연결선 (확인 필요 = 주황)
    ctx.lineWidth = 1.5;
    for (const c of lk.cells.values()) for (const n of c.nuclei) {
      const a = cc.get(c.id), b = nc.get(n); if (!a || !b) continue;
      ctx.strokeStyle = c.state === '확인 필요' ? 'rgba(255,150,40,.95)' : c.state === '수동 연결' ? 'rgba(120,180,255,.9)' : 'rgba(255,255,255,.55)';
      ctx.beginPath(); ctx.moveTo(tx + a[0] * s, ty + a[1] * s); ctx.lineTo(tx + b[0] * s, ty + b[1] * s); ctx.stroke();
    }
    for (const c of lk.cells.values()) if (c.state === '확인 필요' && !c.nuclei.length) {  // 핵 없는 세포: 주황 고리
      const a = cc.get(c.id); if (!a) continue;
      ctx.strokeStyle = 'rgba(255,150,40,.95)'; ctx.beginPath(); ctx.arc(tx + a[0] * s, ty + a[1] * s, 7, 0, Math.PI * 2); ctx.stroke();
    }
    for (const x of lk.orphans) if (!x.ok) {  // 세포 없는 핵: 주황 X
      const b = nc.get(x.id); if (!b) continue; const X = tx + b[0] * s, Y = ty + b[1] * s;
      ctx.strokeStyle = 'rgba(255,150,40,.95)'; ctx.beginPath(); ctx.moveTo(X - 6, Y - 6); ctx.lineTo(X + 6, Y + 6); ctx.moveTo(X + 6, Y - 6); ctx.lineTo(X - 6, Y + 6); ctx.stroke();
    }
  }
  const sel = S.mode === 'review' ? reviewLinkSel() : L.pending ? { cell: L.pending.cell, nuc: L.pending.nuc } : L.sel;
  if (sel && (sel.cell || sel.nuc)) { ctx.imageSmoothingEnabled = false; ctx.drawImage(pairCanvas(d, lk, sel), tx, ty, d.w * s, d.h * s); }
}

function renderLinkPanel() {
  if (!S.cur) return;
  const g = groupOf(), lk = computeLinks(S.cur, g);
  if (!lk) { $('link-summary').textContent = `${g} 세포막·세포핵 마스크가 모두 있어야 대응을 계산합니다.`; $('link-list').innerHTML = ''; $('link-actions').innerHTML = ''; return; }
  const cells = [...lk.cells.values()].sort((a, b) => a.id - b.id), todo = cells.filter((c) => c.state === '확인 필요'), orphTodo = lk.orphans.filter((x) => !x.ok);
  const nTodo = todo.length + orphTodo.length;
  $('link-summary').innerHTML = `<b>${g}</b> · 세포 ${cells.length} · 핵 ${lk.nuclei.size}<br>자동 ${cells.filter((c) => c.state === '자동').length} · 수동 ${cells.filter((c) => c.state === '수동 연결').length} · 확인됨 ${cells.filter((c) => c.state === '확인됨').length + lk.orphans.filter((x) => x.ok).length} · <span class="${nTodo ? 'lk-todo' : ''}">확인 필요 ${nTodo}</span>`;
  document.querySelectorAll('.lk-filter').forEach((b) => b.classList.toggle('on', b.dataset.f === L.filter));
  const show = L.filter === 'todo' ? todo : cells, orph = L.filter === 'todo' ? orphTodo : lk.orphans;
  const sw = (id) => { const [r, gg, b] = labelColor(id); return `<span class="lk-sw" style="background:rgb(${r},${gg},${b})"></span>`; };
  const review = S.mode === 'review', rsel = review ? reviewLinkSel() : null, cur = review ? rsel : L.sel;
  const selCell = cur?.cell || (cur?.nuc && lk.nuclei.get(cur.nuc)?.cell) || 0;
  let html = show.map((c) => `<li data-c="${c.id}" class="${c.id === selCell ? 'on' : ''}">${sw(c.id)}<b>세포 ${c.id}</b> ↔ ${c.nuclei.length ? c.nuclei.map((n) => `핵 ${n}`).join(', ') : '<i>핵 없음</i>'}
    <span class="lk-st st-${c.state.replace(' ', '')}">${c.problem && c.state !== '자동' ? esc(c.problem) + ' · ' : ''}${c.state}</span></li>`).join('');
  html += orph.map((x) => `<li data-n="${x.id}" class="${cur?.nuc === x.id && !selCell ? 'on' : ''}"><b>핵 ${x.id}</b> ↔ <i>세포 없음</i>
    <span class="lk-st st-${x.ok ? '확인됨' : '확인필요'}">${x.manual ? '연결 끊음' : '세포 밖'} · ${x.ok ? '확인됨' : '확인 필요'}</span></li>`).join('');
  if (!html) html = `<li class="muted lk-empty">${L.filter === 'todo' ? '확인할 항목이 없습니다 ✓' : '객체가 없습니다'}</li>`;
  $('link-list').innerHTML = html;
  $('link-list').querySelectorAll('li[data-c], li[data-n]').forEach((li) => (li.onclick = () => {
    L.pending = null; L.sel = li.dataset.c ? { cell: Number(li.dataset.c) } : { nuc: Number(li.dataset.n) };
    focusLinkSel(lk);
    if (S.mode === 'review') {  // 검수: 목록에서 고른 객체를 코멘트 대상으로 선택
      R.sel = L.sel.cell ? { key: lk.ck, label: L.sel.cell } : { key: lk.nk, label: L.sel.nuc };
      renderReviewPanel();
    } else renderLinkPanel();
    draw();
  }));
  if (review) {  // 검수 모드는 읽기 전용 — 수정은 작업 모드에서
    $('link-actions').innerHTML = selCell || cur?.nuc ? `<div class="muted">대응 수정은 작업 모드에서 합니다. 오류는 위 코멘트 칸에서 <b>대응 오류</b>로 남기세요.</div>` : '';
    return;
  }
  // 선택한 항목의 확인 버튼
  let act = '';
  if (selCell && lk.cells.get(selCell)) {
    const c = lk.cells.get(selCell);
    act = `<div class="lk-sel">세포 <b>${c.id}</b> · ${c.area.toLocaleString()} px · ${c.state}${c.problem ? ` (${c.problem})` : ''}</div>` +
      c.nuclei.map((n) => { const x = lk.nuclei.get(n); return `<div class="lk-nuc">핵 ${n} · 세포 안 ${Math.round(x.frac * 100)}%${x.manual ? ' · 수동' : ''}<button data-un="${n}" title="이 핵의 연결을 끊음">연결 끊기</button></div>`; }).join('') +
      `<div class="row">${c.problem ? `<button id="lk-ok">${c.ok ? '확인 취소' : '✓ 이대로 맞음'}</button>` : ''}<button id="lk-link" title="이 세포에 핵을 연결 (🔗 도구로 핵 클릭)">🔗 핵 연결하기</button></div>`;
  } else if (L.sel?.nuc && lk.nuclei.get(L.sel.nuc)) {
    const x = lk.nuclei.get(L.sel.nuc), orphan = lk.orphans.find((o) => o.id === x.id);
    act = `<div class="lk-sel">핵 <b>${x.id}</b> · ${x.area.toLocaleString()} px · 연결된 세포 없음</div><div class="row">` +
      `<button id="lk-ok-n">${orphan?.ok ? '확인 취소' : '✓ 이대로 맞음'}</button><button id="lk-link-n">🔗 세포 연결하기</button></div>`;
  }
  $('link-actions').innerHTML = act;
  $('link-actions').querySelectorAll('[data-un]').forEach((b) => (b.onclick = () => { assignNucleus(Number(b.dataset.un), 0); }));
  $('lk-ok')?.addEventListener('click', () => toggleOk('cell', selCell));
  $('lk-ok-n')?.addEventListener('click', () => toggleOk('nuc', L.sel.nuc));
  $('lk-link')?.addEventListener('click', () => { setTool('link'); L.pending = { cell: selCell }; msg(`세포 ${selCell} — 연결할 핵을 클릭하세요`); draw(); });
  $('lk-link-n')?.addEventListener('click', () => { setTool('link'); L.pending = { nuc: L.sel.nuc }; msg(`핵 ${L.sel.nuc} — 연결할 세포를 클릭하세요`); draw(); });
}
function focusLinkSel(lk) {
  const d = S.cur, key = L.sel.cell ? lk.ck : lk.nk, id = L.sel.cell || L.sel.nuc, m = d.masks[key];
  if (!m.cent) centroids(m, d.w);
  const e = m.cent.find((x) => x[0] === id); if (!e) return;
  S.view.tx = cv.clientWidth / 2 - e[1] * S.view.s; S.view.ty = cv.clientHeight / 2 - e[2] * S.view.s;
}

// ───────────────────────── 저장 (대응표 CSV + 확인 기록 JSON) ─────────────────────────
function linkCsv(d, g) {
  const lk = computeLinks(d, g); if (!lk) return null;
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`, rows = [['세트', '구분', '세포번호', '핵번호', '판정', '문제', '핵이 세포 안에 든 비율(%)', '세포 면적(px)', '핵 면적(px)']];
  for (const c of [...lk.cells.values()].sort((a, b) => a.id - b.id)) {
    if (!c.nuclei.length) rows.push([d.name, g, c.id, '', c.state, c.problem, '', c.area, '']);
    for (const n of c.nuclei) { const x = lk.nuclei.get(n); rows.push([d.name, g, c.id, n, x.manual ? '수동 연결' : c.state, c.problem, Math.round(x.frac * 100), c.area, x.area]); }
  }
  for (const x of lk.orphans) rows.push([d.name, g, '', x.id, x.ok ? '확인됨' : '확인 필요', x.manual ? '연결 끊음' : '세포 밖', Math.round(x.frac * 100), '', x.area]);
  return new Blob(['﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
}
async function saveLinks() {
  const files = [];
  for (const name of S.sets) {  // 모든 세트를 불러와 대응표를 만든다 (열어 보지 않은 세트도 자동 연결 결과로)
    const d = await loadSet(name);
    for (const g of ['초벌', '정답']) { const b = linkCsv(d, g); if (b) files.push([`${name}_대응표_${g}.csv`, b]); }
  }
  files.push([LINK_FILE, new Blob([JSON.stringify({ version: 1, folder: L.folder, saved: new Date().toISOString(), over: L.over }, null, 2)], { type: 'application/json' })]);
  try {
    if (S.dir && (await S.dir.requestPermission({ mode: 'readwrite' })) === 'granted') {
      const sub = await S.dir.getDirectoryHandle(SAVE_DIR, { create: true });
      for (const [fn, b] of files) { const fh = await sub.getFileHandle(fn, { create: true }); const w = await fh.createWritable(); await w.write(b); await w.close(); if (fn === LINK_FILE) S.edited.set(fn, fh); }
      msg(`대응표 ${files.length - 1}개와 확인 기록을 ${S.dir.name}/${SAVE_DIR}/ 에 저장했습니다.`); return;
    }
  } catch (e) { console.warn(e); }
  const entries = []; for (const [fn, b] of files) entries.push({ name: fn, data: new Uint8Array(await b.arrayBuffer()) });
  download(zipStore(entries), `대응표_${L.folder}_${todayYMD()}.zip`);
  msg(`대응표 ${files.length - 1}개와 확인 기록을 zip으로 내려받았습니다. 압축을 풀어 폴더 안 ${SAVE_DIR}/ 에 넣으면 다음에 이어서 열립니다.`);
}

// ───────────────────────── 버튼 연결 ─────────────────────────
document.querySelectorAll('.lk-filter').forEach((b) => (b.onclick = () => { L.filter = b.dataset.f; renderLinkPanel(); }));
$('lk-lines').onchange = (e) => { L.lines = e.target.checked; draw(); };
$('lk-reset').onclick = resetSetLinks;
$('lk-save').onclick = saveLinks;
Object.assign(window.cellMaskEditor, { L, computeLinks, linkClick, assignNucleus, toggleOk, linkCsv, saveLinks });
