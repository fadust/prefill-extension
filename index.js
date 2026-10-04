import { DEFAULTS, normalizeSettings, compileTemplate, prepareRequest, readEnvelope, renderPartial, renderPartialValue, EnvelopeStream, StreamGuard, applyStops, importPreset } from './core.js';

const KEY = 'structuredPrefillClean';
const context = () => SillyTavern.getContext();
let panel;
let initializing;
let generation = null;
let pending = null;
let generatorController = null;
let commandsRegistered = false;
const listeners = [];

function status(text) {
    if (panel) panel.querySelector('#sp-status').textContent = text;
}

function settings() { return normalizeSettings(context().extensionSettings[KEY]); }

function setSettings(value) {
    const old = context().extensionSettings[KEY] ?? {};
    context().extensionSettings[KEY] = { ...normalizeSettings(value), presets: old.presets ?? [] };
    context().saveSettingsDebounced();
}

function renderSettings() {
    const value = settings();
    for (const input of panel.querySelectorAll('[data-setting]')) {
        if (input.type === 'checkbox') input.checked = value[input.dataset.setting];
        else input.value = value[input.dataset.setting];
    }
    const presets = panel.querySelector('#sp-presets');
    presets.replaceChildren(new Option('Choose a preset', ''));
    for (const item of context().extensionSettings[KEY].presets ?? []) presets.add(new Option(item.name, item.name));
}

function readSettings() {
    const value = {};
    for (const input of panel.querySelectorAll('[data-setting]')) {
        value[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value;
    }
    return normalizeSettings(value);
}

function names() {
    const ctx = context();
    const group = ctx.groups?.find(x => String(x.id) === String(ctx.groupId));
    const members = (group?.members ?? []).map(avatar => ctx.characters.find(x => x.avatar === avatar)?.name);
    return [ctx.name1, ctx.name2, ...members].filter(Boolean);
}

function refreshProfiles() {
    if (!panel) return;
    const select = panel.querySelector('#sp-profile');
    const selected = context().extensionSettings[KEY]?.generatorProfile ?? '';
    select.replaceChildren(new Option('Disabled', ''));
    for (const profile of context().extensionSettings.connectionManager?.profiles ?? []) select.add(new Option(profile.name, profile.id));
    if (selected && ![...select.options].some(x => x.value === selected)) select.add(new Option('Saved profile unavailable', selected));
    select.value = selected;
}

function loadPreset(name) {
    const preset = context().extensionSettings[KEY]?.presets?.find(x => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!preset) throw new Error('Choose an existing saved preset.');
    setSettings({ ...preset.settings, enabled: false, generatorProfile: '' });
    refreshProfiles(); renderSettings();
    return preset.name;
}

function registerCommands() {
    const ctx = context();
    if (commandsRegistered || !ctx.SlashCommandParser || !ctx.SlashCommand || !ctx.SlashCommandArgument || !ctx.ARGUMENT_TYPE) return;
    ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'sp-clean-preset',
        callback: (_args, name) => panel ? loadPreset(String(name)) : '',
        unnamedArgumentList: [ctx.SlashCommandArgument.fromProps({ description: 'Saved clean preset name', typeList: [ctx.ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'Load a StructuredPrefill clean preset by name. Starts disabled and clears the generator profile.',
    }));
    ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'sp-clean-preset-list', callback: () => JSON.stringify(panel ? (ctx.extensionSettings[KEY]?.presets ?? []).map(preset => preset.name) : []),
        helpString: 'List saved StructuredPrefill clean preset names as JSON.',
    }));
    commandsRegistered = true;
}

async function generatePrefix(messages, value) {
    if (!value.generatorProfile || !context().ConnectionManagerRequestService) throw new Error('Choose an available generator connection profile.');
    generatorController = new AbortController();
    const timer = setTimeout(() => generatorController?.abort(), value.generatorTimeout);
    try {
        const textMessages = messages.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '') })).filter(x => ['user', 'assistant', 'system'].includes(x.role));
        if (textMessages.at(-1)?.role === 'assistant') textMessages.push({ role: 'user', content: 'Write a short opening for the next assistant reply.' });
        const prompt = { role: value.generatorRole, content: context().substituteParams(value.generatorPrompt) };
        if (value.generatorRole === 'system') textMessages.unshift(prompt);
        else if (value.generatorRole === 'user') textMessages.push(prompt);
        else textMessages.splice(Math.max(0, textMessages.length - 1), 0, prompt);
        const stops = value.generatorStops.split(/\r?\n/).filter(Boolean);
        const result = await context().ConnectionManagerRequestService.sendRequest(value.generatorProfile, textMessages, value.generatorTokens,
            { stream: false, signal: generatorController.signal, extractData: true, includePreset: false },
            { ...(stops.length ? { stop: stops } : {}), include_reasoning: false, enable_web_search: false, request_images: false });
        let text = result?.content;
        if (typeof text !== 'string') throw new Error('Generator returned no text.');
        text = applyStops(text, stops, value.generatorKeepStop);
        if (text.length > 2000) throw new Error('Generator output exceeds 2000 characters.');
        if (text.includes('[[')) throw new Error('Generator returned template markers instead of plain text.');
        return text;
    } finally {
        clearTimeout(timer);
        generatorController = null;
    }
}

