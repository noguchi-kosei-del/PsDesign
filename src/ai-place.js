// 吹き出し検出 × TXT 自動配置 (v1.2.0)
//
// ai-ocr.js が保存した MokuroDocument (吹き出し座標 + OCR テキスト) と、
// txt-source.js から取れる TXT ブロック (ページ別) を突き合わせ、
// PSD の正しい位置に新規テキストレイヤーを生成する。
//
// 配置確定後は state.newLayers に積まれ、renderOverlay() が in-app プレビュー
// に即座に反映する。実際の Photoshop 書き出しは既存の Ctrl+S (保存) フロー。

import {
  getPages,
  getAiOcrDoc,
  onAiOcrDocChange,
  addNewLayer,
  getCurrentFont,
  getTextSize,
  getLeadingPct,
  getStrokeColor,
  getStrokeWidthPx,
  getFillColor,
  getPdfPaths,
  getTxtSource,
  onTxtSourceChange,
  getNewLayers,
  updateNewLayer,
  beginHistoryTransient,
  abortHistoryTransient,
} from "./state.js";
import { parsePages } from "./txt-source.js";
import { notifyDialog, confirmDialog } from "./ui-feedback.js";
import { loadPsdFilesByPaths, pickPsdFiles } from "./services/psd-load.js";
import { runAiOcrForFiles } from "./ai-ocr.js";
import { renderAllSpreads } from "./spread-view.js";
import { rebuildLayerList } from "./text-editor.js";

const $ = (id) => document.getElementById(id);

let runningPlace = false;
// 直近に適用された配置プランのテキスト内容指紋。
// 同一テキストで連続して自動配置するときに確認ダイアログを出すために使う。
let lastPlacedFingerprint = null;

function planFingerprint(plan) {
  const seq = [];
  for (const row of plan.pages) {
    for (const layer of row.layers) seq.push(layer.contents ?? "");
  }
  return JSON.stringify(seq);
}

// ============================================================
// 吹き出し読み順ソート (縦書き漫画: 右上 → 左下)
// ============================================================
// y-中心が近いブロックを行クラスタに束ねる。バンドは平均ブロック高 × 0.5。
// 行は上から下、行内は右から左 (縦書き混在時の読み順は同じ)。
function sortBlocksMangaOrder(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const items = blocks.map((b) => ({
    block: b,
    cx: (b.box[0] + b.box[2]) / 2,
    cy: (b.box[1] + b.box[3]) / 2,
    h: b.box[3] - b.box[1],
  }));
  // y 順に処理して行を組み立てる
  items.sort((a, b) => a.cy - b.cy);
  const avgH = items.reduce((s, it) => s + it.h, 0) / items.length;
  const band = Math.max(avgH * 0.5, 1);
  const rows = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r.cy - it.cy) <= band);
    if (row) {
      row.items.push(it);
      row.cy = (row.cy * (row.items.length - 1) + it.cy) / row.items.length;
    } else {
      rows.push({ cy: it.cy, items: [it] });
    }
  }
  rows.sort((a, b) => a.cy - b.cy);
  for (const row of rows) row.items.sort((a, b) => b.cx - a.cx); // 右 → 左
  return rows.flatMap((r) => r.items.map((i) => i.block));
}

// ============================================================
// 1 ブロック → NewLayer 変換
// ============================================================
// canvas-tools.js の placeTxtSelectionAt + centerTopLeft + layerRectForNew と
// 同じ手順:
//   (1) クリック位置 = bubble の中心 (PSD 座標)
//   (2) 文字サイズ・行数・文字数からレイヤー矩形のサイズを推定
//   (3) クリック位置からレイヤーの中心が一致するよう top-left をオフセット
function longestLine(s) {
  if (!s) return 0;
  const lines = String(s).split(/\r?\n/);
  let max = 0;
  for (const line of lines) if (line.length > max) max = line.length;
  return max;
}
function countLines(s) {
  if (!s) return 0;
  return String(s).split(/\r?\n/).length;
}
// canvas-tools.js layerRectForNew の幅・高さ計算と同一ロジック (px は PSD 座標)。
// thick の安全余白 (+0.4em) も canvas-tools.js と揃える。
function estimateLayerSize(psdPage, sizePt, contents, leadingPct, direction) {
  const dpi = psdPage.dpi ?? 72;
  const ptInPsdPx = sizePt * (dpi / 72);
  const chars = Math.max(1, longestLine(contents));
  const lineCount = Math.max(1, countLines(contents));
  const leadingFactor = (leadingPct ?? 125) / 100;
  const thick = Math.max(24, ptInPsdPx * (leadingFactor * lineCount + 0.4));
  const longRaw = Math.max(ptInPsdPx * 2, ptInPsdPx * 1.05 * chars);
  const isVertical = direction !== "horizontal";
  const maxLong = isVertical ? psdPage.height * 0.95 : psdPage.width * 0.95;
  const long = Math.min(longRaw, maxLong);
  return {
    width:  isVertical ? thick : long,
    height: isVertical ? long  : thick,
  };
}

