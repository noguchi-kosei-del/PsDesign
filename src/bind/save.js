// 保存系: 保存ボタン、保存中の多重実行ガード。
// 上書き保存は廃止。保存は常に Tachimi 互換の
//   <Desktop>/Script_Output/OPUS写植/写植完了/  (既存時は 写植完了(1), 写植完了(2)... と連番)
// に書き出す。フロント側で空きフォルダ名を確定してから Rust に渡す。
// 外向き API: bindSaveMenu / handleSave / 保存可能フラグの get/set。

import { exportEdits, getEdit, getNewLayersForPsd, getPages, getPdfPaths, getPsdRotation, hasEdits } from "../state.js";
import {
  hideModalAnimated,
  hideProgress,
  notifyDialog,
  showModalAnimated,
  showProgress,
  toast,
  updateProgress,
} from "../ui-feedback.js";
import { baseName, joinPath, parentDir } from "../utils/path.js";
import { launchKenbanPsdPdf } from "../services/kenban.js";
import { launchTachimiWithPaths } from "../services/tachimi.js";
import { saveProject } from "../services/project.js";
// 【v1.29.x UI-coord】保存前に全 page のルビ wrap 実描画位置を同期測定して state に書き戻す。
// これにより exportEdits が「最新の UI 上の位置」を含む payload を返し、JSX 側 createRubyLayer が
// ビューアーと完全一致した位置にルビレイヤーを配置できる (rAF 遅延を待たずに済む)。
import { measureAllRubyOffsetsSync, renderStaticPageOverlay } from "../canvas-tools.js";

// PSD 読込時に false にリセットされ、保存成功で true になる。
// 旧: 初回 Ctrl+S を別名保存にフォールバックさせるためのフラグ。
// 現: 上書き保存廃止により実質的な分岐ロジックは無いが、他モジュール（hasSavedThisSession を
//     参照する箇所）の互換のため state は維持。
let hasSavedThisSession = false;
// Photoshop への保存 invoke が走っている間は true。Ctrl+S や保存ボタンの連打で
// 同じ PSD に対して invoke が並行実行されると Photoshop 側で開くドキュメントが
// 競合し、片方の編集が失われる / セッションが破壊されるためガードする。
let saveInflight = false;
let finishReviewPromise = null;

// 旧 confirmDialog 経由の「上書き確認」ダイアログは廃止（連番フォルダで衝突しないため）。

export function getHasSavedThisSession() { return hasSavedThisSession; }
export function setHasSavedThisSession(v) { hasSavedThisSession = !!v; }

export function updateSaveButton() {
  const hasPages = getPages().length > 0;
  const btn = document.getElementById("project-save-btn");
  const projectItem = document.getElementById("save-project-menu-item");
  const psdItem = document.getElementById("save-psd-menu-item");
  const bothItem = document.getElementById("save-both-menu-item");
  if (btn) {
    btn.disabled = !hasPages;
    btn.title = "保存";
    btn.setAttribute("aria-label", "保存メニュー");
  }
  if (projectItem) projectItem.disabled = !hasPages;
  if (psdItem) psdItem.disabled = !hasPages || saveInflight;
  if (bothItem) bothItem.disabled = !hasPages || saveInflight;
}

function flushActiveSidebarInputBeforeSave() {
  const active = document.activeElement;
  if (!(active instanceof window.HTMLInputElement)) return;
  const commitOnSaveIds = new Set([
    "size-input",
    "leading-input",
    "stroke-width-input",
    "horizontal-scale-input",
    "vertical-scale-input",
    "tracking-input",
    "kerning-input",
  ]);
  if (!commitOnSaveIds.has(active.id)) return;
  active.dispatchEvent(new window.Event("change", { bubbles: true }));
  active.blur();
}

