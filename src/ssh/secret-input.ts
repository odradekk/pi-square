import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  type Component,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { SSH_INPUT_MAX_CHARS } from "./contracts";

function sanitize(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 500);
}

function pad(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

class SecretInputComponent implements Component {
  private value = Buffer.alloc(0);
  private finished = false;

  constructor(
    private readonly purpose: string,
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (value: Buffer | undefined) => void,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const lines = [this.theme.fg("toolTitle", this.theme.bold("SSH secret input"))];
    for (const line of wrapTextWithAnsi(this.theme.fg("muted", this.purpose), safeWidth)) lines.push(line);
    lines.push("");
    const available = Math.max(1, safeWidth - 2);
    const visibleCount = Math.min(this.value.length, available);
    const hiddenPrefix = this.value.length > visibleCount ? this.theme.fg("dim", "<") : "";
    lines.push(`${hiddenPrefix}${"*".repeat(visibleCount)}${CURSOR_MARKER}`);
    lines.push("");
    lines.push(this.theme.fg("dim", "enter send once · esc cancel"));
    return lines.map((line) => pad(line, safeWidth));
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.input.submit") || data === "\n") {
      this.finish(Buffer.from(this.value));
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.removeLastCharacter();
      this.tui.requestRender();
      return;
    }

    const decoded = decodeKittyPrintable(data);
    const input = decoded ?? data.replace(/\x1b\[200~|\x1b\[201~/g, "");
    if ([...input].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    })) return;
    const chunk = Buffer.from(input, "utf8");
    if (this.value.length + chunk.length > SSH_INPUT_MAX_CHARS) return;
    this.value = Buffer.concat([this.value, chunk]);
    chunk.fill(0);
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    this.value.fill(0);
    this.value = Buffer.alloc(0);
  }

  private removeLastCharacter(): void {
    if (this.value.length === 0) return;
    const characters = Array.from(this.value.toString("utf8"));
    characters.pop();
    this.value.fill(0);
    this.value = Buffer.from(characters.join(""), "utf8");
    characters.fill("");
  }

  private finish(value: Buffer | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.value.fill(0);
    this.value = Buffer.alloc(0);
    this.done(value);
  }
}

export async function promptSecret(
  ui: ExtensionUIContext,
  purpose: string,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  if (signal?.aborted) return undefined;
  let close: ((value: Buffer | undefined) => void) | undefined;
  const onAbort = () => close?.(undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await ui.custom<Buffer | undefined>((tui, theme, keybindings, done) => {
      close = done;
      if (signal?.aborted) done(undefined);
      return new SecretInputComponent(sanitize(purpose) || "Enter a secret for the selected SSH session", tui, theme, keybindings, done);
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
