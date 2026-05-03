// 環境設定モーダルの UI 制御。
// - タブ切替（ショートカット / ページ送り）
// - ショートカット一覧の動的生成 + キーキャプチャモーダル + 衝突検出
// - ページ送り反転のラジオ
// settings.js (state + persistence) とは疎結合で、変更は setShortcut / setPageDirectionInverted
// を呼ぶだけ。逆方向の通知は onSettingsChange で受けて UI を再描画する。

import {
  checkConflict,
  formatShortcutDisplay,
  getAllShortcuts,
  getDefaults,
  getPageDirectionInverted,
  normalizeKeyName,
  onSettingsChange,
  resetDefaults,
  resetShortcuts,
  setDefault,
  setPageDirectionInverted,
  setShortcut,
} from "./settings.js";
import { applyToolDefaults, getFonts } from "./state.js";
import { onFontsRegistered } from "./font-loader.js";
import { hideModalAnimated, showModalAnimated } from "./ui-feedback.js";

const $ = (id) => document.getElementById(id);

let modalOpen = false;
let captureState = null; // { id, key, modifiers, onCommit }

function openModal() {
  const m = $("settings-modal");
  if (!m) return;
  showModalAnimated(m);
  modalOpen = true;
  // 開くたびに最新値で再描画（外部から setPageDirectionInverted が呼ばれた等を反映）。
  renderShortcutList();
  syncPageDirectionUi();
  syncDefaultsUi();
  // デフォルトはショートカットタブ。
  switchTab("shortcuts");
}

function closeModal() {
  const m = $("settings-modal");
  if (!m) return;
  hideModalAnimated(m);
  modalOpen = false;
}

export function isSettingsModalOpen() { return modalOpen; }

function switchTab(tabId) {
  const tabs = document.querySelectorAll(".settings-tab");
  const panels = document.querySelectorAll(".settings-tab-panel");
  for (const t of tabs) {
    const active = t.dataset.tab === tabId;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const p of panels) {
    p.classList.toggle("active", p.id === `settings-tab-${tabId}`);
  }
}

function renderShortcutList() {
  const list = $("shortcut-list");
  if (!list) return;
  const shortcuts = getAllShortcuts();
  const frag = document.createDocumentFragment();
  for (const [id, sc] of Object.entries(shortcuts)) {
    const row = document.createElement("div");
    row.className = "shortcut-item";
    const label = document.createElement("span");
    label.className = "shortcut-label";
    label.textContent = sc.description || id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shortcut-key-btn";
    btn.textContent = formatShortcutDisplay(sc) || "未設定";
    btn.title = "クリックして変更";
    btn.addEventListener("click", () => openKeyCapture(id, sc));
    row.appendChild(label);
    row.appendChild(btn);
    frag.appendChild(row);
  }
  list.innerHTML = "";
  list.appendChild(frag);
}

function syncPageDirectionUi() {
  const v = getPageDirectionInverted();
  const opts = document.querySelectorAll('input[name="page-direction"]');
  for (const inp of opts) {
    const isOn = (inp.value === "true") === v;
    inp.checked = isOn;
    const wrap = inp.closest(".settings-radio-option");
    if (wrap) wrap.classList.toggle("selected", isOn);
  }
}

// 「デフォルト」タブ：保存値をフォームに反映。
function syncDefaultsUi() {
  const d = getDefaults();
  const ts = $("default-text-size");
  const tss = $("default-text-size-step");
  const lp = $("default-leading-pct");
  const sw = $("default-stroke-width");
  const ft = $("default-font");
  const sb = $("default-show-badge");
  if (ts) ts.value = String(d.textSize ?? "");
  if (tss) tss.value = String(d.textSizeStep ?? 0.1);
  if (lp) lp.value = String(d.leadingPct ?? "");
  if (sw) sw.value = String(d.strokeWidthPx ?? "");
  if (ft) ft.value = String(d.fontPostScriptName ?? "");
  if (sb) sb.value = d.showBadge === false ? "hide" : "show";
  populateFontDatalist();
}

