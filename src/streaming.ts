// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import {
  buildInferhubRequestError,
  formatDuration,
  formatRateLimitSummary,
  InferHubRequestError,
  readRateLimitInfo,
  truncateForLog,
} from "./errors";
import { createUsageDataParts } from "./chatParts";
import {
  clearContextWindowRequest,
  reportProgressWithContextWindowRequest,
  reportUsageToContextWindowForRequest,
  setContextWindowOutputBufferForRequest,
} from "./contextWindowHookBridge";
import { formatUsageLogLine } from "./usage";

export interface StreamRequestOptions {
  url: string;
  providerDisplayName: string;
  apiKey: string;
  modelId: string;
  body: unknown;
  requestHeaders: Record<string, string>;
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>;
  token: vscode.CancellationToken;
  output?: vscode.OutputChannel;
  debugReasoning: boolean;
  debugTransport: boolean;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  contextWindowOutputBuffer?: number;
  authHeaders?: Record<string, string>;
  onReasoningContent?: (toolCallIds: string[], reasoningContent: string) => void;
  onTransportSummary?: (summary: TransportRequestSummary) => void;
}

export interface TransportRequestSummary {
  providerDisplayName: string;
  modelId: string;
  url: string;
  requestId?: string;
  sessionId?: string;
  status?: number;
  contentType?: string;
  payloadBytes: number;
  totalBytes: number;
  totalEvents: number;
  durationMs: number;
  ttfbMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  finishReason?: string;
  rateLimitSummary?: string;
  abortedReason?: "request-timeout" | "stream-idle-timeout" | "cancelled";
  errorMessage?: string;
}

export async function streamChatCompletions(
  options: StreamRequestOptions,
): Promise<void> {
  const extractor = new ResponsesExtractor(
    options.onReasoningContent,
    createReasoningDebugger(options.output, options.debugReasoning),
  );

  await streamInferhubResponse({
    ...options,
    extractStreamParts: (data) => extractor.extractStreamParts(data),
    extractFullParts: (data) => extractor.extractFullParts(data),
  });

  extractor.flushReasoningFallback(
    options.progress,
    options.requestHeaders["x-inferhub-request"],
  );
  if (options.debugTransport) {
    options.output?.appendLine(
      `[stream-summary model=${options.modelId}] textChars=${extractor.emittedText} toolCalls=${extractor.emittedTools} reasoningChars=${extractor.reasoningChars}`,
    );
  }
  if (extractor.emittedText === 0 && extractor.emittedTools === 0) {
    options.output?.appendLine(
      `[warn] empty response from model=${options.modelId} (no text, no tool calls, no reasoning).`,
    );
    options.output?.show(true);
  }
}

export const streamResponses = streamChatCompletions;

interface StreamInferhubResponseOptions extends StreamRequestOptions {
  extractStreamParts: (data: unknown) => vscode.LanguageModelResponsePart[];
  extractFullParts: (data: unknown) => vscode.LanguageModelResponsePart[];
  maxRetries?: number;
}

interface RequestUsageSummary {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  finishReason?: string;
  rateLimitSummary?: string;
  abortedReason?: "request-timeout" | "stream-idle-timeout" | "cancelled";
  errorMessage?: string;
}

function reportProgressPart(
  localRequestId: string | undefined,
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
  part: vscode.LanguageModelResponsePart2,
): void {
  if (!localRequestId) {
    progress.report(part);
    return;
  }

  reportProgressWithContextWindowRequest(localRequestId, progress, part);
}

const CONNECTION_TIMEOUT_MS = 60_000;
const FIRST_EVENT_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 2;

