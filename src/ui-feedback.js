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
