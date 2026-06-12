import type {
  AuthUser,
  CreateMissionBody,
  IntentResponse,
  Mission,
  Receipt,
  SubmitReceiptBody,
} from "./types";

// Client API minimal. Le backend répond { error: 'SNAKE_CASE_CODE' } — on le
// remonte tel quel via ApiError.code. JWT en Authorization: Bearer.

const TOKEN_KEY = "waylo_token";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

async function apiFetch<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (!res.ok) {
    let code = "UNKNOWN_ERROR";
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload.error) code = payload.error;
    } catch {
      // corps non-JSON : on garde UNKNOWN_ERROR
    }
    throw new ApiError(code, res.status);
  }
  return (await res.json()) as T;
}

// --- Auth ---

export const register = (email: string, password: string) =>
  apiFetch<{ token: string }>("/auth/register", {
    method: "POST",
    body: { email, password },
  });

export const login = (email: string, password: string) =>
  apiFetch<{ token: string }>("/auth/login", {
    method: "POST",
    body: { email, password },
  });

export const me = () => apiFetch<AuthUser>("/auth/me");

// --- Missions ---

export const createMission = (body: CreateMissionBody) =>
  apiFetch<Mission>("/missions", { method: "POST", body });

export const listMyMissions = () => apiFetch<Mission[]>("/missions");

export const listAvailableMissions = () =>
  apiFetch<Mission[]>("/missions/available");

export const getMission = (id: string) => apiFetch<Mission>(`/missions/${id}`);

export const createIntent = (id: string) =>
  apiFetch<IntentResponse>(`/missions/${id}/intent`, { method: "POST" });

export const validateMission = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/validate`, { method: "POST" });

export const matchMission = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/match`, { method: "POST" });

export const startTravel = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/start-travel`, { method: "POST" });

export const submitReceipt = (id: string, body: SubmitReceiptBody) =>
  apiFetch<Receipt>(`/missions/${id}/submit-receipt`, {
    method: "POST",
    body,
  });
