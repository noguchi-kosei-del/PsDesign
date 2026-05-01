// PSD 表示領域の上/左にルーラーを描画し、ドラッグでガイド線（cyan）を引ける機能。
// Photoshop の操作感を踏襲：
//   - 上ルーラーから下方向にドラッグ → 水平ガイド
//   - 左ルーラーから右方向にドラッグ → 垂直ガイド
//   - ガイド本体をドラッグで再配置
//   - ガイドをルーラー帯まで戻して離すと削除
//
// 設計判断（plan の Context 参照）:
//   - 座標系は PSD pixel。回転/ズーム/スクロールは描画時に変換。
//   - データは Map<psdPath, {h, v}> をモジュール内で保持（揮発、undo 対象外）。
//   - ルーラー帯は Canvas（HiDPI、再描画軽量）、ガイドは div absolute。
//   - rulersVisible のみ localStorage に保存（既存 panel 折畳と同パターン）。

import {
  getPages,
  getCurrentPageIndex,
  getPsdRotation,
  getPsdZoom,
  onPsdRotationChange,
  onPsdZoomChange,
  onPageIndexChange,
} from "./state.js";

// ===== State =====
const RULER_THICK = 18; // CSS px。styles.css の --ruler-thick と同期。
const VISIBLE_KEY = "psdesign_rulers_visible";
const LOCKED_KEY = "psdesign_guides_locked";

const guidesByPsd = new Map(); // psdPath -> { h: number[], v: number[] } （PSD pixel）
let rulersVisible = loadVisible();
const visibleListeners = new Set();
let guidesLocked = loadLocked();
const lockedListeners = new Set();
// guides 配列が変化（追加 / 移動 / 削除）したときに発火する listener。
// ガイドロックボタンの disabled 状態を「ガイドが 1 本以上引かれているか」と連動させる用途。
const guidesChangeListeners = new Set();
function emitGuidesChange(psdPath) {
  for (const fn of guidesChangeListeners) {
    try { fn(psdPath); } catch (e) { console.error(e); }
  }
}
export function onGuidesChange(fn) {
  guidesChangeListeners.add(fn);
  return () => guidesChangeListeners.delete(fn);
}
// 指定 PSD（省略時: 現在ページ）に水平 / 垂直のガイドが 1 本でも引かれているか。
export function hasAnyGuide(psdPath) {
  const path = psdPath ?? getCurrentPsdPath();
  if (!path) return false;
  const g = guidesByPsd.get(path);
  return !!g && ((g.h?.length ?? 0) + (g.v?.length ?? 0) > 0);
}

function loadVisible() {
  try { return localStorage.getItem(VISIBLE_KEY) === "1"; } catch { return false; }
}
function saveVisible() {
  try { localStorage.setItem(VISIBLE_KEY, rulersVisible ? "1" : "0"); } catch {}
}
function loadLocked() {
  try { return localStorage.getItem(LOCKED_KEY) === "1"; } catch { return false; }
}
function saveLocked() {
  try { localStorage.setItem(LOCKED_KEY, guidesLocked ? "1" : "0"); } catch {}
}

export function getRulersVisible() { return rulersVisible; }

export function setRulersVisible(on) {
  const v = !!on;
  if (rulersVisible === v) return;
  rulersVisible = v;
  saveVisible();
  applyVisibilityToDom();
  requestRulerRedraw();
  for (const fn of visibleListeners) fn(v);
}

export function toggleRulersVisible() { setRulersVisible(!rulersVisible); }

export function onRulersVisibleChange(fn) {
  visibleListeners.add(fn);
  return () => visibleListeners.delete(fn);
}

// ガイドのロック。true の間は新規作成・移動・削除のドラッグ操作を全てブロック。
// 表示自体は継続（Photoshop / InDesign の "ガイドをロック" と同じ挙動）。
export function getGuidesLocked() { return guidesLocked; }

export function setGuidesLocked(on) {
  const v = !!on;
  if (guidesLocked === v) return;
  guidesLocked = v;
  saveLocked();
  applyLockedToDom();
  for (const fn of lockedListeners) fn(v);
}

