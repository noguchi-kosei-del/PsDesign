import { loadReferenceFiles, pickReferenceFiles } from "./pdf-loader.js";
import { mountPdfView } from "./pdf-view.js";
import {
  cycleLayerSelection,
  deleteSelectedLayers,
  nudgeSelectedLayers,
  refreshAllOverlays,
  snapNextSize,
  // 【v1.16.0】in-place 編集 textarea 上の文字選択キャッシュ
  getLastInplaceSelection,
  onInplaceSelectionChange,
  // 【v1.21.0】per-char サイズ・フォント変更時の編集中 DOM リアルタイム反映
  applyEditModeStyleToRange,
  // 【v1.26.0】ルビ予定インジケータの編集中 DOM 反映
  applyEditModeRubyToRange,
  getExistingLayerEffectiveSizePt,
} from "./canvas-tools.js";
import { onFontsRegistered } from "./font-loader.js";
import { renderAllSpreads } from "./spread-view.js";
import {
  bindEditorEvents,
  commitBoldToSelections,
  commitLeadingToSelections,
  commitSelectedLayerField,
  commitSizeToSelections,
  computeCommonBold,
  hasSelection,
  rebuildLayerList,
  syncBoldToggle,
} from "./text-editor.js";
import { cycleTxtBlockSelection, deleteSelectedTxtBlock, getTxtPageCount, initTxtSource, loadTxtFromPath } from "./txt-source.js";
import { bindAiInstallMenu } from "./ai-install.js";
import { bindFirstRunSetup, maybeShowFirstRunSetup } from "./first-run-setup.js";
import { bindAiOcrButton } from "./ai-ocr.js";
import { bindAiPlaceButton, bindPositionAdjustButton } from "./ai-place.js";
import { bindViewerMode, toggleViewerMode } from "./viewer-mode.js";
import { bindAutoUpdater } from "./auto-updater.js";
import { bindProofreadUi, openProofread } from "./proofread.js";
import { initHamburgerMenu } from "./hamburger-menu.js";
import { bindStylePalette } from "./style-palette.js";
import {
  confirmDialog,
  hideModalAnimated,
  hideProgress,
  showModalAnimated,
  showProgress,
  toast,
} from "./ui-feedback.js";
import {
  bindSaveMenu,
  handleOverwriteSave,
  handleSaveAs,
  setHasSavedThisSession,
  updateSaveButton,
} from "./bind/save.js";
import { bindEditorPane, focusEditor } from "./bind/editor-pane.js";
import {
  handleOpenFiles,
  listPsdFilesInFolder,
  loadPsdFilesByPaths,
  pickPsdFiles,
} from "./services/psd-load.js";
import {
  findShortcutMatch,
  getDefault,
  getPageDirectionInverted,
  getShortcut,
  matchShortcut,
  onSettingsChange,
} from "./settings.js";
import { initSettingsUi } from "./settings-ui.js";
import {
  initRulers,
  toggleRulersVisible,
  getRulersVisible,
  onRulersVisibleChange,
  getGuidesLocked,
  toggleGuidesLocked,
  onGuidesLockedChange,
  hasAnyGuide,
  onGuidesChange,
  applyGuidesToPaths,
  clearGuidesForPaths,
  guidesMatchCurrent,
} from "./rulers.js";
import {
  addPage,
  canRedo,
  canUndo,
  clearAllEdits,
  clearPages,
  getActivePane,
  getCurrentPageIndex,
  getNewLayersForPsd,
  getPages,
  getParallelSyncMode,
  getParallelViewMode,
  getPdfDoc,
  getPdfPageIndex,
  getPdfRotation,
  getPdfSkipFirstBlank,
  getPdfZoom,
  getPsdRotation,
  getPsdZoom,
  getTextSize,
  getTool,
  hasEdits,
  getEditorLeftPaneMode,
  setEditorLeftPaneMode,
  onEditorLeftPaneModeChange,
  onActivePaneChange,
  onHistoryChange,
  onPageIndexChange,
  onParallelSyncModeChange,
  onParallelViewModeChange,
  onPdfChange,
  onPdfPageIndexChange,
  onPdfRotationChange,
  onPdfSkipFirstBlankChange,
  onPdfSplitModeChange,
  onPdfZoomChange,
  onPsdZoomChange,
  onTextSizeChange,
  onToolChange,
  onTxtSourceChange,
  setActivePane,
  setCurrentPageIndex,
  setFonts,
  setParallelSyncMode,
  setParallelViewMode,
  setPdfPageIndex,
  setSelectedLayers,
  setPdfRotation,
  setPdfSkipFirstBlank,
  setPdfZoom,
  setPsdRotation,
  setPsdZoom,
  setTextSize,
  setTool,
  redo,
  undo,
  getLeadingPct,
  setLeadingPct,
  onLeadingPctChange,
  getEditingContext,
  onEditingContextChange,
  setLineLeading,
  getLineLeading,
  // 【v1.16.0】per-char サイズ
  setCharSizesRange,
  // 【v1.22.0】per-char 合成太字
  setCharBoldsRange,
  // 【v1.26.0】per-char ルビ
  setCharRubiesRange,
  getCharRubyAt,
  rangeHasAnyRuby,
  withHistoryTransient,
  getEdit,
  getSelectedLayers,
  getNewTextDirection,
  setNewTextDirection,
  onNewTextDirectionChange,
  applyToolDefaults,
} from "./state.js";
import {
  getPdfVirtualIndexForPhysicalPage,
  getPdfVirtualPageAt,
  getPdfVirtualPageCount,
} from "./pdf-pages.js";

async function handleOpenPdf() {
  const paths = await pickReferenceFiles();
  if (!paths.length) return;
  await loadReferenceFiles(paths);
}

function bindPdfWorkspaceToggle() {
  // PDF エリアは常時表示（未読込時は empty state を見せる）。
  // 回転ボタンも常時表示し、doc 未読込時は disabled でグレーアウト。
  const rotateBtn = document.getElementById("pdf-rotate-btn");
  const apply = (doc) => {
    if (rotateBtn) rotateBtn.disabled = !doc;
  };
  onPdfChange(apply);
  apply(null);
}

function bindPdfRotate() {
  const btn = document.getElementById("pdf-rotate-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    setPdfRotation((getPdfRotation() + 90) % 360);
  });
}

function bindPsdRotate() {
  const btn = document.getElementById("psd-rotate-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    setPsdRotation((getPsdRotation() + 90) % 360);
  });
}

function updatePsdRotateVisibility() {
  const btn = document.getElementById("psd-rotate-btn");
  if (!btn) return;
  btn.disabled = getPages().length === 0;
}

function bindPsdGuidesLock() {
  const btn = document.getElementById("psd-guides-lock-btn");
  if (!btn) return;
  const syncPressed = () => {
    const locked = getGuidesLocked();
    btn.setAttribute("aria-pressed", locked ? "true" : "false");
    btn.title = locked ? "ガイドのロック解除" : "ガイドをロック";
    btn.setAttribute("aria-label", btn.title);
  };
  // PSD 未読込 or ガイドが 1 本も無い場合は disabled でグレーアウト。
  // 表示/非表示はルーラー ON/OFF のみで制御（読込前でもバー上にボタンは出す）。
  const syncDisabled = () => {
    btn.disabled = getPages().length === 0 || !hasAnyGuide();
  };
  btn.addEventListener("click", () => toggleGuidesLocked());
  onGuidesLockedChange(syncPressed);
  onGuidesChange(syncDisabled);
  onPageIndexChange(syncDisabled); // ページ切替で対象 PSD のガイド有無が変わる
  syncPressed();
  syncDisabled();
  // ルーラー OFF のときだけ完全非表示（機能トグル）。読込前は disabled で見せる。
  const updateVis = () => {
    btn.hidden = !getRulersVisible();
  };
  onRulersVisibleChange(updateVis);
  updateVis();
}

// ガイドロックボタンの「ファイル読込みあり」条件 + ガイド有無を、PSD ロード/クリア時に同期。
function updatePsdGuidesLockVisibility() {
  const btn = document.getElementById("psd-guides-lock-btn");
  if (!btn) return;
  btn.hidden = !getRulersVisible();
  btn.disabled = getPages().length === 0 || !hasAnyGuide();
}

// 「ガイドを複数反映」ボタン: ロックボタンと同じく ルーラー ON + PSD 読込済 で可視。
// ただし反映先が無いと意味が無いので PSD が 2 ページ以上必要。
// また「現在のガイドが確定している」ことを示すためロック中でないと無効にする
// （ロック前 = 編集中なので、まだ反映を取らない方が UX として安全）。
function bindPsdGuidesApply() {
  const btn = document.getElementById("psd-guides-apply-btn");
  if (!btn) return;
  btn.addEventListener("click", openGuidesApplyModal);
  const sync = () => updatePsdGuidesApplyVisibility();
  onRulersVisibleChange(sync);
  onGuidesChange(sync);
  onPageIndexChange(sync);
  onGuidesLockedChange(sync);
  sync();
}
function updatePsdGuidesApplyVisibility() {
  const btn = document.getElementById("psd-guides-apply-btn");
  if (!btn) return;
  // ルーラー OFF のときだけ完全非表示（機能トグル）。読込前 / 1 ページしか無い場合は disabled で見せる。
  btn.hidden = !getRulersVisible();
  // 有効条件: PSD 2 ページ以上 + 現ページにガイドあり + ガイドロック中。
  const pageCount = getPages().length;
  const tooFewPages = pageCount < 2;
  const noGuides = !hasAnyGuide();
  const notLocked = !getGuidesLocked();
  btn.disabled = tooFewPages || noGuides || notLocked;
  btn.title = pageCount === 0
    ? "PSD を読み込んでください"
    : (tooFewPages
      ? "反映先のページがありません"
      : (noGuides
        ? "現在のページにガイドが引かれていません"
        : (notLocked
          ? "ガイドをロックすると反映できます"
          : "ガイドを複数ページに反映")));
  btn.setAttribute("aria-label", btn.title);
}

