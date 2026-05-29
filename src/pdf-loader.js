import * as pdfjsLib from "pdfjs-dist";
import { setPdf, setPdfExcludedReferencePages, setPdfSkipFirstBlank, setPdfSplitMode } from "./state.js";
import { showProgress, hideProgress, toast, updateProgress } from "./ui-feedback.js";
import { withProgressFlow } from "./progress-flow.js";

// 「見本」として読み込める拡張子。PDF（複数ページ）と、JPEG / PNG（単一画像）。
export const REFERENCE_EXTENSIONS = ["pdf", "jpg", "jpeg", "png"];
export const REFERENCE_EXT_REGEX = /\.(pdf|jpe?g|png)$/i;
const IMAGE_EXT_REGEX = /\.(jpe?g|png)$/i;

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

function normalizeExcludedPages(pages) {
  return new Set(
    Array.from(pages || [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0),
  );
}

async function readFileBytes(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return new Uint8Array(bytes);
}

// 自然順ソート (page1 → page2 → page10、numeric collation)。
function sortPathsNaturally(paths) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...paths].sort((a, b) => collator.compare(basename(a), basename(b)));
}

function waitForNextFrame() {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// 1 ページ目の物理サイズで「横長原稿」と判定する。横長なら単ページ表示（左右分割）。
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

function makeRenderingCancelledException() {
  const err = new Error("Rendering cancelled");
  err.name = "RenderingCancelledException";
  return err;
}

// ImageBitmap を pdfjs Page 互換オブジェクトに包む。
// pdf-view.js が触れる API: page.rotate, page.getViewport({scale,rotation}), page.render({...})
function makeImagePage(bitmap) {
  const naturalW = bitmap.width;
  const naturalH = bitmap.height;
  return {
    rotate: 0,
    getViewport({ scale = 1, rotation = 0 } = {}) {
      const r = ((Math.round(rotation) % 360) + 360) % 360;
      const swap = r === 90 || r === 270;
      const w = (swap ? naturalH : naturalW) * scale;
      const h = (swap ? naturalW : naturalH) * scale;
      return { width: w, height: h, scale, rotation: r };
    },
    render({ canvasContext, viewport }) {
      let cancelled = false;
      const promise = (async () => {
        // microtask を 1 つ挟む — 連打時に上位の cancelInFlightRender() が
        // .cancel() を呼ぶ余地を作る（呼ばれれば即 throw して描画スキップ）。
        await Promise.resolve();
        if (cancelled) throw makeRenderingCancelledException();
        const { width, height, rotation, scale } = viewport;
        const ctx = canvasContext;
        ctx.save();
        try {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.clearRect(0, 0, width, height);
          // viewport 中心を原点に取り、user 回転後にネイティブ寸法で描画。
          ctx.translate(width / 2, height / 2);
          ctx.rotate((rotation * Math.PI) / 180);
          const drawW = naturalW * scale;
          const drawH = naturalH * scale;
          ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
        } finally {
          ctx.restore();
        }
      })();
      return { promise, cancel() { cancelled = true; } };
    },
  };
}

// 複数ファイル（PDF / 画像）を 1 つの「合成 doc」にまとめる。
//   sources: Array<{ type: "image", bitmap: ImageBitmap, path: string }
//                  | { type: "pdf",   doc: pdfjsDoc, pageNum: number, path: string }>
// pdf-view.js / pdf-pages.js は doc.numPages と doc.getPage(n) しか触らないので、
// 各ソースを 1 ページずつ並べたフラットな配列にすれば従来コードに変更不要で動く。
// getSourcePath(n) で n ページ目の元ファイルパスを返す（バーのファイル名表示用）。
function makeCompositeDoc(sources) {
  return {
    numPages: sources.length,
    getPage(n) {
      const src = sources[n - 1];
      if (!src) return Promise.reject(new Error(`ページ ${n} は存在しません`));
      if (src.type === "image") return Promise.resolve(makeImagePage(src.bitmap));
      // pdf — pdfjs Page をそのまま返す
      return src.doc.getPage(src.pageNum);
    },
    getSourcePath(n) {
      const src = sources[n - 1];
      return src?.path ?? null;
    },
    getSourcePageNum(n) {
      const src = sources[n - 1];
      return src?.type === "pdf" ? src.pageNum : 1;
    },
    destroy() {
      const seenDocs = new Set();
      for (const src of sources) {
        if (src.type === "image") {
          try { if (typeof src.bitmap?.close === "function") src.bitmap.close(); } catch (_) {}
        } else if (src.type === "pdf" && !seenDocs.has(src.doc)) {
          seenDocs.add(src.doc);
          try { if (typeof src.doc.destroy === "function") src.doc.destroy(); } catch (_) {}
        }
      }
    },
  };
}

// テストモード用: ディスク I/O 無しで白紙 count ページの見本（合成 doc）を作る。
// 既存の makeCompositeDoc / makeImagePage をそのまま再利用するので pdf-view.js と互換。
export async function buildBlankReferenceDoc(count, width, height) {
  const sources = [];
  for (let i = 0; i < count; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    const bitmap = await createImageBitmap(canvas);
    sources.push({ type: "image", bitmap, path: `テストページ ${i + 1}` });
  }
  return makeCompositeDoc(sources);
}

// 単一画像ファイルを読み込み、ImageBitmap を返す。
async function readImageBitmap(path) {
  const bytes = await readFileBytes(path);
  return await createImageBitmap(new Blob([bytes]));
}

// 単一 PDF ファイルを読み込み、pdfjs ドキュメントを返す。
async function readPdfDocument(path) {
  ensureWorker();
  const bytes = await readFileBytes(path);
  return await pdfjsLib.getDocument({ data: bytes }).promise;
}

// 見本ファイル（PDF / JPEG / PNG）を選択。複数選択可。
export async function countReferencePages(paths, options = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return 0;
  const skipFirstBlankPage = !!(options.skipFirstBlankPage ?? options.skipFirstPdfPage);
  const excludedPages = normalizeExcludedPages(options.excludedPages ?? options.hiddenReferencePages);
  const filtered = sortPathsNaturally(paths.filter((p) => REFERENCE_EXT_REGEX.test(p)));
  let count = 0;
  let hasPdf = false;
  let sourceIndex = 0;
  for (const p of filtered) {
    if (IMAGE_EXT_REGEX.test(p)) {
      sourceIndex += 1;
      if (excludedPages.has(sourceIndex)) continue;
      count += 1;
      continue;
    }
    hasPdf = true;
    let doc = null;
    try {
      doc = await readPdfDocument(p);
      const pageTotal = Math.max(0, Number(doc?.numPages) || 0);
      for (let pageNum = 1; pageNum <= pageTotal; pageNum += 1) {
        sourceIndex += 1;
        if (excludedPages.has(sourceIndex)) continue;
        try {
          const page = await doc.getPage(pageNum);
          const baseRotation = typeof page.rotate === "number" ? page.rotate : 0;
          const vp = page.getViewport({ scale: 1, rotation: baseRotation });
          count += vp.width > vp.height ? 2 : 1;
        } catch (_) {
          count += 1;
        }
      }
    } finally {
      try { if (typeof doc?.destroy === "function") doc.destroy(); } catch (_) {}
    }
  }
  return skipFirstBlankPage && hasPdf ? Math.max(0, count - 1) : count;
}

export async function buildReferencePageCards(paths) {
  const filtered = Array.isArray(paths) ? paths.filter((p) => REFERENCE_EXT_REGEX.test(p)) : [];
  const sorted = sortPathsNaturally(filtered);
  const cards = [];
  let sourceIndex = 0;
  for (const p of sorted) {
    const name = basename(p);
    if (IMAGE_EXT_REGEX.test(p)) {
      sourceIndex += 1;
      let bitmap = null;
      try {
        bitmap = await readImageBitmap(p);
        cards.push({
          index: sourceIndex,
          path: p,
          fileName: name,
          pageLabel: `${cards.length + 1}P`,
          sourceLabel: name,
          thumbnail: makeImageThumbnail(bitmap),
        });
      } finally {
        try { if (typeof bitmap?.close === "function") bitmap.close(); } catch (_) {}
      }
      continue;
    }
    let doc = null;
    try {
      doc = await readPdfDocument(p);
      const total = Math.max(0, Number(doc?.numPages) || 0);
      for (let pageNum = 1; pageNum <= total; pageNum += 1) {
        sourceIndex += 1;
        let thumbnail = "";
        try {
          thumbnail = await makePdfPageThumbnail(doc, pageNum);
        } catch (e) {
          console.warn("reference page thumbnail failed:", p, pageNum, e);
        }
        cards.push({
          index: sourceIndex,
          path: p,
          fileName: name,
          pageNum,
          pageLabel: `${cards.length + 1}P`,
          sourceLabel: total > 1 ? `${name} / ${pageNum}P` : name,
          thumbnail,
        });
      }
    } finally {
      try { if (typeof doc?.destroy === "function") doc.destroy(); } catch (_) {}
    }
  }
  return cards;
}

function makeImageThumbnail(bitmap) {
  const max = 180;
  const scale = Math.min(max / Math.max(1, bitmap.width), max / Math.max(1, bitmap.height), 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function makePdfPageThumbnail(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const baseRotation = typeof page.rotate === "number" ? page.rotate : 0;
  const vp1 = page.getViewport({ scale: 1, rotation: baseRotation });
  const scale = Math.min(180 / Math.max(1, vp1.width), 180 / Math.max(1, vp1.height), 1);
  const viewport = page.getViewport({ scale, rotation: baseRotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  await task.promise;
  return canvas.toDataURL("image/jpeg", 0.82);
}

export async function pickReferenceFiles() {
  const { openFileDialog } = await import("./file-picker.js");
  const picked = await openFileDialog({
    mode: "open",
    multiple: true,
    title: "見本を読み込み",
    filters: [{ name: "見本 (PDF / JPEG / PNG)", extensions: REFERENCE_EXTENSIONS }],
    rememberKey: "reference-open",
  });
  if (!picked) return [];
  const arr = Array.isArray(picked) ? picked : [picked];
  return arr
    .map((p) => (typeof p === "string" ? p : p?.path ?? null))
    .filter(Boolean);
}

// 互換用エイリアス: 単一ファイル選択（既存コードからの呼び出し用）
export async function pickPdfFile() {
  const arr = await pickReferenceFiles();
  return arr[0] ?? null;
}

// 複数の見本ファイル（PDF / 画像）を読み込み、1 つの合成 doc として表示する。
// - PDF はその全ページが順に展開される
// - 画像は 1 ファイル = 1 ページ
// - 並び順はファイル名の自然順（page1.jpg → page2.jpg → page10.jpg）
export async function loadReferenceFiles(paths, options = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const keepProgressOpen = !!options.keepProgressOpen;
  const shouldShowProgress = options.showProgress !== false;
  const progressFlow = options.progressFlow || null;
  const skipFirstBlankPage = !!(options.skipFirstBlankPage ?? options.skipFirstPdfPage);
  const excludedPages = normalizeExcludedPages(options.excludedPages ?? options.hiddenReferencePages);
  const filtered = paths.filter((p) => REFERENCE_EXT_REGEX.test(p));
  const hasPdf = filtered.some((p) => !IMAGE_EXT_REGEX.test(p));
  if (filtered.length === 0) {
    toast("PDF / JPEG / PNG ファイルを指定してください", { kind: "error", duration: 4000 });
    return;
  }
  const sorted = sortPathsNaturally(filtered);
  const total = sorted.length;
  const progressTotal = total + 2;
  const headLabel = total === 1
    ? basename(sorted[0])
    : `${basename(sorted[0])} ほか ${total} 件`;

  if (shouldShowProgress) {
    showProgress(withProgressFlow(progressFlow, {
      title: options.title || options.label || "見本を読み込み中",
      detail: `${headLabel}  読込中`,
      current: 0,
      total: progressTotal,
      variant: options.variant || "load",
      tasks: hasPdf ? ["ファイル読込", "PDF解析", "表示準備"] : ["ファイル読込", "画像解析", "表示準備"],
      taskIndex: 0,
      taskProgress: 0,
    }));
  }

  const sources = [];
  const failures = [];
  let sourceIndex = 0;
  try {
    for (let i = 0; i < total; i++) {
      const p = sorted[i];
      const name = basename(p);
      if (shouldShowProgress) {
        updateProgress(withProgressFlow(progressFlow, {
          detail: `${name} (${i + 1} / ${total})`,
          current: i,
          total: progressTotal,
          taskIndex: 0,
        }));
      }
      await waitForNextFrame();
      try {
        if (IMAGE_EXT_REGEX.test(p)) {
          sourceIndex += 1;
          if (excludedPages.has(sourceIndex)) continue;
          const bitmap = await readImageBitmap(p);
          sources.push({ type: "image", bitmap, path: p });
        } else {
          const doc = await readPdfDocument(p);
          let addedFromDoc = false;
          for (let pn = 1; pn <= doc.numPages; pn++) {
            sourceIndex += 1;
            if (excludedPages.has(sourceIndex)) continue;
            sources.push({ type: "pdf", doc, pageNum: pn, path: p });
            addedFromDoc = true;
          }
          if (!addedFromDoc) {
            try { if (typeof doc?.destroy === "function") doc.destroy(); } catch (_) {}
          }
        }
      } catch (e) {
        console.error(`見本ファイル読込失敗 (${name}):`, e);
        failures.push({ name, error: e });
      }
    }
    if (shouldShowProgress) {
      updateProgress(withProgressFlow(progressFlow, { detail: headLabel, current: total, total: progressTotal, taskIndex: 1 }));
    }

    if (sources.length === 0) {
      toast("有効な見本ファイルがありませんでした", { kind: "error", duration: 5000 });
      return;
    }

    const compositeDoc = makeCompositeDoc(sources);
    // 横長判定は 1 ページ目（先頭ソース）で行い、PDF と同じく自動 split mode を設定。
    const isLandscape = await detectLandscape(compositeDoc);
    if (shouldShowProgress) {
      updateProgress(withProgressFlow(progressFlow, { detail: headLabel, current: total + 1, total: progressTotal, taskIndex: 2 }));
    }
    setPdfSplitMode(isLandscape);
    setPdfSkipFirstBlank(skipFirstBlankPage && hasPdf);
    // path は先頭ファイルパス（getPdfPath() の互換用）。pdfPaths に sorted 全件を渡し、
    // 画像スキャンや自動配置が複数ファイルを 画像スキャン 対象にできるようにする。
    setPdf(compositeDoc, sorted[0], sorted);
    setPdfExcludedReferencePages(excludedPages);
    if (shouldShowProgress) {
      updateProgress(withProgressFlow(progressFlow, { detail: headLabel, current: progressTotal, total: progressTotal, taskIndex: 2, taskProgress: 100 }));
    }

    if (failures.length > 0) {
      toast(
        `見本 ${sources.length === 0 ? 0 : total - failures.length} / ${total} 件を読み込みました（${failures.length} 件失敗）`,
        { kind: "info", duration: 5000 },
      );
    }
  } finally {
    if (shouldShowProgress && !keepProgressOpen) hideProgress();
  }
}

// 互換用エイリアス: 単一ファイル読込（既存コードからの呼び出し用）
export async function loadPdfByPath(path) {
  if (!path) return;
  await loadReferenceFiles([path]);
}
