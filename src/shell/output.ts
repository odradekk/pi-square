import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export interface ShellOutputOptions {
  maxLines?: number;
  maxBytes?: number;
  tempFilePath?: () => string;
  tempFilePrefix?: string;
}

export interface ShellOutputSnapshot {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function defaultTempFilePath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
}

export class ShellOutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly tempFilePath: () => string;
  private readonly decoder = new TextDecoder();
  private rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;
  private fullOutputPath: string | undefined;
  private stream: WriteStream | undefined;
  private streamError: Error | undefined;

  constructor(options: ShellOutputOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePath = options.tempFilePath
      ?? (() => defaultTempFilePath(options.tempFilePrefix ?? "pi-pwsh"));
  }

  append(data: Buffer | string): void {
    if (this.finished) throw new Error("Cannot append to finished shell output");
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.totalRawBytes += buffer.byteLength;
    this.appendDecoded(this.decoder.decode(buffer, { stream: true }));

    if (this.stream || this.shouldPersist()) {
      this.ensureTempFile();
      this.stream?.write(buffer);
    } else if (buffer.byteLength > 0) {
      this.rawChunks.push(Buffer.from(buffer));
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecoded(this.decoder.decode());
    if (this.shouldPersist()) this.ensureTempFile();
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): ShellOutputSnapshot {
    const tail = truncateTail(this.snapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncation: TruncationResult = {
      ...tail,
      truncated,
      truncatedBy: truncated
        ? (tail.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
        : null,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile();
    return {
      content: truncation.content,
      truncation,
      ...(this.fullOutputPath ? { fullOutputPath: this.fullOutputPath } : {}),
    };
  }

  getLastLineBytes(): number {
    return this.currentLineBytes;
  }

  async close(): Promise<void> {
    if (!this.stream) {
      if (this.streamError) throw this.streamError;
      return;
    }
    const stream = this.stream;
    this.stream = undefined;
    if (this.streamError) {
      stream.destroy();
      throw this.streamError;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
    if (this.streamError) throw this.streamError;
  }

  private appendDecoded(text: string): void {
    if (!text) return;
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

    let newlines = 0;
    let lastNewline = -1;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      newlines += 1;
      lastNewline = index;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const trailing = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(trailing);
      this.hasOpenLine = trailing.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf8");
    if (buffer.byteLength <= this.maxRollingBytes) {
      this.tailBytes = buffer.byteLength;
      return;
    }
    let start = buffer.byteLength - this.maxRollingBytes;
    while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
    this.tailStartsAtLineBoundary = start === 0
      ? this.tailStartsAtLineBoundary
      : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf8");
    this.tailBytes = byteLength(this.tailText);
  }

  private snapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldPersist(): boolean {
    return this.totalRawBytes > this.maxBytes
      || this.totalDecodedBytes > this.maxBytes
      || this.totalLines > this.maxLines;
  }

  private ensureTempFile(): void {
    if (this.fullOutputPath) return;
    this.fullOutputPath = this.tempFilePath();
    this.stream = createWriteStream(this.fullOutputPath, { mode: 0o600 });
    this.stream.on("error", (error) => {
      this.streamError = error;
    });
    for (const chunk of this.rawChunks) this.stream.write(chunk);
    this.rawChunks = [];
  }
}
