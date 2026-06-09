// 保存系: 保存ボタン、保存中の多重実行ガード。
// 上書き保存は廃止。保存は常に Tachimi 互換の
//   <Desktop>/Script_Output/OPUS写植/写植完了/  (既存時は 写植完了(1), 写植完了(2)... と連番)
// に書き出す。フロント側で空きフォルダ名を確定してから Rust に渡す。
// 外向き API: bindSaveMenu / handleSave / 保存可能フラグの get/set。

import {
  exportEdits,
  getPages,
  getPdfPaths,
  getProjectSaveDirty,
  markProjectSaveClean,
  markPsdSaveClean,
} from "../state.js";
import {
  confirmDialog,
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
import { measureAllRubyOffsetsSync } from "../canvas-tools.js";

// PSD 読込時に false にリセットされ、保存成功で true になる。
// 旧: 初回 Ctrl+S を別名保存にフォールバックさせるためのフラグ。
// 現: 上書き保存廃止により実質的な分岐ロジックは無いが、他モジュール（hasSavedThisSession を
//     参照する箇所）の互換のため state は維持。
let hasSavedThisSession = false;
// Photoshop への保存 invoke が走っている間は true。Ctrl+S や保存ボタンの連打で
// 同じ PSD に対して invoke が並行実行されると Photoshop 側で開くドキュメントが
// 競合し、片方の編集が失われる / セッションが破壊されるためガードする。
let saveInflight = false;

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

const BASE_SAVE_FOLDER_NAME = "写植完了";
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

// Photoshop スクラッチディスク (システムドライブ、通常 C:) の空き容量を 5 段階で評価し、
// 段階ごとにトーンと色の異なる警告ダイアログを出す。ユーザーが「続行」を選んだら true。
// 取得失敗 (Tauri 非接続環境 / Unix / その他) は警告スキップで true 扱い。
//
// 段階の設計:
//   - critical-5GB   < 5 GB  : 危機的 (danger)  保存中に失敗する可能性が極めて高い
//   - severe-10GB    < 10 GB : 深刻 (danger)    保存に失敗するリスクが高い
//   - warn-20GB      < 20 GB : 警告 (warning)   メモリ不足エラーの可能性
//   - caution-50GB   < 50 GB : 注意 (warning)   処理が遅くなる可能性
//   - info-100GB     < 100 GB: 案内 (warning)   起動時に Photoshop の警告ダイアログが出る可能性
//   - >= 100 GB                : 何もしない
//
// セッション中に一度「続行」が選ばれたら以降は再表示しない（毎保存ごとの煩わしさ回避）。
// 容量が悪化したケースもあえて再表示せず、起動直後の最初の保存時の確認だけで終わらせる方針。
const GB = 1024 * 1024 * 1024;
const SCRATCH_LEVELS = [
  { id: "critical-5GB",  threshold: 5  * GB, kind: "danger" },
  { id: "severe-10GB",   threshold: 10 * GB, kind: "danger" },
  { id: "warn-20GB",     threshold: 20 * GB, kind: "warning" },
  { id: "caution-50GB",  threshold: 50 * GB, kind: "warning" },
  { id: "info-100GB",    threshold: 100 * GB, kind: "warning" },
];
let scratchWarningAcknowledgedThisSession = false;
function classifyScratchLevel(freeBytes) {
  for (const lvl of SCRATCH_LEVELS) {
    if (freeBytes < lvl.threshold) return lvl;
  }
  return null;
}
function buildScratchWarningMessage(level, drivePath, freeBytes) {
  const gbStr = (freeBytes / GB).toFixed(1);
  const head = `スクラッチディスク (${drivePath}) の空き容量は約 ${gbStr} GB です。\n\n`;
  switch (level.id) {
    case "critical-5GB":
      return head +
        "【危機的】空き容量が 5 GB を切っています。\n" +
        "Photoshop は保存中にスクラッチディスクへ作業ファイルを書き出すため、\n" +
        "この状態ではファイル破損 / 保存失敗のリスクが極めて高くなります。\n\n" +
        "今すぐ不要なファイルを削除してから保存することを強くおすすめします。\n" +
        "それでもこのまま保存処理を続行しますか？";
    case "severe-10GB":
      return head +
        "【深刻】空き容量が 10 GB を切っています。\n" +
        "Photoshop が保存処理中にスクラッチディスクを使い切る可能性があり、\n" +
        "保存に失敗するリスクが高くなっています。\n\n" +
        "可能なら容量を確保してから実行することを強くおすすめします。\n" +
        "このまま保存処理を続行しますか？";
    case "warn-20GB":
      return head +
        "【警告】空き容量が 20 GB を切っています。\n" +
        "大きな PSD を編集している場合、保存中にメモリ不足エラーが発生する\n" +
        "可能性があります。\n\n" +
        "このまま保存処理を続行しますか？";
    case "caution-50GB":
      return head +
        "【注意】空き容量が 50 GB を切っています。\n" +
        "Photoshop の処理がやや遅くなる可能性があります。\n\n" +
        "このまま保存処理を続行しますか？";
    case "info-100GB":
    default:
      return head +
        "Photoshop は空き容量が 100 GB 未満のとき、\n" +
        "起動時に容量不足の警告ダイアログを表示する場合があります。\n\n" +
        "このまま保存処理を続行しますか？";
  }
}
async function ensurePhotoshopScratchOk() {
  if (scratchWarningAcknowledgedThisSession) return true;
  let info = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    info = await invoke("get_photoshop_scratch_free_space");
  } catch (e) {
    // 取得失敗時はスキップして従来通り保存処理に進む
    return true;
  }
  if (!info) return true;
  const free = Number(info.free_bytes ?? 0);
  const level = classifyScratchLevel(free);
  if (!level) return true; // 100GB 以上 → 警告不要
  const proceed = await confirmDialog({
    title: "Photoshop スクラッチディスク容量警告",
    message: buildScratchWarningMessage(level, info.path, free),
    confirmLabel: "続行",
    cancelLabel: "キャンセル",
    kind: level.kind,
  });
  if (proceed) scratchWarningAcknowledgedThisSession = true;
  return proceed;
}

