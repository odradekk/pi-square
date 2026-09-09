/**
 * Session-owned input-surface tracking.
 *
 * Pi 0.84.2 exposes raw terminal input through one global listener but no
 * public focus query, so a global listener cannot see whether some component
 * currently owns keyboard focus. pi-square surfaces that capture input
 * (managers, wizards, secret inputs, confirmations) bracket their modal here,
 * and the subagent roster's empty-editor navigation stays inactive while any
 * of them is open. Third-party capturing overlays remain undetectable; that
 * limitation is documented with the roster navigation itself.
 *
 * The counter is process-global by design: one Pi process hosts one
 * interactive session at a time, and non-interactive contexts never install
 * the listener that consults it.
 */
let ownedInputSurfaces = 0;

export function isOwnedInputSurfaceActive(): boolean {
  return ownedInputSurfaces > 0;
}

/**
 * Runs one modal-owning action with the owned-input-surface marker held.
 * The marker releases when the action settles, even on rejection; a modal
 * whose promise never settles keeps the marker raised, which only disables
 * roster navigation.
 */
export async function withOwnedInputSurface<T>(action: () => Promise<T>): Promise<T> {
  ownedInputSurfaces += 1;
  try {
    return await action();
  } finally {
    ownedInputSurfaces = Math.max(0, ownedInputSurfaces - 1);
  }
}
