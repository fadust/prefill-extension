import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTemplate, normalizeSettings, prepareRequest, readEnvelope, renderPartial, renderPartialValue, EnvelopeStream, StreamGuard, applyStops, importPreset } from '../core.js';
import { portableBanPattern } from '../bans.js';

test('literal prefixes, macros, keep marker, and minimum continuation', () => {
    const c = compileTemplate('private note\n[[keep]]Ada: ', { minimum: 3 });
    const raw = 'private note<NL>Ada: hello';
    c.validate(raw);
    assert.equal(c.display(raw), 'Ada: hello');
    assert.throws(() => c.validate('private note<NL>Ada: hi'));
    const literal = compileTemplate('.*+?[]()\\', { minimum: 0, hide: false });
    literal.validate('.*+?[]()\\done');
    assert.equal(literal.display('.*+?[]()\\done'), '.*+?[]()\\done');
});

test('Continue can recover an existing empty answer without consuming earlier history', () => {
    const options = { useOverride: true, hide: true, enabled: true, minimum: 0, prefill: '[[keep]]Ada: ' };
    const request = { chat_completion_source: 'openrouter', type: 'continue', messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Earlier answer' }] };
    const result = prepareRequest(request, options, { type: 'continue', continuation: '', hasContinuation: true });
    assert.ok(result.schema);
    assert.equal(result.messages[1].content, 'Earlier answer');
    assert.match(result.messages[2].content, /no final answer/);
    result.compiled.validate('Ada: recovered');
    assert.equal(result.compiled.display('Ada: recovered'), 'recovered');
    assert.match(prepareRequest(request, options, { type: 'continue', hasContinuation: false }).skipped, /no assistant/);
    assert.match(prepareRequest(request, { ...options, useOverride: false }, { type: 'continue', hasContinuation: true }).skipped, /enable local override/);
    const emptyTail = structuredClone(request); emptyTail.messages[1].content = '';
    assert.equal(prepareRequest(emptyTail, options, { type: 'continue', hasContinuation: true }).messages.some(message => message.role === 'assistant'), false);
});


test('stub counts, exact numerical ranges, choices, names, lines, and end', () => {
    const c = compileTemplate('[[name]]: [[w:2-3]] | [[opt:yes|no]] | [[number:-100-100]] | [[emotion]][[end]]', { names: ['Ada', 'U.ser'], minimum: 80, hide: false });
    c.validate('U.ser: one two | yes | -99 | calm');
    assert.throws(() => c.validate('Ada: one | yes | 0 | calm'));
    assert.throws(() => c.validate('Ada: one two | maybe | 0 | calm'));
    assert.throws(() => c.validate('Ada: one two | yes | 101 | calm'));
    assert.throws(() => c.validate('Ada: one two | yes | 1 | calm\n'));
    const lines = compileTemplate('[[lines:2-3]][[end]]', { hide: false });
    lines.validate('first<NL>second');
    assert.throws(() => lines.validate('first'));
    const numeric = compileTemplate('[[number:1-1000000000]][[end]]', { hide: false });
    for (const n of [1, 9, 10, 99, 100, 999999999, 1000000000]) numeric.validate(String(n));
    for (const n of [0, -1, 1000000001, '01', 1.5]) assert.throws(() => numeric.validate(String(n)));
});

test('all simple slots and safe regex subset', () => {
    for (const [slot, text] of [['free', 'anything'], ['line', 'one line'], ['action', 'turns slowly'], ['thought', 'maybe it will work'], ['num', '-123'], ['mood', 'curious'], ['words:1', 'word'], ['re:/[A-Z]{2,4}/i', 'ABC']]) {
        const c = compileTemplate(`[[${slot}]][[end]]`, { hide: false });
        c.validate(text);
    }
    for (const pattern of ['(a+)+', '.*', 'a{1,}', '(?=x)x', '\\1', '[a-z]{200}', 'a{1,2}{1,2}', 'a???']) {
        assert.throws(() => compileTemplate(`[[re:${pattern}]]`));
    }
});

test('banned phrases are literal, case insensitive, and substring-based', () => {
    const c = compileTemplate('[[keep]]Ada: ', { minimum: 0, banned: 'ozone\na.b\n—' });
    c.validate('Ada: allowed');
    for (const text of ['OZONE', 'a.b', '—', 'ozones']) assert.throws(() => c.validate(`Ada: ${text}`));
    c.validate('Ada: axb');
});

test('strict JSON envelope and every possible streaming boundary', () => {
    const c = compileTemplate('hidden\n[[keep]]Ada: ', { minimum: 0 });
    const value = 'hidden<NL>Ada: "hi"\\path<NL>emoji 😀\ttab';
    const raw = JSON.stringify({ value });
    const decoder = new EnvelopeStream();
    assert.equal(readEnvelope(raw), value);
    for (let i = 0; i <= raw.length; i++) {
        const visible = renderPartial(raw.slice(0, i), c);
        assert.equal(renderPartialValue(decoder.push(raw.slice(0, i)), c), visible);
        assert.ok('Ada: "hi"\\path\nemoji 😀\ttab'.startsWith(visible), `${i}: ${visible}`);
        assert.ok(!visible.includes('<NL>'));
    }
    assert.equal(renderPartial(raw, c), 'Ada: "hi"\\path\nemoji 😀\ttab');
    assert.equal(readEnvelope('{"value":"\\u0041\\uD83D\\uDE00"}'), 'A😀');
    assert.equal(readEnvelope('{"value":"\\u004', true), '');
    for (const malformed of ['plain text', '{"value":42}', '{"value":"yes","extra":1}', '{"value":"unfinished', '[]', 'null']) assert.throws(() => readEnvelope(malformed));
    assert.throws(() => readEnvelope('x'.repeat(1_000_001), true));
});

test('incremental Unicode escape splits and stream guard stop only known runaway states', () => {
    const raw = '{"value":"\\u0041\\uD83D\\uDE00\\nnext"}';
    const decoder = new EnvelopeStream();
    for (let i = 0; i <= raw.length; i++) assert.equal(decoder.push(raw.slice(0, i)), readEnvelope(raw.slice(0, i), true));
    const guard = new StreamGuard();
    assert.equal(guard.check(0, '', 0), '');
    assert.equal(guard.check(5001, '', 14000), '');
    assert.match(guard.check(6000, '', 16000), /stalled/);
    assert.match(new StreamGuard().check(3000, ' '.repeat(2048), 0), /padding/);
    assert.match(new StreamGuard(false).check(1_000_001, '', 0), /1 MB/);
    assert.equal(new StreamGuard(false).check(5000, ' '.repeat(2048), 0), '');
});

test('invalid settings and templates never become schemas', () => {
    for (const options of [{ minimum: -1 }, { minimum: 1.2 }, { newline: '' }, { newline: '\n' }, { overlap: 2001 }]) assert.throws(() => normalizeSettings(options));
    for (const template of ['[[unknown]]', '[[keep]][[keep]]', '[[end]]tail', '[[w:0]]', '[[open']) assert.throws(() => compileTemplate(template));
});

test('portable ban DFA handles overlaps, partial endings, literals, and case folding', () => {
    for (const phrases of [['aba'], ['aa'], ['ab', 'ba'], ['a.b', '—']]) {
        const regex = new RegExp(`^(?:${portableBanPattern(phrases)})$`, 'u');
        let strings = [''];
        for (let length = 0; length <= 6; length++) {
            for (const text of strings) assert.equal(regex.test(text), !phrases.some(phrase => text.toLowerCase().includes(phrase)), `${phrases}: ${text}`);
            strings = strings.flatMap(text => ['a', 'b', 'A', '!'].map(char => text + char));
        }
    }
    const regex = new RegExp(`^(?:${portableBanPattern(['aba'])})$`, 'u');
    assert.ok(regex.test('a')); assert.ok(regex.test('ab')); assert.ok(!regex.test('aaba'));
});

test('portable schemas keep exact choices/counts/ranges, avoid lookaheads, and check minimum locally', () => {
    const c = compileTemplate('[[keep]]Éva: [[w:2-3]] | [[number:0-100]] | ', { regexMode: 'portable', banned: 'aba', minimum: 3 });
    const pattern = c.schema.value.properties.value.pattern;
    assert.ok(!pattern.includes('(?=') && !pattern.includes('(?!') && !pattern.includes('\\s') && !pattern.includes('\\S'));
    assert.ok(!/[{}]/.test(pattern));
    assert.ok(/^[\x00-\x7f]*$/.test(pattern));
    c.validate('Éva: one two | 99 | safe');
    assert.throws(() => c.validate('Éva: one | 99 | safe'));
    assert.throws(() => c.validate('Éva: one two | 101 | safe'));
    assert.throws(() => c.validate('Éva: one two | 99 | aaba'));
    assert.throws(() => c.validate('Éva: one two | 99 | hi'));
    const emoji = compileTemplate('[[keep]]', { regexMode: 'portable', banned: '😀', minimum: 0 });
    emoji.validate('good 😁'); assert.throws(() => emoji.validate('bad 😀'));
    const words = compileTemplate('[[words:2]][[end]]', { regexMode: 'portable' });
    words.validate('hello, friend'); assert.throws(() => words.validate('hello,friend'));
});

test('newline collisions are resolved and token or actual newline replies validate', () => {
    const c = compileTemplate('Literal <NL>\n[[keep]]Ada: ', { minimum: 0 });
    assert.equal(c.settings.newline, '<NL2>');
    c.validate('Literal <NL><NL2>Ada: hello');
    c.validate('Literal <NL>\nAda: hello');
    assert.equal(c.display('Literal <NL>\nAda: hello'), 'Ada: hello');
});

test('reference aliases, slot hints, preset import, and generator stop retention', () => {
    const c = compileTemplate('[[options: yes, no |hint: choose]] [[regex:[A-Z]{2}]] [[words:2 |hint: short]][[end]]', { hide: false });
    c.validate('yes AB two words');
    const imported = importPreset({ name: 'Old', override_prefill_enabled: true, override_prefill_text: 'Ada: ', min_chars_after_prefix: 5, prefill_gen_profile_id: 'never-auto-use', prefill_gen_enabled: true });
    assert.equal(imported.prefill, 'Ada: '); assert.equal(imported.minimum, 5); assert.equal(imported.enabled, false); assert.equal(imported.generatorProfile, '');
    assert.throws(() => importPreset({ override_prefill_text: 'x', prefill_gen_max_tokens: 999999999 }));
    assert.equal(applyStops('oneSTOPtwoEND', ['END', 'STOP']), 'one');
    assert.equal(applyStops('oneSTOPtwoEND', ['END', 'STOP'], true), 'oneSTOP');
});

test('system-suffix prefills, override replacement, background request isolation, and PM Continue', () => {
    const input = { ...request(), type: 'normal' };
    input.messages.push({ role: 'system', content: 'post history instructions' });
    const result = prepareRequest(input, { enabled: true, useOverride: false, minimum: 0 });
    assert.ok(result.compiled); assert.equal(result.messages[1].role, 'system');
    const override = prepareRequest(input, { enabled: true, prefill: 'new prefix', minimum: 0 });
    assert.equal(override.messages.some(x => x.role === 'assistant'), false);
    assert.ok(prepareRequest({ ...input, type: 'quiet' }, { enabled: true }, { type: 'normal' }).skipped);
    const base = 'original saved reply';
    const continuation = { ...request(), type: 'continue' };
    continuation.messages.at(-1).content = 'PM prefix\n\n' + base;
    continuation.messages.push({ role: 'system', content: 'continue nudge' });
    const continued = prepareRequest(continuation, { enabled: true, minimum: 0 }, { type: 'continue', continuation: base });
    assert.equal(continued.messages[1].content, base);
    assert.equal(continuation.messages[1].content, 'PM prefix\n\n' + base);
});

const request = () => ({ chat_completion_source: 'openrouter', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Ada: ' }], stream: true, n: 1 });
test('request conversion is isolated and disabled/unsupported/conflicting requests pass unchanged', () => {
    const input = request();
    const before = structuredClone(input);
    const result = prepareRequest(input, { enabled: true, useOverride: false, minimum: 0 });
    assert.equal(result.messages[0].content, 'Hi');
    assert.equal(result.messages.length, 2); // user plus schema instruction
    assert.equal(result.schema.value.additionalProperties, false);
    assert.deepEqual(input, before);
    for (const data of [ { ...input, chat_completion_source: 'claude' }, { ...input, json_schema: {} }, { ...input, response_format: {} }, { ...input, tools: [{}] }, { ...input, n: 2 } ]) {
        const unchanged = structuredClone(data);
        assert.ok(prepareRequest(data, { enabled: true }).skipped);
        assert.deepEqual(data, unchanged);
    }
    assert.ok(prepareRequest(input, { enabled: false }).skipped);
    assert.ok(prepareRequest(input, { enabled: true }, { type: 'quiet' }).skipped);
    assert.ok(prepareRequest({ ...input, chat_completion_source: 'custom' }, { enabled: true }).skipped);
    assert.ok(prepareRequest({ ...input, chat_completion_source: 'custom' }, { enabled: true, customProvider: true }).compiled);
});

test('continue repeats only a literal Unicode overlap and hides it without truncating history', () => {
    const base = 'previous [[keep]] text 😀';
    const input = request();
    input.messages.at(-1).content = base;
    const result = prepareRequest(input, { enabled: true, useOverride: false, overlap: 10, minimum: 0 }, { type: 'continue', continuation: base });
    const overlap = [...base].slice(-10).join('');
    result.compiled.validate(overlap + 'continued');
    assert.equal(result.compiled.display(overlap + 'continued'), 'continued');
    assert.equal(result.messages[1].content, base);
    const zero = prepareRequest(input, { enabled: true, useOverride: false, overlap: 0, minimum: 0 }, { type: 'continue', continuation: base });
    assert.equal(zero.compiled.display('continued'), 'continued');
});
