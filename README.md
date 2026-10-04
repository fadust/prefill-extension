# StructuredPrefill clean

An original SillyTavern UI extension that turns an assistant prefix into a JSON Schema response constraint, then unwraps the returned `{ "value": "…" }` into chat text. The compact settings panel follows the supplied visual reference.

Written from the reference project's README as a behavioral specification and SillyTavern's public host interfaces. No code was copied from the reference implementation.

## Install

Repository: https://github.com/fadust/prefill-extension

In SillyTavern, open **Extensions → Install extension** and enter the repository URL. This repository is private: the machine running SillyTavern needs Git credentials with access. Do not embed a token in the URL. Alternatively, download the repository ZIP, extract it, and copy its contents into `public/scripts/extensions/third-party/prefill-extension` in your SillyTavern installation. `manifest.json` must be directly inside that folder. Reload SillyTavern.

The extension has no npm dependencies, build step, server plugin, or external scripts. Only `manifest.json`, `index.js`, `core.js`, `bans.js`, `settings.html`, and `styles.css` are needed to run it. Test and preview files are development tools.

## First use

1. Choose **Chat Completion** and a model/provider that enforces JSON Schema **string patterns**. Support for JSON mode alone is insufficient.
2. Set the number of completions to **1** and disable function calling for this request.
3. Open **StructuredPrefill clean** in Extensions. It starts disabled.
4. Enable it and use the local override, for example `[[keep]]{{char}}: `. SillyTavern expands normal macros.
5. Generate a reply and read **Last status**. “Validated and unwrapped” means the returned JSON passed local checks. “Applied: JSON Schema prefix constraint” means the request was transformed; it is not confirmation that the provider accepted it.

The final non-system assistant message is treated as the prefill; trailing system instructions remain in place. With local override off its text becomes the schema prefix; with override on it is replaced by the text box. Use a final assistant prompt in SillyTavern's Prompt Manager for this mode. Do not put ordinary history there that you want retained as conversation context. The saved chat is never used as the mutable request array.

The default is a neutral character-name prefix, 80 minimum continuation characters, and `<NL>` as the newline placeholder. No built-in instructions ask the model to change its safety behavior or disclose private reasoning.

## Settings

| Setting | Behavior |
| --- | --- |
| Enabled | Opts in to request transformation. Disabled requests pass through. |
| Hide prefill | Removes the matched hidden portion before display **and saving**. Changes apply to future generations. |
| Local override | Uses the text box instead of consuming the final assistant request message. |
| Minimum characters | Requests a minimum continuation length and validates decoded text afterward. Ignored with an end marker. |
| Newline token | Encodes template line breaks; decodes the placeholder throughout the reply. Pick a token absent from your template and intended prose. |
| Schema regex mode | Auto chooses portable mode for Claude/Anthropic model names; Standard and Portable can be selected explicitly. |
| Stream guard | Stops growing streams with no decoded progress for 15 seconds after 5,000 characters, or 2,048 consecutive repeated/whitespace padding characters. Can be disabled; the 1 MB budget always applies. |
| Continue overlap | Repeats the final N Unicode characters as a literal schema prefix, then removes that repeated prefix from the continuation. Zero removes the overlap requirement. |
| Banned phrases | Literal substring bans; ASCII letters are case-insensitive. Maximum 30 phrases of 80 characters each. |
| Custom/NanoGPT support | Explicitly enables those routes after you establish your selected model supports patterns. |

`[[keep]]` is a zero-width template marker: text before it is hidden, and text after it remains visible. Without a keep marker, Hide removes the entire matched template. The marker itself is never generated. Template slots are matched against the generated prefix, so a cutoff may follow a variable slot. Prefer fixed delimiters after variable slots to make the boundary unambiguous.

**Continue:** uses the last assistant reply as context, never invokes `[[pg]]`, and treats overlap text literally even if it contains marker-like text. The local override (or an identifiable Prompt Manager prefix before the saved base) is included in the schema, then removed along with the overlap before appending. `[[keep]]` and end markers are ignored here; the full prefix is hidden. Streaming uses the exact saved base; standard non-stream replies are checked against that base before editing. Select **Continue Postfix → None** for a predictable join, especially with non-streaming. Reasoning-only continuation and other host cleanup settings can change the base; when it cannot be matched, the extension leaves the reply intact.

## Template slots

| Slot | Constraint |
| --- | --- |
| `[[w:2]]`, `[[words:2-5]]` | Word counts, 1–100. Spaces/tabs separate words; comma-joined words do not count as one, but trailing commas are allowed. |
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

