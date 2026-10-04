import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../core.js';

// Small host double follows ST's request -> iterator -> message -> save order.
// No third-party DOM library or running provider needed.
const nodes = new Map();
function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', options: [], replaceChildren(...items) { this.options = items; }, add(item) { this.options.push(item); } });
    return nodes.get(selector);
}
const panel = { querySelector: node, querySelectorAll: () => [], addEventListener() {}, remove() {} };
let insertions = 0;
const target = { insertAdjacentHTML() { insertions++; }, querySelector: () => panel };
globalThis.document = { readyState: 'loading', addEventListener() {}, querySelector: () => target };
globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
const handlers = new Map();
const events = Object.fromEntries(['GENERATION_STARTED', 'CHAT_COMPLETION_SETTINGS_READY', 'MESSAGE_RECEIVED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED'].map(x => [x, x]));
const ctx = {
    chat: [], extensionSettings: {}, groups: [], characters: [], name1: 'User', name2: 'Ada', mainApi: 'openai', streamingProcessor: null,
    getCurrentChatId: () => 'chat-1', substituteParams: text => text.replaceAll('{{char}}', 'Ada'), saveSettingsDebounced() {},
    renderExtensionTemplateAsync: async () => '', updateMessageBlock() {}, saveChat: async () => {}, eventTypes: events,
    eventSource: {
        on(event, callback) { const list = handlers.get(event) ?? []; list.push(callback); handlers.set(event, list); },
        removeListener(event, callback) { handlers.set(event, (handlers.get(event) ?? []).filter(x => x !== callback)); },
    },
};
globalThis.SillyTavern = { getContext: () => ctx };
const { activate, deactivate } = await import('../index.js');
async function emit(event, ...args) { for (const callback of handlers.get(event) ?? []) await callback(...args); }
function enabled(extra = {}) { ctx.extensionSettings.structuredPrefillClean = { ...DEFAULTS, enabled: true, minimum: 0, prefill: 'private\n[[keep]]Ada: ', ...extra }; }
const data = (stream = false) => ({ chat_completion_source: 'openrouter', messages: [{ role: 'user', content: 'Hello' }], stream, n: 1 });
function processor(type = 'normal', base = '') {
    const p = { messageId: -1, continueMessage: base, generator: null,
        async onStartStreaming() {
            if (type !== 'continue') ctx.chat.push({ mes: '...', is_user: false, extra: {}, swipes: [], swipe_id: 0 });
            this.messageId = ctx.chat.length - 1;
            return this.messageId;
        },
    };
    ctx.streamingProcessor = p;
    return p;
}

test('host integration: stream wrapper is scoped, unwraps before display, and preserves state', async () => {
    await Promise.all([activate(), activate()]); assert.equal(insertions, 1); enabled(); ctx.chat = []; const p = processor();
    await emit(events.GENERATION_STARTED, 'normal', {}, false);
    const request = data(true);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, request);
    assert.ok(request.json_schema);
    const raw = JSON.stringify({ value: 'private<NL>Ada: hello 😀' });
    const state = { reasoning: 'host-managed reasoning', images: [], signature: 'sig' };
    p.generator = async function* () { for (let i = 1; i <= raw.length; i++) yield { text: raw.slice(0, i), swipes: [], toolCalls: [], state }; };
    await p.onStartStreaming('...');
    const chunks = [];
    for await (const chunk of p.generator()) chunks.push(chunk);
    assert.equal(chunks.at(-1).text, 'Ada: hello 😀');
    assert.equal(chunks.at(-1).state, state);
    assert.ok(chunks.every(x => !x.text.includes('"value"') && !x.text.includes('private')));
    ctx.chat[0].mes = chunks.at(-1).text;
    await emit(events.GENERATION_ENDED); // ST can emit this before MESSAGE_RECEIVED
    await emit(events.MESSAGE_RECEIVED, 0);
    assert.deepEqual(ctx.chat[0].extra.structuredPrefillClean, { validated: true });
});

test('host integration: non-stream reply and active swipe are both unwrapped', async () => {
    enabled(); ctx.chat = []; ctx.streamingProcessor = null;
    await emit(events.GENERATION_STARTED, 'normal', {}, false);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, data());
    ctx.chat.push({ mes: JSON.stringify({ value: 'private<NL>Ada: hello' }), is_user: false, swipes: ['raw'], swipe_id: 0, swipe_info: [{ extra: {} }] });
    await emit(events.MESSAGE_RECEIVED, 0);
    assert.equal(ctx.chat[0].mes, 'Ada: hello');
    assert.equal(ctx.chat[0].swipes[0], 'Ada: hello');
    assert.equal(ctx.chat[0].swipe_info[0].extra.structuredPrefillClean.validated, true);
    await emit(events.GENERATION_ENDED);
});

