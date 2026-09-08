/* =======================================================================
   render.js — 도형 그리기 · 좌표 변환 · 히트 테스트
   ======================================================================= */

/* 표시 옵션 (app.js가 UI에서 갱신) */
const VIEW = {
  show: true,          // 도형 전체 표시
  labelMode: 'class',  // 'off' | 'class'(클래스당 1회) | 'each'(객체마다)
  lineW: 2,
  labelScale: 1,
  fillAlpha: 0.14,     // 폴리곤 채우기 투명도 (0이면 외곽선만)
  vertices: false,     // 꼭짓점 점 표시
  fitAnn: false,       // 어노테이션이 있는 영역만 잘라 크게 보기
  markSeen: true,      // 확대해서 본 이미지 카드를 표시
  classOff: new Set(), // 숨긴 클래스 id
  kindOff: new Set()   // 숨긴 도형 종류
};

const KINDS = ['box','polygon','polyline','point','circle'];
const KIND_LABEL = { box:'박스', polygon:'폴리곤', polyline:'폴리라인', point:'포인트', circle:'원' };

/* 클래스 색 — 0번 빨강과 헷갈리는 5번만 짙은 네이비로 고정 */
const COLOR_OVERRIDE = { 5:'#1f3a93' };
function colorFor(id){
  /* 라벨 자체에 색이 지정된 포맷(labelit의 extra.color)은 그 색을 그대로 쓴다 */
  if(CLS.colors && CLS.colors[id]) return CLS.colors[id];
  if(COLOR_OVERRIDE[id]) return COLOR_OVERRIDE[id];
  return `hsl(${(id*67)%360} 100% 58%)`;
}
const _txtColCache = new Map();
function labelTextColor(id){
  const key = id + '|' + colorFor(id);          // 색이 바뀌면 다시 계산
  if(_txtColCache.has(key)) return _txtColCache.get(key);
  let col = '#fff';
  try{
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const x = c.getContext('2d'); x.fillStyle = colorFor(id); x.fillRect(0,0,1,1);
    const d = x.getImageData(0,0,1,1).data;
    col = (0.299*d[0] + 0.587*d[1] + 0.114*d[2]) > 150 ? '#111827' : '#ffffff';
  }catch(e){}
  _txtColCache.set(key, col); return col;
}

/* ---- 좌표 변환: 정규화(YOLO) ↔ 픽셀 ---- */
function ringsOf(sh){ return sh.rings && sh.rings.length ? sh.rings : [sh.pts]; }
function ringsPx(sh, W, H){
  const sx = sh.norm ? W : 1, sy = sh.norm ? H : 1;
  return ringsOf(sh).map(r => r.map(p => [p[0]*sx, p[1]*sy]));
}
function ptsPx(sh, W, H){
  const sx = sh.norm ? W : 1, sy = sh.norm ? H : 1;
  return sh.pts.map(p => [p[0]*sx, p[1]*sy]);
}
/* 도형의 픽셀 바운딩 박스 */
function shapeRect(sh, W, H){
  const rs = ringsPx(sh, W, H);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for(const r of rs) for(const p of r){
    if(p[0] < minx) minx = p[0]; if(p[0] > maxx) maxx = p[0];
    if(p[1] < miny) miny = p[1]; if(p[1] > maxy) maxy = p[1];
  }
  if(sh.kind === 'circle' && sh.pts.length >= 2){
    const [c, e] = ptsPx(sh, W, H), rad = Math.hypot(e[0]-c[0], e[1]-c[1]);
    return { x:c[0]-rad, y:c[1]-rad, w:rad*2, h:rad*2 };
  }
  if(sh.kind === 'point'){
    const c = ptsPx(sh, W, H)[0]; return { x:c[0], y:c[1], w:0, h:0 };
  }
  return { x:minx, y:miny, w:maxx-minx, h:maxy-miny };
}
function shapeArea(sh, W, H){ const r = shapeRect(sh, W, H); return Math.max(1, r.w*r.h); }
const visibleShape = sh => !VIEW.classOff.has(sh.cls) && !VIEW.kindOff.has(sh.kind);

