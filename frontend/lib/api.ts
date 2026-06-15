import type {
  AuthUser,
  CheckoutSessionResponse,
  CreateMissionBody,
  IntentResponse,
  Mission,
  Receipt,
  SubmitReceiptBody,
} from "./types";

// Client API minimal. Le backend répond { error: 'SNAKE_CASE_CODE' } — on le
// remonte tel quel via ApiError.code. JWT en Authorization: Bearer.

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

// Auth par cookie HttpOnly : aucun jeton manipulé côté JS. `credentials:
// "include"` envoie/reçoit le cookie ; un 401 déclenche UN refresh silencieux
// puis rejoue la requête.
async function apiFetch<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
  retryOn401 = true,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers,
    credentials: "include",
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (
    res.status === 401 &&
    retryOn401 &&
    path !== "/auth/refresh" &&
    path !== "/auth/login" &&
    path !== "/auth/register"
  ) {
    const refreshed = await fetch(`/api/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    if (refreshed.ok) return apiFetch<T>(path, init, false);
  }

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

export const refresh = () =>
  apiFetch<{ token: string }>("/auth/refresh", { method: "POST" });

export const logout = () =>
  apiFetch<{ ok: boolean }>("/auth/logout", { method: "POST" });

// --- Missions ---

export const createMission = (body: CreateMissionBody) =>
  apiFetch<Mission>("/missions", { method: "POST", body });

export const listMyMissions = () => apiFetch<Mission[]>("/missions");

export const listAvailableMissions = (filters?: {
  origin?: string;
  destination?: string;
}) => {
  const qs = new URLSearchParams();
  if (filters?.origin) qs.set("origin", filters.origin);
  if (filters?.destination) qs.set("destination", filters.destination);
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiFetch<Mission[]>(`/missions/available${suffix}`);
};

export const getMission = (id: string) => apiFetch<Mission>(`/missions/${id}`);

export const createIntent = (id: string) =>
  apiFetch<IntentResponse>(`/missions/${id}/intent`, { method: "POST" });

export const createCheckoutSession = (id: string) =>
  apiFetch<CheckoutSessionResponse>(`/missions/${id}/checkout-session`, {
    method: "POST",
  });

export const validateMission = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/validate`, { method: "POST" });

export const matchMission = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/match`, { method: "POST" });

export const acceptMission = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/accept`, { method: "POST" });

export const shipMission = (
  id: string,
  trackingReference: string,
  purchaseAmountCents: number,
) =>
  apiFetch<Mission>(`/missions/${id}/ship`, {
    method: "POST",
    body: { trackingReference, purchaseAmountCents },
  });

export const receiveMission = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/receive`, { method: "POST" });

export const submitCustomsReceipt = (id: string, customsReceiptUrl: string) =>
  apiFetch<Mission>(`/missions/${id}/customs-receipt`, {
    method: "POST",
    body: { customsReceiptUrl },
  });

export const startTravel = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/start-travel`, { method: "POST" });

export const submitReceipt = (id: string, body: SubmitReceiptBody) =>
  apiFetch<Receipt>(`/missions/${id}/submit-receipt`, {
    method: "POST",
    body,
  });
