import { getPackagePath, getPackageRoot } from "../core/paths";

export { getPackageRoot };

export function getWasmDir(): string {
  return getPackagePath("wasm");
}

export function getWasmPath(filename: string): string {
  return getPackagePath("wasm", filename);
}
