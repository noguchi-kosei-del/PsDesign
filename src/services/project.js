import { loadReferenceFiles } from "../pdf-loader.js";
import { renderAllSpreads } from "../spread-view.js";
import { rebuildLayerList } from "../text-editor.js";
import { renderTxtSourceViewer } from "../txt-source.js";
import { confirmDialog, hideProgress, toast } from "../ui-feedback.js";
import { openFileDialog } from "../file-picker.js";
import {
  applyProjectSnapshot,
  exportProjectSnapshot,
  getActivePane,
  getCurrentPageIndex,
  getEditorLeftPaneMode,
  getPages,
  getParallelSyncMode,
  getParallelViewMode,
  getPdfExcludedReferencePages,
  getPdfPageIndex,
  getPdfPaths,
  getPdfRotation,
  getPdfSkipFirstBlank,
  getPdfSplitMode,
  getPdfZoom,
  getPsdRotation,
  getPsdZoom,
  hasEdits,
  setActivePane,
  setCurrentPageIndex,
  setEditorLeftPaneMode,
  setParallelSyncMode,
  setParallelViewMode,
  setPdfPageIndex,
  setPdfRotation,
  setPdfSkipFirstBlank,
  setPdfSplitMode,
  setPdfZoom,
  setPsdRotation,
  setPsdZoom,
} from "../state.js";
import { loadPsdFilesByPaths } from "./psd-load.js";
import { baseName, joinPath } from "../utils/path.js";

const PROJECT_KIND = "opus-project";
const PROJECT_SCHEMA_VERSION = 1;
let projectSaveInflight = false;

function defaultProjectStem() {
  const first = getPages()[0]?.path;
  const stem = first ? baseName(first).replace(/\.[^.]+$/, "") : "opus-project";
  return stem || "opus-project";
}

function makeProjectDocument() {
  const snapshot = exportProjectSnapshot();
  return {
    kind: PROJECT_KIND,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    app: "OPUS",
    savedAt: new Date().toISOString(),
    psdPaths: snapshot.psdPaths,
    snapshot,
    references: {
      paths: getPdfPaths(),
      excludedPages: Array.from(getPdfExcludedReferencePages()),
      splitMode: getPdfSplitMode(),
      skipFirstBlank: getPdfSkipFirstBlank(),
    },
    view: {
      psdPageIndex: getCurrentPageIndex(),
      pdfPageIndex: getPdfPageIndex(),
      psdZoom: getPsdZoom(),
      pdfZoom: getPdfZoom(),
      psdRotation: getPsdRotation(),
      pdfRotation: getPdfRotation(),
      parallelSyncMode: getParallelSyncMode(),
      activePane: getActivePane(),
      parallelViewMode: getParallelViewMode(),
      editorLeftPaneMode: getEditorLeftPaneMode(),
    },
  };
}

function normalizeProjectDocument(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("プロジェクトファイルの形式が正しくありません");
  }
  const snapshot = raw.snapshot && typeof raw.snapshot === "object"
    ? raw.snapshot
    : raw;
  const psdPaths = Array.isArray(raw.psdPaths)
    ? raw.psdPaths
    : Array.isArray(snapshot.psdPaths)
      ? snapshot.psdPaths
      : [];
  const normalizedPsdPaths = psdPaths.filter((p) => typeof p === "string" && /\.psd$/i.test(p));
  if (normalizedPsdPaths.length === 0) {
    throw new Error("プロジェクト内に PSD ファイル情報がありません");
  }
  return {
    ...raw,
    snapshot: {
      ...snapshot,
      psdPaths: normalizedPsdPaths,
    },
    psdPaths: normalizedPsdPaths,
    references: raw.references && typeof raw.references === "object" ? raw.references : null,
    view: raw.view && typeof raw.view === "object" ? raw.view : null,
  };
}

async function pickProjectOpenPath() {
  let defaultPath = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    defaultPath = await invoke("script_output_dir");
  } catch (e) {
    console.warn("[project] Script_Output default path unavailable:", e);
  }
  const picked = await openFileDialog({
    mode: "open",
    title: "プロジェクトを開く",
    filters: [{ name: "OPUS Project", extensions: ["opus"] }],
    defaultPath,
    rememberKey: "project-open",
  });
  return Array.isArray(picked) ? picked[0] : picked;
}

