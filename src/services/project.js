import { loadReferenceFiles } from "../pdf-loader.js";
import { renderAllSpreads } from "../spread-view.js";
import { rebuildLayerList } from "../text-editor.js";
import { renderTxtSourceViewer } from "../txt-source.js";
import {
  MODAL_ANIM_MS,
  confirmDialog,
  hideModalAnimated,
  hideProgress,
  notifyDialog,
  showModalAnimated,
  toast,
} from "../ui-feedback.js";
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
import { baseName, joinPath, parentDir } from "../utils/path.js";

const PROJECT_KIND = "opus-project";
const PROJECT_SCHEMA_VERSION = 1;
const PROJECT_TEXT_DIR_NAME = "\u30c6\u30ad\u30b9\u30c8";
const PROJECT_REFERENCE_DIR_NAME = "\u5199\u690d\u898b\u672c";
let projectSaveInflight = false;
let projectLoadInProgress = false;
let currentProjectPath = null;
let currentProjectDir = null;
let currentProjectName = null;
let currentProjectWorkName = "";
let currentProjectVolume = "";
let currentProjectTextPath = null;
let currentProjectPsdPathMap = new Map();
let currentProjectReferencePathMap = new Map();

function setCurrentProject(path, options = {}) {
  currentProjectPath = typeof path === "string" && path ? path : null;
  currentProjectDir = options.projectDir || parentDir(currentProjectPath) || null;
  currentProjectName = options.projectName || (currentProjectPath
    ? safeFileName(baseName(currentProjectPath).replace(/\.opus$/i, ""), "project")
    : null);
  currentProjectWorkName = options.workName || "";
  currentProjectVolume = options.volume || "";
  currentProjectTextPath = options.textPath || null;
  currentProjectPsdPathMap = new Map(options.psdPathMapEntries || []);
  currentProjectReferencePathMap = new Map(options.referencePathMapEntries || []);
  updateProjectButtons();
}

function clearCurrentProject() {
  if (projectLoadInProgress) return;
  setCurrentProject(null);
}

function defaultProjectStem() {
  const first = getPages()[0]?.path;
  const stem = first ? baseName(first).replace(/\.[^.]+$/, "") : "opus-project";
  return stem || "opus-project";
}

function defaultWorkName() {
  const stem = defaultProjectStem();
  return stem === "opus-project" ? "" : stem;
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
    defaultPath = await invoke("opus_project_root_path");
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
  if (saveBtn) {
    saveBtn.disabled = projectSaveInflight || getPages().length === 0;
    saveBtn.title = currentProjectPath
      ? "プロジェクトを上書き保存 (Ctrl+S)"
      : "プロジェクトを保存 (Ctrl+S)";
    saveBtn.setAttribute("aria-label", currentProjectPath ? "プロジェクトを上書き保存" : "プロジェクトを保存");
  }
}

function extensionOf(path) {
  const name = baseName(path) || "";
  const m = name.match(/(\.[^.\\/]*)$/);
  return m ? m[1] : "";
}

function safeFileName(name, fallback = "untitled") {
  const raw = String(name || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  return raw || fallback;
}

function buildProjectDisplayName(workName, volume) {
  const work = String(workName || "").trim();
  const vol = String(volume || "").trim();
  if (work && vol) return `${work} ${vol}`;
  return work || vol || defaultProjectStem();
}

function normalizeVolumeLabel(volume) {
  const vol = String(volume || "").trim();
  if (!vol) return "";
  return /^\d+$/.test(vol) ? `${vol}巻` : vol;
}

function buildProjectTextFileName({ workName, volume, projectName }) {
  const work = String(workName || "").trim();
  const vol = normalizeVolumeLabel(volume);
  const stem = work && vol
    ? `${work}${vol}`
    : work || vol || projectName || defaultProjectStem();
  return `${safeFileName(stem, "text")}.txt`;
}

async function defaultProjectRoot() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("opus_project_root_path");
}

async function chooseProjectRoot(currentRoot) {
  let fallbackRoot = currentRoot || await defaultProjectRoot();
  try {
    fallbackRoot = await defaultProjectRoot();
  } catch {}
  const picked = await openFileDialog({
    mode: "openFolder",
    title: "プロジェクト保存先を選択",
    defaultPath: fallbackRoot,
    rememberKey: "project-save-root",
  });
  return typeof picked === "string" && picked ? picked : currentRoot;
}

