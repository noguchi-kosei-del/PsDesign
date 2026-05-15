import {
  abortHistoryTransient,
  addEditOffset,
  addNewLayer,
  beginHistoryTransient,
  commitHistoryTransient,
  withHistoryTransient,
  getCurrentFont,
  getCurrentPageIndex,
  getEdit,
  getFillColor,
  getFontDisplayName,
  getFontPickerStuck,
  getLeadingPct,
  getNewLayersForPsd,
  getNewTextDirection,
  getPages,
  getPsdRotation,
  getSelectedLayer,
  getSelectedLayers,
  getStrokeColor,
  getStrokeWidthPx,
  getTextSize,
  getTool,
  isLayerSelected,
  onToolChange,
  removeNewLayer,
  setCurrentPageIndex,
  setEdit,
  setEditingContext,
  setSelectedLayer,
  setSelectedLayers,
  setTool,
  toDisplaySizePt,
  toggleLayerSelected,
  updateNewLayer,
  // 【v1.29.x UI-coord】ルビ wrap の実描画位置を PSD 座標で state に書き戻すため
  setCharRubyOffset,
} from "./state.js";
import { ensureFontLoaded } from "./font-loader.js";
import { getDefault, onSettingsChange } from "./settings.js";
import { commitFontToSelections, rebuildLayerList } from "./text-editor.js";
import { cascadeRemoveTxtForLayers, syncTxtSelectionToLayer } from "./txt-source.js";

const mounts = new Map();
const resizeObservers = new Set();
let toolListenerBound = false;
const RUBY_TOWARD_PARENT_RATIO = 1.60;

// 【v1.16.0】in-place 編集 textarea 上の文字選択範囲のキャッシュ。
// reportCursor の発火点で必ずモジュール変数に保存しておくことで、focus 変動の影響を回避。
// editingContext は select イベントのタイミングで更新するが、フォーカスが他の input
// (size / font 入力欄など) に移ったときに古い値が残ることがある。これを補うため、
// reportCursor が走るたびに module-level でも選択範囲を保持する。サイドバーから直接
// 参照できるよう listener API で通知する。
let _lastInplaceSelection = null;
const _selectionChangeListeners = new Set();
export function getLastInplaceSelection() { return _lastInplaceSelection; }
export function onInplaceSelectionChange(fn) {
  _selectionChangeListeners.add(fn);
  return () => _selectionChangeListeners.delete(fn);
}
function setLastInplaceSelection(v) {
  // 値が同じなら listener を発火しない（連続 keystroke で大量発火を抑止）
  const a = _lastInplaceSelection;
  const b = v;
  if (a === b) return;
  if (a && b && a.start === b.start && a.end === b.end
      && a.psdPath === b.psdPath
      && a.layerId === b.layerId && a.tempId === b.tempId) return;
  _lastInplaceSelection = b;
  for (const fn of _selectionChangeListeners) fn(b);
}

// MojiQ 流パン状態：モジュールレベルで保持し、canvas に常設リスナーで扱う。
let panState = null;
// マーキー（V ツールの矩形選択）状態。
let marqueeState = null;

// キャンバス外でリリースされた場合のセーフティネット（window level）
if (typeof window !== "undefined") {
  window.addEventListener("mouseup", () => { if (panState) endPan(); });
  window.addEventListener("blur", () => { if (panState) endPan(); });
}

export function mountPageInteraction({ pageEl, canvas, overlay, page, pageIndex }) {
  mounts.set(pageIndex, { pageEl, canvas, overlay, page, pageIndex });
  if (!toolListenerBound) {
    onToolChange(() => {
      for (const m of mounts.values()) {
        applyToolAttrs(m);
        renderOverlay(m);
      }
    });
    toolListenerBound = true;
  }
  canvas.addEventListener("mousedown", (e) => onCanvasMouseDown(e, mounts.get(pageIndex)));
  canvas.addEventListener("mousemove", (e) => onCanvasMouseMove(e, mounts.get(pageIndex)));
  canvas.addEventListener("mouseup", (e) => onCanvasMouseUp(e, mounts.get(pageIndex)));
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      const m = mounts.get(pageIndex);
      if (m) renderOverlay(m);
    });
    ro.observe(canvas);
    resizeObservers.add(ro);
  }
  applyToolAttrs(mounts.get(pageIndex));
  renderOverlay(mounts.get(pageIndex));
}

export function unmountAll() {
  mounts.clear();
  for (const ro of resizeObservers) ro.disconnect();
  resizeObservers.clear();
}

export function refreshAllOverlays() {
  for (const m of mounts.values()) renderOverlay(m);
}

// 【v1.21.0】編集中レイヤーの inner で、char index 範囲 [start, end) を <span> でラップして
// CSS スタイルを直接適用する。サイドバーから per-char サイズ・フォントを変更したときに
// 編集中の DOM へリアルタイムに視覚反映するために使う。
//
// 引数:
//   start, end : char 位置（state.contents 上の絶対 index、innerText 順）
//   styleProps : { fontFamily, fontSize, ... } の CSS プロパティオブジェクト
//
// 戻り値: 適用に成功したら true、編集中レイヤーが無い / 範囲解決失敗で false。
//
// 注意: ネストした span が同じ styleProp を持つと em 系単位は乗算されるため、size 系は
// 「em 比 = sigSize / layerDefaultSizePt」で指定しつつ、ネスト時は親 span の em を打ち消す
// よう既存 fontSize span を range 内から事前に剥がす（unwrapStyleSpansInRange）。
export function applyEditModeStyleToRange(start, end, styleProps) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return false;
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return false;
  const inner = editing.querySelector(".existing-layer-text, .new-layer-text");
  if (!inner) return false;

  const startPos = charIndexToNodeOffset(inner, start);
  const endPos = charIndexToNodeOffset(inner, end);
  if (!startPos || !endPos) return false;

  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
  } catch { return false; }

  // ネスト span による em 乗算事故を避けるため、上書きされる styleProp を持つ span を
  // 範囲内から剥がす（unwrap）。子の text node はそのまま残る。
  for (const prop of Object.keys(styleProps)) {
    unwrapStyleSpansInRange(inner, range, prop);
  }
  // 範囲は unwrap 後に invalid になることがあるので char index から再計算。
  const startPos2 = charIndexToNodeOffset(inner, start);
  const endPos2 = charIndexToNodeOffset(inner, end);
  if (!startPos2 || !endPos2) return false;
  const range2 = document.createRange();
  try {
    range2.setStart(startPos2.node, startPos2.offset);
    range2.setEnd(endPos2.node, endPos2.offset);
  } catch { return false; }

  // 新規 span でラップ
  const span = document.createElement("span");
  for (const [k, v] of Object.entries(styleProps)) {
    if (v != null && v !== "") span.style[k] = v;
  }
  try {
    range2.surroundContents(span);
  } catch (e) {
    // surroundContents は range が要素境界を跨ぐと NotSupportedError。
    // extractContents + insertNode で fallback。
    try {
      const contents = range2.extractContents();
      span.appendChild(contents);
      range2.insertNode(span);
    } catch {
      return false;
    }
  }

  // 選択を span 全体に再設定（連続して別 styleProp を当てたいときの利便性）
  const sel = window.getSelection();
  sel.removeAllRanges();
  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.addRange(newRange);
  return true;
}

// 【v1.27.0】in-place 編集中のレイヤーで「ルビプレビュー」を表示する。
// 旧 v1.26.0 では `<span class="ruby-edit-pending" data-ruby-text="rt">親文字</span>` +
// CSS `::after { content: attr(data-ruby-text) }` の疑似要素方式でプレビューしていたが、
// contenteditable 内で caret 移動 / 文字選択を解除すると Chromium が ::after の描画を
// 破棄するケースが発生し、「文字選択を解除した瞬間にルビが消える」不具合が出ていた。
//
// これを解消するため、finalize 後の `renderInnerText` が使う本番の実 DOM 構造をそのまま
// 編集中プレビューでも使う:
//   <span class="ruby-wrap ruby-edit-pending">
//     <span class="ruby-base">親文字 (or per-char 装飾 span)</span>
//     <span class="ruby-text" contenteditable="false">rt</span>
//   </span>
// .ruby-text は contenteditable="false" にして caret の進入と readContents による
// state.contents 破壊を両方とも防ぐ（readContents 側でも .ruby-text の text node を skip）。
//
// finalize 後の renderInnerText 再構築でも同じ DOM 構造に置き換わるため、編集中 → finalize
// での「見た目の連続性」も担保される。
//
// 引数: start, end (char 範囲)、rubyText, rubyType, rubyScale
// 戻り値: 編集中レイヤーが無い / range 解決失敗で false。
export function applyEditModeRubyToRange(start, end, rubyText, rubyType, rubyScale) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return false;
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return false;
  const inner = editing.querySelector(".existing-layer-text, .new-layer-text");
  if (!inner) return false;
  if (typeof rubyText !== "string" || rubyText.length === 0) return false;

  const startPos = charIndexToNodeOffset(inner, start);
  const endPos = charIndexToNodeOffset(inner, end);
  if (!startPos || !endPos) return false;

  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
  } catch { return false; }

  // 既存の `.ruby-wrap` が範囲に交差する場合は事前に unwrap（親の中身を外に出して
  // wrap 要素自体を削除）して、新規 wrap を nest させない。state.charRubies 側は
  // setCharRubiesRange の dropOverlapping で既にクリーンになっているので、DOM 側
  // だけ揃える必要がある。
  unwrapRubyInRange(inner, range);
  // 範囲が unwrap で text node の状態が変わった可能性があるため char index から
  // 再解決する（unwrap は文字を消さないので start/end char index は不変）。
  const startPos2 = charIndexToNodeOffset(inner, start);
  const endPos2 = charIndexToNodeOffset(inner, end);
  if (!startPos2 || !endPos2) return false;
  try {
    range.setStart(startPos2.node, startPos2.offset);
    range.setEnd(endPos2.node, endPos2.offset);
  } catch { return false; }

  // 本番と同じ DOM 構造を組む:
  //   <span class="ruby-wrap ruby-edit-pending">
  //     <span class="ruby-base">親文字 (or 既存の per-char 装飾 span)</span>
  //     <span class="ruby-text" contenteditable="false">rt</span>
  //   </span>
  // ruby-edit-pending クラスを併記する理由: 既存の `inner.querySelector(".ruby-edit-pending")`
  // ガード（applyConversionToInner 内）と互換性を保つため。
  const wrap = document.createElement("span");
  wrap.className = "ruby-wrap ruby-edit-pending";
  // 【v1.29.x UI-coord】後段の measureRubyOffsets が「どの charRubies エントリに対応するか」
  // 特定できるように、絶対 char start を data 属性で持たせる。
  wrap.dataset.rubyStart = String(start);
  if (rubyType === "mono" || rubyType === "group") {
    wrap.setAttribute("data-ruby-type", rubyType);
  }
  if (Number.isFinite(rubyScale) && rubyScale > 0) {
    wrap.style.setProperty("--ruby-scale", `${rubyScale / 100}em`);
  }
  // 親文字部分: range の内容を extractContents で取り出して .ruby-base に詰める。
  const base = document.createElement("span");
  base.className = "ruby-base";
  try {
    const contents = range.extractContents();
    base.appendChild(contents);
    wrap.appendChild(base);
  } catch { return false; }
  // ふりがな部分: 実 DOM の <span class="ruby-text"> として追加。
  // contenteditable="false" で caret 進入を禁止 + readContents 側で除外する。
  const rt = document.createElement("span");
  rt.className = "ruby-text";
  rt.contentEditable = "false";
  rt.setAttribute("aria-hidden", "true");
  rt.textContent = rubyText;
  wrap.appendChild(rt);
  try {
    range.insertNode(wrap);
  } catch { return false; }
  // 親 inner の overflow:hidden が .ruby-text の絶対配置を切り取らないように has-ruby クラスを付ける。
  inner.classList.add("has-ruby");
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      const overlay = inner.closest(".page-overlay");
      if (overlay) placeRubyAtLineMidpointsForOverlay(overlay, { towardParentRatio: 0 });
    });
  }
  return true;
}

// 【v1.27.0】range と交差する既存 `.ruby-wrap` を inner DOM から unwrap する。
// 「unwrap」= wrap 自身を外して .ruby-base の子要素を wrap の位置に移動 + .ruby-text を削除。
// 結果として親文字（plain text もしくは per-char スタイル付き span）だけが残り、
// その後の extractContents が予想通りに動作する。
//
// 「交差する wrap」の検出: wrap の bounding range (wrap 全体を覆う Range) と引数 range が
// 交差する場合に unwrap 対象とする。range が wrap の内側に完全に収まっているケースも
// 含まれる（user が既存 ruby を再適用するケース）。
function unwrapRubyInRange(inner, range) {
  if (!inner || !range) return;
  const wraps = Array.from(inner.querySelectorAll(".ruby-wrap"));
  for (const wrap of wraps) {
    const wrapRange = document.createRange();
    try { wrapRange.selectNode(wrap); } catch { continue; }
    // range と wrapRange が交差するか
    const intersects =
      range.compareBoundaryPoints(Range.END_TO_START, wrapRange) < 0
      && range.compareBoundaryPoints(Range.START_TO_END, wrapRange) > 0;
    if (!intersects) { wrapRange.detach?.(); continue; }
    // .ruby-base の中身を wrap の親に移動（wrap 位置に挿入）して wrap を削除。
    const parent = wrap.parentNode;
    if (!parent) continue;
    const base = wrap.querySelector(":scope > .ruby-base");
    if (base) {
      while (base.firstChild) parent.insertBefore(base.firstChild, wrap);
    }
    parent.removeChild(wrap);
  }
  // unwrap 後に隣接 text node の正規化（merge）を行う。range の boundary 位置が
  // text node 内 offset に正しく解決されるようにするため。
  inner.normalize();
}

// inner 内の text node を順に走査し、char index に対応する (text node, offset) を返す。
function charIndexToNodeOffset(rootEl, charIndex) {
  let remaining = Math.max(0, charIndex);
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  let lastNode = null;
  let node = walker.nextNode();
  while (node) {
    const len = node.nodeValue.length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
    lastNode = node;
    node = walker.nextNode();
  }
  if (lastNode) return { node: lastNode, offset: lastNode.nodeValue.length };
  return { node: rootEl, offset: 0 };
}

// 範囲内の span で指定 styleProp を持つものを unwrap（中身の child を親に展開して span を削除）。
// ネスト span による em 乗算を防ぐ目的。fully-inside の span のみが対象（partial overlap は
// 触らない）。range は unwrap 後に invalid になり得るので、呼び出し側で再構築する想定。
function unwrapStyleSpansInRange(rootEl, range, styleProp) {
  const targets = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.tagName === "SPAN" && node.style[styleProp]) {
      const elRange = document.createRange();
      elRange.selectNode(node);
      // span 全体が range に内包されているなら unwrap 対象。
      const startsAfterRange = range.compareBoundaryPoints(Range.START_TO_START, elRange) <= 0;
      const endsBeforeRange = range.compareBoundaryPoints(Range.END_TO_END, elRange) >= 0;
      if (startsAfterRange && endsBeforeRange) targets.push(node);
    }
    node = walker.nextNode();
  }
  for (const span of targets) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
}

// 環境設定（フォント名表示 / サイズ表示の切替など）が変わったらオーバーレイを再描画して
// 選択中のバッジに即時反映する。
let settingsListenerBound = false;
function bindSettingsListener() {
  if (settingsListenerBound) return;
  settingsListenerBound = true;
  onSettingsChange(() => refreshAllOverlays());
}
bindSettingsListener();

export function nudgeSelectedLayers(dx, dy) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const pages = getPages();
  const moved = withHistoryTransient(() => {
    let any = false;
    for (const sel of selections) {
      const page = pages[sel.pageIndex];
      if (!page) continue;
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
        if (!nl) continue;
        updateNewLayer(sel.layerId, { x: nl.x + dx, y: nl.y + dy });
        any = true;
      } else {
        const layer = page.textLayers.find((l) => l.id === sel.layerId);
        if (!layer) continue;
        addEditOffset(page.path, sel.layerId, dx, dy);
        any = true;
      }
    }
    return any || false;
  });
  if (moved) {
    refreshAllOverlays();
    rebuildLayerList();
  }
  return !!moved;
}

// 矢印キー ↑/↓ で現在ページ内のテキストレイヤー選択を順送り / 逆送りする。
// 順序は text-editor.js rebuildLayerList と同じ「既存レイヤー → 新規レイヤー」。
// 末尾で wrap (last → first / first → last)。delta: +1 次へ / -1 前へ。
// レイヤーが 0 件のときは false、そうでなければ選択を切替えて true。
// 現選択が別ページのレイヤーなら無視して現ページの先頭/末尾から開始する。
export function cycleLayerSelection(delta) {
  const pages = getPages();
  const pageIdx = getCurrentPageIndex();
  if (pageIdx < 0 || pageIdx >= pages.length) return false;
  const page = pages[pageIdx];
  if (!page) return false;
  // ordered ID list: 既存 → 新規
  const ids = [];
  for (const layer of page.textLayers) ids.push(layer.id);
  for (const nl of getNewLayersForPsd(page.path)) ids.push(nl.tempId);
  if (ids.length === 0) return false;
  const selections = getSelectedLayers();
  // 現選択が現ページにあるか確認 (複数選択でも先頭で代表する)
  const cur = selections.find((s) => s.pageIndex === pageIdx);
  let nextIdx;
  if (cur) {
    const curIdx = ids.findIndex((id) => id === cur.layerId);
    nextIdx = curIdx < 0
      ? (delta > 0 ? 0 : ids.length - 1)
      : (curIdx + delta + ids.length) % ids.length;
  } else {
    // 現ページに選択なし → 方向に応じて先頭 / 末尾を選ぶ
    nextIdx = delta > 0 ? 0 : ids.length - 1;
  }
  setSelectedLayer(pageIdx, ids[nextIdx]);
  refreshAllOverlays();
  rebuildLayerList();
  // 自動配置済みレイヤー（sourceTxtRef あり）の場合は txt-source-viewer の選択 / フォーカスも追従。
  // 紐付け無しのレイヤーが選ばれた場合は viewer 側の選択を解除する（同関数内で処理）。
  syncTxtSelectionToLayer(pageIdx, ids[nextIdx]);
  return true;
}

// 選択中のレイヤーを削除する（Delete / Backspace から呼ばれる想定）。
// 新規追加レイヤーのみ削除可能。PSD 既存テキストレイヤーは選択から外すだけで残す
// （PSD バイナリからの削除は edit モデル外のため未対応）。
// 何かを削除した場合 true、対象がなく no-op の場合 false を返す。
export function deleteSelectedLayers() {
  const selections = getSelectedLayers();
  const tempIds = selections
    .filter((s) => typeof s.layerId === "string")
    .map((s) => s.layerId);
  if (tempIds.length === 0) return false;

  // 削除前のレイヤースナップショットを取り、sourceTxtRef を持つものは TXT 側からも消す
  // ための情報として保持する（自動配置レイヤー → 原稿テキスト の cascade）。
  const tempIdSet = new Set(tempIds);
  const newLayersAll = (typeof window !== "undefined" ? null : null) || [];
  // モジュールスコープに getNewLayers が無いので getNewLayersForPsd 経由で取得する代わりに、
  // selection の page から layer を解決する。
  const deletedLayerSnapshots = [];
  for (const sel of selections) {
    if (typeof sel.layerId !== "string") continue;
    const page = getPages()[sel.pageIndex];
    if (!page) continue;
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
    if (nl) deletedLayerSnapshots.push(nl);
  }

  withHistoryTransient(() => {
    for (const id of tempIds) removeNewLayer(id);
    // 削除されたレイヤーが原稿テキストの段落に紐付いていれば、その段落も TXT 側から取り除く。
    // editor-textarea / txt-source-viewer は state.txtSource の listener 経由で自動更新される。
    cascadeRemoveTxtForLayers(deletedLayerSnapshots, tempIdSet);
  });
  // 既存 PSD レイヤーの選択は維持し、新規分のみ選択から外す。
  setSelectedLayers(selections.filter((s) => typeof s.layerId !== "string"));
  refreshAllOverlays();
  rebuildLayerList();
  return true;
}

function clampSizePt(v) {
  const rounded = Math.round(v * 10) / 10;
  return Math.max(6, Math.min(999, rounded));
}

// 現在値 cur から baseStep グリッド上の「次の」値を返す。
// - グリッド上ぴったりなら sign 方向に 1 ステップ
// - グリッド外（例：0.5 刻み設定で 12.3）なら sign 方向の最寄りグリッドへスナップ
//   （+1 は ceil、-1 は floor）。これにより 12.3 + 0.5 step → 12.5（13.0 ではない）
// - multiplier > 1（Shift+wheel 等）はスナップ後に追加でグリッドを進む。
export function snapNextSize(cur, baseStep, sign, multiplier = 1) {
  if (!Number.isFinite(cur) || !Number.isFinite(baseStep) || baseStep <= 0) return cur;
  const ratio = cur / baseStep;
  const onGrid = Math.abs(ratio - Math.round(ratio)) < 1e-9;
  const firstStep = onGrid
    ? Math.round(ratio) + sign
    : (sign > 0 ? Math.ceil(ratio) : Math.floor(ratio));
  const finalGrid = firstStep + sign * (Math.max(1, multiplier) - 1);
  return Math.round(finalGrid * baseStep * 10) / 10;
}