`[[options:yes,no]]` and `[[regex:…]]` aliases are supported. A `|hint:…` suffix is accepted as annotation and does not alter the constraint. Portable mode unrolls bounded counts exactly; custom regex in that mode cannot use brace quantifiers or whitespace shorthand classes. Portable word/line slots exclude the first character of the newline token to avoid needing a lookahead, so a `<NL>` token makes `<` unavailable inside those slots.

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

The assistant prefill is removed from generator context. The optional prompt can use System, User, or Assistant role; Assistant is inserted before the final user message. Stop strings are sent to the profile API and checked locally before insertion. Keep-stop retains a matched string if the provider returns it; it cannot recover stop text a provider omits from its response. On failure or timeout, `[[pg]]` becomes empty and Last status explains the fallback. Stops and chat changes abort the generator. It is unused without the marker or during Continue.

## Presets

Save, load, rename, delete, and copy/paste JSON presets in the Local presets section. Both clean version 1 JSON and the reference extension's flat exported preset format are accepted. Reference fields are mapped and validated; unsupported limits are rejected. Import and load start disabled and clear the generator profile. After importing, use Save to retain the preset in the list. No community preset is fetched automatically.

`/sp-clean-preset <name>` loads a saved preset; `/sp-clean-preset-list` returns names as JSON. Names differ from the reference's commands to avoid collisions if both extensions are installed. Loading from a command has the same disabled/profile-cleared behavior as the UI.

## Compatibility and deliberate differences

This implements the extension workflow; the reference's separate proxy is outside this package.

The request hook uses SillyTavern's `json_schema = { name, strict, value }` format, which its server maps to provider response formats. Enabled routes are OpenAI, Azure OpenAI, OpenRouter, Groq, and Fireworks; Custom and NanoGPT are opt-in. **A listed route does not imply every model supports the required schema.** Direct Anthropic and text-completion backends are skipped. Unsupported models may reject the request or ignore constraints; there is no automatic paid retry or silent capability downgrade.

Standard mode uses a negative lookahead to ban phrases anywhere in the reply. Portable mode uses an original, exact DFA-to-regex compiler on the **continuation**, handles overlapping matches and incomplete endings, and avoids lookaheads, whitespace shorthands, non-ASCII pattern literals, and bounded-count quantifiers. To prevent runaway compiler growth it allows up to 60 ban-prefix states and 16,000 pattern characters; complex lists are rejected explicitly. Local validation rejects banned phrases anywhere in either mode, including the generated prefix. A prefix that itself contains a ban therefore cannot validate.

Portable schemas enforce an overall string `minLength`; the decoded continuation minimum is checked locally because combining a prefix, a banned-substring automaton, and an exact continuation length would greatly enlarge the pattern. Last status identifies the selected mode. Other provider schema restrictions can still cause rejection. Auto uses a model-name hint, not a live capability probe. The schema-preview button shows Standard for Auto because it has no outgoing model to inspect.

Line placeholders make encoded lengths differ from visible lengths. The schema constrains the encoded reply, and the extension separately checks the decoded continuation minimum. A provider may pass its own validation yet fail this stricter local check. JSON Schema patterns also cannot guarantee that a model will comply instead of returning a refusal or API error.

Streaming wraps only the current generation's iterator through its `onStartStreaming` method, then unwraps chunks **before** SillyTavern renders them. This uses a host implementation detail, guarded at runtime. If the compatible hook is unavailable, the extension skips transformation. Standard replies are unwrapped at `MESSAGE_RECEIVED`; other host response-cleanup or regex extensions run earlier and can alter the JSON. Turn off such processing if it causes parsing errors.

Tool calls, multiple completions, quiet/impersonate requests, and existing response schemas are skipped to avoid conflicting request formats. An existing schema is never overwritten. Hidden content is removed from future saved replies, not retroactively from old messages.

## Recovery and privacy