async function streamInferhubResponse(
  options: StreamInferhubResponseOptions,
): Promise<void> {
  const maxAttempts = (options.maxRetries ?? MAX_RETRIES) + 1;
  let lastError: unknown;
  let body = options.body;
  let didPrune = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.token.isCancellationRequested) {
      return;
    }

    try {
      await streamInferhubResponseAttempt({ ...options, body }, attempt);
      return;
    } catch (error) {
      lastError = error;

      if (options.token.isCancellationRequested) {
        throw error;
      }

      if (
        attempt < maxAttempts - 1
        && isTransientConnectionError(error)
      ) {
        const delayMs = 1000 * (attempt + 1);
        options.output?.appendLine(
          `[retry] attempt ${attempt + 1}/${maxAttempts} failed with transient error, retrying in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (
        attempt < maxAttempts - 1
        && isEmptyStreamTimeout(error)
        && !didPrune
      ) {
        body = pruneRequestBody(body);
        didPrune = true;
        const delayMs = 2000;
        const prunedLabel = body === options.body ? "(body unchanged)" : "(body pruned)";
        options.output?.appendLine(
          `[retry] attempt ${attempt + 1}/${maxAttempts} failed with empty stream, retrying ${prunedLabel} in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

function isTransientConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("econnrefused")
    || message.includes("econnreset")
    || message.includes("enotfound")
    || message.includes("etimedout")
    || message.includes("socket hang up")
    || message.includes("network error")
    || message.includes("fetch failed")
    || message.includes("und_err_connect")
    || (error instanceof TypeError && message.includes("fetch"))
  );
}

function isEmptyStreamTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("stream stalled")
    || message.includes("stream idle")
    || message.includes("timed out after") && message.includes("during streaming phase")
  );
}

function pruneRequestBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;

  const obj: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  let changed = false;

  if (Array.isArray(obj.messages) && obj.messages.length > 3) {
    const msgs = [...obj.messages];
    const systemMsg = msgs.find(
      (m) => typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "system",
    );
    const nonSystem = msgs.filter(
      (m) => typeof m !== "object" || m === null || (m as Record<string, unknown>).role !== "system",
    );
    const keepCount = Math.max(3, Math.ceil(nonSystem.length / 2));
    if (keepCount < nonSystem.length) {
      obj.messages = systemMsg ? [systemMsg, ...nonSystem.slice(-keepCount)] : nonSystem.slice(-keepCount);
      changed = true;
    }
  }

  if (Array.isArray(obj.contents) && obj.contents.length > 3) {
    const keepCount = Math.max(3, Math.ceil(obj.contents.length / 2));
    if (keepCount < obj.contents.length) {
      obj.contents = obj.contents.slice(-keepCount);
      changed = true;
    }
  }

  if (Array.isArray(obj.input) && obj.input.length > 3) {
    const keepCount = Math.max(3, Math.ceil(obj.input.length / 2));
    if (keepCount < obj.input.length) {
      obj.input = obj.input.slice(-keepCount);
      changed = true;
    }
  }

  return changed ? obj : body;
}