/* 보이는 도형 + 오류 지점을 모두 감싸는 영역 (여백 포함). 없으면 null → 전체 이미지 */
function annBounds(shapes, errors, W, H){
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, any = false;
  const add = (x, y, w, h) => { any = true;
    minx = Math.min(minx, x); miny = Math.min(miny, y);
    maxx = Math.max(maxx, x + (w||0)); maxy = Math.max(maxy, y + (h||0)); };
  for(const sh of shapes){
    if(!visibleShape(sh)) continue;
    const r = shapeRect(sh, W, H);
    add(r.x, r.y, r.w, r.h);
  }
  for(const e of (errors || []))            // 누락 지점 표시도 잘리지 않게 포함
    if(e.kind === 'point') add(e.x*W, e.y*H, 0, 0);
  if(!any) return null;
  let w = maxx - minx, h = maxy - miny;
  const pad = Math.max(16, Math.min(W, H)*0.02, Math.max(w, h)*0.14);
  let x = minx - pad, y = miny - pad; w += pad*2; h += pad*2;
  /* 너무 작은 영역은 과하게 확대되므로 최소 크기를 둔다 */
  const minSide = Math.max(120, Math.min(W, H)*0.12);
  if(w < minSide){ x -= (minSide - w)/2; w = minSide; }
  if(h < minSide){ y -= (minSide - h)/2; h = minSide; }
  x = Math.max(0, Math.min(x, W - Math.min(w, W)));
  y = Math.max(0, Math.min(y, H - Math.min(h, H)));
  w = Math.min(w, W - x); h = Math.min(h, H - y);
  if(w >= W && h >= H) return null;         // 사실상 전체면 자르지 않음
  return {x:Math.round(x), y:Math.round(y), w:Math.round(w), h:Math.round(h)};
}