function createProjectSaveForm({ workName, volume, rootDir }) {
  const form = document.createElement("div");
  form.className = "project-save-form";
  form.innerHTML = `
    <label class="project-save-field">
      <span>作品名</span>
      <input id="project-save-work-input" class="project-save-input" type="text" autocomplete="off" />
    </label>
    <label class="project-save-field">
      <span>巻数</span>
      <input id="project-save-volume-input" class="project-save-input" type="text" autocomplete="off" placeholder="例: 1巻" />
    </label>
    <div class="project-save-field">
      <span>保存先</span>
      <div class="project-save-path-row">
        <input id="project-save-root-input" class="project-save-input project-save-path-input" type="text" readonly />
        <button id="project-save-root-btn" class="page-jump-btn" type="button">変更</button>
      </div>
    </div>
    <div class="project-save-preview">
      <span>保存フォルダ</span>
      <strong id="project-save-preview-name"></strong>
    </div>
  `;
  const workInput = form.querySelector("#project-save-work-input");
  const volumeInput = form.querySelector("#project-save-volume-input");
  const rootInput = form.querySelector("#project-save-root-input");
  const preview = form.querySelector("#project-save-preview-name");
  if (workInput) workInput.value = workName || "";
  if (volumeInput) volumeInput.value = volume || "";
  if (rootInput) rootInput.value = rootDir || "";
  const syncPreview = () => {
    if (preview) preview.textContent = safeFileName(
      buildProjectDisplayName(workInput?.value, volumeInput?.value),
      "OPUS_Project",
    );
  };
  workInput?.addEventListener("input", syncPreview);
  volumeInput?.addEventListener("input", syncPreview);
  syncPreview();
  return { form, workInput, volumeInput, rootInput, syncPreview };
}