// 選択中レイヤーをサイズ変更。sign（+1 / -1）と multiplier（Shift+wheel で 10）で
// 各レイヤーの現在 sizePt を snapNextSize で次の baseStep グリッドへ移動する。
// 中心固定のため矩形差の半分だけ x/y を補正するのは従来通り。
export function resizeSelectedLayers(baseStep, sign, multiplier = 1) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const pages = getPages();
  const changed = withHistoryTransient(() => {
    let any = false;
    for (const sel of selections) {
      const page = pages[sel.pageIndex];
      if (!page) continue;
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
        if (!nl) continue;
        const cur = nl.sizePt ?? 24;
        const next = clampSizePt(snapNextSize(cur, baseStep, sign, multiplier));
        if (next === cur) continue;
        const oldRect = layerRectForNew(page, nl);
        const newRect = layerRectForNew(page, { ...nl, sizePt: next });
        const dx = (oldRect.width - newRect.width) / 2;
        const dy = (oldRect.height - newRect.height) / 2;
        updateNewLayer(sel.layerId, { sizePt: next, x: nl.x + dx, y: nl.y + dy });
        any = true;
      } else {
        const layer = page.textLayers.find((l) => l.id === sel.layerId);
        if (!layer) continue;
        const edit = getEdit(page.path, sel.layerId) ?? {};
        const cur = edit.sizePt ?? layer.fontSize ?? 24;
        const next = clampSizePt(snapNextSize(cur, baseStep, sign, multiplier));
        if (next === cur) continue;
        const oldRect = layerRectForExisting(page, layer, edit);
        const newRect = layerRectForExisting(page, layer, { ...edit, sizePt: next });
        const ddx = (oldRect.width - newRect.width) / 2;
        const ddy = (oldRect.height - newRect.height) / 2;
        setEdit(page.path, sel.layerId, {
          sizePt: next,
          dx: (edit.dx ?? 0) + ddx,
          dy: (edit.dy ?? 0) + ddy,
        });
        any = true;
      }
    }
    return any || false;
  });
  if (changed) {
    refreshAllOverlays();
    rebuildLayerList();
  }
  return !!changed;
}

function applyToolAttrs(ctx) {
  const tool = getTool();
  ctx.overlay.dataset.tool = tool;
  ctx.canvas.style.cursor = tool === "pan" ? "grab" : "default";
}

// 既存テキストレイヤーの「実描画 fontSize（pt）」を返す。
// 写植テキストは Photoshop で「100pt → 0.2× scale」のように transform で縮められて
// 配置されることがあり、ag-psd の style.fontSize は scale 前の生値を返すため、
// 単純に layer.fontSize を採用すると frame / 内文が実描画サイズの数倍に膨れる。
// bounds (layer.left/right/top/bottom) はラスタライズ後の実描画範囲を反映するので、
// 「厚み軸長 / em-box 列数係数」で em-box pt を逆算する。
// ユーザーが明示的にサイズを編集している場合は edit.sizePt を優先、それ以外は
// declared と bounds-derived の小さい方を採用（過大値を抑える）。
export function getExistingLayerEffectiveSizePt(page, layer, edit) {
  if (edit && Number.isFinite(edit.sizePt) && edit.sizePt > 0) return edit.sizePt;
  const declaredSizePt = layer?.fontSize ?? null;
  const dpi = page?.dpi ?? 72;
  const rawWidth = Math.max(0, (layer?.right ?? 0) - (layer?.left ?? 0));
  const rawHeight = Math.max(0, (layer?.bottom ?? 0) - (layer?.top ?? 0));
  if (rawWidth > 0 && rawHeight > 0) {
    const direction = edit?.direction ?? layer?.direction ?? "horizontal";
    const isVertical = direction === "vertical";
    const text = edit?.contents ?? layer?.text ?? "";
    const lineCount = Math.max(1, countLines(text));
    const thickPsdPx = isVertical ? rawWidth : rawHeight;
    // tight bounds 想定: thick = em × (1 + (n-1) × leading_default)
    // leading_default は写植系の慣例で 1.25 を仮定（autoLeading 125% と整合）。
    const tightDenom = 1 + Math.max(0, lineCount - 1) * 1.25;
    if (tightDenom > 0) {
      const ptPsdPx = thickPsdPx / tightDenom;
      const sizeFromBounds = (ptPsdPx * 72) / dpi;
      if (sizeFromBounds > 0) {
        // bounds が padded で大きめに出ているケースでは declared を尊重するため、
        // 必ず小さい方を選ぶ（過大化を防ぐのが目的）。
        return declaredSizePt > 0
          ? Math.min(declaredSizePt, sizeFromBounds)
          : sizeFromBounds;
      }
    }
  }
  return declaredSizePt ?? 24;
}

export function layerRectForExisting(page, layer, edit) {
  const dpi = page.dpi ?? 72;
  const left0 = layer.left ?? 0;
  const top0 = layer.top ?? 0;
  const rawWidth = Math.max(0, (layer.right ?? 0) - left0);
  const rawHeight = Math.max(0, (layer.bottom ?? 0) - top0);

  const direction = edit.direction ?? layer.direction ?? "horizontal";
  const isVertical = direction === "vertical";
  const previewText = edit.contents ?? layer.text ?? "";
  const chars = Math.max(1, longestLine(previewText));
  const lineCount = Math.max(1, countLines(previewText));
  // 【v1.16.0】枠の自動調整 — フォント実描画幅 + per-char サイズ/フォント override で long を再算出。
  // 測定失敗 / 未ロード時は null → 従来の chars 推定にフォールバック。
  const fontPs = edit.fontPostScriptName ?? layer.font ?? null;
  // 行間 (autoLeadingAmount %) を厚み（行スタック方向）の係数に反映。125% を最低値として
  // 設定しても既存の見た目より細くしないように clamp。
  const leadingFactor = Math.max(1.25, ((edit.leadingPct ?? 125) / 100));

  const sizePt = getExistingLayerEffectiveSizePt(page, layer, edit);
  const ptInPsdPx = sizePt * (dpi / 72);
  // 【v1.x.0】句読点ツメも bbox 幅に反映（、 / 。 の個数 × tsume% × em ぶん長さが縮む）。
  const punctTsumePctExisting = Number(getDefault("punctuationTsumePercent")) || 0;
  // 【v1.x.0】縦中横（!!/!?/！！/！？）も bbox 長軸に反映（TCY ペアごとに 1em 縮む）。
  // 設定 ON かつ縦書きレイヤーのときのみ。
  const tcyEnabledExisting = (getDefault("tateChuYokoEnabled") !== false) && isVertical;
  // 【v1.16.0】measureMaxLineExtentEm はここで sizePt が確定してから呼ぶ（per-char override も反映）。
  const measuredEm = measureMaxLineExtentEm(previewText, fontPs, sizePt, edit.charSizes, edit.charFonts, punctTsumePctExisting, tcyEnabledExisting);
  // CJK 縦書きで小書き仮名（ょ・っ・ゃ等）や glyph の line-box overhang、
  // text-stroke の outset 半分（stroke 既定 20 PSD px → ~0.16em）を吸収するため
  // 列方向に 0.4em の安全余白を足す。テキスト本体は CSS で bbox 中央に配置するので
  // bbox が広がっても視覚位置は不変。
  // LONG 軸（流し方向）にも display 系フォントの ascender/descender が em-box を
  // 超えてはみ出すぶんの安全余白を 0.4em 加える。
  const THICK_SAFETY = 0.4;
  const LONG_SAFETY = 0.4;
  // 【v1.16.0】行ごとに leading override + per-char サイズ override を反映して厚みを合算。
  // 行 N の override = 行 N-1 と行 N の隙間（marginBlockStart）。行 0 は「前の行」がないので無視。
  // per-char サイズ override がある行はその行の最大文字サイズで line-height をスケール。
  const lineLeadings = edit.lineLeadings ?? {};
  const charSizesMap = edit.charSizes ?? {};
  const linesArrE = previewText.split(/\r?\n/);
  const lineStartsE = getLineStartOffsets(previewText);
  let thickSum = 0;
  for (let i = 0; i < lineCount; i++) {
    const v = (i > 0 && Number.isFinite(lineLeadings[i])) ? lineLeadings[i] / 100 : leadingFactor;
    const leading = Math.max(1.25, v);
    let lineMaxRatio = 1;
    const line = linesArrE[i] ?? "";
    const startIdx = lineStartsE[i] ?? 0;
    for (let k = 0; k < line.length; k++) {
      const cs = charSizesMap[startIdx + k];
      if (Number.isFinite(cs) && cs > 0) {
        const ratio = cs / sizePt;
        if (ratio > lineMaxRatio) lineMaxRatio = ratio;
      }
    }
    thickSum += leading * lineMaxRatio;
  }
  const fallbackThick = ptInPsdPx * (thickSum + THICK_SAFETY);
  // long 軸: 実測 em があればそれ、無ければ chars × 1.05 のヒューリスティック。
  // CJK 縦書き等は chars と em がほぼ等価、Latin 系では em < chars になるので bbox が縮む。
  // 【v1.26.0 移植 (PsDesign-main v1.24.0)】フォント未ロード fallback / Latin 文字幅誤判定で
  // measuredEm が極端に小さくなる事故を防ぐため、最低 1.05 × chars を保証する。
  const heuristicLong = 1.05 * chars;
  const longChars = Number.isFinite(measuredEm) && measuredEm > heuristicLong ? measuredEm : heuristicLong;
  const fallbackLong = ptInPsdPx * (longChars + LONG_SAFETY);
  const minThick = Math.max(ptInPsdPx * (leadingFactor + THICK_SAFETY), 20);
  const minLong = Math.max(ptInPsdPx * 2, 48);

  let width;
  let height;
  if (isVertical) {
    width = Math.max(rawWidth, fallbackThick, minThick);
    height = Math.max(rawHeight, fallbackLong, minLong);
  } else {
    width = Math.max(rawWidth, fallbackLong, minLong);
    height = Math.max(rawHeight, fallbackThick, minThick);
  }

  const left = left0 + (edit.dx ?? 0);
  const top = top0 + (edit.dy ?? 0);
  return { left, top, right: left + width, bottom: top + height, width, height, isVertical, ptInPsdPx, previewText };
}

export function layerRectForNew(page, nl) {
  const dpi = page.dpi ?? 72;
  const isVertical = nl.direction !== "horizontal";
  const sizePt = nl.sizePt ?? 24;
  const ptInPsdPx = sizePt * (dpi / 72);
  const contents = nl.contents ?? "";
  const chars = Math.max(1, longestLine(contents));
  const lineCount = Math.max(1, countLines(contents));
  // 【v1.x.0】句読点ツメも bbox 幅に反映（、 / 。 の個数 × tsume% × em ぶん長さが縮む）。
  const punctTsumePctNew = Number(getDefault("punctuationTsumePercent")) || 0;
  // 【v1.x.0】縦中横（!!/!?/！！/！？）も bbox 長軸に反映（TCY ペアごとに 1em 縮む）。
  const tcyEnabledNew = (getDefault("tateChuYokoEnabled") !== false) && isVertical;
  // 【v1.16.0】枠の自動調整 — 実描画幅で long を auto-fit（フォント変更 + per-char サイズ/フォント変更で bbox 自動更新）。
  const measuredEm = measureMaxLineExtentEm(contents, nl.fontPostScriptName, sizePt, nl.charSizes, nl.charFonts, punctTsumePctNew, tcyEnabledNew);
  // 行間 (%) を厚み係数に反映。125 が既定。
  // 小書き仮名 + stroke overhang を吸収する 0.4em の安全余白を THICK 軸に加算。テキスト本体は
  // CSS padding で bbox 中央に配置されるので、bbox が広がっても視覚位置は変わらない。
  // LONG 軸（流し方向）にも display 系フォントの ascender/descender overshoot 用に 0.4em 加える。
  const leadingFactor = (nl.leadingPct ?? 125) / 100;
  // 【v1.16.0】行ごとに leading override + per-char サイズ override を反映して厚みを合算。
  const lineLeadings = nl.lineLeadings ?? {};
  const charSizesMap = nl.charSizes ?? {};
  const linesArrN = contents.split(/\r?\n/);
  const lineStartsN = getLineStartOffsets(contents);
  let thickSum = 0;
  for (let i = 0; i < lineCount; i++) {
    const v = (i > 0 && Number.isFinite(lineLeadings[i])) ? lineLeadings[i] / 100 : leadingFactor;
    let lineMaxRatio = 1;
    const line = linesArrN[i] ?? "";
    const startIdx = lineStartsN[i] ?? 0;
    for (let k = 0; k < line.length; k++) {
      const cs = charSizesMap[startIdx + k];
      if (Number.isFinite(cs) && cs > 0) {
        const ratio = cs / sizePt;
        if (ratio > lineMaxRatio) lineMaxRatio = ratio;
      }
    }
    thickSum += v * lineMaxRatio;
  }
  const thick = Math.max(24, ptInPsdPx * (thickSum + 0.4));
  // 【v1.26.0 移植 (PsDesign-main v1.24.0)】最低 1.05 × chars を保証して bbox 改行防止。
  const heuristicLong = 1.05 * chars;
  const longChars = Number.isFinite(measuredEm) && measuredEm > heuristicLong ? measuredEm : heuristicLong;
  const longRaw = Math.max(ptInPsdPx * 2, ptInPsdPx * (longChars + 0.4));
  const maxLong = isVertical ? page.height * 0.95 : page.width * 0.95;
  const long = Math.min(longRaw, maxLong);
  const width = isVertical ? thick : long;
  const height = isVertical ? long : thick;
  return { left: nl.x, top: nl.y, right: nl.x + width, bottom: nl.y + height, width, height, isVertical, ptInPsdPx };
}

function rectsIntersect(a, b) {
  return !(b.left >= a.right || b.right <= a.left || b.top >= a.bottom || b.bottom <= a.top);
}

// fillColor === "default" はプレビュー上も編集前の表示を維持するため何も設定しない。
// white/black のときだけ CSS color を上書きする。
function applyFillPreview(inner, fillColor) {
  if (fillColor === "white") inner.style.color = "#fff";
  else if (fillColor === "black") inner.style.color = "#000";
}

function applyStrokePreview(inner, strokeColor, strokeWidthPx, pxPerPsd) {
  if (!strokeColor || strokeColor === "none" || !(strokeWidthPx > 0) || !(pxPerPsd > 0)) return;
  const cssColor = strokeColor === "white" ? "#fff" : "#000";
  // PSD px → screen px。最低 0.5px で visibility 確保。
  const w = Math.max(0.5, strokeWidthPx * pxPerPsd);
  inner.style.webkitTextStroke = `${w}px ${cssColor}`;
  // paint-order を指定して、塗りが上・ストロークが下（外側近似）。
  inner.style.paintOrder = "stroke fill";
}

function renderOverlay(ctx) {
  const { overlay, page, pageIndex } = ctx;
  // 【v1.21.0】編集中 (.editing) のレイヤーは contenteditable のキャレット・選択範囲を
  // 持っているので破壊しない（再構築するとキャレット消失 + selectionchange が走って
  // editingContext が壊れる）。マーキー矩形は marqueeState の復元コードが drawMarquee() で再描画する。
  // 【v1.16.0】innerHTML = "" を撤廃し layer-box / marquee-rect だけ削除する。
  for (const el of overlay.querySelectorAll(".layer-box, .marquee-rect")) {
    if (el.classList.contains("editing")) continue;
    el.remove();
  }

  // 編集中レイヤーがあればその layerKey を控えておき、下のループで二重生成を回避する。
  const editingExistingId = (() => {
    const el = overlay.querySelector(".layer-box-existing.editing");
    return el ? Number(el.dataset.layerId) : null;
  })();
  const editingNewTempId = (() => {
    const el = overlay.querySelector(".layer-box-new.editing");
    return el ? el.dataset.tempId : null;
  })();

  const pxPerPsd = ctx.canvas.clientWidth > 0 ? ctx.canvas.clientWidth / page.width : 0;
  // 複数選択 (2 件以上) の判定。.multi-selected クラスで CSS 側が水色点線 + 青バッジに切替える。
  const isMultiSelect = getSelectedLayers().length > 1;

  for (const layer of page.textLayers) {
    // 編集中レイヤーは既存 DOM を温存（contenteditable キャレットを破壊しない）
    if (editingExistingId !== null && layer.id === editingExistingId) continue;
    const edit = getEdit(page.path, layer.id) ?? {};
    const rect = layerRectForExisting(page, layer, edit);
    const rotation = edit.rotation ?? 0;
    const box = createBox(page, rect.left, rect.top, rect.width, rect.height, "existing");
    box.dataset.layerId = String(layer.id);
    box.dataset.direction = rect.isVertical ? "vertical" : "horizontal";
    if (rotation) box.style.transform = `rotate(${rotation}deg)`;
    box.title = rect.previewText.length > 60 ? rect.previewText.slice(0, 60) + "…" : rect.previewText;

    const inner = document.createElement("div");
    inner.className = "existing-layer-text";
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${rect.ptInPsdPx * pxPerPsd}px`;
    }
    // 行間：edit.leadingPct があれば反映、なければ既定 1.05（既存表示と整合）。
    // tracking は既存レイヤーには適用しない（PS 側に書き戻さない方針と整合させ、保存後の見た目とプレビューを一致させる）。
    // tcy（縦中横）は「見た目の確認」用途で縦書きの既存レイヤープレビューにも反映する（PS 側の実値とは独立）。
    const defaultLeadPct = Number.isFinite(edit.leadingPct) ? edit.leadingPct : 105;
    const tcyEnabled = getDefault("tateChuYokoEnabled") !== false;
    // 【v1.22.0】記号フォント置換（♡♥★☆♪ 等）。新規 + 既存両方に適用、ユーザー手動指定は尊重。
    const symbolReplaceOn = getDefault("symbolFontReplaceEnabled") !== false;
    const symbolFontPS = symbolReplaceOn ? String(getDefault("symbolFontPostScriptName") || "") : "";
    if (symbolFontPS) ensureFontLoaded(symbolFontPS);
    // 【v1.x.0】句読点ツメ（、 / 。 を mojiZume N% で詰める）。新規 + 既存両方の preview に反映。
    const punctTsumePct = Number(getDefault("punctuationTsumePercent")) || 0;
    // 【v1.16.0】per-char サイズ/フォント override + sizePt を渡して per-line bbox / 文字描画を反映。
    const existingSizePt = getExistingLayerEffectiveSizePt(page, layer, edit);
    renderInnerText(
      inner, rect.previewText, defaultLeadPct, edit.lineLeadings, 0, 0,
      tcyEnabled && rect.isVertical,
      rect.isVertical,
      edit.charSizes, existingSizePt, edit.charFonts,
      symbolFontPS,
      edit.charBolds,
      punctTsumePct,
      edit.charRubies,
    );
    const existingPs = edit.fontPostScriptName ?? layer.font;
    const existingFontCss = cssFontFamily(existingPs);
    if (existingFontCss) inner.style.fontFamily = existingFontCss;
    ensureFontLoaded(existingPs);
    // 【v1.22.0】layer 全体の合成太字（faux bold）。per-char (charBolds) があれば
    // span が override する。
    if (edit.syntheticBold === true) inner.style.fontWeight = "700";
    applyFillPreview(inner, edit.fillColor ?? layer.fillColor ?? "default");
    applyStrokePreview(
      inner,
      edit.strokeColor ?? layer.strokeColor ?? "none",
      edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20,
      pxPerPsd,
    );
    box.appendChild(inner);

    if (isLayerSelected(pageIndex, layer.id)) {
      box.classList.add("selected");
      if (isMultiSelect) box.classList.add("multi-selected");
      box.appendChild(createRotateHandle(ctx, layer.id));
      // バッジは bounds 逆算後の実効 pt（layerRectForExisting が rect.ptInPsdPx に反映済み）を表示。
      // 環境設定でフォント/サイズ両方とも非表示の場合 createSizeBadge は null を返す。
      const effectivePt = edit.sizePt ?? (rect.ptInPsdPx * 72 / (page.dpi ?? 72));
      const badge = createSizeBadge(effectivePt, page, edit.fontPostScriptName ?? layer.font ?? null);
      if (badge) box.appendChild(badge);
    }
    box.addEventListener("mousedown", (e) => onExistingLayerMouseDown(e, ctx, layer));
    box.addEventListener("wheel", (e) => onLayerWheel(e, ctx, layer.id), { passive: false });
    overlay.appendChild(box);
  }

  for (const nl of getNewLayersForPsd(page.path)) {
    // 編集中レイヤーは既存 DOM を温存（contenteditable キャレットを破壊しない）
    if (editingNewTempId !== null && nl.tempId === editingNewTempId) continue;
    const rect = layerRectForNew(page, nl);
    const rotation = nl.rotation ?? 0;
    const box = createBox(page, rect.left, rect.top, rect.width, rect.height, "new");
    box.dataset.tempId = nl.tempId;
    box.dataset.direction = rect.isVertical ? "vertical" : "horizontal";
    if (rotation) box.style.transform = `rotate(${rotation}deg)`;
    box.classList.add("text-box-preview");
    // 【v1.26.0 移植 (PsDesign-main v1.24.0)】自動配置で背景/ウニ判定によりフォント切替された印
    // (UI 色強調用)。bucket = 0..5 の 10% 刻みでスコア帯ごとに別色 (青→緑→黄→橙→赤→濃赤)。
    if (nl.autoFontSwitched) {
      box.classList.add("auto-font-switched");
      if (Number.isInteger(nl.autoFontSwitchBucket) && nl.autoFontSwitchBucket >= 0) {
        box.classList.add(`auto-font-bucket-${nl.autoFontSwitchBucket}`);
      }
    }
    const inner = document.createElement("div");
    inner.className = "new-layer-text";
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${rect.ptInPsdPx * pxPerPsd}px`;
    }
    // 新規レイヤーには環境設定の連続記号ツメ（dash/tilde グループ別）を適用。PS 保存にも同じ値を書き戻す。
    // tcy（縦中横）も新規かつ縦書きレイヤーに適用、PS 保存でも textStyleRange の tcy 属性を立てる。
    const dashMille = Number(getDefault("dashRunTrackingMille")) || 0;
    const tildeMille = Number(getDefault("tildeRunKerningMille")) || 0;
    const tcyEnabledNew = getDefault("tateChuYokoEnabled") !== false;
    // 【v1.22.0】記号フォント置換（♡♥★☆♪ 等）。新規 + 既存両方に適用、ユーザー手動指定は尊重。
    const symbolReplaceOnNew = getDefault("symbolFontReplaceEnabled") !== false;
    const symbolFontPSNew = symbolReplaceOnNew ? String(getDefault("symbolFontPostScriptName") || "") : "";
    if (symbolFontPSNew) ensureFontLoaded(symbolFontPSNew);
    // 【v1.x.0】句読点ツメ（、 / 。 を mojiZume N% で詰める）。新規 + 既存両方の preview に反映。
    const punctTsumePctNew = Number(getDefault("punctuationTsumePercent")) || 0;
    // 【v1.16.0】per-char サイズ/フォント override + sizePt を渡して per-line bbox / 文字描画を反映。
    renderInnerText(
      inner, nl.contents, nl.leadingPct ?? 125, nl.lineLeadings, dashMille, tildeMille,
      tcyEnabledNew && rect.isVertical,
      rect.isVertical,
      nl.charSizes, nl.sizePt ?? 24, nl.charFonts,
      symbolFontPSNew,
      nl.charBolds,
      punctTsumePctNew,
      nl.charRubies,
    );
    const newFontCss = cssFontFamily(nl.fontPostScriptName);
    if (newFontCss) inner.style.fontFamily = newFontCss;
    ensureFontLoaded(nl.fontPostScriptName);
    // 【v1.22.0】layer 全体の合成太字。
    if (nl.syntheticBold === true) inner.style.fontWeight = "700";
    applyFillPreview(inner, nl.fillColor ?? "default");
    applyStrokePreview(
      inner,
      nl.strokeColor ?? "none",
      nl.strokeWidthPx ?? 20,
      pxPerPsd,
    );
    box.appendChild(inner);
    if (isLayerSelected(pageIndex, nl.tempId)) {
      box.classList.add("selected");
      if (isMultiSelect) box.classList.add("multi-selected");
      box.appendChild(createRotateHandle(ctx, nl.tempId));
      const newBadge = createSizeBadge(nl.sizePt ?? 24, page, nl.fontPostScriptName ?? null);
      if (newBadge) box.appendChild(newBadge);
    }
    box.addEventListener("mousedown", (e) => onNewLayerMouseDown(e, ctx, nl));
    box.addEventListener("wheel", (e) => onLayerWheel(e, ctx, nl.tempId), { passive: false });
    overlay.appendChild(box);
  }

  // マーキー矩形を復元（ドラッグ中に renderOverlay が走った場合に消えないように）
  if (marqueeState && marqueeState.ctx === ctx) drawMarquee();

  // 【v1.16.0】枠の自動調整（後置の保険）— 実描画後に各 box の inner overflow を検査して、
  // もし内容が box を超えているなら box を伸ばす（フォント/per-char サイズ変更で
  // measureText の予測がズレた際の最終フォールバック）。
  scheduleBoxAutoFit(ctx);

  // 【v1.x.0】複数選択時のバッジ重なり解決。近接する選択フレームの青バッジ同士が
  // 縦に重なるケースがあるため、後で重なりを検出して該当バッジを上向き反転する。
  scheduleBadgeOverlapResolution(ctx);

  // ルビを、属する行と前の行の実測中点へ配置してから PSD 座標で state に書き戻す。
  // これにより Photoshop 保存時 (jsx_gen.rs createRubyLayer) が「ビューアーで見えている位置」を
  // そのまま使え、CSS/JSX の計算ズレが排除される。rAF で layout 確定後に測定する。
  scheduleRubyOffsetMeasure(ctx);
}

