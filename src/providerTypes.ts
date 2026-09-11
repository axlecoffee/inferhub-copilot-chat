// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export const INFERHUB_VENDOR = "inferhub" as const;

export type ProviderVendor = typeof INFERHUB_VENDOR;

export interface ProviderRoutingDefinition {
  vendor: ProviderVendor;
  chatCompletionsUrl: string;
  messagesUrl: string;
  modelsUrl: string;
  responsesUrl?: string;
}