function openGuidesApplyModal() {
  const modal = document.getElementById("guides-apply-modal");
  const list = document.getElementById("guides-apply-list");
  const okBtn = document.getElementById("guides-apply-ok");
  const unapplyBtn = document.getElementById("guides-apply-unapply");
  const cancelBtn = document.getElementById("guides-apply-cancel");
  const selAllBtn = document.getElementById("guides-apply-select-all");
  const selNoneBtn = document.getElementById("guides-apply-select-none");
  if (!modal || !list || !okBtn || !cancelBtn) return;

  const pages = getPages();
  const currentIdx = getCurrentPageIndex();
  list.innerHTML = "";
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const isCurrent = i === currentIdx;
    // 反映済み: 現ページとガイドが完全一致。
    // ガイドあり: 何らかのガイドを持つが現ページと一致しない。
    // 解除を後から行えるよう、現ページ以外は全て選択可能にする（disabled は外す）。
    const alreadyApplied = !isCurrent && guidesMatchCurrent(page?.path);
    const otherHasGuides = !isCurrent && !alreadyApplied && hasAnyGuide(page?.path);
    const label = document.createElement("label");
    label.className = "guides-apply-item"
      + (isCurrent ? " guides-apply-item-current" : "")
      + (alreadyApplied ? " guides-apply-item-applied" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.index = String(i);
    cb.dataset.hasGuides = (alreadyApplied || otherHasGuides) ? "1" : "0";
    // 現ページもチェック可能にしておく（全選択に含めるため）。
    // 実際の反映 / 解除は rulers.js 側で path === srcPath を弾くので二重防止。
    const span = document.createElement("span");
    span.className = "guides-apply-item-name";
    const m = (page?.path ?? "").match(/[\\/]([^\\/]+)$/);
    const name = m ? m[1] : (page?.path ?? `ページ ${i + 1}`);
    let suffix = "";
    if (isCurrent) suffix = "（現在のページ）";
    else if (alreadyApplied) suffix = "（反映済み）";
    else if (otherHasGuides) suffix = "（ガイドあり）";
    span.textContent = `${i + 1}: ${name}${suffix}`;
    label.appendChild(cb);
    label.appendChild(span);
    list.appendChild(label);
  }

  showModalAnimated(modal);

  const cleanup = () => {
    hideModalAnimated(modal);
    okBtn.removeEventListener("click", onOk);
    unapplyBtn?.removeEventListener("click", onUnapply);
    cancelBtn.removeEventListener("click", onCancel);
    selAllBtn?.removeEventListener("click", onSelAll);
    selNoneBtn?.removeEventListener("click", onSelNone);
    modal.removeEventListener("mousedown", onOverlay);
    document.removeEventListener("keydown", onKey);
  };
  const collectSelectedPaths = (filterFn) => {
    const out = [];
    list.querySelectorAll("input[type=checkbox]:not(:disabled):checked").forEach((cb) => {
      if (filterFn && !filterFn(cb)) return;
      const idx = Number(cb.dataset.index);
      if (Number.isFinite(idx) && pages[idx]?.path) out.push(pages[idx].path);
    });
    return out;
  };
  const onOk = () => {
    const targetPaths = collectSelectedPaths();
    cleanup();
    if (targetPaths.length === 0) return;
    const count = applyGuidesToPaths(targetPaths);
    if (count > 0) toast(`${count} ページにガイドを反映しました`, { kind: "success" });
  };
  const onUnapply = () => {
    // 解除はガイドを持つページのみ意味がある。
    // ガイドのないページが混ざっていても rulers 側で no-op になるが、
    // ユーザーには「N ページのガイドを解除しました」と実際に解除した数だけ通知する。
    const targetPaths = collectSelectedPaths((cb) => cb.dataset.hasGuides === "1");
    cleanup();
    if (targetPaths.length === 0) return;
    const count = clearGuidesForPaths(targetPaths);
    if (count > 0) toast(`${count} ページのガイドを解除しました`, { kind: "success" });
  };
  const onCancel = () => cleanup();
  const onOverlay = (e) => { if (e.target === modal) cleanup(); };
  const onSelAll = () => list.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = true; });
  const onSelNone = () => list.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = false; });
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cleanup(); }
    else if (e.key === "Enter") { e.preventDefault(); onOk(); }
  };

  okBtn.addEventListener("click", onOk);
  unapplyBtn?.addEventListener("click", onUnapply);
  cancelBtn.addEventListener("click", onCancel);
  selAllBtn?.addEventListener("click", onSelAll);
  selNoneBtn?.addEventListener("click", onSelNone);
  modal.addEventListener("mousedown", onOverlay);
  document.addEventListener("keydown", onKey);
}

async function loadFontsFromBackend() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const fonts = await invoke("list_fonts");
    setFonts(fonts);
  } catch (e) {
    console.warn("フォント一覧の取得に失敗:", e);
  }
}

let panPreviousTool = null;
let panSpaceActive = false;

// 環境設定経由でカスタマイズされたショートカット ID を実際のアクションに dispatch。
// pagePrev / pageNext / pageFirst / pageLast はページ送り反転設定 (settings.js) に従って
// 進行方向を入替える。＋/− ボタン・サイドバーボタンは反転対象外（物理矢印キーのみ反転）。
function runShortcut(id) {
  const inv = getPageDirectionInverted();
  switch (id) {
    case "save":       handleOverwriteSave(); break;
    case "saveAs":     handleSaveAs(); break;
    case "pagePrev":   advancePage(inv ? +1 : -1); break;
    case "pageNext":   advancePage(inv ? -1 : +1); break;
    case "pageFirst":  jumpToEdge(inv ? "last" : "first"); break;
    case "pageLast":   jumpToEdge(inv ? "first" : "last"); break;
    case "pageJump":   openPageJumpDialog(); break;
    case "toolSelect": setTool("move"); break;
    case "zoomIn":     zoomActivePaneBy(1.15); break;
    case "zoomOut":    zoomActivePaneBy(1 / 1.15); break;
    case "zoomReset":  resetActivePaneZoom(); break;
    case "sizeUp":     stepTextSize(+1, Math.max(1, Math.round(2 / getSizeStep()))); break;
    case "sizeDown":   stepTextSize(-1, Math.max(1, Math.round(2 / getSizeStep()))); break;
    case "toggleRulers": toggleRulersVisible(); break;
    case "viewerMode":   toggleViewerMode(); break;
  }
}

// 入力欄 (INPUT/TEXTAREA/contenteditable) 内では発火させたくないショートカット判定。
// 規則：修飾キーなし or 矢印キー使用 → 入力欄では無効。Ctrl+S 等は入力欄でも有効を維持。
function isShortcutBlockedInInput(id, target) {
  if (!target) return false;
  const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
  if (!isInput) return false;
  const sc = getShortcut(id);
  if (!sc) return false;
  const isArrow =
    sc.key === "ArrowLeft" || sc.key === "ArrowRight" ||
    sc.key === "ArrowUp"   || sc.key === "ArrowDown";
  const noMods = !sc.modifiers || sc.modifiers.length === 0;
  return isArrow || noMods;
}

function isPageNavShortcut(id) {
  return id === "pagePrev" || id === "pageNext" || id === "pageFirst" || id === "pageLast";
}

// Undo / Redo / 全削除 ボタン群を配線。
// 状態（disabled）は onHistoryChange / onPdfChange... ではなく state.history の
// 変動と pages 切替に追従させたいので、updateHistoryButtons を共通呼び出しにする。
function updateHistoryButtons() {
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const clearBtn = document.getElementById("clear-all-btn");
  if (undoBtn) undoBtn.disabled = !canUndo();
  if (redoBtn) redoBtn.disabled = !canRedo();
  if (clearBtn) clearBtn.disabled = !hasEdits();
}

async function handleClearAllEdits() {
  if (!hasEdits()) return;
  const ok = await confirmDialog({
    title: "編集を全て削除",
    message: "現在の編集（移動・追加レイヤー・テキスト変更など）をすべて削除します。",
    confirmLabel: "全て削除",
  });
  if (!ok) return;
  clearAllEdits();
  refreshAllOverlays();
  rebuildLayerList();
}

function bindHistoryButtons() {
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const clearBtn = document.getElementById("clear-all-btn");
  if (undoBtn) undoBtn.addEventListener("click", () => { if (undo()) syncAfterHistoryChange(); });
  if (redoBtn) redoBtn.addEventListener("click", () => { if (redo()) syncAfterHistoryChange(); });
  if (clearBtn) clearBtn.addEventListener("click", () => { handleClearAllEdits(); });
  // 履歴の変更（push / undo / redo / baseline reset）に追従して disabled と再描画を更新。
  onHistoryChange(() => {
    updateHistoryButtons();
    refreshAllOverlays();
    rebuildLayerList();
  });
  updateHistoryButtons();
}

// undo / redo は state を書換えるだけなので、UI は onHistoryChange listener が受ける。
// ここでは listener を介さない経路向けに用意（現状未使用、将来のため安全側）。
function syncAfterHistoryChange() {
  refreshAllOverlays();
  rebuildLayerList();
  updateHistoryButtons();
}

