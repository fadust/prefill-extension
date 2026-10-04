const listeners = new Map();
const names = ['GENERATION_STARTED', 'CHAT_COMPLETION_SETTINGS_READY', 'MESSAGE_RECEIVED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED'];
const eventTypes = Object.fromEntries(names.map(name => [name, name]));
const chat = [];
const result = document.querySelector('#demo-results');
const output = document.querySelector('#demo-output');
const ctx = {
    mainApi: 'openai', name1: 'User', name2: 'Ada', chat, characters: [], groups: [], groupId: null, streamingProcessor: null,
    extensionSettings: JSON.parse(localStorage.getItem('sp-clean-demo') ?? '{}'),
    getCurrentChatId: () => 'demo-chat',
    substituteParams: text => text.replaceAll('{{char}}', 'Ada').replaceAll('{{user}}', 'User'),
    saveSettingsDebounced: () => localStorage.setItem('sp-clean-demo', JSON.stringify(ctx.extensionSettings)),
    saveChat: async () => {}, updateMessageBlock: (_id, message) => { output.textContent = message.mes; },
    renderExtensionTemplateAsync: async (_name, template) => await (await fetch(`/scripts/extensions/third-party/prefill-extension/${template}.html`)).text(),
    eventTypes, eventSource: {
        on(event, callback) { const list = listeners.get(event) ?? []; list.push(callback); listeners.set(event, list); },
        removeListener(event, callback) { listeners.set(event, (listeners.get(event) ?? []).filter(x => x !== callback)); },
    },
};
window.SillyTavern = { getContext: () => ctx };
const { activate } = await import('/scripts/extensions/third-party/prefill-extension/index.js');
await activate();
async function emit(event, ...args) { for (const callback of listeners.get(event) ?? []) await callback(...args); }
async function demo(type, stream, invalid = false) {
    result.textContent = ''; output.textContent = ''; chat.length = 0;
    const base = 'Ada: The light flickered';
    if (type === 'continue') chat.push({ mes: base, is_user: false, extra: {} });
    const processor = stream ? {
        messageId: -1, continueMessage: type === 'continue' ? base + ' ' : '',
        async onStartStreaming() { if (type !== 'continue') chat.push({ mes: '...', is_user: false, extra: {} }); this.messageId = chat.length - 1; return this.messageId; },
    } : null;
    ctx.streamingProcessor = processor;
    await emit(eventTypes.GENERATION_STARTED, type, {}, false);
    const data = { chat_completion_source: 'openrouter', stream, n: 1, messages: [{ role: 'user', content: 'Write the next scene.' }] };
    await emit(eventTypes.CHAT_COMPLETION_SETTINGS_READY, data);
    if (!data.json_schema) { result.textContent = 'No schema applied. Enable the extension to run this demo.'; await emit(eventTypes.GENERATION_ENDED); return; }
    const text = ' and the room fell quiet. She checked the old lamp, found the loose switch, and smiled as the warm glow returned.';
    const config = ctx.extensionSettings.structuredPrefillClean;
    const prefix = ctx.substituteParams(config.prefill).replace(/\[\[(?:keep|pg|end|stop|eos)\]\]/g, '').replaceAll('\n', config.newline);
    const overlap = config.overlap ? [...base].slice(-config.overlap).join('') : '';
    const value = type === 'continue' ? prefix + overlap + text : prefix + 'Welcome. I found the note you left by the door, and I brought the map. Shall we start with the northern trail?';
    const raw = invalid ? 'This provider returned plain text instead of JSON.' : JSON.stringify({ value });
    if (stream) {
        processor.generator = async function* () { for (let i = 1; i <= raw.length; i += 3) yield { text: raw.slice(0, i), state: {} }; yield { text: raw, state: {} }; };
        await processor.onStartStreaming('...');
        for await (const chunk of processor.generator()) { chat[processor.messageId].mes = processor.continueMessage + chunk.text; output.textContent = chat[processor.messageId].mes; }
    } else chat.push({ mes: raw, is_user: false, extra: {} });
    await emit(eventTypes.MESSAGE_RECEIVED, chat.length - 1);
    output.textContent = chat.at(-1).mes;
    result.textContent = JSON.stringify(chat.at(-1).extra.structuredPrefillClean, null, 2);
    await emit(eventTypes.GENERATION_ENDED);
}
document.querySelector('#demo-stream').addEventListener('click', () => demo('normal', true));
document.querySelector('#demo-standard').addEventListener('click', () => demo('normal', false));
document.querySelector('#demo-continue').addEventListener('click', () => demo('continue', true));
document.querySelector('#demo-invalid').addEventListener('click', () => demo('normal', false, true));
