export interface StatuslineConfig {
  enabled: boolean;
  shortcut: string;
}

export interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
}

export interface GitSnapshot {
  branch: string | null;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface StatuslineState {
  config: StatuslineConfig;
  enabled: boolean;
  currentModelId: string;
  currentModelName: string;
  lastUsage: UsageSnapshot | null;
  tuiRef: { requestRender: () => void } | null;
  activeShortcut: string;
  registeredShortcuts: Set<string>;
  cwd: string;
  git: GitSnapshot;
}
