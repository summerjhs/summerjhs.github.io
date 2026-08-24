/* =======================================================================
   parsers.js — 여러 어노테이션 포맷을 하나의 도형(Shape) 모델로 변환
   -----------------------------------------------------------------------
   Shape = {
     cls   : number          클래스 id (문자열 라벨은 CLS 레지스트리가 id 부여)
     kind  : 'box'|'polygon'|'polyline'|'point'|'circle'
     pts   : [[x,y], ...]    box=[[x1,y1],[x2,y2]] · circle=[center, edge]
     rings : [[...pts], ...] (폴리곤 다중 링일 때만)
     norm  : true면 좌표가 0~1 정규화값 (YOLO), false면 이미지 픽셀
     src   : {fmt, raw|idx|ann}  원본 재직렬화를 위한 참조
     attrs : {}              truncated/difficult/score 등 부가정보
   }
   ======================================================================= */

/* ---- 클래스 레지스트리: 숫자 id(YOLO)와 문자열 라벨(VOC/LabelMe/COCO)을 함께 수용 ---- */
const CLS = {
  names: {},        // id -> name
  idOf: {},         // lowercase name -> id
  /* 이름으로 id를 얻는다. 처음 보는 이름이면 비어있는 가장 작은 id를 할당 */
  register(name){
    const key = String(name).trim().toLowerCase();
    if(this.idOf[key] != null) return this.idOf[key];
    let id = 0; while(this.names[id] != null) id++;
    this.names[id] = String(name).trim();
    this.idOf[key] = id;
    return id;
  },
  /* 숫자 id를 확보한다 (YOLO). 이름이 없으면 'class N' */
  ensureId(id){
    if(this.names[id] == null){ this.names[id] = 'class ' + id; this.idOf['class ' + id] = id; }
    return id;
  },
  nameOf(id){ return this.names[id] != null ? this.names[id] : ('class ' + id); },
  /* 클래스 이름 파일(.txt/.yaml/.json)을 통째로 적용 */
  setNames(obj){
    this.names = {}; this.idOf = {};
    for(const k in obj){ const id = +k; this.names[id] = String(obj[k]); this.idOf[String(obj[k]).toLowerCase()] = id; }
  },
  reset(){ this.names = {}; this.idOf = {}; }
};

/* ---- 확장자 / 파일명 유틸 ---- */
const extOf = n => (n.split('.').pop() || '').toLowerCase();
const IMG_EXT = ['jpg','jpeg','png','bmp','webp','tif','tiff','gif'];
/* image.jpg · image.txt · image.jpg.txt · image.xml 을 모두 같은 키로 정규화 */
function baseOf(n){
  /* 한글 파일명은 macOS(NFD)와 Windows/JSON(NFC)의 표현이 달라 그대로는 매칭이 안 된다 → NFC로 통일 */
  let s = String(n).normalize ? String(n).normalize('NFC').toLowerCase() : String(n).toLowerCase();
  s = s.replace(/\.(txt|json|xml)$/, '');
  s = s.replace(/\.(jpe?g|png|bmp|webp|tiff?|gif)$/, '');
  return s;
}