function rubyFallbackAdvancePx(box, rt) {
  const rootStyle = getComputedStyle(document.documentElement);
  const pct = Number(rootStyle.getPropertyValue("--ruby-row-leading-pct")) || Number(getDefault("rubyLeadingPct")) || 150;
  const wrap = rt?.closest?.(".ruby-wrap");
  const base = wrap?.querySelector?.(".ruby-base");
  const basis = base || wrap || rt;
  const st = basis ? getComputedStyle(basis) : null;
  const fontPx = st ? Number.parseFloat(st.fontSize) : 0;
  const boxStyle = box ? getComputedStyle(box) : null;
  const boxFontPx = boxStyle ? Number.parseFloat(boxStyle.fontSize) : 0;
  const px = Number.isFinite(fontPx) && fontPx > 0 ? fontPx : boxFontPx;
  return (Number.isFinite(px) && px > 0 ? px : 16) * (pct / 100);
}

function centerOfRect(rect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function unionDomRects(rects) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return null;
  }
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function isInsideRubyText(node) {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return !!el?.closest?.(".ruby-text");
}

function textContentRectWithoutRuby(element) {
  if (!element) return null;
  const rects = [];
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim() === "") return NodeFilter.FILTER_REJECT;
        if (isInsideRubyText(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  const range = document.createRange();
  try {
    while (walker.nextNode()) {
      range.selectNodeContents(walker.currentNode);
      rects.push(...Array.from(range.getClientRects()));
    }
  } finally {
    range.detach?.();
  }
  return unionDomRects(rects);
}

function layoutRectWithoutRuby(element) {
  if (!element?.getBoundingClientRect) return null;
  const rubyTexts = Array.from(element.querySelectorAll?.(".ruby-text") ?? []);
  const prevDisplays = rubyTexts.map((rt) => rt.style.display);
  try {
    for (const rt of rubyTexts) rt.style.display = "none";
    const rect = element.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  } finally {
    rubyTexts.forEach((rt, i) => { rt.style.display = prevDisplays[i]; });
  }
}

function rubyBaseRect(wrap) {
  const base = wrap?.querySelector?.(":scope > .ruby-base");
  const rect = layoutRectWithoutRuby(base || wrap) || (base || wrap)?.getBoundingClientRect?.();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function rubyPlacementBaseRect(wrap, box, vertical) {
  const baseRect = rubyBaseRect(wrap);
  if (!baseRect) return null;
  const lineEl = lineElementForRubyWrap(wrap, box);
  const lineRect = layoutRectWithoutRuby(lineEl);
  if (!lineRect) return baseRect;
  if (vertical) {
    return {
      left: lineRect.left,
      right: lineRect.right,
      top: baseRect.top,
      bottom: baseRect.bottom,
      width: lineRect.width,
      height: baseRect.height,
    };
  }
  return {
    left: baseRect.left,
    right: baseRect.right,
    top: lineRect.top,
    bottom: lineRect.bottom,
    width: baseRect.width,
    height: lineRect.height,
  };
}

function screenPointToPsd(canvasRect, page, screenX, screenY) {
  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  const visualW = rotated90 ? canvasRect.height : canvasRect.width;
  const visualH = rotated90 ? canvasRect.width : canvasRect.height;
  const cx = canvasRect.left + canvasRect.width / 2;
  const cy = canvasRect.top + canvasRect.height / 2;
  const { dx: dxLocal, dy: dyLocal } = inverseRotateDelta(screenX - cx, screenY - cy, rotation);
  const scaleX = page.width / visualW;
  const scaleY = page.height / visualH;
  return {
    x: (visualW / 2 + dxLocal) * scaleX,
    y: (visualH / 2 + dyLocal) * scaleY,
  };
}

function lineElementForRubyWrap(wrap, box) {
  const parent = wrap?.parentElement;
  if (!parent || parent === box) return null;
  const inner = box?.querySelector?.(".new-layer-text, .existing-layer-text");
  if (parent === inner) return null;
  return parent instanceof HTMLElement ? parent : null;
}

function rectsOverlapOnCrossAxis(a, b, vertical) {
  if (vertical) {
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return overlap > Math.min(a.height, b.height) * 0.2;
  }
  const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  return overlap > Math.min(a.width, b.width) * 0.2;
}

function findNeighborLineRect(overlay, box, wrap, baseRect, vertical) {
  const wrapCenter = centerOfRect(baseRect);
  let best = null;
  const candidates = [];
  for (const otherBox of overlay.querySelectorAll(".layer-box")) {
    const inner = otherBox.querySelector(".new-layer-text, .existing-layer-text");
    if (!inner) continue;
    const lineChildren = Array.from(inner.children).filter((el) => el instanceof HTMLElement);
    if (lineChildren.length > 0) {
      for (const child of lineChildren) candidates.push(child);
    } else {
      candidates.push(inner);
    }
  }
  for (const el of candidates) {
    if (el.contains(wrap)) continue;
    const rect = layoutRectWithoutRuby(el) || el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!rectsOverlapOnCrossAxis(baseRect, rect, vertical)) continue;
    const center = centerOfRect(rect);
    // vertical-rl の「前の行」は右側。横書きは上側。
    const forward = vertical ? center.x > wrapCenter.x : center.y < wrapCenter.y;
    if (!forward) continue;
    const distance = vertical ? (center.x - wrapCenter.x) : (wrapCenter.y - center.y);
    if (distance <= 0) continue;
    if (!best || distance < best.distance) best = { rect, distance };
  }
  return best?.rect ?? null;
}

function placeRubyAtLineMidpointsForOverlay(overlay, options = {}) {
  if (!overlay) return;
  const towardParentRatio = Number.isFinite(Number(options.towardParentRatio))
    ? Number(options.towardParentRatio)
    : RUBY_TOWARD_PARENT_RATIO;
  const boxes = overlay.querySelectorAll(".layer-box");
  for (const box of boxes) {
    const vertical = box.dataset.direction === "vertical";
    const wraps = box.querySelectorAll(".ruby-wrap");
    for (const wrap of wraps) {
      const rt = wrap.querySelector(".ruby-text");
      if (!rt) continue;
      const anchorRect = rubyBaseRect(wrap);
      const baseRect = rubyPlacementBaseRect(wrap, box, vertical);
      if (!anchorRect || !baseRect) continue;
      const anchorCenter = centerOfRect(anchorRect);
      const baseCenter = centerOfRect(baseRect);
      let targetX = baseCenter.x;
      let targetY = baseCenter.y;
      const neighbor = findNeighborLineRect(overlay, box, wrap, baseRect, vertical);
      if (neighbor) {
        if (vertical) {
          const middleX = (baseRect.right + neighbor.left) / 2;
          targetX = middleX + (baseRect.right - middleX) * towardParentRatio;
          targetY = baseCenter.y;
        } else {
          targetX = baseCenter.x;
          const middleY = (baseRect.top + neighbor.bottom) / 2;
          targetY = middleY + (baseRect.top - middleY) * towardParentRatio;
        }
      } else {
        const advance = rubyFallbackAdvancePx(box, rt);
        if (vertical) {
          const gap = Math.max(advance - baseRect.width, advance * 0.25, 1);
          targetX = baseRect.right + gap * ((1 - towardParentRatio) / 2);
          targetY = baseCenter.y;
        } else {
          targetX = baseCenter.x;
          const gap = Math.max(advance - baseRect.height, advance * 0.25, 1);
          targetY = baseRect.top - gap * ((1 - towardParentRatio) / 2);
        }
      }
      const dx = targetX - anchorCenter.x;
      const dy = targetY - anchorCenter.y;
      rt.style.left = "50%";
      rt.style.top = "50%";
      rt.style.bottom = "auto";
      rt.style.transform = `translate(calc(-50% + ${dx.toFixed(3)}px), calc(-50% + ${dy.toFixed(3)}px))`;
    }
  }
}

function uiTextBasisRectForBox(box) {
  const inner = box?.querySelector?.(".new-layer-text, .existing-layer-text");
  if (!inner) return box?.getBoundingClientRect?.() ?? null;
  const rect = inner.getBoundingClientRect();
  const st = getComputedStyle(inner);
  const pl = Number.parseFloat(st.paddingLeft) || 0;
  const pr = Number.parseFloat(st.paddingRight) || 0;
  const pt = Number.parseFloat(st.paddingTop) || 0;
  const pb = Number.parseFloat(st.paddingBottom) || 0;
  return {
    left: rect.left + pl,
    top: rect.top + pt,
    right: rect.right - pr,
    bottom: rect.bottom - pb,
    width: Math.max(0, rect.width - pl - pr),
    height: Math.max(0, rect.height - pt - pb),
  };
}

// 1 ctx 分の ruby 位置測定 (同期、副作用は state 書き戻しのみ)。
// rAF 版と save-time 同期版から共有する内部実装。
function measureRubyOffsetsForOverlay(overlay, canvas, page) {
  if (!overlay || !canvas || !page) return;
  const canvasRect = canvas.getBoundingClientRect();
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return;
  const pxPerPsd = canvasRect.width / page.width;
  if (!Number.isFinite(pxPerPsd) || pxPerPsd <= 0) return;
  // overlay 内の全 layer-box (.editing 含む) を走査。
  const boxes = overlay.querySelectorAll(".layer-box");
  for (const box of boxes) {
    const wraps = box.querySelectorAll(".ruby-wrap[data-ruby-start]");
    if (wraps.length === 0) continue;
    const basisRect = uiTextBasisRectForBox(box);
    if (!basisRect || basisRect.width <= 0 || basisRect.height <= 0) continue;
    const psdPath = page.path;
    const isNew = box.classList.contains("layer-box-new");
    const layerKey = isNew ? box.dataset.tempId : Number(box.dataset.layerId);
    if (!psdPath || layerKey === null || layerKey === undefined || layerKey === "" || (typeof layerKey === "number" && !Number.isFinite(layerKey))) continue;
    // 同じ data-ruby-start を持つ wrap が複数あれば (モノルビ)、最初の wrap だけ測る。
    const seenStarts = new Set();
    for (const wrap of wraps) {
      const startStr = wrap.dataset.rubyStart;
      if (!startStr) continue;
      if (seenStarts.has(startStr)) continue;
      seenStarts.add(startStr);
      const start = Number(startStr);
      if (!Number.isInteger(start)) continue;
      const rt = wrap.querySelector(".ruby-text");
      if (!rt) continue;
      const rtRect = rt.getBoundingClientRect();
      if (rtRect.width <= 0 || rtRect.height <= 0) continue;
      // .ruby-text のスクリーン中心 → UI 上の実テキスト領域からの screen 相対座標 → PSD 座標に換算。
      // 縦書きは親文字の右側が前行側なので、UI/Photoshop ともに右端基準の offsetX にする。
      // 横書きは従来通り左上基準。
      const rtCenterScreenX = rtRect.left + rtRect.width / 2;
      const rtCenterScreenY = rtRect.top + rtRect.height / 2;
      const vertical = box.dataset.direction === "vertical";
      const offsetX = vertical
        ? (rtCenterScreenX - basisRect.right) / pxPerPsd
        : (rtCenterScreenX - basisRect.left) / pxPerPsd;
      const offsetY = (rtCenterScreenY - basisRect.top) / pxPerPsd;
      const abs = screenPointToPsd(canvasRect, page, rtCenterScreenX, rtCenterScreenY);
      const absX = abs.x;
      const absY = abs.y;
      if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !Number.isFinite(absX) || !Number.isFinite(absY)) continue;
      try {
        setCharRubyOffset(psdPath, layerKey, start, offsetX, offsetY, absX, absY);
      } catch (_) { /* state 未整合の場合は無視 */ }
    }
  }
}

// rAF で 1 フレーム遅延させて layout 確定後に走る (renderOverlay 末尾から呼ばれる)。
function scheduleRubyOffsetMeasure(ctx) {
  if (typeof requestAnimationFrame !== "function") return;
  if (ctx._rubyOffsetScheduled) return;
  ctx._rubyOffsetScheduled = true;
  requestAnimationFrame(() => {
    ctx._rubyOffsetScheduled = false;
    placeRubyAtLineMidpointsForOverlay(ctx.overlay);
    measureRubyOffsetsForOverlay(ctx.overlay, ctx.canvas, ctx.page);
    placeRubyAtLineMidpointsForOverlay(ctx.overlay, { towardParentRatio: 0 });
  });
}

// 【v1.29.x UI-coord 保存時同期】保存ボタン押下の瞬間に全 page の overlay を DOM から
// 拾って同期測定する。これにより rAF 遅延を待たずに最新のルビ位置を state に書き戻せる。
// exportEdits を呼ぶ前にこの関数を呼ぶ運用 (bind/save.js の runSaveWithMode で利用)。
//
// DOM 構造: spread-view.js が各ページを以下のように構築する:
//   .canvas-wrap > canvas[data-page-index="N"] + .page-overlay
// これを利用して overlay の親 (.canvas-wrap) から canvas を辿り、data-page-index で page を引く。
export function measureAllRubyOffsetsSync() {
  const pages = getPages();
  if (!pages || pages.length === 0) return;
  const overlays = document.querySelectorAll(".page-overlay");
  for (const overlay of overlays) {
    // overlay の兄弟に canvas (data-page-index 付き) があるはず。
    const parent = overlay.parentElement;
    if (!parent) continue;
    const canvas = parent.querySelector("canvas[data-page-index]");
    if (!canvas) continue;
    const pageIndex = Number(canvas.dataset.pageIndex);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) continue;
    const page = pages[pageIndex];
    if (!page) continue;
    placeRubyAtLineMidpointsForOverlay(overlay);
    measureRubyOffsetsForOverlay(overlay, canvas, page);
    placeRubyAtLineMidpointsForOverlay(overlay, { towardParentRatio: 0 });
  }
}

// バッジ重なり解決パス。rAF で 1 フレーム遅延させて DOM レイアウトが確定してから走る。
// 各バッジの getBoundingClientRect を比較し、すでに配置済みのバッジと縦方向で交差する
// なら .layer-size-badge--above を付けて上向きに反転する。
function scheduleBadgeOverlapResolution(ctx) {
  if (typeof requestAnimationFrame !== "function") return;
  if (ctx._badgeOverlapScheduled) return;
  ctx._badgeOverlapScheduled = true;
  requestAnimationFrame(() => {
    ctx._badgeOverlapScheduled = false;
    if (!ctx.overlay) return;
    const badges = Array.from(ctx.overlay.querySelectorAll(".layer-size-badge"));
    if (badges.length < 2) {
      // 1 個以下なら重なりが発生しない。クラスをクリアして default 下向きに戻す。
      for (const b of badges) b.classList.remove("layer-size-badge--above");
      return;
    }
    // 一旦すべて下向きにリセットしてから検出（前回の反転が残留しないよう）。
    for (const b of badges) b.classList.remove("layer-size-badge--above");
    // 左上 (top, left) 順にソートしてバッジを 1 つずつ「配置」していく。
    // 後から配置するバッジが既存バッジと交差したら上向きに反転する。
    const placed = [];
    badges.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (ra.top !== rb.top) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    for (const badge of badges) {
      const r = badge.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (rectsOverlapPlaced(r, placed)) {
        badge.classList.add("layer-size-badge--above");
        const r2 = badge.getBoundingClientRect();
        // 反転後も重なる場合は諦めて下向きに戻す（多重重なりの極端ケース）。
        if (rectsOverlapPlaced(r2, placed)) {
          badge.classList.remove("layer-size-badge--above");
          placed.push(r);
        } else {
          placed.push(r2);
        }
      } else {
        placed.push(r);
      }
    }
  });
}

function rectsOverlapPlaced(r, placed) {
  for (const p of placed) {
    if (
      r.left < p.right - 1 &&
      r.right > p.left + 1 &&
      r.top < p.bottom - 1 &&
      r.bottom > p.top + 1
    ) return true;
  }
  return false;
}

// 【v1.16.0】枠の自動調整（後置の保険）— measureText の予測がズレた場合の最終フォールバック。
// 各 layer-box の inner.scrollWidth/Height を測って、box を超えていたら box CSS を伸ばす。
// PSD 座標 → % 換算で指定。直接的な auto-fit 保険として動作する。
function scheduleBoxAutoFit(ctx) {
  if (typeof requestAnimationFrame !== "function") return;
  if (ctx._autoFitScheduled) return;
  ctx._autoFitScheduled = true;
  requestAnimationFrame(() => {
    ctx._autoFitScheduled = false;
    if (!ctx.overlay || !ctx.canvas) return;
    const overlayW = ctx.overlay.clientWidth;
    const overlayH = ctx.overlay.clientHeight;
    if (overlayW <= 0 || overlayH <= 0) return;
    for (const box of ctx.overlay.querySelectorAll(".layer-box")) {
      const inner = box.querySelector(".existing-layer-text, .new-layer-text");
      if (!inner) continue;
      const sw = inner.scrollWidth;
      const sh = inner.scrollHeight;
      const cw = inner.clientWidth;
      const ch = inner.clientHeight;
      const overflowW = sw - cw;
      const overflowH = sh - ch;
      if (overflowW > 1) {
        const newW = (box.offsetWidth + overflowW + 4); // 4px 余裕
        box.style.width = `${(newW / overlayW) * 100}%`;
      }
      if (overflowH > 1) {
        const newH = (box.offsetHeight + overflowH + 4);
        box.style.height = `${(newH / overlayH) * 100}%`;
      }
    }
  });
}

