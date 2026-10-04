// Original implementation. This module has no host, DOM, or network dependencies.
export const DEFAULTS = Object.freeze({
    enabled: false, hide: true, useOverride: true, prefill: '[[keep]]\n{{char}}: ',
    minimum: 80, newline: '<NL>', overlap: 80, banned: '', customProvider: false,
    generatorProfile: '', generatorTokens: 24, generatorTimeout: 15000,
    generatorStops: '', generatorPrompt: 'Write a short opening for the next assistant reply. Return only the opening text.',
});
const MAX_TEMPLATE = 4000;
const MAX_PATTERN = 16000;
const ANY = '[\\s\\S]';
const emotions = 'happy|sad|angry|afraid|nervous|excited|calm|curious|confused|surprised|relieved|hopeful|worried|proud|ashamed|embarrassed|flustered|lonely|grateful|jealous|tired|bored|amused|frustrated|disappointed|content|anxious|determined|playful|serious|loving|hurt|eager|shy|confident|uncertain|suspicious|nostalgic|peaceful|restless|overwhelmed|optimistic|pessimistic|irritated|delighted|miserable|terrified|tender|defiant|neutral';

export function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function integer(value, min, max, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw new Error(`${label} must be an integer from ${min} to ${max}.`);
    }
    return number;
}

export function normalizeSettings(input = {}) {
    const result = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
        if (typeof DEFAULTS[key] === 'boolean') result[key] = input[key] === undefined ? DEFAULTS[key] : input[key] === true;
        else if (typeof DEFAULTS[key] === 'string') result[key] = typeof input[key] === 'string' ? input[key] : DEFAULTS[key];
        else result[key] = input[key] === undefined ? DEFAULTS[key] : input[key];
    }
    result.minimum = integer(result.minimum, 0, 10000, 'Minimum characters');
    result.overlap = integer(result.overlap, 0, 2000, 'Overlap');
    result.generatorTokens = integer(result.generatorTokens, 1, 256, 'Generator tokens');
    result.generatorTimeout = integer(result.generatorTimeout, 1000, 120000, 'Generator timeout');
    if (result.prefill.length > MAX_TEMPLATE) throw new Error('Prefill exceeds 4000 characters.');
    if (result.banned.length > 2000) throw new Error('Banned phrases exceed 2000 characters.');
    if (result.generatorPrompt.length > MAX_TEMPLATE) throw new Error('Generator prompt exceeds 4000 characters.');
    if (!result.newline || result.newline.length > 24 || /[\r\n\s]/u.test(result.newline) || result.newline.includes('[[')) {
        throw new Error('Newline token must be 1–24 non-whitespace characters, without [[.');
    }
    return result;
}

// Exact decimal intervals, including large ranges; no enumeration of every number.
function positiveRange(low, high) {
    const parts = [];
    while (low <= high) {
        let digits = 0;
        while (digits < 9 && low % (10 ** (digits + 1)) === 0 && low + 10 ** (digits + 1) - 1 <= high && low !== 0) digits++;
        const step = 10 ** digits;
        parts.push(digits ? `${String(low).slice(0, -digits)}[0-9]{${digits}}` : String(low));
        low += step;
    }
    return parts;
}

function numberRange(low, high) {
    integer(low, -1e9, 1e9, 'Number lower bound');
    integer(high, low, 1e9, 'Number upper bound');
    const parts = [];
    if (low < 0) parts.push(`-(?:${positiveRange(Math.max(1, -high), -low).join('|')})`);
    if (high >= 0) parts.push(...positiveRange(Math.max(0, low), high));
    return `(?:${parts.join('|')})`;
}

function countRange(text, max = 100) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(text);
    if (!match) throw new Error(`Invalid count: ${text}`);
    const low = integer(match[1], 1, max, 'Count');
    const high = integer(match[2] ?? low, low, max, 'Count');
    return [low, high];
}