function layerTextPreview(value, fallback = "") {
  const text = String(value ?? fallback ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "（空のテキスト）";
  return text.length > 36 ? `${text.slice(0, 36)}...` : text;
}

function editedLayersForPage(page) {
  return (page?.textLayers ?? [])
    .map((layer) => ({ layer, edit: getEdit(page.path, layer.id) }))
    .filter((entry) => !!entry.edit);
}

function pageReviewStats(page) {
  const edited = editedLayersForPage(page).length;
  const created = getNewLayersForPsd(page.path).length;
  return { edited, created, total: edited + created };
}

function fitPreviewSize(page, maxW, maxH) {
  const width = Number(page?.width) || Number(page?.canvas?.width) || 1;
  const height = Number(page?.height) || Number(page?.canvas?.height) || 1;
  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  const visualW = rotated90 ? height : width;
  const visualH = rotated90 ? width : height;
  const scale = Math.min(maxW / visualW, maxH / visualH, 1);
  return {
    width,
    height,
    visualW,
    visualH,
    rotation,
    rotated90,
    scale: Math.max(0.0001, scale),
    cssW: Math.max(1, Math.round(width * scale)),
    cssH: Math.max(1, Math.round(height * scale)),
    pageW: Math.max(1, Math.round(visualW * scale)),
    pageH: Math.max(1, Math.round(visualH * scale)),
  };
}

function renderFinishReviewPageView(target, page, pageIndex, maxW, maxH, { clear = true } = {}) {
  if (!target) return null;
  if (clear) target.textContent = "";
  const { width, height, scale, cssW, cssH, pageW, pageH, rotation } = fitPreviewSize(page, maxW, maxH);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pageEl = document.createElement("div");
  pageEl.className = "page finish-review-page";
  pageEl.style.width = `${pageW}px`;
  pageEl.style.height = `${pageH}px`;

  const wrap = document.createElement("div");
  wrap.className = "canvas-wrap";
  if (rotation !== 0) {
    wrap.style.position = "absolute";
    wrap.style.left = "50%";
    wrap.style.top = "50%";
    wrap.style.transformOrigin = "center center";
    wrap.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
  }

  const canvas = document.createElement("canvas");
  canvas.dataset.pageIndex = String(pageIndex);
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const overlay = document.createElement("div");
  overlay.className = "page-overlay";

  wrap.append(canvas, overlay);
  pageEl.appendChild(wrap);
  target.appendChild(pageEl);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (page?.canvas) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(page.canvas, 0, 0, canvas.width, canvas.height);
  }
  renderStaticPageOverlay({ canvas, overlay, page, pageIndex });
  requestAnimationFrame(() => renderStaticPageOverlay({ canvas, overlay, page, pageIndex }));
  window.setTimeout(() => {
    if (target.contains(pageEl)) renderStaticPageOverlay({ canvas, overlay, page, pageIndex });
  }, 160);
  window.setTimeout(() => {
    if (target.contains(pageEl)) renderStaticPageOverlay({ canvas, overlay, page, pageIndex });
  }, 420);
  void scale;
  return pageEl;
}

function renderFinishReviewBlankPage(target, templatePage, maxW, maxH, { clear = false } = {}) {
  if (!target || !templatePage) return null;
  if (clear) target.textContent = "";
  const { pageW, pageH } = fitPreviewSize(templatePage, maxW, maxH);
  const pageEl = document.createElement("div");
  pageEl.className = "page finish-review-page finish-review-blank-page";
  pageEl.style.width = `${pageW}px`;
  pageEl.style.height = `${pageH}px`;
  target.appendChild(pageEl);
  return pageEl;
}

function buildFinishReviewItems(pages, spreadMode) {
  if (!spreadMode) {
    return pages.map((page, index) => ({
      kind: "single",
      slots: [{ page, index, blank: false }],
    }));
  }
  if (pages.length === 0) return [];
  const items = [{
    kind: "spread",
    slots: [
      { page: pages[0], index: 0, blank: false },
      { page: pages[0], index: null, blank: true },
    ],
  }];
  for (let i = 1; i < pages.length; i += 2) {
    items.push({
      kind: "spread",
      slots: [
        pages[i + 1]
          ? { page: pages[i], index: i, blank: false }
          : { page: pages[i], index: null, blank: true },
        pages[i + 1]
          ? { page: pages[i + 1], index: i + 1, blank: false }
          : { page: pages[i], index: i, blank: false },
      ],
    });
  }
  return items;
}

function reviewItemStats(item) {
  return item.slots.reduce((acc, slot) => {
    if (slot.blank || !slot.page) return acc;
    const stats = pageReviewStats(slot.page);
    acc.edited += stats.edited;
    acc.created += stats.created;
    return acc;
  }, { edited: 0, created: 0, total: 0 });
}

