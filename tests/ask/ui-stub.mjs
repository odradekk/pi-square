import { stripVTControlCharacters } from "node:util";

export function visibleWidth(text) {
  return Array.from(stripVTControlCharacters(String(text))).length;
}

export function truncateToWidth(text, width, ellipsis = "…", pad = false) {
  const target = Math.max(0, width);
  const characters = Array.from(String(text));
  const suffix = Array.from(ellipsis);
  let result = characters.length <= target
    ? characters.join("")
    : characters.slice(0, Math.max(0, target - suffix.length)).join("") + suffix.join("");
  if (pad && visibleWidth(result) < target) result += " ".repeat(target - visibleWidth(result));
  return result;
}

export function wrapTextWithAnsi(text, width) {
  const target = Math.max(1, width);
  const characters = Array.from(String(text));
  if (characters.length === 0) return [""];
  const lines = [];
  for (let index = 0; index < characters.length; index += target) {
    lines.push(characters.slice(index, index + target).join(""));
  }
  return lines;
}

// ── Minimal fakes for @earendil-works/pi-coding-agent's getSelectListTheme ──
// and @earendil-works/pi-tui's SelectList/Input. These are NOT faithful
// reimplementations of the real components — they cover only the input
// surface `extensions/ask/prompt.ts` actually drives (arrow/enter/escape
// navigation, single-line value editing), enough to unit-test
// promptQuestions()'s own orchestration logic without depending on a real
// terminal or the full pi-tui package (unavailable via plain Node
// resolution in this workspace; see ui.test.mjs's jiti alias).

export function getSelectListTheme() {
  const identity = (s) => String(s);
  return {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  };
}

export class SelectList {
  constructor(items, maxVisible, _theme, _layout = {}) {
    this.items = items;
    this.maxVisible = maxVisible;
    this.selectedIndex = 0;
    this.onSelect = undefined;
    this.onCancel = undefined;
    this.onSelectionChange = undefined;
  }

  setSelectedIndex(index) {
    this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
  }

  getSelectedItem() {
    return this.items[this.selectedIndex] ?? null;
  }

  invalidate() {}

  render(width) {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + (item.label ?? item.value), width, "", true);
    });
  }

  handleInput(data) {
    if (data === "\x1b[A" || data === "\x1bOA") { // allow-ansi: keyboard-input
      this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      this.onSelectionChange?.(this.items[this.selectedIndex]);
      return;
    }
    if (data === "\x1b[B" || data === "\x1bOB") { // allow-ansi: keyboard-input
      this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      this.onSelectionChange?.(this.items[this.selectedIndex]);
      return;
    }
    if (data === "\r" || data === "\n") {
      const item = this.items[this.selectedIndex];
      if (item) this.onSelect?.(item);
      return;
    }
    if (data === "\x1b" || data === "\x03") {
      this.onCancel?.();
      return;
    }
  }
}

export class Input {
  constructor() {
    this.value = "";
    this.focused = false;
    this.onSubmit = undefined;
    this.onEscape = undefined;
  }

  getValue() {
    return this.value;
  }

  setValue(value) {
    this.value = String(value ?? "");
  }

  invalidate() {}

  render(width) {
    return [truncateToWidth(`> ${this.value}`, width, "", true)];
  }

  handleInput(data) {
    if (data === "\r" || data === "\n") {
      this.onSubmit?.(this.value);
      return;
    }
    if (data === "\x1b") {
      this.onEscape?.();
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.value = this.value.slice(0, -1);
      return;
    }
    if (data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b")) {
      this.value += data;
    }
  }
}
