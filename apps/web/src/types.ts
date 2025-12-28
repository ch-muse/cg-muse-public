export interface Session {
  id: string;
  title: string | null;
  mode: "MUSE" | string;
  llm_provider: string;
  llm_model: string;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary extends Session {
  idea_count: number;
  liked_count: number;
}

export interface Idea {
  id: string;
  session_id: string;
  title: string;
  description: string;
  prompt_snippet: string | null;
  tags: string[];
  liked: boolean;
  created_at: string;
}

export interface LikedIdea extends Idea {
  session_title: string | null;
  session_llm_model: string;
}

export type RecipeTarget = "SDXL" | "COMFYUI_BLOCKS";

export interface PromptBlocks {
  positive?: string;
  negative?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface Lora {
  id: string;
  name: string;
  trigger_words: string[];
  recommended_weight_min: number | null;
  recommended_weight_max: number | null;
  notes: string | null;
  tags: string[];
  example_prompts: string[];
  thumbnail_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface Recipe {
  id: string;
  title: string | null;
  source_idea_id: string | null;
  target: RecipeTarget;
  prompt_blocks: PromptBlocks;
  variables: Record<string, unknown>;
  tags: string[];
  pinned: boolean;
  thumbnail_key: string | null;
  created_at: string;
  updated_at: string;
  lora_count?: number;
}

export interface RecipeLoraLink {
  recipe_id: string;
  lora_id: string;
  weight: number | null;
  usage_notes: string | null;
  sort_order: number;
  lora_name: string;
  trigger_words: string[];
  recommended_weight_min: number | null;
  recommended_weight_max: number | null;
  lora_notes: string | null;
  lora_tags: string[];
  example_prompts: string[];
  lora_thumbnail_key?: string | null;
  lora_created_at: string;
  lora_updated_at: string;
}

export type SessionEventType =
  | "LLM_REQUEST"
  | "LLM_RESPONSE"
  | "IDEA_GENERATED"
  | "IDEA_LIKED_TOGGLED"
  | "IDEA_DELETED"
  | "SESSION_UPDATED"
  | "CANCELLED"
  | "ERROR"
  | string;

export interface SessionEvent {
  id: string;
  session_id: string;
  event_type: SessionEventType;
  payload: unknown;
  created_at: string;
}

export interface LlmModel {
  name: string;
  details?: unknown;
  modified_at?: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiErrorPayload {
  message: string;
  details?: unknown;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorPayload;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ComfyConfigSummary {
  listen: string;
  port: number;
  dir: string;
  python: string;
  extraArgsPresent: boolean;
}

export interface ComfyStatus {
  running: boolean;
  managed: boolean;
  pid: number | null;
  url: string;
  config: ComfyConfigSummary;
  lastError: string | null;
  timestamps: {
    lastProbeAt: string | null;
    lastStartAt: string | null;
  };
}

export interface ComfyStatusResponse {
  status: ComfyStatus;
  started?: boolean;
  stopped?: boolean;
  message?: string;
}

export interface GalleryItem {
  id: string;
  source_type: string;
  source_id: string | null;
  comfy_run_id: string | null;
  rel_path: string | null;
  prompt_id: string | null;
  filename: string;
  subfolder: string | null;
  file_type: string | null;
  width: number | null;
  height: number | null;
  ckpt_name: string | null;
  lora_names: string[] | null;
  positive: string | null;
  negative: string | null;
  extracted_ckpt_name?: string | null;
  extracted_lora_names?: string[] | null;
  extracted_positive?: string | null;
  extracted_negative?: string | null;
  extracted_width?: number | null;
  extracted_height?: number | null;
  manual_ckpt_name?: string | null;
  manual_lora_names?: string[] | null;
  manual_positive?: string | null;
  manual_negative?: string | null;
  manual_width?: number | null;
  manual_height?: number | null;
  manual_tags?: string[] | null;
  manual_notes?: string | null;
  created_at: string;
  favorited: boolean;
  meta: unknown;
  meta_extracted?: unknown;
  meta_overrides?: unknown;
  needs_review?: boolean;
  viewUrl?: string | null;
}

export type WhisperJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface WhisperModel {
  file: string;
  sizeBytes?: number;
}

export interface WhisperJobSummary {
  id: string;
  status: WhisperJobStatus;
  modelFile: string;
  language: string;
  inputOriginalName: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  errorMessage?: string | null;
  downloadUrl?: string | null;
  warnings?: string[];
}

export interface WhisperJobDetail extends WhisperJobSummary {
  transcriptText?: string | null;
}
