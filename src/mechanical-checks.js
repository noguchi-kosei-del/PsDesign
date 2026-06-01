import {
  exportEdits,
  getActivePane,
  getCurrentPageIndex,
  getNewLayers,
  getPages,
  getParallelSyncMode,
  getPdfDoc,
  getPdfPageCount,
  getPdfPageIndex,
  getPdfSkipFirstBlank,
  getPdfSplitMode,
  getPdfZoom,
  getPsdZoom,
  setActivePane,
  setCurrentPageIndex,
  setParallelSyncMode,
  setPdfPageIndex,
  setPdfSkipFirstBlank,
  setPdfSplitMode,
} from "./state.js";
import {
  getPdfVirtualPageAt,
  getPdfVirtualPageCount,
  getPdfVirtualPages,
} from "./pdf-pages.js";
import { notifyDialog } from "./ui-feedback.js";

const CHECK_VERSION = 1;

function waitForFrame() {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function waitForRenderSettle(frames = 4) {
  for (let i = 0; i < frames; i += 1) await waitForFrame();
}

function pass(detail = "") {
  return { status: "pass", detail };
}

function fail(detail = "") {
  return { status: "fail", detail };
}

function skip(detail = "") {
  return { status: "skip", detail };
}

function isFinitePositive(v) {
  return Number.isFinite(Number(v)) && Number(v) > 0;
}

function hasNonFiniteNumber(value, path = "$") {
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : path;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = hasNonFiniteNumber(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const hit = hasNonFiniteNumber(child, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

function pageSideLabel(v) {
  if (!v) return "(none)";
  return `${v.pageNum}:${v.side}`;
}

function checkPdfVirtualSequence(total) {
  const saved = {
    split: getPdfSplitMode(),
    skip: getPdfSkipFirstBlank(),
    index: getPdfPageIndex(),
  };
  try {
    setPdfPageIndex(0);

    setPdfSplitMode(false);
    setPdfSkipFirstBlank(false);
    if (getPdfVirtualPageCount() !== total) {
      return fail(`full mode count ${getPdfVirtualPageCount()} !== ${total}`);
    }
    if (pageSideLabel(getPdfVirtualPageAt(0)) !== "1:full") {
      return fail(`full mode first page is ${pageSideLabel(getPdfVirtualPageAt(0))}`);
    }

    setPdfSkipFirstBlank(true);
    const skipTotal = Math.max(0, total - 1);
    if (getPdfVirtualPageCount() !== skipTotal) {
      return fail(`skip-first count ${getPdfVirtualPageCount()} !== ${skipTotal}`);
    }
    if (skipTotal > 0 && pageSideLabel(getPdfVirtualPageAt(0)) !== "2:full") {
      return fail(`skip-first first page is ${pageSideLabel(getPdfVirtualPageAt(0))}`);
    }

    setPdfSplitMode(true);
    setPdfSkipFirstBlank(false);
    const splitTotal = total > 0 ? 1 + Math.max(0, total - 1) * 2 : 0;
    if (getPdfVirtualPageCount() !== splitTotal) {
      return fail(`split count ${getPdfVirtualPageCount()} !== ${splitTotal}`);
    }
    const split = getPdfVirtualPages().slice(0, 3).map(pageSideLabel).join(",");
    if (total >= 2 && split !== "1:left,2:right,2:left") {
      return fail(`split order starts with ${split}`);
    }

    setPdfSkipFirstBlank(true);
    const splitSkipTotal = Math.max(0, total - 1) * 2;
    if (getPdfVirtualPageCount() !== splitSkipTotal) {
      return fail(`split+skip count ${getPdfVirtualPageCount()} !== ${splitSkipTotal}`);
    }
    const splitSkip = getPdfVirtualPages().slice(0, 2).map(pageSideLabel).join(",");
    if (total >= 2 && splitSkip !== "2:right,2:left") {
      return fail(`split+skip order starts with ${splitSkip}`);
    }

    return pass("full / skip-first / split sequences are consistent");
  } finally {
    setPdfSplitMode(saved.split);
    setPdfSkipFirstBlank(saved.skip);
    setPdfPageIndex(saved.index);
  }
}

async function checkPageSyncBridge() {
  const pages = getPages();
  const total = Math.min(pages.length, getPdfVirtualPageCount());
  if (total < 2) return skip("PSD and PDF both need at least two pages");

  const saved = {
    sync: getParallelSyncMode(),
    activePane: getActivePane(),
    psdIndex: getCurrentPageIndex(),
    pdfIndex: getPdfPageIndex(),
  };
  const target = Math.min(total - 1, 2);
  try {
    setParallelSyncMode(true);
    setCurrentPageIndex(target);
    await waitForFrame();
    if (getPdfPageIndex() !== target) {
      return fail(`PSD -> PDF sync did not mirror (${getPdfPageIndex()} !== ${target})`);
    }

    setPdfPageIndex(0);
    await waitForFrame();
    if (getCurrentPageIndex() !== 0) {
      return fail(`PDF -> PSD sync did not mirror (${getCurrentPageIndex()} !== 0)`);
    }

    setParallelSyncMode(false);
    setActivePane("pdf");
    setCurrentPageIndex(0);
    setPdfPageIndex(target);
    await waitForFrame();
    if (getCurrentPageIndex() !== 0 || getPdfPageIndex() !== target) {
      return fail("async page mode did not keep PSD and PDF indexes independent");
    }

    return pass("sync and async page movement are both observable");
  } finally {
    setParallelSyncMode(false);
    setCurrentPageIndex(saved.psdIndex);
    setPdfPageIndex(saved.pdfIndex);
    setActivePane(saved.activePane);
    setParallelSyncMode(saved.sync);
  }
}

async function runCheck(results, name, fn) {
  try {
    const result = await fn();
    results.push({ name, ...(result || pass()) });
  } catch (error) {
    results.push({
      name,
      status: "fail",
      detail: String(error?.message ?? error),
    });
  }
}

function formatSummary(results) {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip").length;
  const lines = [`${passed} passed / ${failed.length} failed / ${skipped} skipped`];
  for (const item of failed.slice(0, 8)) {
    lines.push(`- ${item.name}: ${item.detail || "failed"}`);
  }
  if (failed.length > 8) lines.push(`- ...and ${failed.length - 8} more`);
  return lines.join("\n");
}

export async function runMechanicalChecks({
  source = "manual",
  expected = {},
  allowMutation = false,
  notify = "fail",
} = {}) {
  await waitForRenderSettle();

  const results = [];
  await runCheck(results, "app shell roots", () => {
    const ids = ["psd-stage", "pdf-stage", "spreads-psd-area", "spreads-pdf-area", "page-nav-label"];
    const missing = ids.filter((id) => !document.getElementById(id));
    return missing.length ? fail(`missing #${missing.join(", #")}`) : pass("required workspace nodes exist");
  });

  await runCheck(results, "PSD page state", () => {
    const pages = getPages();
    if (expected.psdPages != null && pages.length !== expected.psdPages) {
      return fail(`${pages.length} pages loaded, expected ${expected.psdPages}`);
    }
    if (pages.length === 0) return skip("no PSD pages loaded");
    const bad = pages.find((page) =>
      !isFinitePositive(page.width) ||
      !isFinitePositive(page.height) ||
      !isFinitePositive(page.dpi) ||
      !page.canvas ||
      Number(page.canvas.width) !== Number(page.width) ||
      Number(page.canvas.height) !== Number(page.height));
    return bad ? fail(`invalid page geometry: ${bad.path ?? "(unknown)"}`) : pass(`${pages.length} pages`);
  });

  await runCheck(results, "new text layer state", () => {
    const layers = getNewLayers();
    if (expected.newLayers != null && layers.length !== expected.newLayers) {
      return fail(`${layers.length} new layers, expected ${expected.newLayers}`);
    }
    if (layers.length === 0) return skip("no new text layers");
    const pagePaths = new Set(getPages().map((page) => page.path));
    const bad = layers.find((layer) =>
      !pagePaths.has(layer.psdPath) ||
      !Number.isFinite(layer.x) ||
      !Number.isFinite(layer.y) ||
      !Number.isFinite(layer.sizePt));
    return bad ? fail(`invalid layer geometry: ${bad.tempId ?? "(unknown)"}`) : pass(`${layers.length} layers`);
  });

  await runCheck(results, "PDF page state", () => {
    if (!getPdfDoc()) return skip("no PDF/reference document loaded");
    const count = getPdfPageCount();
    if (expected.pdfPages != null && count !== expected.pdfPages) {
      return fail(`${count} pages loaded, expected ${expected.pdfPages}`);
    }
    if (getPdfVirtualPageCount() <= 0) return fail("virtual page list is empty");
    return pass(`${count} physical pages / ${getPdfVirtualPageCount()} virtual pages`);
  });

  await runCheck(results, "rendered workspace DOM", () => {
    const psdPage = document.querySelector("#psd-stage .page");
    const psdOverlay = document.querySelector("#psd-stage .page-overlay");
    const pdfCanvas = document.querySelector("#pdf-stage .pdf-canvas");
    const label = document.getElementById("page-nav-label")?.textContent?.trim() ?? "";
    if (getPages().length > 0 && (!psdPage || !psdOverlay)) return fail("PSD page or overlay is not rendered");
    if (getPdfDoc() && !pdfCanvas) return fail("PDF canvas is not mounted");
    if (!label || label === "- / -" || label === "– / –") return fail("page navigation label is not populated");
    return pass(`page label: ${label}`);
  });

  await runCheck(results, "export payload numeric safety", () => {
    const payload = exportEdits();
    const nonFinitePath = hasNonFiniteNumber(payload);
    if (nonFinitePath) return fail(`non-finite number at ${nonFinitePath}`);
    if (expected.newLayers != null) {
      const count = payload.edits.reduce((sum, edit) => sum + edit.newLayers.length, 0);
      if (count !== expected.newLayers) return fail(`${count} exported new layers, expected ${expected.newLayers}`);
    }
    return pass("payload contains only finite numbers");
  });

  if (allowMutation) {
    await runCheck(results, "PDF virtual page rules", () => {
      const total = getPdfPageCount();
      if (total <= 0) return skip("no PDF/reference document loaded");
      return checkPdfVirtualSequence(total);
    });
    await runCheck(results, "page sync bridge", () => checkPageSyncBridge());
  }

  await runCheck(results, "zoom state", () => {
    const pdfZoom = getPdfZoom();
    const psdZoom = getPsdZoom();
    return Number.isFinite(pdfZoom) && Number.isFinite(psdZoom) && pdfZoom > 0 && psdZoom > 0
      ? pass(`PSD ${Math.round(psdZoom * 100)}%, PDF ${Math.round(pdfZoom * 100)}%`)
      : fail(`invalid zoom values: PSD ${psdZoom}, PDF ${pdfZoom}`);
  });

  const failed = results.filter((r) => r.status === "fail");
  const ok = failed.length === 0;
  const detail = {
    ok,
    source,
    version: CHECK_VERSION,
    checkedAt: new Date().toISOString(),
    results,
  };
  window.__psdesignMechanicalCheckResult = detail;
  window.dispatchEvent(new CustomEvent("psdesign:mechanical-checks-complete", { detail }));

  const logMethod = ok ? "info" : "warn";
  console[logMethod](`[psdesign] mechanical checks ${ok ? "passed" : "failed"}\n${formatSummary(results)}`);
  console.table(results.map((r) => ({ check: r.name, status: r.status, detail: r.detail })));

  if (notify === "always" || (!ok && notify !== "never")) {
    await notifyDialog({
      title: ok ? "自動チェック完了" : "自動チェックで問題を検出",
      message: formatSummary(results),
      okLabel: "OK",
      kind: ok ? "success" : "warning",
    });
  }

  return detail;
}