function mapBlockToNewLayer(block, mokuroPage, psdPage, contents, defaults, sourceTxtRef) {
  const sx = psdPage.width / Math.max(mokuroPage.img_width, 1);
  const sy = psdPage.height / Math.max(mokuroPage.img_height, 1);
  const direction = block.vertical ? "vertical" : "horizontal";
  // bubble bbox の中心を PSD 座標に変換 → "ユーザーがクリックした位置" と等価。
  const cx = ((block.box[0] + block.box[2]) / 2) * sx;
  const cy = ((block.box[1] + block.box[3]) / 2) * sy;
  // 推定レイヤー矩形サイズ → top-left を中心合わせで算出
  // (canvas-tools.js: centerTopLeft = clickX - width/2, clickY - height/2)
  const text = contents ?? "";
  const { width, height } = estimateLayerSize(
    psdPage, defaults.sizePt ?? 24, text, defaults.leadingPct ?? 125, direction,
  );
  const x = cx - width / 2;
  const y = cy - height / 2;
  return {
    psdPath: psdPage.path,
    x,
    y,
    contents: text,
    direction,
    fontPostScriptName: defaults.fontPostScriptName,
    sizePt: defaults.sizePt,
    leadingPct: defaults.leadingPct,
    strokeColor: defaults.strokeColor,
    strokeWidthPx: defaults.strokeWidthPx,
    fillColor: defaults.fillColor,
    sourceTxtRef,
  };
}

// ============================================================
// 配置プラン構築
// ============================================================
// 戻り値:
//   {
//     pages: [
//       {
//         pageIndex,    // 1-based
//         psdName,      // 表示用ファイル名
//         bubbleCount,  // 検出吹き出し数
//         txtCount,     // TXT ブロック数
//         placedCount,  // 実際に配置するペア数
//         status,       // "ok" | "warn-txt-extra" | "warn-bubble-extra" | "warn-empty-txt" | "warn-empty-bubble"
//         layers,       // NewLayer 配列 (placedCount 件)
//         leftoverTxt,  // 余り TXT ブロック配列
//         leftoverBubbles, // 余り吹き出しの OCR テキスト配列
//       }, ...
//     ],
//     totals: { placed, leftoverTxt, leftoverBubbles },
//   }
function buildPlacementPlan(mokuroDoc, psdPages, txtByPage, defaults) {
  const N = Math.min(psdPages.length, mokuroDoc.pages.length);
  const out = { pages: [], totals: { placed: 0, leftoverTxt: 0, leftoverBubbles: 0 } };
  const baseName = (p) => {
    const m = p && p.match(/[\\/]([^\\/]+)$/);
    return m ? m[1] : (p || "");
  };
  for (let i = 0; i < N; i++) {
    const psd = psdPages[i];
    const mokuro = mokuroDoc.pages[i];
    const txt = txtByPage.get(i + 1) ?? [];
    const sorted = sortBlocksMangaOrder(mokuro.blocks ?? []);
    const placedCount = Math.min(txt.length, sorted.length);
    const layers = [];
    for (let j = 0; j < placedCount; j++) {
      // sourceTxtRef は TXT 編集時にレイヤー contents を追従させるための紐付け。
      // pageNumber は 1-based、paragraphIndex はそのページ内 0-based。
      layers.push(mapBlockToNewLayer(
        sorted[j], mokuro, psd, txt[j], defaults,
        { pageNumber: i + 1, paragraphIndex: j },
      ));
    }
    const leftoverTxt = txt.slice(placedCount);
    const leftoverBubbles = sorted.slice(placedCount).map((b) =>
      Array.isArray(b.lines) ? b.lines.join(" ") : ""
    );
    let status = "ok";
    if (sorted.length === 0 && txt.length === 0) status = "ok";
    else if (sorted.length === 0) status = "warn-empty-bubble";
    else if (txt.length === 0) status = "warn-empty-txt";
    else if (txt.length > sorted.length) status = "warn-txt-extra";
    else if (sorted.length > txt.length) status = "warn-bubble-extra";

    out.pages.push({
      pageIndex: i + 1,
      psdName: baseName(psd.path),
      bubbleCount: sorted.length,
      txtCount: txt.length,
      placedCount,
      status,
      layers,
      leftoverTxt,
      leftoverBubbles,
    });
    out.totals.placed += placedCount;
    out.totals.leftoverTxt += leftoverTxt.length;
    out.totals.leftoverBubbles += leftoverBubbles.length;
  }
  // PSD 数 / OCR ページ数の不一致を末尾に warning として記録
  if (psdPages.length > N) {
    out.unmappedPsdCount = psdPages.length - N;
  }
  if (mokuroDoc.pages.length > N) {
    out.unmappedMokuroCount = mokuroDoc.pages.length - N;
  }
  return out;
}