export function updateProjectButtons() {
  const saveBtn = document.getElementById("project-save-btn");
  if (saveBtn) saveBtn.disabled = projectSaveInflight || getPages().length === 0;
}

function extensionOf(path) {
  const name = baseName(path) || "";
  const m = name.match(/(\.[^.\\/]*)$/);
  return m ? m[1] : "";
}

function stemOf(path) {
  const name = baseName(path) || "untitled";
  return name.replace(/\.[^.]*$/, "") || "untitled";
}

function safeFileName(name, fallback = "untitled") {
  const raw = String(name || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  return raw || fallback;
}

function uniqueName(name, used) {
  const safe = safeFileName(name);
  const ext = extensionOf(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = safe;
  let i = 1;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}(${i++})${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function rewriteSnapshotPaths(snapshot, pathMap) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  copy.psdPaths = (copy.psdPaths || []).map((p) => pathMap.get(p) || p);
  for (const entry of copy.edits || []) {
    if (pathMap.has(entry.psdPath)) entry.psdPath = pathMap.get(entry.psdPath);
  }
  for (const layer of copy.newLayers || []) {
    if (pathMap.has(layer.psdPath)) layer.psdPath = pathMap.get(layer.psdPath);
  }
  return copy;
}

async function copyFilesToProject(paths, destDir, { prefix = "" } = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  const used = new Set();
  const copied = [];
  const pathMap = new Map();
  for (let i = 0; i < paths.length; i++) {
    const source = paths[i];
    if (typeof source !== "string" || !source) continue;
    const name = uniqueName(`${prefix}${baseName(source) || `file-${i + 1}`}`, used);
    const dest = joinPath(destDir, name);
    await invoke("copy_file", { source, dest });
    copied.push(dest);
    pathMap.set(source, dest);
  }
  return { copied, pathMap };
}

async function createProjectBundle(snapshot) {
  const { invoke } = await import("@tauri-apps/api/core");
  const projectDir = await invoke("create_opus_project_dir", { name: defaultProjectStem() });
  const projectName = baseName(projectDir);
  const psdDir = joinPath(projectDir, "psd");
  const textDir = joinPath(projectDir, "text");
  const refDir = joinPath(projectDir, "reference");

  const psdBundle = await copyFilesToProject(snapshot.psdPaths || [], psdDir);
  const rewrittenSnapshot = rewriteSnapshotPaths(snapshot, psdBundle.pathMap);

  let textPath = null;
  if (snapshot.txtSource?.content != null) {
    const base = safeFileName(snapshot.txtSource.name || "text.txt");
    const textName = /\.txt$/i.test(base) ? base : `${stemOf(base)}.txt`;
    textPath = joinPath(textDir, textName);
    await invoke("write_text_file", {
      path: textPath,
      content: String(snapshot.txtSource.content || ""),
    });
  }

  const refBundle = await copyFilesToProject(getPdfPaths(), refDir);
  const doc = makeProjectDocument();
  doc.savedAt = new Date().toISOString();
  doc.projectDir = projectDir;
  doc.psdPaths = rewrittenSnapshot.psdPaths;
  doc.snapshot = rewrittenSnapshot;
  doc.text = textPath ? {
    path: textPath,
    name: snapshot.txtSource?.name || baseName(textPath),
  } : null;
  doc.references = {
    paths: refBundle.copied,
    originalPaths: getPdfPaths(),
    excludedPages: Array.from(getPdfExcludedReferencePages()),
    splitMode: getPdfSplitMode(),
    skipFirstBlank: getPdfSkipFirstBlank(),
  };

  const opusPath = joinPath(projectDir, `${safeFileName(projectName, "project")}.opus`);
  await invoke("write_text_file", {
    path: opusPath,
    content: JSON.stringify(doc, null, 2),
  });
  return { projectDir, opusPath, psdCount: psdBundle.copied.length, referenceCount: refBundle.copied.length, textPath };
}

export async function saveProject() {
  if (projectSaveInflight) {
    toast("プロジェクト保存中です。完了までお待ちください", { kind: "info", duration: 2200 });
    return;
  }
  if (getPages().length === 0) {
    toast("PSD を読み込んでからプロジェクト保存してください", { kind: "info" });
    return;
  }
  projectSaveInflight = true;
  updateProjectButtons();
  try {
    const result = await createProjectBundle(exportProjectSnapshot());
    toast(
      `プロジェクトを保存しました: ${baseName(result.opusPath)}`,
      { kind: "success", duration: 3800 },
    );
  } catch (e) {
    console.error(e);
    toast(`プロジェクト保存に失敗しました: ${e?.message ?? e}`, { kind: "error", duration: 5000 });
  } finally {
    projectSaveInflight = false;
    updateProjectButtons();
  }
}

function restoreProjectView(view) {
  if (!view) return;
  setParallelSyncMode(view.parallelSyncMode !== false);
  if (view.activePane === "pdf" || view.activePane === "psd") setActivePane(view.activePane);
  if (view.parallelViewMode) setParallelViewMode(view.parallelViewMode);
  if (view.editorLeftPaneMode) setEditorLeftPaneMode(view.editorLeftPaneMode);
  if (Number.isFinite(Number(view.psdZoom))) setPsdZoom(Number(view.psdZoom));
  if (Number.isFinite(Number(view.pdfZoom))) setPdfZoom(Number(view.pdfZoom));
  if (Number.isFinite(Number(view.psdRotation))) setPsdRotation(Number(view.psdRotation));
  if (Number.isFinite(Number(view.pdfRotation))) setPdfRotation(Number(view.pdfRotation));
  if (Number.isFinite(Number(view.psdPageIndex))) setCurrentPageIndex(Number(view.psdPageIndex));
  if (Number.isFinite(Number(view.pdfPageIndex))) setPdfPageIndex(Number(view.pdfPageIndex));
}

function leaveHomeScreen() {
  document.body.classList.remove("home-mode", "home-starting", "home-returning");
}

async function restoreProjectReferences(refs) {
  const paths = Array.isArray(refs?.paths) ? refs.paths.filter((p) => typeof p === "string") : [];
  if (paths.length === 0) return;
  try {
    await loadReferenceFiles(paths, {
      title: "プロジェクトを読み込み中",
      variant: "place",
      keepProgressOpen: true,
      excludedPages: refs.excludedPages,
      skipFirstBlankPage: refs.skipFirstBlank,
    });
    if (typeof refs.splitMode === "boolean") setPdfSplitMode(refs.splitMode);
    if (typeof refs.skipFirstBlank === "boolean") setPdfSkipFirstBlank(refs.skipFirstBlank);
  } catch (e) {
    console.error("[project] reference restore failed:", e);
    toast(`見本の復元に失敗しました: ${e?.message ?? e}`, { kind: "warning", duration: 4500 });
  }
}

export async function openProjectFromPath(path) {
  if (!path) return;
  if (hasEdits()) {
    const ok = await confirmDialog({
      title: "未保存の編集があります",
      message: "現在の編集内容は破棄され、プロジェクトの内容に置き換わります。続行しますか？",
      confirmLabel: "プロジェクトを開く",
    });
    if (!ok) return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke("read_text_file", { path });
    const project = normalizeProjectDocument(JSON.parse(text));
    await loadPsdFilesByPaths(project.psdPaths, {
      label: "プロジェクトを読み込み中",
      variant: "place",
      keepProgressOpen: true,
      confirmUnsaved: false,
      preserveOrder: true,
    });
    if (getPages().length === 0) {
      throw new Error("プロジェクト内の PSD を読み込めませんでした");
    }
    await restoreProjectReferences(project.references);
    applyProjectSnapshot(project.snapshot);
    restoreProjectView(project.view);
    leaveHomeScreen();
    renderAllSpreads();
    rebuildLayerList();
    renderTxtSourceViewer();
    updateProjectButtons();
    window.dispatchEvent(new CustomEvent("psdesign:project-loaded", { detail: { path } }));
    await hideProgress({ success: true, variant: "place" });
  } catch (e) {
    console.error(e);
    await hideProgress();
    toast(`プロジェクトを開けませんでした: ${e?.message ?? e}`, { kind: "error", duration: 6000 });
  }
}

export async function openProject() {
  const path = await pickProjectOpenPath();
  if (!path) return;
  await openProjectFromPath(path);
}

export function bindProjectButtons() {
  document.getElementById("project-open-btn")?.addEventListener("click", () => { openProject(); });
  document.getElementById("project-save-btn")?.addEventListener("click", () => { saveProject(); });
  window.addEventListener("psdesign:psd-loaded", updateProjectButtons);
  updateProjectButtons();
}
