import { EncryptedPDFError, PDFDocument } from "@cantoo/pdf-lib";
import { MAX_PDF_BYTES, PdfInputError } from "../../core/pdf-input";

export {
  MAX_PDF_BYTES,
  PdfInputError,
  readPdfInput,
  resolvePdfInput,
  resolvePdfPath,
} from "../../core/pdf-input";
export type {
  PdfFileIdentity,
  PdfInputErrorCode,
  ResolvedPdfInput,
  ResolvedPdfPath,
} from "../../core/pdf-input";

export interface LoadedPdf {
  document: PDFDocument;
  totalPages: number;
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
      throw new PdfInputError("PDF_TOO_LARGE", "Selected pages produce a PDF larger than the 50 MB request limit");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfInputError("INVALID_PDF", `Unable to copy selected PDF pages: ${reason}`);
  }
}