// ============================================================
// 確認モーダル UI
// ============================================================
// ステータス用 SVG アイコン（lucide ベース）。
// check（一致）と alert-triangle（警告）の 2 種類。stroke は currentColor で
// .ai-place-status-ok / .ai-place-status-warn の色を継承する。
const STATUS_ICON_SVG = {
  ok:
    '<svg class="ai-place-status-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="20 6 9 17 4 12"/></svg>',
  warn:
    '<svg class="ai-place-status-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
    '<line x1="12" y1="9" x2="12" y2="13"/>' +
    '<line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

const STATUS_LABEL = {
  "ok":               { text: "一致",          icon: STATUS_ICON_SVG.ok,   cls: "ai-place-status-ok" },
  "warn-txt-extra":   { text: "TXT 余",        icon: STATUS_ICON_SVG.warn, cls: "ai-place-status-warn" },
  "warn-bubble-extra":{ text: "吹き出し余",     icon: STATUS_ICON_SVG.warn, cls: "ai-place-status-warn" },
  "warn-empty-txt":   { text: "TXT なし",      icon: STATUS_ICON_SVG.warn, cls: "ai-place-status-warn" },
  "warn-empty-bubble":{ text: "吹き出しなし",   icon: STATUS_ICON_SVG.warn, cls: "ai-place-status-warn" },
};

function renderPlanReviewTable(plan) {
  const tbody = $("ai-place-review-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const row of plan.pages) {
    const tr = document.createElement("tr");
    const meta = STATUS_LABEL[row.status] ?? STATUS_LABEL.ok;
    tr.innerHTML = `
      <td class="ai-place-col-page">${row.pageIndex}</td>
      <td class="ai-place-col-psd" title="${escapeHtml(row.psdName)}">${escapeHtml(row.psdName)}</td>
      <td class="ai-place-col-num">${row.bubbleCount}</td>
      <td class="ai-place-col-num">${row.txtCount}</td>
      <td class="ai-place-col-num">${row.placedCount}</td>
      <td class="ai-place-col-status ${meta.cls}">${meta.icon}<span class="ai-place-status-text">${meta.text}${
        row.status === "warn-txt-extra" ? ` ${row.leftoverTxt.length}` :
        row.status === "warn-bubble-extra" ? ` ${row.leftoverBubbles.length}` :
        ""
      }</span></td>
    `;
    tbody.appendChild(tr);
  }
  const totals = plan.totals;
  const summary = $("ai-place-review-summary");
  if (summary) {
    const extra = [];
    if (plan.unmappedPsdCount) extra.push(`PSD ${plan.unmappedPsdCount} 枚は OCR 結果なし`);
    if (plan.unmappedMokuroCount) extra.push(`OCR ${plan.unmappedMokuroCount} ページは PSD なし`);
    summary.textContent =
      `配置予定 ${totals.placed} 件 / TXT 余 ${totals.leftoverTxt} 件 / 吹き出し余 ${totals.leftoverBubbles} 件` +
      (extra.length ? ` / ${extra.join(" / ")}` : "");
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showPlanReviewModal(plan) {
  return new Promise((resolve) => {
    const modal = $("ai-place-review-modal");
    const okBtn = $("ai-place-review-ok");
    const cancelBtn = $("ai-place-review-cancel");
    if (!modal || !okBtn || !cancelBtn) {
      resolve(false);
      return;
    }
    renderPlanReviewTable(plan);
    modal.hidden = false;
    const cleanup = (result) => {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
      else if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    okBtn.disabled = plan.totals.placed === 0;
    requestAnimationFrame(() => okBtn.focus());
  });
}

// ============================================================
// 確定 → addNewLayer 一括
// ============================================================
function applyPlan(plan) {
  let added = 0;
  for (const row of plan.pages) {
    for (const layer of row.layers) {
      addNewLayer(layer);
      added++;
    }
  }
  if (added > 0) {
    // overlay の再描画とレイヤーリスト更新を即座に反映
    try { renderAllSpreads(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
  }
  return added;
}

// ============================================================
// 自動配置メインフロー
// ============================================================
async function runAutoPlace() {
  if (runningPlace) return;
  runningPlace = true;
  try {
    // 1. PSD / TXT の事前確認
    //    PSD 未読込なら、ファイル選択ダイアログを起動して読み込みまで一気通貫で進める
    //    (ユーザーがダイアログをキャンセルした場合は静かに戻る)。
    let psdPages = getPages();
    if (!psdPages || psdPages.length === 0) {
      const files = await pickPsdFiles();
      if (!files || files.length === 0) return;
      await loadPsdFilesByPaths(files);
      psdPages = getPages();
      if (!psdPages || psdPages.length === 0) {
        // 読み込みが全件失敗 (loadPsdFilesByPaths が内部で notifyDialog を出す) 等
        return;
      }
    }
    const txtSrc = getTxtSource();
    if (!txtSrc || !txtSrc.content) {
      await notifyDialog({
        title: "自動配置できません",
        message: "テキストが読み込まれていません。\n先に TXT を開くか、画像スキャンを実行してください。",
      });
      return;
    }
    const parsed = parsePages(txtSrc.content);
    const txtByPage = parsed.hasMarkers ? parsed.byPage : new Map([[1, parsed.all]]);

    // 2. OCR キャッシュ確認
    //   - キャッシュ有効: 結果あり & pages 1 件以上 → そのまま再利用
    //   - 無効なら、読込済み見本ファイル全てを対象に画像スキャンを自動トリガーする。
    let cache = getAiOcrDoc();
    const cacheValid = !!(
      cache &&
      cache.doc &&
      Array.isArray(cache.doc.pages) &&
      cache.doc.pages.length > 0
    );
    if (!cacheValid) {
      const loadedRefs = getPdfPaths();
      if (loadedRefs.length === 0) {
        await notifyDialog({
          title: "自動配置できません",
          message: "OCR の元になる PDF / 画像が必要です。\n先に PDF を開くか、画像スキャンを実行してください。",
        });
        return;
      }
      // 既存の画像スキャンフローを呼び出す (進捗モーダルは ai-ocr 側が出す)。
      // 読込済みの見本ファイル全てを OCR 対象にして自動配置の整合を取る。
      await runAiOcrForFiles(loadedRefs);
      cache = getAiOcrDoc();
      if (!cache || !cache.doc) {
        // 画像スキャン側がエラー通知済みなのでここでは静かに戻る
        return;
      }
    }

    // 3. プラン構築
    const defaults = {
      fontPostScriptName: getCurrentFont(),
      sizePt: getTextSize(),
      leadingPct: getLeadingPct(),
      strokeColor: getStrokeColor(),
      strokeWidthPx: getStrokeWidthPx(),
      fillColor: getFillColor(),
    };
    const plan = buildPlacementPlan(cache.doc, psdPages, txtByPage, defaults);

    if (plan.totals.placed === 0) {
      await notifyDialog({
        title: "配置できる組み合わせがありません",
        message: "TXT ブロックと検出された吹き出しの対応が 1 件もありません。\nTXT のページ区切りや PSD の枚数を確認してください。",
      });
      return;
    }

    // 4. 直前と同じテキスト内容なら重複確認
    const fingerprint = planFingerprint(plan);
    if (lastPlacedFingerprint !== null && lastPlacedFingerprint === fingerprint) {
      const proceed = await confirmDialog({
        title: "テキスト内容が同一です",
        message: "前回と同じテキスト内容で自動配置しようとしています。\n自動配置を行いますか？",
        confirmLabel: "実行",
        cancelLabel: "キャンセル",
      });
      if (!proceed) return;
    }

    // 5. 確認モーダル
    const ok = await showPlanReviewModal(plan);
    if (!ok) return;

    // 6. 適用
    const added = applyPlan(plan);
    lastPlacedFingerprint = fingerprint;
    await notifyDialog({
      title: "自動配置完了",
      message: `${added} 件のテキストレイヤーを追加しました。`,
      kind: "success",
    });
  } catch (e) {
    console.error(e);
    await notifyDialog({
      title: "自動配置エラー",
      message: String(e?.message ?? e ?? "不明なエラー"),
    });
  } finally {
    runningPlace = false;
  }
}

// ============================================================
// 自動配置済みレイヤーの TXT 追従同期
// ============================================================
// 自動配置時に各レイヤーへ sourceTxtRef = { pageNumber, paragraphIndex } を埋めている。
// TXT が編集されたら、現在の TXT を再パースして該当段落を見つけ、レイヤー contents を
// 上書きする。手動配置レイヤー（sourceTxtRef なし）は触らない。
//
// 履歴: setTxtSource が listener 末尾で pushHistorySnapshot を呼ぶので、ここでの
// updateNewLayer による snapshot push は不要。begin/abortHistoryTransient で抑制する。
function syncPlacedFromTxt() {
  const txtSrc = getTxtSource();
  if (!txtSrc?.content) return;
  const layers = getNewLayers();
  // 自動配置レイヤーが 1 件も無ければ早期 return（パースコスト回避）。
  if (!layers.some((l) => l && l.sourceTxtRef)) return;
  const parsed = parsePages(txtSrc.content);
  const txtByPage = parsed.hasMarkers ? parsed.byPage : new Map([[1, parsed.all]]);
  // psdPath → page object のルックアップ。中心固定の x/y 再計算で page.dpi が必要。
  const pagesByPath = new Map();
  for (const p of getPages()) {
    if (p?.path) pagesByPath.set(p.path, p);
  }

  beginHistoryTransient();
  let changed = false;
  try {
    for (const layer of layers) {
      const ref = layer?.sourceTxtRef;
      if (!ref) continue;
      const paragraphs = txtByPage.get(ref.pageNumber);
      if (!paragraphs) continue;
      const next = paragraphs[ref.paragraphIndex];
      if (next == null) continue;
      if (next === layer.contents) continue;

      // contents 変更で推定 width/height が変わるため、x/y をそのままにすると
      // bbox top-left 固定 → 旧中心からズレて見える（上左に寄ったように見える）。
      // 旧 contents の bbox 中心を求め、新 contents の bbox を中心起点で再配置する。
      const updates = { contents: next };
      const psdPage = pagesByPath.get(layer.psdPath);
      if (psdPage) {
        const sizePt = layer.sizePt ?? 24;
        const leadingPct = layer.leadingPct ?? 125;
        const direction = layer.direction ?? "horizontal";
        const oldRect = estimateLayerSize(psdPage, sizePt, layer.contents ?? "", leadingPct, direction);
        const newRect = estimateLayerSize(psdPage, sizePt, next, leadingPct, direction);
        const cx = (layer.x ?? 0) + oldRect.width / 2;
        const cy = (layer.y ?? 0) + oldRect.height / 2;
        updates.x = cx - newRect.width / 2;
        updates.y = cy - newRect.height / 2;
      }
      updateNewLayer(layer.tempId, updates);
      changed = true;
    }
  } finally {
    abortHistoryTransient();
  }
  if (changed) {
    try { renderAllSpreads(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
  }
}

// ============================================================
// バインド
// ============================================================
export function bindAiPlaceButton() {
  const btn = $("ai-place-btn");
  if (!btn) return;
  btn.addEventListener("click", () => { void runAutoPlace(); });
  // OCR 結果が無いうちはグレーアウト。setAiOcrDoc / clearAiOcrDoc に追従。
  const sync = () => {
    const cache = getAiOcrDoc();
    const hasOcr = !!(
      cache &&
      cache.doc &&
      Array.isArray(cache.doc.pages) &&
      cache.doc.pages.length > 0
    );
    btn.disabled = !hasOcr;
    btn.title = hasOcr
      ? "OCR 結果と原稿テキストを吹き出し位置に自動配置"
      : "先に画像スキャンを実行してください";
  };
  onAiOcrDocChange(sync);
  sync();

  // TXT 編集 → 自動配置済みレイヤー contents を追従。
  // 編集はサイドパネル dblclick 編集 / エディタ textarea / undo/redo 経由で発生する。
  onTxtSourceChange(syncPlacedFromTxt);
}
