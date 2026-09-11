// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export function buildInferhubAuthHeaders(
  apiKey: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}