// インストール済みフォントを <datalist> に流し込み（PostScript 名で確定する想定、
// 表示名は label 属性で参考表示）。
function populateFontDatalist() {
  const list = $("default-font-list");
  if (!list) return;
  const fonts = getFonts() ?? [];
  list.innerHTML = "";
  for (const f of fonts) {
    if (!f?.postScriptName) continue;
    const opt = document.createElement("option");
    opt.value = f.postScriptName;
    if (f.name && f.name !== f.postScriptName) opt.label = f.name;
    list.appendChild(opt);
  }
}

// ===== キーキャプチャモーダル =====

function openKeyCapture(id, sc) {
  captureState = { id, key: sc.key, modifiers: [...(sc.modifiers || [])] };
  const m = $("key-capture-modal");
  const title = $("key-capture-title");
  const display = $("key-capture-display");
  const conflict = $("key-capture-conflict");
  const ok = $("key-capture-ok");
  if (!m || !display || !ok) return;
  if (title) title.textContent = `「${sc.description || id}」のショートカット`;
  // 初期表示は現在値（OK 済み扱い）。
  refreshCaptureDisplay();
  if (conflict) conflict.hidden = true;
  ok.disabled = false;
  showModalAnimated(m);
  // キャプチャモーダル表示中のキーは window keydown を capture して横取り。
  window.addEventListener("keydown", onCaptureKeyDown, true);
}

function closeKeyCapture() {
  const m = $("key-capture-modal");
  if (!m) return;
  hideModalAnimated(m);
  captureState = null;
  window.removeEventListener("keydown", onCaptureKeyDown, true);
}

function refreshCaptureDisplay() {
  const display = $("key-capture-display");
  if (!display || !captureState) return;
  const has = !!captureState.key;
  display.classList.toggle("waiting", !has);
  display.classList.toggle("has-key", has);
  display.textContent = has
    ? formatShortcutDisplay({ key: captureState.key, modifiers: captureState.modifiers })
    : "キーを押してください…";
}

function refreshCaptureConflict() {
  const conflict = $("key-capture-conflict");
  const ok = $("key-capture-ok");
  if (!conflict || !ok || !captureState) return;
  if (!captureState.key) {
    conflict.hidden = true;
    ok.disabled = true;
    return;
  }
  const r = checkConflict(captureState.id, captureState.key, captureState.modifiers);
  if (r.conflict) {
    conflict.hidden = false;
    // 警告アイコン (lucide alert-triangle) + 重複先の名称（XSS 防止のため textContent で挿入）
    const safeName = r.description || r.with;
    conflict.innerHTML =
      '<svg class="key-capture-conflict-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
      '</svg>' +
      '<span class="key-capture-conflict-text"></span>';
    const textEl = conflict.querySelector(".key-capture-conflict-text");
    if (textEl) textEl.textContent = `「${safeName}」と重複しています。設定すると元の割当が動かなくなります。`;
  } else {
    conflict.hidden = true;
  }
  ok.disabled = false;
}

function isModifierOnly(key) {
  return key === "Control" || key === "Shift" || key === "Alt" || key === "Meta";
}

function onCaptureKeyDown(e) {
  if (!captureState) return;
  e.preventDefault();
  e.stopPropagation();
  // Esc → キャンセル / Backspace → クリア。
  if (e.key === "Escape") {
    closeKeyCapture();
    return;
  }
  if (e.key === "Backspace") {
    captureState.key = "";
    captureState.modifiers = [];
    refreshCaptureDisplay();
    refreshCaptureConflict();
    return;
  }
  // 修飾キー単独押下は無視（押し続けで捕捉が暴走するのを防ぐ）。
  if (isModifierOnly(e.key)) return;

  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  captureState.key = normalizeKeyName(e.key);
  captureState.modifiers = mods;
  refreshCaptureDisplay();
  refreshCaptureConflict();
}

