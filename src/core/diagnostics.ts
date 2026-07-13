export type DiagnosticLevel = "info" | "warning" | "error";

export interface DiagnosticMessage {
  level: DiagnosticLevel;
  message: string;
}

export function diagnostic(level: DiagnosticLevel, message: string): DiagnosticMessage {
  return { level, message };
}

export function emitDiagnostics(ctx: any, diagnostics: readonly DiagnosticMessage[]): void {
  if (!ctx?.hasUI || typeof ctx.ui?.notify !== "function") return;
  for (const item of diagnostics) {
    ctx.ui.notify(item.message, item.level);
  }
}