// 【v1.16.0】非対応フォントの対応 — 常に引用で数字始まり / 非 ASCII 名 / 予約語衝突を一括対処。
// 旧: `[\s,'"()]` を含むときだけ引用 → `851チカラヅヨク` のような数字始まり PS 名や
// 非 ASCII 名フォントが unquoted で CSS parse error を起こし、font-family 全体が
// 無効化される事故が発生していた。常時引用にすればこれらを完全に防げる。
function quoteFontFamily(name) {
  if (!name) return null;
  const escaped = String(name).replace(/["\\]/g, "\\$&");
  return `"${escaped}"`;
}

export function cssFontFamily(psName) {
  if (!psName) return null;
  const display = getFontDisplayName(psName);
  const parts = [];
  const q1 = quoteFontFamily(display);
  const q2 = quoteFontFamily(psName);
  if (q1) parts.push(q1);
  if (q2 && q2 !== q1) parts.push(q2);
  parts.push("sans-serif");
  return parts.join(", ");
}

function longestLine(s) {
  if (!s) return 0;
  const lines = String(s).split(/\r?\n/);
  let max = 0;
  for (const line of lines) if (line.length > max) max = line.length;
  return max;
}

function countLines(s) {
  if (!s) return 0;
  return String(s).split(/\r?\n/).length;
}

// fullText の各行の絶対開始 index を返す（textarea selectionStart と同じインデックス系）。
// 【v1.16.0】per-char サイズ/フォント機能で行内 i 番目の char の絶対 index を引くために使う。
function getLineStartOffsets(fullText) {
  const offsets = [0];
  const regex = /\r?\n/g;
  let m;
  while ((m = regex.exec(fullText))) {
    offsets.push(m.index + m[0].length);
  }
  return offsets;
}

// 【v1.16.0】枠の自動調整 — canvas.measureText で実描画幅を測って bbox を auto-fit。
// canvas.measureText 用のオフスクリーン context（モジュール singleton）。
// 各行の実描画幅を em で返す。フォントが未ロードのときは fallback フォントで測定されるが、
// font-loader が登録完了時に refreshAllOverlays を呼ぶので次の render で正確な値に更新される。
let _measureCanvas = null;
function getMeasureContext() {
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  return _measureCanvas.getContext("2d");
}

// 【v1.16.0】枠の自動調整 — per-char サイズ/フォント override を反映した実描画幅を返す。
// 1 行の実描画幅を「layer のフォントサイズ単位」の em で返す。
// charSizes / charFonts による per-char オーバーライドを反映する。
// 連続する同じ (font, size) の文字を 1 セグメントにまとめて canvas.measureText で測り、
// セグメントの寸法を「(layer.sizePt) を 1 とした比率」に換算して合算する。
// charSize がオーバーライドされている文字は、その文字のサイズで測ったうえで
// (charSize / layerSize) 倍してから加算する → bbox が大きい文字に応じて伸びる。
//
// 戻り値: 0 〜 ∞（layer.sizePt em 単位）。空行は 0。測定不能なら null。
function measureLineExtentEmWithOverrides(line, lineStartIdx, charSizes, charFonts, layerSizePt, layerFontPs, punctTsumePct, tcyEnabled) {
  if (!line) return 0;
  if (!Number.isFinite(layerSizePt) || layerSizePt <= 0) return null;
  let ctx;
  try { ctx = getMeasureContext(); } catch { return null; }
  const refSizePx = 100;
  let totalEm = 0;
  // 【v1.x.0】句読点ツメ: 、 / 。 の数だけ tsume% × (charSize / layerSize) を差し引く。
  // measureText 自体は letter-spacing を反映しないので、ここで em 換算した差分を引く。
  const tsumeMag = Number.isFinite(punctTsumePct) && punctTsumePct > 0 ? punctTsumePct / 100 : 0;
  let tsumeReductionEm = 0;
  if (tsumeMag > 0) {
    for (let k = 0; k < line.length; k++) {
      const cc = line.charCodeAt(k);
      if (PUNCT_TSUME_CHAR_CODES.has(cc)) {
        const charSz = Number.isFinite(charSizes?.[lineStartIdx + k]) ? charSizes[lineStartIdx + k] : layerSizePt;
        tsumeReductionEm += tsumeMag * (charSz / layerSizePt);
      }
    }
  }
  // 縦中横ペアは 2 文字を 1 セル幅 (CJK 全角 1em) に圧縮して描画される。
  // measureText が返す元の 2 文字幅は半角/全角でかなり異なる:
  //   - 半角 !! / !? : measureText ≈ 0.4em（ASCII proportional は細い）
  //   - 全角 ！！ / ！？: measureText ≈ 2em（CJK 全角 1em × 2）
  // どちらの場合も TCY 後の bbox は 1em に正規化される必要があるため、
  // ペアごとに「元の measureText 幅を引き、代わりに 1em を足す」差分補正を行う。
  //   - 半角ペア: 元 0.4em → 1em で +0.6em（広げる）
  //   - 全角ペア: 元 2em → 1em で -1em（縮める）
  // これがないと半角ペア入力時に bbox が不足して `!!` がフレームから溢れる。
  // tcyEnabled=true は呼び出し側で「設定 ON かつ縦書きレイヤー」の合成済みフラグを期待。
  let tcyAdjustEm = 0;
  if (tcyEnabled && line.length >= 2) {
    // TCY ペアの font-family は layer フォントを採用（TCY span 内は per-char font override 対象外）。
    const tcyFam = cssFontFamily(layerFontPs) || "sans-serif";
    for (let k = 0; k < line.length - 1; ) {
      const two = line.slice(k, k + 2);
      if (two === "!!" || two === "!?" || two === "！！" || two === "！？") {
        let pairOrigEm = 0;
        try {
          ctx.font = `${refSizePx}px ${tcyFam}`;
          const w = ctx.measureText(two).width;
          pairOrigEm = w / refSizePx;
        } catch { pairOrigEm = 0; }
        // 元の幅 (totalEm に既に含まれている) を引き、TCY 後の 1em を足す
        tcyAdjustEm += 1 - pairOrigEm;
        k += 2;
      } else {
        k += 1;
      }
    }
  }
  let i = 0;
  while (i < line.length) {
    const sizeStart = Number.isFinite(charSizes?.[lineStartIdx + i]) ? charSizes[lineStartIdx + i] : layerSizePt;
    const fontStart = (typeof charFonts?.[lineStartIdx + i] === "string" && charFonts[lineStartIdx + i].length > 0)
      ? charFonts[lineStartIdx + i] : layerFontPs;
    let j = i + 1;
    while (j < line.length) {
      const sz = Number.isFinite(charSizes?.[lineStartIdx + j]) ? charSizes[lineStartIdx + j] : layerSizePt;
      const fn = (typeof charFonts?.[lineStartIdx + j] === "string" && charFonts[lineStartIdx + j].length > 0)
        ? charFonts[lineStartIdx + j] : layerFontPs;
      if (sz !== sizeStart || fn !== fontStart) break;
      j++;
    }
    const segText = line.slice(i, j);
    const fam = cssFontFamily(fontStart) || "sans-serif";
    // bbox 計算で参照する font を先読み開始（ロード完了後に onFontsRegistered →
    // refreshAllOverlays で再描画されて bbox が確定する）。
    if (fontStart) ensureFontLoaded(fontStart);
    const fontShorthand = `${refSizePx}px ${fam}`;
    // フォント未ロード時は measureText が fallback フォントで誤った値を返す。
    // それを使うと bbox が一時的に小さく計算されて、CSS 側の `white-space: pre-wrap` で
    // 改行が走り「フォント変更で改行位置が変わる」事故になるため、未ロード時は
    // 保守的な 1em per char にフォールバックする（CJK で正確、Latin で大きめ）。
    //
    // 注意: `document.fonts.check(fontShorthand)` は font shorthand 全体に sans-serif が
    // 含まれているため常に true を返す（sans-serif は常時利用可能）。これでは未ロード時の
    // フォールバックが発動しない。primary の family 名だけで check する必要がある。
    let fontReady = true;
    if (typeof document !== "undefined" && document.fonts && fontStart) {
      try {
        const display = getFontDisplayName(fontStart);
        const primary = quoteFontFamily(display) || quoteFontFamily(fontStart);
        if (primary) {
          fontReady = document.fonts.check(`${refSizePx}px ${primary}`);
        }
      } catch { fontReady = false; }
    }
    let w;
    if (fontReady) {
      ctx.font = fontShorthand;
      try { w = ctx.measureText(segText).width; } catch { return null; }
      if (!Number.isFinite(w) || w <= 0) {
        w = segText.length * refSizePx;
      }
    } else {
      // フォント未ロード → 1em per char で大きめの bbox を確保
      w = segText.length * refSizePx;
    }
    // refSizePx font-size での実幅（CSS px）→ そのセグメントの「sizeStart pt」での幅に正規化
    // → さらに「layerSizePt em」に換算（layer サイズを 1 とした比率）
    const segWidthAtCharSizeEm = w / refSizePx;
    const segWidthAtLayerEm = segWidthAtCharSizeEm * (sizeStart / layerSizePt);
    totalEm += segWidthAtLayerEm;
    i = j;
  }
  // 句読点ツメぶんを引き、縦中横ぶん（半角は加算 / 全角は減算の符号付き差分）を足し合わせる。
  // 負にならないようガード。
  const adjusted = totalEm - tsumeReductionEm + tcyAdjustEm;
  return adjusted > 0 ? adjusted : 0;
}

// 全行の最大行幅を「layer.sizePt em 単位」で返す。
// charSizes / charFonts に override があれば反映、なければ layer フォント単一で測定。
// punctTsumePct: 句読点ツメ%。0 のとき無効。各行の measureLineExtentEmWithOverrides に伝搬。
// tcyEnabled: 縦中横を bbox 計算に反映するか。true なら !!/!?/！！/！？ ペアの 1 文字幅ぶんを減算。
function measureMaxLineExtentEm(text, postScriptName, layerSizePt, charSizes, charFonts, punctTsumePct, tcyEnabled) {
  if (!text) return 0;
  if (!Number.isFinite(layerSizePt) || layerSizePt <= 0) return null;
  const fullText = String(text);
  const linesArr = fullText.split(/\r?\n/);
  const lineStarts = getLineStartOffsets(fullText);
  let maxEm = 0;
  for (let li = 0; li < linesArr.length; li++) {
    const em = measureLineExtentEmWithOverrides(
      linesArr[li], lineStarts[li], charSizes, charFonts, layerSizePt, postScriptName, punctTsumePct, tcyEnabled,
    );
    if (em == null) continue;
    if (em > maxEm) maxEm = em;
  }
  return maxEm;
}

// 連続したとき自動でツメる対象記号 2 グループ。Photoshop 側でも同じ char code 集合を使う。
// dash:  — U+2014 EM DASH / ― U+2015 HORIZONTAL BAR / – U+2013 EN DASH / ‒ U+2012 FIGURE DASH /
//        ‐ U+2010 HYPHEN / ‑ U+2011 NON-BREAKING HYPHEN / ー U+30FC 長音記号 / － U+FF0D 全角ハイフン
// tilde: 〜 U+301C WAVE DASH / ～ U+FF5E FULLWIDTH TILDE
// 【v1.30.x】罫線素片 (─ U+2500 / ━ U+2501) や hyphen-bullet (⁃) など、Photoshop で
// ダッシュ風に使われる文字も dash 系として扱う。tilde 系は ASCII チルダ (~) と
// SMALL TILDE (˜) を追加。jsx_gen.rs charGroup と同期。
const DASH_CHARS = new Set(["—", "―", "–", "‒", "‐", "‑", "ー", "－", "─", "━", "−", "⁃", "﹘", "﹣"]);
const TILDE_CHARS = new Set(["〜", "～", "~", "˜"]);
const REPEATED_TARGET_REGEX = /[—―–‒‐‑ー－─━−⁃﹘﹣〜～~˜]/;

// 【v1.22.0】記号フォント置換の対象 char code 集合（プレビュー / Photoshop 両側で同一定義）。
// ハードコード固定セット。漫画写植慣例の「写植本体フォントが対応していない記号類」をカバー。
// ハート ♡♥ / 星 ★☆ / 音符 ♪♫♬♩♯♭ / 矢印 →←↑↓ / 丸 ○●〇◎ /
// 三角 △▲▽▼ / 四角 □■ / 菱形 ◇◆ / トランプ ♠♣♦
const SYMBOL_CHAR_CODES = new Set([
  0x2661, 0x2665, 0x2764,           // ♡ ♥ ❤
  0x2605, 0x2606,                   // ★ ☆
  0x266A, 0x266B, 0x266C, 0x2669,   // ♪ ♫ ♬ ♩
  0x266F, 0x266D,                   // ♯ ♭
  0x2192, 0x2190, 0x2191, 0x2193,   // → ← ↑ ↓
  0x25CB, 0x25CF, 0x3007, 0x25CE,   // ○ ● 〇 ◎
  0x25B3, 0x25B2, 0x25BD, 0x25BC,   // △ ▲ ▽ ▼
  0x25A1, 0x25A0,                   // □ ■
  0x25C7, 0x25C6,                   // ◇ ◆
  0x2660, 0x2663, 0x2666,           // ♠ ♣ ♦
]);
function isSymbolReplaceChar(ch) {
  if (typeof ch !== "string" || ch.length === 0) return false;
  return SYMBOL_CHAR_CODES.has(ch.charCodeAt(0));
}
function lineHasSymbolChar(s) {
  if (typeof s !== "string") return false;
  for (let i = 0; i < s.length; i++) {
    if (SYMBOL_CHAR_CODES.has(s.charCodeAt(i))) return true;
  }
  return false;
}

// 縦中横（tate-chu-yoko）対象の半角ペア。先頭から 2 文字単位で探索し、3 文字以上連続のとき
// 余り 1 文字は単独扱い（ユーザー仕様）。Photoshop 側 (jsx_gen.rs) でも同じ判定を行う。
// 縦中横の対象ペア: 半角 !! / !? に加え、全角 ！！ / ！？ も拾う（PSD 既存テキストは
// 全角で組まれていることが多いため）。混在ペア (!！ / !？ / ！! / ！?) は意図しない
// 入力途中のケースが多いので対象外。
const TCY_PAIR_REGEX = /!!|!\?|！！|！？/;

// 【v1.x.0】句読点ツメ（mojiZume）の対象。U+3001「、」/ U+3002「。」のみ。
// Photoshop 側 (jsx_gen.rs applyPunctuationTsume) と同じ char code 集合。
// 環境設定 `punctuationTsumePercent` (0/50%) に従って、各文字の直後の空白を tsume% ぶん詰める。
// CSS では `letter-spacing: -(tsume/100)em` を句読点の span に当てて、次の文字との距離を縮める。
const PUNCT_TSUME_CHAR_CODES = new Set([0x3001, 0x3002]);
function isPunctTsumeChar(ch) {
  if (typeof ch !== "string" || ch.length === 0) return false;
  return PUNCT_TSUME_CHAR_CODES.has(ch.charCodeAt(0));
}
function lineHasPunctTsumeChar(s) {
  if (typeof s !== "string") return false;
  for (let i = 0; i < s.length; i++) {
    if (PUNCT_TSUME_CHAR_CODES.has(s.charCodeAt(i))) return true;
  }
  return false;
}

function repeatedTargetGroup(ch) {
  if (DASH_CHARS.has(ch)) return "dash";
  if (TILDE_CHARS.has(ch)) return "tilde";
  return null;
}
function isRepeatedTargetChar(ch) {
  return repeatedTargetGroup(ch) !== null;
}

// 1 行を [{text, group}] のセグメント列に分解する。
// 例: "あ―――い" → [{text:"あ", group:null}, {text:"―――", group:"dash"}, {text:"い", group:null}]
// 例: "―〜―あ" → dash / tilde / dash を別ラン扱い。
function findRepeatedTargetRuns(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const group = repeatedTargetGroup(line[i]);
    let j = i;
    while (j < line.length && repeatedTargetGroup(line[j]) === group) j++;
    out.push({ text: line.slice(i, j), group });
    i = j;
  }
  return out;
}

// 半角 !! / !? の出現位置を 2 文字ペアとして列挙する。先頭から貪欲に消費するので
// "!!!" → [(0,2)]（末尾 ! は単独）、"!!?!" → [(0,2)] (! 単独 + ! 単独)、
// "!!!!?" → [(0,2), (2,4)]（末尾 ? は単独）。
function findTcyPairs(line) {
  const pairs = [];
  for (let i = 0; i < line.length - 1; ) {
    const two = line.slice(i, i + 2);
    // 半角 !! / !? と全角 ！！ / ！？ の両方を縦中横ペアとして扱う。
    if (two === "!!" || two === "!?" || two === "！！" || two === "！？") {
      pairs.push({ start: i, end: i + 2 });
      i += 2;
    } else {
      i += 1;
    }
  }
  return pairs;
}

// 【v1.16.0】per-char サイズ/フォント描画 + 連続記号ツメ + TCY 統合ヘルパー。
// 4 要素 (TCY + DASH/TILDE 連続記号ツメ + per-char-size + per-char-font) を 1 関数で処理する。
//
// 1 行を parentEl に追加する。
// - tcyOn のとき、!! / !? のペアを <span class="tcy-span"> でラップ（CSS の text-combine-upright で
//   2 文字を 1 文字幅に詰めて縦書き 1 セルに収める）。tcy 内では per-char サイズ/フォントは適用しない。
// - 連続対象記号ラン (dash / tilde) は per-char letter-spacing を当ててツメ表示（最後の 1 文字は除外）。
// - charSizes: contents 文字列の絶対 index をキーとする pt サポート。layer の defaultSizePt との
//   比率を em で指定して inner の font-size に対する相対サイズに変換する。
// - charFonts: 絶対 index をキーとする PostScript 名。inner の font-family を上書きする。
//
// lineStartIdx: この行が full contents 文字列のどの位置から始まるか（0-based）。
// dashMille / tildeMille は写植設定の tracking 値をそのまま使う（例: -100 → -0.1em）。
// tcyOn は呼び出し側で「設定 ON かつ縦書きレイヤー」の合成済みフラグを期待する。
//
// 連続する同 signature (size, tracking, font) の文字を 1 span にまとめて DOM 軽量化。
function appendLineWithTracking(parentEl, line, lineStartIdx, dashMille, tildeMille, tcyOn, charSizes, defaultSizePt, charFonts, symbolFontPS, charBolds, punctTsumeMag, charRubies) {
  if (!line.length) {
    // 空行は zero-width space で line-box を維持（縦書きで列が消えないように）。
    parentEl.appendChild(document.createTextNode("​"));
    return;
  }
  const dashTrack = Number.isFinite(Number(dashMille)) ? Number(dashMille) : 0;
  const tildeTrack = Number.isFinite(Number(tildeMille)) ? Number(tildeMille) : 0;
  let tcyPairs = tcyOn ? findTcyPairs(line) : [];
  const hasCharSizes = charSizes && Object.keys(charSizes).length > 0;
  const hasCharFonts = charFonts && Object.keys(charFonts).length > 0;
  const hasCharBolds = charBolds && Object.keys(charBolds).length > 0;
  const trackingActive = (dashTrack !== 0 || tildeTrack !== 0) && REPEATED_TARGET_REGEX.test(line);
  const symbolActive = (typeof symbolFontPS === "string" && symbolFontPS.length > 0) && lineHasSymbolChar(line);
  // 【v1.x.0】句読点ツメ（、 / 。 を tsume% で詰める）。0..1 の em 量。
  const tsumeMag = Number.isFinite(punctTsumeMag) && punctTsumeMag > 0 ? punctTsumeMag : 0;
  const punctActive = tsumeMag > 0 && lineHasPunctTsumeChar(line);

  // 【v1.26.0】ruby 範囲を line 内で抽出（line 内の local index に変換）。
  // ruby 範囲は最優先で line を分割し、ruby 内の文字は <ruby> 構造で別出力する。
  const lineEnd = lineStartIdx + line.length;
  const rubySegmentsInLine = [];
  if (charRubies) {
    for (const k of Object.keys(charRubies)) {
      const s = Number(k);
      const entry = charRubies[k];
      if (!Number.isFinite(s) || !entry) continue;
      const e = Number(entry.end);
      if (e <= lineStartIdx || s >= lineEnd) continue;
      // line 範囲内に clipping（ruby が複数行に跨ぐケースは Phase A では line 末まで truncate）
      const localStart = Math.max(s, lineStartIdx) - lineStartIdx;
      const localEnd = Math.min(e, lineEnd) - lineStartIdx;
      rubySegmentsInLine.push({ start: localStart, end: localEnd, entry });
    }
    rubySegmentsInLine.sort((a, b) => a.start - b.start);
  }
  const hasRuby = rubySegmentsInLine.length > 0;
  // ruby 範囲内の tcy ペアは抑止（ruby のふりがな上で縦中横が当たると見た目が崩れる）。
  if (hasRuby && tcyPairs.length > 0) {
    tcyPairs = tcyPairs.filter((p) =>
      !rubySegmentsInLine.some((r) => p.start < r.end && p.end > r.start));
  }

  // 高速パス：何も装飾なし → 単純テキストノード 1 つで終わり
  if (!trackingActive && tcyPairs.length === 0 && !hasCharSizes && !hasCharFonts && !symbolActive && !hasCharBolds && !punctActive && !hasRuby) {
    parentEl.appendChild(document.createTextNode(line));
    return;
  }
  // 各文字の tracking 値（em 単位、負）を事前計算。連続ランの最後の文字は 0。
  const trackings = new Array(line.length).fill(0);
  if (trackingActive) {
    const segments = findRepeatedTargetRuns(line);
    let pos = 0;
    for (const seg of segments) {
      if (seg.group && seg.text.length >= 2) {
        for (let k = 0; k < seg.text.length - 1; k++) {
          const value = seg.group === "dash" ? dashTrack : seg.group === "tilde" ? tildeTrack : 0;
          if (value !== 0) trackings[pos + k] = value / 1000;
        }
      }
      pos += seg.text.length;
    }
  }
  // tcy ペア境界で分割し、各セグメントを「tcy 内」(text-combine-upright) または
  // 「tcy 外」(per-char signature 統合) として出力する。
  // 句読点ツメは punctActive のときだけ tsumeMag を append... に渡す（高速パス判定とも整合）。
  const tsumeArg = punctActive ? tsumeMag : 0;

  // 【v1.26.0】ruby 範囲があれば、まず line を「ruby 範囲ぶん」「それ以外（既存 tcy + styled）」
  // で分割して出力する。これにより ruby は最優先で <ruby><rb>...<rt>...</rt></ruby> 構造化される。
  const emitNonRubyRange = (fromLocal, toLocal) => {
    if (toLocal <= fromLocal) return;
    const sub = line.slice(fromLocal, toLocal);
    // tcyPairs を sub の範囲に限定し、local index を sub 基準に再オフセット
    const pairsInSub = tcyPairs
      .filter((p) => p.start >= fromLocal && p.end <= toLocal)
      .map((p) => ({ start: p.start - fromLocal, end: p.end - fromLocal }));
    let pos = 0;
    for (const pair of pairsInSub) {
      if (pair.start > pos) {
        appendStyledSegment(parentEl, sub.slice(pos, pair.start),
          fromLocal + pos, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts,
          hasCharSizes, hasCharFonts, symbolActive ? symbolFontPS : null, charBolds, hasCharBolds, tsumeArg);
      }
      const span = document.createElement("span");
      span.className = "tcy-span";
      span.textContent = sub
        .slice(pair.start, pair.end)
        .replace(/！/g, "!")
        .replace(/？/g, "?");
      parentEl.appendChild(span);
      pos = pair.end;
    }
    if (pos < sub.length) {
      appendStyledSegment(parentEl, sub.slice(pos),
        fromLocal + pos, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts,
        hasCharSizes, hasCharFonts, symbolActive ? symbolFontPS : null, charBolds, hasCharBolds, tsumeArg);
    }
  };

  if (hasRuby) {
    let cursor = 0;
    for (const seg of rubySegmentsInLine) {
      if (seg.start > cursor) emitNonRubyRange(cursor, seg.start);
      appendRubySegment(parentEl,
        line.slice(seg.start, seg.end), seg.start, lineStartIdx, seg.entry,
        trackings, charSizes, defaultSizePt, charFonts,
        symbolActive ? symbolFontPS : null, charBolds,
        hasCharSizes, hasCharFonts, hasCharBolds, tsumeArg);
      cursor = seg.end;
    }
    if (cursor < line.length) emitNonRubyRange(cursor, line.length);
    return;
  }

  // ruby なし → 既存パス（tcy + styled）。
  emitNonRubyRange(0, line.length);
}

// 【v1.26.0】ruby segment を「親文字 wrap + 実 DOM のルビ span」構造で出力する。
// 旧 <ruby> タグ方式は Chromium の writing-mode: vertical-rl サポートが不安定。
// ::after 疑似要素方式も再描画後に消えるバグが残ったため、ルビを本物の <span class="ruby-text">
// として DOM に入れる構造に変更。これで描画が確実に行われる。
//
// 構造:
//   <span class="ruby-wrap">
//     <span class="ruby-base">親文字</span>
//     <span class="ruby-text">ふりがな</span>
//   </span>
// CSS で .ruby-text を absolute 配置（横書きは上、縦書きは右）。
//
// モノルビ（type === "mono" かつ スペース分割数 == parentText.length）は親文字 1 文字 + rt-pair
// を文字ごとに並べる。グループルビは親文字全体に 1 つの rt を付ける。
function appendRubySegment(parentEl, parentText, parentLocalStart, lineStartIdx, entry,
                            trackings, charSizes, defaultSizePt, charFonts,
                            symbolFontPS, charBolds,
                            hasCharSizes, hasCharFonts, hasCharBolds, punctTsumeMag) {
  if (!parentText.length || !entry || typeof entry.text !== "string") return;
  const isMono = entry.type === "mono"
    && /[ 　]/.test(entry.text)
    && entry.text.split(/[ 　]+/).length === parentText.length;
  const scale = (Number.isFinite(entry.scale) && entry.scale > 0) ? entry.scale : 50;
  // 【v1.29.x UI-coord】絶対 char start = 行頭 + 行内 offset。
  // wrap に `data-ruby-start` を付与しておくと、後段の measureRubyOffsets が
  // この wrap がどの charRubies エントリに対応するか特定でき、ルビ実描画位置を
  // PSD 座標に換算して state に保存できる。
  const absRubyStart = lineStartIdx + parentLocalStart;

  // 1 ペア（親 1 セグメント + ルビ 1 個）を ruby-wrap span として生成。
  const makePair = (segText, segLocalStart, rubyText, absStartForThisPair) => {
    const wrap = document.createElement("span");
    wrap.className = "ruby-wrap";
    wrap.style.setProperty("--ruby-scale", `${scale / 100}em`);
    wrap.dataset.rubyStart = String(absStartForThisPair);
    const base = document.createElement("span");
    base.className = "ruby-base";
    appendStyledSegment(base, segText,
      segLocalStart, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts,
      hasCharSizes, hasCharFonts, symbolFontPS, charBolds, hasCharBolds, punctTsumeMag);
    wrap.appendChild(base);
    const rt = document.createElement("span");
    rt.className = "ruby-text";
    rt.textContent = rubyText;
    wrap.appendChild(rt);
    return wrap;
  };

  if (isMono) {
    // モノルビ: 各文字ごとに wrap を分けるが、すべて同じ entry に属するため
    // data-ruby-start には常に entry の絶対 start を入れる。これにより後段の
    // measure 処理が「最初の wrap だけ測る」or「全 wrap をまとめて測る」を選べる。
    const parts = entry.text.split(/[ 　]+/);
    for (let i = 0; i < parentText.length; i++) {
      parentEl.appendChild(makePair(parentText[i], parentLocalStart + i, parts[i], absRubyStart));
    }
  } else {
    parentEl.appendChild(makePair(parentText, parentLocalStart, entry.text, absRubyStart));
  }
}

// 【v1.16.0】tcy 外セグメントを per-char signature (size, tracking, font) 統合で append。
// segStartInLine: このセグメントが line のどの位置から始まるか（trackings 配列の index 算出用）
// lineStartIdx: line が full contents のどの位置から始まるか（charSizes / charFonts の絶対 index 算出用）
// 【v1.x.0】punctTsumeMag (0..1) で 、/。の直後を縮める。例: 0.5 で letter-spacing -0.5em。
//   tracking (連続記号ツメ) と同じく letter-spacing で表現するが、対象文字が重複しないため
//   両者の値を合算して 1 つの letterSpacing にセットする。
function appendStyledSegment(parentEl, segText, segStartInLine, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts, hasCharSizes, hasCharFonts, symbolFontPS, charBolds, hasCharBolds, punctTsumeMag) {
  if (!segText.length) return;
  // 【v1.22.0】per-char font 解決: ユーザー手動指定 (charFonts[idx]) があれば最優先、
  // 無ければ symbol char に対しては symbolFontPS で自動置換、それでも無ければ undefined（layer 既定）。
  const symbolReplaceActive = typeof symbolFontPS === "string" && symbolFontPS.length > 0;
  const tsumeActive = Number.isFinite(punctTsumeMag) && punctTsumeMag > 0;
  function effectiveFontAt(absIdx, ch) {
    const explicit = hasCharFonts ? charFonts[absIdx] : undefined;
    if (typeof explicit === "string" && explicit.length > 0) return explicit;
    if (symbolReplaceActive && SYMBOL_CHAR_CODES.has(ch.charCodeAt(0))) return symbolFontPS;
    return undefined;
  }
  // 各 char の tsume em 値（負の letter-spacing として後で足す）。句読点で 0 < tsume <= 1。
  function tsumeAt(ch) {
    return tsumeActive && PUNCT_TSUME_CHAR_CODES.has(ch.charCodeAt(0)) ? punctTsumeMag : 0;
  }
  let i = 0;
  while (i < segText.length) {
    const absIdx = lineStartIdx + segStartInLine + i;
    const sigSize = hasCharSizes ? charSizes[absIdx] : undefined;
    const sigTrack = trackings[segStartInLine + i];
    const sigFont = effectiveFontAt(absIdx, segText[i]);
    // 【v1.22.0】per-char 合成太字 (charBolds[absIdx])。boolean があれば signature に含める。
    const sigBold = hasCharBolds ? charBolds[absIdx] : undefined;
    // 【v1.x.0】句読点ツメ（、 / 。）。signature に含めて連続する 、、 を 1 span にまとめる。
    const sigTsume = tsumeAt(segText[i]);
    let j = i + 1;
    while (j < segText.length) {
      const absJ = lineStartIdx + segStartInLine + j;
      const s = hasCharSizes ? charSizes[absJ] : undefined;
      const t = trackings[segStartInLine + j];
      const f = effectiveFontAt(absJ, segText[j]);
      const b = hasCharBolds ? charBolds[absJ] : undefined;
      const tu = tsumeAt(segText[j]);
      if (s !== sigSize || t !== sigTrack || f !== sigFont || b !== sigBold || tu !== sigTsume) break;
      j++;
    }
    const text = segText.slice(i, j);
    // 句読点ツメと連続記号ツメは重複対象文字無し（、。 vs ー―〜 等）なので合算で問題ない。
    const effectiveLetterSpacingEm = sigTrack + (sigTsume > 0 ? -sigTsume : 0);
    const needsSpan = Number.isFinite(sigSize) || effectiveLetterSpacingEm !== 0
      || (typeof sigFont === "string" && sigFont.length > 0)
      || typeof sigBold === "boolean";
    if (needsSpan) {
      const span = document.createElement("span");
      if (Number.isFinite(sigSize) && Number.isFinite(defaultSizePt) && defaultSizePt > 0) {
        // sigSize は pt 単位。inner の font-size は layer default を screen px で持つので
        // (sigSize / defaultSizePt) em 表記で相対指定する。
        span.style.fontSize = `${sigSize / defaultSizePt}em`;
      }
      if (effectiveLetterSpacingEm !== 0) {
        span.style.letterSpacing = `${effectiveLetterSpacingEm}em`;
      }
      if (typeof sigFont === "string" && sigFont.length > 0) {
        // PostScript 名から family-name 解決 → font-family を上書き。
        const fam = cssFontFamily(sigFont);
        if (fam) span.style.fontFamily = fam;
        ensureFontLoaded(sigFont);
      }
      if (typeof sigBold === "boolean") {
        // per-char 合成太字。layer 全体の inner.style.fontWeight より span が優先（CSS specificity）。
        span.style.fontWeight = sigBold ? "700" : "400";
      }
      span.textContent = text;
      parentEl.appendChild(span);
    } else {
      parentEl.appendChild(document.createTextNode(text));
    }
    i = j;
  }
}

// 【v1.16.0】行間/サイズ/フォントの per-line・per-char 描画統合。
// inner にテキストを描画する。
// - lineLeadings に override があれば 1 行ずつ <div> に分けて margin-block-start で per-line の
//   行間を表現する（行 N の値 = 行 N-1 と行 N の間隔のみ。CSS line-height ではなく
//   margin-block-start を使うことで「行自身のサイズや次の行との間隔は不変」を実現）。
// - charSizes / charFonts に override があれば各行内で文字ごとに span を作って per-char の
//   サイズ / フォントを反映する。
// - dashMille / tildeMille は連続記号のツメ（letter-spacing）を制御する。
// - tcyOn が ON かつ縦書きで !! / !? が含まれる場合は <span class="tcy-span"> でラップ。
// それ以外は単一テキストノードで描画（最軽量）。
// isVertical: true なら writing-mode: vertical-rl 想定で per-line の幅 (列幅) を切替える。
// defaultSizePt: layer 全体の sizePt（charSizes の em 換算に使う）。
function renderInnerText(inner, text, defaultLeadingPct, lineLeadings, dashMille, tildeMille, tcyOn, isVertical, charSizes, defaultSizePt, charFonts, symbolFontPS, charBolds, punctTsumePct, charRubies) {
  inner.textContent = "";
  const overrides = lineLeadings && Object.keys(lineLeadings).length > 0 ? lineLeadings : null;
  const hasCharSizes = charSizes && Object.keys(charSizes).length > 0;
  const hasCharFonts = charFonts && Object.keys(charFonts).length > 0;
  const hasCharBolds = charBolds && Object.keys(charBolds).length > 0;
  // 【v1.26.0】ruby 範囲 array に変換しておくと、appendLineWithTracking で line ごとに filter しやすい。
  const hasCharRubies = charRubies && Object.keys(charRubies).length > 0;
  // 【v1.26.0】親文字の `overflow: hidden`（new-layer-text / existing-layer-text 既定）が <ruby> の
  // <rt> 部分を切り取ってしまうため、ruby ある時は `.has-ruby` クラスを付けて overflow: visible に。
  inner.classList.toggle("has-ruby", hasCharRubies);
  const fallback = String((defaultLeadingPct ?? 125) / 100);
  const dashTrack = Number.isFinite(Number(dashMille)) ? Number(dashMille) : 0;
  const tildeTrack = Number.isFinite(Number(tildeMille)) ? Number(tildeMille) : 0;
  const fullText = String(text ?? "");
  const trackingHits = (dashTrack !== 0 || tildeTrack !== 0) && REPEATED_TARGET_REGEX.test(fullText);
  const tcyHits = !!tcyOn && TCY_PAIR_REGEX.test(fullText);
  // 【v1.22.0】記号フォント置換: symbolFontPS が指定されており、対象記号が contents に含まれるとき適用。
  const symbolHits = (typeof symbolFontPS === "string" && symbolFontPS.length > 0) && lineHasSymbolChar(fullText);
  // 【v1.x.0】句読点ツメ（、 / 。 を tsume% で詰める）。punctTsumePct (0..100) → em 量に換算。
  const punctTsumeMag = Number.isFinite(punctTsumePct) && punctTsumePct > 0 ? punctTsumePct / 100 : 0;
  const punctHits = punctTsumeMag > 0 && lineHasPunctTsumeChar(fullText);
  // 高速パス：何も装飾なし（charBolds / 句読点ツメ / charRubies も含めて全部空のときだけ通る）
  if (!overrides && !trackingHits && !tcyHits && !hasCharSizes && !hasCharFonts && !symbolHits && !hasCharBolds && !punctHits && !hasCharRubies) {
    inner.textContent = fullText;
    inner.style.lineHeight = fallback;
    return;
  }
  const lines = fullText.split(/\r?\n/);
  const lineStarts = getLineStartOffsets(fullText);
  inner.style.lineHeight = fallback;
  if (overrides || hasCharRubies) {
    const layerFactor = (defaultLeadingPct ?? 125) / 100;
    for (let i = 0; i < lines.length; i++) {
      const lineEl = document.createElement("div");
      // この行の最大文字サイズ ratio（per-char override 反映）。layer サイズを 1 とした倍率。
      let lineMaxRatio = 1;
      if (hasCharSizes && Number.isFinite(defaultSizePt) && defaultSizePt > 0) {
        const startIdx = lineStarts[i] ?? 0;
        for (let k = 0; k < lines[i].length; k++) {
          const cs = charSizes[startIdx + k];
          if (Number.isFinite(cs) && cs > 0) {
            const ratio = cs / defaultSizePt;
            if (ratio > lineMaxRatio) lineMaxRatio = ratio;
          }
        }
      }
      const effectiveLineSize = layerFactor * lineMaxRatio;
      lineEl.style.lineHeight = String(effectiveLineSize);
      lineEl.style.display = "block";
      lineEl.style.boxSizing = "border-box";
      if (isVertical) {
        lineEl.style.width = `${effectiveLineSize}em`;
      } else {
        lineEl.style.minHeight = `${effectiveLineSize}em`;
      }
      // 行 i の override 値 = 行 i-1 と 行 i の隙間のみ（margin-block-start で表現）。
      // layer 全体の leadingFactor との差分だけを margin に追加する。
      // 行 0 は「前の行」が無いので override を無視。
      if (i > 0 && Number.isFinite(overrides[i])) {
        const overrideFactor = overrides[i] / 100;
        const extra = overrideFactor - layerFactor;
        if (Math.abs(extra) > 0.001) {
          lineEl.style.marginBlockStart = `${extra}em`;
        }
      }
      appendLineWithTracking(lineEl, lines[i], lineStarts[i], dashTrack, tildeTrack, tcyOn, charSizes, defaultSizePt, charFonts, symbolFontPS, charBolds, punctTsumeMag, charRubies);
      inner.appendChild(lineEl);
    }
  } else {
    // 【v1.21.0】<br> ではなく \n text node でセパレートする。WebView2 (Chromium) の
    // writing-mode: vertical-rl + text-orientation: mixed で <br> の column break が
    // 期待通り発火しないケース（行が前の column に続いてしまう）があるため、
    // white-space: pre-wrap が必ず尊重する \n text node に統一する。
    // 【v1.27.0】charRubies 引数の渡し忘れバグ修正: 旧コードはこの経路で第 13 引数を
    // 省略していたため、per-line leadingPct override 無しのレイヤー（大多数）で finalize
    // 後の rebuild 時にルビが描画されない不具合があった。上の overrides 経路と同じく
    // charRubies を渡すように修正。
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) inner.appendChild(document.createTextNode("\n"));
      appendLineWithTracking(inner, lines[i], lineStarts[i], dashTrack, tildeTrack, tcyOn, charSizes, defaultSizePt, charFonts, symbolFontPS, charBolds, punctTsumeMag, charRubies);
    }
  }
}

