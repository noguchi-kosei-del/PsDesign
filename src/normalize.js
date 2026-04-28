// AI セリフ抽出後のテキスト正規化
//
// 元: serifu-memo/src/normalize.ts (Ina986/serifu-memo v0.1.1)
// 主な変更点:
//   - localStorage キーを psdesign-ai-normalize-v1 に変更
//   - TS → JS への型剥がし

const STORAGE_KEY = "psdesign-ai-normalize-v1";

export const DEFAULT_SETTINGS = {
  collapsePeriods: true,
  rules: [
    { id: "colon", enabled: true, from: "：", to: "…" },
  ],
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      collapsePeriods: parsed.collapsePeriods ?? true,
      rules: Array.isArray(parsed.rules) ? parsed.rules : DEFAULT_SETTINGS.rules,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota errors */
  }
}

function collapsePeriodRuns(text) {
  let out = "";
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "．") {
      const start = i;
      while (i < chars.length && chars[i] === "．") i++;
      const count = i - start;
      if (count >= 2) {
        const n = Math.max(1, Math.round(count / 3));
        out += "…".repeat(n);
      } else {
        out += "．";
      }
    } else {
      out += chars[i];
      i++;
    }
  }
  return out;
}

export function applyRules(text, settings) {
  let out = settings.collapsePeriods ? collapsePeriodRuns(text) : text;
  for (const r of settings.rules) {
    if (r.enabled && r.from.length > 0) {
      out = out.split(r.from).join(r.to);
    }
  }
  return out;
}

export function newRule() {
  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    enabled: true,
    from: "",
    to: "",
  };
}
