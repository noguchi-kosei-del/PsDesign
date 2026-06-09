const GIB = 1024 ** 3;
const MEMORY_POLL_MS = 60_000;

const FALLBACK_AVAILABLE_THRESHOLD_BYTES = 4 * GIB;
const FALLBACK_TOTAL_THRESHOLD_BYTES = 8 * GIB;
const FALLBACK_LOAD_THRESHOLD_PERCENT = 85;

// 低メモリモードとは別に、通常メモリでも適用する「巨大 PSD のプレビュー上限」。
// Chromium はシステム RAM とは別にレンダラあたりの canvas メモリ上限を持ち、
// 5000x8000 級のページを多数フル解像度で保持すると上限を超えて古いページの
// canvas バッキングストアが破棄され、絵柄が真っ黒に飛ぶ。そこで寸法が大きい
// PSD は表示用ラスターだけを縮小して総 canvas メモリを上限以下に抑える
// （論理寸法 page.width/height は不変なので座標・植字・保存位置には影響しない）。
const LARGE_PSD_PREVIEW_MAX_SIDE = 3000;
const LARGE_PSD_PREVIEW_MAX_PIXELS = 8_000_000;

const DEFAULT_LOW_MEMORY_LIMITS = {
  dprCap: 1,
  previewMaxSide: 2400,
  previewMaxPixels: 3_500_000,
  highFidelityMaskingMaxPixels: 3_500_000,
};

const CRITICAL_LOW_MEMORY_LIMITS = {
  dprCap: 1,
  previewMaxSide: 1800,
  previewMaxPixels: 2_000_000,
  highFidelityMaskingMaxPixels: 0,
};

let memoryStatus = {
  totalPhysicalBytes: 0,
  availablePhysicalBytes: 0,
  memoryLoadPercent: 0,
  low: false,
  reason: "initial",
  source: "initial",
  thresholds: {
    availableBytes: FALLBACK_AVAILABLE_THRESHOLD_BYTES,
    totalBytes: FALLBACK_TOTAL_THRESHOLD_BYTES,
    memoryLoadPercent: FALLBACK_LOAD_THRESHOLD_PERCENT,
  },
};

let initialized = false;
const listeners = new Set();

function bytesFrom(raw, snake, camel) {
  const value = raw?.[snake] ?? raw?.[camel];
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeBackendStatus(raw) {
  const total = bytesFrom(raw, "total_physical_bytes", "totalPhysicalBytes");
  const available = bytesFrom(raw, "available_physical_bytes", "availablePhysicalBytes");
  const load = Number(raw?.memory_load_percent ?? raw?.memoryLoadPercent ?? 0);
  const thresholdAvailable = bytesFrom(raw, "threshold_available_bytes", "thresholdAvailableBytes")
    || FALLBACK_AVAILABLE_THRESHOLD_BYTES;
  const thresholdTotal = bytesFrom(raw, "threshold_total_bytes", "thresholdTotalBytes")
    || FALLBACK_TOTAL_THRESHOLD_BYTES;
  const thresholdLoad = Number(raw?.threshold_memory_load_percent ?? raw?.thresholdMemoryLoadPercent)
    || FALLBACK_LOAD_THRESHOLD_PERCENT;
  return {
    totalPhysicalBytes: total,
    availablePhysicalBytes: available,
    memoryLoadPercent: Number.isFinite(load) ? Math.max(0, Math.min(100, Math.round(load))) : 0,
    low: raw?.low === true,
    reason: typeof raw?.reason === "string" ? raw.reason : "normal",
    source: "system",
    thresholds: {
      availableBytes: thresholdAvailable,
      totalBytes: thresholdTotal,
      memoryLoadPercent: thresholdLoad,
    },
  };
}

function fallbackStatus() {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const totalGb = Number(nav?.deviceMemory ?? 0);
  const total = Number.isFinite(totalGb) && totalGb > 0 ? totalGb * GIB : 0;
  const low = total > 0 && total <= FALLBACK_TOTAL_THRESHOLD_BYTES;
  return {
    totalPhysicalBytes: total,
    availablePhysicalBytes: 0,
    memoryLoadPercent: 0,
    low,
    reason: low ? "total" : "unavailable",
    source: total > 0 ? "navigator" : "unavailable",
    thresholds: {
      availableBytes: FALLBACK_AVAILABLE_THRESHOLD_BYTES,
      totalBytes: FALLBACK_TOTAL_THRESHOLD_BYTES,
      memoryLoadPercent: FALLBACK_LOAD_THRESHOLD_PERCENT,
    },
  };
}

function applyStatus(next) {
  const prevLow = memoryStatus.low;
  memoryStatus = next;
  if (typeof document !== "undefined") {
    document.body?.classList.toggle("low-memory-mode", next.low);
  }
  if (prevLow !== next.low || next.source !== "initial") {
    for (const fn of listeners) fn(memoryStatus);
  }
}

export async function refreshMemoryStatus() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke("get_system_memory_status");
    applyStatus(normalizeBackendStatus(raw));
  } catch (error) {
    console.warn("[memory-mode] system memory status unavailable:", error);
    applyStatus(fallbackStatus());
  }
  return memoryStatus;
}

