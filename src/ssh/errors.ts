export class SshError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SshError";
  }
}

export function sshErrorCode(error: unknown): string {
  return error instanceof SshError ? error.code : "SSH_ERROR";
}

export function sshErrorMessage(error: unknown): string {
  if (error instanceof SshError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
