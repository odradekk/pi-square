import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_PDF_BYTES = 50_000_000;

export type PdfInputErrorCode =
  | "INVALID_PDF_PATH"
  | "PDF_OUTSIDE_WORKSPACE"
  | "PDF_NOT_A_FILE"
  | "UNSUPPORTED_FILE_TYPE"
  | "PDF_TOO_LARGE"
  | "INVALID_PDF"
  | "PDF_CHANGED_DURING_READ"
  | "ENCRYPTED_PDF";

export class PdfInputError extends Error {
  constructor(
    readonly code: PdfInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfInputError";
  }
}

export interface PdfFileIdentity {
  device: string;
  inode: string;
  size: number;
  modifiedNs: string;
  changedNs: string;
}

export interface ResolvedPdfPath {
  absolutePath: string;
  displayPath: string;
  identity: PdfFileIdentity;
}

export interface ResolvedPdfInput extends ResolvedPdfPath {
  bytes: Uint8Array;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const prefix = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  const marker = new TextEncoder().encode("%PDF-");
  outer: for (let index = 0; index <= prefix.byteLength - marker.byteLength; index++) {
    for (let offset = 0; offset < marker.byteLength; offset++) {
      if (prefix[index + offset] !== marker[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function inspectPdfFile(absolutePath: string): PdfFileIdentity {
  try {
    const stats = statSync(absolutePath, { bigint: true });
    if (!stats.isFile()) throw new PdfInputError("PDF_NOT_A_FILE", "PDF path must identify a regular file");
    if (stats.size > BigInt(MAX_PDF_BYTES)) {
      throw new PdfInputError("PDF_TOO_LARGE", "PDF exceeds the 50 MB safety limit");
    }
    return {
      device: String(stats.dev),
      inode: String(stats.ino),
      size: Number(stats.size),
      modifiedNs: String(stats.mtimeNs),
      changedNs: String(stats.ctimeNs),
    };
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfInputError("INVALID_PDF_PATH", `Unable to inspect PDF file: ${reason}`);
  }
}

export function samePdfIdentity(left: PdfFileIdentity, right: PdfFileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNs === right.modifiedNs
    && left.changedNs === right.changedNs;
}

export function pdfIdentityKey(input: ResolvedPdfPath): string {
  const identity = input.identity;
  return [input.absolutePath, identity.device, identity.inode, identity.size, identity.modifiedNs, identity.changedNs].join("\0");
}

export function resolvePdfPath(cwd: string, requestedPath: string): ResolvedPdfPath {
  const trimmed = requestedPath.trim();
  if (!trimmed) throw new PdfInputError("INVALID_PDF_PATH", "path must identify a PDF file");

  let workspaceRoot: string;
  let absolutePath: string;
  try {
    workspaceRoot = realpathSync(cwd);
    absolutePath = realpathSync(resolve(workspaceRoot, trimmed));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfInputError("INVALID_PDF_PATH", `PDF path does not exist or cannot be resolved: ${reason}`);
  }

  if (!isWithin(workspaceRoot, absolutePath)) {
    throw new PdfInputError("PDF_OUTSIDE_WORKSPACE", "PDF path must stay within the current workspace, including through symlinks");
  }
  if (extname(absolutePath).toLowerCase() !== ".pdf") {
    throw new PdfInputError("UNSUPPORTED_FILE_TYPE", "Only PDF files are supported; path must end in .pdf");
  }

  return {
    absolutePath,
    displayPath: relative(workspaceRoot, absolutePath).split(sep).join("/"),
    identity: inspectPdfFile(absolutePath),
  };
}

export function readPdfInput(input: ResolvedPdfPath): ResolvedPdfInput {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(input.absolutePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfInputError("INVALID_PDF_PATH", `Unable to read PDF file: ${reason}`);
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfInputError("PDF_TOO_LARGE", "PDF exceeds the 50 MB safety limit");
  }
  if (!hasPdfHeader(bytes)) {
    throw new PdfInputError("INVALID_PDF", "File does not contain a PDF header in its first 1024 bytes");
  }

  const currentIdentity = inspectPdfFile(input.absolutePath);
  if (!samePdfIdentity(input.identity, currentIdentity)) {
    throw new PdfInputError("PDF_CHANGED_DURING_READ", "PDF changed while it was being read; retry the search");
  }
  return { ...input, bytes };
}

export function resolvePdfInput(cwd: string, requestedPath: string): ResolvedPdfInput {
  return readPdfInput(resolvePdfPath(cwd, requestedPath));
}