/* =========================== YOLO (.txt) =========================== */
/* "cls cx cy w h" → box · "cls x1 y1 x2 y2 x3 y3 …" → polygon(YOLO-seg/OBB) */
function parseYolo(text){
  const shapes = [];
  text = String(text).replace(/^﻿/, '');
  for(const line of text.split(/\r?\n/)){
    const t = line.trim(); if(!t) continue;
    const toks = t.split(/[\s,;\t]+/).filter(Boolean);
    if(toks.length < 3) continue;
    let cls;
    if(/^-?\d+(\.0+)?$/.test(toks[0])) cls = CLS.ensureId(Math.round(Number(toks[0])));
    else if(CLS.idOf[toks[0].toLowerCase()] != null) cls = CLS.idOf[toks[0].toLowerCase()];
    else cls = CLS.register(toks[0]);
    const nums = toks.slice(1).map(Number);
    if(nums.some(v => Number.isNaN(v))) continue;
    /* 좌표가 1보다 크면 픽셀 좌표로 판단 (정규화 아님) */
    const norm = !nums.slice(0, 4).some(v => v > 1.5);
    if(nums.length === 4 || nums.length === 5){
      const [cx, cy, w, h] = nums;
      shapes.push({ cls, kind:'box', pts:[[cx - w/2, cy - h/2], [cx + w/2, cy + h/2]],
                    norm, src:{fmt:'yolo', raw:t}, attrs: nums.length === 5 ? {score:nums[4]} : {} });
    } else if(nums.length >= 6){
      let c = nums.slice(); if(c.length % 2) c = c.slice(0, -1);
      const pts = []; for(let i = 0; i < c.length; i += 2) pts.push([c[i], c[i+1]]);
      shapes.push({ cls, kind:'polygon', pts, norm, src:{fmt:'yolo', raw:t}, attrs:{} });
    }
  }
  return shapes;
}
/* 클래스만 바꾼 YOLO 한 줄 (좌표·형식 그대로 유지) */
function yoloLine(sh){
  if(sh.src && sh.src.raw != null) return sh.src.raw.replace(/^(﻿?\s*)\S+/, `$1${sh.cls}`);
  const f = v => Number.isInteger(v) ? String(v) : (+v.toFixed(6)).toString();
  if(sh.kind === 'box'){
    const [[x1,y1],[x2,y2]] = sh.pts;
    return `${sh.cls} ${f((x1+x2)/2)} ${f((y1+y2)/2)} ${f(Math.abs(x2-x1))} ${f(Math.abs(y2-y1))}`;
  }
  return `${sh.cls} ` + sh.pts.map(p => `${f(p[0])} ${f(p[1])}`).join(' ');
}

/* ======================== PASCAL VOC (.xml) ======================== */
function parseVoc(text){
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if(doc.querySelector('parsererror')) return null;
  const shapes = [];
  const objs = [...doc.getElementsByTagName('object')];
  objs.forEach((o, idx) => {
    const name = (o.getElementsByTagName('name')[0]?.textContent || 'object').trim();
    const cls = CLS.register(name);
    const attrs = {};
    for(const k of ['truncated','difficult','occluded','pose']){
      const v = o.getElementsByTagName(k)[0]?.textContent;
      if(v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'unspecified') attrs[k] = v.trim();
    }
    const bb = o.getElementsByTagName('bndbox')[0];
    const pg = o.getElementsByTagName('polygon')[0];
    const num = (el, tag) => parseFloat(el.getElementsByTagName(tag)[0]?.textContent);
    if(bb){
      const x1 = num(bb,'xmin'), y1 = num(bb,'ymin'), x2 = num(bb,'xmax'), y2 = num(bb,'ymax');
      if([x1,y1,x2,y2].every(v => !Number.isNaN(v)))
        shapes.push({ cls, kind:'box', pts:[[x1,y1],[x2,y2]], norm:false, src:{fmt:'voc', idx}, attrs });
    } else if(pg){
      /* <polygon><x1>..</x1><y1>..</y1><x2>… 형태 */
      const pts = [];
      for(let i = 1; ; i++){
        const x = num(pg, 'x'+i), y = num(pg, 'y'+i);
        if(Number.isNaN(x) || Number.isNaN(y)) break;
        pts.push([x, y]);
      }
      if(pts.length >= 2)
        shapes.push({ cls, kind: pts.length >= 3 ? 'polygon' : 'polyline', pts, norm:false, src:{fmt:'voc', idx}, attrs });
    }
  });
  const sz = doc.getElementsByTagName('size')[0];
  const dim = sz ? { w:parseInt(sz.getElementsByTagName('width')[0]?.textContent),
                     h:parseInt(sz.getElementsByTagName('height')[0]?.textContent) } : null;
  return { shapes, doc, dim: (dim && dim.w && dim.h) ? dim : null };
}
/* 변경된 클래스·삭제를 반영해 VOC XML 문자열 재생성 */
function serializeVoc(doc, shapes){
  const clone = doc.cloneNode(true);
  const objs = [...clone.getElementsByTagName('object')];
  const keep = new Map();                                  // 원본 idx -> shape
  for(const sh of shapes) if(sh.src && sh.src.fmt === 'voc') keep.set(sh.src.idx, sh);
  objs.forEach((o, idx) => {
    const sh = keep.get(idx);
    if(!sh){ o.parentNode.removeChild(o); return; }         // 삭제된 객체
    const nm = o.getElementsByTagName('name')[0];
    if(nm) nm.textContent = CLS.nameOf(sh.cls);
  });
  return new XMLSerializer().serializeToString(clone);
}

