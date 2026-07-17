import { StringDecoder } from "node:string_decoder";
import { SSH_MODEL_OUTPUT_CHARS, SSH_SESSION_BUFFER_BYTES, type SshOutputPage } from "./contracts";

export class SshOutputBuffer {
  private readonly decoder = new StringDecoder("utf8");
  private text = "";
  private startCursor = 0;
  private endCursor = 0;
  private droppedChars = 0;

  constructor(
    private readonly maxBytes = SSH_SESSION_BUFFER_BYTES,
    private readonly pageChars = SSH_MODEL_OUTPUT_CHARS,
  ) {}

  append(chunk: Buffer | string): void {
    const decoded = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (!decoded) return;
    this.text += decoded;
    this.endCursor += decoded.length;
    this.trim();
  }

  end(): void {
    const remaining = this.decoder.end();
    if (remaining) this.append(remaining);
  }

  get oldestCursor(): number {
    return this.startCursor;
  }

  get newestCursor(): number {
    return this.endCursor;
  }

  read(requestedCursor = this.startCursor): SshOutputPage {
    const normalized = Number.isSafeInteger(requestedCursor) && requestedCursor >= 0
      ? requestedCursor
      : this.startCursor;
    const cursorExpired = normalized < this.startCursor;
    const cursor = Math.min(Math.max(normalized, this.startCursor), this.endCursor);
    const offset = cursor - this.startCursor;
    const available = this.text.slice(offset);
    const text = available.slice(0, this.pageChars);
    const nextCursor = cursor + text.length;
    return {
      text,
      requestedCursor: normalized,
      cursor,
      nextCursor,
      oldestCursor: this.startCursor,
      newestCursor: this.endCursor,
      cursorExpired,
      hasMore: nextCursor < this.endCursor,
      droppedChars: this.droppedChars,
    };
  }

  private trim(): void {
    let bytes = Buffer.byteLength(this.text, "utf8");
    if (bytes <= this.maxBytes) return;
    let cut = 0;
    for (const character of this.text) {
      if (bytes <= this.maxBytes) break;
      bytes -= Buffer.byteLength(character, "utf8");
      cut += character.length;
    }
    this.text = this.text.slice(cut);
    this.startCursor += cut;
    this.droppedChars += cut;
  }
}