/* ---- 개별 도형 경로 ---- */
function pathShape(ctx, sh, W, H){
  const rs = ringsPx(sh, W, H);
  ctx.beginPath();
  if(sh.kind === 'box'){
    const r = shapeRect(sh, W, H);
    ctx.rect(Math.round(r.x)+.5, Math.round(r.y)+.5, Math.round(r.w), Math.round(r.h));
  } else if(sh.kind === 'circle'){
    const [c, e] = ptsPx(sh, W, H), rad = Math.hypot(e[0]-c[0], e[1]-c[1]);
    ctx.arc(c[0], c[1], rad, 0, Math.PI*2);
  } else if(sh.kind === 'point'){
    const c = ptsPx(sh, W, H)[0], u = Math.max(5, Math.min(W,H)/80);
    ctx.moveTo(c[0]-u, c[1]); ctx.lineTo(c[0]+u, c[1]);
    ctx.moveTo(c[0], c[1]-u); ctx.lineTo(c[0], c[1]+u);
    ctx.moveTo(c[0]+u*0.75, c[1]); ctx.arc(c[0], c[1], u*0.75, 0, Math.PI*2);
  } else {
    for(const r of rs){
      r.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      if(sh.kind === 'polygon') ctx.closePath();
    }
  }
}
function drawVertices(ctx, sh, W, H, col, vp){
  if(sh.kind === 'box' || sh.kind === 'point') return;
  const rad = Math.max(1.6, Math.min(vp.w, vp.h)/420 + VIEW.lineW*0.4);
  ctx.save(); ctx.fillStyle = col; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = rad*0.5;
  for(const r of ringsPx(sh, W, H)) for(const p of r){
    ctx.beginPath(); ctx.arc(p[0], p[1], rad, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

/* ---- 클래스 이름 칩 (박스 위쪽 바깥) ---- */
function drawClassLabel(ctx, r, text, id, vp){
  const fs = Math.max(10, Math.round(Math.min(vp.w, vp.h)/55 * VIEW.labelScale));
  const padX = Math.max(3, Math.round(fs*0.35)), padY = Math.max(2, Math.round(fs*0.18));
  ctx.save();
  ctx.font = `600 ${fs}px sans-serif`; ctx.textBaseline = 'top';
  const bw = ctx.measureText(text).width + padX*2, bh = fs + padY*2;
  let x = Math.round(r.x);
  let y = Math.round(r.y) - bh - Math.max(2, Math.round(fs*0.18));
  if(y < vp.y) y = Math.round(r.y + r.h) + Math.max(2, Math.round(fs*0.18));
  x = Math.min(Math.max(vp.x, x), Math.max(vp.x, vp.x + vp.w - bw));
  ctx.globalAlpha = .9; ctx.fillStyle = colorFor(id); ctx.fillRect(x, y, bw, bh); ctx.globalAlpha = 1;
  ctx.fillStyle = labelTextColor(id); ctx.fillText(text, x + padX, y + padY);
  ctx.restore();
}
/* ---- 오류 배지 / 선택 강조 ---- */
function drawErrBadge(ctx, r, num, vp){
  const u = Math.max(2, Math.min(vp.w, vp.h)/300), pad = u*1.5;
  const x0 = r.x - pad, y0 = r.y - pad, w = Math.max(r.w, u*2) + pad*2, h = Math.max(r.h, u*2) + pad*2;
  ctx.save();
  ctx.setLineDash([u*5, u*3]);
  ctx.lineWidth = Math.max(2, VIEW.lineW + u); ctx.strokeStyle = '#ff2d2d';
  ctx.strokeRect(x0, y0, w, h);
  ctx.setLineDash([]);
  const rad = Math.max(11, Math.min(vp.w, vp.h)/40);
  /* 번호 배지는 오른쪽 위 바깥에 — 왼쪽 위는 클래스 이름 칩 자리라 겹친다 */
  let bx = Math.min(Math.max(x0 + w + rad*0.2, vp.x + rad), vp.x + vp.w - rad);
  let by = Math.max(y0 - rad - u, vp.y + rad);
  ctx.beginPath(); ctx.arc(bx, by, rad, 0, Math.PI*2);
  ctx.fillStyle = '#ff2d2d'; ctx.fill();
  ctx.lineWidth = Math.max(1.5, rad*0.12); ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(rad*1.15)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(num), bx, by + 1);
  ctx.restore();
}
function drawSelHighlight(ctx, r, vp){
  const u = Math.max(2, Math.min(vp.w, vp.h)/300);
  ctx.save();
  ctx.lineWidth = Math.max(2, VIEW.lineW + u*1.5); ctx.strokeStyle = '#ffd400';
  ctx.strokeRect(r.x - u*2.5, r.y - u*2.5, Math.max(r.w, u) + u*5, Math.max(r.h, u) + u*5);
  ctx.restore();
}
function drawPointErr(ctx, px, py, num, vp){
  const u = Math.max(2, Math.min(vp.w, vp.h)/300), r = Math.max(12, Math.min(vp.w, vp.h)/38);
  ctx.save();
  ctx.strokeStyle = '#ff2d2d'; ctx.lineWidth = Math.max(2, VIEW.lineW + u);
  ctx.beginPath();
  ctx.moveTo(px-r, py); ctx.lineTo(px+r, py);
  ctx.moveTo(px, py-r); ctx.lineTo(px, py+r);
  ctx.stroke();
  const bx = px + r*0.95, by = py - r*0.95, br = r*0.8;
  ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI*2);
  ctx.fillStyle = '#ff2d2d'; ctx.fill();
  ctx.lineWidth = Math.max(1.5, br*0.14); ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(br*1.15)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(num), bx, by + 1);
  ctx.restore();
}
function drawPointSel(ctx, px, py, vp){
  const u = Math.max(2, Math.min(vp.w, vp.h)/300), r = Math.max(15, Math.min(vp.w, vp.h)/30);
  ctx.save();
  ctx.strokeStyle = '#ffd400'; ctx.lineWidth = Math.max(2, VIEW.lineW + u*1.5);
  ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI*2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px-r*1.35, py); ctx.lineTo(px+r*1.35, py);
  ctx.moveTo(px, py-r*1.35); ctx.lineTo(px, py+r*1.35);
  ctx.stroke();
  ctx.restore();
}