export function initMemoryMode() {
  if (initialized) return refreshMemoryStatus();
  initialized = true;
  const first = refreshMemoryStatus();
  if (typeof window !== "undefined") {
    window.setInterval(() => {
      void refreshMemoryStatus();
    }, MEMORY_POLL_MS);
  }
  return first;
}

export function getMemoryStatus() {
  return memoryStatus;
}

export function isLowMemoryMode() {
  return memoryStatus.low === true;
}

export function onMemoryStatusChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getRasterMemoryLimits() {
  if (!isLowMemoryMode()) {
    return {
      dprCap: Infinity,
      previewMaxSide: Infinity,
      previewMaxPixels: Infinity,
      highFidelityMaskingMaxPixels: Infinity,
    };
  }
  const critical =
    memoryStatus.availablePhysicalBytes > 0 &&
    memoryStatus.availablePhysicalBytes < 2 * GIB;
  return critical ? CRITICAL_LOW_MEMORY_LIMITS : DEFAULT_LOW_MEMORY_LIMITS;
}

export function getCanvasDprCap() {
  return getRasterMemoryLimits().dprCap;
}

export function isCriticalLowMemoryMode() {
  return isLowMemoryMode() &&
    memoryStatus.availablePhysicalBytes > 0 &&
    memoryStatus.availablePhysicalBytes < 2 * GIB;
}

export function getMemoryRenderKey() {
  const limits = getRasterMemoryLimits();
  return [
    memoryStatus.low ? "low" : "normal",
    limits.dprCap,
    limits.previewMaxSide,
    limits.previewMaxPixels,
    limits.highFidelityMaskingMaxPixels,
  ].join(":");
}

// worker に渡す「通常メモリ時の巨大 PSD 上限」。低メモリ時は getRasterMemoryLimits()
// 側のより強い制限を使う（parsePsdWithWorker 参照）。
export function getLargePsdPreviewLimits() {
  return {
    previewMaxSide: LARGE_PSD_PREVIEW_MAX_SIDE,
    previewMaxPixels: LARGE_PSD_PREVIEW_MAX_PIXELS,
  };
}

export function getPreviewScaleForSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return 1;
  // 通常メモリでも巨大 PSD は縮小（黒飛び対策）。基準は LARGE_PSD_PREVIEW_*。
  let previewMaxSide = LARGE_PSD_PREVIEW_MAX_SIDE;
  let previewMaxPixels = LARGE_PSD_PREVIEW_MAX_PIXELS;
  // 低メモリモード時はさらに強い制限を min で重ねる。
  if (isLowMemoryMode()) {
    const limits = getRasterMemoryLimits();
    previewMaxSide = Math.min(previewMaxSide, limits.previewMaxSide);
    previewMaxPixels = Math.min(previewMaxPixels, limits.previewMaxPixels);
  }
  const bySide = previewMaxSide / Math.max(w, h);
  const byPixels = Math.sqrt(previewMaxPixels / Math.max(1, w * h));
  const scale = Math.min(1, bySide, byPixels);
  return Math.max(0.05, Math.min(1, scale));
}

export function formatMemoryBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= GIB) return `${(n / GIB).toFixed(n >= 10 * GIB ? 0 : 1)} GB`;
  return `${Math.round(n / (1024 ** 2))} MB`;
}

export function describeMemoryStatus(status = memoryStatus) {
  const available = formatMemoryBytes(status.availablePhysicalBytes);
  const total = formatMemoryBytes(status.totalPhysicalBytes);
  if (status.low) {
    return `低メモリモード: 空き ${available} / 総 ${total}`;
  }
  if (status.source === "unavailable") return "メモリ状態を取得できません";
  return `通常メモリ: 空き ${available} / 総 ${total}`;
}
