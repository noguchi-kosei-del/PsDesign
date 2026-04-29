const $ = (id) => document.getElementById(id);

export function showProgress({ title, detail, current, total } = {}) {
  const modal = $("progress-modal");
  if (!modal) return;
  modal.hidden = false;
  if (title != null) $("progress-title").textContent = title;
  updateProgress({ detail, current, total });
}

export function updateProgress({ detail, current, total } = {}) {
  if (detail != null) $("progress-detail").textContent = detail;
  const fill = $("progress-fill");
  const count = $("progress-count");
  if (typeof current === "number" && typeof total === "number" && total > 0) {
    const pct = Math.max(0, Math.min(100, (current / total) * 100));
    fill.style.width = `${pct}%`;
    fill.classList.remove("indeterminate");
    count.textContent = `${current} / ${total}`;
  } else {
    fill.style.width = "100%";
    fill.classList.add("indeterminate");
    count.textContent = "";
  }
}

export function hideProgress() {
  const modal = $("progress-modal");
  if (!modal) return;
  modal.hidden = true;
  $("progress-fill").classList.remove("indeterminate");
  $("progress-fill").style.width = "0%";
  $("progress-detail").textContent = "";
  $("progress-count").textContent = "";
}

export function confirmDialog({
  title = "確認",
  message = "",
  confirmLabel = "OK",
  cancelLabel = "キャンセル",
} = {}) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    const titleEl = $("confirm-modal-title");
    const msgEl = $("confirm-modal-message");
    const okBtn = $("confirm-modal-ok");
    const cancelBtn = $("confirm-modal-cancel");
    if (!modal || !okBtn || !cancelBtn || !msgEl) {
      resolve(false);
      return;
    }
    if (titleEl) titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
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
    requestAnimationFrame(() => okBtn.focus());
  });
}

// 単一 OK ボタンの中央モーダル通知。`#confirm-modal` の DOM を流用し、
// Cancel ボタンを一時的に非表示にする。OK / Esc / Enter / 背景クリックで dismiss。
// kind: "info" (既定) | "success" | "warning"
//   - "success" → タイトル緑 + チェック (check-circle) SVG
//   - "warning" → タイトルオレンジ + 警告 (alert-triangle) SVG
// 戻り値は Promise<void>。
export function notifyDialog({
  title = "通知",
  message = "",
  okLabel = "OK",
  kind = "info",
} = {}) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    const titleEl = $("confirm-modal-title");
    const msgEl = $("confirm-modal-message");
    const okBtn = $("confirm-modal-ok");
    const cancelBtn = $("confirm-modal-cancel");
    if (!modal || !okBtn || !msgEl) {
      resolve();
      return;
    }
    if (titleEl) {
      titleEl.classList.remove("notify-title-success", "notify-title-warning");
      if (kind === "success" || kind === "warning") {
        titleEl.classList.add(kind === "success" ? "notify-title-success" : "notify-title-warning");
        const iconSvg = kind === "success"
          ? `<svg class="notify-title-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="8 12.5 11 15.5 16 9.5"/>
            </svg>`
          : `<svg class="notify-title-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>`;
        titleEl.innerHTML = `${iconSvg}<span class="notify-title-text"></span>`;
        const span = titleEl.querySelector(".notify-title-text");
        if (span) span.textContent = title;
      } else {
        titleEl.textContent = title;
      }
    }
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    // Cancel ボタンは notify では非表示。次回 confirmDialog の呼び出し時に
    // 復帰するよう cleanup で元の hidden 状態に戻す。
    const prevCancelHidden = cancelBtn ? cancelBtn.hidden : false;
    if (cancelBtn) cancelBtn.hidden = true;
    modal.hidden = false;

    const cleanup = () => {
      modal.hidden = true;
      if (cancelBtn) cancelBtn.hidden = prevCancelHidden;
      // タイトルを次回呼び出しのために plain テキスト状態に戻す。
      if (titleEl) {
        titleEl.classList.remove("notify-title-success", "notify-title-warning");
        titleEl.textContent = title;
      }
      okBtn.removeEventListener("click", onOk);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve();
    };
    const onOk = () => cleanup();
    const onOverlay = (e) => { if (e.target === modal) cleanup(); };
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        cleanup();
      }
    };
    okBtn.addEventListener("click", onOk);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => okBtn.focus());
  });
}

export function toast(message, { kind = "info", duration = 2800 } = {}) {
  const container = $("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  const remove = () => {
    el.classList.remove("visible");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  setTimeout(remove, duration);
  el.addEventListener("click", remove);
}
