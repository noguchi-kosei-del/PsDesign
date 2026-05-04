const $ = (id) => document.getElementById(id);

// CSS の transition と一致させる。閉じるアニメーション完了後に hidden=true とする。
export const MODAL_ANIM_MS = 220;

// 中央モーダルを「奥から手前」アニメーションで開閉するヘルパー。
// CSS 側で `.<modal-class> { opacity:0; transition:opacity }` と
// `.<modal-class>.visible { opacity:1 }`、`.card { transform: scale(0.92); transition:transform }` と
// `.<modal-class>.visible .card { transform: scale(1) }` を定義しておく前提。
//
// 連続呼び出し時の競合（fade-out 中に次の open が来る）に耐えるため、
// hideModalAnimated は最後に .visible を持っていなければ hidden=true、持っていれば
// 次の open に上書きされたとみなして hidden を維持する。
export function showModalAnimated(el) {
  if (!el) return;
  el.hidden = false;
  // hidden 解除と同フレームに .visible を付けるとブラウザが初期状態を確定する前に
  // 終端状態へ飛んで transition が効かないため、2 フレーム遅らせる。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add("visible");
    });
  });
}

export function hideModalAnimated(el, ms = MODAL_ANIM_MS) {
  if (!el) return;
  el.classList.remove("visible");
  setTimeout(() => {
    if (!el.classList.contains("visible")) el.hidden = true;
  }, ms);
}

// 12 ドット円形 spinner。`#progress-icon` の innerHTML に直接挿入する HTML 断片。
// 各 dot は CSS の nth-child セレクタで配置 (rotate(N×30deg) translateY(-22px))・
// fade animation の delay (-N×0.1s) を持ち、回転して見える。
const DEFAULT_SPINNER_HTML = `<div class="progress-spinner">${
  "<div class=\"spinner-dot\"></div>".repeat(12)
}</div>`;

// 直前の hideProgress 閉じアニメをキャンセルするためのタイマー ID。
// 閉じ→即開く（loadReferenceFiles 完了直後に runAiOcr が show する等）の連続呼び出しで
// 古い setTimeout が後から発火して新しい表示を hidden にしてしまう事故を防ぐ。
let pendingHideTimer = null;

// icon: SVG 文字列を直接挿入する（呼び出し側で <svg>...</svg> をそのまま渡す）。
//   undefined / 省略 → デフォルト spinner（PSD 読込・見本読込・Photoshop 反映 等）
//   null              → アイコン領域空 (非表示)
//   "<svg>...</svg>"  → カスタムアイコン
export function showProgress({ title, detail, current, total, showCount, icon } = {}) {
  const modal = $("progress-modal");
  if (!modal) return;
  // 直前の hideProgress が閉じアニメ中なら割り込みキャンセル。
  if (pendingHideTimer != null) {
    clearTimeout(pendingHideTimer);
    pendingHideTimer = null;
  }
  if (modal.classList.contains("closing")) {
    modal.classList.remove("closing");
    modal.style.removeProperty("--bar-top");
  }
  showModalAnimated(modal);
  if (title != null) $("progress-title").textContent = title;
  setProgressIcon(icon === undefined ? DEFAULT_SPINNER_HTML : icon);
  updateProgress({ detail, current, total, showCount });
}

// アイコンを差し替える（呼び出し中に切替えたい場合の補助 API）。
// null / undefined / 空文字を渡すとアイコン領域はクリア。デフォルト spinner に
// 戻したい場合は呼び出し側で DEFAULT_SPINNER_HTML を再渡してください。
export function setProgressIcon(svgString) {
  const el = $("progress-icon");
  if (!el) return;
  el.innerHTML = svgString || "";
}

// showCount: 既定 true。false を渡したときは detail があれば detail を、なければ空を
//            進捗バー内テキストに表示する（OCR の "残り 30 秒" など独自整形向け）。
// バー幅は current/total から計算し fill.style.width に直接反映する（実進捗駆動）。
// 現在/総数が無い場合は .indeterminate を付与してバー満タン表示にし、フラッシュで進行感を出す。
export function updateProgress({ detail, current, total, showCount = true } = {}) {
  if (detail != null) $("progress-detail").textContent = detail;
  const fill = $("progress-fill");
  const loadingText = $("progress-loading-text");
  if (typeof current === "number" && typeof total === "number" && total > 0) {
    const pct = Math.max(0, Math.min(100, (current / total) * 100));
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.classList.remove("indeterminate");
    }
    if (loadingText) {
      if (showCount) {
        const remaining = Math.max(0, total - current);
        loadingText.textContent = `残り ${remaining} ページ ・ ${Math.round(pct)} %`;
      } else {
        // 呼び出し側が detail に進捗テキストを集約しているケース
        loadingText.textContent = detail || "";
      }
    }
  } else {
    if (fill) {
      fill.style.width = "";
      fill.classList.add("indeterminate");
    }
    if (loadingText) {
      // indeterminate (起動中など) は detail があればそれ、なければ "LOADING..." のフォールバック。
      loadingText.textContent = detail || "LOADING...";
    }
  }
}

