# StructuredPrefill clean

An original SillyTavern UI extension that turns an assistant prefix into a JSON Schema response constraint, then unwraps the returned `{ "value": "…" }` into chat text. The compact settings panel follows the supplied visual reference.

Written from the reference project's README as a behavioral specification and SillyTavern's public host interfaces. No code was copied from the reference implementation.

## Install

Repository: https://github.com/fadust/prefill-extension

In SillyTavern, open **Extensions → Install extension** and enter the repository URL. This repository is private: the machine running SillyTavern needs Git credentials with access. Do not embed a token in the URL. Alternatively, download the repository ZIP, extract it, and copy its contents into `public/scripts/extensions/third-party/prefill-extension` in your SillyTavern installation. `manifest.json` must be directly inside that folder. Reload SillyTavern.

The extension has no npm dependencies, build step, server plugin, or external scripts. Only `manifest.json`, `index.js`, `core.js`, `settings.html`, and `styles.css` are needed to run it. Test and preview files are development tools.

## First use

1. Choose **Chat Completion** and a model/provider that enforces JSON Schema **string patterns**. Support for JSON mode alone is insufficient.
2. Set the number of completions to **1** and disable function calling for this request.
3. Open **StructuredPrefill clean** in Extensions. It starts disabled.
4. Enable it and use the local override, for example `[[keep]]{{char}}: `. SillyTavern expands normal macros.
5. Generate a reply and read **Last status**. “Validated and unwrapped” means the returned JSON passed local checks. “Applied: JSON Schema prefix constraint” means the request was transformed; it is not confirmation that the provider accepted it.

With local override off, the extension treats the final text-only assistant request message as the prefill and removes that message from the outgoing request copy. Use a final assistant prompt in SillyTavern's Prompt Manager for this mode. Do not use it when that final message is ordinary history you want to retain. The saved chat is never used as the mutable request array.

The default is a neutral character-name prefix, 80 minimum continuation characters, and `<NL>` as the newline placeholder. No built-in instructions ask the model to change its safety behavior or disclose private reasoning.

## Settings

| Setting | Behavior |
| --- | --- |
| Enabled | Opts in to request transformation. Disabled requests pass through. |
| Hide prefill | Removes the matched hidden portion before display **and saving**. Changes apply to future generations. |
| Local override | Uses the text box instead of consuming the final assistant request message. |
| Minimum characters | Requests a minimum continuation length and validates decoded text afterward. Ignored with an end marker. |
| Newline token | Encodes template line breaks; decodes the placeholder throughout the reply. Pick a token absent from your template and intended prose. |
| Continue overlap | Repeats the final N Unicode characters as a literal schema prefix, then removes that repeated prefix from the continuation. Zero removes the overlap requirement. |
| Banned phrases | Literal substring bans; ASCII letters are case-insensitive. Maximum 30 phrases of 80 characters each. |
| Custom/NanoGPT support | Explicitly enables those routes after you establish your selected model supports patterns. |

`[[keep]]` is a zero-width template marker: text before it is hidden, and text after it remains visible. Without a keep marker, Hide removes the entire matched template. The marker itself is never generated. Template slots are matched against the generated prefix, so a cutoff may follow a variable slot. Prefer fixed delimiters after variable slots to make the boundary unambiguous.

**Continue:** uses the last assistant reply as context, never invokes `[[pg]]`, and treats overlap text literally even if it contains marker-like text. Streaming uses the exact saved base; standard non-stream replies are checked against that base before editing. Select **Continue Postfix → None** for a predictable join, especially with non-streaming. Reasoning-only continuation and other host cleanup settings can change the base; when it cannot be matched, the extension leaves the reply intact.

## Template slots

| Slot | Constraint |
| --- | --- |
| `[[w:2]]`, `[[words:2-5]]` | Word counts, 1–100. Words exclude whitespace, double quotes, and asterisks; spaces/tabs separate them. |
| `[[opt:yes\|no\|maybe]]` | One of the literal choices. |
| `[[re:[A-Z]{2,4}]]` | Restricted custom regex, up to 256 characters. `/pattern/flags` form is accepted; flags are ignored. |
| `[[free]]` | Non-empty text. At most one free-text slot per template. |
| `[[line]]`, `[[lines:2-4]]` | Non-empty lines; line-count bounds are 1–20. |
| `[[name]]` | User, character, or current group-member names; otherwise a capitalized-name pattern. |
| `[[action]]`, `[[thought]]` | Text of 1–6 or 1–10 words. These are formatting slots, not requests for a model's private reasoning. |
| `[[emotion]]`, `[[mood]]` | One of 50 fixed lowercase mood labels. |
| `[[num]]` | An integer, without leading zeros. |
| `[[number:-10-100]]` | An **exact** inclusive integer interval, bounded to ±1 billion. |
| `[[end]]`, `[[stop]]`, `[[eos]]` | Ends the template with no continuation. Must be the final item. |
| `[[pg]]` | Inserts an opening generated with your selected connection profile. |

