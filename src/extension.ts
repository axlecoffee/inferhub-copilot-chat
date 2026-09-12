// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import {
  InferHubRequestError,
} from "./errors";
import {
  MODEL_METADATA_CACHE_KEY,
  MODEL_METADATA_REVISION,
  MODELS_DEV_API_URL,
  bundledModelMetadataSnapshot,
  fallbackModelMetadata,
  hasExplicitModelLimits,
  isFreshModelMetadata,
  normalizeLiveModelMetadata,
  normalizeModelsDevSnapshot,
  resolveModelMetadata,
  toEffectiveModelId,
  type ModelsDevResponse,
} from "./metadata";
import {
  resolveModelRouting,
} from "./routing";
import { buildInferhubAuthHeaders } from "./inferhubAuth";
import {
  fetchUsageLogPage,
  formatUsageReport,
  type UsageRange,
} from "./inferhubUsage";
import {
  streamResponses as runStreamResponses,
  type TransportRequestSummary,
} from "./streaming";
import { INFERHUB_VENDOR } from "./providerTypes";
import { isInternalDataPart } from "./chatParts";
import {
  disposeContextWindowHookBridge,
  initializeContextWindowHookBridge,
} from "./contextWindowHookBridge";
import {
  formatCacheHitRatio,
  formatUsageStatusBarText,
  formatUsageStatusBarTooltip,
  type UsageSnapshot,
} from "./usage";

const SECRET_KEY = "inferhub.apiKey";
const RECENT_TRANSPORT_SUMMARY_LIMIT = 25;
const RECENT_TRANSPORT_SUMMARY_STORAGE_PREFIX = "inferhub.recentTransportSummaries";

let usageStatusBarItem: vscode.StatusBarItem | undefined;

interface ProviderDefinition {
  vendor: typeof INFERHUB_VENDOR;
  displayName: string;
  modelsUrl: string;
  chatCompletionsUrl: string;
  messagesUrl: string;
  responsesUrl?: string;
  categoryOrder: number;
  testModelId: string;
  fallbackModels: string[];
}

type ModelEndpointKind =
  | "chat-completions"
  | "messages"
  | "responses"
  | "google";

const KNOWN_UNAVAILABLE_MODEL_IDS = new Set<string>([]);
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90 * 1000;
const INFERHUB_CLIENT = "vscode-copilot-chat";
const INFERHUB_USER_AGENT = "inferhub-copilot-chat/0.3.0 VSCode";

const INFERHUB_BASE_URL_DEFAULT = "https://api.inferhub.dev/v1";

function getInferhubBaseUrl(): string {
  const override = vscode.workspace.getConfiguration("inferhub").get<string>("baseUrl", "");
  return override.trim() || INFERHUB_BASE_URL_DEFAULT;
}

// Upstream prefix -> display label, mirrors the InferHub dashboard model list.
const PROVIDER_LABEL_BY_PREFIX: Record<string, string> = {
  ag: "Antigravity",
  ali: "Qwencloud/Alibaba",
  cb: "CodeBuddy",
  cbcn: "CodeBuddy CN",
  cc: "Claude Code",
  cmc: "Command Code",
  cp: "ClinePass",
  cx: "OpenAI Codex",
  mimo: "Xiaomi MiMo",
  ocg: "OpenCode Go",
  zai: "Z.AI",
};

interface CatalogModel {
  id: string;
  label?: string;
  isAlias: boolean;
}

function providerLabelForModelId(modelId: string): string | undefined {
  const slashIndex = modelId.indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  return PROVIDER_LABEL_BY_PREFIX[modelId.slice(0, slashIndex)];
}

function catalogModelDisplayName(entry: CatalogModel): string {
  const modelPart = entry.label || formatModelName(displayModelId(entry.id));
  if (entry.isAlias) {
    return `${modelPart} (alias)`;
  }
  const provider = providerLabelForModelId(entry.id);
  return provider ? `${modelPart} (${provider})` : modelPart;
}

function buildProviderDefinition(): ProviderDefinition {
  const baseUrl = getInferhubBaseUrl();
  return {
    vendor: INFERHUB_VENDOR,
    displayName: "InferHub",
    modelsUrl: `${baseUrl}/models`,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    messagesUrl: `${baseUrl}/chat/completions`,
    responsesUrl: `${baseUrl}/responses`,
    categoryOrder: 2,
    testModelId: "cmc/meta/muse-spark-1.2",
    fallbackModels: [
      "cmc/meta/muse-spark-1.2-contributor",
      "cmc/meta/muse-spark-1.2",
      "cmc/meta/muse-spark-1.3-contributor",
      "cmc/meta/muse-spark-1.3",
    ],
  };
}

const PROVIDERS: Record<ProviderDefinition["vendor"], ProviderDefinition> = {
  [INFERHUB_VENDOR]: buildProviderDefinition(),
};

type ResponsesRole = "user" | "assistant" | "developer" | "system";

interface InferhubModel extends vscode.LanguageModelChatInformation {
  endpointKind: ModelEndpointKind;
  provider: ProviderDefinition;
  rawModelId?: string;
  category?: {
    label: string;
    order: number;
  };
  isUserSelectable?: boolean;
  configurationSchema?: vscode.LanguageModelConfigurationSchema;
}

interface ModelListEntry {
  id?: string;
  owned_by?: string;
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
  reasoning_levels?: string[];
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

interface ModelListResponse {
  data?: ModelListEntry[];
}

interface ResponsesInputItem {
  role?: ResponsesRole;
  type?: string;
  content?: ResponsesContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  id?: string;
  status?: string;
  phase?: string;
}

interface ResponsesContentPart {
  type: "input_text" | "input_image" | "output_text";
  text?: string;
  image_url?: string;
  detail?: string;
}

interface ResponsesToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: object;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

type InferhubReasoningEffort = "auto" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ApiSettings {
  temperature: number;
  maxOutputTokensOverride: number;
  maxInputTokensOverride: number;
  debugReasoning: boolean;
  debugLogging: boolean;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  thinkingEffort: InferhubReasoningEffort;
}

interface LanguageModelConfiguration {
  apiKey?: unknown;
}

type ConfiguredLanguageModelInfoOptions = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: LanguageModelConfiguration;
};

type ConfiguredLanguageModelResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  configuration?: LanguageModelConfiguration;
};

interface BaseModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

interface ModelLimits extends BaseModelLimits {
  advertisedContextWindow: number;
  advertisedMaxInputTokens: number;
  advertisedMaxOutputTokens: number;
}

interface ModelMetadataFields {
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  reasoning?: boolean;
  status?: string;
}

interface CachedModelMetadataSnapshot {
  fetchedAt: number;
  providers: Record<
    ProviderDefinition["vendor"],
    Record<string, ModelMetadataFields>
  >;
}

interface ResolvedModelMetadata extends BaseModelLimits {
  supportsVision: boolean;
  reasoning: boolean;
  status?: string;
  source: "models.dev" | "live" | "fallback" | "default";
}

interface ModelRoutingFields {
  endpointKind: ModelEndpointKind;
  endpointUrl: string;
  sdkPackage?: string;
}

