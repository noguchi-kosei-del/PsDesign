import { hideModalAnimated, MODAL_ANIM_MS, notifyDialog, showModalAnimated } from "../ui-feedback.js";
import { baseName, joinPath, parentDir } from "../utils/path.js";

function splitName(name) {
  const raw = String(name ?? "");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return { stem: raw, ext: "" };
  return {
    stem: raw.slice(0, dot),
    ext: raw.slice(dot),
  };
}

function normalizeDigits(value) {
  return String(value ?? "").normalize("NFKC");
}

function parseAmbiguousPsdStem(stem) {
  const normalizedStem = normalizeDigits(stem);
  const numberTokens = Array.from(normalizedStem.matchAll(/[0-9]+/g));
  if (numberTokens.length < 2) {
    return { matched: false, reason: "less than two numeric tokens", normalizedStem };
  }

  const pageToken = numberTokens[numberTokens.length - 1];
  const volumeToken = numberTokens[numberTokens.length - 2];
  const page = pageToken[0];
  const volume = volumeToken[0];
  const pageStart = pageToken.index ?? -1;
  const volumeStart = volumeToken.index ?? -1;
  if (pageStart < 0 || volumeStart < 0) {
    return { matched: false, reason: "numeric token index unavailable", normalizedStem };
  }
  if (volume.length > 2 || page.length > 4) {
    return { matched: false, reason: "numeric token length out of range", normalizedStem, volume, page };
  }

  const between = normalizedStem.slice(volumeStart + volume.length, pageStart);
  if (!between || /[A-Za-z0-9]/.test(between)) {
    return { matched: false, reason: "volume and page are not separated", normalizedStem, volume, page };
  }

  const prefixRaw = normalizedStem.slice(0, volumeStart);
  const prefix = prefixRaw.replace(/[\s._-]+$/g, "");
  if (!prefix) {
    return { matched: false, reason: "empty prefix", normalizedStem, volume, page };
  }

  const suffix = normalizedStem.slice(pageStart + page.length);
  return { matched: true, normalizedStem, prefix, volume, page, suffix };
}

function normalizeDir(path) {
  return parentDir(path) ?? "";
}

function candidateTargetPath(candidate) {
  return joinPath(candidate.dir, candidate.toName);
}

function pathKey(path) {
  return String(path ?? "").replace(/[\\/]+/g, "/").toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function detectAmbiguousPsdRenameCandidates(paths) {
  const parsed = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    const name = baseName(path);
    const { stem, ext } = splitName(name);
    if (ext.toLowerCase() !== ".psd") {
      continue;
    }

    const parsedStem = parseAmbiguousPsdStem(stem);
    if (!parsedStem.matched) {
      continue;
    }

    const { prefix, volume, page } = parsedStem;
    parsed.push({
      path,
      dir: normalizeDir(path),
      fromName: name,
      prefix,
      volume,
      page,
      pageNumber: parseInt(page, 10),
      ext,
    });
  }

  const candidates = parsed
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((item) => ({ ...item, toName: `${item.prefix}_${item.page}${item.ext}` }))
    .filter((item) => item.toName !== item.fromName);

  const selectedPaths = new Set((Array.isArray(paths) ? paths : []).map(pathKey));
  const targetCounts = new Map();
  for (const candidate of candidates) {
    const target = pathKey(candidateTargetPath(candidate));
    targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
  }

  const result = candidates.map((candidate) => {
    const target = candidateTargetPath(candidate);
    const targetKey = pathKey(target);
    return {
      ...candidate,
      targetPath: target,
      conflictsWithSelection: selectedPaths.has(targetKey) && targetKey !== pathKey(candidate.path),
      duplicateTarget: (targetCounts.get(targetKey) ?? 0) > 1,
    };
  });
  return result;
}

function formatConflictMessage(conflicts) {
  const shown = conflicts
    .slice(0, 8)
    .map((item) => `・${item.fromName} -> ${item.toName}`)
    .join("\n");
  const rest = conflicts.length > 8 ? `\nほか ${conflicts.length - 8} 件` : "";
  return `リネーム候補の保存先に同名ファイルがあります。先にファイル名を整理してから読み込んでください。\n\n${shown}${rest}`;
}

function showRenameDialog(candidates) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = document.createElement("div");
    modal.className = "home-typeset-modal psd-rename-modal";
    modal.hidden = true;

    const rows = candidates
      .slice(0, 80)
      .map((item) => `
        <div class="psd-rename-row">
          <span class="psd-rename-name">${escapeHtml(item.fromName)}</span>
          <span class="psd-rename-arrow">-&gt;</span>
          <span class="psd-rename-name psd-rename-name-new">${escapeHtml(item.toName)}</span>
        </div>
      `)
      .join("");
    const rest = candidates.length > 80
      ? `<div class="psd-rename-more">ほか ${candidates.length - 80} 件</div>`
      : "";

    modal.innerHTML = `
      <div class="home-typeset-card psd-rename-card" role="dialog" aria-modal="true" aria-labelledby="psd-rename-title">
        <div class="home-typeset-header">
          <span class="home-typeset-title" id="psd-rename-title">PSDファイル名を変更します</span>
          <span class="home-typeset-subtitle">巻数_ページ番号の形式はページ解析を誤るため、読み込み前に安全な名前へ変更します。</span>
        </div>
        <div class="psd-rename-list">${rows}${rest}</div>
        <div class="home-typeset-actions psd-rename-actions">
          <button type="button" class="page-jump-btn psd-rename-cancel">キャンセル</button>
          <button type="button" class="page-jump-btn page-jump-btn-primary psd-rename-ok">リネームして開く</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      hideModalAnimated(modal);
      modal.querySelector(".psd-rename-ok")?.removeEventListener("click", onOk);
      modal.querySelector(".psd-rename-cancel")?.removeEventListener("click", onCancel);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      setTimeout(() => modal.remove(), MODAL_ANIM_MS);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      }
    };

    modal.querySelector(".psd-rename-ok")?.addEventListener("click", onOk);
    modal.querySelector(".psd-rename-cancel")?.addEventListener("click", onCancel);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    showModalAnimated(modal);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        modal.querySelector(".psd-rename-ok")?.focus();
      });
    });
  });
}

export async function guardAmbiguousPsdFilenamesBeforeLoad(paths) {
  const candidates = detectAmbiguousPsdRenameCandidates(paths);
  if (candidates.length === 0) {
    return paths;
  }

  const conflicts = candidates.filter((item) => item.conflictsWithSelection || item.duplicateTarget);
  if (conflicts.length) {
    await notifyDialog({
      title: "PSDファイル名を変更できません",
      message: formatConflictMessage(conflicts),
      kind: "warning",
    });
    return null;
  }

  const ok = await showRenameDialog(candidates);
  if (!ok) return null;

  const { invoke } = await import("@tauri-apps/api/core");
  const renamed = new Map();
  for (const candidate of candidates) {
    try {
      const newPath = await invoke("rename_psd_file", {
        path: candidate.path,
        newName: candidate.toName,
      });
      renamed.set(pathKey(candidate.path), newPath);
    } catch (error) {
      await notifyDialog({
        title: "PSDファイル名の変更に失敗しました",
        message: `${candidate.fromName}: ${error?.message ?? error}`,
        kind: "warning",
      });
      return null;
    }
  }

  const result = paths.map((path) => renamed.get(pathKey(path)) ?? path);
  return result;
}
