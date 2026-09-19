import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Lines drawn below the footer, separated from it by one blank line. Pi's
 * dock ends at the footer, so content that must sit under it cannot use a
 * `belowEditor` widget — it renders through this slot instead.
 *
 * An empty array means the provider has nothing to show: no separator is
 * drawn and no line is reserved. `width` and `terminalRows` are both at
 * least 1, clamped by the footer before it calls in.
 */
export type FooterTrailer =
  | ((theme: Theme, width: number, terminalRows: number) => string[])
  | {
    render(theme: Theme, width: number, terminalRows: number): string[];
    /**
     * Pi drops cached lines on a theme change by walking `invalidate()` into
     * every mounted component, and the footer forwards that reach here. A
     * producer that caches its lines must implement this or it will keep
     * rendering the previous theme indefinitely.
     */
    invalidate?(): void;
  };

let trailer: FooterTrailer | undefined;
let requestRender: (() => void) | undefined;

/**
 * One slot rather than a keyed map: the subagent roster is the only
 * producer. A later registration replaces the current one, and releasing a
 * replaced provider is inert.
 */
export function setFooterTrailer(provider: FooterTrailer): () => void {
  trailer = provider;
  return () => {
    if (trailer === provider) trailer = undefined;
  };
}

export function renderFooterTrailer(theme: Theme, width: number, terminalRows: number): string[] {
  if (trailer === undefined) return [];
  try {
    return typeof trailer === "function"
      ? trailer(theme, width, terminalRows)
      : trailer.render(theme, width, terminalRows);
  } catch {
    // The footer's own rows are the session's resident status band: an
    // optional trailer's defect drops that trailer alone, never the model,
    // usage, context, and branch the footer carries.
    return [];
  }
}

/** Footer-owned: forwards Pi's component invalidation to the registered producer. */
export function invalidateFooterTrailer(): void {
  if (trailer === undefined || typeof trailer === "function") return;
  try {
    trailer.invalidate?.();
  } catch {
    // Contained like a render defect: the footer's own rows are unaffected.
  }
}

/**
 * Producers register before any footer exists — the extension registers
 * subagents ahead of the footer and both act on session start — so a render
 * request is a no-op until a footer mounts, and again once it is disposed.
 */
export function requestFooterRender(): void {
  requestRender?.();
}

/**
 * Footer-owned: binds the mounted footer's repaint and returns the unbind.
 * Identity-checked like the trailer release, so a footer disposed after its
 * successor mounted cannot silence the live one.
 */
export function bindFooterRender(request: () => void): () => void {
  requestRender = request;
  return () => {
    if (requestRender === request) requestRender = undefined;
  };
}
