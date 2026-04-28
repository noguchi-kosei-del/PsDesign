// 起動時に Tauri Updater で新バージョンを確認し、見つかれば
// ヘッダー直上のバナー (#update-banner) を表示する。
// 「今すぐ更新」で download → install → relaunch、「後で」で非表示。

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "./ui-feedback.js";

const STARTUP_DELAY_MS = 1500;

let dismissed = false;
let cachedUpdate = null;

function el(id) {
  return document.getElementById(id);
}

function showBanner(version) {
  const banner = el("update-banner");
  const versionEl = el("update-banner-version");
  if (!banner || !versionEl) return;
  versionEl.textContent = `v${version}`;
  banner.hidden = false;
}

function hideBanner() {
  const banner = el("update-banner");
  if (banner) banner.hidden = true;
}

async function applyUpdate() {
  const applyBtn = el("update-apply-btn");
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = "更新中...";
  }
  try {
    const update = cachedUpdate ?? (await check());
    if (!update) {
      toast("既に最新です", { kind: "info" });
      hideBanner();
      return;
    }
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.error("[updater] apply failed:", err);
    toast(`更新失敗: ${err}`, { kind: "error", duration: 7000 });
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = "今すぐ更新";
    }
  }
}

export function bindAutoUpdater() {
  const applyBtn = el("update-apply-btn");
  const dismissBtn = el("update-dismiss-btn");

  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      applyUpdate();
    });
  }
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      dismissed = true;
      hideBanner();
    });
  }

  setTimeout(async () => {
    if (dismissed) return;
    try {
      const update = await check();
      if (!update) return;
      cachedUpdate = update;
      showBanner(update.version);
    } catch (err) {
      // ネット切れ・エンドポイント未設定など。サイレントで握りつぶす。
      console.warn("[updater] check failed:", err);
    }
  }, STARTUP_DELAY_MS);
}