test('host integration: Continue keeps the original text exactly once, including literal slots', async () => {
    enabled({ overlap: 6 });
    const base = 'First [[keep]] line 😀';
    ctx.chat = [{ mes: base, is_user: false, extra: {} }];
    const p = processor('continue', base + ' ');
    await emit(events.GENERATION_STARTED, 'continue', {}, false);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, data(true));
    assert.equal(p.continueMessage, base);
    const raw = JSON.stringify({ value: 'private<NL>Ada: ' + [...base].slice(-6).join('') + ' and more' });
    p.generator = async function* () { yield { text: raw, state: {} }; };
    await p.onStartStreaming('...');
    for await (const chunk of p.generator()) ctx.chat[0].mes = p.continueMessage + chunk.text;
    await emit(events.MESSAGE_RECEIVED, 0);
    assert.equal(ctx.chat[0].mes, base + ' and more');
    await emit(events.GENERATION_ENDED);
});

test('host integration: invalid and interrupted replies retain raw recovery data', async () => {
    enabled(); ctx.chat = []; ctx.streamingProcessor = null;
    await emit(events.GENERATION_STARTED, 'normal', {}, false);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, data());
    ctx.chat.push({ mes: 'Provider refusal', is_user: false });
    await emit(events.MESSAGE_RECEIVED, 0);
    assert.equal(ctx.chat[0].mes, 'Provider refusal');
    assert.equal(ctx.chat[0].extra.structuredPrefillClean.raw, 'Provider refusal');
    await emit(events.GENERATION_ENDED);
    ctx.chat = []; const p = processor();
    await emit(events.GENERATION_STARTED, 'normal', {}, false);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, data(true));
    const raw = '{"value":"private<NL>Ada: partial';
    p.generator = async function* () { yield { text: raw, state: {} }; };
    await p.onStartStreaming('...');
    for await (const chunk of p.generator()) ctx.chat[0].mes = chunk.text;
    await emit(events.GENERATION_ENDED);
    assert.equal(ctx.chat[0].mes, 'Ada: partial');
    assert.equal(ctx.chat[0].extra.structuredPrefillClean.raw, raw);
    assert.equal(ctx.chat[0].extra.structuredPrefillClean.validated, false);
});

test('host integration: optional generator uses profile API, applies stop strings, and fails softly', async () => {
    enabled({ prefill: '[[keep]]\n{{char}}: [[pg]]', generatorProfile: 'profile-1', generatorStops: 'STOP' });
    ctx.chat = []; ctx.streamingProcessor = null;
    let calls = 0;
    ctx.ConnectionManagerRequestService = { async sendRequest(profile, messages, tokens, options) {
        calls++; assert.equal(profile, 'profile-1'); assert.equal(tokens, 24); assert.equal(options.includePreset, false); assert.ok(options.signal);
        assert.equal(messages[1].role, 'user'); return { content: 'HelloSTOPdiscard' };
    } };
    await emit(events.GENERATION_STARTED, 'normal', {}, false);
    const request = data();
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, request);
    assert.equal(calls, 1);
    assert.ok(request.json_schema.value.properties.value.pattern.includes('Ada: Hello'));
    await emit(events.GENERATION_ENDED);
    enabled({ useOverride: false, generatorProfile: 'profile-1' });
    ctx.ConnectionManagerRequestService.sendRequest = async () => { throw new Error('offline'); };
    await emit(events.GENERATION_STARTED, 'normal', {}, false);
    const fallback = data(); fallback.messages.push({ role: 'assistant', content: 'Ada: [[pg]]' });
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, fallback);
    assert.ok(fallback.json_schema);
    assert.equal(fallback.messages.some(x => x.content.includes('[[pg]]')), false);
    await emit(events.GENERATION_ENDED);
});

test('host integration: changing the active swipe cancels the stream without editing the selected reply', async () => {
    enabled(); ctx.chat = []; const p = processor();
    let stops = 0;
    ctx.stopGeneration = () => { stops++; return true; };
    await emit(events.GENERATION_STARTED, 'normal', {}, false);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, data(true));
    p.generator = async function* () {
        yield { text: '{"value":"private<NL>Ada: start', state: {} };
        ctx.chat[0].swipe_id = 1; ctx.chat[0].mes = 'Other selected swipe';
        yield { text: '{"value":"private<NL>Ada: start more"}', state: {} };
    };
    await p.onStartStreaming('...');
    for await (const chunk of p.generator()) ctx.chat[0].mes = chunk.text;
    assert.equal(stops, 1); assert.equal(p.isStopped, true);
    assert.equal(ctx.chat[0].mes, 'Other selected swipe');
    await emit(events.GENERATION_ENDED);
    assert.equal(ctx.chat[0].extra.structuredPrefillClean, undefined);
});

test('host integration: dry runs, tools, and incompatible streaming hooks stay unchanged', async () => {
    enabled(); ctx.chat = []; ctx.streamingProcessor = null;
    await emit(events.GENERATION_STARTED, 'normal', {}, false);
    const request = data(true); const original = structuredClone(request);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, request);
    assert.deepEqual(request, original);
    await emit(events.GENERATION_ENDED);
    const quiet = data();
    await emit(events.GENERATION_STARTED, 'quiet', {}, false);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, quiet);
    assert.equal(quiet.json_schema, undefined);
    await emit(events.GENERATION_ENDED);
    await emit(events.GENERATION_STARTED, 'normal', {}, true);
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, quiet);
    assert.equal(quiet.json_schema, undefined);
    deactivate();
    assert.ok([...handlers.values()].every(list => !list.length));
});
