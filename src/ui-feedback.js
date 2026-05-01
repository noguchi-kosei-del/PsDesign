const $ = (id) => document.getElementById(id);

export function showProgress({ title, detail, current, total, showCount } = {}) {
  const modal = $("progress-modal");
  if (!modal) return;
  modal.hidden = false;
  if (title != null) $("progress-title").textContent = title;
  updateProgress({ detail, current, total, showCount });
}

// showCount: 既定 true。false を渡すと右下のカウント表示 (e.g. "1 / 6") を抑止する
// （AI 画像スキャンのように detail テキスト側で進捗を見せている場合の重複防止）。
// バー自体は current/total から計算したものをそのまま出す。
export function updateProgress({ detail, current, total, showCount = true } = {}) {
  if (detail != null) $("progress-detail").textContent = detail;
  const fill = $("progress-fill");
  const count = $("progress-count");
  if (typeof current === "number" && typeof total === "number" && total > 0) {
    const pct = Math.max(0, Math.min(100, (current / total) * 100));
    fill.style.width = `${pct}%`;
    fill.classList.remove("indeterminate");
    count.textContent = showCount ? `${current} / ${total}` : "";
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

// タイトル要素にテキストとアイコンを書き戻す共通ヘルパー。
// kind: "default" → プレーンテキスト（class クリアのみ）
//       "danger"  → notify-title-danger（赤文字、アイコン無し）
//       "success" → notify-title-success（緑文字 + check-circle SVG）
//       "warning" → notify-title-warning（オレンジ + alert-triangle SVG）
function applyTitleIcon(titleEl, title, kind) {
  if (!titleEl) return;
  titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
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
    if (kind === "danger") titleEl.classList.add("notify-title-danger");
  }
}

// kind: "default" (既定) | "danger" | "success" | "warning"
//   - "danger"  → タイトル赤
//   - "success" → タイトル緑 + チェックアイコン（confirm 用に拡張、画像スキャン完了などで使う）
//   - "warning" → タイトルオレンジ + 警告アイコン
// confirmKind: OK ボタンのスタイル切替
//   - "primary"（既定）→ 青塗り (.page-jump-btn-primary)
//   - "place"          → サイドバーの自動配置ボタン (.ai-place-btn) と同じ緑枠スタイル
export function confirmDialog({
  title = "確認",
  message = "",
  confirmLabel = "OK",
  cancelLabel = "キャンセル",
  kind = "default",
  confirmKind = "primary",
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
    applyTitleIcon(titleEl, title, kind);
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    // OK ボタンのスタイル切替: primary（既定の青塗り）を一度外し、必要に応じて place クラスへ。
    okBtn.classList.remove("page-jump-btn-primary", "page-jump-btn-place");
    if (confirmKind === "place") okBtn.classList.add("page-jump-btn-place");
    else okBtn.classList.add("page-jump-btn-primary");
    modal.hidden = false;

    const cleanup = (result) => {
      modal.hidden = true;
      // 次回呼び出し時の干渉を避けるため、success/warning/danger の class とアイコン HTML を全リセット。
      if (titleEl) {
        titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
        titleEl.textContent = title;
      }
      // OK ボタンのスタイルを既定の primary に戻す（次回 confirmDialog 呼び出し時の出発点）。
      okBtn.classList.remove("page-jump-btn-place");
      if (!okBtn.classList.contains("page-jump-btn-primary")) okBtn.classList.add("page-jump-btn-primary");
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
    applyTitleIcon(titleEl, title, kind);
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
        titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
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

// 単一テキスト入力ダイアログ。confirm-modal の DOM を流用し、メッセージの直下に
// `<input type="text">` を動的挿入する。OK で入力値（trim 後）を resolve、
// Cancel / Esc / 背景クリックで null を resolve。Enter で OK、Esc で Cancel。
// 戻り値は Promise<string | null>。
export function promptDialog({
  title = "入力",
  message = "",
  defaultValue = "",
  placeholder = "",
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
      resolve(null);
      return;
    }
    if (titleEl) {
      titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
      titleEl.textContent = title;
    }
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    // メッセージ直下に `<input>` を 1 つ動的挿入。cleanup で必ず remove する。
    const input = document.createElement("input");
    input.type = "text";
    input.className = "prompt-modal-input";
    input.value = defaultValue || "";
    input.placeholder = placeholder || "";
    msgEl.parentNode.insertBefore(input, msgEl.nextSibling);

    // OK ボタンは notify-success スタイル等の干渉を避けるため primary に揃える。
    okBtn.classList.remove("page-jump-btn-place");
    if (!okBtn.classList.contains("page-jump-btn-primary")) okBtn.classList.add("page-jump-btn-primary");
    modal.hidden = false;

    const cleanup = (result) => {
      modal.hidden = true;
      if (input.parentNode) input.parentNode.removeChild(input);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup((input.value ?? "").trim());
    const onCancel = () => cleanup(null);
    const onOverlay = (e) => { if (e.target === modal) cleanup(null); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(null); }
      else if (e.key === "Enter" && document.activeElement === input) {
        e.preventDefault();
        cleanup((input.value ?? "").trim());
      }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => { input.focus(); input.select(); });
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