**Thinking stops before an answer (v1.1.1):** reasoning models can exhaust a small response limit during reasoning. A 300-token limit may produce only the host's Thought block and no answer. The extension reports an empty/reasoning-only response explicitly and warns when a model named `thinking` or `reasoning` has a response limit below 1,024 tokens. Increase the host's response limit or select a non-thinking model, then regenerate. Increasing the limit can increase cost; the extension never changes it or retries automatically. Hiding reasoning does not guarantee that reasoning stops consuming tokens. See [NanoGPT's reasoning documentation](https://docs.nano-gpt.com/api-reference/miscellaneous/extended-thinking).

Continue can now recover an existing assistant message with empty answer text when local override is enabled. It asks for the final reply, without adding empty-answer overlap or treating the previous reasoning as visible prose. Earlier conversation remains intact. Without local override, use Regenerate or enable the override. The host's separate reasoning display remains host-managed; Hide prefill only removes the matched template portion from answer text.

v1.1.2 identifies a missing/changed required prefix separately from other constraint failures and explicitly tells the model that the prefix belongs inside `value`, not in the reasoning field. A neutral prefix such as `[[keep]]Narrator: ` avoids markup that host reasoning parsers can intercept. Provider pattern enforcement still must be verified; an incompatible reply remains unvalidated and recoverable, never relabeled as successful.

Malformed, interrupted, and constraint-violating replies show a status message. Standard replies remain intact on validation failure. Streaming retains the safely decoded partial text (or plain refusal) and stores the raw output in `message.extra.structuredPrefillClean.raw` with an error. This recovery data is saved locally with the chat and may include hidden prefill text. Successful replies store only a validation flag, not a duplicate raw response.

No telemetry, external code/CDN loading, arbitrary code execution, global networking patches, or credential collection. All model requests go through SillyTavern's existing services. Data you choose to send remains subject to your model provider's behavior.

The parser stops processing envelopes above 1 MB. Streaming incrementally decodes new characters, preserving split escapes and surrogate pairs, and validates the complete envelope at the end. Changing the chat or active swipe cancels a structured stream without updating the newly selected reply. The guard operates on decoded progress before prefix hiding so long hidden prefixes are not mistaken for stalls. It depends on SillyTavern's stop-generation interface to cancel the provider request.

## Development and verification

Node.js is the only development requirement; no `npm install` is needed.

```sh
npm test
npm run check
node dev/server.mjs
```

Open `http://127.0.0.1:8787` for the settings UI and simulated streamed/standard/Continue/recovery demos. The preview uses a fake host and makes no model API requests. It listens only on localhost and serves an explicit file allowlist.

The 23 automated checks cover escaping, slots, exact integer intervals, exhaustive short-string ban comparisons, portable regex syntax, every streaming split of a JSON string, Unicode, guards, invalid settings, pass-through behavior, request isolation, stream state, swipe changes, Continue joining, reasoning-only cutoff recovery, generator success/failure, preset migration, and single initialization. Browser checks cover settings rendering and simulated reply handling. **These checks are not a live SillyTavern/provider certification:** test a short reply with your installed host version and chosen model before relying on the extension.

## Reference code comparison (v1.1)

Compared the reference's `index.js`, settings, manifest, and the official SillyTavern host code. All adopted behavior below was implemented independently.

| Gap in v1.0 | v1.1 adoption |
| --- | --- |
| Lookahead/shorthand-heavy schemas | Portable mode, ASCII pattern escaping, exact count unrolling, and DFA continuation bans. |
| Ban overlaps and trailing partial words | Correct suffix-state transitions and acceptance of all non-terminal states. The reference trie step can accept `aaba!` with `aba` banned and reject safe incomplete prefixes; our exhaustive short-string checks cover both. |
| Literal newline or placeholder collision failures | Accept either newline representation and select an unused placeholder. |
| Prefill followed by system instructions | Find the last non-system tail, preserve system instructions, and replace/remove only that selected tail. |
| Continue Prompt Manager prefills | Retain the identifiable prefix as a schema constraint while keeping the saved base as context; hide prefix plus overlap on joining. |
| Nested background requests | Check outgoing request type and prevent re-entry during the optional generator. |
| Limited preset portability/control | Flat reference-preset import, rename, and distinct preset slash commands. |
| Generator context and controls | Remove the prefill from generator context; add prompt roles, API stop strings, and returned stop retention. |
| Long or runaway streams | Incremental decoding, explicit size/stall/padding guards, and target/swap cancellation. |

Intentional remaining differences: strict single-field JSON (no loose malformed-JSON repair or legacy response wrappers); bounded custom regexes; no automatic quote/punctuation rewrites; no forced lowercase Continue-join character; no DOM observers/renderer replacement; and copy/paste preset import/export rather than a file-dialog workflow. SillyTavern's renderer, Markdown, user regexes, scrolling, and reasoning remain host-managed. Non-stream cleanup extensions can still affect JSON before our reply event, as described above.

We did not copy the reference's blanket OpenAI exclusion: the inspected official release backend maps `json_schema` to `response_format` for its Chat Completions path. Other host versions using a different OpenAI request path need separate verification. Its permissive unsupported-provider fallback, unbounded generator token settings, heuristic text rewrites, and numeric-range approximations were also not adopted.

Sources consulted:

- [Reference README (behavioral spec)](https://github.com/aimicrocot/StructuredPrefill-Cheesedozer-Edition/blob/main/README.md)
- [SillyTavern UI extension documentation](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern Prompt Manager and Continue settings](https://docs.sillytavern.app/usage/prompts/prompt-manager/)
- [Official chat-completion frontend](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js)
- [Official stream processor and reply lifecycle](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js)
- [Official extension context](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js)
- [Official connection-profile request service](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/shared.js)
- [Official JSON Schema backend mapping](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/backends/chat-completions.js)
