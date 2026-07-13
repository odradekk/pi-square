import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SoundType = "stop" | "question";

interface NotificationService {
  question(): void;
}

const soundsDir = join(dirname(fileURLToPath(import.meta.url)), "sounds");
const os = process.platform;

const systemSounds: Partial<Record<NodeJS.Platform, Partial<Record<SoundType, string>>>> = {
  darwin: {
    stop: "/System/Library/Sounds/Glass.aiff",
    question: "/System/Library/Sounds/Ping.aiff",
  },
  linux: {
    stop: "/usr/share/sounds/freedesktop/stereo/complete.oga",
    question: "/usr/share/sounds/freedesktop/stereo/dialog-information.oga",
  },
};

const windowsSounds: Record<SoundType, string> = {
  stop: "Asterisk",
  question: "Question",
};

function bell(): void {
  process.stdout.write("\x07");
}

function hasCommand(name: string): boolean {
  try {
    execFileSync(os === "win32" ? "where" : "which", [name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function fire(command: string, args: string[]): void {
  // On Windows, `detached` spawns the child with DETACHED_PROCESS (no console
  // host), so powershell exits before running PlaySync — no sound. Keep it
  // attached and hidden there. On POSIX, `detached` (setsid) is correct for the
  // background audio players.
  const options =
    os === "win32"
      ? { stdio: "ignore" as const, windowsHide: true }
      : { stdio: "ignore" as const, detached: true };
  spawn(command, args, options).unref();
}

function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function linuxPlayers(filepath: string): Array<[string, string[]]> {
  return [
    ["paplay", [filepath]],
    ["pw-play", [filepath]],
    ["aplay", [filepath]],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filepath]],
  ];
}

function playFile(filepath: string): void {
  try {
    if (os === "darwin") {
      fire("afplay", [filepath]);
      return;
    }

    if (os === "win32") {
      fire("powershell", [
        "-NoProfile",
        "-Command",
        `(New-Object System.Media.SoundPlayer '${escapePowerShellLiteral(filepath)}').PlaySync()`,
      ]);
      return;
    }

    for (const [name, args] of linuxPlayers(filepath)) {
      if (hasCommand(name)) {
        fire(name, args);
        return;
      }
    }
  } catch {
    // Fall through to terminal bell.
  }

  bell();
}

function playSystemSound(type: SoundType): void {
  try {
    if (os === "darwin") {
      const filepath = systemSounds.darwin?.[type];
      if (filepath && existsSync(filepath)) {
        fire("afplay", [filepath]);
        return;
      }
    }

    if (os === "win32") {
      fire("powershell", ["-NoProfile", "-Command", `[System.Media.SystemSounds]::${windowsSounds[type]}.Play()`]);
      return;
    }

    const filepath = systemSounds.linux?.[type];
    if (filepath && existsSync(filepath)) {
      for (const [name, args] of linuxPlayers(filepath)) {
        if (hasCommand(name)) {
          fire(name, args);
          return;
        }
      }
    }
  } catch {
    // Fall through to terminal bell.
  }

  bell();
}

function playSound(type: SoundType): void {
  const customFile = join(soundsDir, `${type}_bell.wav`);

  if (existsSync(customFile)) {
    playFile(customFile);
    return;
  }

  playSystemSound(type);
}

export default function registerNotifications(pi: ExtensionAPI): NotificationService {
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.hasUI) playSound("stop");
  });

  return {
    question: () => playSound("question"),
  };
}
