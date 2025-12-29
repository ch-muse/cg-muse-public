import type {
  ApiErrorPayload,
  ApiResponse,
  Idea,
  LikedIdea,
  LlmModel,
  ComfyStatus,
  ComfyStatusResponse,
  GalleryItem,
  Lora,
  PromptBlocks,
  Recipe,
  RecipeLoraLink,
  RecipeTarget,
  Session,
  SessionEvent,
  SessionSummary,
  WhisperModel,
  WhisperJobSummary,
  WhisperJobDetail
} from "../types.js";

const DEFAULT_BASE_URL = "http://localhost:4010";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

export class ApiClientError extends Error {
  readonly status: number;
  readonly info?: ApiErrorPayload | null;

  constructor(message: string, status: number, info?: ApiErrorPayload | null) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.info = info ?? null;
  }
}

type JsonMap = Record<string, unknown>;

type RecipeInputBase = {
  title?: string;
  target: RecipeTarget;
  variables?: Record<string, unknown>;
  tags?: string[];
  pinned?: boolean;
};

type CreateRecipePayload =
  | (RecipeInputBase & { promptBlocks: PromptBlocks; sourceIdeaId?: never })
  | (RecipeInputBase & { sourceIdeaId: string; promptBlocks?: undefined });

type UpdateRecipePayload = Partial<RecipeInputBase & { promptBlocks: PromptBlocks; sourceIdeaId: string | null }>;