/* =======================================================================
   메인 렌더: 이미지 + 도형 + 오류 표시
   opts = {errors:[], sel:{mode:'shape',i}|{mode:'point',x,y}, force:boolean, focus:index}
   ======================================================================= */
function drawScene(canvas, img, shapes, opts){
  opts = opts || {};
  const W = img.naturalWidth, H = img.naturalHeight;
  /* '라벨 영역만' 이면 어노테이션을 감싸는 부분만 잘라서 그린다 (좌표계는 원본 그대로) */
  const crop = VIEW.fitAnn ? annBounds(shapes, opts.errors, W, H) : null;
  const vp = crop || {x:0, y:0, w:W, h:H};
  canvas.width = vp.w; canvas.height = vp.h;
  const ctx = canvas.getContext('2d');
  ctx.translate(-vp.x, -vp.y);
  ctx.drawImage(img, 0, 0);
  if(!(opts.force || VIEW.show)){ ctx.setTransform(1,0,0,1,0,0); return { W, H, vp }; }

  const lw = VIEW.lineW;
  const glow = Math.min(6, Math.max(2, Math.round(Math.min(vp.w, vp.h)/500) + lw));
  const drawn = [];
  /* 1) 채우기 (폴리곤/원) */
  if(VIEW.fillAlpha > 0){
    ctx.save(); ctx.globalAlpha = VIEW.fillAlpha;
    for(const sh of shapes){
      if(!visibleShape(sh)) continue;
      if(sh.kind !== 'polygon' && sh.kind !== 'circle' && sh.kind !== 'box') continue;
      ctx.fillStyle = colorFor(sh.cls);
      pathShape(ctx, sh, W, H); ctx.fill('evenodd');
    }
    ctx.restore();
  }
  /* 2) 흰 후광 → 어두운 배경에서도 선이 뜨게 */
  ctx.save();
  ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,255,255,.95)'; ctx.shadowBlur = glow;
  for(const sh of shapes){
    if(!visibleShape(sh)) continue;
    ctx.strokeStyle = colorFor(sh.cls);
    pathShape(ctx, sh, W, H); ctx.stroke();
    drawn.push(sh);
  }
  /* 3) 후광 없이 색선 덧그리기 */
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  for(const sh of drawn){
    ctx.strokeStyle = colorFor(sh.cls);
    pathShape(ctx, sh, W, H); ctx.stroke();
    if(VIEW.vertices) drawVertices(ctx, sh, W, H, colorFor(sh.cls), vp);
  }
  ctx.restore();

  /* 4) 클래스 이름 */
  if(VIEW.labelMode !== 'off'){
    const once = VIEW.labelMode === 'class';
    const seen = new Set();
    for(const sh of shapes){
      if(!visibleShape(sh)) continue;
      if(once && seen.has(sh.cls)) continue;
      seen.add(sh.cls);
      drawClassLabel(ctx, shapeRect(sh, W, H), `${sh.cls}: ${CLS.nameOf(sh.cls)}`, sh.cls, vp);
    }
  }
  /* 5) 오류 배지 */
  const errs = opts.errors || [];
  errs.forEach((e, n) => {
    if(e.kind === 'shape'){
      const sh = shapes[e.i]; if(!sh || !visibleShape(sh)) return;
      drawErrBadge(ctx, shapeRect(sh, W, H), n+1, vp);
    } else drawPointErr(ctx, e.x*W, e.y*H, n+1, vp);
  });
  /* 6) 선택 강조 */
  const sel = opts.sel;
  if(sel){
    if(sel.mode === 'shape' && shapes[sel.i]){
      const sh = shapes[sel.i];
      drawSelHighlight(ctx, shapeRect(sh, W, H), vp);
      ctx.save(); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = Math.max(2, lw + 1);
      pathShape(ctx, sh, W, H); ctx.stroke(); ctx.restore();
      drawVertices(ctx, sh, W, H, '#ffd400', vp);
    } else if(sel.mode === 'point') drawPointSel(ctx, sel.x*W, sel.y*H, vp);
  }
  ctx.setTransform(1,0,0,1,0,0);   // 이후 이 캔버스에 덧그리는 코드(배너 등)를 위해 원상복구
  return { W, H, vp };
}

