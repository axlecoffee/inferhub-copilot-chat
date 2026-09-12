// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { INFERHUB_VENDOR, type ProviderVendor } from "./providerTypes";

export interface BaseModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ModelMetadataFields {
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  reasoning?: boolean;
  status?: string;
}

export interface CachedModelMetadataSnapshot {
  fetchedAt: number;
  providers: Record<ProviderVendor, Record<string, ModelMetadataFields>>;
}

export interface ResolvedModelMetadata extends BaseModelLimits {
  supportsVision: boolean;
  reasoning: boolean;
  status?: string;
  source: "models.dev" | "live" | "fallback" | "default";
}

export interface ModelListEntry {
  id?: string;
  status?: string;
  deprecated?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  context_window?: number;
  contextWindow?: number;
  input_token_limit?: number;
  max_output_tokens?: number;
  maxOutputTokens?: number;
  attachment?: boolean;
  image_input?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  upstream_label?: string;
  modality?: string;
  reasoning_levels?: string[];
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

export interface ModelsDevModelRecord {
  status?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  attachment?: boolean;
  reasoning?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

interface ModelsDevProviderRecord {
  models?: Record<string, ModelsDevModelRecord>;
}

export interface ModelsDevResponse {
  meta?: ModelsDevProviderRecord;
}

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODEL_METADATA_REVISION = "session-2026-09-11-inferhub";
export const MODEL_METADATA_CACHE_KEY = "inferhub.modelMetadataCache.v1";
export const MODEL_METADATA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const DEFAULT_MODEL_LIMITS: BaseModelLimits = {
  contextWindow: 1048576,
  maxOutputTokens: 65536,
};

const MODELS_DEV_PROVIDER_BY_VENDOR: Record<ProviderVendor, keyof ModelsDevResponse> = {
  [INFERHUB_VENDOR]: "meta",
};

const MODEL_LIMITS_BY_PROVIDER: Record<ProviderVendor, Record<string, BaseModelLimits>> = {
  [INFERHUB_VENDOR]: {
    "muse-spark-1.1": { contextWindow: 1048576, maxOutputTokens: 1048576 },
    "muse-spark-1.2": { contextWindow: 1048576, maxOutputTokens: 1048576 },
    "muse-spark-1.2-contributor": { contextWindow: 1048576, maxOutputTokens: 1048576 },
    "cmc/meta/muse-spark-1.2": { contextWindow: 1048576, maxOutputTokens: 65536 },
    "cmc/meta/muse-spark-1.2-contributor": { contextWindow: 1048576, maxOutputTokens: 65536 },
    "cmc/meta/muse-spark-1.3": { contextWindow: 1048576, maxOutputTokens: 65536 },
    "cmc/meta/muse-spark-1.3-contributor": { contextWindow: 1048576, maxOutputTokens: 65536 },
  },
};

const VISION_CAPABLE_MODELS = new Set<string>([
  "muse-spark-1.1",
  "muse-spark-1.2",
  "muse-spark-1.2-contributor",
  "cmc/meta/muse-spark-1.2",
  "cmc/meta/muse-spark-1.2-contributor",
  "cmc/meta/muse-spark-1.3",
  "cmc/meta/muse-spark-1.3-contributor",
]);

export function isFreshModelMetadata(
  snapshot: CachedModelMetadataSnapshot,
): boolean {
  return Date.now() - snapshot.fetchedAt < MODEL_METADATA_CACHE_TTL_MS;
}

export function toEffectiveModelId(
  modelId: string,
  vendor: ProviderVendor,
): string {
  return `${vendor}:${modelId}::${MODEL_METADATA_REVISION}`;
}

export function bundledModelMetadataSnapshot(): CachedModelMetadataSnapshot {
  return {
    fetchedAt: 0,
    providers: {
      [INFERHUB_VENDOR]: bundledModelMetadataForProvider(INFERHUB_VENDOR),
    },
  };
}

export function fallbackModelMetadata(
  modelId: string,
  vendor: ProviderVendor,
): ModelMetadataFields | undefined {
  const limits = MODEL_LIMITS_BY_PROVIDER[vendor][modelId];
  const supportsVision = VISION_CAPABLE_MODELS.has(modelId);
  const status = undefined;

  if (!limits && !supportsVision && !status && !supportsReasoning(modelId)) {
    return undefined;
  }

  return {
    contextWindow: limits?.contextWindow,
    maxOutputTokens: limits?.maxOutputTokens,
    supportsVision: supportsVision || undefined,
    reasoning: supportsReasoning(modelId) || undefined,
    status,
  };
}

export function normalizeModelsDevSnapshot(
  data: ModelsDevResponse,
): CachedModelMetadataSnapshot {
  return {
    fetchedAt: Date.now(),
    providers: {
      [INFERHUB_VENDOR]: normalizeModelsDevProvider(
        data[MODELS_DEV_PROVIDER_BY_VENDOR[INFERHUB_VENDOR]]?.models ?? {},
      ),
    },
  };
}

export function normalizeLiveModelMetadata(
  model: ModelListEntry,
): ModelMetadataFields | undefined {
  return normalizeModelMetadataFields({
    contextWindow: positiveNumber(
      model.contextWindow ??
        model.context_window ??
        model.input_token_limit ??
        model.limit?.context,
    ),
    maxOutputTokens: positiveNumber(
      model.maxOutputTokens ?? model.max_output_tokens ?? model.limit?.output,
    ),
    supportsVision: detectVisionSupport(
      model.modalities,
      model.imageInput ?? model.image_input ?? model.attachment,
      model.modality,
    ),
    reasoning:
      typeof model.reasoning === "boolean"
        ? model.reasoning
        : Array.isArray(model.reasoning_levels) && model.reasoning_levels.length > 0
          ? true
          : undefined,
    status: model.deprecated
      ? "deprecated"
      : typeof model.status === "string"
        ? model.status
        : undefined,
  });
}

export function resolveModelMetadata(
  modelId: string,
  vendor: ProviderVendor,
  snapshot: CachedModelMetadataSnapshot,
  liveModelMetadataById: Map<string, ModelMetadataFields>,
): ResolvedModelMetadata {
  const cachedMetadata = snapshot.providers[vendor][modelId];
  const liveMetadata = liveModelMetadataById.get(modelId);
  const fallbackMetadata = fallbackModelMetadata(modelId, vendor);

  return {
    contextWindow:
      liveMetadata?.contextWindow ??
      cachedMetadata?.contextWindow ??
      fallbackMetadata?.contextWindow ??
      DEFAULT_MODEL_LIMITS.contextWindow,
    maxOutputTokens:
      liveMetadata?.maxOutputTokens ??
      cachedMetadata?.maxOutputTokens ??
      fallbackMetadata?.maxOutputTokens ??
      DEFAULT_MODEL_LIMITS.maxOutputTokens,
    supportsVision:
      liveMetadata?.supportsVision ??
      cachedMetadata?.supportsVision ??
      fallbackMetadata?.supportsVision ??
      false,
    reasoning:
      liveMetadata?.reasoning ??
      cachedMetadata?.reasoning ??
      fallbackMetadata?.reasoning ??
      supportsReasoning(modelId),
    status:
      liveMetadata?.status ??
      cachedMetadata?.status ??
      fallbackMetadata?.status,
    source: liveMetadata
      ? "live"
      : cachedMetadata
        ? "models.dev"
        : fallbackMetadata
          ? "fallback"
          : "default",
  };
}

export function hasExplicitModelLimits(
  modelId: string,
  vendor: ProviderVendor,
): boolean {
  return Boolean(fallbackModelMetadata(modelId, vendor));
}

function bundledModelMetadataForProvider(
  vendor: ProviderVendor,
): Record<string, ModelMetadataFields> {
  return Object.fromEntries(
    Object.keys(MODEL_LIMITS_BY_PROVIDER[vendor]).flatMap((modelId) => {
      const metadata = fallbackModelMetadata(modelId, vendor);
      return metadata ? [[modelId, metadata] as const] : [];
    }),
  );
}

function normalizeModelsDevProvider(
  models: Record<string, ModelsDevModelRecord>,
): Record<string, ModelMetadataFields> {
  const normalized: Record<string, ModelMetadataFields> = {};

  for (const [modelId, model] of Object.entries(models)) {
    const metadata = normalizeModelMetadataFields({
      contextWindow: positiveNumber(model.limit?.context),
      maxOutputTokens: positiveNumber(model.limit?.output),
      supportsVision: detectVisionSupport(model.modalities, model.attachment),
      reasoning:
        typeof model.reasoning === "boolean" ? model.reasoning : undefined,
      status: typeof model.status === "string" ? model.status : undefined,
    });

    if (metadata) {
      normalized[modelId] = metadata;
    }
  }

  return normalized;
}

function normalizeModelMetadataFields(
  metadata: ModelMetadataFields,
): ModelMetadataFields | undefined {
  if (
    metadata.contextWindow === undefined &&
    metadata.maxOutputTokens === undefined &&
    metadata.supportsVision === undefined &&
    metadata.reasoning === undefined &&
    metadata.status === undefined
  ) {
    return undefined;
  }
  return metadata;
}

function detectVisionSupport(
  modalities: { input?: string[]; output?: string[] } | undefined,
  attachmentHint: boolean | undefined,
  modalityString?: string,
): boolean | undefined {
  // InferHub /v1/models advertises "text" or "text,image"
  if (typeof modalityString === "string" && modalityString.length > 0) {
    return modalityString
      .split(",")
      .some((part) => part.trim() !== "" && part.trim() !== "text");
  }
  const inputModalities = Array.isArray(modalities?.input)
    ? modalities.input
    : undefined;
  if (inputModalities?.length) {
    return inputModalities.some((modality) => modality !== "text");
  }
  return typeof attachmentHint === "boolean" ? attachmentHint : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function supportsReasoning(modelId: string): boolean {
  return /muse-spark/i.test(modelId);
}
