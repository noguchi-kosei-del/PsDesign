// PSD ファイル選択 / 読込のフロー。pickPsdFiles / loadPsdFilesByPaths を提供する。
// 旧 main.js から切り出し、auto-place.js が main.js を動的 import で参照していた循環参照を解消。
//
// loadPsdFilesByPaths が main.js 内の UI 更新関数（updatePageNav / updatePsdRotateVisibility
// / updatePsdGuidesLockVisibility）を直接呼ぶと逆向きの循環が生じるため、読込終了時に
// `psdesign:psd-loaded` の CustomEvent を window に dispatch する。main.js 側は init() で
// 1 度だけリスナーを張り、必要な update 関数群を呼ぶ。

import { addPage, clearPages, hasEdits, setFolder } from "../state.js";
import { confirmDialog, hideProgress, notifyDialog, showProgress, toast, updateProgress } from "../ui-feedback.js";
import { withProgressFlow } from "../progress-flow.js";
import { renderAllSpreads } from "../spread-view.js";
import { rebuildLayerList } from "../text-editor.js";
import { UnsupportedBitmapPsdError, loadPsdFromPath } from "../psd-loader.js";
import { baseName, parentDir } from "../utils/path.js";
import { setGuidesLocked } from "../rulers.js";

function isUnsupportedBitmapPsdError(error) {
  return error instanceof UnsupportedBitmapPsdError || error?.code === "UNSUPPORTED_BITMAP_PSD";
}

export function formatUnsupportedBitmapMessage(paths) {
  if (paths.length === 1) {
    return `「${baseName(paths[0])}」はモノクロ2階調のPSDのため読み込めません。RGBカラーまたはグレースケールに変換してから開いてください。`;
  }
  const shown = paths.slice(0, 10).map((path) => `・${baseName(path)}`).join("\n");
  const rest = paths.length > 10 ? `\nほか ${paths.length - 10} 件` : "";
  return `以下のPSDはモノクロ2階調のため読み込めません。\n\n${shown}${rest}\n\nRGBカラーまたはグレースケールに変換してから開いてください。`;
}

function isBitmapPsdHeader(bytes) {
  if (!bytes || bytes.length < 26) return false;
  const sig =
    String.fromCharCode(bytes[0]) +
    String.fromCharCode(bytes[1]) +
    String.fromCharCode(bytes[2]) +
    String.fromCharCode(bytes[3]);
  if (sig !== "8BPS") return false;
  const colorMode = (bytes[24] << 8) | bytes[25];
  return colorMode === 0;
}

async function isUnsupportedBitmapPsdPath(path) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke("read_binary_file", { path });
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    return isBitmapPsdHeader(bytes);
  } catch (e) {
    console.warn("[psd-load] PSD bitmap preflight failed:", path, e);
    return false;
  }
}

export async function findUnsupportedBitmapPsdFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const unsupported = [];
  for (const path of list) {
    if (typeof path !== "string" || !path) continue;
    if (await isUnsupportedBitmapPsdPath(path)) unsupported.push(path);
  }
  return unsupported;
}

export async function notifyUnsupportedBitmapPsdFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  await notifyDialog({
    title: "モノクロ2階調のPSDは読み込めません",
    message: formatUnsupportedBitmapMessage(paths),
    kind: "warning",
  });
}

export async function pickPsdFiles(opts = {}) {
  const { openFileDialog } = await import("../file-picker.js");
  const picked = await openFileDialog({
    mode: "open",
    multiple: true,
    title: "PSDを開く",
    filters: [{ name: "Photoshop Document", extensions: ["psd"] }],
    // 呼び出し側が rememberKey を上書き可能（写植フローの 3 カードで共有フォルダ記憶に使う）。
    rememberKey: opts.rememberKey ?? "psd-open",
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
//   自動配置から呼ばれるときは auto-place.js が PLACE_ICON_SVG を渡す。
// options.label: アイコン直下のラベル文言（省略時は "PSD を読み込み中"）。
//   自動配置経由は "自動配置中…" を渡してプロセス全体の文脈を維持する。
export async function loadPsdFilesByPaths(files, {
  icon,
  label = "PSD を読み込み中",
  keepProgressOpen = false,
  variant = "load",
  confirmUnsaved = true,
  preserveOrder = false,
  progressFlow = null,
} = {}) {
  if (!files || files.length === 0) return;
  // ファイル名を自然順 (numeric collation) でソート。D&D / OS ダイアログ / フォルダ展開
  // のいずれもページ番号順 (page1 → page2 → page10) で先頭から並ぶようにする。
  // Rust 側の list_psd_files は字句順なので "page10" が "page2" より先に来てしまう。
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  files = preserveOrder
    ? [...files]
    : [...files].sort((a, b) => collator.compare(baseName(a), baseName(b)));
  // 未保存の編集があるなら警告して確認を取る。clearPages() は state.edits / newLayers を
  // 黙って消すため、編集中のユーザーがファイル選択ダイアログ等から別 PSD を開いた瞬間に
  // 作業内容が無警告で失われる事故を防ぐ。
  if (confirmUnsaved && hasEdits()) {
    const ok = await confirmDialog({
      title: "未保存の編集があります",
      message: "現在の編集内容は破棄されます。続行しますか？",
      confirmLabel: "破棄して開く",
    });
    if (!ok) return;
  }
  // 最初に選んだファイルの親ディレクトリを「別名で保存」の既定フォルダ名算出に使う。
  setFolder(parentDir(files[0]) ?? null);
  // PSD を読み込み直すタイミングでガイドロックは解除。新しい PSD のガイドが
  // ない / 異なる位置にあっても古いロック状態でユーザーがハマらないようにする。
  setGuidesLocked(false);

  showProgress(withProgressFlow(progressFlow, {
    title: label,
    detail: baseName(files[0]),
    current: 0,
    total: files.length,
    icon,
    variant,
    tasks: ["ファイル確認", "PSD解析", "ページ表示"],
    taskIndex: 0,
    taskProgress: 0,
  }));

  clearPages();
  renderAllSpreads();
  rebuildLayerList();
  window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));

  const failures = [];
  const unsupportedBitmapFiles = [];
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    updateProgress(withProgressFlow(progressFlow, {
      detail: baseName(path),
      current: i,
      total: files.length,
      taskIndex: i === 0 ? 0 : 1,
    }));
    try {
      const page = await loadPsdFromPath(path);
      addPage(page);
      renderAllSpreads();
      rebuildLayerList();
      window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));
    } catch (e) {
      console.error(e);
      if (isUnsupportedBitmapPsdError(e)) {
        unsupportedBitmapFiles.push(path);
      } else {
        failures.push({ path, error: e });
      }
    }
    updateProgress(withProgressFlow(progressFlow, {
      detail: baseName(path),
      current: i + 1,
      total: files.length,
      taskIndex: i + 1 >= files.length ? 2 : 1,
    }));
  }

  window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));
  // 全件失敗のときは緑チェック演出をスキップ。1 件でも成功していれば success 表示。
  const allFailed = failures.length + unsupportedBitmapFiles.length === files.length;
  if (!keepProgressOpen || allFailed) {
    await hideProgress({ success: !allFailed });
  }
  if (unsupportedBitmapFiles.length) {
    await notifyUnsupportedBitmapPsdFiles(unsupportedBitmapFiles);
  }
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