function createSizeBadge(sizePt, page, fontPostScriptName) {
  // 環境設定（デフォルトタブ）でフォント名・文字サイズの表示/非表示を一括切替。
  // OFF の場合はバッジ自体を生成せず null を返し、呼び出し側で append をスキップする。
  if (getDefault("showBadge") === false) return null;

  const el = document.createElement("div");
  el.className = "layer-size-badge";
  // 基準PSD 比で換算した pt を表示。基準が 1 ページ目（または未読込）の場合は素のまま。
  const display = toDisplaySizePt(sizePt ?? 0, page);
  const rounded = Math.round((display ?? 0) * 10) / 10;
  const fontName = fontPostScriptName ? (getFontDisplayName(fontPostScriptName) ?? fontPostScriptName) : "";
  // フォント名と文字サイズを 2 行に分けて表示（フォント上 / サイズ下）。
  if (fontName) {
    const fontEl = document.createElement("div");
    fontEl.className = "layer-size-badge-font";
    fontEl.textContent = fontName;
    el.appendChild(fontEl);
  }
  const sizeEl = document.createElement("div");
  sizeEl.className = "layer-size-badge-size";
  sizeEl.textContent = `${rounded}pt`;
  el.appendChild(sizeEl);
  return el;
}

function createRotateHandle(ctx, layerId) {
  const el = document.createElement("div");
  el.className = "layer-rotate-handle";
  el.title = "ドラッグで回転（Shift で 15° スナップ）";
  el.addEventListener("mousedown", (e) => beginRotateDrag(e, ctx, layerId));
  return el;
}

function getLayerRotation(ctx, layerId) {
  if (typeof layerId === "string") {
    const nl = getNewLayersForPsd(ctx.page.path).find((l) => l.tempId === layerId);
    return nl?.rotation ?? 0;
  }
  const edit = getEdit(ctx.page.path, layerId) ?? {};
  return edit.rotation ?? 0;
}

function setLayerRotation(ctx, layerId, deg) {
  const normalized = ((deg + 180) % 360 + 360) % 360 - 180;
  if (typeof layerId === "string") {
    updateNewLayer(layerId, { rotation: normalized });
  } else {
    setEdit(ctx.page.path, layerId, { rotation: normalized });
  }
}