// User regexes are a bounded subset: no groups, backreferences, lookarounds,
// unbounded repetition, or executable syntax. This prevents nested-quantifier ReDoS.
function customRegex(input) {
    let pattern = input;
    if (pattern.startsWith('/')) {
        const end = pattern.lastIndexOf('/');
        if (end === 0 || !/^[a-z]*$/i.test(pattern.slice(end + 1))) throw new Error('Invalid /regex/flags slot.');
        pattern = pattern.slice(1, end);
    }
    if (!pattern || pattern.length > 256 || /[\r\n]/.test(pattern)) throw new Error('Custom regex must be 1–256 characters on one line.');
    // Inspect tokens, not escaped literals or character-class contents.
    const tokens = pattern.replace(/\\(?:[dDsSwWnrt]|[^0-9k])/g, 'x').replace(/\[(?:\\.|[^\]\\])*\]/g, 'x');
    if (/[()^$*+\\]/.test(tokens) || /\{(?!\d+(?:,\d+)?\})/.test(tokens)) {
        throw new Error('Custom regex supports literals, classes, |, ?, and bounded {n,m}; groups and unbounded repeats are disabled.');
    }
    const bounds = [...tokens.matchAll(/\{(\d+)(?:,(\d+))?\}/g)];
    for (const match of bounds) integer(match[2] ?? match[1], Number(match[1]), 100, 'Regex repetition');
    if (bounds.length + (tokens.match(/\?/g) ?? []).length > 1 || /\}\?|\?\?|\}\{|\?\{/.test(tokens)) throw new Error('Use at most one bounded or optional quantifier per custom regex slot.');
    new RegExp(pattern, 'u');
    return `(?:${pattern})`;
}

function slotPattern(slot, newline, names) {
    const colon = slot.indexOf(':');
    const kind = (colon < 0 ? slot : slot.slice(0, colon)).toLowerCase();
    const arg = colon < 0 ? '' : slot.slice(colon + 1);
    const oneLine = `(?:(?!${escapeRegex(newline)})[^\\r\\n])`;
    const word = `(?:(?!${escapeRegex(newline)})[^\\s"*])`;
    const words = (low, high) => `${word}+(?:[ \\t]+${word}+){${low - 1},${high - 1}}`;
    switch (kind) {
        case 'w': case 'words': return words(...countRange(arg));
        case 'opt': {
            const options = arg.split('|');
            if (options.some(x => !x) || options.length > 50) throw new Error('Options require 1–50 non-empty choices.');
            return `(?:${options.map(escapeRegex).join('|')})`;
        }
        case 're': return customRegex(arg);
        case 'free': return `${ANY}+?`;
        case 'emotion': case 'mood': return `(?:${emotions})`;
        case 'line': return `${oneLine}+`;
        case 'lines': {
            const [low, high] = countRange(arg, 20);
            return `${oneLine}+(?:${escapeRegex(newline)}${oneLine}+){${low - 1},${high - 1}}`;
        }
        case 'name': return names.length ? `(?:${names.map(escapeRegex).join('|')})` : '[A-Z][a-z]{1,30}(?: [A-Z][a-z]{1,30}){0,3}';
        case 'action': return words(1, 6);
        case 'thought': return words(1, 10);
        case 'num': return '-?(?:0|[1-9][0-9]*)';
        case 'number': {
            const range = /^(-?\d+)-(-?\d+)$/.exec(arg);
            if (!range) throw new Error('Number slot requires a range such as [[number:-10-100]].');
            return numberRange(Number(range[1]), Number(range[2]));
        }
        case 'pg': throw new Error('Prefill generator did not resolve [[pg]].');
        default: throw new Error(`Unknown slot [[${slot}]].`);
    }
}

