// PSD ファイル選択 / 読込のフロー。pickPsdFiles / loadPsdFilesByPaths を提供する。
// 旧 main.js から切り出し、ai-place.js が main.js を動的 import で参照していた循環参照を解消。
//
// loadPsdFilesByPaths が main.js 内の UI 更新関数（updatePageNav / updatePsdRotateVisibility
// / updatePsdGuidesLockVisibility）を直接呼ぶと逆向きの循環が生じるため、読込終了時に
// `psdesign:psd-loaded` の CustomEvent を window に dispatch する。main.js 側は init() で
// 1 度だけリスナーを張り、必要な update 関数群を呼ぶ。

import { addPage, clearPages, hasEdits, setFolder } from "../state.js";
import { confirmDialog, hideProgress, showProgress, toast, updateProgress } from "../ui-feedback.js";
import { renderAllSpreads } from "../spread-view.js";
import { rebuildLayerList } from "../text-editor.js";
import { loadPsdFromPath } from "../psd-loader.js";
import { setHasSavedThisSession, updateSaveButton } from "../bind/save.js";
import { baseName, parentDir } from "../utils/path.js";
import { setGuidesLocked } from "../rulers.js";

export async function pickPsdFiles() {
  const { openFileDialog } = await import("../file-picker.js");
  const picked = await openFileDialog({
    mode: "open",
    multiple: true,
    title: "PSDを開く",
    filters: [{ name: "Photoshop Document", extensions: ["psd"] }],
    rememberKey: "psd-open",
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export async function listPsdFilesInFolder(folder) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("list_psd_files", { folder });
}

// options.icon: 進捗ダイアログに出すアイコン SVG 文字列（省略可）。
//   通常の「PSD を開く」フローは未指定 → アイコン無し。
//   自動配置から呼ばれるときは ai-place.js が PLACE_ICON_SVG を渡す。
// options.label: アイコン直下のラベル文言（省略時は "PSD を読み込み中"）。
//   自動配置経由は "自動配置中…" を渡してプロセス全体の文脈を維持する。
export async function loadPsdFilesByPaths(files, { icon, label = "PSD を読み込み中" } = {}) {
  if (!files || files.length === 0) return;
  // ファイル名を自然順 (numeric collation) でソート。D&D / OS ダイアログ / フォルダ展開
  // のいずれもページ番号順 (page1 → page2 → page10) で先頭から並ぶようにする。
  // Rust 側の list_psd_files は字句順なので "page10" が "page2" より先に来てしまう。
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  files = [...files].sort((a, b) => collator.compare(baseName(a), baseName(b)));
  // 未保存の編集があるなら警告して確認を取る。clearPages() は state.edits / newLayers を
  // 黙って消すため、編集中のユーザーがファイル選択ダイアログ等から別 PSD を開いた瞬間に
  // 作業内容が無警告で失われる事故を防ぐ。
  if (hasEdits()) {
    const ok = await confirmDialog({
      title: "未保存の編集があります",
      message: "現在の編集内容は破棄されます。続行しますか？",
      confirmLabel: "破棄して開く",
    });
    if (!ok) return;
  }
  // 最初に選んだファイルの親ディレクトリを「別名で保存」の既定フォルダ名算出に使う。
  setFolder(parentDir(files[0]) ?? null);
  setHasSavedThisSession(false);
  // PSD を読み込み直すタイミングでガイドロックは解除。新しい PSD のガイドが
  // ない / 異なる位置にあっても古いロック状態でユーザーがハマらないようにする。
  setGuidesLocked(false);

  showProgress({
    title: label,
    detail: baseName(files[0]),
    current: 0,
    total: files.length,
    icon,
  });

  clearPages();
  renderAllSpreads();
  rebuildLayerList();
  window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));

  const failures = [];
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    updateProgress({
      detail: baseName(path),
      current: i,
      total: files.length,
    });
    try {
      const page = await loadPsdFromPath(path);
      addPage(page);
      renderAllSpreads();
      rebuildLayerList();
      window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));
    } catch (e) {
      console.error(e);
      failures.push({ path, error: e });
    }
    updateProgress({
      detail: baseName(path),
      current: i + 1,
      total: files.length,
    });
  }

  updateSaveButton();
  window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));
  hideProgress();
  if (failures.length) {
    const first = failures[0];
    const msg =
      failures.length === 1
        ? `読込失敗 ${baseName(first.path)}: ${first.error?.message ?? first.error}`
        : `読込失敗 ${failures.length} 件（${baseName(first.path)} 他）`;
    toast(msg, { kind: "error", duration: 5000 });
  }
}

export async function handleOpenFiles() {
  const files = await pickPsdFiles();
  if (!files.length) return;
  await loadPsdFilesByPaths(files);
}