/* ========================= LabelMe (.json) ========================= */
const LM_KIND = { rectangle:'box', polygon:'polygon', line:'polyline', linestrip:'polyline',
                  point:'point', circle:'circle', points:'polyline' };
function parseLabelMe(obj){
  const shapes = [];
  (obj.shapes || []).forEach((s, idx) => {
    const pts = (s.points || []).map(p => Array.isArray(p) ? [ +p[0], +p[1] ] : [ +p.x, +p.y ])
                                .filter(p => !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
    if(!pts.length) return;
    let kind = LM_KIND[String(s.shape_type || '').toLowerCase()];
    if(!kind) kind = pts.length === 1 ? 'point' : (pts.length === 2 ? 'polyline' : 'polygon');
    if(kind === 'box' && pts.length >= 2) {
      const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1]);
      shapes.push({ cls: CLS.register(s.label ?? 'object'), kind:'box',
                    pts:[[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]],
                    norm:false, src:{fmt:'labelme', idx}, attrs: s.group_id != null ? {group:s.group_id} : {} });
      return;
    }
    shapes.push({ cls: CLS.register(s.label ?? 'object'), kind, pts, norm:false,
                  src:{fmt:'labelme', idx}, attrs: s.group_id != null ? {group:s.group_id} : {} });
  });
  const dim = (obj.imageWidth && obj.imageHeight) ? { w:obj.imageWidth, h:obj.imageHeight } : null;
  return { shapes, obj, dim };
}
function serializeLabelMe(obj, shapes){
  const out = JSON.parse(JSON.stringify(obj));
  const keep = new Map();
  for(const sh of shapes) if(sh.src && sh.src.fmt === 'labelme') keep.set(sh.src.idx, sh);
  out.shapes = (obj.shapes || []).map((s, idx) => {
    const sh = keep.get(idx); if(!sh) return null;
    const c = JSON.parse(JSON.stringify(s));
    c.label = CLS.nameOf(sh.cls);
    return c;
  }).filter(Boolean);
  return JSON.stringify(out, null, 2);
}

/* =========================== COCO (.json) =========================== */
function isCocoJson(o){
  return !!o && Array.isArray(o.annotations) && Array.isArray(o.images);
}
/* COCO 한 파일 → base별 shapes 맵. 카테고리는 CLS에 등록 */
function parseCoco(obj){
  const catName = {};
  for(const c of (obj.categories || [])) catName[c.id] = c.name;
  const imgById = {};
  for(const im of obj.images) imgById[im.id] = im;
  const byBase = new Map(), dims = new Map();
  for(const im of obj.images){
    const b = baseOf(im.file_name.split(/[\\/]/).pop());
    byBase.set(b, []);
    if(im.width && im.height) dims.set(b, { w:im.width, h:im.height });
  }
  let rle = 0;
  for(const ann of obj.annotations){
    const im = imgById[ann.image_id]; if(!im) continue;
    const b = baseOf(im.file_name.split(/[\\/]/).pop());
    const arr = byBase.get(b) || (byBase.set(b, []), byBase.get(b));
    const cls = CLS.register(catName[ann.category_id] ?? ('cat ' + ann.category_id));
    const attrs = {};
    if(ann.iscrowd) attrs.iscrowd = 1;
    if(ann.score != null) attrs.score = ann.score;
    const seg = ann.segmentation;
    if(Array.isArray(seg) && seg.length && Array.isArray(seg[0])){
      const rings = seg.map(poly => {
        const pts = []; for(let i = 0; i + 1 < poly.length; i += 2) pts.push([poly[i], poly[i+1]]);
        return pts;
      }).filter(r => r.length >= 3);
      if(rings.length){
        arr.push({ cls, kind:'polygon', pts:rings[0], rings, norm:false, src:{fmt:'coco', ann}, attrs });
        continue;
      }
    } else if(seg && !Array.isArray(seg)) rle++;            // RLE 마스크 → bbox로 대체 표시
    if(Array.isArray(ann.bbox) && ann.bbox.length === 4){
      const [x, y, w, h] = ann.bbox;
      arr.push({ cls, kind:'box', pts:[[x, y], [x + w, y + h]], norm:false, src:{fmt:'coco', ann}, attrs });
    }
  }
  return { byBase, dims, obj, rle };
}
/* 변경(클래스 수정·삭제)을 반영한 COCO JSON 문자열 */
function serializeCoco(obj, keptAnnSet, clsOfAnn){
  const nameToCat = {};
  for(const c of (obj.categories || [])) nameToCat[String(c.name).toLowerCase()] = c.id;
  const out = JSON.parse(JSON.stringify(obj));
  out.annotations = (obj.annotations || []).filter(a => keptAnnSet.has(a)).map(a => {
    const c = JSON.parse(JSON.stringify(a));
    const clsId = clsOfAnn.get(a);
    if(clsId != null){
      const nm = CLS.nameOf(clsId).toLowerCase();
      if(nameToCat[nm] != null) c.category_id = nameToCat[nm];
    }
    return c;
  });
  return JSON.stringify(out);
}