// Copilot surfaces combine input/output metadata differently across views.
// Reserve a modest UI output budget, while requests still use the real model max.
const UI_OUTPUT_TOKEN_RESERVE = 8192;
const MESSAGE_TOKEN_OVERHEAD = 4;
const MESSAGE_NAME_TOKEN_OVERHEAD = 1;
const TOOL_CALL_TOKEN_OVERHEAD = 10;
const TOOL_RESULT_TOKEN_OVERHEAD = 6;
const IMAGE_TOKEN_ESTIMATE = 1024;

type CopilotCompatibleCapabilities = vscode.LanguageModelChatCapabilities & {
  supportsToolCalling: boolean;
  supportsImageToText: boolean;
};

let modelMetadataSnapshot: CachedModelMetadataSnapshot | undefined;
let modelMetadataRefreshPromise: Promise<CachedModelMetadataSnapshot> | undefined;

interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface RecentTransportSummary extends TransportRequestSummary {
  recordedAt: string;
  endpointKind: string;
  metadataSource: string;
  requestInitiator?: string;
}

export function activate(context: vscode.ExtensionContext) {
  ensureUsageStatusBar(context);
  void syncExperimentalContextIndicator();
  const inferhubProvider = new InferhubProvider(context, PROVIDERS[INFERHUB_VENDOR]);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(INFERHUB_VENDOR, inferhubProvider),
    vscode.commands.registerCommand("inferhub.manage", () => inferhubProvider.manage()),
    vscode.commands.registerCommand("inferhub.diagnostics", () => inferhubProvider.showDiagnostics()),
    vscode.commands.registerCommand("inferhub.setApiKey", () => inferhubProvider.setApiKey()),
    vscode.commands.registerCommand("inferhub.usage", () => inferhubProvider.showUsage()),
    vscode.commands.registerCommand("inferhub.modelPickerDiagnostics", () => showModelPickerDiagnostics()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("inferhub.showUsageStatusBar")) {
        resetUsageStatusBar();
      }
      if (event.affectsConfiguration("inferhub.experimentalContextIndicator")) {
        void syncExperimentalContextIndicator();
      }
    }),
  );

  void warmModelPickerMetadata();

  // VS Code 1.128+ — auto-fix BYOK utility model so background tasks work
  checkUtilityModelConfiguration(context);
}

/**
 * VS Code 1.128 introduced `chat.byokUtilityModelDefault` with a default of "none",
 * which breaks all background utility tasks (title generation, commit messages, intent
 * detection) for BYOK users. This function auto-configures it to "mainAgent" on first
 * activation so background tasks continue to work seamlessly.
 *
 * RULES:
 * - Only runs on VS Code 1.128+.
 * - Skips if any utility model setting is already explicitly configured.
 * - Uses a one-time globalState flag to avoid showing the notification on every activation.
 * - Valid enum (from VS Code 1.128 desktop bundle): "none" | "mainAgent" | "copilot".
 */
function checkUtilityModelConfiguration(context: vscode.ExtensionContext): void {
  const [major, minor] = vscode.version.split(".").map(Number);
  if (major < 1 || (major === 1 && minor < 128)) return;

  const chat = vscode.workspace.getConfiguration("chat");
  const byokDefault = chat.get<string>("byokUtilityModelDefault", "");
  const utilitySmall = chat.get<string>("utilitySmallModel", "");
  const utilityGeneral = chat.get<string>("utilityModel", "");

  // Treat VS Code's schema default values as "not configured"
  const isConfigured =
    (byokDefault !== "" && byokDefault !== undefined && byokDefault !== "none") ||
    (utilitySmall !== "" && utilitySmall !== undefined && utilitySmall !== "Default") ||
    (utilityGeneral !== "" && utilityGeneral !== undefined && utilityGeneral !== "Default");
  if (isConfigured) return;

  void chat
    .update("byokUtilityModelDefault", "mainAgent", vscode.ConfigurationTarget.Global)
    .then(() => {
      const NOTICE_KEY = "inferhub.utilityModelAutoFixed.v1128";
      if (context.globalState.get<boolean>(NOTICE_KEY)) return;
      void context.globalState.update(NOTICE_KEY, true);
      void vscode.window.showInformationMessage(
        "InferHub Copilot Chat: Automatically fixed VS Code 1.128 utility model setting. " +
          "Background tasks (chat titles, commit messages) now use your InferHub model.",
      );
    });
}

async function warmModelPickerMetadata(): Promise<void> {
  await Promise.allSettled([
    vscode.lm.selectChatModels({ vendor: INFERHUB_VENDOR }),
  ]);
}

async function showModelPickerDiagnostics(): Promise<void> {
  const vendors = [INFERHUB_VENDOR, "copilot"];
  const sections: string[] = [];

  for (const vendor of vendors) {
    const models = await vscode.lm.selectChatModels({ vendor });
    sections.push(`## vendor: ${vendor}`, "", `models: ${models.length}`, "");
    for (const model of models) {
      const internalModel = model as unknown as { configurationSchema?: unknown; detail?: unknown };
      const schema = internalModel.configurationSchema;
      sections.push(
        `### ${model.name}`,
        "",
        `- id: \`${model.id}\``,
        `- family: \`${model.family}\``,
        `- version: \`${model.version}\``,
        `- vendor: \`${model.vendor}\``,
        `- detail: \`${typeof internalModel.detail === "string" ? internalModel.detail : ""}\``,
        `- schema:`,
        "```json",
        JSON.stringify(schema ?? null, null, 2),
        "```",
        ""
      );
    }
  }

  const doc = await vscode.workspace.openTextDocument({
    content: ["# InferHub Model Picker Diagnostics", "", ...sections].join("\n"),
    language: "markdown"
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

export async function deactivate(): Promise<void> {
  await disposeContextWindowHookBridge();
}

function ensureUsageStatusBar(
  context: vscode.ExtensionContext,
): vscode.StatusBarItem {
  if (!usageStatusBarItem) {
    usageStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      95,
    );
    context.subscriptions.push(usageStatusBarItem);
  }

  resetUsageStatusBar();
  return usageStatusBarItem;
}

function shouldShowUsageStatusBar(): boolean {
  return vscode.workspace
    .getConfiguration("inferhub")
    .get("showUsageStatusBar", true);
}

function isExperimentalContextIndicatorEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("inferhub")
    .get("experimentalContextIndicator", false);
}

let hookDiagnosticChannel: vscode.OutputChannel | undefined;

function getHookDiagnosticChannel(): vscode.OutputChannel {
  if (!hookDiagnosticChannel) {
    hookDiagnosticChannel = vscode.window.createOutputChannel("InferHub");
  }
  return hookDiagnosticChannel;
}

function hookDiagnostic(message: string): void {
  getHookDiagnosticChannel().appendLine(
    `[${new Date().toISOString()}] [contextWindowHook] ${message}`,
  );
}

async function syncExperimentalContextIndicator(): Promise<void> {
  if (isExperimentalContextIndicatorEnabled()) {
    const ok = await initializeContextWindowHookBridge(hookDiagnostic);
    if (!ok) {
      hookDiagnostic(
        "experimentalContextIndicator is enabled but the bridge could not activate. " +
        "The Copilot Chat footer will show default (estimated) usage. " +
        "This is expected if VS Code internals changed — check for extension updates.",
      );
    }
    return;
  }

  await disposeContextWindowHookBridge();
}

function resetUsageStatusBar(): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  usageStatusBarItem.text = "InferHub";
  usageStatusBarItem.tooltip = "InferHub usage summary";
  usageStatusBarItem.show();
}

