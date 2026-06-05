import { showProgress, updateProgress } from "./ui-feedback.js";

const clampPct = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
};

const roman = ["I", "II", "III", "IV", "V", "VI", "VII"];

let activeFlow = null;

function formatRemainingMs(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return "残り約1分未満";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `残り約${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (restMinutes < 10) return `残り約${hours}時間`;
  return `残り約${hours}時間${restMinutes}分`;
}

function normalizeSteps(steps = []) {
  return steps
    .map((step, index) => ({
      id: String(step.id || `step-${index + 1}`),
      label: String(step.label || step.id || `Step ${index + 1}`),
      labelEn: String(step.labelEn || step.id || `step ${index + 1}`),
      weight: Math.max(0.1, Number(step.weight) || 1),
      progress: clampPct(step.progress) ?? 0,
      status: index === 0 ? "active" : "pending",
      detail: "",
      current: null,
      total: null,
    }))
    .filter((step) => step.id);
}

function getFlow(id) {
  return activeFlow && activeFlow.id === id ? activeFlow : null;
}

function setActiveStep(flow, stepId) {
  const nextIndex = flow.steps.findIndex((step) => step.id === stepId);
  if (nextIndex < 0) return;
  const prevIndex = flow.steps.findIndex((step) => step.id === flow.activeStepId);
  flow.activeStepId = stepId;
  flow.steps.forEach((step, index) => {
    if (index < nextIndex) {
      step.status = "done";
      step.progress = Math.max(step.progress, 100);
      return;
    }
    if (index === nextIndex) {
      step.status = "active";
      return;
    }
    if (step.status !== "done") step.status = "pending";
  });
  if (nextIndex !== prevIndex) flow.phaseSerial += 1;
}

function updateStep(flow, stepId, data = {}) {
  if (!flow || !stepId) return;
  setActiveStep(flow, stepId);
  const step = flow.steps.find((item) => item.id === stepId);
  if (!step) return;

  const current = Number(data.current);
  const total = Number(data.total);
  const explicitProgress = clampPct(data.progress ?? data.taskProgress);
  const countedProgress = Number.isFinite(current) && Number.isFinite(total) && total > 0
    ? clampPct((current / total) * 100)
    : null;
  const nextProgress = explicitProgress ?? countedProgress;
  if (nextProgress != null) step.progress = Math.max(step.progress, nextProgress);
  if (data.detail != null) step.detail = String(data.detail);
  step.current = Number.isFinite(current) ? current : null;
  step.total = Number.isFinite(total) && total > 0 ? total : null;

  if (step.progress >= 100 || data.status === "done") {
    step.status = "done";
    step.progress = 100;
  } else {
    step.status = "active";
  }
}

function computeOverallPct(flow) {
  const totalWeight = flow.steps.reduce((sum, step) => sum + step.weight, 0) || 1;
  const doneWeight = flow.steps.reduce((sum, step) => {
    return sum + step.weight * (Math.max(0, Math.min(100, step.progress)) / 100);
  }, 0);
  return Math.max(0, Math.min(100, (doneWeight / totalWeight) * 100));
}

function snapshot(flow) {
  if (!flow) return null;
  const activeIndex = Math.max(0, flow.steps.findIndex((step) => step.id === flow.activeStepId));
  const activeStep = flow.steps[activeIndex] || flow.steps[0] || null;
  const overallPct = flow.completed ? 100 : Math.min(98.4, computeOverallPct(flow));
  const elapsedMs = Math.max(0, Date.now() - flow.startedAt);
  const hasEstimate = !flow.completed && overallPct >= 5 && overallPct < 96 && elapsedMs > 8000;
  const remainingMs = hasEstimate ? elapsedMs * ((100 - overallPct) / Math.max(overallPct, 1)) : null;
  return {
    id: flow.id,
    title: flow.title,
    overallPct,
    completed: flow.completed,
    elapsedMs,
    remainingLabel: remainingMs != null ? formatRemainingMs(remainingMs) : "",
    activeStepId: activeStep?.id ?? null,
    activeIndex,
    activeOrdinal: roman[activeIndex] || String(activeIndex + 1),
    phaseSerial: flow.phaseSerial,
    steps: flow.steps.map((step) => ({ ...step })),
  };
}

export function startProgressFlow({ id, title, variant = "place", icon = null, steps = [], detail = "準備中…" }) {
  const normalized = normalizeSteps(steps);
  activeFlow = {
    id,
    title,
    variant,
    icon,
    steps: normalized,
    activeStepId: normalized[0]?.id ?? null,
    completed: false,
    phaseSerial: 0,
    startedAt: Date.now(),
  };
  showProgress({
    title,
    detail,
    current: null,
    total: null,
    showCount: false,
    icon,
    variant,
    flow: snapshot(activeFlow),
  });
  return id;
}

export function withProgressFlow(flowRef, data = {}) {
  if (!flowRef) return data;
  const id = typeof flowRef === "string" ? flowRef : flowRef.id;
  const stepId = typeof flowRef === "string" ? null : flowRef.stepId;
  const flow = getFlow(id);
  if (!flow) return data;
  if (stepId) updateStep(flow, stepId, data);
  return {
    ...data,
    flow: snapshot(flow),
  };
}

export function updateProgressFlow(flowRef, data = {}) {
  updateProgress(withProgressFlow(flowRef, data));
}

export function completeProgressFlowStep(flowRef, data = {}) {
  const payload = withProgressFlow(flowRef, { ...data, progress: 100, status: "done" });
  updateProgress(payload);
}

export function clearProgressFlow(id) {
  if (!id || activeFlow?.id === id) activeFlow = null;
}

export function createHomeTypesetSteps({ positionAdjustMode = null } = {}) {
  const steps = [
    { id: "reference-load", label: "見本読み込み", labelEn: "reference", weight: 10 },
    { id: "psd-load", label: "PSD解析", labelEn: "psd parsing", weight: 25 },
    { id: "scan", label: "画像スキャン", labelEn: "scan", weight: 35 },
  ];
  if (positionAdjustMode === "mode1" || positionAdjustMode === "mode2") {
    steps.push({ id: "align", label: "位置調整", labelEn: "alignment", weight: 10 });
  }
  steps.push({ id: "place", label: "自動配置", labelEn: "placement", weight: 20 });
  if (positionAdjustMode === "mode3") {
    steps.push({ id: "align", label: "重ね調整", labelEn: "overlay alignment", weight: 10 });
  }
  return steps;
}

export function createHomeTranscribeSteps() {
  return [
    { id: "reference-load", label: "見本読み込み", labelEn: "reference", weight: 22 },
    { id: "scan", label: "画像スキャン", labelEn: "scan", weight: 43 },
    { id: "transcribe", label: "書き起こし", labelEn: "transcription", weight: 30 },
    { id: "editor-ready", label: "表示準備", labelEn: "preparing view", weight: 5 },
  ];
}

export function createHomeReuseSteps() {
  return [
    { id: "psd-read", label: "PSD読み取り", labelEn: "psd reading", weight: 42 },
    { id: "extract", label: "テキスト抽出", labelEn: "text extraction", weight: 28 },
    { id: "place", label: "配置調整", labelEn: "placement", weight: 22 },
    { id: "view-ready", label: "表示準備", labelEn: "preparing view", weight: 8 },
  ];
}

export function createProjectLoadSteps() {
  return [
    { id: "project-read", label: "プロジェクト読込", labelEn: "project file", weight: 10 },
    { id: "psd-load", label: "PSD読み込み", labelEn: "psd parsing", weight: 45 },
    { id: "reference-load", label: "見本読み込み", labelEn: "reference", weight: 25 },
    { id: "snapshot-restore", label: "編集復元", labelEn: "restoring edits", weight: 15 },
    { id: "view-ready", label: "表示準備", labelEn: "preparing view", weight: 5 },
  ];
}