function bindTools() {
  const buttons = document.querySelectorAll(".tool-btn");
  for (const btn of buttons) {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  }
  const applyActive = () => {
    // Space 長押しで一時的に pan 化しているときは、直前ツールを選択中として表示し続ける
    const current = panSpaceActive && panPreviousTool ? panPreviousTool : getTool();
    for (const btn of buttons) {
      btn.classList.toggle("active", btn.dataset.tool === current);
    }
  };
  onToolChange((tool) => {
    if (panSpaceActive && tool !== "pan") {
      panPreviousTool = null;
      panSpaceActive = false;
    }
    applyActive();
  });
  applyActive();

  // 現在ページの全テキストフレーム (既存レイヤー + 新規レイヤー) を選択する。
  // Ctrl+A 経由で呼ばれる。PSD 未読込時は no-op。
  const selectAllTextFramesOnCurrentPage = () => {
    const pages = getPages();
    if (pages.length === 0) return;
    const idx = Math.max(0, Math.min(pages.length - 1, getCurrentPageIndex()));
    const page = pages[idx];
    const selections = [];
    for (const layer of page.textLayers ?? []) {
      selections.push({ pageIndex: idx, layerId: layer.id });
    }
    for (const nl of getNewLayersForPsd(page.path)) {
      selections.push({ pageIndex: idx, layerId: nl.tempId });
    }
    if (selections.length === 0) return;
    setSelectedLayers(selections);
    rebuildLayerList();
    refreshAllOverlays();
  };

  // サイドツールバーの「全選択」ボタン (パンツールとレイヤーボタンの間)。
  // Ctrl+A と同じく現在ページの全テキストフレーム (既存 + 新規) を選択する。
  const selectAllBtn = document.getElementById("select-all-btn");
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", (e) => {
      e.preventDefault();
      selectAllTextFramesOnCurrentPage();
    });
  }

  // Alt 単独押下/離上で Windows のシステムメニューが活性化し、次の Space で開いてしまう
  // 事故を防ぐ。Alt+wheel でズームした直後に Space を押すと左上にメニューが出る現象の対策。
  const suppressAltMenuActivation = (e) => {
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      e.preventDefault();
    }
  };
  window.addEventListener("keydown", suppressAltMenuActivation);
  window.addEventListener("keyup", suppressAltMenuActivation);

  window.addEventListener("keydown", (e) => {
    // Space は環境設定対象外（パン一時切替の特殊挙動を保つ）。
    if (e.code === "Space") {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.tagName === "BUTTON" || active.tagName === "A")) {
        active.blur();
      }
      e.preventDefault();
      if (e.repeat) return;
      if (!panSpaceActive) {
        panSpaceActive = true;
        if (getTool() !== "pan") {
          panPreviousTool = getTool();
          setTool("pan");
        } else {
          panPreviousTool = null;
        }
      }
      return;
    }

    // 矢印キー (V ツール):
    //   - Alt+↑/↓ : 原稿テキスト (txt-source-viewer) の選択ブロックを順送り / 逆送り
    //   - レイヤー選択あり: 全 4 方向で位置をナッジ (1px / Shift で 10px)
    //   - レイヤー選択なし + ↑/↓: 現ページ内のレイヤー選択を順送り / 逆送り (cycleLayerSelection)
    //   - レイヤー選択なし + ←/→: 下のショートカット dispatch に流して pagePrev/pageNext (ページ移動)
    const isArrowKey =
      e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown";

    // Alt+↑/↓ で原稿テキストブロック選択を切替 (V ツール限定 + 入力欄外)。
    // Alt+←/→ は無効 (将来何かにバインドする可能性のため未使用にしておく)。
    if (isArrowKey && e.altKey && !e.ctrlKey && !e.metaKey) {
      const t = e.target;
      const isInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!isInput && getTool() === "move" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const delta = e.key === "ArrowDown" ? +1 : -1;
        cycleTxtBlockSelection(delta);
        e.preventDefault();
        return;
      }
    }

    if (isArrowKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      const isInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!isInput && getTool() === "move") {
        const hasSel = getSelectedLayers().length > 0;
        if (hasSel) {
          // 選択あり: 位置ナッジ (Shift で 10px)
          const step = e.shiftKey ? 10 : 1;
          let dx = 0, dy = 0;
          if (e.key === "ArrowLeft") dx = -step;
          else if (e.key === "ArrowRight") dx = +step;
          else if (e.key === "ArrowUp") dy = -step;
          else if (e.key === "ArrowDown") dy = +step;
          if (nudgeSelectedLayers(dx, dy)) {
            e.preventDefault();
            return;
          }
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          // 選択なし + ↑/↓: レイヤー選択サイクル (先頭 / 末尾を選ぶ)
          const delta = e.key === "ArrowDown" ? +1 : -1;
          cycleLayerSelection(delta);
          e.preventDefault();
          return;
        }
        // 選択なし + ←/→: nudge せず page nav (pagePrev/pageNext) へ素通し。
      }
    }

    // Delete / Backspace で選択中のものを削除（修飾キーなし）。
    // 入力欄やテキスト編集中（floater の textarea）には介入しない。
    // 優先順: 原稿テキストブロック → 追加テキストフレーム
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    ) {
      const t = e.target;
      const isInput =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!isInput) {
        if (deleteSelectedTxtBlock()) {
          e.preventDefault();
          return;
        }
        if (deleteSelectedLayers()) {
          e.preventDefault();
          return;
        }
      }
    }

    // 履歴系（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / Ctrl+Delete）。
    // 環境設定対象外（破壊的でないため固定キー、入力欄でも有効）。
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        if (undo()) { /* listener が UI を更新 */ }
        return;
      }
      if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        if (redo()) { /* listener が UI を更新 */ }
        return;
      }
      if (e.key === "Delete" || e.code === "Delete") {
        e.preventDefault();
        handleClearAllEdits();
        return;
      }
      // Ctrl+A: 入力欄/contenteditable 内では通常の「フィールド内テキスト全選択」を
      // 維持。それ以外では現在ページの全テキストフレーム (既存 + 新規) を選択する。
      // ブラウザ既定の「ページ全体テキスト選択」は preventDefault で抑止。
      if (k === "a" && !e.shiftKey) {
        const t = e.target;
        const isInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (!isInput) {
          e.preventDefault();
          selectAllTextFramesOnCurrentPage();
          return;
        }
      }
    }

    // 環境設定でカスタマイズ可能なショートカットの dispatch。
    const id = findShortcutMatch(e);
    if (!id) return;
    if (isShortcutBlockedInInput(id, e.target)) return;
    // ページ移動系のみ auto-repeat スロットル（80ms ≒ 12Hz、OS auto-repeat の 30Hz 由来の暴走を抑制）。
    if (e.repeat && isPageNavShortcut(id) && !canAdvancePageNow()) return;
    e.preventDefault();
    runShortcut(id, e);
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" && panSpaceActive) {
      panSpaceActive = false;
      if (panPreviousTool) {
        setTool(panPreviousTool);
        panPreviousTool = null;
      }
    }
  });

  window.addEventListener("blur", () => {
    if (panSpaceActive) {
      panSpaceActive = false;
      if (panPreviousTool) {
        setTool(panPreviousTool);
        panPreviousTool = null;
      }
    }
  });
}

// ページ変更時の重い再描画 (renderAllSpreads は DOM を全壊して再構築する) を rAF で
// 合流させる。連打や ←/→ の OS auto-repeat で 1 フレーム内に複数のページ index 変更が
// 来ても、最終 index に対して 1 回だけ rebuild する。ラベル更新 (updatePageNav) は
// 軽いので毎回実行して即時反映させる。
let pageChangeRaf = 0;
function schedulePageRender() {
  if (pageChangeRaf) return;
  pageChangeRaf = requestAnimationFrame(() => {
    pageChangeRaf = 0;
    renderAllSpreads();
    rebuildLayerList();
    updatePsdRotateVisibility();
    updatePsdGuidesLockVisibility();
    updatePsdGuidesApplyVisibility();
  });
}

function bindPageChange() {
  onPageIndexChange(() => {
    schedulePageRender();
    updatePageNav();
  });
  onPdfPageIndexChange(() => updatePageNav());
  onPdfChange(() => updatePageNav());
  onPdfSplitModeChange(() => updatePageNav());
  onPdfSkipFirstBlankChange(() => updatePageNav());
  onParallelSyncModeChange(() => updatePageNav());
  onActivePaneChange(() => updatePageNav());
  // TXT 単体運用時は TXT のマーカー数がページ総数になるので、TXT の読込/クリアでも
  // ナビ表示を更新する。さらに新 TXT のページ数が現在 index を下回ったら 0 にクランプ。
  onTxtSourceChange(() => {
    if (getPages().length === 0 && getPdfVirtualPageCount() === 0) {
      const total = getTxtPageCount();
      if (total > 0 && getPdfPageIndex() > total - 1) setPdfPageIndex(0);
    }
    updatePageNav();
  });
}

// サイドツールバー / サイドパネルの折り畳みトグル。localStorage に状態を保存して
// 起動時に復元する（MojiQ Pro の同様 UI に倣う）。
const SIDE_TOOLBAR_COLLAPSED_KEY = "psdesign_side_toolbar_collapsed";
const SIDE_PANEL_COLLAPSED_KEY = "psdesign_side_panel_collapsed";

function applyPanelCollapsed(el, collapsed, btn, expandedTitle, collapsedTitle) {
  if (!el) return;
  el.classList.toggle("collapsed", collapsed);
  if (btn) {
    const t = collapsed ? collapsedTitle : expandedTitle;
    btn.title = t;
    btn.setAttribute("aria-label", t);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
}

function bindPanelToggle(panelEl, btn, storageKey, expandedTitle, collapsedTitle) {
  if (!panelEl || !btn) return;
  let collapsed = false;
  try { collapsed = localStorage.getItem(storageKey) === "1"; } catch (_) {}
  applyPanelCollapsed(panelEl, collapsed, btn, expandedTitle, collapsedTitle);
  btn.addEventListener("click", () => {
    collapsed = !collapsed;
    applyPanelCollapsed(panelEl, collapsed, btn, expandedTitle, collapsedTitle);
    try { localStorage.setItem(storageKey, collapsed ? "1" : "0"); } catch (_) {}
  });
}

function bindCollapseToggles() {
  bindPanelToggle(
    document.querySelector(".side-toolbar"),
    document.getElementById("toggle-side-toolbar-btn"),
    SIDE_TOOLBAR_COLLAPSED_KEY,
    "ツールバーを折り畳む",
    "ツールバーを展開",
  );
  bindPanelToggle(
    document.querySelector(".side-panel"),
    document.getElementById("toggle-side-panel-btn"),
    SIDE_PANEL_COLLAPSED_KEY,
    "サイドバーを折り畳む",
    "サイドバーを展開",
  );
}

// サイドパネル先頭の排他タブ（原稿テキスト / テキスト編集）。
// active なタブの panel-section だけ表示し、他は hidden。状態は localStorage に保存。
const SIDE_PANEL_TAB_KEY = "psdesign_side_panel_tab";
function loadSidePanelTab() {
  try {
    const v = localStorage.getItem(SIDE_PANEL_TAB_KEY);
    if (v === "txt" || v === "editor") return v;
  } catch (_) {}
  return "txt";
}
function setSidePanelTab(tab) {
  for (const btn of document.querySelectorAll(".side-panel-tab")) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const sec of document.querySelectorAll(".side-panel .panel-section")) {
    sec.hidden = sec.dataset.section !== tab;
  }
  try { localStorage.setItem(SIDE_PANEL_TAB_KEY, tab); } catch (_) {}
}
function bindSidePanelTabs() {
  const tabs = document.querySelectorAll(".side-panel-tab");
  if (!tabs.length) return;
  for (const btn of tabs) {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => setSidePanelTab(btn.dataset.tab));
  }
  setSidePanelTab(loadSidePanelTab());
}

// レイヤードロワー：サイドツールバーの #layers-toggle-btn から横（左方向）スライドで開閉。
// MojiQ の「指示ツール / 文字サイズ」ドロップダウンと同じシンプルパターン:
// .open クラスのトグルだけで opacity / transform の transition を発火させる。
// visibility / hidden 属性は使わず、display は常に flex 固定（CSS transition が
// 両方向で確実に走るようにする）。永続化なし（毎セッション closed で起動）。
function isLayersDrawerOpen() {
  return !!document.getElementById("layers-drawer")?.classList.contains("open");
}
function openLayersDrawer() {
  const drawer = document.getElementById("layers-drawer");
  const btn = document.getElementById("layers-toggle-btn");
  if (!drawer) return;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  if (btn) btn.setAttribute("aria-expanded", "true");
}
function closeLayersDrawer() {
  const drawer = document.getElementById("layers-drawer");
  const btn = document.getElementById("layers-toggle-btn");
  if (!drawer) return;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  if (btn) btn.setAttribute("aria-expanded", "false");
}
function toggleLayersDrawer() {
  if (isLayersDrawerOpen()) closeLayersDrawer();
  else openLayersDrawer();
}
function bindLayersDrawer() {
  const btn = document.getElementById("layers-toggle-btn");
  if (btn) {
    btn.addEventListener("click", (e) => {
      // ドキュメントレベルの outside-click ハンドラに伝播させない。
      e.stopPropagation();
      toggleLayersDrawer();
    });
  }
  const closeBtn = document.getElementById("layers-drawer-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeLayersDrawer);
  // 外側クリックで閉じる。
  // ボタン自身のクリックは stopPropagation で除外、ドロワー内のクリックは
  // drawer.contains で除外。両者とも .side-toolbar 直下に配置されているので、
  // 個別に contains 判定する。
  document.addEventListener("mousedown", (e) => {
    if (!isLayersDrawerOpen()) return;
    const drawer = document.getElementById("layers-drawer");
    const triggerBtn = document.getElementById("layers-toggle-btn");
    if (drawer && drawer.contains(e.target)) return;
    if (triggerBtn && triggerBtn.contains(e.target)) return;
    closeLayersDrawer();
  });
  // Esc で閉じる（他のモーダル類は自前で Esc を stopPropagation する設計のため安全）。
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isLayersDrawerOpen()) {
      closeLayersDrawer();
    }
  });
}

// サイドツールバーの上下ボタン（ページ移動）配線 + 表示更新。
function bindPageNav() {
  const prev = document.getElementById("page-prev-btn");
  const next = document.getElementById("page-next-btn");
  if (prev) prev.addEventListener("click", () => advancePage(-1));
  if (next) next.addEventListener("click", () => advancePage(+1));
  updatePageNav();
}

