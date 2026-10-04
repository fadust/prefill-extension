import { portableBanPattern } from './bans.js';
// Original implementation. This module has no host, DOM, or network dependencies.
export const DEFAULTS = Object.freeze({
    enabled: false, hide: true, useOverride: true, prefill: '[[keep]]\n{{char}}: ',
    outputMode: 'json',
    minimum: 80, newline: '<NL>', overlap: 80, banned: '', customProvider: false, regexMode: 'auto', streamGuard: true,
    generatorProfile: '', generatorTokens: 24, generatorTimeout: 15000,
    generatorStops: '', generatorKeepStop: false, generatorRole: 'system', generatorPrompt: 'Write a short opening for the next assistant reply. Return only the opening text.',
});
const MAX_TEMPLATE = 4000;
const MAX_PATTERN = 16000;
const ANY = '(?:.|\\n|\\r|\\u2028|\\u2029)';
const SPACE = '\\t \\r\\n\\f\\v\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
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
    if (!['auto', 'standard', 'portable'].includes(result.regexMode)) throw new Error('Regex mode must be auto, standard, or portable.');
    if (!['json', 'native'].includes(result.outputMode)) throw new Error('Reply mode must be json or native.');
    if (!['system', 'user', 'assistant'].includes(result.generatorRole)) throw new Error('Generator prompt role must be system, user, or assistant.');
    if (result.prefill.length > MAX_TEMPLATE) throw new Error('Prefill exceeds 4000 characters.');
    if (result.banned.length > 2000) throw new Error('Banned phrases exceed 2000 characters.');
    if (result.generatorPrompt.length > MAX_TEMPLATE) throw new Error('Generator prompt exceeds 4000 characters.');
    if (!result.newline || result.newline.length > 24 || /[\r\n\s]/u.test(result.newline) || result.newline.includes('[[')) {
        throw new Error('Newline token must be 1–24 non-whitespace characters, without [[.');
    }
    return result;
}

// Exact decimal intervals, including large ranges; no enumeration of every number.
function positiveRange(low, high, portable = false) {
    const parts = [];
    while (low <= high) {
        let digits = 0;
        while (digits < 9 && low % (10 ** (digits + 1)) === 0 && low + 10 ** (digits + 1) - 1 <= high && low !== 0) digits++;
        const step = 10 ** digits;
        parts.push(digits ? `${String(low).slice(0, -digits)}${portable ? '[0-9]'.repeat(digits) : `[0-9]{${digits}}`}` : String(low));
        low += step;
    }
    return parts;
}

