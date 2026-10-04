// Original DFA -> regex conversion. All non-terminal prefix states accept, so
// incomplete banned prefixes remain legal; suffix transitions handle overlaps.
const fold = text => text.replace(/[A-Z]/g, char => char.toLowerCase());
const classEscape = text => text.replace(/[\\\]\[\^\-]/g, '\\$&');
const LIMIT = 16000;
const either = (a, b) => a === null ? b : b === null || a === b ? a : a === '' ? `(?:${b})?` : b === '' ? `(?:${a})?` : `(?:${a}|${b})`;
const size = expression => {
    if (expression.length > LIMIT) throw new Error('Portable ban pattern is too large; use fewer or shorter phrases.');
    return expression;
};

export function portableBanPattern(phrases) {
    const allWords = [...new Set(phrases.map(fold))];
    // Any longer phrase containing a shorter ban is redundant.
    const words = allWords.filter(word => !allWords.some(other => other !== word && word.includes(other)));
    if (!words.length) return '(?:.|\\n|\\r|\\u2028|\\u2029)*';
    const prefixes = [...new Set(['', ...words.flatMap(word => [...word].slice(0, -1).map((_, i) => [...word].slice(0, i + 1).join('')))])];
    if (prefixes.length > 60) throw new Error('Portable bans exceed 60 prefix states; shorten the ban list.');
    const symbols = [...new Set(words.flatMap(word => [...word]))];
    const index = new Map(prefixes.map((prefix, i) => [prefix, i]));
    const start = prefixes.length, end = start + 1;
    const edges = new Map();
    const get = (i, j) => edges.get(`${i},${j}`) ?? null;
    const add = (i, j, expression) => edges.set(`${i},${j}`, size(either(get(i, j), expression)));
    const cases = symbol => /^[a-z]$/.test(symbol) ? symbol + symbol.toUpperCase() : symbol;
    const excluded = classEscape(symbols.map(cases).join(''));
    for (let i = 0; i < prefixes.length; i++) {
        const groups = new Map([[0, []]]);
        for (const symbol of symbols) {
            const next = prefixes[i] + symbol;
            if (words.some(word => next.endsWith(word))) continue; // forbidden transition
            const suffix = prefixes.filter(prefix => next.endsWith(prefix)).sort((a, b) => b.length - a.length)[0];
            const target = index.get(suffix);
            const chars = groups.get(target) ?? [];
            chars.push(cases(symbol)); groups.set(target, chars);
        }
        for (const [target, chars] of groups) {
            let expression = chars.length ? `[${classEscape(chars.join(''))}]` : null;
            if (target === 0) expression = either(expression, `[^${excluded}]`);
            if (expression !== null) add(i, target, expression);
        }
        add(i, end, '');
    }
    add(start, 0, '');
    const remaining = new Set(prefixes.map((_, i) => i));
    while (remaining.size) {
        const all = [start, ...remaining, end];
        // Eliminating the least connected state first limits expression growth.
        const cost = k => all.filter(i => i !== k && get(i, k) !== null).length * all.filter(j => j !== k && get(k, j) !== null).length;
        const k = [...remaining].sort((a, b) => cost(a) - cost(b))[0];
        const loop = get(k, k);
        const star = loop === null || loop === '' ? '' : `(?:${loop})*`;
        for (const i of all.filter(i => i !== k && get(i, k) !== null)) {
            for (const j of all.filter(j => j !== k && get(k, j) !== null)) add(i, j, size(get(i, k) + star + get(k, j)));
        }
        for (const i of all) { edges.delete(`${i},${k}`); edges.delete(`${k},${i}`); }
        remaining.delete(k);
    }
    return get(start, end) ?? '';
}