function updatePageNav() {
  const label = document.getElementById("page-nav-label");
  const prev = document.getElementById("page-prev-btn");
  const next = document.getElementById("page-next-btn");
  // advancePage と同じターゲット決定ロジック。PSD/PDF とも無ければ TXT マーカーへフォールバック。
  const psdCount = getPages().length;
  const pdfCount = getPdfVirtualPageCount();
  const txtCount = getTxtPageCount();
  let total = 0;
  let current = 0;
  if (getParallelSyncMode()) {
    if (psdCount > 0) { total = psdCount; current = getCurrentPageIndex(); }
    else if (pdfCount > 0) { total = pdfCount; current = getPdfPageIndex(); }
    else if (txtCount > 0) { total = txtCount; current = getPdfPageIndex(); }
  } else if (getActivePane() === "pdf" && pdfCount > 0) {
    total = pdfCount; current = getPdfPageIndex();
  } else if (psdCount > 0) {
    total = psdCount; current = getCurrentPageIndex();
  } else if (pdfCount > 0) {
    total = pdfCount; current = getPdfPageIndex();
  } else if (txtCount > 0) {
    total = txtCount; current = getPdfPageIndex();
  }
  if (label) {
    label.textContent = total > 0 ? `${current + 1} / ${total}` : "– / –";
  }
  const disabled = total === 0;
  if (prev) prev.disabled = disabled || current <= 0;
  if (next) next.disabled = disabled || current >= total - 1;
}

// 矢印キー auto-repeat 時の leading-edge スロットル（80ms = 約 12Hz）。
// 単発タップは throttle 対象外（ハンドラ側で e.repeat 判定して呼び分け）。
const ARROW_REPEAT_THROTTLE_MS = 80;
let lastArrowAdvanceAt = 0;
function canAdvancePageNow() {
  const now = performance.now();
  if (now - lastArrowAdvanceAt < ARROW_REPEAT_THROTTLE_MS) return false;
  lastArrowAdvanceAt = now;
  return true;
}

// 「現在ページ」のソースを判定して { source, total, current } を返す。
// 優先順: PSD pages → PDF 仮想ページ → TXT マーカーページ。null = どれも無し。
// TXT 単体運用時は pdfPageIndex を「閲覧中ページ index」として流用する設計。
export function activePageSource() {
  const psd = getPages().length;
  if (psd > 0) return { source: "psd", total: psd, current: getCurrentPageIndex() };
  const pdf = getPdfVirtualPageCount();
  if (pdf > 0) return { source: "pdf", total: pdf, current: getPdfPageIndex() };
  const txt = getTxtPageCount();
  if (txt > 0) return { source: "txt", total: txt, current: getPdfPageIndex() };
  return null;
}

function setActivePageIndex(source, idx) {
  if (source === "psd") setCurrentPageIndex(idx);
  else setPdfPageIndex(idx); // pdf / txt はどちらも pdfPageIndex 駆動
}

// ページ送り：同期モードなら両側、非同期ならアクティブペインだけ進める。
// 同期中でも PSD 未読込の場合は PDF を直接駆動する（空の PSD index 経由だと
// setCurrentPageIndex が「pages 0 件 → index 0 固定」で何も起こらないため）。
// PDF も無ければ TXT マーカーページ数にフォールバック（pdfPageIndex を流用）。
export function advancePage(delta) {
  if (getParallelSyncMode()) {
    const info = activePageSource();
    if (!info) return;
    const next = Math.max(0, Math.min(info.total - 1, info.current + delta));
    setActivePageIndex(info.source, next);
    return;
  }
  if (getActivePane() === "pdf") {
    const vcount = getPdfVirtualPageCount();
    const next = getPdfPageIndex() + delta;
    const clamped = Math.max(0, Math.min(Math.max(0, vcount - 1), next));
    setPdfPageIndex(clamped);
  } else if (getPages().length > 0) {
    setCurrentPageIndex(getCurrentPageIndex() + delta);
  } else {
    // PSD 無し + PDF 無し時の TXT-only フォールバック（非同期 + activePane=psd の場合）
    const info = activePageSource();
    if (!info) return;
    const next = Math.max(0, Math.min(info.total - 1, info.current + delta));
    setActivePageIndex(info.source, next);
  }
}

function jumpToEdge(where) {
  if (getParallelSyncMode()) {
    const info = activePageSource();
    if (!info) return;
    setActivePageIndex(info.source, where === "first" ? 0 : info.total - 1);
    return;
  }
  if (getActivePane() === "pdf") {
    const vcount = getPdfVirtualPageCount();
    if (vcount === 0) return;
    setPdfPageIndex(where === "first" ? 0 : vcount - 1);
  } else if (getPages().length > 0) {
    const total = getPages().length;
    setCurrentPageIndex(where === "first" ? 0 : total - 1);
  } else {
    const info = activePageSource();
    if (!info) return;
    setActivePageIndex(info.source, where === "first" ? 0 : info.total - 1);
  }
}

// 見本 / PSD ペイン上のマウススクロールでページを送る。
// 同期モード: advancePage で両ペインがブリッジ越しに同時に動く。
// 非同期モード: スクロールしたペインだけを動かす（getActivePane には依存しない）。
// Alt+wheel はズーム、選択レイヤー上の wheel は onLayerWheel がサイズ変更で stopPropagation
// するため、それ以外の wheel イベントだけここで page nav に使う。
function bindWheelPageNav() {
  const pdfArea = document.getElementById("spreads-pdf-area");
  const psdArea = document.getElementById("spreads-psd-area");
  let lastWheelMs = 0;
  const throttleMs = 120;

  const navigate = (pane, delta) => {
    if (getParallelSyncMode()) {
      advancePage(delta);
      return;
    }
    if (pane === "pdf") {
      const vcount = getPdfVirtualPageCount();
      if (vcount > 0) {
        const next = Math.max(0, Math.min(vcount - 1, getPdfPageIndex() + delta));
        setPdfPageIndex(next);
      }
    } else if (getPages().length > 0) {
      setCurrentPageIndex(getCurrentPageIndex() + delta);
    }
  };

  const onWheel = (pane) => (e) => {
    // Alt / Ctrl / Meta は他のハンドラ（ズーム / ブラウザ既定）に委ねる。
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelMs < throttleMs) return;
    lastWheelMs = now;
    const delta = e.deltaY > 0 ? +1 : -1;
    navigate(pane, delta);
  };

  if (pdfArea) pdfArea.addEventListener("wheel", onWheel("pdf"), { passive: false });
  if (psdArea) psdArea.addEventListener("wheel", onWheel("psd"), { passive: false });
}

// 同期モード中は currentPageIndex（PSD）と pdfPageIndex を相互にミラーする。
// 非同期中は各側が独立して動く。再入防止にフラグで一方向の反映に限定。
let syncBridgeBusy = false;
function bindParallelSync() {
  onPageIndexChange((psdIdx) => {
    if (!getParallelSyncMode()) return;
    if (syncBridgeBusy) return;
    if (getPdfPageIndex() === psdIdx) return;
    syncBridgeBusy = true;
    try { setPdfPageIndex(psdIdx); } finally { syncBridgeBusy = false; }
  });
  onPdfPageIndexChange((pdfIdx) => {
    if (!getParallelSyncMode()) return;
    if (syncBridgeBusy) return;
    if (getCurrentPageIndex() === pdfIdx) return;
    syncBridgeBusy = true;
    try { setCurrentPageIndex(pdfIdx); } finally { syncBridgeBusy = false; }
  });
}

function bindActivePaneTracking() {
  const pdfArea = document.getElementById("spreads-pdf-area");
  const psdArea = document.getElementById("spreads-psd-area");
  // 同期/非同期どちらでも activePane は常に追跡（ズーム対象の決定に使う）。
  // リング枠の視覚強調は非同期モードのときだけ。
  pdfArea?.addEventListener("mousedown", () => setActivePane("pdf"), true);
  psdArea?.addEventListener("mousedown", () => setActivePane("psd"), true);
  const apply = () => {
    const asyncMode = !getParallelSyncMode();
    pdfArea?.classList.toggle("active-pane", asyncMode && getActivePane() === "pdf");
    psdArea?.classList.toggle("active-pane", asyncMode && getActivePane() === "psd");
  };
  onParallelSyncModeChange(apply);
  onActivePaneChange(apply);
  apply();
}

// resync モーダル制御
let resyncResolver = null;
function openResyncModal() {
  const modal = document.getElementById("resync-modal");
  if (!modal) return Promise.resolve(null);
  showModalAnimated(modal);
  return new Promise((resolve) => {
    resyncResolver = resolve;
  });
}
function closeResyncModal(result) {
  const modal = document.getElementById("resync-modal");
  if (modal) hideModalAnimated(modal);
  if (resyncResolver) {
    const r = resyncResolver;
    resyncResolver = null;
    r(result);
  }
}
function bindResyncModal() {
  const modal = document.getElementById("resync-modal");
  const cancel = document.getElementById("resync-cancel");
  const keep = document.getElementById("resync-keep");
  const match = document.getElementById("resync-match");
  if (!modal || !cancel || !keep || !match) return;
  cancel.addEventListener("click", () => closeResyncModal("cancel"));
  keep.addEventListener("click", () => closeResyncModal("keep"));
  match.addEventListener("click", () => closeResyncModal("match"));
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) closeResyncModal("cancel");
  });
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeResyncModal("cancel");
    }
  });
}

function bindViewModeControls() {
  const syncOnBtn = document.getElementById("sync-on-btn");
  const syncOffBtn = document.getElementById("sync-off-btn");
  const skipBlankBtn = document.getElementById("skip-first-blank-btn");
  if (!syncOnBtn || !syncOffBtn) return;

  // 先頭白紙ページ除外トグル
  if (skipBlankBtn) {
    const syncSkipUi = () => {
      skipBlankBtn.setAttribute("aria-pressed", getPdfSkipFirstBlank() ? "true" : "false");
    };
    syncSkipUi();
    skipBlankBtn.addEventListener("click", () => {
      // 切替前後で「同じ物理ページ」を維持するため、現在の virtual page の pageNum を保存しておき
      // 切替後にその pageNum に対応する virtual index へ再マップする。
      const cur = getPdfVirtualPageAt(getPdfPageIndex());
      const prevPageNum = cur ? cur.pageNum : null;
      setPdfSkipFirstBlank(!getPdfSkipFirstBlank());
      if (prevPageNum != null) {
        setPdfPageIndex(getPdfVirtualIndexForPhysicalPage(prevPageNum));
      }
    });
    onPdfSkipFirstBlankChange(syncSkipUi);
  }

  // 同期トグル
  syncOnBtn.addEventListener("click", async () => {
    if (getParallelSyncMode()) return;
    const choice = await openResyncModal();
    if (choice === "cancel" || choice == null) return;
    if (choice === "match") {
      // アクティブペイン側の index を非アクティブ側に合わせる。
      const active = getActivePane();
      if (active === "pdf") {
        setCurrentPageIndex(getPdfPageIndex());
      } else {
        setPdfPageIndex(getCurrentPageIndex());
      }
    }
    setParallelSyncMode(true);
  });
  syncOffBtn.addEventListener("click", () => {
    if (!getParallelSyncMode()) return;
    setParallelSyncMode(false);
    setActivePane("psd");
  });

  const syncModeUi = () => {
    const sync = getParallelSyncMode();
    syncOnBtn.classList.toggle("active", sync);
    syncOffBtn.classList.toggle("active", !sync);
    syncOnBtn.setAttribute("aria-pressed", sync ? "true" : "false");
    syncOffBtn.setAttribute("aria-pressed", !sync ? "true" : "false");
  };
  onParallelSyncModeChange(syncModeUi);
  syncModeUi();
}