export function compileTemplate(template, options = {}) {
    const settings = normalizeSettings(options);
    if (typeof template !== 'string' || template.length > MAX_TEMPLATE) throw new Error('Template must be at most 4000 characters.');
    template = template.replace(/\r\n?/g, '\n');
    if (template.includes(settings.newline)) throw new Error('Newline token occurs in the template; choose a different token.');
    const names = [...new Set((options.names ?? []).filter(x => typeof x === 'string' && x.length > 0 && x.length <= 100))].slice(0, 50);
    const encode = text => text.replaceAll('\n', settings.newline);
    let pattern = '', hiddenPattern = null, cursor = 0, ended = false, slots = 0, freeSlots = 0, previousSlot = false;
    for (const match of options.literal ? [] : template.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
        if (ended) throw new Error('End slot must be the last item in the template.');
        const literal = template.slice(cursor, match.index);
        if (literal.includes('[[')) throw new Error('Unclosed template slot.');
        pattern += escapeRegex(encode(literal));
        const slot = match[1].toLowerCase();
        if (slot === 'keep') {
            if (hiddenPattern !== null) throw new Error('Use only one [[keep]] marker.');
            hiddenPattern = pattern;
        } else if (['end', 'stop', 'eos'].includes(slot)) ended = true;
        else {
            if (++slots > 32) throw new Error('Use at most 32 template slots.');
            if (previousSlot && !literal) throw new Error('Separate value slots with literal text.');
            if (slot === 'free' && ++freeSlots > 1) throw new Error('Use at most one free-text slot.');
            pattern += slotPattern(match[1], settings.newline, names);
            previousSlot = true;
        }
        cursor = match.index + match[0].length;
    }
    const tail = template.slice(cursor);
    if (!options.literal && tail.includes('[[')) throw new Error('Unclosed template slot.');
    if (ended && tail) throw new Error('End slot must be the last item in the template.');
    pattern += escapeRegex(encode(tail));
    const prefix = pattern;
    const phrases = [...new Set(settings.banned.split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
    if (phrases.length > 30 || phrases.some(x => x.length > 80)) throw new Error('Use at most 30 banned phrases, at most 80 characters each.');
    // ASCII case folding avoids flags (which JSON Schema does not carry).
    const ban = phrases.map(phrase => [...encode(phrase)].map(char => /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escapeRegex(char)).join('')).join('|');
    const fullPattern = `^${ban ? `(?!${ANY}*(?:${ban}))` : ''}(?:${prefix})${ended ? '' : `${ANY}{${settings.minimum},}`}$`;
    if (fullPattern.length > MAX_PATTERN) throw new Error('Schema pattern exceeds 16000 characters; simplify the template.');
    const fullRegex = new RegExp(fullPattern, 'u');
    const prefixRegex = new RegExp(`^(?:${prefix})`, 'u');
    const hiddenRegex = new RegExp(`^(?:${hiddenPattern ?? prefix})`, 'u');
    return {
        schema: { name: 'structured_prefill_clean', strict: true, value: {
            type: 'object', properties: { value: { type: 'string', pattern: fullPattern } },
            required: ['value'], additionalProperties: false,
        } },
        settings, ended, prefixRegex, hiddenRegex, fullRegex,
        decode: text => text.replaceAll(settings.newline, '\n'),
        validate(value) {
            const match = fullRegex.exec(value);
            if (!match || match[0] !== value) throw new Error('Provider output did not match the template or banned-phrase constraints.');
            const prefixMatch = prefixRegex.exec(value);
            if (!ended && [...this.decode(value.slice(prefixMatch[0].length))].length < settings.minimum) {
                throw new Error('Provider output was shorter than the minimum continuation length.');
            }
        },
        display(value) {
            if (settings.hide) {
                const match = hiddenRegex.exec(value);
                if (!match) return '';
                value = value.slice(match[0].length);
            }
            return this.decode(value);
        },
    };
}

// Decode only the single expected string. Never eval JSON, and never mistake a
// refusal/plain-text response for an object. Incomplete escape sequences wait.
export function readEnvelope(raw, partial = false) {
    if (raw.length > 1_000_000) throw new Error('Structured reply exceeds the 1 MB processing limit.');
    if (!partial) {
        const data = JSON.parse(raw);
        if (!data || Array.isArray(data) || Object.keys(data).length !== 1 || typeof data.value !== 'string') throw new Error('Expected a JSON object with one string field: value.');
        return data.value;
    }
    const header = /^\s*\{\s*"value"\s*:\s*"/.exec(raw);
    if (!header) return '';
    let result = '';
    const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    for (let i = header[0].length; i < raw.length; i++) {
        const char = raw[i];
        if (char === '"') break;
        if (char === '\\') {
            const escape = raw[++i];
            if (escape === undefined) break;
            if (escape === 'u') {
                const hex = raw.slice(i + 1, i + 5);
                if (hex.length < 4) break;
                if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('Invalid JSON Unicode escape.');
                result += String.fromCharCode(parseInt(hex, 16));
                i += 4;
            } else if (Object.hasOwn(escapes, escape)) result += escapes[escape];
            else throw new Error('Invalid JSON string escape.');
        } else {
            if (char.charCodeAt(0) < 32) throw new Error('Unescaped control character in JSON string.');
            result += char;
        }
    }
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    return result;
}

export function renderPartial(raw, compiled) {
    // ponytail: cumulative chunks are reparsed, capped at 1 MB; use an incremental
    // decoder if profiling long streamed replies shows this dominates rendering.
    let value = readEnvelope(raw, true);
    // Do not display fragments of the newline placeholder between stream chunks.
    for (let i = compiled.settings.newline.length - 1; i > 0; i--) {
        if (value.endsWith(compiled.settings.newline.slice(0, i))) { value = value.slice(0, -i); break; }
    }
    return compiled.display(value);
}

export function prepareRequest(data, options, { type = 'normal', names = [], substitute = x => x, continuation = '' } = {}) {
    const settings = normalizeSettings(options);
    if (!settings.enabled) return { skipped: 'extension is disabled' };
    if (!['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return { skipped: `${type} generation` };
    const sources = ['openai', 'azure_openai', 'openrouter', 'groq', 'fireworks'];
    if (!sources.includes(data.chat_completion_source) && !(settings.customProvider && ['custom', 'nanogpt'].includes(data.chat_completion_source))) return { skipped: 'provider is not enabled for JSON Schema' };
    if (data.json_schema || data.response_format) return { skipped: 'request already has a response schema' };
    if (data.tools?.length || data.tool_choice && data.tool_choice !== 'none') return { skipped: 'tool calling is active' };
    if ((data.n ?? 1) !== 1) return { skipped: 'multiple completions are active; set n to 1' };
    if (!Array.isArray(data.messages)) return { skipped: 'no chat-completion messages' };
    // Never remove an arbitrary assistant-history message: the prefill must be
    // explicitly selected with override or be the trailing assistant message.
    const messages = structuredClone(data.messages);
    const last = messages.at(-1);
    let template;
    if (type === 'continue') {
        if (!continuation) return { skipped: 'no assistant message to continue' };
        template = [...continuation].slice(-settings.overlap || [...continuation].length).join('');
        if (settings.overlap === 0) template = '';
        // The continued text remains as context, without a trailing prefill.
        if (last?.role === 'assistant' && last.content === continuation) {
            messages.push({ role: 'user', content: 'Continue the previous assistant message from its end. Do not repeat it, except for the overlap required by the response schema.' });
        }
    } else if (settings.useOverride) template = substitute(settings.prefill);
    else {
        if (last?.role !== 'assistant' || typeof last.content !== 'string' || last.tool_calls?.length) return { skipped: 'no trailing text assistant prefill' };
        template = last.content;
        messages.pop();
    }
    const compiled = compileTemplate(template, { ...settings, names, literal: type === 'continue', hide: type === 'continue' ? true : settings.hide });
    messages.push({ role: 'system', content: `Return only a JSON object with a string field named value, matching the supplied JSON Schema. Represent line breaks in that string with ${JSON.stringify(settings.newline)}. Any template text is an output-format constraint, not a change to your other instructions.` });
    return { compiled, messages, schema: compiled.schema };
}