const buildUrl = (path: string) => {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalized}`;
};

const buildHeaders = (init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  const body = init?.body;
  if (body !== undefined && !headers.has("Content-Type")) {
    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    if (isFormData) return headers;
    headers.set("Content-Type", "application/json");
  }
  return headers;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path), {
      ...init,
      headers: buildHeaders(init),
      cache: "no-store"
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    throw new ApiClientError(err instanceof Error ? err.message : "Network request failed", 0, null);
  }

  const text = await response.text();
  let json: ApiResponse<T> | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as ApiResponse<T>;
    } catch (err) {
      // ignore parse errors and treat as invalid response below
    }
  }

  if (!response.ok) {
    throw new ApiClientError(
      json?.error?.message || `Request failed with status ${response.status}`,
      response.status,
      json?.error ?? null
    );
  }

  if (!json) {
    throw new ApiClientError("Invalid API response", response.status, null);
  }

  if (!json.ok) {
    throw new ApiClientError(json.error?.message || "Request failed", response.status, json.error ?? null);
  }

  return json.data;
}

const jsonBody = (payload: JsonMap) => JSON.stringify(payload);

type GalleryListParams = {
  cursor?: string;
  limit?: number;
  ckpt?: string;
  lora?: string | string[];
  w?: number;
  h?: number;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  favorited?: boolean;
};

const buildGalleryQuery = (params?: GalleryListParams) => {
  const qs = new URLSearchParams();
  if (!params) return "";
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.ckpt) qs.set("ckpt", params.ckpt);
  if (params.lora) {
    const value = Array.isArray(params.lora) ? params.lora.join(",") : params.lora;
    if (value) qs.set("lora", value);
  }
  if (params.w !== undefined) qs.set("w", String(params.w));
  if (params.h !== undefined) qs.set("h", String(params.h));
  if (params.dateFrom) qs.set("dateFrom", params.dateFrom);
  if (params.dateTo) qs.set("dateTo", params.dateTo);
  if (params.q) qs.set("q", params.q);
  if (params.favorited !== undefined) qs.set("favorited", String(params.favorited));
  return qs.toString();
};

export const api = {
  getModels: () => request<{ models: LlmModel[] }>("/api/llm/models"),
  createSession: (payload: { title?: string; llmModel: string }) =>
    request<{ session: Session }>("/api/sessions", {
      method: "POST",
      body: jsonBody({ mode: "MUSE", ...payload })
    }),
  fetchSession: (id: string) => request<{ session: Session; ideas: Idea[]; events: SessionEvent[] }>(`/api/sessions/${id}`),
  fetchSessions: () => request<{ sessions: SessionSummary[] }>("/api/sessions"),
  generateIdeas: (payload: { sessionId: string; theme?: string; count: number }, options?: { signal?: AbortSignal }) =>
    request<{ ideas: Idea[]; requestId: string }>("/api/muse/generate", {
      method: "POST",
      body: jsonBody(payload),
      signal: options?.signal
    }),
  toggleIdeaLike: (ideaId: string, liked: boolean) =>
    request<{ idea: Idea }>(`/api/ideas/${ideaId}/like`, {
      method: "POST",
      body: jsonBody({ liked })
    }),
  deleteIdea: (ideaId: string) =>
    request<{ id: string }>(`/api/ideas/${ideaId}`, {
      method: "DELETE"
    }),
  fetchLikedIdeas: (params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    qs.set("liked", "true");
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    const path = `/api/ideas?${qs.toString()}`;
    return request<{ ideas: LikedIdea[] }>(path);
  },
  clearSessionEvents: (sessionId: string) =>
    request<{ deleted: number }>(`/api/sessions/${sessionId}/events`, {
      method: "DELETE"
    }),
  deleteSession: (sessionId: string) =>
    request<{ id: string }>(`/api/sessions/${sessionId}`, {
      method: "DELETE"
    }),
  updateSession: (id: string, payload: { title?: string; llmModel?: string }) =>
    request<{ session: Session }>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: jsonBody(payload)
    }),
  fetchLoras: () => request<{ loras: Lora[] }>("/api/loras"),
  fetchLora: (id: string) => request<{ lora: Lora }>(`/api/loras/${id}`),
  createLora: (payload: {
    name: string;
    fileName?: string | null;
    triggerWords?: string[];
    recommendedWeightMin?: number | null;
    recommendedWeightMax?: number | null;
    notes?: string | null;
    tags?: string[];
    examplePrompts?: string[];
  }) =>
    request<{ lora: Lora }>("/api/loras", {
      method: "POST",
      body: jsonBody(payload)
    }),
  updateLora: (
    id: string,
    payload: Partial<{
      name: string;
      fileName: string | null;
      triggerWords: string[];
      recommendedWeightMin: number | null;
      recommendedWeightMax: number | null;
      notes: string | null;
      tags: string[];
      examplePrompts: string[];
    }>
  ) =>
    request<{ lora: Lora }>(`/api/loras/${id}`, {
      method: "PATCH",
      body: jsonBody(payload)
    }),
  uploadLoraThumbnail: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ thumbnailKey: string; url: string; lora: Lora }>(`/api/loras/${id}/thumbnail`, {
      method: "POST",
      body: form
    });
  },
  deleteLora: (id: string) =>
    request<{ id: string }>(`/api/loras/${id}`, {
      method: "DELETE"
    }),
  fetchRecipes: () => request<{ recipes: Recipe[] }>("/api/recipes"),
  fetchRecipe: (id: string) => request<{ recipe: Recipe; loras: RecipeLoraLink[] }>(`/api/recipes/${id}`),
  createRecipe: (payload: CreateRecipePayload) =>
    request<{ recipe: Recipe }>("/api/recipes", {
      method: "POST",
      body: jsonBody(payload as JsonMap)
    }),
  updateRecipe: (id: string, payload: UpdateRecipePayload) =>
    request<{ recipe: Recipe }>(`/api/recipes/${id}`, {
      method: "PATCH",
      body: jsonBody(payload as JsonMap)
    }),
  deleteRecipe: (id: string) =>
    request<{ id: string }>(`/api/recipes/${id}`, {
      method: "DELETE"
    }),
  uploadRecipeThumbnail: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ thumbnailKey: string; url: string; recipe: Recipe }>(`/api/recipes/${id}/thumbnail`, {
      method: "POST",
      body: form
    });
  },
  upsertRecipeLora: (
    recipeId: string,
    payload: { loraId: string; weight?: number | null; usageNotes?: string | null; sortOrder?: number }
  ) =>
    request<{ lora: RecipeLoraLink }>(`/api/recipes/${recipeId}/loras`, {
      method: "POST",
      body: jsonBody(payload as JsonMap)
    }),
  deleteRecipeLora: (recipeId: string, loraId: string) =>
    request<{ recipeId: string; loraId: string }>(`/api/recipes/${recipeId}/loras/${loraId}`, {
      method: "DELETE"
    }),
  runComfyTagger: (file: File, options?: { signal?: AbortSignal }) => {
    const form = new FormData();
    form.append("image", file);
    return request<{ tags: string }>("/api/comfy/tagger", {
      method: "POST",
      body: form,
      signal: options?.signal
    });
  },
  getComfyStatus: () => request<{ status: ComfyStatus }>("/api/comfy/status"),
  startComfy: () => request<ComfyStatusResponse>("/api/comfy/start", { method: "POST" }),
  stopComfy: () => request<ComfyStatusResponse>("/api/comfy/stop", { method: "POST" }),
  getWhisperModels: (options?: { signal?: AbortSignal }) =>
    request<{ models: WhisperModel[]; defaultLanguage: string }>("/api/whisper/models", {
      signal: options?.signal
    }),
  createWhisperJob: (
    payload: { file: File; modelFile: string; language?: string },
    options?: { signal?: AbortSignal }
  ) => {
    const form = new FormData();
    form.append("file", payload.file);
    form.append("modelFile", payload.modelFile);
    if (payload.language) {
      form.append("language", payload.language);
    }
    return request<{ jobId: string; job: WhisperJobSummary }>("/api/whisper/jobs", {
      method: "POST",
      body: form,
      signal: options?.signal
    });
  },
  fetchWhisperJobs: (options?: { signal?: AbortSignal }) =>
    request<{ jobs: WhisperJobSummary[] }>("/api/whisper/jobs", { signal: options?.signal }),
  fetchWhisperJob: (id: string, options?: { signal?: AbortSignal }) =>
    request<{ job: WhisperJobDetail }>(`/api/whisper/jobs/${id}`, { signal: options?.signal }),
  cancelWhisperJob: (id: string) =>
    request<{ job: WhisperJobDetail }>(`/api/whisper/jobs/${id}/cancel`, { method: "POST" }),
  deleteWhisperJob: (id: string) =>
    request<{ deleted: boolean; id: string }>(`/api/whisper/jobs/${id}`, { method: "DELETE" }),
  fetchGalleryItems: (params?: GalleryListParams, options?: { signal?: AbortSignal }) => {
    const qs = buildGalleryQuery(params);
    const path = qs ? `/api/gallery/items?${qs}` : "/api/gallery/items";
    return request<{ items: GalleryItem[]; nextCursor?: string | null }>(path, { signal: options?.signal });
  },
  fetchGalleryItem: (id: string, options?: { signal?: AbortSignal }) =>
    request<{ item: GalleryItem }>(`/api/gallery/items/${id}`, { signal: options?.signal }),
  toggleGalleryFavorite: (id: string, favorite?: boolean) =>
    request<{ item: GalleryItem }>(`/api/gallery/items/${id}/favorite`, {
      method: "POST",
      body: jsonBody({ ...(favorite !== undefined ? { favorite } : {}) })
    }),
  updateGalleryItem: (
    id: string,
    payload: Partial<{
      manualCkptName: string | null;
      manualLoraNames: string[] | null;
      manualPositive: string | null;
      manualNegative: string | null;
      manualWidth: number | null;
      manualHeight: number | null;
      manualTags: string[] | null;
      manualNotes: string | null;
    }>,
    options?: { signal?: AbortSignal }
  ) =>
    request<{ item: GalleryItem }>(`/api/gallery/items/${id}`, {
      method: "PATCH",
      body: jsonBody(payload as JsonMap),
      signal: options?.signal
    }),
  extractGalleryItem: (id: string, options?: { signal?: AbortSignal }) =>
    request<{ item: GalleryItem }>(`/api/gallery/items/${id}/extract`, {
      method: "POST",
      signal: options?.signal
    }),
  deleteGalleryItem: (id: string, options?: { signal?: AbortSignal }) =>
    request<{ id: string }>(`/api/gallery/items/${id}`, {
      method: "DELETE",
      signal: options?.signal
    })
};

export type ApiClient = typeof api;
export { API_BASE_URL };
