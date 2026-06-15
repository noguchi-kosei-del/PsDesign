export function normalizeFontSearchText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja");
}

export function fontDisplayName(font) {
  return font?.name || font?.label || font?.postScriptName || "";
}

export function fontSearchHaystack(font) {
  const aliases = Array.isArray(font?.aliases) ? font.aliases : [];
  return normalizeFontSearchText([
    font?.name,
    font?.label,
    font?.postScriptName,
    ...aliases,
  ].filter(Boolean).join("\n"));
}

export function resolveFontFromInput(fonts, typed) {
  const trimmed = String(typed ?? "").trim();
  if (!trimmed) return null;
  const list = Array.isArray(fonts) ? fonts : [];
  const exactDisplay = list.find((font) => fontDisplayName(font) === trimmed);
  if (exactDisplay) return exactDisplay;
  const exactPs = list.find((font) => (font?.postScriptName ?? "") === trimmed);
  if (exactPs) return exactPs;
  const lower = normalizeFontSearchText(trimmed);
  return list.find((font) => normalizeFontSearchText(fontDisplayName(font)) === lower)
    ?? list.find((font) => normalizeFontSearchText(font?.postScriptName ?? "") === lower)
    ?? null;
}

function setHidden(el, hidden) {
  if (el) el.hidden = !!hidden;
}

