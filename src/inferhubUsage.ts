// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export type UsageRange = "24h" | "7d" | "30d" | "90d" | "all";

export interface UsageLogRow {
  id: string;
  ts: string;
  status: string;
  http_status: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_tokens?: number | null;
  cache_write_tokens?: number | null;
  cost_consumer_usdc: string;
  model?: string | null;
  upstream_label?: string | null;
  ttft_ms?: number | null;
  duration_ms?: number | null;
}

export interface UsageLogPage {
  rows: UsageLogRow[];
  total: number;
  rangeTotal: number;
  totalCostUsdc: string;
  totalTokens: number;
  totalSavedUsdc: string;
  range: string;
}

const MANAGEMENT_API_BASE = "https://inferhub.dev/api";
const USAGE_LOG_PAGE_SIZE = 100;

export async function fetchUsageLogPage(
  apiKey: string,
  range: UsageRange,
): Promise<UsageLogPage> {
  const url =
    `${MANAGEMENT_API_BASE}/usage/logs?range=${encodeURIComponent(range)}` +
    `&pageSize=${USAGE_LOG_PAGE_SIZE}&sort=ts&dir=desc`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `InferHub usage request failed (HTTP ${response.status}): ${responseText.slice(0, 200)}`,
    );
  }

  const page = JSON.parse(responseText) as UsageLogPage;
  if (!Array.isArray(page.rows)) {
    throw new Error("InferHub usage response is missing rows.");
  }
  return page;
}

interface ProviderUsageRow {
  provider: string;
  requests: number;
  failedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsdc: number;
  ttftSumMs: number;
  ttftSamples: number;
  durationSumMs: number;
}

export function aggregateProviderRows(rows: UsageLogRow[]): ProviderUsageRow[] {
  const byProvider = new Map<string, ProviderUsageRow>();

  for (const row of rows) {
    const provider = row.upstream_label || row.model || "Unknown";
    let entry = byProvider.get(provider);
    if (!entry) {
      entry = {
        provider,
        requests: 0,
        failedRequests: 0,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        costUsdc: 0,
        ttftSumMs: 0,
        ttftSamples: 0,
        durationSumMs: 0,
      };
      byProvider.set(provider, entry);
    }

    entry.requests += 1;
    if (row.status !== "ok") {
      entry.failedRequests += 1;
    }
    entry.inputTokens += row.prompt_tokens ?? 0;
    entry.cachedTokens += row.cached_tokens ?? 0;
    entry.outputTokens += row.completion_tokens ?? 0;
    entry.costUsdc += Number.parseFloat(row.cost_consumer_usdc) || 0;
    if (typeof row.ttft_ms === "number" && row.ttft_ms > 0) {
      entry.ttftSumMs += row.ttft_ms;
      entry.ttftSamples += 1;
    }
    if (typeof row.duration_ms === "number" && row.duration_ms > 0) {
      entry.durationSumMs += row.duration_ms;
    }
  }

  return [...byProvider.values()].sort((a, b) => b.costUsdc - a.costUsdc);
}

function formatTokensCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

function formatCostUsdc(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 6 : 2)}`;
}

function formatSpeed(tokens: number, durationMs: number): string {
  if (durationMs <= 0 || tokens <= 0) {
    return "-";
  }
  return `${(tokens / (durationMs / 1000)).toFixed(1)} tok/s`;
}

function formatCellInputPlusCache(input: number, cached: number): string {
  const base = formatTokensCompact(input);
  return cached > 0 ? `${base}(+${formatTokensCompact(cached)})` : base;
}

function requestStatusIcon(row: UsageLogRow): string {
  if (row.http_status >= 200 && row.http_status < 300 && row.status === "ok") {
    return "✅";
  }
  return `❌ ${row.http_status}`;
}

function formatRequestTime(ts: string): string {
  return new Date(ts).toLocaleString();
}

export function formatUsageReport(page: UsageLogPage): string {
  const providers = aggregateProviderRows(page.rows);
  const lines: string[] = [
    `# InferHub Usage (${page.range})`,
    "",
    `Totals: ${formatTokensCompact(page.totalTokens)} tokens · ` +
      `${formatCostUsdc(Number.parseFloat(page.totalCostUsdc) || 0)} · ` +
      `${page.rangeTotal} requests · ` +
      `saved ${formatCostUsdc(Number.parseFloat(page.totalSavedUsdc) || 0)} vs official pricing`,
    "",
    "## Providers",
    "",
    "| Provider | Input(+Cache)+Output=Total | Cost | Reqs | Latency (TTFT) | Speed |",
    "|---|---:|---:|---:|---:|---:|",
  ];

  for (const p of providers) {
    const total = p.inputTokens + p.outputTokens;
    const avgTtft =
      p.ttftSamples > 0 ? Math.round(p.ttftSumMs / p.ttftSamples) : 0;
    const latency = avgTtft > 0 ? `${avgTtft}ms` : "-";
    const speed = formatSpeed(p.outputTokens, p.durationSumMs);
    const requests =
      p.failedRequests > 0
        ? `${p.requests} (${p.failedRequests} failed)`
        : String(p.requests);
    lines.push(
      `| ${p.provider} | ` +
        `${formatCellInputPlusCache(p.inputTokens, p.cachedTokens)}+${formatTokensCompact(p.outputTokens)}=${formatTokensCompact(total)} | ` +
        `${formatCostUsdc(p.costUsdc)} | ${requests} | ${latency} | ${speed} |`,
    );
  }

  lines.push(
    "",
    `## Recent Requests (latest ${page.rows.length})`,
    "",
    "| Provider | Time | Status | Input(+Cache) | Output | Cost | TTFT | Duration | Speed |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
  );

  for (const row of page.rows) {
    const provider = row.upstream_label || row.model || "Unknown";
    const speed = formatSpeed(
      row.completion_tokens ?? 0,
      row.duration_ms ?? 0,
    );
    lines.push(
      `| ${provider} | ${formatRequestTime(row.ts)} | ${requestStatusIcon(row)} | ` +
        `${formatCellInputPlusCache(row.prompt_tokens ?? 0, row.cached_tokens ?? 0)} | ` +
        `${formatTokensCompact(row.completion_tokens ?? 0)} | ` +
        `${formatCostUsdc(Number.parseFloat(row.cost_consumer_usdc) || 0)} | ` +
        `${row.ttft_ms != null ? `${Math.round(row.ttft_ms)}ms` : "-"} | ` +
        `${row.duration_ms != null ? `${Math.round(row.duration_ms)}ms` : "-"} | ${speed} |`,
    );
  }

  return lines.join("\n");
}
