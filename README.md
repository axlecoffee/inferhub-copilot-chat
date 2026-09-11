# InferHub Copilot Chat

BYOK InferHub models in GitHub Copilot Chat. No Copilot Pro needed.

One `sk-airo-` key gets you the full InferHub marketplace: Muse Spark with a 1,048,576 token context window, Claude, GPT, GLM, Kimi, DeepSeek and friends, routed cheapest-first. This extension registers the catalog as a language model provider so it shows up in the Copilot Chat model picker next to GPT and Claude.

## Quick start

1. Install [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) (required) and this extension.
2. Open Copilot Chat.
3. Click the model picker, then **Manage Models**.
4. Select **InferHub**, accept the group name, and paste your `sk-airo-` API key.
5. Pick a model and chat.

Get an API key from [InferHub](https://inferhub.dev).

## Models

The extension fetches the live catalog from `https://api.inferhub.dev/v1/models` and falls back to the bundled Muse Spark entries when offline:

| Model | Context window |
|---|---:|
| `cmc/meta/muse-spark-1.2` | 1,048,576 |
| `cmc/meta/muse-spark-1.2-contributor` | 1,048,576 |
| `cmc/meta/muse-spark-1.3` | 1,048,576 |
| `cmc/meta/muse-spark-1.3-contributor` | 1,048,576 |

The contributor tier is cheaper because the upstream trains on your prompts and completions. The standard tier does not.

## Endpoint

OpenAI-compatible responses and chat completions at `https://api.inferhub.dev/v1`. Tool calling works, so agent mode functions normally.

## Usage

Run **InferHub: Show InferHub Usage** for a breakdown of the last 24 hours straight from the InferHub management API: per-provider token/cost/latency/speed tables plus per-request rows (status, tokens, cost, TTFT, duration, tok/s).

The status bar also shows a per-response prompt/output token summary with cost when the API reports it.

## Settings

| Setting | Default | Description |
|---|---|---|
| `inferhub.baseUrl` | *(empty)* | Override the API base URL |
| `inferhub.temperature` | `0.2` | Sampling temperature (0 to 2) |
| `inferhub.maxTokens` | `0` | Max output token override (0 = per-model default) |
| `inferhub.maxInputTokens` | `0` | Context size override advertised to VS Code |
| `inferhub.contextWindowLimit` | `full` | Cap the advertised context window (`full`, `1m`, `512k`, ... `32k`) |
| `inferhub.thinking.effort` | `Auto` | Reasoning effort (`Auto`, `Minimal`, `Low`, `Medium`, `High`, `XHigh`) |
| `inferhub.requestTimeoutSeconds` | `300` | Total request timeout |
| `inferhub.streamIdleTimeoutSeconds` | `90` | Cancel if the stream goes silent this long |
| `inferhub.showUsageStatusBar` | `true` | Token usage summary in the status bar |
| `inferhub.debugLogging` | `false` | Verbose diagnostics to the output channel |
| `inferhub.debugReasoning` | `false` | Request/response diagnostics (reasoning itself is private to the API) |
| `inferhub.experimentalContextIndicator` | `false` | Inject real usage into the context indicator via VS Code internals |

## Commands

| Command | What it does |
|---|---|
| `InferHub: Manage Provider` | Manage API key, refresh models, test connection |
| `InferHub: Set API Key` | Store or update your `sk-airo-` key |
| `InferHub: Show InferHub Usage` | 24h usage breakdown from the management API |
| `InferHub: Diagnostics` | Registered models and recent request summaries |
| `InferHub: Model Picker Diagnostics` | Inspect what the model picker sees |

Your API key is stored in VS Code SecretStorage, encrypted by the OS keychain. It is only ever sent to `api.inferhub.dev` and `inferhub.dev`.

## Development

```bash
pnpm install
pnpm run compile      # build
pnpm run watch        # watch mode
pnpm run package      # create .vsix
```

Press F5 to launch an Extension Development Host.

## Credits

- [ltmoerdani](https://github.com/ltmoerdani) built [opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat). He borrowed an opencode go plugin and modified it for Xiaomi MiMo; that did not work well, I edited his MiMo plugin until it did, then used my edited version for Meta Muse. This extension is that codebase rewired for InferHub.
- Model docs: [inferhub.dev/docs](https://inferhub.dev/docs)

## License

This project is licensed under AGPL-3.0-or-later. See [LICENSE](./LICENSE).

The upstream work this fork descends from is credited under its original MIT license:

> Copyright (c) 2026 ltmoerdani
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
