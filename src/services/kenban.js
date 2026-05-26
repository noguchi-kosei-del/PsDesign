import { notifyDialog } from "../ui-feedback.js";

const HINT_KEY = "psdesign_kenban_exe_path";
const REFERENCE_RE = /\.(pdf|tiff?|jpe?g|png)$/i;

function uniqueExistingCandidates(paths) {
  const seen = new Set();
  return (Array.isArray(paths) ? paths : [])
    .filter((path) => typeof path === "string" && path && REFERENCE_RE.test(path))
    .filter((path) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function launchKenbanPsdPdf({ psdFolder, psdPaths, referencePaths } = {}) {
  const refs = uniqueExistingCandidates(referencePaths);
  if (!psdFolder || !Array.isArray(psdPaths) || psdPaths.length === 0) {
    await notifyDialog({
      title: "KENBANで開けません",
      message: "保存したPSDの場所が取得できませんでした。",
      kind: "warning",
    });
    return;
  }
  if (refs.length === 0) {
    await notifyDialog({
      title: "KENBANで開けません",
      message: "写植見本のPDF / 画像が読み込まれていません。",
      kind: "warning",
    });
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const hint = localStorage.getItem(HINT_KEY) || null;
  let exePath = null;
  try {
    exePath = await invoke("detect_kenban_exe", { hint });
  } catch (err) {
    console.error("[kenban] detect failed", err);
    await notifyDialog({
      title: "KENBANが見つかりません",
      message: String(err ?? "検出エラー"),
      kind: "warning",
    });
    return;
  }

  if (!exePath) {
    await notifyDialog({
      title: "KENBANが見つかりません",
      message: "KENBANがインストールされていないか、想定外の場所にあります。\nKENBANをインストールしてからもう一度お試しください。",
      kind: "warning",
    });
    return;
  }

  try { localStorage.setItem(HINT_KEY, exePath); } catch (_) {}

  try {
    await invoke("launch_kenban_psd_pdf", {
      exePath,
      psdFolder,
      psdPaths,
      referencePaths: refs,
    });
  } catch (err) {
    console.error("[kenban] launch failed", err);
    await notifyDialog({
      title: "KENBANの起動に失敗しました",
      message: String(err ?? "起動エラー"),
      kind: "warning",
    });
  }
}