async function runSaveWithMode({ saveMode, targetDir }) {
  if (saveInflight) {
    toast("保存処理中です。完了までお待ちください", { kind: "info", duration: 2200 });
    return;
  }
  flushActiveSidebarInputBeforeSave();
  if (getPages().length === 0) {
    return;
  }
  // Photoshop 起動時のスクラッチディスク容量警告を事前にチェック。
  // 100GB 未満なら confirmDialog でユーザーに伝え、続行可否を確認する。
  const scratchOk = await ensurePhotoshopScratchOk();
  if (!scratchOk) return;
  // 【v1.29.x UI-coord】payload 構築前に、全 page のルビ wrap 実描画位置を同期測定して
  // state に書き戻す。これがないと rAF 遅延で「新規に適用したばかりのルビの offsetX/Y が
  // payload に含まれない」事故が起き、JSX 側で計算式 fallback が使われて位置がズレる。
  try { measureAllRubyOffsetsSync(); } catch (e) { console.warn("[save] ruby offset measure failed:", e); }
  // 仕上がりチェック（showFinishReviewDialog）は保存フローから除去。確認ダイアログを挟まず
  // 直接 Photoshop へ反映する。実際の保存は JSX 経由で行われ page.canvas（アプリ内プレビュー）に
  // 依存しないため、出力 PSD の品質には影響しない。
  if (saveInflight) return;
  const base = exportEdits();
  const payload = {
    ...base,
    saveMode,
    targetDir: targetDir ?? null,
  };
  const projectWasCleanBeforePsdSave = !getProjectSaveDirty();
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
    // PSD への反映が完了 → PSD 側の保存ダーティを解消（ウインドウ閉じる確認の条件分岐用）。
    markPsdSaveClean();
    if (projectWasCleanBeforePsdSave) {
      markProjectSaveClean();
    }
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
      await handleSave();
      await saveProject();
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
