// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export const MUSE_VENDOR = "meta-muse" as const;

export type ProviderVendor = typeof MUSE_VENDOR;

export interface ProviderRoutingDefinition {
  vendor: ProviderVendor;
  chatCompletionsUrl: string;
  messagesUrl: string;
  modelsUrl: string;
  responsesUrl?: string;
}
