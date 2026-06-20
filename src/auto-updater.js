// 起動時にドライブ式アップデータ（脱git）で新バージョンを確認し、
// 見つかれば中央モーダルダイアログ (#update-modal) を表示する。
// idle → applying → (アプリ終了→インストーラ→再起動)、または idle → error の状態遷移。
//
// 更新先 `App_installer\OPUS\` は Rust 側 updater_local.rs が外部参照 enc（updater.localDir）から
// 実行時解決し、setup.exe を minisign 検証してから適用する（GitHub 非接続）。

import { invoke } from "@tauri-apps/api/core";

const STARTUP_DELAY_MS = 1500;

const ICONS = {
  download: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>`,
  spinner: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>`,
  check: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12"/>
  </svg>`,
  alert: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>`,
};

let modalEl = null;
let iconEl = null;
let titleEl = null;
let versionEl = null;
let messageEl = null;
let buttonsEl = null;
let laterBtn = null;
let nowBtn = null;

let dismissed = false;
let cachedUpdate = null; // Rust の LocalUpdateInfo { version, file_name, setup_path } | null

function ensureRefs() {
  if (modalEl) return true;
  modalEl = document.getElementById("update-modal");
  iconEl = document.getElementById("update-modal-icon");
  titleEl = document.getElementById("update-modal-title");
  versionEl = document.getElementById("update-modal-version");
  messageEl = document.getElementById("update-modal-message");
  buttonsEl = document.getElementById("update-modal-buttons");
  laterBtn = document.getElementById("update-modal-later");
  nowBtn = document.getElementById("update-modal-now");
  return Boolean(modalEl && titleEl && versionEl && messageEl && buttonsEl && laterBtn && nowBtn);
}

function setIcon(variant, html) {
  if (!iconEl) return;
  iconEl.classList.remove("update-modal-icon-info", "update-modal-icon-spin", "update-modal-icon-success", "update-modal-icon-error");
  iconEl.classList.add(`update-modal-icon-${variant}`);
  iconEl.innerHTML = html;
}

function showModal() {
  if (!ensureRefs()) return;
  modalEl.hidden = false;
  // double rAF で hidden 解除直後にトランジションが効くようにする
  requestAnimationFrame(() => {
    requestAnimationFrame(() => modalEl.classList.add("visible"));
  });
}

function hideModal() {
  if (!modalEl) return;
  modalEl.classList.remove("visible");
  setTimeout(() => {
    if (modalEl && !modalEl.classList.contains("visible")) {
      modalEl.hidden = true;
    }
  }, 220);
}

function renderIdle(version) {
  setIcon("info", ICONS.download);
  titleEl.textContent = "新しいバージョンがあります";
  versionEl.textContent = `v${version}`;
  versionEl.hidden = false;
  messageEl.textContent = "今すぐアップデートしますか？";
  buttonsEl.hidden = false;
  laterBtn.disabled = false;
  laterBtn.hidden = false;
  nowBtn.disabled = false;
  nowBtn.hidden = false;
  nowBtn.textContent = "アップデート";
}

function renderDownloading() {
  setIcon("spin", ICONS.spinner);
  titleEl.textContent = "アップデート中...";
  versionEl.hidden = true;
  messageEl.textContent = "ダウンロードしています。\nしばらくお待ちください。";
  buttonsEl.hidden = true;
}

function renderSuccess() {
  setIcon("success", ICONS.check);
  titleEl.textContent = "インストール完了";
  versionEl.hidden = true;
  messageEl.textContent = "アプリを再起動します...";
  buttonsEl.hidden = true;
}

function renderError(err) {
  setIcon("error", ICONS.alert);
  titleEl.textContent = "アップデート失敗";
  versionEl.hidden = true;
  messageEl.textContent = String(err?.message ?? err ?? "不明なエラーが発生しました");
  buttonsEl.hidden = false;
  laterBtn.hidden = true;
  nowBtn.hidden = false;
  nowBtn.disabled = false;
  nowBtn.textContent = "閉じる";
}

async function runUpdate() {
  renderDownloading();
  try {
    const update = cachedUpdate ?? (await invoke("check_local_update"));
    if (!update) {
      hideModal();
      return;
    }
    // ドライブ式: apply_local_update が App_installer\OPUS\ の setup.exe を minisign 再検証 →
    // ローカル temp へコピー → /S /UPDATE で起動し、アプリを終了する（NSIS フックが再起動）。
    // 通常はこの invoke の解決前にアプリが終了する。検証失敗時は reject → catch で renderError。
    await invoke("apply_local_update", { setupPath: update.setup_path });
    renderSuccess();
  } catch (err) {
    console.error("[updater] update failed:", err);
    renderError(err);
  }
}

export function bindAutoUpdater() {
  if (!ensureRefs()) {
    console.warn("[updater] modal elements missing, skip");
    return;
  }

  laterBtn.addEventListener("click", () => {
    dismissed = true;
    hideModal();
  });

  nowBtn.addEventListener("click", () => {
    // エラー画面のとき: textContent === "閉じる"
    if (nowBtn.textContent === "閉じる") {
      hideModal();
      return;
    }
    runUpdate();
  });

  setTimeout(async () => {
    if (dismissed) return;
    try {
      // ドライブ式: App_installer\OPUS\ を見て、現行より高い版を minisign 検証して返す（無ければ null）。
      const update = await invoke("check_local_update");
      if (!update) return;
      cachedUpdate = update;
      renderIdle(update.version);
      showModal();
    } catch (err) {
      // G:未接続・参照アドレス未解決・署名不一致など。サイレントで握りつぶす。
      console.warn("[updater] check failed:", err);
    }
  }, STARTUP_DELAY_MS);
}