function numberRange(low, high, portable) {
    integer(low, -1e9, 1e9, 'Number lower bound');
    integer(high, low, 1e9, 'Number upper bound');
    const parts = [];
    if (low < 0) parts.push(`-(?:${positiveRange(Math.max(1, -high), -low, portable).join('|')})`);
    if (high >= 0) parts.push(...positiveRange(Math.max(0, low), high, portable));
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

function slotPattern(slot, newline, names, portable) {
    slot = slot.split(/\|hint:/i)[0].trim();
    const colon = slot.indexOf(':');
    const kind = (colon < 0 ? slot : slot.slice(0, colon)).trim().toLowerCase();
    const arg = colon < 0 ? '' : slot.slice(colon + 1).trim();
    const forbidden = newline[0].replace(/[\\\]\[\^\-]/g, '\\$&');
    const oneLine = portable ? `[^\\r\\n${forbidden}]` : `(?:(?!${escapeRegex(newline)})[^\\r\\n])`;
    const word = portable ? `[^${SPACE},<>"*${forbidden}]` : `(?:(?!${escapeRegex(newline)})[^\\s,"*])`;
    const repeat = (atom, low, high) => portable ? atom.repeat(low) + `(?:${atom})?`.repeat(high - low) : `(?:${atom}){${low},${high}}`;
    const wordToken = `${word}+[,]*`;
    const words = (low, high) => `${wordToken}${repeat(`[ \\t]+${wordToken}`, low - 1, high - 1)}`;
    switch (kind) {
        case 'w': case 'words': return words(...countRange(arg));
        case 'opt': case 'options': {
            const options = [...new Set(arg.split(/[|,]/).map(x => x.trim()))];
            if (options.some(x => !x) || options.length > 50) throw new Error('Options require 1–50 non-empty choices.');
            return `(?:${options.map(escapeRegex).join('|')})`;
        }
        case 're': case 'regex': {
            const result = customRegex(arg);
            if (portable && /\\[sS]|\{/.test(result)) throw new Error('Portable custom regex cannot use shorthand whitespace classes or brace quantifiers.');
            return result;
        }
        case 'free': return `${ANY}+?`;
        case 'emotion': case 'mood': return `(?:${emotions})`;
        case 'line': return `${oneLine}+`;
        case 'lines': {
            const [low, high] = countRange(arg, 20);
            return `${oneLine}+${repeat(`(?:${escapeRegex(newline)}|\\n)${oneLine}+`, low - 1, high - 1)}`;
        }
        case 'name': return names.length ? `(?:${names.map(escapeRegex).join('|')})` : `[A-Z]${repeat('[a-z]', 1, 30)}${repeat(` [A-Z]${repeat('[a-z]', 1, 30)}`, 0, 3)}`;
        case 'action': return words(1, 6);
        case 'thought': return words(1, 10);
        case 'num': return '-?(?:0|[1-9][0-9]*)';
        case 'number': {
            const range = /^(-?\d+)-(-?\d+)$/.exec(arg);
            if (!range) throw new Error('Number slot requires a range such as [[number:-10-100]].');
            return numberRange(Number(range[1]), Number(range[2]), portable);
        }
        case 'pg': throw new Error('Prefill generator did not resolve [[pg]].');
        default: throw new Error(`Unknown slot [[${slot}]].`);
    }
}

export function compileTemplate(template, options = {}) {
    const settings = normalizeSettings(options);
    const portable = settings.regexMode === 'portable';
    if (typeof template !== 'string' || template.length > MAX_TEMPLATE) throw new Error('Template must be at most 4000 characters.');
    template = template.replace(/\r\n?/g, '\n');
    if (template.includes(settings.newline)) {
        settings.newline = Array.from({ length: 99 }, (_, i) => `<NL${i + 2}>`).find(token => !template.includes(token));
        if (!settings.newline) throw new Error('Cannot find an unused newline token.');
    }
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
            pattern += slotPattern(match[1], settings.newline, names, portable);
            previousSlot = true;
        }
        cursor = match.index + match[0].length;
    }
    const tail = template.slice(cursor);
    if (!options.literal && tail.includes('[[')) throw new Error('Unclosed template slot.');
    if (ended && tail) throw new Error('End slot must be the last item in the template.');
    pattern += escapeRegex(encode(tail));
    if (options.literalSuffix) pattern += escapeRegex(encode(options.literalSuffix.replace(/\r\n?/g, '\n')));
    // Accept either encoded tokens or actual decoded newlines without modifying
    // the literal text. Some providers prefer JSON \n escapes despite the hint.
    pattern = pattern.split(escapeRegex(settings.newline)).join(`(?:${escapeRegex(settings.newline)}|\\n)`);
    if (hiddenPattern !== null) hiddenPattern = hiddenPattern.split(escapeRegex(settings.newline)).join(`(?:${escapeRegex(settings.newline)}|\\n)`);
    const prefix = pattern;
    const phrases = [...new Set(settings.banned.split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
    if (phrases.length > 30 || phrases.some(x => x.length > 80)) throw new Error('Use at most 30 banned phrases, at most 80 characters each.');
    // ASCII case folding avoids flags (which JSON Schema does not carry).
    const ban = phrases.map(phrase => [...encode(phrase)].map(char => /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escapeRegex(char)).join('')).join('|');
    let fullPattern = `^${ban && !portable ? `(?!${ANY}*(?:${ban}))` : ''}(?:${prefix})${ended ? '' : portable ? `(?:${phrases.length ? portableBanPattern(phrases) : `${ANY}*`})` : `${ANY}{${settings.minimum},}`}$`;
    if (portable) fullPattern = fullPattern.replace(/[^\x00-\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (fullPattern.length > MAX_PATTERN) throw new Error('Schema pattern exceeds 16000 characters; simplify the template.');
    const fullRegex = new RegExp(fullPattern, 'u');
    const prefixRegex = new RegExp(`^(?:${prefix})`, 'u');
    const hiddenRegex = new RegExp(`^(?:${hiddenPattern ?? prefix})`, 'u');
    return {
        schema: { name: 'structured_prefill_clean', strict: true, value: {
            type: 'object', properties: { value: { type: 'string', pattern: fullPattern, ...(portable && !ended ? { minLength: settings.minimum } : {}) } },
            required: ['value'], additionalProperties: false,
        } },
        settings, ended, prefixRegex, hiddenRegex, fullRegex,
        decode: text => text.replaceAll(settings.newline, '\n'),
        validate(value) {
            const prefixMatch = prefixRegex.exec(value);
            if (!prefixMatch) throw new Error('Required prefix is missing or changed. The model may not enforce string patterns, or host reasoning/regex processing may have removed it. Try a neutral prefix without thinking tags.');
            const match = fullRegex.exec(value);
            if (!match || match[0] !== value) throw new Error('Provider output did not match the template or banned-phrase constraints.');
            const fold = text => text.replace(/[A-Z]/g, char => char.toLowerCase());
            if (phrases.some(phrase => fold(this.decode(value)).includes(fold(phrase)))) throw new Error('Provider output contained a banned phrase.');
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
    return renderPartialValue(readEnvelope(raw, true), compiled);
}

export function renderPartialValue(value, compiled) {
    // Do not display fragments of the newline placeholder between stream chunks.
    for (let i = compiled.settings.newline.length - 1; i > 0; i--) {
        if (value.endsWith(compiled.settings.newline.slice(0, i))) { value = value.slice(0, -i); break; }
    }
    return compiled.display(value);
}

// ST supplies monotonically accumulated text. Parse each new character once;
// an escape cut across chunks stays at the cursor until its bytes arrive.
export class EnvelopeStream {
    offset = 0;
    value = '';
    started = false;
    closed = false;
    push(raw) {
        if (raw.length > 1_000_000) throw new Error('Structured reply exceeds the 1 MB processing limit.');
        if (!this.started) {
            const header = /^\s*\{\s*"value"\s*:\s*"/.exec(raw);
            if (!header) return '';
            this.offset = header[0].length; this.started = true;
        }
        const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        while (!this.closed && this.offset < raw.length) {
            const char = raw[this.offset];
            if (char === '"') { this.closed = true; break; }
            if (char === '\\') {
                const escape = raw[this.offset + 1];
                if (escape === undefined) break;
                if (escape === 'u') {
                    const hex = raw.slice(this.offset + 2, this.offset + 6);
                    if (hex.length < 4) break;
                    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('Invalid JSON Unicode escape.');
                    this.value += String.fromCharCode(parseInt(hex, 16)); this.offset += 6;
                } else if (Object.hasOwn(escapes, escape)) { this.value += escapes[escape]; this.offset += 2; }
                else throw new Error('Invalid JSON string escape.');
            } else {
                if (char.charCodeAt(0) < 32) throw new Error('Unescaped control character in JSON string.');
                this.value += char; this.offset++;
            }
        }
        return /[\uD800-\uDBFF]$/.test(this.value) ? this.value.slice(0, -1) : this.value;
    }
}

export class StreamGuard {
    constructor(enabled = true) { this.enabled = enabled; this.started = null; this.progress = null; this.length = 0; }
    check(rawLength, decoded, now = Date.now()) {
        if (rawLength > 1_000_000) return 'Structured stream exceeded the 1 MB limit.';
        this.started ??= now; this.progress ??= now;
        if (decoded.length !== this.length) { this.length = decoded.length; this.progress = now; }
        if (!this.enabled) return '';
        if (rawLength > 5000 && now - this.progress > 15000) return 'Structured stream stalled without decoded progress for 15 seconds.';
        const tail = decoded.slice(-2048);
        if (tail.length === 2048 && (!tail.trim() || [...tail].every(char => char === tail[0]))) return 'Structured stream produced 2048 repeated or whitespace padding characters.';
        return '';
    }
}

function prepareNativeRequest(data, settings, { type, names, substitute, continuation, hasContinuation }) {
    const messages = structuredClone(data.messages);
    let tailIndex = messages.length - 1;
    while (tailIndex >= 0 && messages[tailIndex]?.role === 'system') tailIndex--;
    const last = messages[tailIndex];
    if (last?.tool_calls?.length) return { skipped: 'assistant tool calls cannot be used as a native prefix' };
    let template = settings.useOverride ? substitute(settings.prefill) : '';
    let previous = {};
    if (type === 'continue') {
        if (!hasContinuation) return { skipped: 'no assistant message to continue' };
        if (last?.role === 'assistant' && (continuation || last.content === '' || last.content === template || names.some(name => last.content === `${name}: `))) {
            if (typeof last.content !== 'string' || !last.content.endsWith(continuation)) return { skipped: 'Continue request does not contain the saved assistant base' };
            if (!settings.useOverride) {
                template = continuation ? last.content.slice(0, -continuation.length) : '';
                if (names.some(name => template === `${name}: `)) template = '';
            }
            previous = last;
            messages.splice(tailIndex, 1);
        }
        template = template.replace(/\[\[\s*(?:pg|keep|end|stop|eos)\s*\]\]/gi, '');
    } else {
        if (!settings.useOverride && (last?.role !== 'assistant' || typeof last.content !== 'string' || last.tool_calls?.length)) return { skipped: 'no trailing text assistant prefill' };
        if (!settings.useOverride) template = last.content;
        if (last?.role === 'assistant' && typeof last.content === 'string' && !last.tool_calls?.length) messages.splice(tailIndex, 1);
    }
    template = template.replace(/\r\n?/g, '\n');
    const pieces = template.split('[[keep]]');
    if (pieces.length > 2 || pieces.some(part => part.includes('[['))) throw new Error('Native RP mode accepts literal text, macros, [[keep]], and a resolved [[pg]]; use JSON Schema mode for variable slots.');
    const prefix = pieces.join('') + (type === 'continue' ? continuation : '');
    if (!prefix) return { skipped: 'native prefill is empty' };
    const visible = type === 'continue' ? '' : settings.hide ? pieces.length === 2 ? pieces[1] : '' : prefix;
    const assistant = { ...previous, role: 'assistant', content: prefix };
    delete assistant.prefix; delete assistant.partial;
    // Provider flags describe an answer prefix, never synthetic reasoning.
    const source = data.chat_completion_source;
    if (source === 'deepseek' || /deepseek/i.test(data.model ?? '')) assistant.prefix = true;
    else if (source === 'moonshot' || /(?:kimi|moonshot)/i.test(data.model ?? '')) assistant.partial = true;
    messages.push(assistant); // Last, after preserved system messages, before inference.
    const compiled = {
        settings,
        display(raw, complete = false) {
            if (!complete && raw.length < prefix.length && prefix.startsWith(raw)) return '';
            const tail = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
            return tail ? visible + tail : '';
        },
        validate(raw) {
            const tail = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
            if ([...tail].length < settings.minimum) throw new Error('Final RP answer was shorter than the local minimum continuation length.');
            const fold = text => text.replace(/[A-Z]/g, char => char.toLowerCase());
            const bans = settings.banned.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
            if (bans.some(phrase => fold(prefix + tail).includes(fold(phrase)))) throw new Error('Final RP answer contained a banned phrase.');
        },
    };
    return { mode: 'native', messages, compiled, prefix, warning: ['nanogpt', 'custom', 'openrouter'].includes(source)
        ? ' Gateway native-prefill support is unverified; it may reject or ignore the prefix.' : '' };
}

export function prepareRequest(data, options, { type = data.type ?? 'normal', names = [], substitute = x => x, continuation = '', hasContinuation = Boolean(continuation) } = {}) {
    const settings = normalizeSettings(options);
    if (!settings.enabled) return { skipped: 'extension is disabled' };
    if (data.type && data.type !== type) return { skipped: 'background request type does not match the active generation' };
    if (!['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return { skipped: `${type} generation` };
    const sources = settings.outputMode === 'native' ? ['moonshot', 'deepseek', 'openrouter'] : ['openai', 'azure_openai', 'openrouter', 'groq', 'fireworks'];
    if (!sources.includes(data.chat_completion_source) && !(settings.customProvider && ['custom', 'nanogpt'].includes(data.chat_completion_source))) return { skipped: `provider is not enabled for ${settings.outputMode === 'native' ? 'native prefill' : 'JSON Schema'}` };
    if (data.json_schema || data.response_format) return { skipped: 'request already has a response schema' };
    if (data.tools?.length || data.tool_choice && data.tool_choice !== 'none') return { skipped: 'tool calling is active' };
    if ((data.n ?? 1) !== 1) return { skipped: 'multiple completions are active; set n to 1' };
    if (!Array.isArray(data.messages)) return { skipped: 'no chat-completion messages' };
    if (settings.outputMode === 'native') return prepareNativeRequest(data, settings, { type, names, substitute, continuation, hasContinuation });
    // Never remove an arbitrary assistant-history message: the prefill must be
    // explicitly selected with override or be the trailing assistant message.
    const messages = structuredClone(data.messages);
    let tailIndex = messages.length - 1;
    while (tailIndex >= 0 && messages[tailIndex]?.role === 'system') tailIndex--;
    const last = messages[tailIndex];
    let template, literalSuffix = '';
    if (type === 'continue') {
        if (!hasContinuation) return { skipped: 'no assistant message to continue' };
        if (!continuation && !settings.useOverride) return { skipped: 'previous reply has no answer text; enable local override to recover it, or regenerate' };
        literalSuffix = settings.overlap ? [...continuation].slice(-settings.overlap).join('') : '';
        template = settings.useOverride ? substitute(settings.prefill) : '';
        // The continued text remains as context, without a trailing prefill.
        if (continuation && last?.role === 'assistant') {
            // Discard an exact PM prefix only when the base is an identifiable
            // suffix; fuzzy matches could remove legitimate conversation text.
            if (typeof last.content !== 'string' || !last.content.endsWith(continuation)) return { skipped: 'Continue request does not contain the saved assistant base' };
            if (!settings.useOverride) {
                const pmPrefix = last.content.slice(0, -continuation.length);
                if (!names.some(name => pmPrefix === `${name}: `)) template = pmPrefix;
            }
            last.content = continuation;
        }
        if (!continuation) {
            // A reasoning-only reply is still an existing assistant message.
            // Keep prior history; remove only an empty tail or an exact prefill.
            if (last?.role === 'assistant' && (last.content === '' || last.content === template || names.some(name => last.content === `${name}: `))) messages.splice(tailIndex, 1);
            messages.push({ role: 'user', content: 'The previous assistant response contained no final answer. Provide the requested final reply now.' });
        } else if (last?.role === 'assistant' && last.content === continuation) {
            messages.push({ role: 'user', content: 'Continue the previous assistant message from its end. Do not repeat it, except for the overlap required by the response schema.' });
        }
        // Continue reuses the chosen prefix but never runs a generator, honors
        // an end directive, or exposes its prefix/overlap in the appended text.
        template = template.replace(/\[\[\s*(?:pg|keep|end|stop|eos)\s*\]\]/gi, '');
    } else if (settings.useOverride) {
        template = substitute(settings.prefill);
        if (last?.role === 'assistant' && typeof last.content === 'string' && !last.tool_calls?.length) messages.splice(tailIndex, 1);
    }
    else {
        if (last?.role !== 'assistant' || typeof last.content !== 'string' || last.tool_calls?.length) return { skipped: 'no trailing text assistant prefill' };
        template = last.content;
        messages.splice(tailIndex, 1);
    }
    if (settings.regexMode === 'auto') settings.regexMode = /claude|anthropic/i.test(data.model ?? '') ? 'portable' : 'standard';
    if (literalSuffix.includes(settings.newline)) {
        settings.newline = Array.from({ length: 99 }, (_, i) => `<NL${i + 2}>`).find(token => !literalSuffix.includes(token) && !template.includes(token));
        if (!settings.newline) throw new Error('Cannot find an unused Continue newline token.');
    }
    const compiled = compileTemplate(template, { ...settings, names, literalSuffix, hide: type === 'continue' ? true : settings.hide });
    messages.push({ role: 'system', content: `Return only a JSON object with a string field named value, matching the supplied JSON Schema. All required prefix text belongs inside value, not in a separate reasoning field. After that prefix, value must contain the final user-facing answer, without planning notes or analysis. Represent line breaks in that string with ${JSON.stringify(compiled.settings.newline)}. Any template text is an output-format constraint, not a change to your other instructions.` });
    return { compiled, messages, schema: compiled.schema };
}

export function applyStops(text, stops, keep = false) {
    const matches = stops.filter(Boolean).map(stop => ({ index: text.indexOf(stop), stop })).filter(match => match.index >= 0).sort((a, b) => a.index - b.index);
    const match = matches[0];
    return match ? text.slice(0, match.index + (keep ? match.stop.length : 0)) : text;
}

export function importPreset(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Preset must be a JSON object.');
    let value;
    if (data.version === 1 && data.settings) value = data.settings;
    else if ('override_prefill_text' in data || 'min_chars_after_prefix' in data) {
        const mapping = {
            hide_prefill_in_display: 'hide', newline_token: 'newline', min_chars_after_prefix: 'minimum', continue_overlap_chars: 'overlap',
            anti_slop_ban_list: 'banned', override_prefill_enabled: 'useOverride', override_prefill_text: 'prefill',
            prefill_gen_extra_prompt: 'generatorPrompt', prefill_gen_extra_prompt_role: 'generatorRole', prefill_gen_max_tokens: 'generatorTokens',
            prefill_gen_stop: 'generatorStops', prefill_gen_keep_matched_stop_string: 'generatorKeepStop', prefill_gen_timeout_ms: 'generatorTimeout',
        };
        value = {};
        for (const [from, to] of Object.entries(mapping)) if (data[from] !== undefined) value[to] = data[from];
    } else throw new Error('Expected a clean version 1 preset or a StructuredPrefill preset object.');
    return { ...normalizeSettings(value), enabled: false, generatorProfile: '' };
}