function updateUsageStatusBar(
  providerDisplayName: string,
  modelId: string,
  summary: TransportRequestSummary,
): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  const usage: UsageSnapshot = {
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    cachedTokens: summary.cachedTokens,
    costUsd: summary.costUsd,
    finishReason: summary.finishReason,
  };
  const text = formatUsageStatusBarText(providerDisplayName, usage);

  usageStatusBarItem.text = text ?? providerDisplayName;
  usageStatusBarItem.tooltip = formatUsageStatusBarTooltip(
    providerDisplayName,
    modelId,
    usage,
  );
  usageStatusBarItem.show();
}

class InferhubProvider implements vscode.LanguageModelChatProvider<InferhubModel> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  private readonly apiKeysByModelId = new Map<string, string>();
  private readonly reasoningContentByToolCallId = new Map<string, string>();
  private readonly liveModelMetadataById = new Map<string, ModelMetadataFields>();
  private readonly recentTransportSummaries: RecentTransportSummary[] = [];
  private outputChannel: vscode.OutputChannel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly definition: ProviderDefinition
  ) {
    this.restoreRecentTransportSummaries();
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel("InferHub");
      this.context.subscriptions.push(this.outputChannel);
    }
    return this.outputChannel;
  }

  private log(message: string): void {
    this.getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private debugLog(message: string): void {
    if (getSettings().debugLogging) {
      this.log(message);
    }
  }

  private async getMetadataSnapshot(): Promise<CachedModelMetadataSnapshot> {
    return getInferhubModelMetadata(
      this.context,
      getSettings().debugLogging ? this.getOutputChannel() : undefined,
    );
  }

  private resolveModelMetadata(
    modelId: string,
    snapshot: CachedModelMetadataSnapshot,
  ): ResolvedModelMetadata {
    return resolveModelMetadata(
      modelId,
      this.definition.vendor,
      snapshot,
      this.liveModelMetadataById,
    );
  }

  private replaceLiveModelMetadata(entries: ModelListEntry[] | undefined): void {
    this.liveModelMetadataById.clear();
    for (const entry of entries ?? []) {
      if (typeof entry.id !== "string" || !entry.id) {
        continue;
      }
      const metadata = normalizeLiveModelMetadata(entry);
      if (metadata) {
        this.liveModelMetadataById.set(entry.id, metadata);
      }
    }
  }

  private recentTransportSummariesStorageKey(): string {
    return `${RECENT_TRANSPORT_SUMMARY_STORAGE_PREFIX}.${this.definition.vendor}`;
  }

  private restoreRecentTransportSummaries(): void {
    const stored = this.context.globalState.get<RecentTransportSummary[]>(
      this.recentTransportSummariesStorageKey(),
      [],
    );

    if (!Array.isArray(stored) || !stored.length) {
      return;
    }

    this.recentTransportSummaries.push(
      ...stored.slice(-RECENT_TRANSPORT_SUMMARY_LIMIT),
    );
  }

  private persistRecentTransportSummaries(): void {
    void this.context.globalState.update(
      this.recentTransportSummariesStorageKey(),
      this.recentTransportSummaries,
    );
  }

  private recordTransportSummary(
    summary: TransportRequestSummary,
    endpointKind: string,
    metadataSource: string,
    requestInitiator: unknown,
  ): void {
    const initiator = typeof requestInitiator === "string"
      ? requestInitiator
      : requestInitiator === undefined || requestInitiator === null
        ? undefined
        : String(requestInitiator);

    this.recentTransportSummaries.push({
      ...summary,
      recordedAt: new Date().toISOString(),
      endpointKind,
      metadataSource,
      ...(initiator ? { requestInitiator: initiator } : {}),
    });

    if (this.recentTransportSummaries.length > RECENT_TRANSPORT_SUMMARY_LIMIT) {
      this.recentTransportSummaries.splice(
        0,
        this.recentTransportSummaries.length - RECENT_TRANSPORT_SUMMARY_LIMIT,
      );
    }

    this.persistRecentTransportSummaries();
  }

  private recentTransportDiagnosticsLines(): string[] {
    if (!this.recentTransportSummaries.length) {
      return ["No requests recorded in this extension host yet.", ""];
    }

    return this.recentTransportSummaries
      .slice()
      .reverse()
      .flatMap((summary, index) => {
        const status = summary.status ?? summary.abortedReason ?? "n/a";
        const cacheHitRatio = formatCacheHitRatio({
          promptTokens: summary.promptTokens,
          cachedTokens: summary.cachedTokens,
        });
        const lines = [
          `### ${index + 1}. ${summary.modelId}`,
          "",
          `- time: ${summary.recordedAt}`,
          `- endpoint: ${summary.endpointKind}`,
          `- initiator: ${summary.requestInitiator ?? "unknown"}`,
          `- metadataSource: ${summary.metadataSource}`,
          `- status: ${status}`,
          `- durationMs: ${summary.durationMs}`,
          `- ttfbMs: ${summary.ttfbMs ?? "n/a"}`,
          `- totalBytes: ${summary.totalBytes}`,
          `- totalEvents: ${summary.totalEvents}`,
          `- tokens: prompt=${summary.promptTokens ?? "n/a"}, completion=${summary.completionTokens ?? "n/a"}, total=${summary.totalTokens ?? "n/a"}, cached=${summary.cachedTokens ?? "n/a"}`,
          `- costUsd: ${summary.costUsd ?? "n/a"}`,
          `- cacheHitRatio: ${cacheHitRatio ?? "n/a"}`,
          `- finishReason: ${summary.finishReason ?? "n/a"}`,
          `- requestId: ${summary.requestId ?? "n/a"}`,
          `- sessionId: ${summary.sessionId ?? "n/a"}`,
          `- url: ${summary.url}`,
        ];

        if (summary.rateLimitSummary) {
          lines.push(`- rateLimit: ${summary.rateLimitSummary}`);
        }
        if (summary.errorMessage) {
          lines.push(`- error: ${summary.errorMessage}`);
        }

        lines.push("");
        return lines;
      });
  }

  private async refreshMetadataAndModels(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    await clearInferhubModelMetadataCache(this.context);
    await this.fetchModels(apiKey, { showNotification: true });
  }

  async manage(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);

    if (!apiKey) {
      await this.setApiKey();
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: "Set API Key", action: "set" as const },
        { label: "Clear API Key", action: "clear" as const },
        { label: "Test Connection", action: "test" as const },
        { label: "Refresh Models", action: "refresh" as const }
      ],
      {
        title: `Manage ${this.definition.displayName}`,
        placeHolder: "Choose an action"
      }
    );

    if (!choice) {
      return;
    }

    if (choice.action === "set") {
      await this.setApiKey();
      return;
    }

    if (choice.action === "clear") {
      await this.context.secrets.delete(SECRET_KEY);
      this.changeEmitter.fire();
      vscode.window.showInformationMessage("InferHub API key cleared.");
      return;
    }

    if (choice.action === "test") {
      await this.testConnection();
      return;
    }

    await this.refreshMetadataAndModels();
    this.changeEmitter.fire();
    vscode.window.showInformationMessage(`${this.definition.displayName} models refreshed.`);
  }

  async testConnection(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      vscode.window.showErrorMessage(`${this.definition.displayName}: No API key set. Use 'Set API Key' first.`);
      return;
    }

    const statusBar = vscode.window.setStatusBarMessage(`$(loading~spin) Testing ${this.definition.displayName} connection...`);
    this.log(`Testing connection to ${this.definition.responsesUrl}`);

    try {
      const response = await fetch(this.definition.responsesUrl!, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.definition.testModelId,
          input: "reply with just: ok",
          max_output_tokens: 10,
          store: false
        })
      });

      const responseText = await response.text();
      statusBar.dispose();
      this.log(`Test response (${response.status}): ${responseText}`);
      this.getOutputChannel().show(true);

      if (response.ok) {
        vscode.window.showInformationMessage(`${this.definition.displayName}: Connection OK (HTTP ${response.status}). Check Output panel for details.`);
      } else {
        vscode.window.showErrorMessage(`${this.definition.displayName}: Connection failed (HTTP ${response.status}). Check Output panel for details.`);
      }
    } catch (error) {
      statusBar.dispose();
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Test connection error: ${message}`);
      this.getOutputChannel().show(true);
      vscode.window.showErrorMessage(`${this.definition.displayName}: Connection error - ${message}`);
    }
  }

  async setApiKey(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      title: "InferHub API Key",
      prompt: "Paste your InferHub API key (sk-airo-...). It will be stored securely in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true
    });

    if (!apiKey) {
      return;
    }

    await this.context.secrets.store(SECRET_KEY, apiKey.trim());
    this.changeEmitter.fire();
    vscode.window.showInformationMessage("InferHub API key saved.");
  }

  async showUsage(range: UsageRange = "24h"): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      vscode.window.showErrorMessage(`${this.definition.displayName}: No API key set. Use 'Set API Key' first.`);
      return;
    }

    const statusBar = vscode.window.setStatusBarMessage("$(loading~spin) Fetching InferHub usage...");
    try {
      const page = await fetchUsageLogPage(apiKey, range);
      const doc = await vscode.workspace.openTextDocument({
        content: formatUsageReport(page),
        language: "markdown"
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`InferHub usage error: ${message}`);
      vscode.window.showErrorMessage(`InferHub usage failed: ${message}`);
    } finally {
      statusBar.dispose();
    }
  }

  async showDiagnostics(): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: this.definition.vendor });
    const metadataSnapshot = await this.getMetadataSnapshot();
    const lines = models.map((model) => {
      const rawModelId = resolveRawModelId(model.id);
      const metadata = this.resolveModelMetadata(rawModelId, metadataSnapshot);
      const limits = modelLimits(metadata);
      return [
      `- ${rawModelId}`,
      `  rawModelId: ${rawModelId}`,
      `  name: ${model.name}`,
      `  family: ${model.family}`,
      `  vendor: ${model.vendor}`,
      `  version: ${model.version}`,
      `  maxInputTokens: ${model.maxInputTokens}`,
      `  advertisedMaxOutputTokens: ${limits.advertisedMaxOutputTokens}`,
      `  advertisedContextWindow: ${limits.advertisedContextWindow}`,
      `  apiMaxOutputTokens: ${limits.maxOutputTokens}`,
      `  metadataSource: ${metadata.source}`,
      `  supportsVision: ${metadata.supportsVision}`,
      `  status: ${metadata.status ?? "active"}`,
      `  thinking: ${metadata.reasoning ? "supported" : "off"}`,
      `  configurationSchema: ${JSON.stringify((model as unknown as { configurationSchema?: unknown }).configurationSchema ?? null)}`,
      ...(hasExplicitModelLimits(rawModelId, this.definition.vendor) ? [] : ["  limits: using bundled fallback"])
      ].join("\n");
    });

    const content = [
      `# ${this.definition.displayName} Diagnostics`,
      "",
      "## Recent Requests",
      "",
      ...this.recentTransportDiagnosticsLines(),
      `## Models`,
      "",
      `Models visible through vscode.lm.selectChatModels({ vendor: "${this.definition.vendor}" }): ${models.length}`,
      "",
      ...lines
    ].join("\n");

    const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<InferhubModel[]> {
    const apiKey =
      getConfiguredApiKey(options as ConfiguredLanguageModelInfoOptions)
      ?? await this.context.secrets.get(SECRET_KEY);

    if (!apiKey) {
      return [];
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const models = await this.fetchModels(apiKey);
    const settings = getSettings();
    const metadataSnapshot = await this.getMetadataSnapshot();

    return models.map((entry) => {
      const modelId = entry.id;
      const metadata = this.resolveModelMetadata(modelId, metadataSnapshot);
      const routing = resolveModelRouting(modelId, this.definition);
      const effectiveModelId = toEffectiveModelId(modelId, this.definition.vendor);
      const limits = modelLimits(metadata, settings);
      this.apiKeysByModelId.set(modelId, apiKey);
      this.apiKeysByModelId.set(effectiveModelId, apiKey);

      const baseTooltip = `${this.definition.displayName} model: ${modelId}`;

      const isContributor = modelId.includes("contributor");
      const info: InferhubModel = {
        id: effectiveModelId,
        rawModelId: modelId,
        name: catalogModelDisplayName(entry),
        family: `${this.definition.vendor}-${modelId}-${MODEL_METADATA_REVISION}`,
        version: `1.3.0-${MODEL_METADATA_REVISION}-${limits.contextWindow}-${limits.maxOutputTokens}`,
        detail: entry.isAlias ? `${modelId} (auto-routed)` : modelId,
        tooltip: baseTooltip,
        category: {
          label: this.definition.displayName,
          order: this.definition.categoryOrder
        },
        isUserSelectable: true,
        multiplierNumeric: isContributor ? 1 : 2,
        maxInputTokens: limits.advertisedMaxInputTokens,
        maxOutputTokens: limits.advertisedMaxOutputTokens,
        capabilities: modelCapabilities(metadata),
        endpointKind: routing.endpointKind,
        provider: this.definition,
        configurationSchema: inferhubReasoningConfigurationSchema(),
      };

      this.debugLog(`Model registered: id=${info.id} family=${info.family} metadataSource=${metadata.source} endpointKind=${routing.endpointKind} endpointUrl=${routing.endpointUrl}`);

      return info;
    });
  }

  async provideLanguageModelChatResponse(
    model: InferhubModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey =
      getConfiguredApiKey(options as ConfiguredLanguageModelResponseOptions)
      ?? this.apiKeysByModelId.get(model.id)
      ?? await this.context.secrets.get(SECRET_KEY);

    if (!apiKey) {
      throw new Error(`${this.definition.displayName} API key is required. Use the ${this.definition.displayName} gear icon in Language Models to configure it, then reload the window.`);
    }

    const responsesInput = normalizeResponsesInput(messages.flatMap((message) => convertToResponsesInput(message)));
    const baseSettings = getSettings();
    const rawModelId = model.rawModelId ?? resolveRawModelId(model.id);
    const requestOverride = getRequestModelConfiguration(options);
    const thinkingEffort = resolveThinkingEffort(baseSettings, requestOverride);
    const settings: ApiSettings = {
      ...baseSettings,
      thinkingEffort,
    };
    const metadataSnapshot = await this.getMetadataSnapshot();
    const metadata = this.resolveModelMetadata(rawModelId, metadataSnapshot);
    const routing = resolveModelRouting(rawModelId, this.definition);
    const limits = modelLimits(metadata, settings);
    const hasImageInput = inputHasImages(responsesInput);
    // Only reasoning-capable models get an effort payload; strict upstreams
    // reject the field otherwise.
    const thinkingPayload = metadata.reasoning
      ? thinkingEffortToPayload(settings.thinkingEffort)
      : {};
    const requestHeaders = buildInferhubRequestHeaders(
      messages,
      options,
      rawModelId,
    );
    const outputChannel =
      settings.debugLogging || settings.debugReasoning
        ? this.getOutputChannel()
        : undefined;
    const onTransportSummary = (summary: TransportRequestSummary) => {
      this.recordTransportSummary(
        summary,
        routing.endpointKind,
        metadata.source,
        options.requestInitiator,
      );
      updateUsageStatusBar(this.definition.displayName, rawModelId, summary);
    };

    this.debugLog(`Request: initiator=${options.requestInitiator} model=${model.id} rawModel=${rawModelId} endpoint=${routing.endpointKind} metadataSource=${metadata.source} inputItems=${responsesInput.length} session=${requestHeaders["x-inferhub-session"]} request=${requestHeaders["x-inferhub-request"]} thinkingEffort=${settings.thinkingEffort} hasImageInput=${hasImageInput}`);
    if (settings.debugReasoning) {
      this.log("Debug logging enabled. Responses API reasoning summaries will stream as thinking parts when available.");
    }

    try {
      const contextWindowOutputBuffer = limits.advertisedMaxOutputTokens;

      await runStreamResponses({
        url: routing.endpointUrl,
        providerDisplayName: this.definition.displayName,
        apiKey,
        modelId: rawModelId,
        body: buildResponsesRequestBody(rawModelId, responsesInput, options, settings, limits, thinkingPayload),
        authHeaders: buildInferhubAuthHeaders(apiKey),
        requestHeaders,
        progress,
        token,
        output: outputChannel,
        debugReasoning: settings.debugReasoning,
        debugTransport: settings.debugLogging,
        requestTimeoutMs: settings.requestTimeoutMs,
        streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
        contextWindowOutputBuffer,
        onTransportSummary,
        onReasoningContent: (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
        }
      });
      this.debugLog(`Request completed: model=${model.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`ERROR model=${model.id}: ${message}`);
      this.getOutputChannel().show(true);
      if (error instanceof InferHubRequestError) {
        vscode.window.showErrorMessage(error.userMessage);
      }
      throw error;
    }
  }

  async provideTokenCount(
    _model: InferhubModel,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    return typeof text === "string"
      ? estimateTokenCount(text)
      : estimateChatMessageTokenCount(text);
  }

  private async fetchModels(
    apiKey?: string,
    options?: { showNotification?: boolean },
  ): Promise<CatalogModel[]> {
    const showNotification = options?.showNotification ?? false;
    try {
      const headers: Record<string, string> = {
        "User-Agent": INFERHUB_USER_AGENT,
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const response = await fetch(this.definition.modelsUrl, { headers });

      if (!response.ok) {
        throw new Error(`Model list request failed (${response.status}): ${response.statusText}`);
      }

      const data = await response.json() as ModelListResponse;
      this.replaceLiveModelMetadata(data.data);
      const entries: CatalogModel[] = [];
      for (const model of data.data ?? []) {
        if (typeof model.id !== "string" || !model.id) {
          continue;
        }
        entries.push({
          id: model.id,
          label: model.upstream_label,
          isAlias: model.owned_by === "alias",
        });
      }

      // Always include the bundled fallback models so documented models that the
      // /models endpoint does not list (e.g. muse-spark-1.2-contributor) are
      // still selectable in the picker.
      const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
      for (const fallbackId of this.definition.fallbackModels) {
        if (!entriesById.has(fallbackId)) {
          entriesById.set(fallbackId, { id: fallbackId, isAlias: false });
        }
      }

      const allEntries = [...entriesById.values()];
      const keptIds = new Set(await this.filterAvailableModels(allEntries.map((entry) => entry.id)));
      return keptIds.size ? allEntries.filter((entry) => keptIds.has(entry.id)) : allEntries;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const warning = `Could not fetch ${this.definition.displayName} model list. Using bundled model list. ${message}`;
      this.log(`WARN ${warning}`);
      if (showNotification) {
        vscode.window.showWarningMessage(warning);
      }
      return (await this.filterAvailableModels(this.definition.fallbackModels))
        .map((id) => ({ id, isAlias: false }));
    }
  }

  private async filterAvailableModels(modelIds: string[]): Promise<string[]> {
    const uniqueModelIds = [...new Set(modelIds)];

    try {
      const metadataSnapshot = await this.getMetadataSnapshot();
      const filteredModelIds = uniqueModelIds.filter((modelId) =>
        !KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId)
        && !shouldHideDeprecatedModel(modelId, this.definition.vendor, metadataSnapshot)
      );

      const removedModelIds = uniqueModelIds.filter((modelId) => !filteredModelIds.includes(modelId));
      if (removedModelIds.length) {
        this.debugLog(`Filtered unavailable/deprecated models: ${removedModelIds.join(", ")}`);
      }

      return filteredModelIds;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.debugLog(`Could not fetch model status metadata from models.dev. Applying local unavailable model filter only. ${message}`);
      return uniqueModelIds.filter((modelId) => !KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId));
    }
  }

}

function getConfiguredApiKey(options?: { configuration?: LanguageModelConfiguration }): string | undefined {
  const configuredApiKey = options?.configuration?.apiKey;
  return typeof configuredApiKey === "string" && configuredApiKey.trim() ? configuredApiKey.trim() : undefined;
}

async function clearInferhubModelMetadataCache(
  context: vscode.ExtensionContext,
): Promise<void> {
  modelMetadataSnapshot = undefined;
  modelMetadataRefreshPromise = undefined;
  await context.globalState.update(MODEL_METADATA_CACHE_KEY, undefined);
}

async function getInferhubModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  const cached =
    modelMetadataSnapshot ??
    context.globalState.get<CachedModelMetadataSnapshot>(
      MODEL_METADATA_CACHE_KEY,
    );
  if (cached) {
    modelMetadataSnapshot = cached;
    if (isFreshModelMetadata(cached)) {
      return cached;
    }
    void refreshInferhubModelMetadata(context, output);
    return cached;
  }

  return refreshInferhubModelMetadata(context, output);
}

async function refreshInferhubModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  if (modelMetadataRefreshPromise) {
    return modelMetadataRefreshPromise;
  }

  modelMetadataRefreshPromise = (async () => {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      throw new Error(`models.dev request failed (${response.status}): ${response.statusText}`);
    }

    const data = await response.json() as ModelsDevResponse;
    const snapshot = normalizeModelsDevSnapshot(data);
    modelMetadataSnapshot = snapshot;
    await context.globalState.update(MODEL_METADATA_CACHE_KEY, snapshot);
    output?.appendLine(
      `[metadata] refreshed models.dev cache inferhub=${Object.keys(snapshot.providers[INFERHUB_VENDOR]).length}`,
    );
    return snapshot;
  })()
    .catch((error) => {
      const cached =
        modelMetadataSnapshot ??
        context.globalState.get<CachedModelMetadataSnapshot>(
          MODEL_METADATA_CACHE_KEY,
        );
      if (cached) {
        const message = error instanceof Error ? error.message : String(error);
        output?.appendLine(
          `[metadata] refresh failed, using cached snapshot: ${message}`,
        );
        modelMetadataSnapshot = cached;
        return cached;
      }

      const message = error instanceof Error ? error.message : String(error);
      const fallback = bundledModelMetadataSnapshot();
      output?.appendLine(
        `[metadata] refresh failed, using bundled snapshot: ${message}`,
      );
      modelMetadataSnapshot = fallback;
      return fallback;
    })
    .finally(() => {
      modelMetadataRefreshPromise = undefined;
    });

  return modelMetadataRefreshPromise;
}

function buildResponsesRequestBody(
  modelId: string,
  input: ResponsesInputItem[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  limits: ModelLimits,
  thinkingPayload: Record<string, unknown>,
): Record<string, unknown> {
  const tools = mapResponsesTools(options.tools);

  return {
    model: modelId,
    input,
    temperature: settings.temperature,
    max_output_tokens: limits.maxOutputTokens,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "vscode-copilot-chat",
    prompt_cache_retention: "24h",
    ...(thinkingPayload.reasoning ? { reasoning: thinkingPayload.reasoning } : {}),
    ...(tools.length ? { tools, tool_choice: toolChoice(options.toolMode), parallel_tool_calls: true } : {}),
  };
}

function buildResponsesTestBody(modelId: string): Record<string, unknown> {
  return {
    model: modelId,
    input: "reply with just: ok",
    max_output_tokens: 10,
    store: false,
  };
}

function mapResponsesTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): ResponsesToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.inputSchema)
  }));
}

function sanitizeToolSchema(schema: unknown): object {
  const root = isRecord(schema) ? schema : { type: "object", properties: {} };
  const sanitized = sanitizeJsonSchemaNode(root, root, new Set());
  if (!isRecord(sanitized)) {
    return { type: "object", properties: {} };
  }

  return {
    type: sanitized.type === "object" ? "object" : "object",
    properties: isRecord(sanitized.properties) ? sanitized.properties : {},
    ...(Array.isArray(sanitized.required) ? { required: sanitized.required } : {})
  };
}

function sanitizeJsonSchemaNode(value: unknown, root: Record<string, unknown>, seenRefs: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchemaNode(item, root, seenRefs));
  }

  if (!isRecord(value)) {
    return value;
  }

  const ref = typeof value.$ref === "string" ? value.$ref : undefined;
  if (ref?.startsWith("#/") && !seenRefs.has(ref)) {
    const target = resolveJsonPointer(root, ref);
    if (target !== undefined) {
      const nextSeenRefs = new Set(seenRefs);
      nextSeenRefs.add(ref);
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      const resolved = sanitizeJsonSchemaNode(target, root, nextSeenRefs);
      return isRecord(resolved)
        ? sanitizeJsonSchemaNode({ ...resolved, ...siblings }, root, nextSeenRefs)
        : sanitizeJsonSchemaNode(siblings, root, nextSeenRefs);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "$id" || key === "$ref" || key === "$defs" || key === "definitions") {
      continue;
    }

    if (key === "properties" && isRecord(child)) {
      result.properties = Object.fromEntries(
        Object.entries(child).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeJsonSchemaNode(propertySchema, root, seenRefs)
        ])
      );
      continue;
    }

    if (key === "items" || key === "additionalProperties") {
      result[key] = sanitizeJsonSchemaNode(child, root, seenRefs);
      continue;
    }

    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(child)) {
      result[key] = child.map((item) => sanitizeJsonSchemaNode(item, root, seenRefs));
      continue;
    }

    if (["type", "description", "enum", "required", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].includes(key)) {
      result[key] = child;
    }
  }

  return result;
}

function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  return pointer
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, root);
}

// Meta Model API only supports tool_choice "auto". "none", "required", and
// named function choices return HTTP 400.
function toolChoice(_mode: vscode.LanguageModelChatToolMode): "auto" {
  return "auto";
}

// Session/request identifiers forwarded to the Meta gateway as headers.
function buildInferhubRequestHeaders(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  modelId: string,
): Record<string, string> {
  const sessionId = cleanHeaderValue(
    findStringOption(options, [
      "sessionId",
      "sessionID",
      "chatSessionId",
      "chatSessionID",
      "conversationId",
      "conversationID",
      "threadId",
      "threadID",
      "session.id",
      "chatSession.id",
    ]) ?? `vscode-${stableHash(conversationAnchor(messages, modelId))}`,
  );
  const requestId = cleanHeaderValue(
    findStringOption(options, [
      "requestId",
      "requestID",
      "messageId",
      "messageID",
    ]) ??
      `req-${stableHash(`${Date.now()}-${Math.random()}-${sessionId}-${modelId}`)}`,
  );

  return {
    "x-inferhub-session": sessionId,
    "x-inferhub-request": requestId,
    "x-inferhub-client": INFERHUB_CLIENT,
    "User-Agent": INFERHUB_USER_AGENT,
  };
}

function findStringOption(options: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = readPath(options, path.split("."));
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function conversationAnchor(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  modelId: string,
): string {
  const anchorMessages = messages
    .slice(0, 3)
    .map((message) => `${message.role}:${messageText(message).slice(0, 2048)}`);
  return anchorMessages.length ? anchorMessages.join("\n") : modelId;
}

function cleanHeaderValue(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, " ").trim();
  return cleaned ? cleaned.slice(0, 256) : "unknown";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function convertToResponsesInput(
  message: vscode.LanguageModelChatRequestMessage,
): ResponsesInputItem[] {
  const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
  const textParts: string[] = [];
  const imageParts: ResponsesContentPart[] = [];
  const toolCalls: { id: string; name: string; args: string }[] = [];
  const toolResults: ResponsesInputItem[] = [];

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({
        id: part.callId,
        name: part.name,
        args: JSON.stringify(part.input ?? {}),
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      const outputText = part.content.map(partToText).filter(Boolean).join("\n");
      toolResults.push({
        type: "function_call_output",
        call_id: part.callId,
        output: outputText,
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
      const base64 = dataPartToBase64(part.data);
      imageParts.push({
        type: "input_image",
        image_url: `data:${part.mimeType};base64,${base64}`,
        detail: "auto",
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
      continue;
    }

    const text = partToText(part);
    if (text) {
      textParts.push(text);
    }
  }

  const textContent = textParts.join("\n");
  const contentParts: ResponsesContentPart[] = [];
  if (textContent) {
    contentParts.push({ type: isAssistant ? "output_text" : "input_text", text: textContent });
  }
  if (imageParts.length) {
    contentParts.push(...imageParts);
  }

  const items: ResponsesInputItem[] = [];
  const role: ResponsesRole = isAssistant ? "assistant" : "user";

  if (contentParts.length) {
    items.push({ role, content: contentParts });
  }

  for (const tc of toolCalls) {
    items.push({
      type: "function_call",
      call_id: tc.id,
      name: tc.name,
      arguments: tc.args,
    });
  }

  items.push(...toolResults);

  return items;
}

function dataPartToBase64(data: Uint8Array): string {
  let output = "";

  for (let index = 0; index < data.length; index += 3) {
    const first = data[index] ?? 0;
    const second = data[index + 1] ?? 0;
    const third = data[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;

    output += BASE64_ALPHABET[(chunk >> 18) & 63];
    output += BASE64_ALPHABET[(chunk >> 12) & 63];
    output += index + 1 < data.length ? BASE64_ALPHABET[(chunk >> 6) & 63] : "=";
    output += index + 2 < data.length ? BASE64_ALPHABET[chunk & 63] : "=";
  }

  return output;
}

function reasoningForToolCalls(
  toolCalls: { id: string }[],
  reasoningContentByToolCallId: ReadonlyMap<string, string>
): string | undefined {
  const reasoning = toolCalls
    .map((toolCall) => reasoningContentByToolCallId.get(toolCall.id))
    .filter((value): value is string => Boolean(value?.trim()));

  return reasoning.length ? reasoning.join("\n") : undefined;
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content.map(partToText).filter(Boolean).join("\n");
}

function estimateChatMessageTokenCount(message: vscode.LanguageModelChatRequestMessage): number {
  const role = typeof message.role === "string" ? message.role : String(message.role);
  const name = typeof message.name === "string" ? message.name : "";
  const contentTokens = message.content
    .map(partToTokenCount)
    .reduce((total, count) => total + count, 0);

  return MESSAGE_TOKEN_OVERHEAD
    + estimateTokenCount(role)
    + (name ? MESSAGE_NAME_TOKEN_OVERHEAD + estimateTokenCount(name) : 0)
    + contentTokens;
}

function partToTokenCount(part: vscode.LanguageModelInputPart | unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return estimateTokenCount(part.value);
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    const contentTokens = part.content
      .map(partToTokenCount)
      .reduce((total, count) => total + count, 0);
    return TOOL_RESULT_TOKEN_OVERHEAD
      + estimateTokenCount(part.callId)
      + contentTokens;
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return TOOL_CALL_TOKEN_OVERHEAD
      + estimateTokenCount(part.callId)
      + estimateTokenCount(part.name)
      + estimateStructuredTokenCount(part.input);
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    return isInternalDataPart(part) ? 0 : estimateDataPartTokenCount(part);
  }

  if (typeof part === "string") {
    return estimateTokenCount(part);
  }

  if (isRecord(part)) {
    return estimateStructuredTokenCount(part);
  }

  return 0;
}

function estimateStructuredTokenCount(value: unknown): number {
  try {
    return estimateTokenCount(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function estimateDataPartTokenCount(part: vscode.LanguageModelDataPart): number {
  if (part.mimeType.startsWith("image/")) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
    return estimateTokenCount(Buffer.from(part.data).toString("utf8"));
  }

  return Math.max(1, Math.ceil(part.data.byteLength / 4));
}

function partToText(part: vscode.LanguageModelInputPart | unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return part.content.map(partToText).filter(Boolean).join("\n");
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[Tool call: ${part.name} ${JSON.stringify(part.input)}]`;
  }

  if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
    return "";
  }

  if (typeof part === "string") {
    return part;
  }

  return "";
}

// The Responses API rejects a `function_call_output` whose `function_call` is missing
// (and vice versa), so unpaired/duplicate tool items are dropped before sending.
function pairToolItems(items: readonly ResponsesInputItem[]): ResponsesInputItem[] {
  const callIds = new Set<string>();
  const outputIds = new Set<string>();

  for (const item of items) {
    if (item.type === "function_call" && item.call_id) {
      callIds.add(item.call_id);
    } else if (item.type === "function_call_output" && item.call_id) {
      outputIds.add(item.call_id);
    }
  }

  const emitted = new Set<string>();
  const paired: ResponsesInputItem[] = [];

  for (const item of items) {
    if (item.type !== "function_call" && item.type !== "function_call_output") {
      paired.push(item);
      continue;
    }

    const callId = item.call_id;
    if (!callId || !callIds.has(callId) || !outputIds.has(callId)) {
      continue;
    }

    const key = `${item.type}:${callId}`;
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    paired.push(item);
  }

  return paired;
}

function normalizeResponsesInput(rawItems: ResponsesInputItem[]): ResponsesInputItem[] {
  const items = pairToolItems(rawItems);
  const normalized: ResponsesInputItem[] = [];

  for (const item of items) {
    if (item.type === "function_call" || item.type === "function_call_output") {
      normalized.push(item);
      continue;
    }
    const content = item.content;
    if (!content || content.length === 0) {
      continue;
    }
    const hasText = content.some((p) => typeof p.text === "string" && p.text.trim().length > 0);
    const hasImage = content.some((p) => p.type === "input_image");
    if (!hasText && !hasImage) {
      continue;
    }

    const prev = normalized.at(-1);
    if (
      prev
      && !prev.type
      && !item.type
      && prev.role === item.role
      && prev.role !== undefined
      && item.role !== undefined
    ) {
      const prevText = prev.content?.filter((p) => p.type === "input_text" || p.type === "output_text").map((p) => p.text ?? "").join("\n") ?? "";
      const curText = content.filter((p) => p.type === "input_text" || p.type === "output_text").map((p) => p.text ?? "").join("\n") ?? "";
      if (prevText && curText) {
        const merged = `${prevText}\n\n${curText}`.trim();
        const mergedType = prev.role === "assistant" ? "output_text" : "input_text";
        const images = [...(prev.content?.filter((p) => p.type === "input_image") ?? []), ...(content.filter((p) => p.type === "input_image") ?? [])];
        prev.content = [{ type: mergedType, text: merged }, ...images];
        continue;
      }
    }
    normalized.push({ ...item });
  }

  if (normalized.length === 0) {
    return [{ role: "user", content: [{ type: "input_text", text: "" }] }];
  }

  if (normalized[0]?.role === "assistant" && !normalized[0]?.type) {
    normalized.unshift({ role: "user", content: [{ type: "input_text", text: "Continue the conversation based on the prior assistant message." }] });
  }

  return normalized;
}

function inputHasImages(items: readonly ResponsesInputItem[]): boolean {
  return items.some((item) =>
    Array.isArray(item.content)
    && item.content.some((part) => part.type === "input_image")
  );
}

function hasResponsesPayload(item: ResponsesInputItem): boolean {
  if (item.type === "function_call" || item.type === "function_call_output") {
    return true;
  }
  if (Array.isArray(item.content)) {
    return item.content.length > 0;
  }
  return false;
}

function inferhubReasoningConfigurationSchema(): vscode.LanguageModelConfigurationSchema {
  return {
    type: "object",
    properties: {
      reasoningEffort: {
        type: "string",
        title: "Thinking Effort",
        enum: ["auto", "minimal", "low", "medium", "high", "xhigh"],
        enumItemLabels: ["Auto", "Minimal", "Low", "Medium", "High", "XHigh"],
        enumDescriptions: [
          "Let the model decide",
          "Minimal reasoning",
          "Light reasoning",
          "Moderate depth",
          "Deep reasoning",
          "Maximum reasoning depth"
        ],
        default: "auto",
        group: "navigation"
      }
    }
  };
}

function getRequestModelConfiguration(options: vscode.ProvideLanguageModelChatResponseOptions): Record<string, unknown> | undefined {
  const opts = options as vscode.ProvideLanguageModelChatResponseOptions & {
    modelConfiguration?: Record<string, unknown>;
    configuration?: Record<string, unknown>;
  };
  return opts.modelConfiguration ?? opts.configuration;
}

function normalizeThinkingEffort(raw: string | undefined): InferhubReasoningEffort {
  const normalized = raw?.toLowerCase().replace(/\s+/g, "");
  if (normalized === "auto" || normalized === "" || normalized === undefined) return "auto";
  if (normalized === "minimal") return "minimal";
  if (normalized === "low") return "low";
  if (normalized === "medium") return "medium";
  if (normalized === "high") return "high";
  if (normalized === "xhigh") return "xhigh";
  return "auto";
}

function resolveThinkingEffort(settings: ApiSettings, override: Record<string, unknown> | undefined): InferhubReasoningEffort {
  const effort = override?.reasoningEffort;
  if (typeof effort === "string") {
    return normalizeThinkingEffort(effort);
  }
  return settings.thinkingEffort;
}

function getSettings(): ApiSettings {
  const config = vscode.workspace.getConfiguration("inferhub");

  return {
    temperature: config.get("temperature", 0.2),
    maxOutputTokensOverride: config.get("maxTokens", 0),
    maxInputTokensOverride: config.get("maxInputTokens", 0),
    debugReasoning: config.get("debugReasoning", false),
    debugLogging: config.get("debugLogging", false),
    requestTimeoutMs:
      Math.max(config.get("requestTimeoutSeconds", DEFAULT_REQUEST_TIMEOUT_MS / 1000), 1) * 1000,
    streamIdleTimeoutMs:
      Math.max(
        config.get(
          "streamIdleTimeoutSeconds",
          DEFAULT_STREAM_IDLE_TIMEOUT_MS / 1000,
        ),
        1,
      ) * 1000,
    thinkingEffort: normalizeThinkingEffort(config.get<string>("thinking.effort")),
  };
}

function thinkingEffortToPayload(effort: InferhubReasoningEffort): Record<string, unknown> {
  if (effort === "auto") {
    return { reasoning: { effort: "medium", summary: "auto" } };
  }

  return {
    reasoning: { effort, summary: "auto" },
  };
}

function modelLimits(
  metadata: ResolvedModelMetadata,
  settings = getSettings(),
): ModelLimits {
  const contextWindow = positiveOverride(settings.maxInputTokensOverride) ?? metadata.contextWindow;
  const maxOutputTokens = positiveOverride(settings.maxOutputTokensOverride) ?? metadata.maxOutputTokens;
  const apiMaxOutputTokens = Math.min(maxOutputTokens, contextWindow);
  const advertisedContextWindow = applyContextWindowLimit(
    contextWindow,
  );
  const advertisedMaxOutputTokens = Math.max(1, Math.min(apiMaxOutputTokens, UI_OUTPUT_TOKEN_RESERVE));

  return {
    contextWindow,
    maxOutputTokens: apiMaxOutputTokens,
    advertisedContextWindow,
    advertisedMaxInputTokens: Math.max(1, advertisedContextWindow - advertisedMaxOutputTokens),
    advertisedMaxOutputTokens
  };
}

function applyContextWindowLimit(modelContext: number): number {
  const limit = vscode.workspace.getConfiguration("inferhub").get<string>("contextWindowLimit", "full");
  const limits: Record<string, number> = {
    "32k": 32768,
    "64k": 65536,
    "128k": 131072,
    "256k": 262144,
    "512k": 524288,
    "1m": 1024000,
  };
  const cap = limits[limit ?? "full"];
  return cap && cap < modelContext ? cap : modelContext;
}

function estimateTokenCount(value: string): number {
  if (!value) {
    return 0;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }

  const cjkCharacters = normalized.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const words = normalized.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu)?.length ?? 0;
  const charEstimate = Math.ceil(normalized.length / 4);

  return Math.max(1, Math.ceil(Math.max(words * 1.15, charEstimate, cjkCharacters)));
}