async function streamInferhubResponseAttempt(
  options: StreamInferhubResponseOptions,
  attempt: number,
): Promise<void> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const localRequestId = options.requestHeaders["x-inferhub-request"];
  let firstByteAt: number | undefined;
  const usageSummary: RequestUsageSummary = {};
  let abortReason:
    | "request-timeout"
    | "stream-idle-timeout"
    | "cancelled"
    | undefined;
  let responseStatus: number | undefined;
  let responseContentType: string | undefined;
  let emittedSummary = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let firstEventTimeout: ReturnType<typeof setTimeout> | undefined;
  const abort = (reason: typeof abortReason) => {
    abortReason ??= reason;
    controller.abort();
    if (reader) {
      reader.cancel().catch(() => { /* ignore cancel errors */ });
    }
  };
  const cancellation = options.token.onCancellationRequested(() =>
    abort("cancelled"),
  );
  const connectionTimeout = setTimeout(
    () => {
      if (firstByteAt === undefined) {
        abort("request-timeout");
      }
    },
    Math.min(CONNECTION_TIMEOUT_MS, options.requestTimeoutMs),
  );
  const requestTimeout = setTimeout(
    () => abort("request-timeout"),
    options.requestTimeoutMs,
  );
  let streamIdleTimeout: ReturnType<typeof setTimeout> | undefined;
  const resetStreamIdleTimeout = () => {
    if (streamIdleTimeout) {
      clearTimeout(streamIdleTimeout);
    }
    streamIdleTimeout = setTimeout(
      () => abort("stream-idle-timeout"),
      options.streamIdleTimeoutMs,
    );
  };
  const emitSummary = (
    totalBytes: number,
    totalEvents: number,
    extra?: Partial<TransportRequestSummary>,
  ) => {
    if (emittedSummary) {
      return;
    }
    emittedSummary = true;
    const summary: TransportRequestSummary = {
      providerDisplayName: options.providerDisplayName,
      modelId: options.modelId,
      url: options.url,
      requestId: options.requestHeaders["x-inferhub-request"],
      sessionId: options.requestHeaders["x-inferhub-session"],
      status: responseStatus,
      contentType: responseContentType,
      payloadBytes:
        typeof options.body === "string"
          ? options.body.length
          : new TextEncoder().encode(JSON.stringify(options.body)).byteLength,
      totalBytes,
      totalEvents,
      durationMs: Date.now() - startedAt,
      ...(firstByteAt === undefined ? {} : { ttfbMs: firstByteAt - startedAt }),
      ...(usageSummary.promptTokens === undefined
        ? {}
        : { promptTokens: usageSummary.promptTokens }),
      ...(usageSummary.completionTokens === undefined
        ? {}
        : { completionTokens: usageSummary.completionTokens }),
      ...(usageSummary.totalTokens === undefined
        ? {}
        : { totalTokens: usageSummary.totalTokens }),
      ...(usageSummary.cachedTokens === undefined
        ? {}
        : { cachedTokens: usageSummary.cachedTokens }),
      ...(usageSummary.costUsd === undefined
        ? {}
        : { costUsd: usageSummary.costUsd }),
      ...(usageSummary.finishReason === undefined
        ? {}
        : { finishReason: usageSummary.finishReason }),
      ...extra,
    };

    if (options.debugTransport) {
      options.output?.appendLine(
        `[response-summary] status=${summary.status ?? "n/a"} durationMs=${summary.durationMs} ttfbMs=${summary.ttfbMs ?? "n/a"} promptTokens=${summary.promptTokens ?? "n/a"} completionTokens=${summary.completionTokens ?? "n/a"} totalTokens=${summary.totalTokens ?? "n/a"} cachedTokens=${summary.cachedTokens ?? "n/a"} costUsd=${summary.costUsd ?? "n/a"} finishReason=${summary.finishReason ?? "<unknown>"} totalBytes=${summary.totalBytes} totalEvents=${summary.totalEvents}`,
      );
    }
    const usageLog = formatUsageLogLine({
      promptTokens: summary.promptTokens,
      completionTokens: summary.completionTokens,
      totalTokens: summary.totalTokens,
      cachedTokens: summary.cachedTokens,
      finishReason: summary.finishReason,
    });
    if (options.debugTransport && usageLog) {
      options.output?.appendLine(`[usage] ${usageLog}`);
    }
    options.onTransportSummary?.(summary);

    if (localRequestId) {
      reportUsageToContextWindowForRequest(localRequestId, {
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        totalTokens: summary.totalTokens,
        cachedTokens: summary.cachedTokens,
        finishReason: summary.finishReason,
      });
    }

    const usageParts =
      summary.errorMessage || summary.abortedReason
        ? []
        : createUsageDataParts({
            promptTokens: summary.promptTokens,
            completionTokens: summary.completionTokens,
            totalTokens: summary.totalTokens,
            cachedTokens: summary.cachedTokens,
            finishReason: summary.finishReason,
          });
    for (const usagePart of usageParts) {
      reportProgressPart(localRequestId, options.progress, usagePart);
    }
  };

  try {
    if (localRequestId && options.contextWindowOutputBuffer !== undefined) {
      setContextWindowOutputBufferForRequest(
        localRequestId,
        options.contextWindowOutputBuffer,
      );
    }

    const payload = JSON.stringify(options.body);
    if (options.debugTransport) {
      const attemptLabel = attempt > 0 ? ` attempt=${attempt + 1}` : "";
      options.output?.appendLine(
        `[request] url=${options.url} payloadBytes=${payload.length} requestTimeoutMs=${options.requestTimeoutMs} streamIdleTimeoutMs=${options.streamIdleTimeoutMs} connectionTimeoutMs=${CONNECTION_TIMEOUT_MS}${attemptLabel}`,
      );
    }
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        ...(options.authHeaders ?? { Authorization: `Bearer ${options.apiKey}` }),
        "Content-Type": "application/json",
        ...options.requestHeaders,
      },
      body: payload,
      signal: controller.signal,
    });

    responseStatus = response.status;
    responseContentType = response.headers.get("content-type") ?? "";
    clearTimeout(connectionTimeout);
    firstByteAt ??= Date.now();
    if (options.debugTransport) {
      options.output?.appendLine(
        `[http] ${response.status} ${response.statusText} content-type=${responseContentType || "<none>"}`,
      );
    }
    const rateLimitSummary = formatRateLimitSummary(
      readRateLimitInfo(response.headers),
    );
    if (options.debugTransport && rateLimitSummary) {
      options.output?.appendLine(`[rate-limit] ${rateLimitSummary}`);
    }

    if (!response.ok) {
      const detail = await response.text();
      if (options.debugTransport) {
        options.output?.appendLine(
          `[http-error-body] ${detail.trim() ? truncateForLog(detail) : "<empty>"}`,
        );
      }
      const requestError = buildInferhubRequestError(
        options.providerDisplayName,
        response,
        detail,
        options.modelId,
        payload.length,
        "",
      );
      emitSummary(new TextEncoder().encode(detail).byteLength, 0, {
        errorMessage: requestError.message,
        rateLimitSummary,
      });
      throw requestError;
    }

    if (!response.body || !responseContentType.includes("text/event-stream")) {
      const raw = await response.text();
      firstByteAt ??= Date.now();
      if (options.debugTransport) {
        options.output?.appendLine(`[non-stream-body] ${truncateForLog(raw)}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = undefined;
      }
      if (data !== undefined) {
        updateRequestUsageSummary(usageSummary, data);
        for (const part of options.extractFullParts(data)) {
          reportProgressPart(localRequestId, options.progress, part);
        }
      }
      emitSummary(new TextEncoder().encode(raw).byteLength, data === undefined ? 0 : 1, {
        rateLimitSummary,
      });
      return;
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let totalEvents = 0;
    let receivedFirstEvent = false;
    resetStreamIdleTimeout();
    firstEventTimeout = setTimeout(
      () => abort("stream-idle-timeout"),
      FIRST_EVENT_TIMEOUT_MS,
    );

    while (!options.token.isCancellationRequested) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      resetStreamIdleTimeout();

      totalBytes += value?.byteLength ?? 0;
      if (firstByteAt === undefined && (value?.byteLength ?? 0) > 0) {
        firstByteAt = Date.now();
      }
      if (!receivedFirstEvent) {
        receivedFirstEvent = true;
        clearTimeout(firstEventTimeout);
      }
      const chunk = decoder.decode(value, { stream: true });
      if (options.debugReasoning && options.output && chunk) {
        options.output.appendLine(
          `[sse-raw bytes=${value?.byteLength ?? 0}] ${truncateForLog(chunk)}`,
        );
      }
      buffer += chunk;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        totalEvents += 1;
        if (options.debugReasoning && options.output && event.trim()) {
          options.output.appendLine(`[sse] ${truncateForLog(event)}`);
        }
        for (const part of parseServerSentEvent(
          event,
          options.extractStreamParts,
          (data) => updateRequestUsageSummary(usageSummary, data),
        )) {
          reportProgressPart(localRequestId, options.progress, part);
        }
      }
    }

    if (buffer.trim()) {
      if (options.debugReasoning && options.output) {
        options.output.appendLine(`[sse-tail] ${truncateForLog(buffer)}`);
      }
      for (const part of parseServerSentEvent(
        buffer,
        options.extractStreamParts,
        (data) => updateRequestUsageSummary(usageSummary, data),
      )) {
        reportProgressPart(localRequestId, options.progress, part);
      }
    }

    if (options.debugTransport) {
      options.output?.appendLine(
        `[sse-stats] totalBytes=${totalBytes} totalEvents=${totalEvents} bufferTailLen=${buffer.length}`,
      );
    }
    emitSummary(totalBytes, totalEvents, { rateLimitSummary });
  } catch (error) {
    if (abortReason === "cancelled") {
      emitSummary(0, 0, {
        abortedReason: "cancelled",
        errorMessage: "request cancelled",
      });
      return;
    }
    if (abortReason === "request-timeout") {
      const elapsed = Date.now() - startedAt;
      const phase = firstByteAt === undefined ? "connection" : "streaming";
      const requestError = new InferHubRequestError(
        `${options.providerDisplayName} request timed out after ${formatDuration(elapsed)} (during ${phase} phase).`,
        firstByteAt === undefined
          ? `${options.providerDisplayName} did not respond within ${formatDuration(CONNECTION_TIMEOUT_MS)}. The server may be temporarily unavailable. Try again in a moment or switch to a different model.`
          : `${options.providerDisplayName} started responding but timed out after ${formatDuration(options.requestTimeoutMs)}.`,
      );
      emitSummary(0, 0, {
        abortedReason: "request-timeout",
        errorMessage: requestError.message,
      });
      throw requestError;
    }
    if (abortReason === "stream-idle-timeout") {
      const requestError = new InferHubRequestError(
        `${options.providerDisplayName} stream stalled for ${formatDuration(options.streamIdleTimeoutMs)} without new data.`,
        `${options.providerDisplayName} stopped sending stream data for ${formatDuration(options.streamIdleTimeoutMs)}, so the request was cancelled.`,
      );
      emitSummary(0, 0, {
        abortedReason: "stream-idle-timeout",
        errorMessage: requestError.message,
      });
      throw requestError;
    }
    emitSummary(0, 0, {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(connectionTimeout);
    clearTimeout(requestTimeout);
    if (streamIdleTimeout) {
      clearTimeout(streamIdleTimeout);
    }
    if (firstEventTimeout) {
      clearTimeout(firstEventTimeout);
    }
    cancellation.dispose();
    if (localRequestId) {
      clearContextWindowRequest(localRequestId);
    }
  }
}

function parseServerSentEvent(
  event: string,
  extractParts: (data: unknown) => vscode.LanguageModelResponsePart[],
  onData?: (data: unknown) => void,
): vscode.LanguageModelResponsePart[] {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  const parts: vscode.LanguageModelResponsePart[] = [];

  for (const line of lines) {
    if (!line || line === "[DONE]") {
      continue;
    }

    try {
      const data = JSON.parse(line) as unknown;
      onData?.(data);
      parts.push(...extractParts(data));
    } catch {
    }
  }

  return parts;
}

function createReasoningDebugger(
  output: vscode.OutputChannel | undefined,
  enabled: boolean,
): ((reasoningContent: string) => void) | undefined {
  if (!enabled || !output) {
    return undefined;
  }

  return (reasoningContent) => {
    output.appendLine("[reasoning_content]");
    output.appendLine(reasoningContent);
    output.appendLine("[/reasoning_content]");
  };
}

interface PendingToolCall {
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

class ResponsesExtractor {
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private reasoningSummary = "";
  private emittedTextLength = 0;
  private emittedToolCallsCount = 0;
  private reasoningCharsInternal = 0;

  constructor(
    private readonly onReasoningContent?: (
      toolCallIds: string[],
      reasoningContent: string,
    ) => void,
    private readonly onReasoningDebug?: (reasoningContent: string) => void,
  ) {}

  get emittedText(): number {
    return this.emittedTextLength;
  }

  get emittedTools(): number {
    return this.emittedToolCallsCount;
  }

  get reasoningChars(): number {
    return this.reasoningCharsInternal;
  }

  extractStreamParts(data: unknown): vscode.LanguageModelResponsePart[] {
    if (!isRecord(data)) {
      return [];
    }

    const type = typeof data.type === "string" ? data.type : "";

    if (type === "response.output_text.delta") {
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (delta) {
        this.emittedTextLength += delta.length;
        return [new vscode.LanguageModelTextPart(delta)];
      }
      return [];
    }

    if (type === "response.reasoning_summary_text.delta") {
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (delta) {
        this.reasoningSummary += delta;
        this.reasoningCharsInternal += delta.length;
        this.onReasoningDebug?.(delta);
        return [new vscode.LanguageModelThinkingPart(delta) as unknown as vscode.LanguageModelResponsePart];
      }
      return [];
    }

    if (type === "response.output_item.added") {
      const item = isRecord(data.item) ? data.item : undefined;
      if (item && item.type === "function_call") {
        const id = typeof item.id === "string" ? item.id : "";
        const callId = typeof item.call_id === "string" ? item.call_id : id;
        const name = typeof item.name === "string" ? item.name : "";
        const args = typeof item.arguments === "string" ? item.arguments : "";
        if (id) {
          this.pendingToolCalls.set(id, { id, callId, name, arguments: args });
        }
      }
      return [];
    }

    if (type === "response.function_call_arguments.delta") {
      const delta = typeof data.delta === "string" ? data.delta : "";
      const itemId = typeof data.item_id === "string" ? data.item_id : "";
      if (delta && itemId) {
        const pending = this.pendingToolCalls.get(itemId);
        if (pending) {
          pending.arguments += delta;
        } else {
          this.pendingToolCalls.set(itemId, { id: itemId, callId: "", name: "", arguments: delta });
        }
      }
      return [];
    }

    if (type === "response.function_call_arguments.done") {
      const args = typeof data.arguments === "string" ? data.arguments : "";
      const itemId = typeof data.item_id === "string" ? data.item_id : "";
      const name = typeof data.name === "string" ? data.name : "";
      if (itemId) {
        const pending = this.pendingToolCalls.get(itemId);
        if (pending) {
          if (args) pending.arguments = args;
          if (name) pending.name = name;
        } else {
          this.pendingToolCalls.set(itemId, { id: itemId, callId: "", name, arguments: args });
        }
      }
      return [];
    }

    if (type === "response.output_item.done") {
      const item = isRecord(data.item) ? data.item : undefined;
      if (item && item.type === "function_call") {
        const id = typeof item.id === "string" ? item.id : "";
        const callId = typeof item.call_id === "string" ? item.call_id : id;
        const name = typeof item.name === "string" ? item.name : "";
        const args = typeof item.arguments === "string" ? item.arguments : "";
        let pending = id ? this.pendingToolCalls.get(id) : undefined;
        if (!pending && id) {
          pending = { id, callId, name, arguments: args };
          this.pendingToolCalls.set(id, pending);
        }
        if (pending) {
          if (name) pending.name = name;
          if (args) pending.arguments = args;
          if (callId) pending.callId = callId;
          if (pending.name) {
            const toolPart = new vscode.LanguageModelToolCallPart(
              pending.callId || pending.id || `inferhub-tool-${Date.now()}`,
              pending.name,
              parseToolInput(pending.arguments),
            );
            this.emittedToolCallsCount += 1;
            if (this.reasoningSummary.trim()) {
              this.onReasoningDebug?.(this.reasoningSummary);
              this.onReasoningContent?.([toolPart.callId], this.reasoningSummary);
            }
            this.pendingToolCalls.delete(id);
            this.reasoningSummary = "";
            return [toolPart as unknown as vscode.LanguageModelResponsePart];
          }
        } else if (name) {
          const toolPart = new vscode.LanguageModelToolCallPart(
            callId || id || `inferhub-tool-${Date.now()}`,
            name,
            parseToolInput(args),
          );
          this.emittedToolCallsCount += 1;
          return [toolPart as unknown as vscode.LanguageModelResponsePart];
        }
      }
      return [];
    }

    if (type === "response.reasoning_summary_text.done") {
      return [];
    }

    if (type === "response.content_part.done" || type === "response.content_part.added") {
      return [];
    }

    return [];
  }

  extractFullParts(data: unknown): vscode.LanguageModelResponsePart[] {
    if (!isRecord(data)) {
      return [];
    }

    const response = isRecord(data.response) ? data.response : data;
    if (!isRecord(response) || !Array.isArray(response.output)) {
      if (Array.isArray((data as Record<string, unknown>).choices)) {
        return extractChatCompletionParts(data);
      }
      return [];
    }

    const parts: vscode.LanguageModelResponsePart[] = [];
    const output = response.output as unknown[];

    for (const item of output) {
      if (!isRecord(item)) continue;
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const content of item.content as unknown[]) {
          if (!isRecord(content)) continue;
          if (content.type === "output_text" && typeof content.text === "string" && content.text) {
            this.emittedTextLength += content.text.length;
            parts.push(new vscode.LanguageModelTextPart(content.text));
          }
        }
      } else if (item.type === "function_call") {
        const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `inferhub-tool-${Date.now()}`;
        const name = typeof item.name === "string" ? item.name : "";
        const args = typeof item.arguments === "string" ? item.arguments : "{}";
        if (name) {
          this.emittedToolCallsCount += 1;
          parts.push(new vscode.LanguageModelToolCallPart(id, name, parseToolInput(args)));
        }
      } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
        const summaryParts = item.summary as unknown[];
        let summaryText = "";
        for (const s of summaryParts) {
          if (isRecord(s) && typeof s.text === "string") summaryText += s.text;
          else if (typeof s === "string") summaryText += s;
        }
        if (summaryText.trim()) {
          this.reasoningCharsInternal += summaryText.length;
          this.onReasoningDebug?.(summaryText);
          parts.push(new vscode.LanguageModelThinkingPart(summaryText) as unknown as vscode.LanguageModelResponsePart);
        }
      }
    }

    return parts;
  }

  flushReasoningFallback(
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    localRequestId?: string,
  ): void {
    const reasoning = this.reasoningSummary.trim();
    if (!reasoning) {
      return;
    }
    if (this.emittedTextLength > 0 || this.emittedToolCallsCount > 0) {
      this.reasoningSummary = "";
      return;
    }
    this.onReasoningDebug?.(this.reasoningSummary);
    reportProgressPart(
      localRequestId,
      progress,
      new vscode.LanguageModelThinkingPart(reasoning) as unknown as vscode.LanguageModelResponsePart,
    );
    this.emittedTextLength += reasoning.length;
    this.reasoningSummary = "";
  }
}

function extractChatCompletionParts(
  data: unknown,
): vscode.LanguageModelResponsePart[] {
  if (!isRecord(data) || !Array.isArray(data.choices)) {
    return [];
  }

  const first = data.choices[0];
  if (!isRecord(first)) {
    return [];
  }

  const parts: vscode.LanguageModelResponsePart[] = [];
  const message = first.message;
  if (isRecord(message)) {
    const text = extractTextFromDelta(message);
    if (text) {
      parts.push(new vscode.LanguageModelTextPart(text));
    } else {
      const reasoning = extractReasoningFromDelta(message);
      if (reasoning.trim()) {
        parts.push(new vscode.LanguageModelTextPart(reasoning));
      }
    }
    for (const toolCallPart of toolCallPartsFromOpenAiMessage(
      message.tool_calls,
    )) {
      parts.push(toolCallPart);
    }
  }

  if (typeof first.text === "string") {
    parts.push(new vscode.LanguageModelTextPart(first.text));
  }

  return parts;
}

function extractTextFromDelta(delta: Record<string, unknown>): string {
  const candidates: unknown[] = [delta.content, delta.text, delta.output_text];
  let collected = "";
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      collected += candidate;
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const part of candidate) {
        if (typeof part === "string") {
          collected += part;
        } else if (isRecord(part)) {
          const text = part.text ?? part.value ?? part.output_text;
          if (typeof text === "string") {
            collected += text;
          }
        }
      }
    }
  }
  return collected;
}

function extractReasoningFromDelta(delta: Record<string, unknown>): string {
  const candidates: unknown[] = [
    delta.reasoning_content,
    delta.reasoning,
    delta.thinking,
    isRecord(delta.message)
      ? (delta.message as Record<string, unknown>).reasoning_content
      : undefined,
  ];
  let collected = "";
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      collected += candidate;
    } else if (isRecord(candidate) && typeof candidate.content === "string") {
      collected += candidate.content;
    } else if (Array.isArray(candidate)) {
      for (const part of candidate) {
        if (typeof part === "string") {
          collected += part;
        } else if (isRecord(part) && typeof part.text === "string") {
          collected += part.text;
        }
      }
    }
  }
  return collected;
}

function toolCallPartsFromOpenAiMessage(
  toolCalls: unknown,
): vscode.LanguageModelToolCallPart[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .filter(isRecord)
    .map((toolCall, index) => {
      const fn = toolCall.function;
      const id =
        typeof toolCall.id === "string"
          ? toolCall.id
          : `inferhub-tool-${Date.now()}-${index}`;
      const name = isRecord(fn) && typeof fn.name === "string" ? fn.name : "";
      const args =
        isRecord(fn) && typeof fn.arguments === "string" ? fn.arguments : "{}";
      return name
        ? new vscode.LanguageModelToolCallPart(id, name, parseToolInput(args))
        : undefined;
    })
    .filter(
      (part): part is vscode.LanguageModelToolCallPart => Boolean(part),
    );
}

function parseToolInput(value: string): object {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function updateRequestUsageSummary(
  summary: RequestUsageSummary,
  data: unknown,
): void {
  if (!isRecord(data)) {
    return;
  }

  let usage: Record<string, unknown> | undefined;
  if (isRecord(data.usage)) {
    usage = data.usage;
  } else if (isRecord(data.response) && isRecord((data.response as Record<string, unknown>).usage)) {
    usage = (data.response as Record<string, unknown>).usage as Record<string, unknown>;
  }

  if (usage) {
    const promptTokens =
      typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : typeof usage.input_tokens === "number"
          ? usage.input_tokens
          : undefined;
    const completionTokens =
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : undefined;
    const totalTokens =
      typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
    const promptTokenDetails = isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : isRecord(usage.input_tokens_details)
        ? usage.input_tokens_details
        : undefined;
    const cachedTokens =
      promptTokenDetails &&
      typeof (promptTokenDetails as Record<string, unknown>).cached_tokens === "number"
        ? (promptTokenDetails as Record<string, unknown>).cached_tokens as number
        : undefined;

    if (promptTokens !== undefined) {
      summary.promptTokens = promptTokens;
    }
    if (completionTokens !== undefined) {
      summary.completionTokens = completionTokens;
    }
    if (totalTokens !== undefined) {
      summary.totalTokens = totalTokens;
    }
    if (cachedTokens !== undefined) {
      summary.cachedTokens = cachedTokens;
    }
    if (typeof usage.cost === "number") {
      summary.costUsd = usage.cost;
    }
  }

  let finishReason: string | undefined;
  if (Array.isArray((data as Record<string, unknown>).choices) && isRecord(((data as Record<string, unknown>).choices as unknown[])[0])) {
    const firstChoice = ((data as Record<string, unknown>).choices as unknown[])[0] as Record<string, unknown>;
    if (typeof firstChoice.finish_reason === "string") {
      finishReason = firstChoice.finish_reason;
    } else if (typeof firstChoice.finishReason === "string") {
      finishReason = firstChoice.finishReason;
    }
  }
  if (!finishReason && isRecord(data.response) && typeof (data.response as Record<string, unknown>).status === "string") {
    finishReason = (data.response as Record<string, unknown>).status as string;
  } else if (!finishReason && typeof (data as Record<string, unknown>).status === "string") {
    finishReason = (data as Record<string, unknown>).status as string;
  }
  if (finishReason) {
    summary.finishReason = finishReason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
