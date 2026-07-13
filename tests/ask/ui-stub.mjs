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
  const lines = [];
  for (const sourceLine of String(text).split("\n")) {
    const characters = Array.from(sourceLine);
    if (characters.length === 0) {
      lines.push("");
      continue;
    }
    for (let index = 0; index < characters.length; index += target) {
      lines.push(characters.slice(index, index + target).join(""));
    }
  }
  return lines;
}

export function matchesKey(data, key) {
  const matches = {
    space: data === " ",
    escape: data === "\x1b",
    enter: data === "\r" || data === "\n",
    up: data === "\x1b[A" || data === "\x1bOA",
    down: data === "\x1b[B" || data === "\x1bOB",
    pageUp: data === "\x1b[5~",
    pageDown: data === "\x1b[6~",
    "shift+pageUp": data === "\x1b[5;2~",
    "shift+pageDown": data === "\x1b[6;2~",
  };
  return Boolean(matches[key]);
}

export function keyHint(_binding, label) {
  return String(label);
}

export function getSelectListTheme() {
  const identity = (value) => String(value);
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
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible));
    const end = Math.min(start + this.maxVisible, this.items.length);
    const output = [];
    for (let index = start; index < end; index += 1) {
      const item = this.items[index];
      const prefix = index === this.selectedIndex ? "> " : "  ";
      output.push(truncateToWidth(prefix + (item.label ?? item.value), width, "", true));
    }
    return output;
  }

  handleInput(data) {
    if (matchesKey(data, "up")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      this.onSelectionChange?.(this.items[this.selectedIndex]);
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      this.onSelectionChange?.(this.items[this.selectedIndex]);
      return;
    }
    if (matchesKey(data, "enter")) {
      const item = this.items[this.selectedIndex];
      if (item) this.onSelect?.(item);
      return;
    }
    if (matchesKey(data, "escape") || data === "\x03") this.onCancel?.();
  }
}

export class Editor {
  constructor(_tui, _theme, _options = {}) {
    this.value = "";
    this.focused = false;
    this.onSubmit = undefined;
    this.onChange = undefined;
  }

  getText() { return this.value; }
  getExpandedText() { return this.value; }
  setText(value) { this.value = String(value ?? ""); }
  invalidate() {}
  render(width) { return wrapTextWithAnsi(`> ${this.value}`, width).map((line) => truncateToWidth(line, width, "", true)); }

  handleInput(data) {
    if (matchesKey(data, "enter")) {
      this.onSubmit?.(this.value);
      return;
    }
    if (data === "\x1b[13;2u") {
      this.value += "\n";
      this.onChange?.(this.value);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.value = this.value.slice(0, -1);
      this.onChange?.(this.value);
      return;
    }
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      this.value += data.slice(6, -6);
      this.onChange?.(this.value);
      return;
    }
    if (data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b")) {
      this.value += data;
      this.onChange?.(this.value);
    }
  }
}

export class Container {
  constructor() { this.children = []; }
  addChild(child) { this.children.push(child); }
  clear() { this.children = []; }
  invalidate() { for (const child of this.children) child.invalidate?.(); }
  render(width) { return this.children.flatMap((child) => child.render(width)); }
}

export class Text {
  constructor(text = "") { this.text = text; }
  setText(text) { this.text = String(text); }
  invalidate() {}
  render(width) { return wrapTextWithAnsi(this.text, width).map((line) => truncateToWidth(line, width, "")); }
}
