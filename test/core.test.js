import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTemplate, normalizeSettings, prepareRequest, readEnvelope, renderPartial } from '../core.js';

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
    assert.equal(readEnvelope(raw), value);
    for (let i = 0; i <= raw.length; i++) {
        const visible = renderPartial(raw.slice(0, i), c);
        assert.ok('Ada: "hi"\\path\nemoji 😀\ttab'.startsWith(visible), `${i}: ${visible}`);
        assert.ok(!visible.includes('<NL>'));
    }
    assert.equal(renderPartial(raw, c), 'Ada: "hi"\\path\nemoji 😀\ttab');
    assert.equal(readEnvelope('{"value":"\\u0041\\uD83D\\uDE00"}'), 'A😀');
    assert.equal(readEnvelope('{"value":"\\u004', true), '');
    for (const malformed of ['plain text', '{"value":42}', '{"value":"yes","extra":1}', '{"value":"unfinished', '[]', 'null']) assert.throws(() => readEnvelope(malformed));
    assert.throws(() => readEnvelope('x'.repeat(1_000_001), true));
});

test('invalid settings and templates never become schemas', () => {
    for (const options of [{ minimum: -1 }, { minimum: 1.2 }, { newline: '' }, { newline: '\n' }, { overlap: 2001 }]) assert.throws(() => normalizeSettings(options));
    for (const template of ['[[unknown]]', '[[keep]][[keep]]', '[[end]]tail', '[[w:0]]', '[[open', 'literal<NL>']) assert.throws(() => compileTemplate(template));
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
    const result = prepareRequest(input, { enabled: true, overlap: 10, minimum: 0 }, { type: 'continue', continuation: base });
    const overlap = [...base].slice(-10).join('');
    result.compiled.validate(overlap + 'continued');
    assert.equal(result.compiled.display(overlap + 'continued'), 'continued');
    assert.equal(result.messages[1].content, base);
    const zero = prepareRequest(input, { enabled: true, overlap: 0, minimum: 0 }, { type: 'continue', continuation: base });
    assert.equal(zero.compiled.display('continued'), 'continued');
});