function finish(raw, request) {
    const value = readEnvelope(raw);
    request.compiled.validate(value);
    return request.compiled.display(value);
}

// Wrap only this generation's iterator, after ST has assigned it, and before
// its first chunk. No global fetch patches or modifications to ST prototypes.
function attachStream(processor, request) {
    const originalStart = processor.onStartStreaming;
    processor.onStartStreaming = async function (...args) {
        processor.onStartStreaming = originalStart;
        const originalGenerator = processor.generator;
        processor.generator = async function* () {
            let raw = '';
            const decoder = new EnvelopeStream();
            const guard = new StreamGuard(request.compiled.settings.streamGuard);
            try {
                for await (const chunk of originalGenerator()) {
                    const current = context();
                    const message = current.chat[processor.messageId];
                    if (current.getCurrentChatId() !== request.chatId || message !== request.messageRef || message.swipe_id !== request.swipeId) {
                        request.error = 'Chat or active swipe changed during the structured reply.';
                        processor.isStopped = true;
                        if (current.streamingProcessor === processor) current.stopGeneration?.();
                        status(`Stopped: ${request.error}`);
                        return;
                    }
                    raw = chunk.text ?? '';
                    request.raw = raw;
                    let text = '';
                    let decoded = '';
                    try { decoded = decoder.push(raw); text = renderPartialValue(decoded, request.compiled); }
                    catch { /* Wait for full JSON; an incomplete response is preserved below. */ }
                    const issue = guard.check(raw.length, decoded);
                    if (issue) {
                        request.error = issue;
                        processor.isStopped = true;
                        if (context().streamingProcessor === processor) context().stopGeneration?.();
                        throw new Error(issue);
                    }
                    yield { ...chunk, text };
                }
                const text = finish(raw, request);
                request.complete = true;
                status('Applied: JSON reply validated and unwrapped.');
                yield { text, swipes: [], toolCalls: [], state: request.lastState };
            } catch (error) {
                request.error = error.message;
                status(`Reply needs review: ${error.message} Raw reply is stored in message extra.structuredPrefillClean.raw.`);
                // Keep a refusal/plain reply visible; never erase it for failing the schema.
                const text = raw.trimStart().startsWith('{') ? renderPartialSafely(raw, request) : raw;
                yield { text, swipes: [], toolCalls: [], state: request.lastState };
            }
        };
        // Preserve the final provider reasoning/images/signatures on our last yield.
        const wrappedGenerator = processor.generator;
        processor.generator = async function* () {
            for await (const chunk of wrappedGenerator()) {
                if (chunk.state) request.lastState = chunk.state;
                yield chunk;
            }
        };
        const messageId = await originalStart.apply(this, args);
        request.messageRef = context().chat[messageId];
        request.swipeId = request.messageRef?.swipe_id;
        return messageId;
    };
}

function renderPartialSafely(raw, request) {
    try { return renderPartial(raw, request.compiled); } catch { return ''; }
}