const VIEW_MODE_LS_KEY = "psdesign_parallel_view_mode";
const EDITOR_LEFT_PANE_LS_KEY = "psdesign_editor_left_pane_mode";

function bindParallelViewMode() {
  const parallelBtn = document.getElementById("view-parallel-btn");
  const proofreadBtn = document.getElementById("view-proofread-btn");
  const editorBtn = document.getElementById("view-editor-btn");
  // ドロワー要素は CSS で制御するため bind は不要だが、初期 DOM の存在確認だけ行う。
  const proofreadArea = document.getElementById("spreads-proofread-area");
  const editorArea = document.getElementById("spreads-editor-area");
  const proofreadPanel = document.getElementById("proofread-panel");
  // editor モード時のみ表示される「校正 / 見本」セグメントトグル。
  // proofread-panel-header 内に配置されている。
  const leftProofreadBtn = document.getElementById("editor-left-proofread-btn");
  const leftPdfBtn = document.getElementById("editor-left-pdf-btn");
  if (!parallelBtn || !proofreadBtn || !editorBtn || !proofreadArea || !editorArea || !proofreadPanel) return;

  try {
    const saved = localStorage.getItem(VIEW_MODE_LS_KEY);
    if (saved === "parallel" || saved === "proofread" || saved === "editor") {
      setParallelViewMode(saved);
    }
  } catch {}

  // editor モード左ペイン (校正 / 見本) の選択を localStorage から復元。
  // editor モードに入ったときだけ実効化される（CSS 側で .workspace.editor-mode が前提）。
  try {
    const savedLeft = localStorage.getItem(EDITOR_LEFT_PANE_LS_KEY);
    if (savedLeft === "proofread" || savedLeft === "pdf") {
      setEditorLeftPaneMode(savedLeft);
    }
  } catch {}

  parallelBtn.addEventListener("click", () => setParallelViewMode("parallel"));
  proofreadBtn.addEventListener("click", () => setParallelViewMode("proofread"));
  editorBtn.addEventListener("click", () => setParallelViewMode("editor"));
  if (leftProofreadBtn) {
    leftProofreadBtn.addEventListener("click", () => setEditorLeftPaneMode("proofread"));
  }
  if (leftPdfBtn) {
    leftPdfBtn.addEventListener("click", () => setEditorLeftPaneMode("pdf"));
  }

  // 3 モード構成:
  //   parallel:  PDF + PSD のみ（proofread / editor ドロワーはどちらも左へ格納）
  //   proofread: PDF + PSD + 校正パネルが左半分にスライドオーバーレイ（PDF area の上）
  //   editor:    PDF/PSD は背景に残し、校正パネル（左）+ エディタ（右）が左からスライドして覆う
  //              サイドバー類は display:none（編集に集中、本リクエスト対象外）
  //
  // proofread-panel は #spreads-proofread-area 内に固定配置。モード切替で DOM を移動しない。
  // ドロワーの slide-in/out は CSS の transform transition + visibility で実装され、
  // .spreads-stage に付ける `proofread-visible` / `editor-visible` クラスで制御する。
  const workspace = document.querySelector(".workspace");
  const stage = document.getElementById("spreads-stage");
  const applyEditorLeftPaneClass = () => {
    if (!workspace) return;
    // editor モード時のみ left-pdf class が意味を持つ。それ以外では常に外す。
    const inEditor = getParallelViewMode() === "editor";
    const leftPdf = inEditor && getEditorLeftPaneMode() === "pdf";
    workspace.classList.toggle("left-pdf", leftPdf);
  };
  const sync = () => {
    const mode = getParallelViewMode();
    const showEditor = mode === "editor";
    const showProofread = mode === "proofread";
    if (workspace) {
      workspace.classList.toggle("editor-mode", showEditor);
      workspace.classList.toggle("proofread-mode", showProofread);
    }
    // ドロワー表示クラス。proofread / editor どちらでも proofread-area は表示する。
    if (stage) {
      stage.classList.toggle("proofread-visible", showProofread || showEditor);
      stage.classList.toggle("editor-visible", showEditor);
    }
    parallelBtn.classList.toggle("active", mode === "parallel");
    proofreadBtn.classList.toggle("active", mode === "proofread");
    editorBtn.classList.toggle("active", mode === "editor");
    parallelBtn.setAttribute("aria-pressed", mode === "parallel" ? "true" : "false");
    proofreadBtn.setAttribute("aria-pressed", mode === "proofread" ? "true" : "false");
    editorBtn.setAttribute("aria-pressed", mode === "editor" ? "true" : "false");
    try { localStorage.setItem(VIEW_MODE_LS_KEY, mode); } catch {}
    // editor モード ON/OFF に応じて left-pdf class も更新（editor モード以外では常に外す）。
    applyEditorLeftPaneClass();

    // 校正パネルの内部状態（panel 表示）を確保。parent (.spreads-proofread-area) の
    // opacity / transform で実際の表示制御を行うため、panel 自体は閉じない（閉じると
    // スライドアウト中に内容が瞬時に display:none になり、空のドロワーが滑る不格好な
    // アニメになる）。closeProofread は呼ばない。
    if (showProofread || showEditor) openProofread();

    if (showEditor) focusEditor();
  };
  onParallelViewModeChange(sync);

  // 「見本」モード時に pdf-area の幅を現在の見本ページの実アスペクト比に同期する。
  // 50% 固定だと縦長ページで letter-box / 横長ページで切れる「ぎこちない表示」になる。
  // - stage 高さ - ヘッダー (34px) を基準に width = (height - padding) * AR + padding
  // - 結果を CSS 変数 `--left-pdf-width` に書き込み、pdf-area / editor-area の両方が参照
  // - rAF で coalesce、async getPage() の競合は seq token で抑止
  // - syncEditorLeftPane より前に定義する必要あり (sync 初回呼出で requestRecompute を参照するため、
  //   後置すると const TDZ エラーで init が止まり renderAllSpreads が走らない事故あり)
  const PANEL_PADDING = 32; // pdf-area の左右 padding 16+16
  const HEADER_OFFSET = 34; // proofread-panel-header 高さ
  const MIN_PANEL_WIDTH = 240;
  const MAX_PANEL_RATIO = 0.85; // stage 幅の最大 85%
  let leftPdfRecomputeRaf = 0;
  let leftPdfRecomputeSeq = 0;

  const clearLeftPdfWidth = () => {
    if (workspace) workspace.style.removeProperty("--left-pdf-width");
  };

  const recomputeLeftPdfWidth = async () => {
    if (!workspace) return;
    // editor モード以外では使わない（var を消して通常 50% に戻す）。
    // editor モード中は left-pdf サブ状態でなくても先行計算しておくと、
    // 「見本」トグルした瞬間に CSS var が既に正しい値になっていて 50% フラッシュが起きない。
    const inEditor = getParallelViewMode() === "editor";
    if (!inEditor) {
      clearLeftPdfWidth();
      return;
    }
    if (!stage) {
      clearLeftPdfWidth();
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    if (stageRect.height <= 0 || stageRect.width <= 0) return;

    const doc = getPdfDoc();
    const vp = getPdfVirtualPageAt(getPdfPageIndex());
    if (!doc || !vp) {
      // 見本未読込 / 範囲外: 50% フォールバック（CSS デフォルト）。
      clearLeftPdfWidth();
      return;
    }

    const seq = ++leftPdfRecomputeSeq;
    let page;
    try {
      page = await doc.getPage(vp.pageNum);
    } catch {
      return;
    }
    // 競合 (新しい recompute が来た) なら破棄。
    if (seq !== leftPdfRecomputeSeq) return;
    // editor モードを抜けていたら破棄して var クリア。
    if (getParallelViewMode() !== "editor") {
      clearLeftPdfWidth();
      return;
    }

    const baseRot = typeof page.rotate === "number" ? page.rotate : 0;
    const totalRot = (((baseRot + getPdfRotation()) % 360) + 360) % 360;
    const viewport0 = page.getViewport({ scale: 1, rotation: totalRot });
    const isLandscape = viewport0.width > viewport0.height;
    const wantsSplit = vp.side === "left" || vp.side === "right";
    const side = wantsSplit && isLandscape ? vp.side : "full";
    const fullAR = viewport0.width / viewport0.height;
    const ar = side === "full" ? fullAR : fullAR / 2;

    const availH = Math.max(0, stageRect.height - HEADER_OFFSET - PANEL_PADDING);
    const targetCanvasW = availH * ar;
    const targetPanelW = targetCanvasW + PANEL_PADDING;
    const maxW = stageRect.width * MAX_PANEL_RATIO;
    const finalW = Math.max(MIN_PANEL_WIDTH, Math.min(maxW, targetPanelW));

    workspace.style.setProperty("--left-pdf-width", `${Math.round(finalW)}px`);
  };

  const requestRecomputeLeftPdfWidth = () => {
    if (leftPdfRecomputeRaf) cancelAnimationFrame(leftPdfRecomputeRaf);
    leftPdfRecomputeRaf = requestAnimationFrame(() => {
      leftPdfRecomputeRaf = 0;
      recomputeLeftPdfWidth();
    });
  };

  // recompute トリガー一覧:
  // - PDF (見本) ロード変化、ページ切替、回転 → アスペクト比が変わる
  // - parallel view mode 変化 → editor モード入退出
  // - 既に editor.left-pdf に居る状態でも初回 sync で呼ぶ必要があるので↑の sync 経路でも発火
  // - stage の resize → 高さ依存なのでウィンドウサイズに追従
  onPdfChange(requestRecomputeLeftPdfWidth);
  onPdfPageIndexChange(requestRecomputeLeftPdfWidth);
  onPdfRotationChange(requestRecomputeLeftPdfWidth);
  onParallelViewModeChange(requestRecomputeLeftPdfWidth);
  if (typeof ResizeObserver !== "undefined" && stage) {
    const ro = new ResizeObserver(requestRecomputeLeftPdfWidth);
    ro.observe(stage);
  }
  // 初期同期。
  requestRecomputeLeftPdfWidth();

  // editor モードの左ペイン (校正 / 見本) 切替の同期。
  // - workspace.classList の left-pdf を更新（CSS で表示切替）
  // - セグメントボタンの active / aria-pressed を更新
  // - localStorage に永続化
  // - requestRecomputeLeftPdfWidth を呼ぶので、必ずそれが定義された後に書く。
  const syncEditorLeftPane = () => {
    const m = getEditorLeftPaneMode();
    applyEditorLeftPaneClass();
    if (leftProofreadBtn) {
      leftProofreadBtn.classList.toggle("active", m === "proofread");
      leftProofreadBtn.setAttribute("aria-pressed", m === "proofread" ? "true" : "false");
    }
    if (leftPdfBtn) {
      leftPdfBtn.classList.toggle("active", m === "pdf");
      leftPdfBtn.setAttribute("aria-pressed", m === "pdf" ? "true" : "false");
    }
    try { localStorage.setItem(EDITOR_LEFT_PANE_LS_KEY, m); } catch {}
    requestRecomputeLeftPdfWidth();
  };
  onEditorLeftPaneModeChange(syncEditorLeftPane);
  syncEditorLeftPane();
  sync();
}

// 【v1.16.0】フォントサイズ一部変更 — 選択範囲があれば per-char、無ければ layer 全体に適用。
function applyTextSize(n) {
  // in-place 編集中で文字選択がある → per-char サイズ適用。
  // 選択範囲は canvas-tools の module-level キャッシュから取る（select イベントで保存される）。
  const sel = getLastInplaceSelection();
  if (sel && sel.end > sel.start) {
    const v = clampSize(n);
    const targetId = sel.tempId ?? sel.layerId;
    setCharSizesRange(sel.psdPath, targetId, sel.start, sel.end, v);
    // 【v1.21.0】編集中の DOM にも即時反映: span でラップして fontSize を em 比で当てる。
    // layer の defaultSizePt を取得して em 比 = v / defaultSizePt を求める。
    const defaultSizePt = resolveLayerDefaultSizePt(sel);
    if (defaultSizePt > 0) {
      const ratio = v / defaultSizePt;
      applyEditModeStyleToRange(sel.start, sel.end, { fontSize: `${ratio}em` });
    }
    refreshAllOverlays();
    rebuildLayerList();
    setTextSize(v); // サイドバー入力欄の値も同期
    return;
  }
  setTextSize(n);
  // 選択中の全レイヤーに同じサイズを適用（複数選択でも一括反映）。
  commitSizeToSelections(getTextSize());
}

// per-char サイズ変更で em 比換算に使う「対象レイヤーの defaultSizePt」を解決。
function resolveLayerDefaultSizePt(sel) {
  if (!sel) return 0;
  const pages = getPages();
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    if (page.path !== sel.psdPath) continue;
    if (typeof sel.layerId === "number") {
      const layer = page.textLayers.find((l) => l.id === sel.layerId);
      if (!layer) return 0;
      const edit = getEdit(page.path, layer.id) ?? {};
      // ↓ getExistingLayerEffectiveSizePt は canvas-tools.js から既に import 済み
      return getExistingLayerEffectiveSizePt(page, layer, edit) || 0;
    }
    if (typeof sel.tempId === "string") {
      const nl = page.textLayers; // 不要、newLayers から探す
      // newLayers は state から
      // import 経由で getNewLayersForPsd を使う必要があるが既に import 済み
      const list = (typeof getNewLayersForPsd === "function") ? getNewLayersForPsd(page.path) : [];
      const item = list.find((l) => l.tempId === sel.tempId);
      return item?.sizePt ?? 0;
    }
  }
  return 0;
}

function clampSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return getTextSize();
  return Math.max(6, Math.min(999, Math.round(v * 10) / 10));
}

function getSizeStep() {
  const v = Number(getDefault("textSizeStep"));
  return v === 0.5 ? 0.5 : 0.1;
}

// +/- ボタンと [/] ショートカット用のサイズ調整。
// 環境設定の baseStep（0.1 / 0.5）グリッドに揃える形でスナップする：
// 例）0.5 刻み設定で現在 12.3pt → "+" で 12.5（13.0 ではない）／"-" で 12.0
function stepTextSize(sign, multiplier = 1) {
  const baseStep = getSizeStep();
  const next = snapNextSize(getTextSize(), baseStep, sign, multiplier);
  applyTextSize(next);
}

// 【v1.22.0】合成太字（faux bold）トグルボタン。Photoshop の Character パネル B ボタン相当。
// in-place 編集中で文字選択あり → per-char (charBolds)、無ければ layer 全体 (syntheticBold)。
// クリック時の現在 aria-pressed 値を反転させ、新値を適用する。populateEditor が
// computeCommonBold で aria-pressed を同期するので、選択切替・複数選択時も正しく追従。
function bindBoldToggle() {
  const btn = document.getElementById("bold-toggle-btn");
  if (!btn) return;
  // mousedown.preventDefault で contenteditable のフォーカス移動を抑止し、in-place 編集中の
  // 文字選択を保ったまま B をクリックできるようにする（commitFontToSelections の bind パターンと同じ）。
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const newValue = btn.getAttribute("aria-pressed") !== "true";
    // 1. in-place 編集中の文字選択 → per-char 適用
    const sel = getLastInplaceSelection();
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      setCharBoldsRange(sel.psdPath, targetId, sel.start, sel.end, newValue);
      // 編集中の DOM にも即時反映: span ラップで font-weight を当てる。
      applyEditModeStyleToRange(sel.start, sel.end, { fontWeight: newValue ? "700" : "400" });
      refreshAllOverlays();
      rebuildLayerList();
      // ボタン表示: 範囲の bold 値を即座に反映（commit 後の populateEditor 経由でも同じだが visual lag を避ける）。
      btn.setAttribute("aria-pressed", newValue ? "true" : "false");
      return;
    }
    // 2. layer 選択 → per-layer 適用（既存の commitFontToSelections と同じ流れ）
    if (commitBoldToSelections(newValue)) {
      btn.setAttribute("aria-pressed", newValue ? "true" : "false");
    }
  });
}

// 【v1.26.0】ルビパネル。in-place 編集中の文字選択範囲 + ふりがな入力 → 「適用」ボタンで
// charRubies に書き込む。モノ/グループ自動判定は「入力にスペースあり and 分割数 == 親文字数」
// のときモノ、それ以外グループ。手動 mode (自動/モノ/グループ) で強制も可。
function bindRubyTool() {
  const parentEl = document.getElementById("ruby-parent-display");
  const inputEl = document.getElementById("ruby-text-input");
  const scaleEl = document.getElementById("ruby-scale-input");
  const applyBtn = document.getElementById("ruby-apply-btn");
  const removeBtn = document.getElementById("ruby-remove-btn");
  const modeAuto = document.getElementById("ruby-mode-auto-btn");
  const modeMono = document.getElementById("ruby-mode-mono-btn");
  const modeGroup = document.getElementById("ruby-mode-group-btn");
  if (!parentEl || !inputEl || !applyBtn || !removeBtn) return;

  let currentMode = "auto"; // "auto" | "mono" | "group"

  // フォーカスを盗まないように mousedown を抑制（in-place 編集を保護）。
  // ただし input 系（ふりがな + scale）は通常通りフォーカスを許可する。
  const noFocusSteal = (el) => el && el.addEventListener("mousedown", (e) => e.preventDefault());
  [applyBtn, removeBtn, modeAuto, modeMono, modeGroup].forEach(noFocusSteal);

  const setMode = (m) => {
    currentMode = m;
    [
      [modeAuto, "auto"],
      [modeMono, "mono"],
      [modeGroup, "group"],
    ].forEach(([b, k]) => {
      if (b) b.classList.toggle("active", k === m);
    });
  };
  modeAuto?.addEventListener("click", () => setMode("auto"));
  modeMono?.addEventListener("click", () => setMode("mono"));
  modeGroup?.addEventListener("click", () => setMode("group"));

  const clampRubyScale = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return 50;
    return Math.max(20, Math.min(100, Math.round(v / 5) * 5));
  };

  const decideRubyType = (mode, text, parentText) => {
    if (mode === "mono") return "mono";
    if (mode === "group") return "group";
    // auto
    if (/[ 　]/.test(text)) {
      const parts = text.split(/[ 　]+/);
      if (parts.length === parentText.length) return "mono";
    }
    return "group";
  };

  // 【v1.29.x】親文字選択時に行 index を表示するためのラベル
  const lineHintEl = document.getElementById("ruby-line-hint");

  // 文字選択変化で親文字表示と入力欄の有効化を切替
  const updateSelection = (sel) => {
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      const ec = getEditingContext();
      const contents = ec?.contents ?? "";
      const parentText = contents.substring(sel.start, sel.end);
      parentEl.textContent = parentText || "（選択範囲）";
      inputEl.disabled = false;
      applyBtn.disabled = false;
      // 【v1.29.x】親文字が乗る行 index を計算 (0-based) → ユーザーには 1-based で表示
      const startLine = (contents.substring(0, sel.start).match(/\n/g) ?? []).length;
      const endLine = (contents.substring(0, sel.end).match(/\n/g) ?? []).length;
      if (lineHintEl) {
        const lineLabel = startLine === endLine
          ? `${startLine + 1} 行目`
          : `${startLine + 1}〜${endLine + 1} 行目`;
        lineHintEl.textContent = lineLabel;
        lineHintEl.hidden = false;
      }
      // 既存ルビがあれば入力欄に reload
      const existing = getCharRubyAt(sel.psdPath, targetId, sel.start);
      if (existing && existing.end === sel.end) {
        inputEl.value = existing.text;
        if (existing.scale) scaleEl.value = String(existing.scale);
        if (existing.type) setMode(existing.type);
        removeBtn.disabled = false;
      } else {
        inputEl.value = "";
        removeBtn.disabled = !rangeHasAnyRuby(sel.psdPath, targetId, sel.start, sel.end);
      }
    } else {
      parentEl.innerHTML = '<span class="ruby-parent-empty">文字を選択</span>';
      if (lineHintEl) { lineHintEl.textContent = ""; lineHintEl.hidden = true; }
      inputEl.disabled = true;
      applyBtn.disabled = true;
      removeBtn.disabled = true;
      inputEl.value = "";
    }
  };
  onInplaceSelectionChange(updateSelection);
  updateSelection(getLastInplaceSelection());

  // 適用
  const doApply = () => {
    const sel = getLastInplaceSelection();
    if (!sel || sel.end <= sel.start) return;
    const text = inputEl.value.trim();
    if (!text) return;
    const targetId = sel.tempId ?? sel.layerId;
    const parentText = parentEl.textContent || "";
    const scale = clampRubyScale(scaleEl.value);
    const type = decideRubyType(currentMode, text, parentText);
    // 【v1.29.0】ルビ適用と同時に、ルビが乗る行の lineLeading を rubyLeadingPct
    // (デフォルト 150%) に上書き。同一 history snapshot にまとめ Ctrl+Z 一発で
    // ルビ + leading 両方戻る。
    // 行 index = 親文字 range の手前にある改行数。複数行に跨ぐ ruby は range 開始行のみ更新。
    const ec = getEditingContext();
    const contents = ec?.contents ?? "";
    const startLine = (contents.substring(0, sel.start).match(/\n/g) ?? []).length;
    const endLine = (contents.substring(0, sel.end).match(/\n/g) ?? []).length;
    const rubyLeadingPct = Number(getDefault("rubyLeadingPct")) || 150;
    console.info(
      `[ruby-apply] 親文字 range=[${sel.start}, ${sel.end}) → ${startLine + 1}〜${endLine + 1} 行目 / lineLeading=${rubyLeadingPct}%`,
    );
    withHistoryTransient(() => {
      setCharRubiesRange(sel.psdPath, targetId, sel.start, sel.end, text, type, scale);
      // 親文字 range が跨ぐすべての行に rubyLeadingPct を当てる。
      for (let li = startLine; li <= endLine; li++) {
        setLineLeading(sel.psdPath, targetId, li, rubyLeadingPct);
      }
    });
    // 【v1.29.x】編集中レイヤー DOM への即時 line-height 反映。
    //   renderOverlay は .editing レイヤーをスキップする (caret 保護のため)。
    //   state.lineLeadings の変更を画面に反映するには、編集中 inner の style を直接更新する必要がある。
    //   ここでは簡易的に inner 全体の line-height を rubyLeadingPct に上書きする
    //   (per-line ではなく per-layer の簡易適用)。編集モードを抜けると renderOverlay が
    //   per-line lineLeadings を正確に反映するので、その時点でズレが解消される。
    const editingBox = document.querySelector(".layer-box.editing");
    if (editingBox) {
      const inner = editingBox.querySelector(".existing-layer-text, .new-layer-text");
      if (inner) {
        inner.style.lineHeight = String(rubyLeadingPct / 100);
      }
    }
    // 編集中 DOM への即時反映（実 DOM ルビ wrap を inner に挿入）。
    applyEditModeRubyToRange(sel.start, sel.end, text, type, scale);
    refreshAllOverlays();
    rebuildLayerList();
    removeBtn.disabled = false;
  };
  applyBtn.addEventListener("click", doApply);

  // 削除
  removeBtn.addEventListener("click", () => {
    const sel = getLastInplaceSelection();
    if (!sel || sel.end <= sel.start) return;
    const targetId = sel.tempId ?? sel.layerId;
    withHistoryTransient(() => {
      setCharRubiesRange(sel.psdPath, targetId, sel.start, sel.end, "", "group", 50);
    });
    refreshAllOverlays();
    rebuildLayerList();
    inputEl.value = "";
    removeBtn.disabled = true;
  });

  // Enter で apply、Esc でクリア
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      doApply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      inputEl.value = "";
    }
  });
}