function beginRotateDrag(e, ctx, layerId) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const box = e.currentTarget.parentElement;
  if (!box) return;
  // CSS rotate は要素中心を保つ（変換中心は中心）。getBoundingClientRect は
  // 回転後の AABB を返すが、その中心は回転中心と一致する（rect 中心 = 元の中心）。
  const rect = box.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const startRotation = getLayerRotation(ctx, layerId);
  const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;

  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "grabbing";

  // 【v1.21.0】回転中の度数表示インジケータ。マウスカーソルの近くにフロート表示し、
  // ドラッグ中の現在角度（normalized: -180..180）を更新。Shift スナップ中は 15° 単位。
  const indicator = document.createElement("div");
  indicator.className = "rotate-degree-indicator";
  document.body.appendChild(indicator);
  const formatDeg = (deg) => {
    const normalized = ((deg + 180) % 360 + 360) % 360 - 180;
    return `${Math.round(normalized)}°`;
  };
  const updateIndicator = (deg, mouseX, mouseY) => {
    indicator.textContent = formatDeg(deg);
    // マウスカーソルの右下 16px オフセットに表示。画面端でクリッピングしないよう
    // 右端 / 下端近くは左側 / 上側に切替。
    const padding = 16;
    const rect = indicator.getBoundingClientRect();
    const w = rect.width || 60;
    const h = rect.height || 24;
    let x = mouseX + padding;
    let y = mouseY + padding;
    if (x + w > window.innerWidth) x = mouseX - w - padding;
    if (y + h > window.innerHeight) y = mouseY - h - padding;
    indicator.style.left = `${x}px`;
    indicator.style.top = `${y}px`;
  };
  updateIndicator(startRotation, e.clientX, e.clientY);

  let moved = false;
  beginHistoryTransient();
  const onMove = (ev) => {
    ev.preventDefault();
    const a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
    let next = startRotation + (a - startAngle);
    if (ev.shiftKey) next = Math.round(next / 15) * 15;
    if (next !== startRotation) moved = true;
    setLayerRotation(ctx, layerId, next);
    refreshAllOverlays();
    updateIndicator(next, ev.clientX, ev.clientY);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
    indicator.remove();
    if (moved) commitHistoryTransient(); else abortHistoryTransient();
    rebuildLayerList();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function createBox(page, left, top, width, height, kind) {
  const el = document.createElement("div");
  el.className = `layer-box layer-box-${kind}`;
  el.style.left = `${(left / page.width) * 100}%`;
  el.style.top = `${(top / page.height) * 100}%`;
  el.style.width = `${(width / page.width) * 100}%`;
  el.style.height = `${(height / page.height) * 100}%`;
  return el;
}

// スクリーン空間の delta (dxS, dyS) を回転逆変換して「回転前のローカル空間」の delta に変換。
// rotation は CSS の rotate() 方向（時計回り正）。CSS 座標は y 下向きのため、90° 回転で
// ローカル (+x) は画面 (+y) に、ローカル (+y) は画面 (-x) に対応する。
function inverseRotateDelta(dxS, dyS, rotation) {
  switch (rotation) {
    case 90:  return { dx:  dyS, dy: -dxS };
    case 180: return { dx: -dxS, dy: -dyS };
    case 270: return { dx: -dyS, dy:  dxS };
    default:  return { dx:  dxS, dy:  dyS };
  }
}

function canvasCoordsFromEvent(e, ctx) {
  const rect = ctx.canvas.getBoundingClientRect();
  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  // getBoundingClientRect は回転後の視覚 bbox を返すため、90/270 では W/H をスワップ。
  const W = rotated90 ? rect.height : rect.width;
  const H = rotated90 ? rect.width : rect.height;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const { dx: dxL, dy: dyL } = inverseRotateDelta(e.clientX - cx, e.clientY - cy, rotation);
  const scaleX = ctx.page.width / W;
  const scaleY = ctx.page.height / H;
  return {
    x: (W / 2 + dxL) * scaleX,
    y: (H / 2 + dyL) * scaleY,
    scaleX,
    scaleY,
  };
}

function onCanvasMouseDown(e, ctx) {
  const tool = getTool();
  if (tool === "pan") {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // スクロールは #psd-stage に閉じている（ペイン本体は overflow:hidden で回転ボタンを固定）。
    const scroller = ctx.canvas.closest(".psd-stage");
    if (!scroller) return;
    panState = {
      canvas: ctx.canvas,
      scroller,
      startX: e.clientX,
      startY: e.clientY,
      scrollStart: { left: scroller.scrollLeft, top: scroller.scrollTop },
      prevUserSelect: document.body.style.userSelect,
    };
    document.body.style.userSelect = "none";
    ctx.canvas.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0) return;
  if (tool === "move") {
    // 1) アクティブな contenteditable 編集中レイヤーがあれば、外側クリックなら finalize。
    //    内側 (.editing 内) のクリックは contenteditable の caret 移動に委ねる
    //    （preventDefault しない／finalize しない）。
    const openEdit = document.querySelector(".layer-box.editing");
    if (openEdit) {
      // クリック対象が編集中レイヤー自身またはその子孫なら caret 移動に委ねる。
      if (openEdit === e.target || openEdit.contains(e.target)) return;
      // 外側クリック → 編集確定
      e.preventDefault();
      if (typeof openEdit.__finalize === "function") openEdit.__finalize(true);
      else openEdit.classList.remove("editing");
      return;
    }
    e.preventDefault();
    // 2) 原稿テキストブロック選択中のクリック配置は廃止。空所への 350ms 以内の
    //    2 回目クリック → 新規テキスト入力欄を開く。
    const { x, y } = canvasCoordsFromEvent(e, ctx);
    const now = Date.now();
    if (isCanvasDoubleClick(now, x, y)) {
      lastCanvasClickAt = 0; // 連続トリガを抑止（次の click は単独扱い）
      startTextInput(ctx, x, y, getNewTextDirection());
      return;
    }
    // 3) シングルクリック: 次回 dblclick 検出のため記録 + マーキー開始。
    lastCanvasClickAt = now;
    lastCanvasClickPos = { x, y };
    startMarquee(e, ctx);
  }
}

// canvas 上の同位置への 350ms 以内 + 5px 以内の 2 回目クリックを double-click と判定。
// 既存 `isLayerDoubleClick` の方針を踏襲し、レイヤー外（空所）専用に独立して持つ。
let lastCanvasClickAt = 0;
let lastCanvasClickPos = { x: 0, y: 0 };
function isCanvasDoubleClick(now, x, y) {
  if (lastCanvasClickAt === 0) return false;
  if (now - lastCanvasClickAt > 350) return false;
  const dx = x - lastCanvasClickPos.x;
  const dy = y - lastCanvasClickPos.y;
  if (dx * dx + dy * dy > 25) return false; // 5px^2
  return true;
}

function onCanvasMouseMove(e, ctx) {
  if (!panState) return;
  e.preventDefault();
  e.stopPropagation();
  const scroller = panState.scroller;
  if (!scroller) return;
  const dx = e.clientX - panState.startX;
  const dy = e.clientY - panState.startY;
  scroller.scrollLeft = panState.scrollStart.left - dx;
  scroller.scrollTop = panState.scrollStart.top - dy;
}

function onCanvasMouseUp(e, ctx) {
  if (!panState) return;
  e.preventDefault();
  e.stopPropagation();
  endPan();
}

function endPan() {
  if (!panState) return;
  const { canvas, prevUserSelect } = panState;
  document.body.style.userSelect = prevUserSelect;
  if (getTool() === "pan") canvas.style.cursor = "grab";
  panState = null;
}

// クリック位置がレイヤー矩形の中央になるよう top-left をオフセットする。
export function centerTopLeft(page, { contents, sizePt, direction, leadingPct }, clickX, clickY) {
  const r = layerRectForNew(page, { x: 0, y: 0, contents, sizePt, direction, leadingPct });
  return { x: clickX - r.width / 2, y: clickY - r.height / 2 };
}

function onLayerWheel(e, ctx, layerId) {
  // Alt+wheel はズーム、Ctrl/Meta+wheel はブラウザ既定（ページズーム等）に委ねる。
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const tool = getTool();
  if (tool !== "move") return;
  if (!isLayerSelected(ctx.pageIndex, layerId)) return;
  e.preventDefault();
  e.stopPropagation();
  // 環境設定の「文字サイズの刻み」（0.1 / 0.5）を baseStep に、Shift で 10 倍。
  // off-grid な値（例：0.5 刻み設定で 12.3）は最寄りグリッドにスナップする。
  const baseStep = Number(getDefault("textSizeStep")) === 0.5 ? 0.5 : 0.1;
  const sign = e.deltaY < 0 ? +1 : -1;
  const multiplier = e.shiftKey ? 10 : 1;
  resizeSelectedLayers(baseStep, sign, multiplier);
}

// edit-font 欄 / スタイルパレットでユーザーがフォントを選んだ後（fontPickerStuck === true）、
// move ツールでの単独クリック・shift クリック・マーキー選択や、サイド「レイヤー」一覧での
// 行クリック等、選択集合が確定した直後に呼ぶ。現在の選択リスト全体に currentFont を一括適用し、
// 1 件以上書き込まれたら true。false（apply しなかった）の場合、呼び出し側が
// rebuildLayerList / overlay 更新を行うこと。
export function maybeApplyStickyFont() {
  if (!getFontPickerStuck()) return false;
  const ps = getCurrentFont();
  if (!ps) return false;
  return commitFontToSelections(ps);
}

// 直近 mousedown のタイムスタンプとレイヤーキーで「同じレイヤーへの 2 連クリック」を検出する。
// 1 回目の mousedown で renderOverlay が走り box DOM が差し替わるため、ブラウザ既定の dblclick
// は発火しない（mousedown と mouseup のターゲットが食い違って click 自体が出ない）。タイミング
// での自前検出に切替える。
const DBLCLICK_THRESHOLD_MS = 350;
let lastLayerClickAt = 0;
let lastLayerClickKey = null;

function isLayerDoubleClick(pageIndex, layerKey) {
  const now = performance.now();
  const composite = `${pageIndex}::${layerKey}`;
  const isDouble = (now - lastLayerClickAt) < DBLCLICK_THRESHOLD_MS && lastLayerClickKey === composite;
  lastLayerClickAt = now;
  lastLayerClickKey = composite;
  return isDouble;
}

// V（選択）ツール選択中にテキストフレームをダブルクリックすると、in-place 編集を開始する。
// T/Y ツールが廃止され V に統合された後は、ツール切替は不要（V に居続ける）。
// direction は対象レイヤー自身の direction に従って floater の見え方が決まる。
function enterInPlaceEditFromMove(ctx, target) {
  const layerKey = target.kind === "existing" ? target.layer.id : target.nl.tempId;
  setSelectedLayer(ctx.pageIndex, layerKey);
  renderOverlay(ctx);
  rebuildLayerList();
  startInPlaceEdit(ctx, target);
}

function onExistingLayerMouseDown(e, ctx, layer) {
  const tool = getTool();
  if (tool !== "move") return;
  // 【v1.21.0】編集中レイヤー (.editing) のクリックは contenteditable のキャレット移動に
  // 委ねる。preventDefault しないことで「全選択中に文字の途中をクリック → キャレット移動」
  // という Photoshop / 通常 textarea と同じ挙動を取り戻す。
  if (e.currentTarget && e.currentTarget.classList.contains("editing")) return;
  e.stopPropagation();
  e.preventDefault();
  if (isLayerDoubleClick(ctx.pageIndex, layer.id)) {
    enterInPlaceEditFromMove(ctx, { kind: "existing", layer });
    return;
  }
  if (e.shiftKey) {
    toggleLayerSelected(ctx.pageIndex, layer.id);
    renderOverlay(ctx);
    rebuildLayerList();
    return;
  }
  if (!isLayerSelected(ctx.pageIndex, layer.id)) {
    setSelectedLayer(ctx.pageIndex, layer.id);
    renderOverlay(ctx);
    if (!maybeApplyStickyFont()) rebuildLayerList();
  }
  beginMultiLayerDrag(e, ctx);
}

function onNewLayerMouseDown(e, ctx, nl) {
  const tool = getTool();
  if (tool !== "move") return;
  // 編集中レイヤーのクリックは contenteditable に委ねる（上記 onExistingLayerMouseDown と同パターン）。
  if (e.currentTarget && e.currentTarget.classList.contains("editing")) return;
  e.stopPropagation();
  e.preventDefault();
  if (isLayerDoubleClick(ctx.pageIndex, nl.tempId)) {
    enterInPlaceEditFromMove(ctx, { kind: "new", nl });
    return;
  }
  if (e.shiftKey) {
    toggleLayerSelected(ctx.pageIndex, nl.tempId);
    renderOverlay(ctx);
    rebuildLayerList();
    return;
  }
  if (!isLayerSelected(ctx.pageIndex, nl.tempId)) {
    setSelectedLayer(ctx.pageIndex, nl.tempId);
    renderOverlay(ctx);
    if (!maybeApplyStickyFont()) rebuildLayerList();
  }
  beginMultiLayerDrag(e, ctx);
}

function beginMultiLayerDrag(e, ctx) {
  const selections = getSelectedLayers().filter((s) => s.pageIndex === ctx.pageIndex);
  if (selections.length === 0) return;

  // Photoshop と同じ Alt+ドラッグ複製。ドラッグ開始時に各選択レイヤーの複製を
  // 同位置に作成し、items をその複製（kind:"new"）に差し替えて以降のプレビュー
  // と確定処理に乗せる。元レイヤーはそのまま残る。
  const isDuplicate = !!e.altKey;

  const items = [];
  if (isDuplicate) {
    beginHistoryTransient();
    const newSelections = [];
    for (const sel of selections) {
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(ctx.page.path).find((l) => l.tempId === sel.layerId);
        if (!nl) continue;
        const dup = addNewLayer({
          psdPath: nl.psdPath,
          x: nl.x,
          y: nl.y,
          contents: nl.contents,
          fontPostScriptName: nl.fontPostScriptName,
          sizePt: nl.sizePt,
          direction: nl.direction,
          strokeColor: nl.strokeColor,
          strokeWidthPx: nl.strokeWidthPx,
          fillColor: nl.fillColor,
          rotation: nl.rotation ?? 0,
          leadingPct: nl.leadingPct,
        });
        if (nl.lineLeadings && Object.keys(nl.lineLeadings).length > 0) {
          updateNewLayer(dup.tempId, { lineLeadings: { ...nl.lineLeadings } });
        }
        items.push({ kind: "new", nl: dup, startX: dup.x, startY: dup.y, rotation: dup.rotation ?? 0 });
        newSelections.push({ pageIndex: ctx.pageIndex, layerId: dup.tempId });
      } else {
        const layer = ctx.page.textLayers.find((l) => l.id === sel.layerId);
        if (!layer) continue;
        const edit = getEdit(ctx.page.path, sel.layerId) ?? {};
        const dupX = (layer.left ?? 0) + (edit.dx ?? 0);
        const dupY = (layer.top ?? 0) + (edit.dy ?? 0);
        const dup = addNewLayer({
          psdPath: ctx.page.path,
          x: dupX,
          y: dupY,
          contents: edit.contents ?? layer.text ?? "",
          fontPostScriptName: edit.fontPostScriptName ?? layer.font ?? null,
          sizePt: edit.sizePt ?? layer.fontSize ?? null,
          direction: edit.direction ?? layer.direction ?? "horizontal",
          strokeColor: edit.strokeColor ?? layer.strokeColor ?? "none",
          strokeWidthPx: edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20,
          fillColor: edit.fillColor ?? layer.fillColor ?? "default",
          rotation: edit.rotation ?? 0,
          leadingPct: edit.leadingPct ?? 125,
        });
        if (edit.lineLeadings && Object.keys(edit.lineLeadings).length > 0) {
          updateNewLayer(dup.tempId, { lineLeadings: { ...edit.lineLeadings } });
        }
        items.push({ kind: "new", nl: dup, startX: dup.x, startY: dup.y, rotation: dup.rotation ?? 0 });
        newSelections.push({ pageIndex: ctx.pageIndex, layerId: dup.tempId });
      }
    }
    if (items.length === 0) {
      abortHistoryTransient();
      return;
    }
    setSelectedLayers(newSelections);
    renderOverlay(ctx);
    rebuildLayerList();
  } else {
    for (const sel of selections) {
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(ctx.page.path).find((l) => l.tempId === sel.layerId);
        if (nl) items.push({ kind: "new", nl, startX: nl.x, startY: nl.y, rotation: nl.rotation ?? 0 });
      } else {
        const layer = ctx.page.textLayers.find((l) => l.id === sel.layerId);
        if (layer) {
          const edit = getEdit(ctx.page.path, sel.layerId) ?? {};
          items.push({ kind: "existing", layer, rotation: edit.rotation ?? 0 });
        }
      }
    }
    if (items.length === 0) return;
  }

  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const rect = ctx.canvas.getBoundingClientRect();
  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  // 回転前の canvas CSS 寸法。
  const W = rotated90 ? rect.height : rect.width;
  const H = rotated90 ? rect.width : rect.height;
  const scaleX = ctx.page.width / W;
  const scaleY = ctx.page.height / H;
  const pxScaleX = W / ctx.page.width;
  const pxScaleY = H / ctx.page.height;
  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;
  document.body.style.userSelect = "none";
  if (isDuplicate) document.body.style.cursor = "copy";

  // swap モード判定用：単一選択 + Alt 複製でないときのみ swap 可能。
  const isSingleMoveDrag = !isDuplicate && items.length === 1;
  const dragged = isSingleMoveDrag ? items[0] : null;
  // ドラッグ開始時点の被ドラッグレイヤーの絶対 PSD rect（aStart）。
  // 既存レイヤーの edit.dx/dy は開始時の値で固定される（layerRectForExisting が反映済み）。
  const aStartRect = dragged
    ? (dragged.kind === "existing"
      ? layerRectForExisting(ctx.page, dragged.layer, getEdit(ctx.page.path, dragged.layer.id) ?? {})
      : layerRectForNew(ctx.page, dragged.nl))
    : null;
  const draggedKey = dragged
    ? (dragged.kind === "existing"
      ? { kind: "existing", id: dragged.layer.id }
      : { kind: "new", id: dragged.nl.tempId })
    : null;
  let lastSwapTarget = null;
  let swapGhostEl = null;
  const swapTargetKey = (t) => (
    t ? `${t.kind}:${t.kind === "existing" ? t.layer.id : t.nl.tempId}` : null
  );

  // 入れ替え対象 B が存在するときの視覚フィードバックを適用/解除。
  //   - 既存の `.swap-target` リング（緑）を B 側に付ける
  //   - A の元位置中心 + B のサイズで点線 ghost を表示（B の入れ替え後 着地位置）
  const applySwapVisuals = (target) => {
    setSwapTargetHighlight(ctx, target);
    if (target) {
      const bRect = target.kind === "existing"
        ? layerRectForExisting(ctx.page, target.layer, getEdit(ctx.page.path, target.layer.id) ?? {})
        : layerRectForNew(ctx.page, target.nl);
      const aCenterX = aStartRect.left + aStartRect.width / 2;
      const aCenterY = aStartRect.top + aStartRect.height / 2;
      const ghostLeft = aCenterX - bRect.width / 2;
      const ghostTop = aCenterY - bRect.height / 2;
      if (!swapGhostEl) {
        swapGhostEl = document.createElement("div");
        swapGhostEl.className = "swap-ghost";
        ctx.overlay.appendChild(swapGhostEl);
      }
      swapGhostEl.style.left = `${(ghostLeft / ctx.page.width) * 100}%`;
      swapGhostEl.style.top = `${(ghostTop / ctx.page.height) * 100}%`;
      swapGhostEl.style.width = `${(bRect.width / ctx.page.width) * 100}%`;
      swapGhostEl.style.height = `${(bRect.height / ctx.page.height) * 100}%`;
    } else if (swapGhostEl) {
      swapGhostEl.remove();
      swapGhostEl = null;
    }
  };

  const computePsdDelta = (ev) => {
    const { dx, dy } = inverseRotateDelta(
      ev.clientX - startClientX,
      ev.clientY - startClientY,
      rotation,
    );
    return { ddx: dx * scaleX, ddy: dy * scaleY };
  };

  const suppressDefault = (ev) => ev.preventDefault();
  // overlay 自体が回転済みのため、translate() は PSD 空間（= 回転前ローカル）ピクセル量で与える。
  const applyPreview = (ddx, ddy) => {
    for (const item of items) {
      if (item.kind === "existing") {
        const boxEl = ctx.overlay.querySelector(`.layer-box-existing[data-layer-id="${item.layer.id}"]`);
        if (boxEl) {
          const rot = item.rotation ? ` rotate(${item.rotation}deg)` : "";
          boxEl.style.transform = `translate(${ddx * pxScaleX}px, ${ddy * pxScaleY}px)${rot}`;
        }
      } else {
        const boxEl = ctx.overlay.querySelector(`.layer-box-new[data-temp-id="${item.nl.tempId}"]`);
        if (boxEl) {
          boxEl.style.left = `${((item.startX + ddx) / ctx.page.width) * 100}%`;
          boxEl.style.top = `${((item.startY + ddy) / ctx.page.height) * 100}%`;
        }
      }
    }
  };
  const onMove = (ev) => {
    ev.preventDefault();
    const { ddx, ddy } = computePsdDelta(ev);
    applyPreview(ddx, ddy);
    if (!isSingleMoveDrag) return;
    const cx = aStartRect.left + aStartRect.width / 2 + ddx;
    const cy = aStartRect.top + aStartRect.height / 2 + ddy;
    const next = findSwapTarget(ctx, draggedKey, cx, cy);
    if (swapTargetKey(next) !== swapTargetKey(lastSwapTarget)) {
      applySwapVisuals(next);
      document.body.style.cursor = next ? "alias" : prevCursor;
      lastSwapTarget = next;
    }
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("dragstart", suppressDefault, true);
    window.removeEventListener("selectstart", suppressDefault, true);
    document.body.style.userSelect = prevUserSelect;
    if (isDuplicate || lastSwapTarget) document.body.style.cursor = prevCursor;
    // swap モード中の hover ハイライト残骸を必ず掃除（refreshAllOverlays でも再構築されるが
    // 通常移動分岐では DOM が再生成されないため明示的に外す）。
    applySwapVisuals(null);
    const { ddx, ddy } = computePsdDelta(ev);
    if (isDuplicate) {
      // 複製は開始時点で beginHistoryTransient 済み。移動量があれば位置も確定し、
      // 移動量ゼロでも複製自体は残るため必ず commit して 1 つの履歴ステップにする。
      if (ddx !== 0 || ddy !== 0) {
        for (const item of items) {
          // 複製はすべて kind:"new"。
          updateNewLayer(item.nl.tempId, { x: item.startX + ddx, y: item.startY + ddy });
        }
      }
      commitHistoryTransient();
    } else if (isSingleMoveDrag && (ddx !== 0 || ddy !== 0)) {
      // mouseup 時点で再判定（mousemove 最終フレームと mouseup の差を吸収）。
      const cx = aStartRect.left + aStartRect.width / 2 + ddx;
      const cy = aStartRect.top + aStartRect.height / 2 + ddy;
      const target = findSwapTarget(ctx, draggedKey, cx, cy);
      if (target) {
        performSwap(ctx, dragged, aStartRect, target);
      } else {
        beginHistoryTransient();
        if (dragged.kind === "existing") {
          addEditOffset(ctx.page.path, dragged.layer.id, ddx, ddy);
        } else {
          updateNewLayer(dragged.nl.tempId, { x: dragged.startX + ddx, y: dragged.startY + ddy });
        }
        commitHistoryTransient();
      }
    } else if (ddx !== 0 || ddy !== 0) {
      beginHistoryTransient();
      for (const item of items) {
        if (item.kind === "existing") {
          addEditOffset(ctx.page.path, item.layer.id, ddx, ddy);
        } else {
          updateNewLayer(item.nl.tempId, { x: item.startX + ddx, y: item.startY + ddy });
        }
      }
      commitHistoryTransient();
    }
    refreshAllOverlays();
    rebuildLayerList();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("dragstart", suppressDefault, true);
  window.addEventListener("selectstart", suppressDefault, true);
}