export function toggleGuidesLocked() { setGuidesLocked(!guidesLocked); }

export function onGuidesLockedChange(fn) {
  lockedListeners.add(fn);
  return () => lockedListeners.delete(fn);
}

function applyLockedToDom() {
  if (!paneEl) return;
  paneEl.classList.toggle("guides-locked", guidesLocked);
}

function getCurrentPsdPath() {
  const pages = getPages();
  if (pages.length === 0) return null;
  const idx = getCurrentPageIndex();
  return pages[Math.max(0, Math.min(pages.length - 1, idx))]?.path ?? null;
}

function getCurrentPage() {
  const pages = getPages();
  if (pages.length === 0) return null;
  const idx = getCurrentPageIndex();
  return pages[Math.max(0, Math.min(pages.length - 1, idx))] ?? null;
}

function getGuidesObj(psdPath) {
  if (!psdPath) return { h: [], v: [] };
  let g = guidesByPsd.get(psdPath);
  if (!g) { g = { h: [], v: [] }; guidesByPsd.set(psdPath, g); }
  return g;
}

export function getGuides(psdPath) { return getGuidesObj(psdPath); }

export function addGuide(psdPath, axis, psdValue) {
  if (!psdPath || !Number.isFinite(psdValue)) return;
  const g = getGuidesObj(psdPath);
  const list = axis === "h" ? g.h : g.v;
  list.push(Math.round(psdValue * 100) / 100);
  requestRulerRedraw();
  emitGuidesChange(psdPath);
}

export function moveGuide(psdPath, axis, index, psdValue) {
  if (!psdPath || !Number.isFinite(psdValue)) return;
  const g = getGuidesObj(psdPath);
  const list = axis === "h" ? g.h : g.v;
  if (index < 0 || index >= list.length) return;
  list[index] = Math.round(psdValue * 100) / 100;
  requestRulerRedraw();
  // 個数は変わらないが、座標は変わったので位置依存の UI（将来的なミニマップ等）のため通知。
  emitGuidesChange(psdPath);
}

export function removeGuide(psdPath, axis, index) {
  if (!psdPath) return;
  const g = getGuidesObj(psdPath);
  const list = axis === "h" ? g.h : g.v;
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  requestRulerRedraw();
  emitGuidesChange(psdPath);
}

// ===== Mount =====
let paneEl = null;       // .spreads-psd-area
let stageEl = null;      // #psd-stage
let rulersDiv = null;    // .psd-rulers
let topCanvas = null;    // #psd-ruler-top
let leftCanvas = null;   // #psd-ruler-left
let cornerEl = null;     // .psd-ruler-corner
let guidesLayer = null;  // .psd-guides-layer
let mounted = false;

