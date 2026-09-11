# Muse Copilot Chat

BYOK Meta Muse models in GitHub Copilot Chat. No Copilot Pro needed.

Muse Spark runs on Meta's Model API with a 1,048,576 token context window and pay-as-you-go pricing. This extension registers it as a language model provider so it shows up in the Copilot Chat model picker next to GPT and Claude.

## Quick start

1. Install [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) (required) and this extension.
2. Open Copilot Chat.
3. Click the model picker, then **Manage Models**.
4. Select **Muse (Meta)**, accept the group name, and paste your API key.
5. Pick a model and chat.

Get an API key from the [Meta Model API dashboard](https://dev.meta.ai).

## Models

| Model | Tier | Context window |
|---|---|---:|
| `muse-spark-1.1` | Standard | 1,048,576 |
| `muse-spark-1.2` | Standard | 1,048,576 |
| `muse-spark-1.2-contributor` | Contributor | 1,048,576 |

The extension fetches the live model list from the API and falls back to this bundled catalog when offline.

### Pricing

Per 1M tokens ([source](https://dev.meta.ai/docs/pricing-rate-limits)):

| Usage | Standard (`1.1`, `1.2`) | Contributor (`1.2-contributor`) |
|---|---:|---:|
| Cached input | $0.15 | $0.002 |
| Input | $1.25 | $0.10 |
| Output | $4.25 | $0.20 |

The contributor tier is cheaper because Meta trains on your prompts and completions. The standard tier does not.

## Endpoint

OpenAI-compatible chat completions at `https://api.meta.ai/v1`. Tool calling works, so agent mode functions normally.

## Settings

| Setting | Default | Description |
|---|---|---|
| `meta-muse.baseUrl` | *(empty)* | Override the API base URL |
| `meta-muse.temperature` | `0.2` | Sampling temperature (0 to 2) |
| `meta-muse.maxTokens` | `0` | Max output token override (0 = per-model default) |
| `meta-muse.maxInputTokens` | `0` | Context size override advertised to VS Code |
| `meta-muse.contextWindowLimit` | `full` | Cap the advertised context window (`full`, `1m`, `512k`, ... `32k`) |
| `meta-muse.thinking.effort` | `Auto` | Reasoning effort (`Auto`, `Minimal`, `Low`, `Medium`, `High`, `XHigh`) |
| `meta-muse.requestTimeoutSeconds` | `300` | Total request timeout |
| `meta-muse.streamIdleTimeoutSeconds` | `90` | Cancel if the stream goes silent this long |
| `meta-muse.showUsageStatusBar` | `true` | Token usage summary in the status bar |
| `meta-muse.debugLogging` | `false` | Verbose diagnostics to the output channel |
| `meta-muse.debugReasoning` | `false` | Request/response diagnostics (reasoning itself is private to the API) |
| `meta-muse.experimentalContextIndicator` | `false` | Inject real usage into the context indicator via VS Code internals |

## Commands

| Command | What it does |
|---|---|
| `Muse: Manage Provider` | Manage API key, refresh models, test connection |
| `Muse: Set API Key` | Store or update your API key |
| `Muse: Diagnostics` | Registered models and recent request summaries |
| `Muse: Model Picker Diagnostics` | Inspect what the model picker sees |

Your API key is stored in VS Code SecretStorage, encrypted by the OS keychain. It is only ever sent to `api.meta.ai`.

## Development

```bash
pnpm install
pnpm run compile      # build
pnpm run watch        # watch mode
pnpm run package      # create .vsix
```

Press F5 to launch an Extension Development Host.

## Credits

- [ltmoerdani](https://github.com/ltmoerdani) built [opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat). He borrowed an opencode go plugin and modified it for Xiaomi MiMo; that did not work well, I edited his MiMo plugin until it did, then used my edited version for Meta Muse. Here we are.
- Model docs: [dev.meta.ai/docs](https://dev.meta.ai/docs)

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