function reviewItemPageIndices(item) {
  return item.slots
    .filter((slot) => !slot.blank && Number.isInteger(slot.index))
    .map((slot) => slot.index);
}

function reviewItemContainsPage(item, pageIndex) {
  return reviewItemPageIndices(item).includes(pageIndex);
}

function reviewItemTitle(item, totalPages) {
  const indices = reviewItemPageIndices(item).map((i) => i + 1);
  if (indices.length === 0) return "白紙";
  if (item.kind === "single" || indices.length === 1) return `${indices[0]} / ${totalPages}`;
  return `${indices[0]}-${indices[indices.length - 1]} / ${totalPages}`;
}

function reviewItemName(item) {
  const names = item.slots
    .filter((slot) => !slot.blank && slot.page)
    .map((slot) => baseName(slot.page.path));
  if (names.length <= 1) return names[0] ?? "白紙";
  return names.join(" / ");
}

function renderFinishReviewItemView(target, item, maxW, maxH) {
  if (!target || !item) return;
  target.textContent = "";
  if (item.kind !== "spread") {
    const slot = item.slots[0];
    if (slot?.page) renderFinishReviewPageView(target, slot.page, slot.index ?? 0, maxW, maxH, { clear: false });
    return;
  }

  const spread = document.createElement("div");
  spread.className = "finish-review-spread";
  target.appendChild(spread);
  const slotGap = target.classList.contains("finish-review-thumb-preview") ? 1 : 8;
  spread.style.gap = `${slotGap}px`;
  const slotW = Math.max(1, Math.floor((maxW - slotGap) / 2));
  const slotH = maxH;
  for (const slot of item.slots) {
    const slotEl = document.createElement("div");
    slotEl.className = "finish-review-spread-slot";
    spread.appendChild(slotEl);
    if (slot.blank) {
      renderFinishReviewBlankPage(slotEl, slot.page, slotW, slotH, { clear: false });
    } else {
      renderFinishReviewPageView(slotEl, slot.page, slot.index ?? 0, slotW, slotH, { clear: false });
    }
  }
}

