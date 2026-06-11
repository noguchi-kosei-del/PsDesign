let activeLoadOperation = null;

export function tryBeginLoadOperation(label = "load") {
  if (activeLoadOperation) return null;
  const token = {
    label,
    startedAt: Date.now(),
    id: Symbol(label),
  };
  activeLoadOperation = token;
  window.dispatchEvent(new CustomEvent("psdesign:load-operation-change", {
    detail: { active: true, label },
  }));
  return token;
}

export function endLoadOperation(token) {
  if (!token || activeLoadOperation !== token) return;
  activeLoadOperation = null;
  window.dispatchEvent(new CustomEvent("psdesign:load-operation-change", {
    detail: { active: false },
  }));
}

export function isLoadOperationActive() {
  return !!activeLoadOperation;
}

export function getActiveLoadOperationLabel() {
  return activeLoadOperation?.label || "";
}
