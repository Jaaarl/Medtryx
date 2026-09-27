import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function restrictWindowsAcl(target: string, directory: boolean): void {
  const identity = execFileSync("whoami.exe", [], { encoding: "utf8" }).trim();
  const permissions = directory ? "(OI)(CI)F" : "F";
  execFileSync(
    "icacls.exe",
    [
      resolve(target),
      "/inheritance:r",
      "/grant:r",
      `${identity}:${permissions}`,
      `*S-1-5-18:${permissions}`,
      `*S-1-5-32-544:${permissions}`,
    ],
    { stdio: "ignore" },
  );
}

export function restrictDirectory(path: string): void {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") restrictWindowsAcl(absolute, true);
  else chmodSync(absolute, 0o700);
}

export function restrictFile(path: string): void {
  const absolute = resolve(path);
  if (process.platform === "win32") restrictWindowsAcl(absolute, false);
  else chmodSync(absolute, 0o600);
}