function startMarquee(e, ctx) {
  const { x, y } = canvasCoordsFromEvent(e, ctx);
  const additive = e.shiftKey;
  const initialSelection = additive ? getSelectedLayers().slice() : [];
  if (!additive) {
    setSelectedLayers([]);
    renderOverlay(ctx);
    rebuildLayerList();
  }
  marqueeState = { ctx, startX: x, startY: y, currentX: x, currentY: y, additive, initialSelection };
  drawMarquee();

  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";

  const suppressDefault = (ev) => ev.preventDefault();
  const onMove = (ev) => {
    if (!marqueeState) return;
    ev.preventDefault();
    const pos = canvasCoordsFromEvent(ev, ctx);
    marqueeState.currentX = pos.x;
    marqueeState.currentY = pos.y;
    drawMarquee();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("dragstart", suppressDefault, true);
    window.removeEventListener("selectstart", suppressDefault, true);
    document.body.style.userSelect = prevUserSelect;
    finalizeMarquee();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("dragstart", suppressDefault, true);
  window.addEventListener("selectstart", suppressDefault, true);
}

function drawMarquee() {
  if (!marqueeState) return;
  const { ctx, startX, startY, currentX, currentY } = marqueeState;
  let el = ctx.overlay.querySelector(".marquee-rect");
  if (!el) {
    el = document.createElement("div");
    el.className = "marquee-rect";
    ctx.overlay.appendChild(el);
  }
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  const w = Math.abs(currentX - startX);
  const h = Math.abs(currentY - startY);
  el.style.left = `${(left / ctx.page.width) * 100}%`;
  el.style.top = `${(top / ctx.page.height) * 100}%`;
  el.style.width = `${(w / ctx.page.width) * 100}%`;
  el.style.height = `${(h / ctx.page.height) * 100}%`;
}

function finalizeMarquee() {
  if (!marqueeState) return;
  const { ctx, startX, startY, currentX, currentY, additive, initialSelection } = marqueeState;
  marqueeState = null;
  const existingEl = ctx.overlay.querySelector(".marquee-rect");
  if (existingEl) existingEl.remove();

  const tinyClick = Math.abs(currentX - startX) < 2 && Math.abs(currentY - startY) < 2;
  if (tinyClick) {
    if (!additive) {
      setSelectedLayers([]);
      renderOverlay(ctx);
      rebuildLayerList();
    }
    return;
  }

  const selRect = {
    left: Math.min(startX, currentX),
    top: Math.min(startY, currentY),
    right: Math.max(startX, currentX),
    bottom: Math.max(startY, currentY),
  };
  const hits = collectLayerHits(ctx, selRect);
  let final;
  if (additive) {
    final = initialSelection.slice();
    for (const h of hits) {
      if (!final.some((s) => s.pageIndex === h.pageIndex && s.layerId === h.layerId)) {
        final.push(h);
      }
    }
  } else {
    final = hits;
  }
  setSelectedLayers(final);
  renderOverlay(ctx);
  if (!maybeApplyStickyFont()) rebuildLayerList();
}

function collectLayerHits(ctx, selRect) {
  const { page, pageIndex } = ctx;
  const hits = [];
  for (const layer of page.textLayers) {
    const edit = getEdit(page.path, layer.id) ?? {};
    const lrect = layerRectForExisting(page, layer, edit);
    if (rectsIntersect(selRect, lrect)) hits.push({ pageIndex, layerId: layer.id });
  }
  for (const nl of getNewLayersForPsd(page.path)) {
    const lrect = layerRectForNew(page, nl);
    if (rectsIntersect(selRect, lrect)) hits.push({ pageIndex, layerId: nl.tempId });
  }
  return hits;
}

// V ツールでテキストフレームを別フレームの上にドロップしたとき、両者の位置を
// 入れ替える（swap）ためのヘルパ群。単一選択ドラッグ（Alt 複製ではない）の
// ときだけ有効化される。

// ドラッグ中レイヤーの中心点 (centerXPsd, centerYPsd) を含むレイヤーを探す。
// draggedKey と一致するレイヤーは自己除外。最初のヒット 1 件を返す（既存→新規の順）。
function findSwapTarget(ctx, draggedKey, centerXPsd, centerYPsd) {
  const tinyRect = {
    left: centerXPsd - 0.5,
    top: centerYPsd - 0.5,
    right: centerXPsd + 0.5,
    bottom: centerYPsd + 0.5,
  };
  for (const layer of ctx.page.textLayers) {
    if (draggedKey.kind === "existing" && layer.id === draggedKey.id) continue;
    const edit = getEdit(ctx.page.path, layer.id) ?? {};
    const lrect = layerRectForExisting(ctx.page, layer, edit);
    if (rectsIntersect(tinyRect, lrect)) return { kind: "existing", layer };
  }
  for (const nl of getNewLayersForPsd(ctx.page.path)) {
    if (draggedKey.kind === "new" && nl.tempId === draggedKey.id) continue;
    const lrect = layerRectForNew(ctx.page, nl);
    if (rectsIntersect(tinyRect, lrect)) return { kind: "new", nl };
  }
  return null;
}

// hover 中の swap ターゲットに `.swap-target` クラスを付ける/外す。
// refreshAllOverlays は呼ばず、対象 box の DOM だけを直接触る。
function setSwapTargetHighlight(ctx, target) {
  const prev = ctx.overlay.querySelector(".layer-box.swap-target");
  if (prev) prev.classList.remove("swap-target");
  if (!target) return;
  let el = null;
  if (target.kind === "existing") {
    el = ctx.overlay.querySelector(`.layer-box-existing[data-layer-id="${target.layer.id}"]`);
  } else {
    el = ctx.overlay.querySelector(`.layer-box-new[data-temp-id="${target.nl.tempId}"]`);
  }
  if (el) el.classList.add("swap-target");
}

// 被ドラッグレイヤー A とターゲット B の位置を交換する。
// aStartRect は A のドラッグ開始時点の絶対 PSD rect、target は最新の B 情報。
// A と B でサイズ（幅・高さ）が異なる場合、左上 (left/top) ではなく
// **中心 (center)** を入れ替える。これによりサイズ差があっても各フレームが
// 元々あった位置の中央に収まる（吹き出し中央同士のスワップとして自然）。
// 既存レイヤーは差分加算 (addEditOffset)、新規レイヤーは絶対値上書き (updateNewLayer)
// を用い、begin/commitHistoryTransient で 1 history snapshot に集約する。
function performSwap(ctx, dragged, aStartRect, target) {
  const path = ctx.page.path;
  // ターゲット B の現在 rect（最新の絶対座標 + 幅高さ）を取得。
  let bRect;
  if (target.kind === "existing") {
    const bEdit = getEdit(path, target.layer.id) ?? {};
    bRect = layerRectForExisting(ctx.page, target.layer, bEdit);
  } else {
    bRect = layerRectForNew(ctx.page, target.nl);
  }
  // 中心点（A は開始時、B は現在）。
  const aCenterX = aStartRect.left + aStartRect.width / 2;
  const aCenterY = aStartRect.top + aStartRect.height / 2;
  const bCenterX = bRect.left + bRect.width / 2;
  const bCenterY = bRect.top + bRect.height / 2;
  // A の新 left/top（中心を B の中心に揃える → A 自身の半サイズを引く）。
  const aNewLeft = bCenterX - aStartRect.width / 2;
  const aNewTop = bCenterY - aStartRect.height / 2;
  // B の新 left/top（中心を A の元中心に揃える → B 自身の半サイズを引く）。
  const bNewLeft = aCenterX - bRect.width / 2;
  const bNewTop = aCenterY - bRect.height / 2;

  beginHistoryTransient();
  // A → B の中心へ
  if (dragged.kind === "existing") {
    addEditOffset(path, dragged.layer.id, aNewLeft - aStartRect.left, aNewTop - aStartRect.top);
  } else {
    updateNewLayer(dragged.nl.tempId, { x: aNewLeft, y: aNewTop });
  }
  // B → A の元中心へ
  if (target.kind === "existing") {
    addEditOffset(path, target.layer.id, bNewLeft - bRect.left, bNewTop - bRect.top);
  } else {
    updateNewLayer(target.nl.tempId, { x: bNewLeft, y: bNewTop });
  }
  commitHistoryTransient();
}

// 【v1.21.0】contenteditable ベースの in-place 編集ヘルパ。
// 旧 createTextFloater (textarea) を置換し、レイヤーの text element 自身を直接編集対象にする。
// Photoshop ポイントテキスト同様に「テキスト本体にカーソルが入って打ち換える」UX を実現。
//
// 戦略:
//   1. text element に contenteditable=true + .editing class を付ける
//   2. per-char span 構造を解除して plain text 化（IME / 削除挿入による DOM 破壊リスクを排除）
//   3. Enter は <br>/<div> 自動挿入を抑止して \n text node を手動挿入
//   4. paste は plain text 限定
//   5. input イベントで文字列差分を計算し charSizes/charFonts/lineLeadings の index を re-map
//   6. 確定時に既存の renderInnerText で per-char span を再構築
//
// target = { kind: "existing"|"new", layer? | nl? } は startInPlaceEdit と同形式。
// options:
//   selectAll: 開始時に全選択（既存編集打ち換え向け）
//   onCommit(newContents): 確定時のフック（center-fix 補正等を行う）
//   onCancel(): Esc / blur で finalize されたが commit しないときのフック（新規空レイヤー削除等）
//   afterCommit(newContents): commit 後に呼ばれる外部同期フック（原稿テキスト書換等）
function startContentEditableEdit(ctx, target, options = {}) {
  const { page } = ctx;
  const isExisting = target.kind === "existing";

  // 1. レイヤー DOM (.layer-box-existing[data-layer-id] / .layer-box-new[data-temp-id]) を解決
  const layerKey = isExisting ? String(target.layer.id) : String(target.nl.tempId);
  const escapedKey = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(layerKey) : layerKey;
  const boxSelector = isExisting
    ? `.layer-box-existing[data-layer-id="${escapedKey}"]`
    : `.layer-box-new[data-temp-id="${escapedKey}"]`;
  const box = ctx.overlay.querySelector(boxSelector);
  if (!box) return null;
  const inner = box.querySelector(".existing-layer-text, .new-layer-text");
  if (!inner) return null;

  // 2. 開始時点のスナップショット（cancel 時の復元用）
  const startEdit = isExisting ? (getEdit(page.path, target.layer.id) ?? {}) : null;
  const startContents = isExisting
    ? (startEdit.contents ?? target.layer.text ?? "")
    : (target.nl.contents ?? "");

  // 縦書きレイヤーの半角→全角自動変換 direction（edit 開始時に一度だけ確定。
  // edit 中の direction 変更は対象外）。readContents 内で maybeConvert に渡される。
  const editDirection = isExisting
    ? ((startEdit?.direction) ?? target.layer.direction ?? "horizontal")
    : (target.nl.direction ?? "vertical");
  const startLineLeadings = isExisting
    ? { ...(startEdit.lineLeadings ?? {}) }
    : { ...(target.nl.lineLeadings ?? {}) };
  const startCharSizes = isExisting
    ? { ...(startEdit.charSizes ?? {}) }
    : { ...(target.nl.charSizes ?? {}) };
  const startCharFonts = isExisting
    ? { ...(startEdit.charFonts ?? {}) }
    : { ...(target.nl.charFonts ?? {}) };
  // 位置（x,y / dx,dy）も snapshot。recenterBox が edit 中に書き換えるので、
  // cancel 時に元の位置に戻すために必要。
  const startDx = isExisting ? (startEdit.dx ?? 0) : null;
  const startDy = isExisting ? (startEdit.dy ?? 0) : null;
  const startX = isExisting ? null : (target.nl.x ?? 0);
  const startY = isExisting ? null : (target.nl.y ?? 0);

  // 3. per-char span 構造を解除し plain text 化
  if (startContents) {
    inner.textContent = startContents;
  } else {
    inner.innerHTML = "";
  }

  // 【v1.21.0】編集前の bbox 中心を握っておく。文字数変化（特に改行追加）で bbox の
  // 幅・高さが伸びると、左上 anchor 固定の box は右下方向にだけ伸びるため
  // vertical-rl では「既存テキストが右にずれた」ように見える。これを防ぐため、
  // edit 中は毎 input イベントで box の left/top/width/height を中心固定で再計算する。
  const oldRect = isExisting
    ? layerRectForExisting(page, target.layer, getEdit(page.path, target.layer.id) ?? {})
    : layerRectForNew(page, target.nl);
  const oldCenterX = oldRect.left + oldRect.width / 2;
  const oldCenterY = oldRect.top + oldRect.height / 2;

  // 4. 編集モード ON
  box.classList.add("editing");
  inner.contentEditable = "true";
  inner.spellcheck = false;

  // 【v1.21.0】edit セッション全体を 1 つの history snapshot に集約する。
  // これがないと keystroke ごとに setEdit/updateNewLayer → pushHistorySnapshot →
  // onHistoryChange リスナーが refreshAllOverlays + rebuildLayerList を発火し、
  // sidebar 再描画が頻繁に起きてキャレットが破壊される（特に縦書きで顕著）。
  beginHistoryTransient();

  // 5. フォーカス + 全選択 / 末尾カーソル
  inner.focus();
  const sel0 = window.getSelection();
  if (sel0) {
    sel0.removeAllRanges();
    const r0 = document.createRange();
    if (options.selectAll && startContents) {
      r0.selectNodeContents(inner);
    } else {
      r0.selectNodeContents(inner);
      r0.collapse(false); // 末尾
    }
    sel0.addRange(r0);
  }

  const layerMeta = isExisting
    ? { psdPath: page.path, layerId: target.layer.id }
    : { psdPath: page.path, tempId: target.nl.tempId };

  // === 内部 state ===
  let lastContents = startContents;
  let imeComposing = false;
  let finished = false;

  // 現在のレイヤー state から最新の per-char/line override を取り出す
  // 【v1.26.0】charBolds / charRubies も含めて取得 → 編集時の index shift で全て同期。
  const readCurrentMaps = () => {
    if (isExisting) {
      const e = getEdit(page.path, target.layer.id) ?? {};
      return {
        charSizes: e.charSizes ?? {},
        charFonts: e.charFonts ?? {},
        charBolds: e.charBolds ?? {},
        charRubies: e.charRubies ?? {},
        lineLeadings: e.lineLeadings ?? {},
      };
    }
    const list = getNewLayersForPsd(page.path);
    const nl = list.find((l) => l.tempId === target.nl.tempId) ?? target.nl;
    return {
      charSizes: nl.charSizes ?? {},
      charFonts: nl.charFonts ?? {},
      charBolds: nl.charBolds ?? {},
      charRubies: nl.charRubies ?? {},
      lineLeadings: nl.lineLeadings ?? {},
    };
  };

  // contenteditable 上の selection を root 内の char index range に変換。
  // selectNodeContents + setEnd の Range を作って toString().length で全長カウント。
  const getSelRange = () => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0) return null;
    const r = s.getRangeAt(0);
    if (!inner.contains(r.startContainer) && r.startContainer !== inner) return null;
    try {
      const a = document.createRange();
      a.selectNodeContents(inner);
      a.setEnd(r.startContainer, r.startOffset);
      const startIdx = a.toString().length;
      const b = document.createRange();
      b.selectNodeContents(inner);
      b.setEnd(r.endContainer, r.endOffset);
      const endIdx = b.toString().length;
      return { start: Math.min(startIdx, endIdx), end: Math.max(startIdx, endIdx) };
    } catch (e) {
      return null;
    }
  };

  // 縦書きレイヤーで半角英数字 (0-9 / A-Z / a-z) を全角に自動変換する。
  // direction === "vertical" かつ環境設定 verticalHalfToFullEnabled が true の
  // ときだけ動作（横書き / OFF は素通し）。冪等動作（全角入力は対象外）。
  // 1:1 文字対応（UTF-16 1 code unit → 1 code unit）なので contenteditable の
  // caret 位置や computeStringDiff のインデックス計算には影響しない。
  // txt-source.js の convertHalfToFullForVertical と同じロジックを inline 化
  // （canvas-tools.js → txt-source.js の import は循環参照になるため避ける）。
  // 既存テキストにある半角は触らないため、input イベントで「ユーザーが新規に
  // 打ち込んだ差分」のみ変換する設計（writeStateContents 経由）。
  const maybeConvertHalfToFull = (s) => {
    if (editDirection !== "vertical") return s;
    if (getDefault("verticalHalfToFullEnabled") === false) return s;
    return s.replace(/[0-9A-Za-z]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) + 0xFEE0),
    );
  };

  // contenteditable の現在テキスト読み取り。
  // 【設計判断】TreeWalker で text node を直接連結する方式を採用。理由:
  //   - innerText だと <br> / <div> 境界 / display:block 子要素の境界が暗黙的に
  //     "\n" として現れる。半角 "!!" 等を打ち直した際に Chromium が自動的に
  //     <div> 内に文字を wrap するケースがあり、 "!!" が "!\n!" として contents
  //     に保存されてしまい、TCY (縦中横) のペア検出が走らず縦に並ぶ事故が起きる。
  //   - 一方で Enter キー押下は keydown ハンドラ (preventDefault) で
  //     "\n" text node を直接挿入するため、TreeWalker で順次連結すれば取得できる。
  //     beforeinput の insertParagraph / insertLineBreak フォールバックも同様に
  //     "\n" text node 経路を使用。
  //   - つまり「browser 自動挿入の DOM 構造」は無視し、「明示的な \n text node」
  //     だけを拾うことで、視覚と内部状態の乖離を Enter 由来に限定できる。
  // ​ (zero-width space) は insertTextAtCursor が caret anchor として
  // 末尾に追加する不可視文字。state.contents には残さないよう strip する。
  // 注: 変換は呼び出し側で applyConversionToInner / maybeConvertHalfToFull を
  // 経由する。readContents 自身は変換せず DOM の生テキストを返す（diff 計算が
  // 一致する必要があるため）。
  const readContents = () => {
    let out = "";
    // 【v1.27.0】.ruby-text（編集中プレビューのふりがな）の text node は state.contents から除外。
    // これがないと「親（ふりがな）」のふりがな文字が contents に紛れ込み、その後の onInput で
    // 巨大な textShift 差分として誤検出 → shiftCharMap が壊れて per-char 属性が崩壊する。
    // .ruby-text は contenteditable="false" なので caret も入らない（ユーザーが触れない）。
    const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p !== inner) {
          if (p.classList && p.classList.contains("ruby-text")) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      out += node.textContent;
    }
    return out.replace(/\r\n?/g, "\n").replace(/​/g, "");
  };

  // 編集中の inner DOM を「plain text の text node 1 個」構造に正規化する。
  // 1. 縦書き + 設定 ON のとき半角英数字を全角に変換（Photoshop 縦中横自動入力風の UX）
  // 2. browser が <div> / <br> を自動挿入してしまったケースを必ず除去
  //
  // 1:1 文字対応なので既存の caret 位置（Selection の char offset）は保持される。
  // 呼び出しタイミング: input イベント / compositionend / commit。
  //
  // 設計判断（v1.24.0 後の TCY バグ修正）: 旧実装は「変換が必要なときだけ DOM を書換」
  // していたが、それだと browser 自動挿入の <div>/<br> が残ってしまう。具体的には
  // 半角 "!!" を打ち直したときに `<div>!</div><div>!</div>` 構造が作られ、commit 後の
  // renderOverlay で innerText が "!\n!" として state.contents に保存されて TCY ペア
  // 検出が走らなくなる（結果 "!" が縦に並ぶ）。これを防ぐため、変換不要時も毎 input
  // で textContent を書換えて DOM 構造を強制的にリセットする。
  const applyConversionToInner = () => {
    const raw = readContents();
    const converted = (
      editDirection === "vertical" && getDefault("verticalHalfToFullEnabled") !== false
    ) ? maybeConvertHalfToFull(raw) : raw;
    // 「全 child が text node」のときは zwsp anchor (Enter 後の caret anchor、v1.21.0
    // C4-4) を維持するため書換しない。一方 <div> / <br> 等 element node が混入して
    // いれば必ず plain text に書換える。比較は zwsp を strip した形で行う（converted
    // 側は readContents で strip 済み、inner.textContent には zwsp が残るため）。
    // 【v1.26.0】ruby-edit-pending span（applyEditModeRubyToRange が挿入）は許容
    // non-text node として扱う。これがないと ruby を振った直後に textContent 書換で
    // span が破壊され、ルビプレビューが消える。
    // 【v1.27.0】ruby を実 DOM 化（.ruby-wrap）に変更。互換のため .ruby-edit-pending と
    // .ruby-wrap の両方を許容ノードとして扱う（applyEditModeRubyToRange は両方の class
    // を併記して挿入する）。
    const allAllowedNodes = Array.from(inner.childNodes).every(
      (n) => n.nodeType === Node.TEXT_NODE
        || (n.nodeType === Node.ELEMENT_NODE && n.classList
            && (n.classList.contains("ruby-edit-pending")
                || n.classList.contains("ruby-wrap"))),
    );
    const innerTextStripped = inner.textContent.replace(/​/g, "");
    // ruby を持つ inner は plain text 化を完全 skip（変換は ruby 削除後に再実行可能）。
    const hasRubyPending = inner.querySelector(".ruby-edit-pending, .ruby-wrap");
    if (hasRubyPending) return false;
    if (allAllowedNodes && innerTextStripped === converted) return false;
    // caret 位置を char offset で保持してから DOM を書換える
    const sel = window.getSelection();
    let savedStart = null;
    let savedEnd = null;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (inner.contains(r.startContainer) || r.startContainer === inner) {
        try {
          const a = document.createRange();
          a.selectNodeContents(inner);
          a.setEnd(r.startContainer, r.startOffset);
          savedStart = a.toString().length;
          const b = document.createRange();
          b.selectNodeContents(inner);
          b.setEnd(r.endContainer, r.endOffset);
          savedEnd = b.toString().length;
        } catch (_) { /* fallthrough */ }
      }
    }
    inner.textContent = converted;
    // caret 復元: textContent 書換後は inner の child は単一 text node のみ
    if (savedStart != null && sel) {
      try {
        const tn = inner.firstChild ?? inner;
        const r = document.createRange();
        const len = (tn.nodeType === 3 ? tn.length : converted.length);
        r.setStart(tn, Math.min(savedStart, len));
        r.setEnd(tn, Math.min(savedEnd ?? savedStart, len));
        sel.removeAllRanges();
        sel.addRange(r);
      } catch (_) { /* ignore */ }
    }
    return true;
  };

  // 単純差分: 共通接頭辞・接尾辞の外側を 1 つの編集領域とみなす（input 1 回 = 1 操作前提）
  const computeStringDiff = (a, b) => {
    let prefix = 0;
    const minLen = Math.min(a.length, b.length);
    while (prefix < minLen && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix
           && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    return { pos: prefix, deleted: a.length - prefix - suffix, inserted: b.length - prefix - suffix };
  };

  // per-char index map のシフト（{ "10": 18 } 形式の charSizes / charFonts）
  const shiftCharMap = (map, pos, deleted, inserted) => {
    if (!map || typeof map !== "object") return {};
    const result = {};
    const delta = inserted - deleted;
    for (const k of Object.keys(map)) {
      const idx = Number(k);
      if (!Number.isFinite(idx)) continue;
      if (idx < pos) result[idx] = map[k];
      else if (idx >= pos + deleted) result[idx + delta] = map[k];
      // pos <= idx < pos+deleted は削除文字なので drop
    }
    return result;
  };

  const countNewlinesBefore = (str, idx) => {
    let n = 0;
    const limit = Math.min(idx, str.length);
    for (let i = 0; i < limit; i++) if (str[i] === "\n") n++;
    return n;
  };

  // 【v1.26.0】charRubies map のシフト。{"<start>": {end, text, type, scale}} 形式で
  // 値が range を持つため、shiftCharMap とは扱いが異なる。
  //   - 編集範囲が ruby を完全に含む (pos <= start && pos+deleted >= end) → drop
  //   - 部分重複 (pos < end && pos+deleted > start, ただし完全包含ではない) → drop（安全側）
  //   - ruby の end <= pos (前方は未変化) → unchanged
  //   - ruby の start >= pos + deleted (後方) → start/end を delta シフト
  const shiftRubyMap = (map, pos, deleted, inserted) => {
    if (!map || typeof map !== "object") return {};
    const result = {};
    const delta = inserted - deleted;
    for (const k of Object.keys(map)) {
      const start = Number(k);
      const entry = map[k];
      if (!Number.isFinite(start) || !entry) continue;
      const end = Number(entry.end);
      if (!Number.isFinite(end)) continue;
      const editEnd = pos + deleted;
      if (pos < end && editEnd > start) continue;
      if (start >= editEnd) {
        result[String(start + delta)] = { ...entry, end: end + delta };
      } else {
        result[String(start)] = { ...entry };
      }
    }
    return result;
  };

  // per-line leading map のシフト（{ "2": 130 } 形式、行番号は 0-based）
  const shiftLineMap = (map, oldContents, newContents, pos, deleted, inserted) => {
    if (!map || typeof map !== "object") return {};
    const oldDeletedSegment = oldContents.slice(pos, pos + deleted);
    const newInsertedSegment = newContents.slice(pos, pos + inserted);
    const oldNL = (oldDeletedSegment.match(/\n/g) ?? []).length;
    const newNL = (newInsertedSegment.match(/\n/g) ?? []).length;
    const delta = newNL - oldNL;
    if (delta === 0) {
      const out = {};
      for (const k of Object.keys(map)) out[k] = map[k];
      return out;
    }
    const linesBeforeEdit = countNewlinesBefore(oldContents, pos);
    const result = {};
    for (const k of Object.keys(map)) {
      const idx = Number(k);
      if (!Number.isFinite(idx)) continue;
      if (idx <= linesBeforeEdit) {
        result[idx] = map[k];
      } else {
        const newIdx = idx + delta;
        if (newIdx >= 0) result[newIdx] = map[k];
      }
    }
    return result;
  };

  // カーソル位置と選択範囲を _lastInplaceSelection / editingContext に反映
  const reportCursor = () => {
    const range = getSelRange();
    if (!range) return;
    const { start, end } = range;
    if (end > start) {
      setLastInplaceSelection({
        start, end,
        psdPath: layerMeta.psdPath,
        layerId: layerMeta.layerId ?? null,
        tempId: layerMeta.tempId ?? null,
      });
    } else {
      setLastInplaceSelection(null);
    }
    const lineIndex = countNewlinesBefore(lastContents, start);
    const totalLines = (lastContents.match(/\n/g) ?? []).length + 1;
    setEditingContext({
      ...layerMeta,
      currentLineIndex: lineIndex,
      totalLines,
      contents: lastContents,
      selectionStart: start,
      selectionEnd: end,
    });
  };

  // selectionchange は document スコープでしか発火しないので、edit セッション中だけ register。
  const onSelChange = () => {
    if (!inner.isConnected) return;
    const a = document.activeElement;
    if (a !== inner && !inner.contains(a)) return;
    reportCursor();
  };
  document.addEventListener("selectionchange", onSelChange);

  // IME 中は input イベントを無視（中間文字を contents に書き込まない）
  const onCompStart = () => { imeComposing = true; };
  const onCompEnd = () => { imeComposing = false; onInput(); };
  inner.addEventListener("compositionstart", onCompStart);
  inner.addEventListener("compositionend", onCompEnd);

  // text をカーソル位置に挿入する共通ヘルパ。
  // Enter / paste / 他経路で再利用するため切り出し。
  //
  // 重要 (Chromium / WebView2 既知挙動への対処):
  //   末尾 \n だけだと caret が「新行の先頭」を anchor として持てず、
  //   視覚的に前の行末に残ったままになる現象がある（特に縦書き contenteditable）。
  //   結果として「Enter 1 回押下で box は 1 行広がるが cursor は移動しない」
  //   「Enter 2 回押下で初めて caret が新行へ移る」というズレが発生。
  //
  //   fix: 挿入後、tn の直後に内容物 (text や element) が無いとき
  //   zero-width space (U+200B) の text node を anchor として追加し、
  //   その offset 0 にカーソルを置く。これにより caret が確実に新行先頭にレンダリングされる。
  //   読み取り側 (readContents) は ​ を strip するので state.contents には残らない。
  const insertTextAtCursor = (text) => {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return false;
    const r = s.getRangeAt(0);
    let tn;
    if (!inner.contains(r.startContainer) && r.startContainer !== inner) {
      // selection が inner 外に逃げているケース（フォーカス移動直後など）。末尾に挿入。
      const fallback = document.createRange();
      fallback.selectNodeContents(inner);
      fallback.collapse(false);
      tn = document.createTextNode(text);
      fallback.insertNode(tn);
    } else {
      r.deleteContents();
      tn = document.createTextNode(text);
      r.insertNode(tn);
    }

    // 挿入した tn の後ろに caret を置きたいが、tn が \n 末尾のときは anchor が必要。
    // 後続に visible 内容があれば不要、なければ zero-width space を追加する。
    const hasFollowingContent = (() => {
      let n = tn.nextSibling;
      while (n) {
        if (n.nodeType === Node.TEXT_NODE && n.textContent.length > 0) return true;
        if (n.nodeType === Node.ELEMENT_NODE) return true;
        n = n.nextSibling;
      }
      return false;
    })();

    s.removeAllRanges();
    const newR = document.createRange();
    if (text.endsWith("\n") && !hasFollowingContent) {
      // \n の後ろに anchor 用の zwsp を追加し、その先頭に caret を置く。
      // 視覚的には新行の先頭に caret がレンダリングされる（zwsp は不可視）。
      const anchor = document.createTextNode("​");
      tn.parentNode.insertBefore(anchor, tn.nextSibling);
      newR.setStart(anchor, 0);
    } else {
      // 通常: text node 末尾内部にカーソルを置く。
      newR.setStart(tn, tn.length);
    }
    newR.collapse(true);
    s.addRange(newR);
    return true;
  };

  // Enter は <br>/<div> 自動挿入を抑止して \n text node を手動挿入。
  // beforeinput は WebView2 で inputType が一致しないケースがあるため keydown を主経路とし、
  // beforeinput は補助（virtual keyboard / 音声入力 / IME 挿入経由）として残す。
  // 二重挿入を防ぐため keydown ハンドラ側で _enterHandled フラグを立て、
  // beforeinput でフラグ true なら no-op にする。
  let _enterHandled = false;
  const onBeforeInput = (e) => {
    if (_enterHandled) { _enterHandled = false; return; }
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
      e.preventDefault();
      if (insertTextAtCursor("\n")) onInput();
    }
  };
  inner.addEventListener("beforeinput", onBeforeInput);

  // paste は plain text のみ受け付け（HTML 構造を持ち込ませない）
  const onPaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData("text/plain") ?? "";
    if (!text) return;
    if (insertTextAtCursor(text)) onInput();
  };
  inner.addEventListener("paste", onPaste);

  // 【v1.21.0】中心固定: state と DOM box の位置・サイズを oldCenter 起点で再計算。
  // 改行追加で bbox が伸びても、視覚的には edit 開始時の中心位置から左右上下に均等に広がる。
  // state も同時に更新するので commit 時の補正は不要（startInPlaceEdit / startTextInput の
  // onCommit ロジックは no-op になる）。
  //
  // virtualContents が指定されたとき (= IME 候補表示中) は state を書き換えず、
  // 視覚的な box サイズだけを virtualContents の bbox に合わせて更新する。
  // これにより IME 入力中でも box が visible text に追従して広がる。
  const recenterBox = (virtualContents = null) => {
    const useVirtual = typeof virtualContents === "string";
    let newRect;
    if (isExisting) {
      const editObj = getEdit(page.path, target.layer.id) ?? {};
      const merged = useVirtual ? { ...editObj, contents: virtualContents } : editObj;
      newRect = layerRectForExisting(page, target.layer, merged);
    } else {
      const list = getNewLayersForPsd(page.path);
      const nl = list.find((l) => l.tempId === target.nl.tempId) ?? target.nl;
      const merged = useVirtual ? { ...nl, contents: virtualContents } : nl;
      newRect = layerRectForNew(page, merged);
    }
    // 中心を oldCenter に固定する新 top-left
    const newLeft = oldCenterX - newRect.width / 2;
    const newTop = oldCenterY - newRect.height / 2;
    // state を新位置に書き込む（transient 内なので push されない）。
    // ただし virtualContents 経由（IME 中）は state を触らず DOM だけ更新する。
    if (!useVirtual) {
      if (isExisting) {
        const dx = newLeft - target.layer.left;
        const dy = newTop - target.layer.top;
        setEdit(page.path, target.layer.id, { dx, dy });
      } else {
        updateNewLayer(target.nl.tempId, { x: newLeft, y: newTop });
      }
    }
    // box CSS を直接更新（renderOverlay は editing layer をスキップするため自前更新）
    if (page.width > 0 && page.height > 0) {
      box.style.left = `${(newLeft / page.width) * 100}%`;
      box.style.top = `${(newTop / page.height) * 100}%`;
      box.style.width = `${(newRect.width / page.width) * 100}%`;
      box.style.height = `${(newRect.height / page.height) * 100}%`;
    }
  };

  // input ハンドラ: 差分を計算 → state に反映 + per-char index re-mapping
  const onInput = () => {
    if (imeComposing) {
      // IME 候補表示中は state.contents を書き換えない（preedit が確定値として残ってしまうため）。
      // ただし visible text を使って bbox は visual update する。これにより IME で長文を
      // 入力してもテキストボックスが表示中の text に追従して広がる。
      // 半角→全角の自動変換も IME 確定後 (compositionend → onInput 再呼出) に走らせる。
      const visibleText = readContents();
      recenterBox(visibleText);
      return;
    }
    // 縦書き + 設定 ON のとき、ユーザーが新規に打ち込んだ半角英数字を即座に
    // 全角化（DOM 自体を書換、caret 位置は 1:1 文字対応で維持）。Photoshop の
    // 「縦中横自動入力」と類似の感覚で、編集中もリアルタイムに全角表示される。
    applyConversionToInner();
    const newContents = readContents();
    if (newContents === lastContents) {
      reportCursor();
      return;
    }
    const diff = computeStringDiff(lastContents, newContents);
    const { charSizes, charFonts, charBolds, charRubies, lineLeadings } = readCurrentMaps();
    const newCharSizes = shiftCharMap(charSizes, diff.pos, diff.deleted, diff.inserted);
    const newCharFonts = shiftCharMap(charFonts, diff.pos, diff.deleted, diff.inserted);
    // 【v1.26.0】charBolds も同じ shiftCharMap を適用（v1.22.0 で抜けていた既存バグ修正）。
    const newCharBolds = shiftCharMap(charBolds, diff.pos, diff.deleted, diff.inserted);
    // 【v1.26.0】charRubies はキーが range の start なので shiftRubyMap を使う。
    const newCharRubies = shiftRubyMap(charRubies, diff.pos, diff.deleted, diff.inserted);
    const newLineLeadings = shiftLineMap(
      lineLeadings, lastContents, newContents,
      diff.pos, diff.deleted, diff.inserted,
    );

    if (isExisting) {
      setEdit(page.path, target.layer.id, {
        contents: newContents,
        charSizes: newCharSizes,
        charFonts: newCharFonts,
        charBolds: newCharBolds,
        charRubies: newCharRubies,
        lineLeadings: newLineLeadings,
      });
    } else {
      updateNewLayer(target.nl.tempId, {
        contents: newContents,
        charSizes: newCharSizes,
        charFonts: newCharFonts,
        charBolds: newCharBolds,
        charRubies: newCharRubies,
        lineLeadings: newLineLeadings,
      });
    }
    lastContents = newContents;
    // 中心固定で box の位置・サイズを更新（state.x/y or edit.dx/dy も同期）
    recenterBox();
    reportCursor();
  };
  inner.addEventListener("input", onInput);

  // Esc / Ctrl+Enter / 通常 Enter
  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finalize(false);
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      finalize(true);
      return;
    }
    // 通常 Enter / Shift+Enter: WebView2 / Chromium の既定 (<div><br></div> 挿入) を抑止して
    // \n text node を直接挿入。beforeinput のフォールバック・確実経路として keydown を使う。
    // beforeinput がうまく発火しないケース（縦書き contenteditable 等）でも改行が入る。
    // stopImmediatePropagation で他の listener（window グローバルのショートカット dispatch 等）
    // を確実にブロックする。
    if (e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _enterHandled = true; // beforeinput 側で二重挿入しないようにフラグを立てる
      if (insertTextAtCursor("\n")) onInput();
      return;
    }
  };
  inner.addEventListener("keydown", onKeydown);

  // blur: editor パネル内クリックなら維持、それ以外なら commit
  const onBlur = (e) => {
    const next = e.relatedTarget;
    if (next && typeof next.closest === "function"
        && next.closest(".editor, .side-panel .editor")) {
      return;
    }
    finalize(true);
  };
  inner.addEventListener("blur", onBlur);

  // ===== finalize =====
  function finalize(commit) {
    if (finished) return;
    finished = true;

    document.removeEventListener("selectionchange", onSelChange);
    inner.removeEventListener("compositionstart", onCompStart);
    inner.removeEventListener("compositionend", onCompEnd);
    inner.removeEventListener("beforeinput", onBeforeInput);
    inner.removeEventListener("paste", onPaste);
    inner.removeEventListener("input", onInput);
    inner.removeEventListener("keydown", onKeydown);
    inner.removeEventListener("blur", onBlur);

    box.classList.remove("editing");
    inner.removeAttribute("contenteditable");
    inner.removeAttribute("spellcheck");
    box.__finalize = null;

    setEditingContext(null);
    setLastInplaceSelection(null);

    const finalContents = readContents();

    if (commit) {
      let abortRequested = false;
      if (typeof options.onCommit === "function") {
        try {
          // onCommit が false を返すと「履歴に残さず abort」として扱う。
          // 用途: 新規入力で何も打たずに Ctrl+Enter したケース（空レイヤー作成 → 削除）。
          const r = options.onCommit(finalContents);
          if (r === false) abortRequested = true;
        } catch (err) { console.error("onCommit error", err); }
      }
      if (typeof options.afterCommit === "function") {
        try { options.afterCommit(finalContents); } catch (err) { console.error("afterCommit error", err); }
      }
      if (abortRequested) abortHistoryTransient();
      else commitHistoryTransient(); // edit セッション全体を 1 history snapshot にまとめる
    } else {
      // Esc キャンセル: 編集前の state に巻き戻し → transient abort（履歴に何も残さない）。
      // 復元書込・onCancel 内の操作（新規入力時の removeNewLayer 等）はすべて transient 内
      // （depth > 0）で行うので push されず、最後に abort で depth-- して終了。
      // これにより Esc 後は history に編集セッションの痕跡なし。
      // contents だけでなく、recenterBox が書き換えた x/y / dx/dy も元の値に戻す。
      if (isExisting) {
        setEdit(page.path, target.layer.id, {
          contents: startContents,
          lineLeadings: startLineLeadings,
          charSizes: startCharSizes,
          charFonts: startCharFonts,
          dx: startDx,
          dy: startDy,
        });
      } else {
        updateNewLayer(target.nl.tempId, {
          contents: startContents,
          lineLeadings: startLineLeadings,
          charSizes: startCharSizes,
          charFonts: startCharFonts,
          x: startX,
          y: startY,
        });
      }
      if (typeof options.onCancel === "function") {
        try { options.onCancel(); } catch (err) { console.error("onCancel error", err); }
      }
      abortHistoryTransient();
    }

    refreshAllOverlays();
    rebuildLayerList();
  }

  box.__finalize = finalize;

  reportCursor();
  return { finalize, box, inner };
}