/* ================= labelit.pro 결과 (JSONL / JSON) =================
   한 줄에 이미지 한 장의 레코드가 들어 있는 형식.
     {"dataID":…, "importData_file_name":"a.jpg",
      "name_XXXXXX": { info:[{name:'Image Bounding', assets:{label_symbol:{…}}}],
                       data:[{objectID, value:{annotation:'BOX', coords:{tl,tr,br,bl},
                                               object:{left,top,width,height,angle},
                                               label_symbol:'K'}}] } }
   ------------------------------------------------------------------- */
/* 어노테이션 묶음(= info/data를 가진 키) 목록 */
function labelitGroups(rec){
  const out = [];
  for(const k in rec){
    const v = rec[k];
    if(v && typeof v === 'object' && Array.isArray(v.data) && Array.isArray(v.info)) out.push(k);
  }
  return out;
}
const LABELIT_NAME_KEYS = ['importData_file_name','file_name','fileName','imagePath','image','filename','name','dataID'];
function labelitFileName(rec){
  for(const k of LABELIT_NAME_KEYS){ const v = rec[k]; if(typeof v === 'string' && v.trim()) return v.trim(); }
  if(rec.dataID != null) return String(rec.dataID);
  return null;
}
function isLabelitRecord(o){
  return !!o && typeof o === 'object' && !Array.isArray(o) && labelitGroups(o).length > 0;
}
/* JSONL(줄마다 JSON) 파싱 — 한 줄이라도 깨지면 건너뛴다 */
function parseJsonLines(text){
  const recs = [];
  for(const line of String(text).replace(/^﻿/, '').split(/\r?\n/)){
    const t = line.trim(); if(!t) continue;
    try{ const o = JSON.parse(t); if(o && typeof o === 'object') recs.push(o); }catch(e){}
  }
  return recs;
}
/* info의 assets에서 '라벨을 담고 있는 필드'를 찾아, 값과 필드 설명을 돌려준다 */
function labelitLabel(val, group){
  const assetKeys = [];
  for(const inf of (group.info || []))
    for(const ak in (inf.assets || {})) if(!assetKeys.includes(ak)) assetKeys.push(ak);
  const attrs = {};
  let name = null, field = null;
  const take = (k, v) => {
    let txt = null, kind = null;
    if(typeof v === 'string'){ txt = v.trim(); kind = 'string'; }
    else if(Array.isArray(v)){ txt = v.map(x => (x && (x.label ?? x.value)) || '').filter(Boolean).join('/'); kind = 'array'; }
    else if(v && typeof v === 'object' && (v.label != null || v.value != null)){ txt = String(v.label ?? v.value); kind = 'object'; }
    if(!txt) return;
    if(name == null){ name = txt; field = {key:k, kind}; } else attrs[k] = txt;
  };
  for(const k of assetKeys) if(val[k] != null) take(k, val[k]);
  if(name == null && val.extra && (val.extra.label || val.extra.value)){
    name = String(val.extra.label || val.extra.value); field = {key:'extra', kind:'extra'};
  }
  if(name == null && typeof val.label === 'string' && val.label.trim()){
    name = val.label.trim(); field = {key:'label', kind:'string'};
  }
  if(val.text && String(val.text).trim()) attrs.text = String(val.text).trim();
  if(Array.isArray(val.warnings) && val.warnings.length) attrs.warnings = val.warnings.length;
  return {name, field, attrs};
}
const LABELIT_KIND = { BOX:'box', RBOX:'polygon', POLYGON:'polygon', POLY:'polygon',
                       POLYLINE:'polyline', LINE:'polyline', POINT:'point', DOT:'point', CIRCLE:'circle' };