async function onRequest(data) {
    if (!generation || generation.dryRun || generation.api !== 'openai' || pending || generatorController) return;
    const active = generation;
    let value;
    try {
        value = settings();
        const continuation = generation.type === 'continue' ? generation.base : '';
        const options = { type: generation.type, continuation, names: names(), substitute: text => context().substituteParams(text) };
        // Check capability/conflicts before a generator call or any request mutation.
        const probeValue = { ...value, prefill: value.prefill.replaceAll('[[pg]]', '') };
        const probeData = structuredClone(data);
        let tailIndex = (data.messages?.length ?? 0) - 1;
        while (tailIndex >= 0 && data.messages[tailIndex]?.role === 'system') tailIndex--;
        if (!value.useOverride && typeof probeData.messages?.[tailIndex]?.content === 'string') {
            probeData.messages[tailIndex].content = probeData.messages[tailIndex].content.replaceAll('[[pg]]', '');
        }
        const probe = prepareRequest(probeData, probeValue, options);
        if (probe.skipped) { status(`Skipped: ${probe.skipped}.`); return; }
        let generatorWarning = '';
        let template = value.useOverride ? context().substituteParams(value.prefill) : data.messages?.[tailIndex]?.content;
        let requestData = data;
        if (generation.type !== 'continue' && template?.includes('[[pg]]')) {
            status('Generating optional prefill with selected connection profile…');
            let prefix = '';
            const generatorMessages = data.messages.filter((_, i) => !(i === tailIndex && data.messages[i]?.role === 'assistant'));
            try { prefix = await generatePrefix(generatorMessages, value); }
            catch (error) { generatorWarning = ` Generator unavailable: ${error.message}; [[pg]] became empty.`; }
            // A chat change or stop cancels the main request, rather than targeting a different chat.
            if (generation !== active || active.cancelled) throw new DOMException('Generation cancelled.', 'AbortError');
            template = template.replaceAll('[[pg]]', prefix);
            if (!value.useOverride) {
                requestData = structuredClone(data);
                requestData.messages.splice(tailIndex, 1);
            }
            value = { ...value, useOverride: true, prefill: template };
            // Keep this fully resolved template literal in place of macro substitution.
            options.substitute = text => text;
        }
        const request = prepareRequest(requestData, value, options);
        if (request.skipped) { status(`Skipped: ${request.skipped}.`); return; }
        const processor = context().streamingProcessor;
        if (data.stream && (!processor || processor.messageId !== -1 || typeof processor.onStartStreaming !== 'function')) {
            status('Skipped: this SillyTavern version has no compatible stream hook.');
            return;
        }
        const targetId = ['continue', 'swipe'].includes(active.type) ? context().chat.length - 1 : context().chat.length;
        pending = { ...request, chatId: active.chatId, type: active.type, base: active.base, targetId, processor, stream: Boolean(data.stream), raw: '', complete: false };
        data.messages = request.messages;
        data.json_schema = request.schema;
        if (data.stream) {
            if (active.type === 'continue') processor.continueMessage = active.base;
            attachStream(processor, pending);
        }
        status(`Applied: JSON Schema prefix constraint (${request.compiled.settings.regexMode}).${request.compiled.settings.regexMode === 'portable' ? ' Continuation minimum is checked locally.' : ''}${generatorWarning}`);
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        // Invalid settings never partially mutate the outgoing request.
        status(`Skipped: ${error.message}`);
    }
}

async function onReply(messageId) {
    const request = pending;
    const ctx = context();
    if (!request || request.chatId !== ctx.getCurrentChatId() || !Number.isInteger(messageId)) return;
    if (messageId !== (request.stream ? request.processor.messageId : request.targetId)) return;
    const message = ctx.chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    if (request.stream && (message !== request.messageRef || message.swipe_id !== request.swipeId)) {
        pending = null;
        status('Stopped: reply target changed; selected message was left intact.');
        return;
    }
    message.extra ??= {};
    if (request.stream) {
        message.extra[KEY] = { validated: request.complete, ...(request.complete ? {} : { raw: request.raw, error: request.error ?? 'Generation interrupted before complete JSON.' }) };
    } else {
        let raw = message.mes;
        if (request.type === 'continue') {
            // ST normally prepends its original text (and possibly a postfix).
            // Locate the JSON suffix without treating the previous chat text as JSON.
            if (!raw.startsWith(request.base)) { status('Reply needs review: Continue base changed; reply left intact.'); pending = null; return; }
            raw = raw.slice(request.base.length).trimStart();
        }
        try {
            const text = finish(raw, request);
            message.mes = (request.type === 'continue' ? request.base : '') + text;
            message.extra[KEY] = { validated: true };
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = message.mes;
            ctx.updateMessageBlock(messageId, message);
            status('Applied: JSON reply validated and unwrapped.');
        } catch (error) {
            message.extra[KEY] = { validated: false, raw, error: error.message };
            status(`Reply needs review: ${error.message} Original reply left intact.`);
        }
    }
    if (message.swipe_info?.[message.swipe_id]) message.swipe_info[message.swipe_id].extra = structuredClone(message.extra);
    pending = null;
    await ctx.saveChat();
}

function listen(event, callback) {
    if (!event) return;
    context().eventSource.on(event, callback);
    listeners.push([event, callback]);
}

export function deactivate() {
    generatorController?.abort();
    generation = null;
    pending = null;
    for (const [event, callback] of listeners.splice(0)) context().eventSource.removeListener(event, callback);
    panel?.remove();
    panel = null;
}

export function activate() {
    if (panel) return Promise.resolve();
    initializing ??= initialize().finally(() => { initializing = null; });
    return initializing;
}

