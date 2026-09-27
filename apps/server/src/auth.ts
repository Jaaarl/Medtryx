import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { UserRole } from "@medtryx/shared";

export const SESSION_COOKIE = "medtryx_session";
export const CSRF_COOKIE = "medtryx_csrf";
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

export type AuthenticatedUser = {
  id: string;
  email: string;
  role: UserRole;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedUser;
    sessionTokenHash?: string;
  }
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureCookie(): boolean {
  return process.env.COOKIE_SECURE !== "false";
}

export function issueCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: secureCookie(),
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_MS,
  });
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_MS,
  });
}

export function clearAuthCookies(res: Response): void {
  const options = {
    secure: secureCookie(),
    sameSite: "strict" as const,
    path: "/",
  };
  res.clearCookie(SESSION_COOKIE, { ...options, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}

function sameSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function requireDoubleSubmitCsrf(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get("x-csrf-token");
  if (
    typeof cookie !== "string" ||
    typeof header !== "string" ||
    !sameSecret(cookie, header)
  ) {
    res.status(403).json({ error: "csrf_validation_failed" });
    return;
  }
  next();
}

export function requireCsrf(
  db: Database.Database,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get("x-csrf-token");
  if (
    typeof cookie !== "string" ||
    typeof header !== "string" ||
    !sameSecret(cookie, header) ||
    !req.sessionTokenHash
  ) {
    res.status(403).json({ error: "csrf_validation_failed" });
    return;
  }

  const session = db
    .prepare("SELECT csrf_hash FROM sessions WHERE token_hash = ?")
    .get(req.sessionTokenHash) as { csrf_hash: string } | undefined;
  if (!session || !sameSecret(hashSecret(cookie), session.csrf_hash)) {
    res.status(403).json({ error: "csrf_validation_failed" });
    return;
  }
  next();
}

export function requireAuthentication(db: Database.Database) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawToken = req.cookies?.[SESSION_COOKIE];
    if (typeof rawToken !== "string") {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const tokenHash = hashSecret(rawToken);
    const now = Date.now();
    const session = db
      .prepare(
        `SELECT s.token_hash, s.user_id, s.last_seen_at, s.expires_at,
                u.email, u.role, u.is_active
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as
      | {
          token_hash: string;
          user_id: string;
          last_seen_at: string;
          expires_at: string;
          email: string;
          role: UserRole;
          is_active: number;
        }
      | undefined;

    const idleDeadline = session
      ? new Date(session.last_seen_at).getTime() + SESSION_IDLE_MS
      : 0;
    if (
      !session ||
      session.is_active !== 1 ||
      new Date(session.expires_at).getTime() <= now ||
      idleDeadline <= now
    ) {
      if (session)
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      clearAuthCookies(res);
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(
      new Date(now).toISOString(),
      tokenHash,
    );
    req.user = {
      id: session.user_id,
      email: session.email,
      role: session.role,
    };
    req.sessionTokenHash = tokenHash;
    next();
  };
}

export function requireRole(role: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    if (req.user.role !== role) {
      res.status(403).json({ error: "permission_denied" });
      return;
    }
    next();
  };
}