function commitKeyCapture() {
  if (!captureState || !captureState.key) {
    closeKeyCapture();
    return;
  }
  setShortcut(captureState.id, captureState.key, captureState.modifiers);
  closeKeyCapture();
  renderShortcutList();
}

// ===== 配線 =====

export function initSettingsUi() {
  // モーダル背景クリック / 閉じるボタン / Esc。
  const modal = $("settings-modal");
  const closeBtn = $("settings-close-btn");
  if (modal) {
    modal.addEventListener("mousedown", (e) => {
      if (e.target === modal) closeModal();
    });
  }
  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  // タブ切替。
  const tabs = document.querySelectorAll(".settings-tab");
  for (const t of tabs) {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  }

  // ショートカット reset。
  const reset = $("settings-reset-shortcuts-btn");
  if (reset) {
    reset.addEventListener("click", () => {
      resetShortcuts();
      renderShortcutList();
    });
  }

  // ページ送り反転のラジオ。
  const opts = document.querySelectorAll('input[name="page-direction"]');
  for (const inp of opts) {
    inp.addEventListener("change", () => {
      if (!inp.checked) return;
      setPageDirectionInverted(inp.value === "true");
      syncPageDirectionUi();
    });
  }

  // キーキャプチャモーダルのボタン群。
  const cap = $("key-capture-modal");
  const capOk = $("key-capture-ok");
  const capCancel = $("key-capture-cancel");
  if (cap) {
    cap.addEventListener("mousedown", (e) => {
      if (e.target === cap) closeKeyCapture();
    });
  }
  if (capOk) capOk.addEventListener("click", commitKeyCapture);
  if (capCancel) capCancel.addEventListener("click", closeKeyCapture);

  // 設定モーダル中は Esc で閉じる（キャプチャモーダル中は onCaptureKeyDown が握る）。
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (cap && !cap.hidden) return; // キャプチャモーダル優先
    if (modalOpen) {
      e.preventDefault();
      closeModal();
    }
  });

  // 外部からの設定変更（reset 等）を UI に追従。
  onSettingsChange(() => {
    if (modalOpen) {
      renderShortcutList();
      syncPageDirectionUi();
      syncDefaultsUi();
    }
  });

  // 「デフォルト」タブの入力欄。change で settings に保存し、即座にツール状態にも反映。
  bindDefaultsInputs();

  // フォントが非同期で登録されるたびに datalist を更新（モーダルが開いていなくてもよい）。
  onFontsRegistered(() => {
    if (modalOpen) populateFontDatalist();
  });
}

function bindDefaultsInputs() {
  const wireNumber = (id, key) => {
    const inp = $(id);
    if (!inp) return;
    inp.addEventListener("change", () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) {
        // 無効入力 → 現在値で復帰。
        syncDefaultsUi();
        return;
      }
      setDefault(key, v);
      applyToolDefaults();
    });
  };
  wireNumber("default-text-size",   "textSize");
  wireNumber("default-leading-pct", "leadingPct");
  wireNumber("default-stroke-width", "strokeWidthPx");

  const tss = $("default-text-size-step");
  if (tss) {
    tss.addEventListener("change", () => {
      const v = Number(tss.value);
      if (v !== 0.1 && v !== 0.5) {
        syncDefaultsUi();
        return;
      }
      setDefault("textSizeStep", v);
      applyToolDefaults();
    });
  }

  const ft = $("default-font");
  if (ft) {
    ft.addEventListener("change", () => {
      setDefault("fontPostScriptName", String(ft.value || "").trim());
      applyToolDefaults();
    });
  }

  const sb = $("default-show-badge");
  if (sb) {
    sb.addEventListener("change", () => {
      setDefault("showBadge", sb.value !== "hide");
    });
  }

  const reset = $("settings-reset-defaults-btn");
  if (reset) {
    reset.addEventListener("click", () => {
      resetDefaults();
      syncDefaultsUi();
      applyToolDefaults();
    });
  }
}

export function openSettingsModal() {
  openModal();
}