async function initialize() {
    if (panel) return;
    const ctx = context();
    const target = document.querySelector('#extensions_settings');
    if (!target) throw new Error('SillyTavern extension settings container is unavailable.');
    try { setSettings(ctx.extensionSettings[KEY] ?? DEFAULTS); }
    catch { setSettings(DEFAULTS); }
    const pathname = new URL('.', import.meta.url).pathname;
    const extensionName = pathname.split('/scripts/extensions/')[1]?.replace(/\/$/, '') ?? pathname.split('/').filter(Boolean).at(-1);
    const html = await ctx.renderExtensionTemplateAsync(decodeURIComponent(extensionName), 'settings');
    target.insertAdjacentHTML('beforeend', html);
    panel = target.querySelector('#sp-clean');
    refreshProfiles();
    renderSettings();
    registerCommands();
    status(settings().enabled ? 'Ready. Waiting for a compatible generation.' : 'Skipped: extension is disabled.');
    panel.addEventListener('input', event => {
        if (!event.target.dataset.setting) return;
        try { setSettings(readSettings()); status('Settings saved. Applies to the next generation.'); }
        catch (error) { status(`Settings not saved: ${error.message}`); }
    });
    panel.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        try {
            const select = panel.querySelector('#sp-presets');
            const store = context().extensionSettings[KEY];
            const name = panel.querySelector('#sp-preset-name').value.trim();
            const json = panel.querySelector('#sp-preset-json');
            if (action === 'preview') {
                const value = readSettings();
                const preview = panel.querySelector('#sp-preview');
                preview.textContent = JSON.stringify(compileTemplate(context().substituteParams(value.prefill.replaceAll('[[pg]]', 'example opening')), { ...value, names: names() }).schema, null, 2);
                preview.hidden = false;
            } else if (action === 'reset') { setSettings(DEFAULTS); refreshProfiles(); renderSettings(); }
            else if (action === 'export') json.value = JSON.stringify({ version: 1, settings: readSettings() }, null, 2);
            else if (action === 'import') {
                const data = JSON.parse(json.value);
                // Imported presets cannot auto-enable the extension or extra API requests.
                setSettings(importPreset(data));
                if (typeof data.name === 'string') panel.querySelector('#sp-preset-name').value = data.name.slice(0, 80);
                refreshProfiles(); renderSettings();
            } else if (action === 'save') {
                if (!name) throw new Error('Enter a preset name.');
                const presets = Array.isArray(store.presets) ? store.presets : [];
                if (presets.length >= 30 && !presets.some(x => x.name === name)) throw new Error('Preset limit is 30.');
                store.presets = [...presets.filter(x => x.name !== name), { name, settings: readSettings() }];
                context().saveSettingsDebounced(); renderSettings(); select.value = name;
            } else if (action === 'load') {
                loadPreset(select.value);
            } else if (action === 'rename') {
                const preset = store.presets?.find(x => x.name === select.value);
                if (!preset || !name) throw new Error('Choose a preset and enter its new name.');
                if (store.presets.some(x => x !== preset && x.name.toLowerCase() === name.toLowerCase())) throw new Error('That preset name already exists.');
                preset.name = name;
                context().saveSettingsDebounced(); renderSettings(); select.value = name;
            } else if (action === 'delete') {
                store.presets = (store.presets ?? []).filter(x => x.name !== select.value);
                context().saveSettingsDebounced(); renderSettings();
            }
            status('Done. Settings apply to the next generation.');
        } catch (error) { status(error.message); }
    });
    const events = ctx.eventTypes;
    listen(events.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun) return;
        if (generation) generation.cancelled = true;
        const current = context();
        const last = current.chat.at(-1);
        generation = { type, dryRun, api: current.mainApi, chatId: current.getCurrentChatId(), base: last && !last.is_user && !last.is_system ? last.mes : '' };
        pending = null;
    });
    listen(events.CHAT_COMPLETION_SETTINGS_READY, onRequest);
    listen(events.MESSAGE_RECEIVED, onReply);
    listen(events.GENERATION_STOPPED, () => { if (generation) generation.cancelled = true; generatorController?.abort(); });
    listen(events.GENERATION_ENDED, async () => {
        generation = null;
        generatorController?.abort();
        if (pending?.stream && pending.processor.messageId >= 0) await onReply(pending.processor.messageId);
    });
    listen(events.CHAT_CHANGED, () => { generation = null; pending = null; generatorController?.abort(); });
    for (const event of [events.CONNECTION_PROFILE_LOADED, events.CONNECTION_PROFILE_CREATED, events.CONNECTION_PROFILE_UPDATED, events.CONNECTION_PROFILE_DELETED]) listen(event, refreshProfiles);
}

// Legacy ST versions initialize extensions by executing their entry script;
// recent versions can call activate as a manifest lifecycle hook as well.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => activate().catch(error => console.error('[StructuredPrefill clean]', error.message)), { once: true });
else activate().catch(error => console.error('[StructuredPrefill clean]', error.message));