function bindSizeTool() {
  const input = document.getElementById("size-input");
  const dec = document.getElementById("size-dec-btn");
  const inc = document.getElementById("size-inc-btn");
  if (!input || !dec || !inc) return;

  const applyStepAttr = () => {
    input.step = String(getSizeStep());
  };
  applyStepAttr();
  onSettingsChange(applyStepAttr);

  input.value = String(getTextSize());
  onTextSizeChange((v) => {
    if (document.activeElement !== input) input.value = String(v);
  });

  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    applyTextSize(v);
  });
  input.addEventListener("blur", () => {
    input.value = String(getTextSize());
  });
  dec.addEventListener("click", () => stepTextSize(-1));
  inc.addEventListener("click", () => stepTextSize(+1));
}

// 行間を適用。in-place 編集中（editingContext あり）はカーソル行の per-line override に
// 書き込み、そうでなければ従来どおり layer 全体の leadingPct を更新する。
function applyLeading(n) {
  const v = clampLeading(n);
  // 1. in-place 編集中はカーソル行の per-line override（既存挙動）
  const ec = getEditingContext();
  if (ec) {
    const targetId = ec.tempId ?? ec.layerId;
    setLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0, v);
    refreshAllOverlays();
    rebuildLayerList();
    syncLeadingInputForEditingContext();
    return;
  }
  // 2. 通常モード（in-place 編集なし）: 選択中レイヤー全体に一括適用 + global leadingPct 更新。
  //    旧サイドバー行セレクタ（「全行 / 2 / 3 / …」ボタン）による per-line override は廃止。
  //    in-place 編集中のカーソル行のみが per-line 対象。
  setLeadingPct(v);
  commitLeadingToSelections(getLeadingPct());
}
function clampLeading(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return getLeadingPct();
  return Math.max(50, Math.min(500, Math.round(v)));
}

function adjustLeading(delta) {
  const ec = getEditingContext();
  if (ec) {
    const targetId = ec.tempId ?? ec.layerId;
    const cur = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
    applyLeading(cur + delta);
    return;
  }
  applyLeading(getLeadingPct() + delta);
}

// editingContext が active のときは leading-input にカーソル行の値を表示。
// 行ごとの override が無ければレイヤー global の leadingPct を表示する。
function syncLeadingInputForEditingContext() {
  const input = document.getElementById("leading-input");
  if (!input) return;
  const ec = getEditingContext();
  if (!ec) return;
  const targetId = ec.tempId ?? ec.layerId;
  const v = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
  if (document.activeElement !== input) input.value = String(v);
}

function bindLeadingTool() {
  const input = document.getElementById("leading-input");
  const dec = document.getElementById("leading-dec-btn");
  const inc = document.getElementById("leading-inc-btn");
  if (!input || !dec || !inc) return;

  input.value = String(getLeadingPct());
  onLeadingPctChange((v) => {
    if (document.activeElement !== input) input.value = String(v);
  });

  input.addEventListener("input", () => {
    const v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) return;
    applyLeading(v);
  });
  input.addEventListener("blur", () => {
    // editingContext (in-place 編集中) ならカーソル行の per-line 値、それ以外は global。
    const ec = getEditingContext();
    if (ec) {
      const targetId = ec.tempId ?? ec.layerId;
      const v = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
      input.value = String(v);
      return;
    }
    input.value = String(getLeadingPct());
  });
  // ボタン群は in-place 編集 textarea からのフォーカス移動を抑止する。これがないと
  // + を押すたびに textarea が blur → カーソル行が失われ、editingContext が消える。
  const keepFocus = (el) => el && el.addEventListener("mousedown", (e) => e.preventDefault());
  keepFocus(dec); keepFocus(inc);
  dec.addEventListener("click", () => adjustLeading(-5));
  inc.addEventListener("click", () => adjustLeading(+5));

  // in-place 編集の context 変化に追従して input/ボタンの表示を更新。
  // context が立つ → カーソル行の per-line 値（無ければ global）を表示。
  // context が消える → global 値に戻す。
  // 旧 `syncRuby(leadingPct)` 呼出は v1.16.0 期の「leadingPct >= 150 でルビトグル active」
  // 機構の残骸で、ルビ panel が独自 state（charRubies）に移行した時点で dead code 化していた
  // が、未参照のままコードに残って `ReferenceError` を起こしていた。撤去済み。
  onEditingContextChange((ec) => {
    if (ec) {
      syncLeadingInputForEditingContext();
    } else {
      input.value = String(getLeadingPct());
    }
  });
}

async function handleDroppedPaths(paths) {
  if (!paths || paths.length === 0) return;
  const psdFiles = [];
  const txtFiles = [];
  const pdfFiles = []; // PDF / JPEG / PNG いずれも「見本」としてここに入れる
  const unknowns = []; // 拡張子なし ＝ おそらくフォルダ
  for (const p of paths) {
    if (/\.psd$/i.test(p)) psdFiles.push(p);
    else if (/\.txt$/i.test(p)) txtFiles.push(p);
    else if (/\.(pdf|jpe?g|png)$/i.test(p)) pdfFiles.push(p);
    else unknowns.push(p);
  }
  // フォルダらしきものは中の .psd を展開して取り込む（従来の利便性を維持）。
  for (const folder of unknowns) {
    try {
      const files = await listPsdFilesInFolder(folder);
      if (Array.isArray(files) && files.length) psdFiles.push(...files);
    } catch (e) {
      console.warn("フォルダ展開に失敗:", folder, e);
    }
  }
  if (psdFiles.length > 0) {
    await loadPsdFilesByPaths(psdFiles);
  }
  for (const t of txtFiles) {
    await loadTxtFromPath(t);
  }
  if (pdfFiles.length > 0) {
    // 複数ファイルは合成 doc としてまとめて読み込む（自然順 = page1 → page2 → page10）。
    await loadReferenceFiles(pdfFiles);
  }
}

async function setupTauriDragDrop() {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const overlay = document.getElementById("drag-overlay");
    const showOverlay = () => {
      if (!overlay) return;
      overlay.classList.remove("flash");
      overlay.classList.add("active");
    };
    const hideOverlay = () => overlay?.classList.remove("active");
    const flashOverlay = () => {
      if (!overlay) return;
      overlay.classList.remove("active");
      overlay.classList.remove("flash");
      // 同フレームの re-add でアニメーションを確実に再発火
      void overlay.offsetWidth;
      overlay.classList.add("flash");
      setTimeout(() => overlay.classList.remove("flash"), 400);
    };

    await listen("tauri://drag-enter", showOverlay);
    await listen("tauri://drag-over", showOverlay);
    await listen("tauri://drag-leave", hideOverlay);
    await listen("tauri://drag-drop", (e) => {
      flashOverlay();
      const paths = Array.isArray(e.payload?.paths) ? e.payload.paths : [];
      handleDroppedPaths(paths).catch((err) => console.error(err));
    });
  } catch (e) {
    console.warn("drag-drop listener failed:", e);
  }
}

// アクティブペイン基準のズーム操作（ボタン・キーボード）
function zoomActivePaneBy(factor) {
  zoomPaneBy(getActivePane(), factor);
}
function resetActivePaneZoom() {
  resetPaneZoom(getActivePane());
}
function zoomPaneBy(pane, factor) {
  if (pane === "pdf") setPdfZoom(getPdfZoom() * factor);
  else setPsdZoom(getPsdZoom() * factor);
}
function resetPaneZoom(pane) {
  if (pane === "pdf") setPdfZoom(1);
  else setPsdZoom(1);
}