/* 레코드 하나 → shapes */
function labelitShapes(rec){
  const shapes = [];
  for(const gk of labelitGroups(rec)){
    const g = rec[gk];
    (g.data || []).forEach((d, idx) => {
      const val = d.value || {};
      const ann = String(val.annotation || '').toUpperCase();
      const {name, field, attrs} = labelitLabel(val, g);
      const cls = CLS.register(name || ann || 'object');
      const src = {fmt:'labelit', rec, grp:gk, idx, ref:d, field};
      const pts = (val.points || val.point || []).map ? (val.points || []) : [];
      const toXY = p => [ +(p.x ?? p[0]), +(p.y ?? p[1]) ];
      let kind = LABELIT_KIND[ann] || null;
      const c = val.coords;
      if((!kind || kind === 'box') && c && c.tl && c.br){
        const corners = [c.tl, c.tr, c.br, c.bl].filter(Boolean).map(toXY);
        const rotated = Math.abs(+(val.angle || (val.object && val.object.angle) || 0)) > 0.01;
        if(rotated && corners.length === 4){        // 회전 박스는 네 꼭짓점 폴리곤으로
          shapes.push({cls, kind:'polygon', pts:corners, norm:false, src, attrs});
          return;
        }
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        shapes.push({cls, kind:'box', pts:[[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]],
                     norm:false, src, attrs});
        return;
      }
      if((!kind || kind === 'box') && val.object && val.object.width != null){
        const o = val.object;
        shapes.push({cls, kind:'box', pts:[[+o.left, +o.top], [+o.left + +o.width, +o.top + +o.height]],
                     norm:false, src, attrs});
        return;
      }
      if(pts.length){
        const P = pts.map(toXY).filter(p => !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
        if(!P.length) return;
        if(!kind) kind = P.length === 1 ? 'point' : (P.length === 2 ? 'polyline' : 'polygon');
        if(kind === 'point') shapes.push({cls, kind:'point', pts:[P[0]], norm:false, src, attrs});
        else shapes.push({cls, kind, pts:P, norm:false, src, attrs});
        return;
      }
      if(val.object && val.object.left != null)     // 좌표만 있는 포인트
        shapes.push({cls, kind:'point', pts:[[+val.object.left, +val.object.top]], norm:false, src, attrs});
    });
  }
  return shapes;
}
/* 레코드 배열 → base별 shapes */
function parseLabelit(records){
  const byBase = new Map();
  for(const rec of records){
    const fn = labelitFileName(rec);
    if(!fn) continue;
    const b = baseOf(String(fn).split(/[\\/]/).pop());
    const arr = byBase.get(b) || [];
    arr.push(...labelitShapes(rec));
    byBase.set(b, arr);
  }
  return {byBase, records};
}
/* 라벨 수정·객체 삭제를 반영한 JSONL 문자열 */
function applyLabelitLabel(val, field, name){
  if(!field) return;
  if(field.kind === 'string') val[field.key] = name;
  else if(field.kind === 'array'){
    const first = Array.isArray(val[field.key]) && val[field.key][0] ? val[field.key][0] : {};
    val[field.key] = [Object.assign({}, first, {label:name})];
  }
  else if(field.kind === 'object') val[field.key] = Object.assign({}, val[field.key], {label:name});
  else if(field.kind === 'extra') val.extra = Object.assign({}, val.extra, {label:name});
}
function serializeLabelit(records, kept, clsOf, fieldOf){
  const lines = [];
  for(const rec of records){
    const copy = Object.assign({}, rec);
    for(const gk of labelitGroups(rec)){
      const g = rec[gk], nd = [];
      for(const d of (g.data || [])){
        if(!kept.has(d)) continue;
        const cd = JSON.parse(JSON.stringify(d));
        const cls = clsOf.get(d);
        if(cls != null) applyLabelitLabel(cd.value || (cd.value = {}), fieldOf.get(d), CLS.nameOf(cls));
        nd.push(cd);
      }
      copy[gk] = Object.assign({}, g, {data: nd});
    }
    lines.push(JSON.stringify(copy));
  }
  return lines.join('\n') + '\n';
}

/* =============== 클래스 이름 파일(.txt/.names/.yaml/.json) =============== */
function parseNamesFile(txt, fname){
  const names = {};
  const clean = s => String(s).trim().replace(/^['"]|['"]$/g, '');
  if(/\.json$/i.test(fname)){
    const j = JSON.parse(txt);
    if(Array.isArray(j)) j.forEach((n, i) => names[i] = clean(n));
    else Object.keys(j).forEach(k => names[+k] = clean(j[k]));
  } else if(/\.(ya?ml)$/i.test(fname)){
    let idx = 0, inNames = false;
    txt.split(/\r?\n/).forEach(line => {
      if(/^\s*names\s*:/.test(line)){ inNames = true;
        const inline = line.match(/\[(.*)\]/);
        if(inline){ inline[1].split(',').forEach(s => { const v = clean(s); if(v) names[idx++] = v; }); inNames = false; }
        return;
      }
      if(!inNames && Object.keys(names).length === 0 && !/^\s*[-\d]/.test(line)) return;
      let m;
      if(m = line.match(/^\s*-\s*(.+?)\s*$/)) names[idx++] = clean(m[1]);
      else if(m = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/)) names[+m[1]] = clean(m[2]);
    });
  } else {
    let auto = 0;
    txt.split(/\r?\n/).forEach(line => {
      const t = line.trim(); if(!t) return;
      const m = t.match(/^(\d+)\s*[,:\t ]\s*(.+)$/);
      if(m) names[+m[1]] = clean(m[2]); else names[auto++] = clean(t);
    });
  }
  return names;
}

/* ============ 라벨 파일 하나를 포맷 자동 감지해 파싱 ============ */
/* 반환: {fmt, shapes, doc?, obj?, dim?} · COCO 전체 파일이면 {fmt:'coco-global', json} */
function parseLabelFile(name, text){
  const ext = extOf(name);
  const bad = reason => ({ fmt:'unsupported', reason });
  if(ext === 'txt') return { fmt:'yolo', shapes: parseYolo(text) };
  if(ext === 'xml'){
    const r = parseVoc(text);
    return r ? { fmt:'voc', shapes:r.shapes, doc:r.doc, dim:r.dim } : bad('XML을 읽지 못했습니다 (형식 오류)');
  }
  if(ext === 'json' || ext === 'jsonl' || ext === 'ndjson'){
    let j = null;
    try{ j = JSON.parse(text); }catch(e){ j = null; }
    if(j){
      if(isCocoJson(j)) return { fmt:'coco-global', json:j };
      if(Array.isArray(j.shapes)){
        const r = parseLabelMe(j);
        return { fmt:'labelme', shapes:r.shapes, obj:r.obj, dim:r.dim };
      }
      if(isLabelitRecord(j)) return { fmt:'labelit-global', records:[j] };
      if(Array.isArray(j)){
        const recs = j.filter(isLabelitRecord);
        if(recs.length) return { fmt:'labelit-global', records:recs };
        const lm = j.filter(o => o && Array.isArray(o.shapes));
        if(lm.length) return { fmt:'labelit-global', records:[] };   // 형태만 맞고 내용 없음
      }
      const keys = Object.keys(j).slice(0, 6).join(', ');
      return bad(`JSON은 읽었지만 COCO·LabelMe·labelit 구조가 아닙니다 (최상위 키: ${keys})`);
    }
    /* 통짜 JSON이 아니면 JSONL(줄마다 JSON)로 다시 시도 — labelit.pro 결과 파일 */
    const all = parseJsonLines(text);
    const recs = all.filter(isLabelitRecord);
    if(recs.length) return { fmt:'labelit-global', records:recs };
    if(!all.length) return bad('JSON으로 읽히지 않습니다 (JSON도 JSONL도 아님)');
    const keys = Object.keys(all[0]).slice(0, 6).join(', ');
    return bad(`줄 단위 JSON ${all.length}개를 읽었지만 어노테이션 묶음(info+data)이 없습니다 (첫 줄 키: ${keys})`);
  }
  return bad(`지원하지 않는 확장자: .${ext}`);
}