function createFinishReviewModal() {
  const existing = document.getElementById("finish-review-modal");
  if (existing) return existing;
  const modal = document.createElement("div");
  modal.id = "finish-review-modal";
  modal.className = "finish-review-modal";
  modal.hidden = true;
  modal.tabIndex = -1;
  modal.innerHTML = `
    <div class="finish-review-card" role="dialog" aria-modal="true" aria-labelledby="finish-review-title">
      <div class="finish-review-header">
        <div class="finish-review-heading">
          <div class="finish-review-title" id="finish-review-title">仕上がりチェック</div>
          <div class="finish-review-subtitle">Photoshopで保存する前に全ページの状態を確認してください</div>
        </div>
        <div class="finish-review-view-toggle" role="group" aria-label="表示形式">
          <button type="button" class="finish-review-mode-btn selected" id="finish-review-single-btn" aria-pressed="true">単ページ</button>
          <button type="button" class="finish-review-mode-btn" id="finish-review-spread-btn" aria-pressed="false">見開き</button>
        </div>
      </div>
      <div class="finish-review-body">
        <div class="finish-review-main">
          <div class="finish-review-large-wrap">
            <div id="finish-review-large" class="finish-review-large"></div>
          </div>
          <div class="finish-review-caption" id="finish-review-caption"></div>
        </div>
        <div class="finish-review-side">
          <div class="finish-review-side-title">ページ一覧</div>
          <div class="finish-review-grid" id="finish-review-grid"></div>
        </div>
      </div>
      <div class="finish-review-footer">
        <div class="finish-review-summary" id="finish-review-summary"></div>
        <div class="finish-review-actions">
          <button type="button" class="page-jump-btn" id="finish-review-cancel">キャンセル</button>
          <button type="button" class="page-jump-btn page-jump-btn-primary" id="finish-review-ok">Photoshopで保存</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function showFinishReviewDialog() {
  if (finishReviewPromise) return finishReviewPromise;
  const pages = getPages();
  if (pages.length === 0) return Promise.resolve(false);

  finishReviewPromise = new Promise((resolve) => {
    const modal = createFinishReviewModal();
    const grid = modal.querySelector("#finish-review-grid");
    const large = modal.querySelector("#finish-review-large");
    const largeWrap = modal.querySelector(".finish-review-large-wrap");
    const caption = modal.querySelector("#finish-review-caption");
    const summary = modal.querySelector("#finish-review-summary");
    const okBtn = modal.querySelector("#finish-review-ok");
    const cancelBtn = modal.querySelector("#finish-review-cancel");
    const singleBtn = modal.querySelector("#finish-review-single-btn");
    const spreadBtn = modal.querySelector("#finish-review-spread-btn");
    if (!grid || !large || !caption || !summary || !okBtn || !cancelBtn || !singleBtn || !spreadBtn) {
      finishReviewPromise = null;
      resolve(true);
      return;
    }

    const controller = new AbortController();
    let selectedIndex = 0;
    let spreadMode = false;
    let reviewItems = buildFinishReviewItems(pages, spreadMode);
    let lastWheelPageAt = 0;
    const totals = pages.reduce((acc, page) => {
      const stats = pageReviewStats(page);
      acc.edited += stats.edited;
      acc.created += stats.created;
      return acc;
    }, { edited: 0, created: 0 });

    const updateModeButtons = () => {
      singleBtn.classList.toggle("selected", !spreadMode);
      spreadBtn.classList.toggle("selected", spreadMode);
      singleBtn.setAttribute("aria-pressed", String(!spreadMode));
      spreadBtn.setAttribute("aria-pressed", String(spreadMode));
    };

    const selectPage = (index) => {
      selectedIndex = Math.max(0, Math.min(reviewItems.length - 1, index));
      const item = reviewItems[selectedIndex];
      const stats = reviewItemStats(item);
      const box = largeWrap?.getBoundingClientRect?.();
      const maxW = Math.max(320, Math.floor((box?.width || 860) - 18));
      const maxH = Math.max(360, Math.floor((box?.height || 700) - 18));
      renderFinishReviewItemView(large, item, maxW, maxH);
      caption.textContent = `${reviewItemTitle(item, pages.length)}  ${reviewItemName(item)}  既存編集 ${stats.edited} / 新規 ${stats.created}`;
      grid.querySelectorAll(".finish-review-thumb").forEach((btn, i) => {
        btn.classList.toggle("selected", i === selectedIndex);
      });
    };

    const anchorPageIndex = () => {
      const item = reviewItems[selectedIndex];
      return reviewItemPageIndices(item)[0] ?? 0;
    };

    const rebuildGrid = (anchor = anchorPageIndex()) => {
      reviewItems = buildFinishReviewItems(pages, spreadMode);
      selectedIndex = Math.max(0, reviewItems.findIndex((item) => reviewItemContainsPage(item, anchor)));
      grid.textContent = "";
      reviewItems.forEach((reviewItem, index) => {
        const stats = reviewItemStats(reviewItem);
        const item = document.createElement("button");
        item.type = "button";
        item.className = "finish-review-thumb";
        item.setAttribute("aria-label", `${reviewItemTitle(reviewItem, pages.length)}を確認`);
        const preview = document.createElement("span");
        preview.className = "finish-review-thumb-preview";
        const meta = document.createElement("span");
        meta.className = "finish-review-thumb-meta";
        const name = document.createElement("span");
        name.className = "finish-review-thumb-name";
        name.textContent = `${reviewItemTitle(reviewItem, pages.length)}. ${reviewItemName(reviewItem)}`;
        const count = document.createElement("span");
        count.className = "finish-review-thumb-count";
        count.textContent = stats.total > 0 ? `編集 ${stats.edited} / 新規 ${stats.created}` : "変更なし";
        meta.append(name, count);
        item.append(preview, meta);
        item.addEventListener("click", () => selectPage(index), { signal: controller.signal });
        grid.appendChild(item);
        renderFinishReviewItemView(preview, reviewItem, 58, 78);
      });
      updateModeButtons();
      selectPage(selectedIndex);
    };

    summary.textContent = `${pages.length}ページ / 既存編集 ${totals.edited} / 新規 ${totals.created}`;

    const cleanup = (result) => {
      controller.abort();
      hideModalAnimated(modal);
      finishReviewPromise = null;
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(false);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        e.stopPropagation();
        selectPage(selectedIndex + 1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        e.stopPropagation();
        selectPage(selectedIndex - 1);
      }
    };
    const onWheel = (e) => {
      if (Math.abs(e.deltaY) < 8 && Math.abs(e.deltaX) < 8) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastWheelPageAt < 130) return;
      lastWheelPageAt = now;
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      selectPage(selectedIndex + (delta > 0 ? 1 : -1));
    };

    okBtn.addEventListener("click", () => cleanup(true), { signal: controller.signal });
    cancelBtn.addEventListener("click", () => cleanup(false), { signal: controller.signal });
    singleBtn.addEventListener("click", () => {
      if (!spreadMode) return;
      const anchor = anchorPageIndex();
      spreadMode = false;
      rebuildGrid(anchor);
      modal.focus();
    }, { signal: controller.signal });
    spreadBtn.addEventListener("click", () => {
      if (spreadMode) return;
      const anchor = anchorPageIndex();
      spreadMode = true;
      rebuildGrid(anchor);
      modal.focus();
    }, { signal: controller.signal });
    window.addEventListener("keydown", onKey, { capture: true, signal: controller.signal });
    modal.addEventListener("wheel", onWheel, { passive: false, signal: controller.signal });
    showModalAnimated(modal);
    requestAnimationFrame(() => {
      rebuildGrid(0);
      modal.focus();
    });
  });

  return finishReviewPromise;
}

const BASE_SAVE_FOLDER_NAME = "写植完了";
// 連番フォーマット: BASE, BASE(1), BASE(2), ...（Tachimi の `jpg(1)` 命名に合わせて空白なし）。
function indexedSaveFolderName(i) {
  return i === 0 ? BASE_SAVE_FOLDER_NAME : `${BASE_SAVE_FOLDER_NAME}(${i})`;
}
// 安全上限。通常運用で 1000 個もできないが暴走防止。
const MAX_FOLDER_INDEX = 9999;

async function openSavedFolder(folderPath) {
  if (!folderPath) {
    toast("保存先フォルダが見つかりません", { kind: "error", duration: 3000 });
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_folder_in_explorer", { path: folderPath });
}

async function runSaveWithMode({ saveMode, targetDir }) {
  if (saveInflight) {
    toast("保存処理中です。完了までお待ちください", { kind: "info", duration: 2200 });
    return;
  }
  flushActiveSidebarInputBeforeSave();
  if (!hasEdits()) {
    toast("編集内容がありません", { kind: "info" });
    return;
  }
  // 【v1.29.x UI-coord】payload 構築前に、全 page のルビ wrap 実描画位置を同期測定して
  // state に書き戻す。これがないと rAF 遅延で「新規に適用したばかりのルビの offsetX/Y が
  // payload に含まれない」事故が起き、JSX 側で計算式 fallback が使われて位置がズレる。
  try { measureAllRubyOffsetsSync(); } catch (e) { console.warn("[save] ruby offset measure failed:", e); }
  const shouldSave = await showFinishReviewDialog();
  if (!shouldSave) return;
  if (saveInflight) return;
  const base = exportEdits();
  const payload = {
    ...base,
    saveMode,
    targetDir: targetDir ?? null,
  };
  saveInflight = true;
  const saveBtn = document.getElementById("project-save-btn");
  if (saveBtn) saveBtn.disabled = true;
  let unlistenProgress = null;
  showProgress({
    title: "Photoshop に反映中",
    detail: "Photoshop を起動しています...",
    current: 0,
    total: payload.edits?.length ?? 0,
    showCount: true,
    variant: "save",
  });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    unlistenProgress = await listen("photoshop_save_progress", (event) => {
      const p = event?.payload || {};
      updateProgress({
        detail: typeof p.detail === "string" ? p.detail : undefined,
        current: Number.isFinite(p.current) ? p.current : undefined,
        total: Number.isFinite(p.total) ? p.total : undefined,
        showCount: true,
      });
    });
    const result = await invoke("apply_edits_via_photoshop", { payload });
    const suffix = saveMode === "saveAs" && targetDir ? `（保存先: ${targetDir}）` : "";
    const hasWarn = typeof result === "string" && result.includes("警告:");
    hasSavedThisSession = true;
    // 警告ありなら success アニメをスキップして即閉じ（ユーザーには警告通知を優先表示）。
    // 純粋な成功時のみ緑チェックマークを再生してから閉じる。
    await hideProgress({ success: !hasWarn });
    // 保存先 PSD パス一覧を組み立て（Tachimi に渡す）。
    //   - saveMode "saveAs": <targetDir>/<元 PSD basename> として連番フォルダ内の出力先を指す
    //   - saveMode "overwrite": 元の PSD パス自体（旧フロー互換）
    // 配列の順序は getPages() の順 = ユーザーの並び順 = Tachimi 側で連番プレフィックスでも保持される
    const savedPaths = (saveMode === "saveAs" && targetDir)
      ? getPages().map((p) => joinPath(targetDir, baseName(p.path)))
      : getPages().map((p) => p.path);
    const savedFolder = (saveMode === "saveAs" && targetDir)
      ? targetDir
      : parentDir(savedPaths[0]);
    // 保存完了は中央モーダルで通知。警告有無で kind を切替（warning=オレンジ + 警告 SVG / success=緑 + チェック SVG）。
    // 「PDF 化に進む」ボタンを併設し、保存した PSD を Tachimi (写植チェッカー / PDF 化機能あり) に流して開く。
    await notifyDialog({
      title: hasWarn ? "保存完了（警告あり）" : "保存完了",
      message: `${result}${suffix}`,
      kind: hasWarn ? "warning" : "success",
      // keepOpen: true で押下してもダイアログは閉じない (複数アクションを連続実行できる)。
      // OK / Esc / 背景クリックで通常通り閉じる。
      actions: [
        {
          label: "保存先を開く",
          kind: "folder",
          keepOpen: true,
          onClick: () => openSavedFolder(savedFolder),
        },
        {
          label: "KENBANで開く",
          kind: "primary",
          keepOpen: true,
          onClick: () => launchKenbanPsdPdf({
            psdFolder: savedFolder,
            psdPaths: savedPaths,
            referencePaths: getPdfPaths(),
          }),
        },
        {
          label: "PDF 化に進む",
          kind: "place",
          keepOpen: true,
          onClick: () => launchTachimiWithPaths(savedPaths),
        },
      ],
    });
  } catch (e) {
    console.error(e);
    await hideProgress();
    toast(`保存失敗: ${e.message ?? e}`, { kind: "error", duration: 5000 });
  } finally {
    if (typeof unlistenProgress === "function") {
      try { unlistenProgress(); } catch (_) {}
    }
    saveInflight = false;
    // pages 0 件なら disabled のまま。ある場合のみ復帰。
    if (saveBtn) saveBtn.disabled = getPages().length === 0;
    updateSaveButton();
  }
}

// 親フォルダ直下の全 entry を返す。例外時は空配列。
async function listEntriesIn(parent) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const entries = await invoke("list_directory_entries", { path: parent });
    return Array.isArray(entries) ? entries : [];
  } catch (e) {
    console.error("[save] list_directory_entries failed:", e);
    return [];
  }
}

// 親フォルダ内で「写植完了」「写植完了(1)」… の中から最小の未使用 index を返す。
// 例外 / 取得失敗時は 0（= 基本名）を返して create_dir_all に丸投げ（その経路ではぶつかれば上書きになる）。
async function pickNextSaveFolderName(parent) {
  const entries = await listEntriesIn(parent);
  // 既存フォルダ名（小文字化）を Set 化
  const existing = new Set(
    entries
      .filter((e) => e && e.isDirectory === true)
      .map((e) => (e.name ?? "").toLowerCase()),
  );
  for (let i = 0; i <= MAX_FOLDER_INDEX; i++) {
    const name = indexedSaveFolderName(i);
    if (!existing.has(name.toLowerCase())) return name;
  }
  // 9999 個埋まっていれば諦めて基本名を返す（=Photoshop 側で saveAs 時に既存 PSD を
  // 事前削除する v1.14.0 A4 のフェイルセーフが効くので壊れはしない）。
  return BASE_SAVE_FOLDER_NAME;
}

// ユーザーが指定したタイトル/巻/校数からフォルダ名を組み立てる。
// 例: { title: "ワンピース", volume: 5, kousu: "初校" } → "ワンピース_5巻_初校"
// Windows で使えない文字 (\\ / : * ? " < > |) はサニタイズする。
function sanitizeFolderSegment(s) {
  return String(s ?? "").replace(/[\\/:*?"<>|]/g, "").trim();
}
function buildSaveFolderNameFromParams({ title, volume, kousu }) {
  const safeTitle = sanitizeFolderSegment(title);
  const v = Number(volume);
  const volPart = Number.isFinite(v) && v > 0 ? `${v}巻` : "";
  const safeKousu = sanitizeFolderSegment(kousu);
  const parts = [safeTitle, volPart, safeKousu].filter(Boolean);
  return parts.length > 0 ? parts.join("_") : BASE_SAVE_FOLDER_NAME;
}

const SAVE_FOLDER_DIALOG_LS_KEY = "psdesign_save_folder_params";

function loadSaveFolderDefaults() {
  try {
    const raw = localStorage.getItem(SAVE_FOLDER_DIALOG_LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v !== "object" || !v) return null;
    return v;
  } catch (_) {
    return null;
  }
}
function saveSaveFolderDefaults(params) {
  try {
    localStorage.setItem(SAVE_FOLDER_DIALOG_LS_KEY, JSON.stringify(params));
  } catch (_) {}
}

// 元 PSD パス（state.folder or 先頭 PSD の親フォルダ名）からタイトルと巻数を推測する。
function inferTitleAndVolume() {
  try {
    const pages = getPages();
    const first = pages?.[0]?.path;
    if (!first) return { title: "", volume: "" };
    const parentName = baseName(parentDir(first));
    // 「ワンピース 5巻」「ワンピース5巻」「ワンピース_05巻」「ワンピース_05」のパターンを試す
    let m = parentName.match(/^(.+?)[\s_]*0*(\d+)\s*巻?$/);
    if (m) return { title: m[1].trim(), volume: String(parseInt(m[2], 10)) };
    return { title: parentName, volume: "" };
  } catch (_) {
    return { title: "", volume: "" };
  }
}

// 保存先フォルダ命名ダイアログ。Promise<{title, volume, kousu} | null> を返す。
// Cancel / Esc / 背景クリックで null を resolve。
async function openSaveFolderDialog() {
  const modal = document.getElementById("save-folder-modal");
  if (!modal) return null;
  const titleInput = document.getElementById("save-folder-title");
  const volumeInput = document.getElementById("save-folder-volume");
  const kousuSelect = document.getElementById("save-folder-kousu");
  const previewEl = document.getElementById("save-folder-preview");
  const cancelBtn = document.getElementById("save-folder-cancel");
  const okBtn = document.getElementById("save-folder-ok");
  if (!titleInput || !volumeInput || !kousuSelect || !okBtn || !cancelBtn) return null;

  // 初期値: localStorage 直前値 → 元 PSD フォルダから推測 → 既定値
  const saved = loadSaveFolderDefaults();
  const inferred = inferTitleAndVolume();
  titleInput.value = saved?.title ?? inferred.title ?? "";
  volumeInput.value = (saved?.volume ?? inferred.volume ?? "") + "";
  kousuSelect.value = saved?.kousu ?? "初校";

  const refreshPreview = () => {
    const folderName = buildSaveFolderNameFromParams({
      title: titleInput.value,
      volume: volumeInput.value,
      kousu: kousuSelect.value,
    });
    if (previewEl) previewEl.textContent = folderName;
  };
  refreshPreview();
  titleInput.addEventListener("input", refreshPreview);
  volumeInput.addEventListener("input", refreshPreview);
  kousuSelect.addEventListener("change", refreshPreview);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      titleInput.removeEventListener("input", refreshPreview);
      volumeInput.removeEventListener("input", refreshPreview);
      kousuSelect.removeEventListener("change", refreshPreview);
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      hideModalAnimated(modal);
      resolve(value);
    };
    const onCancel = () => finish(null);
    const onOk = () => {
      const params = {
        title: titleInput.value.trim(),
        volume: volumeInput.value.trim(),
        kousu: kousuSelect.value,
      };
      saveSaveFolderDefaults(params);
      finish(params);
    };
    const onOverlay = (e) => { if (e.target === modal) onCancel(); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter" && document.activeElement !== kousuSelect) {
        e.preventDefault();
        onOk();
      }
    };
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    showModalAnimated(modal);
    requestAnimationFrame(() => {
      titleInput.focus();
      titleInput.select?.();
    });
  });
}

export async function handleSave() {
  if (getPages().length === 0) return;

  // ユーザーが「タイトル / 巻数 / 校数」を選ぶダイアログを表示。Cancel ならアボート。
  const params = await openSaveFolderDialog();
  if (!params) return;
  const folderName = buildSaveFolderNameFromParams(params);

  // <Desktop>/Script_Output/OPUS写植/<folderName>/ で保存。
  // 既に同名フォルダがあれば (N) 連番を付ける（既存ロジック流用）。
  let scriptOutputDir;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    scriptOutputDir = await invoke("script_output_dir");
  } catch (e) {
    console.error("[save] script_output_dir failed:", e);
    toast(`保存先の取得に失敗しました: ${e?.message ?? e}`, { kind: "error", duration: 5000 });
    return;
  }
  if (typeof scriptOutputDir !== "string" || !scriptOutputDir) {
    toast("Script_Output フォルダが見つかりません", { kind: "error", duration: 4000 });
    return;
  }

  const typesetOutputDir = joinPath(scriptOutputDir, "OPUS写植");
  const finalName = await pickNextSaveFolderNameFor(typesetOutputDir, folderName);
  const targetDir = joinPath(typesetOutputDir, finalName);

  // 中間フォルダ Script_Output / OPUS写植 / 終端 <folderName> は apply_edits_via_photoshop の
  // create_dir_all で再帰的に作られるので、フロント側での明示作成は不要。
  await runSaveWithMode({ saveMode: "saveAs", targetDir });
}

// 指定 base 名を起点に空き番号フォルダ名を返す。BASE 自体が未使用なら BASE、
// 既存なら BASE(1), BASE(2)... 同様の連番化。
async function pickNextSaveFolderNameFor(parent, baseName) {
  const entries = await listEntriesIn(parent);
  const existing = new Set(
    entries
      .filter((e) => e && e.isDirectory === true)
      .map((e) => (e.name ?? "").toLowerCase()),
  );
  if (!existing.has(baseName.toLowerCase())) return baseName;
  for (let i = 1; i <= MAX_FOLDER_INDEX; i++) {
    const candidate = `${baseName}(${i})`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return baseName;
}

// 旧バージョンの保存ドロップダウン（上書き保存 / 別名で保存 2 項目）は撤去。
// save-btn は単独でクリックされ、handleSave を呼ぶだけのシンプルな構造になった。
// 関数名 bindSaveMenu は main.js 側の import を壊さないため温存。
export function bindSaveMenu() {
  const btn = document.getElementById("project-save-btn");
  const menu = document.getElementById("save-menu");
  const projectItem = document.getElementById("save-project-menu-item");
  const psdItem = document.getElementById("save-psd-menu-item");
  const bothItem = document.getElementById("save-both-menu-item");
  if (!btn) return;
  const setOpen = (open) => {
    if (!menu) return;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const closeMenu = () => setOpen(false);
  const runAndClose = async (fn) => {
    closeMenu();
    await fn();
    updateSaveButton();
  };
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    updateSaveButton();
    setOpen(menu?.hidden !== false);
  });
  projectItem?.addEventListener("click", () => {
    if (projectItem.disabled) return;
    void runAndClose(saveProject);
  });
  psdItem?.addEventListener("click", () => {
    if (psdItem.disabled) return;
    void runAndClose(handleSave);
  });
  bothItem?.addEventListener("click", () => {
    if (bothItem.disabled) return;
    void runAndClose(async () => {
      await saveProject();
      await handleSave();
    });
  });
  document.addEventListener("click", (e) => {
    if (!menu || menu.hidden) return;
    if (e.target?.closest?.(".save-container")) return;
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !menu || menu.hidden) return;
    e.preventDefault();
    closeMenu();
    btn.focus();
  });
  window.addEventListener("psdesign:psd-loaded", updateSaveButton);
  updateSaveButton();
}