/* ======================= 히트 테스트 ======================= */
function pointInRing(x, y, ring){
  let inside = false;
  for(let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if(((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)) inside = !inside;
  }
  return inside;
}
function distToSeg(px, py, a, b){
  const dx = b[0]-a[0], dy = b[1]-a[1];
  const L = dx*dx + dy*dy;
  let t = L ? ((px-a[0])*dx + (py-a[1])*dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t*dx), py - (a[1] + t*dy));
}
function distToShape(sh, x, y, W, H){
  const rs = ringsPx(sh, W, H);
  if(sh.kind === 'point'){ const c = rs[0][0]; return Math.hypot(x-c[0], y-c[1]); }
  if(sh.kind === 'circle'){
    const [c, e] = ptsPx(sh, W, H), rad = Math.hypot(e[0]-c[0], e[1]-c[1]);
    return Math.abs(Math.hypot(x-c[0], y-c[1]) - rad);
  }
  if(sh.kind === 'box'){
    const r = shapeRect(sh, W, H);
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w)), dy = Math.max(r.y - y, 0, y - (r.y + r.h));
    return Math.hypot(dx, dy);
  }
  let best = Infinity;
  for(const r of rs){
    const n = r.length;
    for(let i = 0; i + 1 < n; i++) best = Math.min(best, distToSeg(x, y, r[i], r[i+1]));
    if(sh.kind === 'polygon' && n > 2) best = Math.min(best, distToSeg(x, y, r[n-1], r[0]));
  }
  return best;
}
/* 클릭 지점에서 가장 그럴듯한 도형 index (없으면 -1) */
function hitTest(shapes, x, y, W, H){
  const tol = Math.max(4, Math.min(W,H) * 0.006 + VIEW.lineW*1.5);
  let best = -1, bestScore = Infinity;
  shapes.forEach((sh, i) => {
    if(!visibleShape(sh)) return;
    let inside = false;
    if(sh.kind === 'box'){
      const r = shapeRect(sh, W, H);
      inside = x >= r.x - tol/2 && x <= r.x + r.w + tol/2 && y >= r.y - tol/2 && y <= r.y + r.h + tol/2;
    } else if(sh.kind === 'polygon'){
      let n = 0; for(const r of ringsPx(sh, W, H)) if(pointInRing(x, y, r)) n++;
      inside = (n % 2) === 1;
    } else if(sh.kind === 'circle'){
      const [c, e] = ptsPx(sh, W, H), rad = Math.hypot(e[0]-c[0], e[1]-c[1]);
      inside = Math.hypot(x-c[0], y-c[1]) <= rad + tol;
    }
    const d = distToShape(sh, x, y, W, H);
    if(inside || d <= tol){
      /* 겹칠 때는 더 작은 도형(=정밀한 선택)을 우선, 선/점은 거리 우선 */
      const score = (sh.kind === 'polyline' || sh.kind === 'point') ? d : shapeArea(sh, W, H) / 1e6 + d/1e3;
      if(score < bestScore){ bestScore = score; best = i; }
    }
  });
  if(best >= 0) return best;
  /* 근처에 아무것도 없으면 임계값 안의 가장 가까운 도형 (작은 객체 클릭 보조) */
  const far = Math.max(W, H) * 0.03;
  let bd = far, bi = -1;
  shapes.forEach((sh, i) => {
    if(!visibleShape(sh)) return;
    const d = distToShape(sh, x, y, W, H);
    if(d < bd){ bd = d; bi = i; }
  });
  return bi;
}
