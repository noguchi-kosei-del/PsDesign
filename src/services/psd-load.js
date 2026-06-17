// PSD ファイル選択 / 読込のフロー。pickPsdFiles / loadPsdFilesByPaths を提供する。
// 旧 main.js から切り出し、auto-place.js が main.js を動的 import で参照していた循環参照を解消。
//
// loadPsdFilesByPaths が main.js 内の UI 更新関数（updatePageNav / updatePsdRotateVisibility
// / updatePsdGuidesLockVisibility）を直接呼ぶと逆向きの循環が生じるため、読込終了時に
// `psdesign:psd-loaded` の CustomEvent を window に dispatch する。main.js 側は init() で
// 1 度だけリスナーを張り、必要な update 関数群を呼ぶ。

import { addPage, clearPages, hasEdits, setFolder, setAppMode } from "../state.js";
import { confirmDialog, hideProgress, notifyDialog, showProgress, toast, updateProgress } from "../ui-feedback.js";
import { withProgressFlow } from "../progress-flow.js";
import { renderAllSpreads } from "../spread-view.js";
import { rebuildLayerList } from "../text-editor.js";
import { UnsupportedBitmapPsdError, expandLandscapePsdPage, loadPsdFromPath } from "../psd-loader.js";
import { baseName, parentDir } from "../utils/path.js";
import { setGuidesLocked, setGuidesFromPsd, setRulersVisible, applyGuidesToPaths } from "../rulers.js";
import { refreshMemoryStatus } from "../memory-mode.js";
import { endLoadOperation, tryBeginLoadOperation } from "./load-guard.js";

function isUnsupportedBitmapPsdError(error) {
  return error instanceof UnsupportedBitmapPsdError || error?.code === "UNSUPPORTED_BITMAP_PSD";
}

function hasCompleteGuideFrame(guides) {
  return !!guides
    && Array.isArray(guides.h)
    && Array.isArray(guides.v)
    && guides.h.length >= 2
    && guides.v.length >= 2;
}

function formatUnsupportedBitmapMessage(paths) {
  if (paths.length === 1) {
    return `「${baseName(paths[0])}」はモノクロ2階調のPSDのため読み込めません。RGBカラーまたはグレースケールに変換してから開いてください。`;
  }
  const shown = paths.slice(0, 10).map((path) => `・${baseName(path)}`).join("\n");
  const rest = paths.length > 10 ? `\nほか ${paths.length - 10} 件` : "";
  return `以下のPSDはモノクロ2階調のため読み込めません。\n\n${shown}${rest}\n\nRGBカラーまたはグレースケールに変換してから開いてください。`;
}
async function isUnsupportedBitmapPsdPath(path) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("is_unsupported_bitmap_psd", { path }) === true;
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

function formatPsdDiagnosticsLine(item) {
  const d = item?.diagnostics ?? {};
  const parts = [
    `・${baseName(item.path)}`,
    `レイヤー数: ${d.estimatedLayerCount ?? "不明"}`,
    `テキスト: ${d.visibleTextLayerCount ?? "不明"}`,
    `非表示テキスト: ${d.hiddenTextLayerCount ?? "不明"}`,
    `プレビュー: ${d.finalCanvasSource ?? "不明"}`,
  ];
  if (d.skipLayerImageData) parts.push("レイヤー画像: 省略");
  if (d.photoshopTextMetadataFallback === "ok") {
    const matched = d.photoshopTextMetadataMatched ?? 0;
    const imported = d.photoshopTextMetadataImported ?? 0;
    parts.push(`PS補正: ${matched + imported}/${d.photoshopTextMetadataTotal ?? "不明"}`);
  } else if (d.photoshopTextMetadataFallback === "failed") {
    parts.push("PS補正: 失敗");
  }
  return parts.join(" / ");
}

