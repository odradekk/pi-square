import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { EncryptedPDFError, PDFDocument } from "@cantoo/pdf-lib";

export const MAX_PDF_BYTES = 50_000_000;

export type PdfInputErrorCode =
  | "INVALID_PDF_PATH"
  | "PDF_OUTSIDE_WORKSPACE"
  | "PDF_NOT_A_FILE"
  | "UNSUPPORTED_FILE_TYPE"
  | "PDF_TOO_LARGE"
  | "INVALID_PDF"
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

export interface ResolvedPdfInput {
  absolutePath: string;
  displayPath: string;
  bytes: Uint8Array;
}

export interface LoadedPdf {
  document: PDFDocument;
  totalPages: number;
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

export function resolvePdfInput(cwd: string, requestedPath: string): ResolvedPdfInput {
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

  let size: number;
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) throw new PdfInputError("PDF_NOT_A_FILE", "PDF path must identify a regular file");
    size = stats.size;
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfInputError("INVALID_PDF_PATH", `Unable to inspect PDF file: ${reason}`);
  }

  if (extname(absolutePath).toLowerCase() !== ".pdf") {
    throw new PdfInputError("UNSUPPORTED_FILE_TYPE", "parse accepts PDF files only; path must end in .pdf");
  }
  if (size > MAX_PDF_BYTES) {
    throw new PdfInputError("PDF_TOO_LARGE", "PDF exceeds Firecrawl's 50 MB per-request limit");
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(absolutePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfInputError("INVALID_PDF_PATH", `Unable to read PDF file: ${reason}`);
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfInputError("PDF_TOO_LARGE", "PDF exceeds Firecrawl's 50 MB per-request limit");
  }
  if (!hasPdfHeader(bytes)) {
    throw new PdfInputError("INVALID_PDF", "File does not contain a PDF header in its first 1024 bytes");
  }

  return {
    absolutePath,
    displayPath: relative(workspaceRoot, absolutePath).split(sep).join("/"),
    bytes,
  };
}

export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (document.isEncrypted) {
      throw new PdfInputError("ENCRYPTED_PDF", "Encrypted or password-protected PDFs are not supported");
    }
    const totalPages = document.getPageCount();
    if (totalPages < 1) throw new PdfInputError("INVALID_PDF", "PDF does not contain any pages");
    return { document, totalPages };
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    if (error instanceof EncryptedPDFError) {
      throw new PdfInputError("ENCRYPTED_PDF", "Encrypted or password-protected PDFs are not supported");
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfInputError("INVALID_PDF", `Unable to parse PDF structure: ${reason}`);
  }
}

export async function extractPdfPages(source: PDFDocument, pages: readonly number[]): Promise<Uint8Array> {
  try {
    const output = await PDFDocument.create({ updateMetadata: false });
    const copied = await output.copyPages(source, pages.map((page) => page - 1));
    for (const page of copied) output.addPage(page);
    const bytes = await output.save();
    if (bytes.byteLength > MAX_PDF_BYTES) {
      throw new PdfInputError("PDF_TOO_LARGE", "Selected pages produce a PDF larger than Firecrawl's 50 MB per-request limit");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfInputError("INVALID_PDF", `Unable to copy selected PDF pages: ${reason}`);
  }
}
