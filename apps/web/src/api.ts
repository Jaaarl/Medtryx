import type { User } from "@medtryx/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

let csrfToken: string | undefined;
let authExpiredHandler: (() => void) | undefined;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function onAuthExpired(handler: (() => void) | undefined): void {
  authExpiredHandler = handler;
}

export async function refreshCsrf(): Promise<void> {
  const response = await fetch("/api/auth/csrf", {
    credentials: "same-origin",
  });
  if (!response.ok) throw new ApiError(response.status, "csrf_unavailable");
  const data = (await response.json()) as { token: string };
  setCsrfToken(data.token);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!csrfToken) await refreshCsrf();
    headers.set("x-csrf-token", csrfToken ?? "");
  }
  const response = await fetch(`/api${path}`, {
    ...init,
    method,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login")
      authExpiredHandler?.();
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ApiError(response.status, body.error ?? "request_failed");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>(path);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  },
};

export type CurrentUserResponse = { user: User };
