import type { NextFunction, Request, Response } from "express";

let restoreActive = false;
let activeMutations = 0;
let drainWaiters: Array<() => void> = [];

export function apiMaintenance(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const isRestoreRequest = req.path === "/backups/restore";
  if (restoreActive && !isRestoreRequest) {
    res.status(503).json({ error: "database_restore_in_progress" });
    return;
  }
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (isMutation && !isRestoreRequest) {
    activeMutations += 1;
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      activeMutations -= 1;
      if (activeMutations === 0) {
        const waiters = drainWaiters;
        drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    };
    res.once("finish", release);
    res.once("close", release);
  }
  next();
}

export function beginRestore(): boolean {
  if (restoreActive) return false;
  restoreActive = true;
  return true;
}

export async function waitForMutationsToDrain(): Promise<void> {
  if (activeMutations === 0) return;
  await new Promise<void>((resolve) => drainWaiters.push(resolve));
}

export function finishRestore(): void {
  restoreActive = false;
}

export function restoreIsActive(): boolean {
  return restoreActive;
}
