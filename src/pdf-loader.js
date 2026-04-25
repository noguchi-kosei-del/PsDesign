import * as pdfjsLib from "pdfjs-dist";
import { setPdf, setPdfSplitMode } from "./state.js";
import { showProgress, hideProgress, toast, updateProgress } from "./ui-feedback.js";

// 1 ページ目の物理サイズで「横長原稿」と判定する。横長なら単ページ表示（左半分のみ）。
async function detectLandscape(doc) {
  try {
    const page = await doc.getPage(1);
    const baseRotation = typeof page.rotate === "number" ? page.rotate : 0;
    const vp = page.getViewport({ scale: 1, rotation: baseRotation });
    return vp.width > vp.height;
  } catch (_) {
    return false;
  }
}

let workerConfigured = false;
function ensureWorker() {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  workerConfigured = true;
}

function basename(p) {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

async function readFileBytes(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return new Uint8Array(bytes);
}

export async function pickPdfFile() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    title: "PDFを開く",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!picked) return null;
  return typeof picked === "string" ? picked : picked?.path ?? null;
}

export async function loadPdfByPath(path) {
  if (!path) return;
  ensureWorker();
  const name = basename(path);
  showProgress({ title: "PDF を読み込み中", detail: `${name}  ファイル読込`, current: 0, total: 100 });

  // 目標値 target に向けて current を毎 30ms ずつ追従させる（遷移をごまかしなく可視化）。
  let current = 0;
  let target = 8;
  const ticker = setInterval(() => {
    if (current >= target) return;
    const delta = target - current;
    const step = Math.max(1, Math.ceil(delta * 0.18));
    current = Math.min(target, current + step);
    updateProgress({ current, total: 100 });
  }, 30);

  const setTarget = (v, detail) => {
    target = Math.max(target, Math.min(100, v));
    if (detail != null) {
      updateProgress({ detail, current, total: 100 });
    }
  };
  const waitUntilReached = async (threshold) => {
    while (current < threshold) {
      await new Promise((r) => setTimeout(r, 30));
    }
  };

  try {
    // Phase 1: ディスクからバイト読込
    setTarget(40);
    const bytes = await readFileBytes(path);

    // Phase 2: pdfjs パース
    setTarget(70, `${name}  PDF 解析`);
    const task = pdfjsLib.getDocument({ data: bytes });
    task.onProgress = ({ loaded, total }) => {
      if (typeof total === "number" && total > 0) {
        const pct = 40 + Math.round((loaded / total) * 50);
        setTarget(Math.min(90, pct));
      }
    };
    const doc = await task.promise;

    // Phase 3: 先頭ページ先読み
    setTarget(95, `${name}  先頭ページ読込`);
    try {
      await doc.getPage(1);
    } catch (_) {
      // 先読み失敗しても表示は続行
    }

    setTarget(100);
    await waitUntilReached(100);
    // 横長原稿なら単ページ化を自動 ON、縦長なら OFF。setPdf より先に確定させて初回 redraw が正しいモードで走るようにする。
    const isLandscape = await detectLandscape(doc);
    setPdfSplitMode(isLandscape);
    setPdf(doc, path);
  } catch (e) {
    console.error("PDF 読込失敗:", e);
    toast(`PDF の読込に失敗しました: ${e?.message ?? e}`, { kind: "error", duration: 5000 });
  } finally {
    clearInterval(ticker);
    hideProgress();
  }
}