// 完了時の閉じアニメは「進捗バーを中心線として、ぼかし背景が上下に開く」演出。
// バーの Y 座標を計測して --bar-top に注入 → 上下 2 つの bg 帯の境界をバー位置に揃え、
// .closing クラス付与で bg-top は translateY(-100%)、bg-bottom は translateY(100%) で
// 物理的に画面外へスライドアウトさせる。card は少し遅れてフェードアウト。
//
// 戻り値: 閉じアニメ完了時に resolve する Promise。await すれば「次に開くモーダルが
// progress-modal の上に重なってアニメが見えなくなる」事故を防げる（既存の fire-and-forget
// 呼び出しは await しないだけで、Promise 自体は GC で回収されるため互換）。
//
// success: true を渡すと、close アニメに入る前にアイコン領域へ緑のチェックマーク
// アニメーション（リング描画 + チェック描画 + バースト）を再生してから閉じる。
const PROGRESS_CLOSE_ANIM_MS = 500;
const SUCCESS_HOLD_MS = 700;
const SUCCESS_CHECK_HTML = `
  <div class="success-check-anim">
    <div class="success-check-burst"></div>
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle class="success-check-ring" cx="24" cy="24" r="22"/>
      <path class="success-check-path" d="M14 24l7 7 13-13"/>
    </svg>
  </div>
`;
export function hideProgress({ success = false } = {}) {
  return new Promise((resolve) => {
    const modal = $("progress-modal");
    if (!modal) { resolve(); return; }
    // 既に hidden で closing でもなければ、何も走らせず即解決。
    // （未表示状態で呼ばれた場合に 500ms 待つのは無駄）
    if (modal.hidden && !modal.classList.contains("closing")) {
      resolve();
      return;
    }

    const startCloseAnim = () => {
      // バーの中心 Y をビューポート % で算出し --bar-top に設定（bg-top の高さ = バー位置まで）。
      const trackEl = modal.querySelector(".progress-track");
      if (trackEl) {
        const r = trackEl.getBoundingClientRect();
        const barCenterY = r.top + r.height / 2;
        const winH = window.innerHeight || document.documentElement.clientHeight || 1;
        const topPct = Math.max(0, Math.min(100, (barCenterY / winH) * 100));
        modal.style.setProperty("--bar-top", `${topPct}%`);
      }
      // 直前の hideProgress があれば置き換え（重複タイマー防止）。
      if (pendingHideTimer != null) clearTimeout(pendingHideTimer);
      // .visible は外さず .closing を付ける（opacity 1 維持 + bg 帯のスライドアウト）。
      modal.classList.add("closing");
      pendingHideTimer = setTimeout(() => {
        pendingHideTimer = null;
        // 万一 .closing が外れていたら（次の showProgress が割り込んだ）何もしない。
        if (!modal.classList.contains("closing")) {
          resolve();
          return;
        }
        // アニメ完了 → 状態リセット + hidden 化。次回 open に備えて変数も消す。
        modal.classList.remove("closing");
        modal.classList.remove("visible");
        modal.hidden = true;
        modal.style.removeProperty("--bar-top");
        // 次回 open 時に 0% から再開するため fill 幅と indeterminate クラスを明示リセット。
        const fill = $("progress-fill");
        if (fill) {
          fill.classList.remove("indeterminate");
          fill.style.width = "0%";
        }
        $("progress-detail").textContent = "";
        const loadingText = $("progress-loading-text");
        if (loadingText) loadingText.textContent = "LOADING...";
        setProgressIcon(null);
        resolve();
      }, PROGRESS_CLOSE_ANIM_MS);
    };

    if (success) {
      // close アニメに入る前にアイコンを成功チェックマークに差し替えて約 700ms 再生。
      // ローディングテキストもクリアして「完了」感を視覚的に揃える。
      setProgressIcon(SUCCESS_CHECK_HTML);
      const loadingText = $("progress-loading-text");
      if (loadingText) loadingText.textContent = "";
      setTimeout(startCloseAnim, SUCCESS_HOLD_MS);
    } else {
      startCloseAnim();
    }
  });
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
    showModalAnimated(modal);

    const cleanup = (result) => {
      hideModalAnimated(modal);
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
    showModalAnimated(modal);

    const cleanup = () => {
      hideModalAnimated(modal);
      // Cancel ボタン復帰 / タイトルリセットはフェード完了後に。フェード中に Cancel が
      // 現れたりタイトルが平文に戻るチラつきを避ける。
      setTimeout(() => {
        if (cancelBtn) cancelBtn.hidden = prevCancelHidden;
        if (titleEl) {
          titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
          titleEl.textContent = title;
        }
      }, MODAL_ANIM_MS);
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
    showModalAnimated(modal);

    const cleanup = (result) => {
      hideModalAnimated(modal);
      // input 要素の DOM 除去はフェード完了後に。フェード中に input が消えると
      // 「ダイアログから input だけ先に消える」見た目になって違和感が出る。
      setTimeout(() => {
        if (input.parentNode) input.parentNode.removeChild(input);
      }, MODAL_ANIM_MS);
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