export function initRulers() {
  if (mounted) return;
  paneEl = document.querySelector(".spreads-psd-area");
  stageEl = document.getElementById("psd-stage");
  rulersDiv = document.getElementById("psd-rulers");
  topCanvas = document.getElementById("psd-ruler-top");
  leftCanvas = document.getElementById("psd-ruler-left");
  cornerEl = rulersDiv?.querySelector(".psd-ruler-corner");
  guidesLayer = document.getElementById("psd-guides-layer");
  if (!paneEl || !stageEl || !rulersDiv || !topCanvas || !leftCanvas || !guidesLayer) return;
  mounted = true;

  applyVisibilityToDom();
  applyLockedToDom();

  // 描画タイミングを 1 経路にまとめる（rAF でcoalesce）。
  // ペイン / ステージに加え、ルーラー Canvas 自身もサイズ変化を監視（hidden 解除直後の
  // 初回 layout を確実に拾い、backing bitmap を CSS 計算サイズに同期させる）。
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => requestRulerRedraw());
    ro.observe(paneEl);
    ro.observe(stageEl);
    ro.observe(topCanvas);
    ro.observe(leftCanvas);
  }
  stageEl.addEventListener("scroll", requestRulerRedraw, { passive: true });
  onPsdZoomChange(requestRulerRedraw);
  onPsdRotationChange(requestRulerRedraw);
  onPageIndexChange(requestRulerRedraw);

  // ライト/ダークテーマ切替で目盛り色を再取得。
  const themeObserver = new MutationObserver(() => {
    cachedRulerColors = null;
    requestRulerRedraw();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ルーラー帯への mousedown でガイド作成開始。
  topCanvas.addEventListener("mousedown", (e) => beginCreateGuide(e, "h"));
  leftCanvas.addEventListener("mousedown", (e) => beginCreateGuide(e, "v"));

  // 初回描画。
  requestRulerRedraw();
}

function applyVisibilityToDom() {
  if (!paneEl) return;
  paneEl.classList.toggle("rulers-on", rulersVisible);
  if (rulersDiv) rulersDiv.hidden = !rulersVisible;
  if (guidesLayer) guidesLayer.hidden = !rulersVisible;
  // hidden 解除直後は layout がまだ確定していないことがあるため、
  // 次フレーム + さらに次フレームで再描画を 2 段かけて初回サイズを確実に拾う。
  if (rulersVisible) {
    requestAnimationFrame(() => requestAnimationFrame(() => requestRulerRedraw()));
  }
}

// ===== 描画 =====
let redrawScheduled = false;
export function requestRulerRedraw() {
  if (!mounted || redrawScheduled) return;
  redrawScheduled = true;
  requestAnimationFrame(() => {
    redrawScheduled = false;
    if (!rulersVisible) return;
    redraw();
  });
}

let cachedRulerColors = null;
function rulerColors() {
  if (cachedRulerColors) return cachedRulerColors;
  const cs = getComputedStyle(document.documentElement);
  cachedRulerColors = {
    text: (cs.getPropertyValue("--text-muted") || "#999").trim(),
    border: (cs.getPropertyValue("--border") || "#444").trim(),
    bg: (cs.getPropertyValue("--panel") || "#252526").trim(),
  };
  return cachedRulerColors;
}

// 回転に応じて「上/左ルーラーが PSD のどの軸を表示するか」を返す。
// Photoshop のビュー回転と同じく、ルーラーは画面に固定のまま値が PSD 座標を示す。
//   rotation = 0   → 上=X+ / 左=Y+
//   rotation = 90  → 上=Y+ / 左=X-
//   rotation = 180 → 上=X- / 左=Y-
//   rotation = 270 → 上=Y- / 左=X+
function axisMappingForRotation(rotation) {
  switch (rotation) {
    case 90:  return { topAxis: "y", topSign: +1, leftAxis: "x", leftSign: -1 };
    case 180: return { topAxis: "x", topSign: -1, leftAxis: "y", leftSign: -1 };
    case 270: return { topAxis: "y", topSign: -1, leftAxis: "x", leftSign: +1 };
    default:  return { topAxis: "x", topSign: +1, leftAxis: "y", leftSign: +1 };
  }
}

// 現在の表示用 geometry を集約。canvas が無い場合 null を返す。
function computeGeometry() {
  const page = getCurrentPage();
  if (!page) return null;
  const canvas = stageEl?.querySelector(".canvas-wrap > canvas") ?? null;
  if (!canvas) return null;
  const paneRect = paneEl.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  // canvas は回転前の CSS 寸法。回転後の画面 bbox は wrap の rect で近似（簡易に同じサイズで扱う）。
  // ルーラー上で「画面 X」に対応する PSD 距離は、画面長さ / 表示倍率。
  // 表示倍率の計算：rotation=0/180 のとき X 方向の pxPerPsd = canvasRect.width / page.width。
  // rotation=90/270 のときは canvas の物理 W/H が swap されないため canvasRect.width が PSD height に対応。
  const screenWPerPsdAxis = rotated90
    ? canvasRect.width / page.height
    : canvasRect.width / page.width;
  const screenHPerPsdAxis = rotated90
    ? canvasRect.height / page.width
    : canvasRect.height / page.height;
  return {
    page,
    paneRect,
    canvasRect,
    rotation,
    rotated90,
    pxPerPsdH: screenWPerPsdAxis, // 画面横方向 1px が PSD 何 px か（の逆数）
    pxPerPsdV: screenHPerPsdAxis,
    // canvas の左上端 / 右下端を pane 基準の絶対 px に変換
    canvasLeftInPane: canvasRect.left - paneRect.left,
    canvasTopInPane: canvasRect.top - paneRect.top,
    canvasRightInPane: canvasRect.right - paneRect.left,
    canvasBottomInPane: canvasRect.bottom - paneRect.top,
  };
}

function redraw() {
  const geom = computeGeometry();
  drawRulerCanvases(geom);
  renderGuides(geom);
}

// ルーラー Canvas のサイズと中身を更新。
function drawRulerCanvases(geom) {
  // ルーラー帯は pane 内の上/左に固定される。CSS は absolute で制御済み。
  // Canvas の内部解像度を CSS 寸法 × DPR に揃え、HiDPI でくっきり描画。
  if (!topCanvas || !leftCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cs = rulerColors();

  const topW = topCanvas.clientWidth;
  const topH = topCanvas.clientHeight;
  const leftW = leftCanvas.clientWidth;
  const leftH = leftCanvas.clientHeight;
  topCanvas.width = Math.max(1, Math.round(topW * dpr));
  topCanvas.height = Math.max(1, Math.round(topH * dpr));
  leftCanvas.width = Math.max(1, Math.round(leftW * dpr));
  leftCanvas.height = Math.max(1, Math.round(leftH * dpr));

  drawRulerOnCanvas(topCanvas, topW, topH, dpr, cs, geom, "top");
  drawRulerOnCanvas(leftCanvas, leftW, leftH, dpr, cs, geom, "left");
}

// 主目盛りが 60〜120 CSS px ごとに来る PSD 座標ステップを選ぶ。
const TICK_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
function pickTickStep(pxPerPsd) {
  if (!Number.isFinite(pxPerPsd) || pxPerPsd <= 0) return 100;
  const targetCssPx = 80; // 主目盛り間隔の理想値
  for (const step of TICK_STEPS) {
    if (step * pxPerPsd >= targetCssPx) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

function drawRulerOnCanvas(canvas, w, h, dpr, cs, geom, side) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // 背景
  ctx.fillStyle = cs.bg;
  ctx.fillRect(0, 0, w, h);
  // 内側の縁線（canvas 寄り側）
  ctx.strokeStyle = cs.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (side === "top") { ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); }
  else                { ctx.moveTo(w - 0.5, 0); ctx.lineTo(w - 0.5, h); }
  ctx.stroke();

  if (!geom) return;

  // この ruler が表すペイン内 px 範囲（canvas の bbox）。それ以外の領域には目盛りを描かない。
  const startInPane = side === "top" ? geom.canvasLeftInPane : geom.canvasTopInPane;
  const endInPane   = side === "top" ? geom.canvasRightInPane : geom.canvasBottomInPane;
  // ルーラー帯は pane の左上から伸びるが、上ルーラーは X = ruler_thick から始まる（左ルーラーぶん）。
  // クリップ範囲（ruler 内座標）に変換：
  const localStart = side === "top" ? startInPane - RULER_THICK : startInPane - RULER_THICK;
  const localEnd   = side === "top" ? endInPane - RULER_THICK : endInPane - RULER_THICK;

  // 軸とサイン
  const map = axisMappingForRotation(geom.rotation);
  const axisInfo = side === "top"
    ? { axis: map.topAxis,  sign: map.topSign,  pxPerPsd: geom.pxPerPsdH, length: geom.page[map.topAxis === "x" ? "width" : "height"] }
    : { axis: map.leftAxis, sign: map.leftSign, pxPerPsd: geom.pxPerPsdV, length: geom.page[map.leftAxis === "x" ? "width" : "height"] };

  const step = pickTickStep(axisInfo.pxPerPsd);
  const subStep = step / 5; // 副目盛りは 1/5 単位
  const pxPerPsd = axisInfo.pxPerPsd;

  // PSD 座標 0..length を CSS px の絶対位置に変換。startCanvas (CSS px) は canvas 左端のペイン内座標 - RULER_THICK
  // 「PSD value v に対応するルーラー内 CSS px 位置 (px)」:
  //   sign = +1: x = localStart + v * pxPerPsd
  //   sign = -1: x = localStart + (length - v) * pxPerPsd
  const valueToLocal = (v) => {
    const along = axisInfo.sign > 0 ? v : (axisInfo.length - v);
    return localStart + along * pxPerPsd;
  };

  // 描画範囲を ruler 内 CSS px [0, w] にクリップ。
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  ctx.strokeStyle = cs.text;
  ctx.fillStyle = cs.text;
  ctx.font = `10px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = side === "top" ? "alphabetic" : "alphabetic";

  // ルーラー帯の「主軸方向の長さ」: top は横幅 w、left は縦高さ h。
  // 副目盛り側の太さ（tick 長さの基準）: top は h、left は w を使う。
  const along = side === "top" ? w : h;
  const across = side === "top" ? h : w;

  // 副目盛り
  ctx.lineWidth = 1;
  for (let v = 0; v <= axisInfo.length; v += subStep) {
    const lp = valueToLocal(v);
    if (lp < -2 || lp > along + 2) continue;
    const isMajor = Math.round(v / step) === v / step || (Math.abs((v % step)) < 0.001);
    const tickLen = isMajor ? Math.floor(across * 0.6) : Math.floor(across * 0.3);
    ctx.beginPath();
    if (side === "top") {
      const x = Math.round(lp) + 0.5;
      ctx.moveTo(x, h);
      ctx.lineTo(x, h - tickLen);
    } else {
      const y = Math.round(lp) + 0.5;
      ctx.moveTo(w, y);
      ctx.lineTo(w - tickLen, y);
    }
    ctx.stroke();
  }

  // 主目盛りの数値ラベル
  for (let v = 0; v <= axisInfo.length; v += step) {
    const lp = valueToLocal(v);
    if (lp < -20 || lp > along + 20) continue;
    const label = String(Math.round(v));
    if (side === "top") {
      ctx.textAlign = "left";
      ctx.fillText(label, Math.round(lp) + 2, h - Math.floor(across * 0.6) - 2);
    } else {
      // 縦方向は数値を 90° 回転して縦読みを避け、目盛り上に小さく表示。
      ctx.save();
      ctx.translate(w - Math.floor(across * 0.6) - 2, Math.round(lp) - 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "left";
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }

  ctx.restore();
}

// ガイド層に div を再配置。簡便のため毎回全消去 → 全再生成。
function renderGuides(geom) {
  if (!guidesLayer) return;
  guidesLayer.innerHTML = "";
  if (!geom || !rulersVisible) return;
  const psdPath = getCurrentPsdPath();
  if (!psdPath) return;
  const g = getGuidesObj(psdPath);

  // 「水平ガイド」= PSD で固定された Y（または rotation で X）位置。画面上は水平な線。
  // 「垂直ガイド」= 画面上は垂直な線。
  // ガイドが PSD 座標で持つのは「画面上での水平/垂直線の延長線が指す PSD 座標値」。
  // → axisMappingForRotation で「上ルーラーが指す軸」が水平ガイドの軸、「左ルーラーが指す軸」が垂直ガイドの軸。
  const map = axisMappingForRotation(geom.rotation);
  const horizAxisInfo = { axis: map.topAxis,  sign: map.topSign,  pxPerPsd: geom.pxPerPsdH };
  const vertAxisInfo  = { axis: map.leftAxis, sign: map.leftSign, pxPerPsd: geom.pxPerPsdV };
  // 水平ガイド (axis: "h") は「上ルーラーで作られた」もの → x=固定の縦線では無い。
  // ここで axis="h" は「画面上で水平に伸びる線」= PSD の Y（rotation=0時）。
  // → 上ルーラーの作るガイドが axis="h"。

  const horizLength = geom.page[horizAxisInfo.axis === "x" ? "width" : "height"];
  const vertLength  = geom.page[vertAxisInfo.axis  === "x" ? "width" : "height"];

  // 水平ガイド：上ルーラーから引いた → 画面上で「縦位置」が固定の水平線。
  // ガイド値 v は「上ルーラーで読み取れる値」= map.topAxis 軸の値。
  // ……実装の単純化のため、「水平ガイド」=画面上の水平線=画面 Y が固定 と読み替え、
  // ガイドの内部表現は「画面 Y にマップされる PSD 軸の値」とする。
  // 画面 Y → PSD 軸の対応は「左ルーラー」と同じ。だから水平ガイドは leftAxis 値で持つ。
  // と思いきや、Photoshop の感覚では「上ルーラーから引いたら水平ガイド」。上ルーラーは画面 X の目盛り。
  // 画面 X 軸 → 画面 X 一定 = 縦線（垂直ガイド）。これが Photoshop の挙動。
  // よって：
  //   axis="h" のガイドを Photoshop 流に作るには「左ルーラーから引く」操作 → 値は leftAxis の値。
  //   axis="v" のガイドを Photoshop 流に作るには「上ルーラーから引く」操作 → 値は topAxis の値。
  // beginCreateGuide で axis をどう決めるかをこれに合わせる。

  // h ガイド：画面上で水平な線。画面 Y で位置が決まる。値は画面 Y → PSD 軸（leftAxis）。
  //   画面 Y in pane (CSS px) = canvasTopInPane + along_y * pxPerPsdV
  //     where along_y = (sign>0 ? v : length - v)
  for (let i = 0; i < g.h.length; i++) {
    const v = g.h[i];
    const along = vertAxisInfo.sign > 0 ? v : (vertLength - v);
    const yInPane = geom.canvasTopInPane + along * geom.pxPerPsdV;
    if (yInPane < geom.canvasTopInPane - 1 || yInPane > geom.canvasBottomInPane + 1) {
      // canvas 外なら描画しない（端をはみ出すガイドは隠す）
      continue;
    }
    const div = document.createElement("div");
    div.className = "psd-guide";
    div.dataset.axis = "h";
    div.dataset.index = String(i);
    div.style.top = `${Math.round(yInPane)}px`;
    div.style.left = `${Math.round(geom.canvasLeftInPane)}px`;
    div.style.width = `${Math.round(geom.canvasRightInPane - geom.canvasLeftInPane)}px`;
    div.addEventListener("mousedown", (e) => beginMoveGuide(e, "h", i));
    guidesLayer.appendChild(div);
  }

  // v ガイド：画面上で垂直な線。画面 X で位置が決まる。値は画面 X → topAxis。
  for (let i = 0; i < g.v.length; i++) {
    const v = g.v[i];
    const along = horizAxisInfo.sign > 0 ? v : (horizLength - v);
    const xInPane = geom.canvasLeftInPane + along * geom.pxPerPsdH;
    if (xInPane < geom.canvasLeftInPane - 1 || xInPane > geom.canvasRightInPane + 1) {
      continue;
    }
    const div = document.createElement("div");
    div.className = "psd-guide";
    div.dataset.axis = "v";
    div.dataset.index = String(i);
    div.style.left = `${Math.round(xInPane)}px`;
    div.style.top = `${Math.round(geom.canvasTopInPane)}px`;
    div.style.height = `${Math.round(geom.canvasBottomInPane - geom.canvasTopInPane)}px`;
    div.addEventListener("mousedown", (e) => beginMoveGuide(e, "v", i));
    guidesLayer.appendChild(div);
  }
}

// ===== 入力 =====
// 上ルーラー mousedown → axis="h"（画面水平のガイド）= 値は leftAxis 軸
// 左ルーラー mousedown → axis="v"（画面垂直のガイド）= 値は topAxis 軸
function beginCreateGuide(e, axisFromRuler) {
  if (e.button !== 0) return;
  if (guidesLocked) {
    // ロック中は新規作成不可。ただし event を完全に消費して、ブラウザの mousedown
    // 既定動作（テキスト選択開始など）が下層に伝播しないようにする。
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // 上ルーラー = "h"（画面水平）, 左ルーラー = "v"（画面垂直）
  // ただし呼び出し側は「ルーラーの種類」で渡すので、対応関係：
  //   topRuler -> axis="h"（mouse down 後 Y で値決定）
  //   leftRuler -> axis="v"（mouse down 後 X で値決定）
  const axis = axisFromRuler;
  e.preventDefault();
  const psdPath = getCurrentPsdPath();
  if (!psdPath) return;

  const previewDiv = document.createElement("div");
  previewDiv.className = "psd-guide dragging";
  previewDiv.dataset.axis = axis;
  guidesLayer?.appendChild(previewDiv);

  const onMove = (ev) => {
    updatePreviewAt(previewDiv, axis, ev.clientX, ev.clientY);
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    previewDiv.remove();
    // canvas 内に落ちたか判定 → addGuide。それ以外は破棄。
    const dropped = computePsdValueFromScreen(axis, ev.clientX, ev.clientY);
    if (dropped != null && !isOverRulerBand(ev)) {
      addGuide(psdPath, axis, dropped);
    } else {
      requestRulerRedraw();
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // 初回プレビュー
  updatePreviewAt(previewDiv, axis, e.clientX, e.clientY);
}

function beginMoveGuide(e, axis, index) {
  if (e.button !== 0) return;
  if (guidesLocked) {
    // ロック中はガイド移動・削除不可。event は消費して下層レイヤーへ伝播させない。
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const psdPath = getCurrentPsdPath();
  if (!psdPath) return;
  const targetDiv = e.currentTarget;
  if (targetDiv) targetDiv.classList.add("dragging");

  const onMove = (ev) => {
    // ドラッグ中はその場で位置だけ仮更新（毎回 moveGuide）。
    const v = computePsdValueFromScreen(axis, ev.clientX, ev.clientY);
    if (v == null) return;
    moveGuide(psdPath, axis, index, v);
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (targetDiv) targetDiv.classList.remove("dragging");
    // ルーラー帯まで戻されたら削除。
    if (isOverRulerBand(ev)) {
      removeGuide(psdPath, axis, index);
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// 画面座標 (clientX, clientY) を PSD 軸の値に変換。axis="h" → leftAxis 値、axis="v" → topAxis 値。
function computePsdValueFromScreen(axis, clientX, clientY) {
  const geom = computeGeometry();
  if (!geom) return null;
  const map = axisMappingForRotation(geom.rotation);
  if (axis === "h") {
    const yInPane = clientY - geom.paneRect.top;
    const along = (yInPane - geom.canvasTopInPane) / geom.pxPerPsdV;
    const length = geom.page[map.leftAxis === "x" ? "width" : "height"];
    const v = map.leftSign > 0 ? along : (length - along);
    return v;
  } else {
    const xInPane = clientX - geom.paneRect.left;
    const along = (xInPane - geom.canvasLeftInPane) / geom.pxPerPsdH;
    const length = geom.page[map.topAxis === "x" ? "width" : "height"];
    const v = map.topSign > 0 ? along : (length - along);
    return v;
  }
}

function updatePreviewAt(previewDiv, axis, clientX, clientY) {
  const geom = computeGeometry();
  if (!geom) return;
  if (axis === "h") {
    const yInPane = Math.round(clientY - geom.paneRect.top);
    previewDiv.style.top = `${yInPane}px`;
    previewDiv.style.left = `${Math.round(geom.canvasLeftInPane)}px`;
    previewDiv.style.width = `${Math.round(geom.canvasRightInPane - geom.canvasLeftInPane)}px`;
  } else {
    const xInPane = Math.round(clientX - geom.paneRect.left);
    previewDiv.style.left = `${xInPane}px`;
    previewDiv.style.top = `${Math.round(geom.canvasTopInPane)}px`;
    previewDiv.style.height = `${Math.round(geom.canvasBottomInPane - geom.canvasTopInPane)}px`;
  }
}

// マウス座標がルーラー帯（上または左）の上にあるか。
function isOverRulerBand(ev) {
  if (!paneEl) return false;
  const r = paneEl.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  if (x < 0 || y < 0 || x > r.width || y > r.height) return false;
  return x < RULER_THICK || y < RULER_THICK;
}
