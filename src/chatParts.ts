// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";
import {
  hasUsageSnapshot,
  toProviderUsagePayload,
  type UsageSnapshot,
} from "./usage";

export const MUSE_USAGE_DATA_MIME = "application/vnd.muse.usage+json";
export const COPILOT_USAGE_DATA_MIME = "usage";

export function createUsageDataPart(
  usage: UsageSnapshot,
): vscode.LanguageModelDataPart | undefined {
  return createUsageDataParts(usage)[0];
}

export function createUsageDataParts(
  usage: UsageSnapshot,
): vscode.LanguageModelDataPart[] {
  if (!hasUsageSnapshot(usage)) {
    return [];
  }

  const payload = toProviderUsagePayload(usage);
  if (!payload) {
    return [];
  }

  const data = new TextEncoder().encode(JSON.stringify(payload));
  return [
    new vscode.LanguageModelDataPart(data, COPILOT_USAGE_DATA_MIME),
    new vscode.LanguageModelDataPart(data, MUSE_USAGE_DATA_MIME),
  ];
}

export function isInternalDataPart(
  part: vscode.LanguageModelDataPart,
): boolean {
  return part.mimeType === MUSE_USAGE_DATA_MIME
    || part.mimeType === COPILOT_USAGE_DATA_MIME;
}