// 【v1.21.0】既存・新規レイヤーの打ち換え in-place 編集。
// レイヤー DOM の text element を直接 contenteditable 化し、Photoshop 風 UX を実現。
// レイヤーの DOM が overlay に存在することを前提とするので、呼び出し側は
// 必要なら refreshAllOverlays() を先に走らせて DOM を確保しておく。
function startInPlaceEdit(ctx, target, options = {}) {
  const { page } = ctx;

  // 既に編集中レイヤーがあれば finalize（多重編集を抑止）
  const existing = ctx.overlay.querySelector(".layer-box.editing");
  if (existing && typeof existing.__finalize === "function") {
    existing.__finalize(true);
  }

  // contents / x,y / dx,dy は startContentEditableEdit の input 経路で edit 中に
  // 中心固定 (recenterBox) で連続更新されているので、ここでの commit-time 補正は不要。
  // 原稿テキスト dblclick 経由の afterCommit (TXT 同期) もそのまま startContentEditableEdit
  // 側の afterCommit に委ねる（同 transient 内で実行されるので 1 history snapshot に収まる）。
  startContentEditableEdit(ctx, target, {
    selectAll: true,
    afterCommit: options.afterCommit,
  });
}

// 【v1.21.0】V ツール空所 dblclick の新規入力。Photoshop 流: 先にレイヤーを作成して
// クリック点に置き、その text element を直接 contenteditable 化。
// 何も打たずに Esc または空のまま blur したらレイヤーを削除（Photoshop と同じ）。
function startTextInput(ctx, x, y, direction = "vertical") {
  const { page } = ctx;
  // 既に編集中があればまずそれを finalize
  const existing = ctx.overlay.querySelector(".layer-box.editing");
  if (existing && typeof existing.__finalize === "function") {
    existing.__finalize(true);
  }

  const sizePt = getTextSize();
  const layerDir = direction === "horizontal" ? "horizontal" : "vertical";
  // 空 contents での bbox 中心 = クリック点になるよう top-left を計算
  const { x: nx, y: ny } = centerTopLeft(page, { contents: "", sizePt, direction: layerDir }, x, y);
  const created = addNewLayer({
    psdPath: page.path,
    x: nx,
    y: ny,
    contents: "",
    fontPostScriptName: getCurrentFont(),
    sizePt,
    direction: layerDir,
    strokeColor: getStrokeColor(),
    strokeWidthPx: getStrokeWidthPx(),
    fillColor: getFillColor(),
    leadingPct: getLeadingPct(),
  });
  setSelectedLayer(ctx.pageIndex, created.tempId);
  // レイヤー DOM を overlay に同期生成（startContentEditableEdit が DOM を要求するため）
  refreshAllOverlays();
  rebuildLayerList();

  startContentEditableEdit(ctx, { kind: "new", nl: created }, {
    selectAll: false,
    onCommit: (value) => {
      // 中心固定 (recenterBox) は startContentEditableEdit の input 経路で連続適用済み。
      // commit-time にはここで「空コミットならレイヤー削除 + 履歴に残さない」判定だけ行う。
      if (!value) {
        removeNewLayer(created.tempId);
        return false; // abort: 履歴に残さない
      }
    },
    onCancel: () => {
      // Esc: 編集前の startContents (空) に巻き戻った後の onCancel。
      // 元々この edit セッションでレイヤーが作られた経緯なので破棄して終了。
      removeNewLayer(created.tempId);
    },
  });
}