function positiveOverride(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function modelCapabilities(metadata: ResolvedModelMetadata): CopilotCompatibleCapabilities {
  const supportsVision = metadata.supportsVision;
  return {
    imageInput: supportsVision,
    toolCalling: 128,
    supportsImageToText: supportsVision,
    supportsToolCalling: true
  };
}

function shouldHideDeprecatedModel(
  modelId: string,
  vendor: ProviderDefinition["vendor"],
  snapshot: CachedModelMetadataSnapshot,
): boolean {
  return snapshot.providers[vendor][modelId]?.status === "deprecated";
}

function resolveRawModelId(modelId: string): string {
  const [base] = modelId.split("::");
  const prefix = `${INFERHUB_VENDOR}:`;
  if (base.startsWith(prefix)) {
    return base.slice(prefix.length);
  }
  return base;
}

function displayModelId(modelId: string): string {
  const slashIndex = modelId.lastIndexOf("/");
  return slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);
}

function formatModelName(modelId: string): string {
  const parts = modelId.split("-");
  const displayParts: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (/^\d+$/.test(part) && /^\d+$/.test(parts[index + 1] ?? "")) {
      const versionParts = [part];

      while (/^\d+$/.test(parts[index + 1] ?? "")) {
        versionParts.push(parts[index + 1]);
        index += 1;
      }

      displayParts.push(versionParts.join("."));
      continue;
    }

    displayParts.push(part);
  }

  return displayParts
    .map((part) => part.toUpperCase() === part ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