async function notifyLightParseDiagnostics(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const shown = items.slice(0, 8).map(formatPsdDiagnosticsLine).join("\n");
  const rest = items.length > 8 ? `\nほか ${items.length - 8} 件` : "";
  await notifyDialog({
    title: "多レイヤーPSDを軽量モードで読み込みました",
    message:
      "メモリ保護のため、レイヤー画像の一部を省略して読み込みました。"
      + "表示プレビューや配置確認が通常読み込みより不正確になる場合があります。\n\n"
      + `${shown}${rest}`,
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
  loadOperationToken = null,
} = {}) {
  if (!files || files.length === 0) return;
  const ownLoadOperationToken = loadOperationToken ? null : tryBeginLoadOperation("psd-load");
  if (!loadOperationToken && !ownLoadOperationToken) {
    toast("PSDの読み込み中です。完了までお待ちください", { kind: "info", duration: 2200 });
    return;
  }
  try {
  await refreshMemoryStatus();
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
  const preflightUnsupportedBitmapFiles = await findUnsupportedBitmapPsdFiles(files);
  if (preflightUnsupportedBitmapFiles.length) {
    await notifyUnsupportedBitmapPsdFiles(preflightUnsupportedBitmapFiles);
    const unsupportedSet = new Set(preflightUnsupportedBitmapFiles);
    files = files.filter((path) => !unsupportedSet.has(path));
    if (!files.length) return;
  }
  // 通常の PSD 読込なので写植再利用モードを解除する（reuse から通常へ切替えたケース対応）。
  setAppMode("normal");
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
  const lightParseDiagnostics = [];
  // 読み込めた PSD のパス一覧。塗り足し枠を全ページへ展開する際のコピー先に使う。
  const loadedPaths = [];
  // PSD 埋め込みガイドが塗り足し枠（縦2+横2）を成す最初のページのパス。
  // 1 ページでも塗り足し枠が入っていれば、それを全ページへ適用する（コピー元）。
  let sourceFramePath = null;
  const completeFramePaths = new Set();
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
      if (page?.psdDiagnostics?.lightParseUsed) {
        lightParseDiagnostics.push({ path, diagnostics: page.psdDiagnostics });
      }
      const viewPages = expandLandscapePsdPage(page);
      for (const viewPage of viewPages) addPage(viewPage);
      loadedPaths.push(page.path);
      // PSD に埋め込まれたガイド（トンボ/塗り足し枠）を定規へ流し込む。
      if (page.psdGuides && (page.psdGuides.h.length || page.psdGuides.v.length)) {
        setGuidesFromPsd(page.path, page.psdGuides);
        for (const viewPage of viewPages) {
          if (viewPage.path !== page.path && viewPage.psdGuides) setGuidesFromPsd(viewPage.path, viewPage.psdGuides);
        }
        // 最初に塗り足し枠（縦2+横2）が揃ったページをコピー元として記録。
        if (hasCompleteGuideFrame(page.psdGuides)) {
          completeFramePaths.add(page.path);
          if (!sourceFramePath) sourceFramePath = page.path;
        }
      }
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

  // 1 ページでも塗り足し枠が入っていれば、ガイド不足ページだけへコピーして補完する。
  // 各 PSD が自前で完全な枠を持つ場合は、そのページ固有のガイドを保持する。
  // その後、定規を自動表示してロック（枠外ディム = 塗り足し表示）。
  // setRulersVisible を先に呼ぶ（requestRulerRedraw が rulersVisible を見るため）。
  // 必要なページへ展開済みなので setGuidesLocked は skipApply: true（再コピー不要）。
  if (sourceFramePath) {
    const missingFramePaths = loadedPaths.filter((path) => !completeFramePaths.has(path));
    if (missingFramePaths.length > 0) applyGuidesToPaths(missingFramePaths, sourceFramePath);
    setRulersVisible(true);
    setGuidesLocked(true, { skipApply: true });
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
  if (lightParseDiagnostics.length) {
    await notifyLightParseDiagnostics(lightParseDiagnostics);
  }
  if (failures.length) {
    const first = failures[0];
    const msg =
      failures.length === 1
        ? `読込失敗 ${baseName(first.path)}: ${first.error?.message ?? first.error}`
        : `読込失敗 ${failures.length} 件（${baseName(first.path)} 他）`;
    toast(msg, { kind: "error", duration: 5000 });
  }
  } finally {
    if (ownLoadOperationToken) endLoadOperation(ownLoadOperationToken);
  }
}
