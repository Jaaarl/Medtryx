import type { User } from "@medtryx/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly responseBody?: Record<string, unknown>,
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
      [key: string]: unknown;
    };
    throw new ApiError(response.status, body.error ?? "request_failed", body);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function postEventStream<T>(
  path: string,
  body: unknown,
  onProgress: (step: number) => void,
): Promise<T> {
  if (!csrfToken) await refreshCsrf();
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken ?? "",
    },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login")
      authExpiredHandler?.();
    const responseBody = (await response.json().catch(() => ({}))) as {
      error?: string;
      [key: string]: unknown;
    };
    throw new ApiError(
      response.status,
      responseBody.error ?? "request_failed",
      responseBody,
    );
  }
  if (!response.body) throw new ApiError(502, "receipt_stream_incomplete");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result: T | undefined;
  const consumeEvent = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n")) as unknown;
    } catch {
      throw new ApiError(502, "receipt_stream_invalid");
    }
    if (typeof payload !== "object" || payload === null)
      throw new ApiError(502, "receipt_stream_invalid");
    const message = payload as Record<string, unknown>;
    if (event === "progress") {
      if (typeof message.step !== "number" || !Number.isInteger(message.step))
        throw new ApiError(502, "receipt_stream_invalid");
      onProgress(message.step);
    } else if (event === "complete") {
      result = payload as T;
    } else if (event === "error") {
      const code =
        typeof message.error === "string"
          ? message.error
          : "receipt_processing_failed";
      throw new ApiError(502, code, { error: code });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const events = pending.split(/\r?\n\r?\n/u);
      pending = events.pop() ?? "";
      for (const event of events) consumeEvent(event);
      if (done) break;
    }
    if (pending.trim()) consumeEvent(pending);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "receipt_stream_incomplete");
  }
  if (result === undefined)
    throw new ApiError(502, "receipt_stream_incomplete");
  return result;
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
  postEventStream<T>(
    path: string,
    body: unknown,
    onProgress: (step: number) => void,
  ): Promise<T> {
    return postEventStream<T>(path, body, onProgress);
  },
  postCsv<T>(path: string, csv: string): Promise<T> {
    return request(path, {
      method: "POST",
      body: csv,
      headers: { "content-type": "text/csv" },
    });
  },
  patch<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  },
  put<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  },
};

export type CurrentUserResponse = { user: User };
