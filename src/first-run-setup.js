// アプリ初回起動時に AI インストールへ誘導するウェルカムモーダル。
//
// 仕様:
//  - localStorage `psdesign_setup_seen` が "1" なら表示しない（一度で永続スキップ）。
//  - AI ランタイムが既にインストール済み (check_ai_models が available:true) なら、
//    ウェルカムは出さずフラグだけ立てて静かに通過する。
//  - 「あとで」「Esc」「背景クリック」「× ボタン」のいずれもフラグを立てて閉じる挙動。
//  - 「今すぐインストール」を押すとウェルカムを閉じてから既存の AI インストールモーダル
//    (openAiInstallModal) を開く。
//  - ハンバーガーメニューの再インストールボタンは無変更（フラグに関係なく常時起動可能）。

import { checkAiModelsStatus, openAiInstallModal } from "./ai-install.js";
import { showModalAnimated, hideModalAnimated, MODAL_ANIM_MS } from "./ui-feedback.js";

const SETUP_SEEN_KEY = "psdesign_setup_seen";

const $ = (id) => document.getElementById(id);

function markSeen() {
  try { localStorage.setItem(SETUP_SEEN_KEY, "1"); } catch (_) { /* ignore */ }
}

function alreadySeen() {
  try { return localStorage.getItem(SETUP_SEEN_KEY) === "1"; } catch (_) { return false; }
}

let escListener = null;
let backdropListener = null;

function attachDismissListeners(modal) {
  // Esc / 背景クリックで「あとで」と同じ扱い。
  escListener = (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeWelcome(modal); }
  };
  document.addEventListener("keydown", escListener);
  backdropListener = (e) => {
    if (e.target === modal) closeWelcome(modal);
  };
  modal.addEventListener("mousedown", backdropListener);
}

function detachDismissListeners(modal) {
  if (escListener) document.removeEventListener("keydown", escListener);
  if (backdropListener) modal.removeEventListener("mousedown", backdropListener);
  escListener = null;
  backdropListener = null;
}

function closeWelcome(modal) {
  markSeen();
  hideModalAnimated(modal);
  detachDismissListeners(modal);
}

async function openWelcomeAndInstall(modal) {
  // ウェルカム close アニメ完了を待ってから AI インストールモーダルを起動。
  markSeen();
  hideModalAnimated(modal);
  detachDismissListeners(modal);
  await new Promise((r) => setTimeout(r, MODAL_ANIM_MS));
  try { await openAiInstallModal(); } catch (e) { console.error(e); }
}

// 公開: 起動時に 1 回呼ぶ。ボタン配線のみ行い、表示判定は maybeShowFirstRunSetup に委ねる。
export function bindFirstRunSetup() {
  const modal = $("first-run-welcome-modal");
  if (!modal) return;
  const skipBtn = $("welcome-skip-btn");
  const installBtn = $("welcome-install-btn");
  if (skipBtn) skipBtn.addEventListener("click", () => closeWelcome(modal));
  if (installBtn) installBtn.addEventListener("click", () => openWelcomeAndInstall(modal));
}

// 公開: 起動シーケンス末尾で呼ぶ。await しない想定（モーダルは UI に乗るだけで他処理は通常起動）。
export async function maybeShowFirstRunSetup() {
  if (alreadySeen()) return;
  // AI が既にインストール済みなら静かにフラグだけ立てて終了。
  let status;
  try { status = await checkAiModelsStatus(); } catch (_) { status = null; }
  if (status?.available) {
    markSeen();
    return;
  }
  const modal = $("first-run-welcome-modal");
  if (!modal) return;
  attachDismissListeners(modal);
  showModalAnimated(modal);
}
