const ESCAPE = "\u001b";

interface CsiSequence {
  final?: string;
  parameters: string;
  nextIndex: number;
}

function readCsi(value: string, startIndex: number): CsiSequence {
  for (let index = startIndex; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        final: value[index],
        parameters: value.slice(startIndex, index),
        nextIndex: index + 1,
      };
    }
  }
  return { parameters: value.slice(startIndex), nextIndex: value.length };
}

function skipEscapeSequence(value: string, startIndex: number): number {
  let index = startIndex;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x2f) break;
    index += 1;
  }
  if (index < value.length) {
    const final = value.charCodeAt(index);
    if (final >= 0x30 && final <= 0x7e) return index + 1;
  }
  return index > startIndex ? value.length : startIndex;
}

function skipControlString(value: string, startIndex: number, allowBell: boolean): number {
  for (let index = startIndex; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((allowBell && code === 0x07) || code === 0x9c) return index + 1;
    if (value[index] === ESCAPE && value[index + 1] === "\\") return index + 2;
  }
  return value.length;
}

function eraseLine(line: string[], cursor: number, parameters: string): void {
  const field = parameters.split(";", 1)[0] ?? "";
  const mode = field === "" ? 0 : Number.parseInt(field, 10);
  if (mode === 0) {
    line.length = Math.min(cursor, line.length);
    return;
  }
  if (mode === 1) {
    const end = Math.min(cursor + 1, line.length);
    for (let index = 0; index < end; index += 1) line[index] = " ";
    return;
  }
  if (mode === 2 || mode === 3) line.length = 0;
}

export function projectTerminalOutput(value: unknown, maxChars = Number.POSITIVE_INFINITY): string {
  const input = String(value ?? "");
  const completed: string[] = [];
  let line: string[] = [];
  let cursor = 0;

  const write = (character: string) => {
    while (line.length < cursor) line.push(" ");
    line[cursor] = character;
    cursor += 1;
  };

  for (let index = 0; index < input.length;) {
    const codePoint = input.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const nextIndex = index + character.length;

    if (character === "\n") {
      completed.push(line.join(""), "\n");
      line = [];
      cursor = 0;
      index = nextIndex;
      continue;
    }
    if (character === "\r") {
      cursor = 0;
      index = nextIndex;
      continue;
    }
    if (character === "\b") {
      cursor = Math.max(0, cursor - 1);
      index = nextIndex;
      continue;
    }
    if (character === ESCAPE) {
      const introducer = input[nextIndex];
      if (introducer === "[") {
        const sequence = readCsi(input, nextIndex + 1);
        if (sequence.final === "K") eraseLine(line, cursor, sequence.parameters);
        index = sequence.nextIndex;
        continue;
      }
      if (introducer === "]") {
        index = skipControlString(input, nextIndex + 1, true);
        continue;
      }
      if (introducer === "P" || introducer === "X" || introducer === "^" || introducer === "_") {
        index = skipControlString(input, nextIndex + 1, false);
        continue;
      }
      index = introducer === undefined ? input.length : skipEscapeSequence(input, nextIndex);
      continue;
    }
    if (codePoint === 0x9b) {
      const sequence = readCsi(input, nextIndex);
      if (sequence.final === "K") eraseLine(line, cursor, sequence.parameters);
      index = sequence.nextIndex;
      continue;
    }
    if (codePoint === 0x9d) {
      index = skipControlString(input, nextIndex, true);
      continue;
    }
    if (codePoint === 0x90 || codePoint === 0x98 || codePoint === 0x9e || codePoint === 0x9f) {
      index = skipControlString(input, nextIndex, false);
      continue;
    }
    if ((codePoint < 0x20 && codePoint !== 0x09) || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      index = nextIndex;
      continue;
    }

    write(character);
    index = nextIndex;
  }

  const projected = completed.join("") + line.join("");
  const limit = Number.isSafeInteger(maxChars) && maxChars >= 0 ? maxChars : Number.POSITIVE_INFINITY;
  return Number.isFinite(limit) ? projected.slice(0, limit) : projected;
}