Custom regexes support literals, character classes, alternation, and at most one bounded or optional quantifier. Groups, backreferences, lookarounds, unbounded repeats, stacked quantifiers, and anchors are rejected. Value slots must have literal text between them; templates allow at most 32 value slots. Unknown or unclosed slots are reported before modifying the outgoing request. The template limit is 4,000 characters and the schema pattern limit is 16,000.

Example:

```text
[[keep]][STATUS]
Location: [[w:1-6]]
Mood: [[emotion]]
HP: [[number:0-100]]

{{char}}: 
```

## Optional prefill generator

Select a SillyTavern Connection Manager profile, set its prompt/token limit/timeout, and include `[[pg]]` in the template. The generator sends a **text-only copy of the outgoing conversation** to that profile. This is an extra model request, may cost money, and uses the profile's existing credentials through SillyTavern. It does not switch the active connection or read API keys. Preset inclusion is disabled so its explicit prompt is predictable.

Stop strings are applied to the returned text locally, before insertion. On failure or timeout, `[[pg]]` becomes empty and Last status explains the fallback. Stops and chat changes abort the generator. It is unused without the marker or during Continue.

## Presets

Save, load, delete, and copy/paste versioned JSON presets in the Local presets section. Presets stay in SillyTavern extension settings. Import and load start disabled and clear the generator profile, preventing an imported preset from enabling an extra API request automatically. No community preset is fetched automatically.

## Compatibility and deliberate differences

This implements the extension workflow; the reference's separate proxy is outside this package.

The request hook uses SillyTavern's `json_schema = { name, strict, value }` format, which its server maps to provider response formats. Enabled routes are OpenAI, Azure OpenAI, OpenRouter, Groq, and Fireworks; Custom and NanoGPT are opt-in. **A listed route does not imply every model supports the required schema.** Direct Anthropic and text-completion backends are skipped. Unsupported models may reject the request or ignore constraints; there is no automatic paid retry or silent capability downgrade.

Banned phrases use a small negative-lookahead regex rather than the reference's DFA construction. Bans and line/word slots therefore need lookahead support, which some structured-output engines lack. Disable those constraints or choose a compatible provider if it rejects them. Regex restrictions and limits keep the implementation inspectable, but complex combinations can still be expensive; keep templates short.

Line placeholders make encoded lengths differ from visible lengths. The schema constrains the encoded reply, and the extension separately checks the decoded continuation minimum. A provider may pass its own validation yet fail this stricter local check. JSON Schema patterns also cannot guarantee that a model will comply instead of returning a refusal or API error.

Streaming wraps only the current generation's iterator through its `onStartStreaming` method, then unwraps chunks **before** SillyTavern renders them. This uses a host implementation detail, guarded at runtime. If the compatible hook is unavailable, the extension skips transformation. Standard replies are unwrapped at `MESSAGE_RECEIVED`; other host response-cleanup or regex extensions run earlier and can alter the JSON. Turn off such processing if it causes parsing errors.

Tool calls, multiple completions, quiet/impersonate requests, and existing response schemas are skipped to avoid conflicting request formats. An existing schema is never overwritten. Hidden content is removed from future saved replies, not retroactively from old messages.

## Recovery and privacy

Malformed, interrupted, and constraint-violating replies show a status message. Standard replies remain intact on validation failure. Streaming retains the safely decoded partial text (or plain refusal) and stores the raw output in `message.extra.structuredPrefillClean.raw` with an error. This recovery data is saved locally with the chat and may include hidden prefill text. Successful replies store only a validation flag, not a duplicate raw response.

No telemetry, external code/CDN loading, arbitrary code execution, global networking patches, or credential collection. All model requests go through SillyTavern's existing services. Data you choose to send remains subject to your model provider's behavior.

The parser stops processing envelopes above 1 MB. Streaming re-parses accumulated chunks; exceptionally long replies may need an incremental decoder in a future revision.

## Development and verification

Node.js is the only development requirement; no `npm install` is needed.

```sh
npm test
npm run check
node dev/server.mjs
```

Open `http://127.0.0.1:8787` for the settings UI and simulated streamed/standard/Continue/recovery demos. The preview uses a fake host and makes no model API requests. It listens only on localhost and serves an explicit file allowlist.

Automated checks cover escaping, slots, exact integer intervals, banned phrases, every streaming split of a JSON string, Unicode, invalid settings, pass-through behavior, request isolation, stream state, swipes, Continue joining, generator success/failure, and single initialization. Browser checks cover settings rendering and simulated reply handling. **These checks are not a live SillyTavern/provider certification:** test a short reply with your installed host version and chosen model before relying on the extension.

Sources consulted:

- [Reference README (behavioral spec)](https://github.com/aimicrocot/StructuredPrefill-Cheesedozer-Edition/blob/main/README.md)
- [SillyTavern UI extension documentation](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern Prompt Manager and Continue settings](https://docs.sillytavern.app/usage/prompts/prompt-manager/)
- [Official chat-completion frontend](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js)
- [Official stream processor and reply lifecycle](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js)
- [Official extension context](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js)
- [Official connection-profile request service](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/shared.js)
- [Official JSON Schema backend mapping](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/backends/chat-completions.js)
