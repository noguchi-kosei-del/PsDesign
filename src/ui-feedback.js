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