async function showProjectSaveDialog() {
  const modal = document.getElementById("confirm-modal");
  const titleEl = document.getElementById("confirm-modal-title");
  const msgEl = document.getElementById("confirm-modal-message");
  const okBtn = document.getElementById("confirm-modal-ok");
  const cancelBtn = document.getElementById("confirm-modal-cancel");
  if (!modal || !msgEl || !okBtn || !cancelBtn) return null;

  const rootDir = await defaultProjectRoot();
  return new Promise((resolve) => {
    if (titleEl) {
      titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
      titleEl.textContent = "プロジェクトを保存";
    }
    msgEl.textContent = "作品名と巻数を入力してください。";
    const nodes = createProjectSaveForm({
      workName: defaultWorkName(),
      volume: "",
      rootDir,
    });
    msgEl.parentNode.insertBefore(nodes.form, msgEl.nextSibling);
    okBtn.textContent = "保存";
    cancelBtn.textContent = "キャンセル";
    okBtn.classList.remove("page-jump-btn-place");
    okBtn.classList.add("page-jump-btn-primary");
    cancelBtn.hidden = false;

    let currentRoot = rootDir;
    let busy = false;
    const setError = (message) => {
      msgEl.textContent = message || "作品名と巻数を入力してください。";
    };
    const cleanup = (result) => {
      hideModalAnimated(modal);
      setTimeout(() => {
        nodes.form.remove();
      }, MODAL_ANIM_MS);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      nodes.form.querySelector("#project-save-root-btn")?.removeEventListener("click", onChooseRoot);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onChooseRoot = async () => {
      if (busy) return;
      busy = true;
      const picked = await chooseProjectRoot(currentRoot);
      if (picked) {
        currentRoot = picked;
        if (nodes.rootInput) nodes.rootInput.value = currentRoot;
      }
      busy = false;
    };
    const onOk = () => {
      const workName = String(nodes.workInput?.value || "").trim();
      const volume = String(nodes.volumeInput?.value || "").trim();
      if (!workName && !volume) {
        setError("作品名または巻数を入力してください。");
        nodes.workInput?.focus();
        return;
      }
      const projectName = safeFileName(buildProjectDisplayName(workName, volume), "OPUS_Project");
      cleanup({ workName, volume, projectName, rootDir: currentRoot });
    };
    const onCancel = () => cleanup(null);
    const onOverlay = (e) => { if (e.target === modal && !busy) cleanup(null); };
    const onKey = (e) => {
      if (busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      } else if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        onOk();
      }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    nodes.form.querySelector("#project-save-root-btn")?.addEventListener("click", onChooseRoot);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    showModalAnimated(modal);
    requestAnimationFrame(() => {
      nodes.workInput?.focus();
      nodes.workInput?.select();
    });
  });
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

async function listProjectRootEntries(rootDir) {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const entries = await invoke("list_directory_entries", { path: rootDir });
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

async function projectFolderExists(rootDir, projectName) {
  const safeName = safeFileName(projectName, "OPUS_Project");
  const entries = await listProjectRootEntries(rootDir);
  return entries.some((entry) => (
    entry?.isDirectory === true
    && String(entry.name || "").toLowerCase() === safeName.toLowerCase()
  ));
}

function projectDirForName(rootDir, projectName) {
  const safeName = safeFileName(projectName, "OPUS_Project");
  return {
    projectDir: joinPath(rootDir, safeName),
    projectName: safeName,
  };
}

async function createProjectBundle(snapshot, options = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  const rootDir = options.rootDir || await defaultProjectRoot();
  const nameInfo = projectDirForName(rootDir, options.projectName || defaultProjectStem());
  const projectDir = nameInfo.projectDir;
  const projectName = nameInfo.projectName;
  const psdDir = joinPath(projectDir, "PSD");
  const projectTextDir = joinPath(projectDir, PROJECT_TEXT_DIR_NAME);
  const projectRefDir = joinPath(projectDir, PROJECT_REFERENCE_DIR_NAME);

  const psdBundle = await copyFilesToProject(snapshot.psdPaths || [], psdDir);
  const rewrittenSnapshot = rewriteSnapshotPaths(snapshot, psdBundle.pathMap);

  let textPath = null;
  if (snapshot.txtSource?.content != null) {
    const textName = buildProjectTextFileName({
      workName: options.workName,
      volume: options.volume,
      projectName,
    });
    textPath = joinPath(projectTextDir, textName);
    await invoke("write_text_file", {
      path: textPath,
      content: String(snapshot.txtSource.content || ""),
    });
    if (rewrittenSnapshot.txtSource) {
      rewrittenSnapshot.txtSource.name = textName;
    }
  }

  const refBundle = await copyFilesToProject(getPdfPaths(), projectRefDir);
  const doc = makeProjectDocument();
  doc.savedAt = new Date().toISOString();
  doc.projectDir = projectDir;
  doc.projectName = projectName;
  doc.workName = options.workName || "";
  doc.volume = options.volume || "";
  doc.psdPaths = rewrittenSnapshot.psdPaths;
  doc.snapshot = rewrittenSnapshot;
  doc.text = textPath ? {
    path: textPath,
    name: baseName(textPath),
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
  return {
    projectDir,
    opusPath,
    projectName,
    psdCount: psdBundle.copied.length,
    referenceCount: refBundle.copied.length,
    textPath,
    psdPathMapEntries: Array.from(psdBundle.pathMap.entries()),
    referencePathMapEntries: Array.from(refBundle.pathMap.entries()),
  };
}

function mapPaths(paths, pathMap) {
  return (Array.isArray(paths) ? paths : []).map((p) => pathMap.get(p) || p);
}

async function confirmProjectOverwrite(message = "上書き保存してよろしいですか？") {
  return confirmDialog({
    title: "プロジェクトを上書き保存",
    message,
    confirmLabel: "上書き保存",
  });
}

async function overwriteCurrentProjectFile() {
  if (!currentProjectPath) return null;
  const doc = makeProjectDocument();
  const projectDir = currentProjectDir || parentDir(currentProjectPath);
  const projectName = currentProjectName || safeFileName(baseName(currentProjectPath).replace(/\.opus$/i, ""), "project");
  const textDir = joinPath(projectDir, PROJECT_TEXT_DIR_NAME);
  const rewrittenSnapshot = currentProjectPsdPathMap.size > 0
    ? rewriteSnapshotPaths(doc.snapshot, currentProjectPsdPathMap)
    : doc.snapshot;
  doc.savedAt = new Date().toISOString();
  doc.projectDir = projectDir;
  doc.projectName = projectName;
  doc.workName = currentProjectWorkName || "";
  doc.volume = currentProjectVolume || "";
  doc.psdPaths = rewrittenSnapshot.psdPaths;
  doc.snapshot = rewrittenSnapshot;
  doc.references = {
    paths: mapPaths(getPdfPaths(), currentProjectReferencePathMap),
    originalPaths: getPdfPaths(),
    excludedPages: Array.from(getPdfExcludedReferencePages()),
    splitMode: getPdfSplitMode(),
    skipFirstBlank: getPdfSkipFirstBlank(),
  };
  const { invoke } = await import("@tauri-apps/api/core");
  let textPath = currentProjectTextPath;
  let textName = textPath ? baseName(textPath) : null;
  if (rewrittenSnapshot.txtSource?.content != null) {
    textName = textName || buildProjectTextFileName({
      workName: currentProjectWorkName,
      volume: currentProjectVolume,
      projectName,
    });
    textPath = textPath || joinPath(textDir, textName);
    await invoke("write_text_file", {
      path: textPath,
      content: String(rewrittenSnapshot.txtSource.content || ""),
    });
    doc.text = {
      path: textPath,
      name: textName,
    };
    if (rewrittenSnapshot.txtSource) rewrittenSnapshot.txtSource.name = textName;
  } else {
    doc.text = null;
  }
  await invoke("write_text_file", {
    path: currentProjectPath,
    content: JSON.stringify(doc, null, 2),
  });
  setCurrentProject(currentProjectPath, {
    projectDir,
    projectName,
    workName: currentProjectWorkName,
    volume: currentProjectVolume,
    textPath: textPath || null,
    psdPathMapEntries: Array.from(currentProjectPsdPathMap.entries()),
    referencePathMapEntries: Array.from(currentProjectReferencePathMap.entries()),
  });
  return {
    projectDir,
    opusPath: currentProjectPath,
    projectName,
  };
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
    let result;
    let overwrote = false;
    if (currentProjectPath) {
      const ok = await confirmProjectOverwrite("現在のプロジェクトを上書き保存してよろしいですか？");
      if (!ok) return;
      result = await overwriteCurrentProjectFile();
      overwrote = true;
    } else {
      const saveOptions = await showProjectSaveDialog();
      if (!saveOptions) return;
      const exists = await projectFolderExists(saveOptions.rootDir, saveOptions.projectName);
      if (exists) {
        const ok = await confirmProjectOverwrite(`「${saveOptions.projectName}」を上書き保存してよろしいですか？`);
        if (!ok) return;
      }
      result = await createProjectBundle(exportProjectSnapshot(), saveOptions);
      setCurrentProject(result.opusPath, {
        projectDir: result.projectDir,
        projectName: result.projectName,
        workName: saveOptions.workName,
        volume: saveOptions.volume,
        textPath: result.textPath,
        psdPathMapEntries: result.psdPathMapEntries,
        referencePathMapEntries: result.referencePathMapEntries,
      });
    }
    await notifyDialog({
      title: overwrote ? "プロジェクト上書き保存完了" : "プロジェクト保存完了",
      message: `${result.projectName} を保存しました。`,
      kind: "success",
      primaryAction: {
        label: "保存先を開く",
        kind: "primary",
        onClick: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("open_folder_in_explorer", { path: result.projectDir });
        },
      },
    });
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
    projectLoadInProgress = true;
    await loadPsdFilesByPaths(project.psdPaths, {
      label: "プロジェクトを読み込み中",
      variant: "place",
      keepProgressOpen: true,
      confirmUnsaved: false,
      preserveOrder: true,
    });
    projectLoadInProgress = false;
    if (getPages().length === 0) {
      throw new Error("プロジェクト内の PSD を読み込めませんでした");
    }
    await restoreProjectReferences(project.references);
    // 【v2.x】silentTxtListener: true で applyProjectSnapshot 内の txtSourceListeners 発火を抑制。
    // 復元時に listener (例: auto-place.js syncPlacedFromTxt) が走ると、自動配置レイヤーの
    // 手動 charRubies / lineLeadings が TXT 注記由来の値で意図せず上書きされる事故が再発する。
    // 必要な UI 再描画はこの下で renderTxtSourceViewer / renderAllSpreads / rebuildLayerList を
    // 明示的に呼ぶので、listener 経由の自動描画は不要。
    applyProjectSnapshot(project.snapshot, { silentTxtListener: true });
    restoreProjectView(project.view);
    leaveHomeScreen();
    renderAllSpreads();
    rebuildLayerList();
    renderTxtSourceViewer();
    setCurrentProject(path, {
      projectDir: project.projectDir || parentDir(path),
      projectName: project.projectName || safeFileName(baseName(path).replace(/\.opus$/i, ""), "project"),
      workName: project.workName || "",
      volume: project.volume || "",
      textPath: project.text?.path || null,
    });
    updateProjectButtons();
    window.dispatchEvent(new CustomEvent("psdesign:project-loaded", { detail: { path } }));
    await hideProgress({ success: true, variant: "place" });
  } catch (e) {
    projectLoadInProgress = false;
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
  window.addEventListener("psdesign:psd-loaded", () => {
    clearCurrentProject();
    updateProjectButtons();
  });
  updateProjectButtons();
}
