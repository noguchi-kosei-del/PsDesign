// Tachimi 起動サービス。台割マネージャー由来の Rust コマンド
// (detect_tachimi_exe / launch_tachimi_with_files) を JS から薄く呼び出す。
//
// 検出: localStorage の hint（前回成功パス）→ Rust 側で開発ビルド / インストール想定パスを順に探索
// 起動: 渡された PSD パス群を %TEMP%\psdesign_tachimi_staging\ に集約 →
//       %TEMP%\tachimi_cli_files.json でファイル一覧を渡して spawn

import { notifyDialog } from "../ui-feedback.js";

const HINT_KEY = "psdesign_tachimi_exe_path";

// 保存先 PSD パス一覧を受け取り、Tachimi で開く。
// 失敗時はそれぞれ notifyDialog で通知して return。成功時は何も表示しない（呼び出し側の
// 保存完了ダイアログが既に閉じている前提）。
export async function launchTachimiWithPaths(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const hint = localStorage.getItem(HINT_KEY) || null;
  let exePath = null;
  try {
    exePath = await invoke("detect_tachimi_exe", { hint });
  } catch (err) {
    console.error("[tachimi] detect failed", err);
    await notifyDialog({
      title: "Tachimi が見つかりません",
      message: String(err ?? "検出エラー"),
      kind: "warning",
    });
    return;
  }
  if (!exePath) {
    await notifyDialog({
      title: "Tachimi が見つかりません",
      message: "Tachimi がインストールされていないか、想定外の場所にあります。\nTachimi を Desktop\\Tachimi_開発 配下、または Program Files\\Tachimi\\ にインストールしてください。",
      kind: "warning",
    });
    return;
  }
  // 次回起動を高速化するため hint を永続化
  try { localStorage.setItem(HINT_KEY, exePath); } catch (_) {}
  try {
    await invoke("launch_tachimi_with_files", { exePath, filePaths });
  } catch (err) {
    console.error("[tachimi] launch failed", err);
    await notifyDialog({
      title: "Tachimi の起動に失敗しました",
      message: String(err ?? "起動エラー"),
      kind: "warning",
    });
  }
}