export function createFontCombobox({
  input,
  list,
  combo,
  getFonts,
  getCurrentPostScriptName = () => "",
  onCommit = () => {},
  onBuilt = null,
  onOpen = null,
  onClose = null,
  itemClassName = "",
  emptyClassName = "font-combobox-empty",
  emptyText = "",
  positionMode = "none",
  appendToBody = false,
  positionTarget = null,
  blurOnCommit = false,
} = {}) {
  let items = [];
  let highlighted = -1;
  let open = false;
  let emptyItem = null;

  const api = {
    input,
    list,
    combo,
    getItems: () => items,
    isOpen: () => open,
    getHighlightedIndex: () => highlighted,
    getHighlightedFont: () => highlighted >= 0 ? items[highlighted]?.font ?? null : null,
    rebuild,
    filter,
    setHighlight,
    moveHighlight,
    position,
    open: openCombo,
    close,
    commit,
    resolve: (value = input?.value) => resolveFontFromInput(getFontList(), value),
  };

  function getFontList() {
    const fonts = typeof getFonts === "function" ? getFonts() : [];
    return Array.isArray(fonts) ? fonts.filter((font) => font?.postScriptName) : [];
  }

  function rebuild() {
    if (!list) return;
    list.textContent = "";
    items = [];
    highlighted = -1;
    emptyItem = null;
    const fonts = getFontList();
    for (const font of fonts) {
      const item = document.createElement("li");
      item.className = ["font-combobox-item", itemClassName].filter(Boolean).join(" ");
      item.dataset.ps = font.postScriptName;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");

      const name = document.createElement("span");
      name.className = "font-combobox-name";
      name.textContent = fontDisplayName(font);
      item.appendChild(name);

      if (fontDisplayName(font) && font.postScriptName && fontDisplayName(font) !== font.postScriptName) {
        const sub = document.createElement("span");
        sub.className = "font-combobox-sub";
        sub.textContent = font.postScriptName;
        item.appendChild(sub);
      }

      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => {
        commit(font);
      });
      list.appendChild(item);
      items.push({ el: item, font, name, styled: false });
    }
    if (emptyText) {
      emptyItem = document.createElement("li");
      emptyItem.className = emptyClassName;
      emptyItem.textContent = emptyText;
      emptyItem.hidden = items.length > 0;
      list.appendChild(emptyItem);
    }
    if (typeof onBuilt === "function") onBuilt(items, list);
  }

  function visibleIndexes() {
    return items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.el.style.display !== "none")
      .map(({ index }) => index);
  }

  function setHighlight(idx) {
    if (highlighted >= 0 && items[highlighted]) {
      items[highlighted].el.classList.remove("highlight");
      items[highlighted].el.setAttribute("aria-selected", "false");
    }
    highlighted = Number.isInteger(idx) ? idx : -1;
    if (highlighted >= 0 && items[highlighted]) {
      const el = items[highlighted].el;
      el.classList.add("highlight");
      el.setAttribute("aria-selected", "true");
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function filter(query = "") {
    const q = normalizeFontSearchText(query).trim();
    let firstVisible = -1;
    for (let i = 0; i < items.length; i++) {
      const { el, font } = items[i];
      const match = q === "" || fontSearchHaystack(font).includes(q);
      el.style.display = match ? "" : "none";
      if (match && firstVisible < 0) firstVisible = i;
    }
    if (emptyItem) emptyItem.hidden = firstVisible >= 0;
    setHighlight(firstVisible);
  }

  function position() {
    if (positionMode !== "fixed" || !list) return;
    const target = positionTarget || combo || input;
    if (!target) return;
    if (appendToBody && list.parentElement !== document.body) {
      document.body.appendChild(list);
    }
    const r = target.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 800;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 600;
    const margin = 8;
    const gap = 4;
    const width = Math.max(160, Math.min(r.width, viewportWidth - margin * 2));
    const left = Math.max(margin, Math.min(r.left, viewportWidth - width - margin));
    const estimatedHeight = Math.min(((items.length || list.children.length || 1) * 34) + 12, 260);
    const naturalHeight = Math.max(120, estimatedHeight);
    const spaceBelow = Math.max(0, viewportHeight - r.bottom - margin);
    const spaceAbove = Math.max(0, r.top - margin);
    const openAbove = spaceAbove > spaceBelow && spaceBelow < naturalHeight;
    const availableHeight = Math.max(120, openAbove ? spaceAbove : spaceBelow);
    const height = Math.min(naturalHeight, availableHeight);
    const top = openAbove
      ? Math.max(margin, r.top - height - gap)
      : Math.min(viewportHeight - margin - height, r.bottom + gap);
    list.style.left = `${left}px`;
    list.style.top = `${top}px`;
    list.style.width = `${width}px`;
    list.style.maxHeight = `${height}px`;
  }

  function openCombo({ showAll = false, query = null, rebuild: shouldRebuild = false } = {}) {
    if (!input || !list || input.disabled) return;
    if (typeof onOpen === "function") onOpen(api);
    if (shouldRebuild || !items.length) rebuild();
    if (!items.length && !emptyText) return;
    open = true;
    combo?.classList.add("open");
    position();
    setHidden(list, false);
    filter(showAll ? "" : query ?? input.value);
    const currentPs = getCurrentPostScriptName() || "";
    if (currentPs) {
      const idx = items.findIndex(({ el, font }) =>
        el.style.display !== "none" && font.postScriptName === currentPs);
      if (idx >= 0) setHighlight(idx);
    }
  }

  function close() {
    open = false;
    setHidden(list, true);
    combo?.classList.remove("open");
    if (typeof onClose === "function") onClose(api);
  }

  function moveHighlight(delta, { openIfClosed = true, showAll = false } = {}) {
    if (!open) {
      if (openIfClosed) openCombo({ showAll });
      return;
    }
    const visible = visibleIndexes();
    if (!visible.length) return;
    const currentVisibleIndex = visible.indexOf(highlighted);
    const next = currentVisibleIndex < 0
      ? visible[0]
      : visible[(currentVisibleIndex + delta + visible.length) % visible.length];
    setHighlight(next);
  }

  function commit(fontOrOptions = null) {
    const options = fontOrOptions && typeof fontOrOptions === "object" && !fontOrOptions.postScriptName
      ? fontOrOptions
      : {};
    const directFont = fontOrOptions?.postScriptName ? fontOrOptions : null;
    const font = directFont
      || (open && highlighted >= 0 ? items[highlighted]?.font : null)
      || resolveFontFromInput(getFontList(), options.fallbackValue ?? input?.value);
    if (!font) return null;
    onCommit(font, api);
    close();
    if (options.blur ?? blurOnCommit) input?.blur();
    return font;
  }

  return api;
}
