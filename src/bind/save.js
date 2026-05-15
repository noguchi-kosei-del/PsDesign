// 保存系: 保存ボタン、保存中の多重実行ガード。
// 上書き保存は廃止。保存は常に Tachimi 互換の
//   <Desktop>/Script_Output/写植完了/  (既存時は 写植完了(1), 写植完了(2)... と連番)
// に書き出す。フロント側で空きフォルダ名を確定してから Rust に渡す。
// 外向き API: bindSaveMenu / handleSave / 保存可能フラグの get/set。

import { exportEdits, getFolder, getPages, hasEdits } from "../state.js";
import {
  hideProgress,
  notifyDialog,
  showProgress,
  toast,
} from "../ui-feedback.js";
import { baseName, joinPath } from "../utils/path.js";
import { launchTachimiWithPaths } from "../services/tachimi.js";
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
  const btn = document.getElementById("save-btn");
  if (btn) btn.disabled = getPages().length === 0;
}

const BASE_SAVE_FOLDER_NAME = "写植完了";
// 連番フォーマット: BASE, BASE(1), BASE(2), ...（Tachimi の `jpg(1)` 命名に合わせて空白なし）。
function indexedSaveFolderName(i) {
  return i === 0 ? BASE_SAVE_FOLDER_NAME : `${BASE_SAVE_FOLDER_NAME}(${i})`;
}
// 安全上限。通常運用で 1000 個もできないが暴走防止。
const MAX_FOLDER_INDEX = 9999;

async function runSaveWithMode({ saveMode, targetDir }) {
  if (saveInflight) {
    toast("保存処理中です。完了までお待ちください", { kind: "info", duration: 2200 });
    return;
  }
  if (!hasEdits()) {
    toast("編集内容がありません", { kind: "info" });
    return;
  }
  // 【v1.29.x UI-coord】payload 構築前に、全 page のルビ wrap 実描画位置を同期測定して
  // state に書き戻す。これがないと rAF 遅延で「新規に適用したばかりのルビの offsetX/Y が
  // payload に含まれない」事故が起き、JSX 側で計算式 fallback が使われて位置がズレる。
  try { measureAllRubyOffsetsSync(); } catch (e) { console.warn("[save] ruby offset measure failed:", e); }
  const base = exportEdits();
  const payload = {
    ...base,
    saveMode,
    targetDir: targetDir ?? null,
  };
  saveInflight = true;
  const saveBtn = document.getElementById("save-btn");
  if (saveBtn) saveBtn.disabled = true;
  showProgress({ title: "Photoshop に反映中", detail: "スクリプトを実行しています..." });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
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
    // 保存完了は中央モーダルで通知。警告有無で kind を切替（warning=オレンジ + 警告 SVG / success=緑 + チェック SVG）。
    // 「PDF 化に進む」ボタンを併設し、保存した PSD を Tachimi (写植チェッカー / PDF 化機能あり) に流して開く。
    await notifyDialog({
      title: hasWarn ? "保存完了（警告あり）" : "保存完了",
      message: `${result}${suffix}`,
      kind: hasWarn ? "warning" : "success",
      primaryAction: {
        label: "PDF 化に進む",
        kind: "place",
        onClick: () => launchTachimiWithPaths(savedPaths),
      },
    });
  } catch (e) {
    console.error(e);
    await hideProgress();
    toast(`保存失敗: ${e.message ?? e}`, { kind: "error", duration: 5000 });
  } finally {
    saveInflight = false;
    // pages 0 件なら disabled のまま。ある場合のみ復帰。
    if (saveBtn) saveBtn.disabled = getPages().length === 0;
  }
}

// 旧 handleOverwriteSave は廃止。Ctrl+S からの呼出経路の互換のため、handleSave への
// alias を残しておく（main.js の runShortcut("save") / runShortcut("saveAs") 両方が
// handleSave を呼ぶようになっている）。
export async function handleOverwriteSave() {
  await handleSave();
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

export async function handleSave() {
  if (getPages().length === 0) return;

  // Tachimi 互換の自動保存先決定: <Desktop>/Script_Output/<写植完了 [連番]>/。
  // 親フォルダ選択ダイアログは廃止。既に「写植完了」がある場合は上書きせず、
  // 「写植完了(1)」「写植完了(2)」… と空き番号を順に取って新規フォルダを作成。
  let desktop;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    desktop = await invoke("desktop_dir");
  } catch (e) {
    console.error("[save] desktop_dir failed:", e);
    toast(`保存先の取得に失敗しました: ${e?.message ?? e}`, { kind: "error", duration: 5000 });
    return;
  }
  if (typeof desktop !== "string" || !desktop) {
    toast("デスクトップフォルダが見つかりません", { kind: "error", duration: 4000 });
    return;
  }

  const scriptOutputDir = joinPath(desktop, "Script_Output");
  const folderName = await pickNextSaveFolderName(scriptOutputDir);
  const targetDir = joinPath(scriptOutputDir, folderName);

  // 中間フォルダ Script_Output / 終端 写植完了(N) は apply_edits_via_photoshop の
  // create_dir_all で再帰的に作られるので、フロント側での明示作成は不要。
  await runSaveWithMode({ saveMode: "saveAs", targetDir });
}

// 旧名互換のため alias を残す（main.js が `handleSaveAs` を import している）。
export const handleSaveAs = handleSave;

// 旧バージョンの保存ドロップダウン（上書き保存 / 別名で保存 2 項目）は撤去。
// save-btn は単独でクリックされ、handleSave を呼ぶだけのシンプルな構造になった。
// 関数名 bindSaveMenu は main.js 側の import を壊さないため温存。
export function bindSaveMenu() {
  const btn = document.getElementById("save-btn");
  if (!btn) return;
  btn.setAttribute("aria-haspopup", "false");
  btn.removeAttribute("aria-expanded");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleSave();
  });
}
