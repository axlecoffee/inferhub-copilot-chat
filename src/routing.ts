// SPDX-FileCopyrightText: 2026 axlecoffee
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  INFERHUB_VENDOR,
  type ProviderRoutingDefinition,
} from "./providerTypes";

export function resolveModelRouting(
  _modelId: string,
  provider: ProviderRoutingDefinition,
): {
  endpointKind: "responses";
  endpointUrl: string;
  sdkPackage?: string;
} {
  return {
    endpointKind: "responses",
    endpointUrl: provider.responsesUrl ?? provider.chatCompletionsUrl.replace("/chat/completions", "/responses"),
    sdkPackage: "@ai-sdk/openai-compatible",
  };
}