// 定規ボタンの click + ON/OFF 表示同期 + Ctrl+R の WebView リロード抑止。
// Ctrl+R は WebView2 の既定リロードに先取りされやすいので、bindZoomTool と同じく
// capture フェーズで matchShortcut("toggleRulers") を判定して preventDefault。
function bindRulerToggle() {
  const btn = document.getElementById("toggle-rulers-btn");
  const sync = () => {
    if (!btn) return;
    const on = getRulersVisible();
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  };
  if (btn) btn.addEventListener("click", () => toggleRulersVisible());
  onRulersVisibleChange(sync);
  sync();

  window.addEventListener(
    "keydown",
    (e) => {
      if (matchShortcut(e, "toggleRulers")) {
        toggleRulersVisible();
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
}

// V ツール直下の「新規テキスト方向」スイッチ (縦型トグル)。
// 1 つのスイッチをクリックすると縦↔横が切替わる。
// localStorage 永続化 + aria-checked 同期 (CSS が thumb 位置 / icon 色を担当)。
const NEW_TEXT_DIR_LS_KEY = "psdesign_new_text_direction";
function bindNewTextDirectionToggle() {
  const sw = document.getElementById("new-text-dir-switch");
  if (!sw) return;

  // 起動時: localStorage から復元
  try {
    const saved = localStorage.getItem(NEW_TEXT_DIR_LS_KEY);
    if (saved === "vertical" || saved === "horizontal") {
      setNewTextDirection(saved);
    }
  } catch {}

  const sync = () => {
    const dir = getNewTextDirection();
    const isV = dir === "vertical";
    sw.setAttribute("aria-checked", isV ? "true" : "false");
    sw.setAttribute(
      "aria-label",
      isV ? "新規テキストの方向: 縦書き" : "新規テキストの方向: 横書き",
    );
  };
  sync();
  onNewTextDirectionChange((dir) => {
    sync();
    try { localStorage.setItem(NEW_TEXT_DIR_LS_KEY, dir); } catch {}
  });

  sw.addEventListener("click", () => {
    setNewTextDirection(getNewTextDirection() === "vertical" ? "horizontal" : "vertical");
  });
}

function bindZoomTool() {
  const out = document.getElementById("zoom-out-btn");
  const inn = document.getElementById("zoom-in-btn");
  const level = document.getElementById("zoom-level-btn");
  const pdfArea = document.getElementById("spreads-pdf-area");
  const psdArea = document.getElementById("spreads-psd-area");
  if (!out || !inn || !level) return;

  const paneLabel = (pane) => (pane === "pdf" ? "PDF" : "PSD");
  const updateLevel = () => {
    const pane = getActivePane();
    const z = pane === "pdf" ? getPdfZoom() : getPsdZoom();
    level.textContent = `${paneLabel(pane)} ${Math.round(z * 100)}%`;
    level.title = `${paneLabel(pane)} を 100% にリセット`;
  };
  updateLevel();
  onPdfZoomChange(updateLevel);
  onPsdZoomChange(updateLevel);
  onActivePaneChange(updateLevel);

  out.addEventListener("click", () => zoomActivePaneBy(1 / 1.15));
  inn.addEventListener("click", () => zoomActivePaneBy(1.15));
  level.addEventListener("click", () => resetActivePaneZoom());

  // Alt+wheel はカーソルが乗っているペインをズーム（active-pane には依存しない方が直感的）。
  const attachWheel = (area, pane) => {
    if (!area) return;
    area.addEventListener(
      "wheel",
      (e) => {
        if (!e.altKey) return;
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
        zoomPaneBy(pane, factor);
      },
      { passive: false },
    );
  };
  attachWheel(pdfArea, "pdf");
  attachWheel(psdArea, "psd");

  window.addEventListener(
    "keydown",
    (e) => {
      // ズーム系は WebView2 の既定ページズームに先取りされるため capture フェーズで拾う。
      // 環境設定のキーを matchShortcut で照合してから handle。
      let handled = false;
      if (matchShortcut(e, "zoomIn")) { zoomActivePaneBy(1.15); handled = true; }
      else if (matchShortcut(e, "zoomOut")) { zoomActivePaneBy(1 / 1.15); handled = true; }
      else if (matchShortcut(e, "zoomReset")) { resetActivePaneZoom(); handled = true; }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
}

// ページジャンプ対象は activePane を優先し、無効なら片方にフォールバック。
// PDF 側を選んだ場合は仮想ページ番号（単ページ化時は見開き分割後の番号）でジャンプする。
let pageJumpTarget = "psd"; // "psd" | "pdf"

function decidePageJumpTarget() {
  const psdHas = getPages().length > 0;
  const pdfHas = getPdfVirtualPageCount() > 0;
  const txtHas = getTxtPageCount() > 0;
  const preferred = getActivePane();
  if (preferred === "pdf" && pdfHas) {
    return { kind: "pdf", total: getPdfVirtualPageCount(), current: getPdfPageIndex(), label: "PDF" };
  }
  if (preferred === "psd" && psdHas) {
    return { kind: "psd", total: getPages().length, current: getCurrentPageIndex(), label: "PSD" };
  }
  if (psdHas) return { kind: "psd", total: getPages().length, current: getCurrentPageIndex(), label: "PSD" };
  if (pdfHas) return { kind: "pdf", total: getPdfVirtualPageCount(), current: getPdfPageIndex(), label: "PDF" };
  // PSD/PDF とも無ければ TXT マーカーへフォールバック (pdfPageIndex を流用)
  if (txtHas) return { kind: "pdf", total: getTxtPageCount(), current: getPdfPageIndex(), label: "テキスト" };
  return null;
}

function openPageJumpDialog() {
  const target = decidePageJumpTarget();
  if (!target) {
    toast("ページが読み込まれていません", { kind: "info", duration: 1800 });
    return;
  }
  pageJumpTarget = target.kind;
  const modal = document.getElementById("page-jump-modal");
  const input = document.getElementById("page-jump-input");
  const hint = document.getElementById("page-jump-hint");
  if (!modal || !input) return;
  input.max = String(target.total);
  input.value = String(target.current + 1);
  if (hint) hint.textContent = `${target.label} ページ：1 〜 ${target.total} を入力してください`;
  showModalAnimated(modal);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closePageJumpDialog() {
  const modal = document.getElementById("page-jump-modal");
  if (modal) hideModalAnimated(modal);
}

function commitPageJump() {
  const input = document.getElementById("page-jump-input");
  if (!input) return;
  const v = parseInt(input.value, 10);
  if (Number.isFinite(v)) {
    if (pageJumpTarget === "pdf") setPdfPageIndex(v - 1);
    else setCurrentPageIndex(v - 1);
  }
  closePageJumpDialog();
}

function bindPageJumpDialog() {
  const modal = document.getElementById("page-jump-modal");
  const ok = document.getElementById("page-jump-ok");
  const cancel = document.getElementById("page-jump-cancel");
  const input = document.getElementById("page-jump-input");
  if (!modal || !ok || !cancel || !input) return;
  ok.addEventListener("click", commitPageJump);
  cancel.addEventListener("click", closePageJumpDialog);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) closePageJumpDialog();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPageJump();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePageJumpDialog();
    }
  });
}

function bindWindowControls() {
  const min = document.getElementById("window-min-btn");
  const max = document.getElementById("window-max-btn");
  const close = document.getElementById("window-close-btn");
  if (!min || !max || !close) return;
  const getWin = async () => {
    const mod = await import("@tauri-apps/api/window");
    return mod.getCurrentWindow();
  };
  min.addEventListener("click", async () => { (await getWin()).minimize(); });
  max.addEventListener("click", async () => { (await getWin()).toggleMaximize(); });
  close.addEventListener("click", async () => { (await getWin()).close(); });
}

function init() {
  document.getElementById("open-folder-btn").addEventListener("click", handleOpenFiles);
  document.getElementById("open-pdf-btn")?.addEventListener("click", handleOpenPdf);
  bindSaveMenu();
  bindHistoryButtons();
  initHamburgerMenu();
  bindTools();
  bindSizeTool();
  bindLeadingTool();
  bindBoldToggle();
  bindRubyTool();
  bindZoomTool();
  bindPageChange();
  bindStylePalette();
  bindEditorEvents();
  bindWindowControls();
  bindPageJumpDialog();
  initTxtSource();
  bindAiInstallMenu();
  bindFirstRunSetup();
  bindAiOcrButton();
  bindAiPlaceButton();
  bindPositionAdjustButton();
  bindProofreadUi();
  bindAutoUpdater();
  bindPageNav();
  bindCollapseToggles();
  bindSidePanelTabs();
  bindLayersDrawer();
  bindPdfWorkspaceToggle();
  bindPdfRotate();
  bindPsdRotate();
  updatePsdRotateVisibility();
  bindPsdGuidesLock();
  updatePsdGuidesLockVisibility();
  bindPsdGuidesApply();
  updatePsdGuidesApplyVisibility();
  mountPdfView();
  setupTauriDragDrop();
  bindParallelSync();
  bindWheelPageNav();
  bindActivePaneTracking();
  bindResyncModal();
  bindViewModeControls();
  // editor pane の初期化を view-mode 切替より先に行う。
  // bindParallelViewMode の sync() が editor モードで focusEditor() を呼ぶ前に
  // textarea を syncFromState() で正しい状態にしておく。
  bindEditorPane();
  bindParallelViewMode();
  initSettingsUi();
  // 環境設定の「デフォルト」（文字サイズ・行間・フチ太さ・フォント）をツール初期値に反映。
  applyToolDefaults();
  // 【v1.29.0】ルビあり行間 (%) を CSS variable で全体に伝達。
  //   styles.css の .ruby-text transform で「親文字行と前の行のちょうど中間」位置を計算する。
  //   設定 (写植設定タブ → ルビあり行間) を変えると即時更新。
  // 【v1.29.x】さらに --ruby-parent-offset-em (UI 親寄せ em) も同期する。
  //   これにより設定値の変更がビューアー上のルビ位置に即時反映される。
  //   Photoshop 側の親寄せ em / 親離し px は exportEdits 経由で payload に乗る (後段)。
  const applyRubyCssVars = () => {
    const pct = Number(getDefault("rubyLeadingPct")) || 150;
    document.documentElement.style.setProperty("--ruby-row-leading-pct", String(pct));
    const uiOffsetEm = Number(getDefault("rubyParentOffsetEm"));
    document.documentElement.style.setProperty(
      "--ruby-parent-offset-em",
      Number.isFinite(uiOffsetEm) ? String(uiOffsetEm) : "0",
    );
    // 既存レイヤーの ruby-text 位置を即時再描画 (CSS variable 更新だけでは
    // 一部のブラウザで親要素の inline-block ボックス計算が遅延するため明示的に再描画)。
    try { refreshAllOverlays(); } catch (_) {}
  };
  applyRubyCssVars();
  onSettingsChange(applyRubyCssVars);
  renderAllSpreads();
  loadFontsFromBackend();
  // フォントが非同期で登録されるたびにオーバーレイを再描画して反映。
  onFontsRegistered(() => refreshAllOverlays());
  bindGlobalBlurOnOutsideClick();
  initRulers();
  bindRulerToggle();
  bindNewTextDirectionToggle();
  bindViewerMode();
  // services/psd-load.js から読込フェーズの節目で投げられるイベントを購読し、
  // ページバー / 回転ボタン / ガイドロックボタンの可視状態を同期する。
  // psd-load.js 側は main.js を直接 import しないので、循環参照を避けつつ
  // UI 更新フックを差し込めるようにこの 1 箇所に集約している。
  window.addEventListener("psdesign:psd-loaded", () => {
    updatePageNav();
    updatePsdRotateVisibility();
    updatePsdGuidesLockVisibility();
    updatePsdGuidesApplyVisibility();
  });
  // 初回起動セットアップ画面: AI 未インストール かつ 未スキップの初回のみ表示。
  // await しない: 内部の checkAiModelsStatus は非同期だが他の起動処理を遅らせない。
  maybeShowFirstRunSetup();
}

// INPUT/TEXTAREA/contenteditable 以外をクリックしたら、現在フォーカス中のテキスト入力から
// フォーカスを外す。Space でパンを切り替えた際に入力欄に文字が入る事故を防ぐ。
function bindGlobalBlurOnOutsideClick() {
  document.addEventListener("mousedown", (e) => {
    const active = document.activeElement;
    if (!active) return;
    const tag = active.tagName;
    const isTextInput =
      (tag === "INPUT" && !/^(button|submit|checkbox|radio|range|color)$/i.test(active.type || "")) ||
      tag === "TEXTAREA" ||
      active.isContentEditable;
    if (!isTextInput) return;
    const target = e.target;
    if (!target) return;
    // 入力欄自身やそれに紐づく UI（コンボボックス・ドロップダウン等）の中をクリックしたときは維持
    if (target === active || active.contains(target)) return;
    // editor パネル内のクリックも安全ゾーンに含める。in-place 編集 textarea が active な
    // ときに行間 input / +/- / ルビボタンを触っても勝手に textarea が blur しないようにする。
    const near = target.closest?.("input, textarea, [contenteditable], .style-palette, .save-menu, .layer-box.editing, .editor");
    if (near) return;
    active.blur();
  }, true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
