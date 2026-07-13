export function isWindowsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function platformShellTool(platform: NodeJS.Platform = process.platform): "bash" | "pwsh" {
  return isWindowsPlatform(platform) ? "pwsh" : "bash";
}
