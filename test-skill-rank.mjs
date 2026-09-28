import assert from 'node:assert/strict'

// Load the browser half with a stubbed module loader so its pure helpers can
// be asserted without a browser. apply() is never called, so no core patch is
// installed and no console noise is produced.
let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
await import('./client.js')

assert.ok(captured !== undefined, 'the client module registers itself')
const mod = captured.factory(() => {
  throw new Error('the internals under test must not require a module')
})
const { rankSkills, detectDollar, loadUsage, recordUsage, USAGE_LIMIT } = mod.__internals

const skills = (...names) => names.map((name) => ({ name }))

// 1. Match quality beats usage: a prefix hit outranks a subsequence hit even
// when the subsequence hit is used far more often.
assert.deepEqual(
  rankSkills(skills('review', 'core-review'), 're', { 'core-review': { count: 99, lastUsedAt: 999 } }).map((s) => s.name),
  ['review', 'core-review'],
  'prefix beats subsequence regardless of usage',
)

// 2. Exact-substring hits outrank scattered subsequence hits.
// 'xabc' contains the query; 'axbxc' only scatters its letters.
assert.deepEqual(
  rankSkills(skills('axbxc', 'xabc'), 'abc').map((s) => s.name),
  ['xabc', 'axbxc'],
  'a name substring outranks a subsequence',
)

// 3. A description-only hit still surfaces, below every name hit.
assert.deepEqual(
  rankSkills([{ name: 'alpha' }, { name: 'zzz', description: 'helpers for alpha' }], 'alpha').map((s) => s.name),
  ['alpha', 'zzz'],
  'description hits rank below name hits',
)

// 4. No match means no row, so an unrelated skill never leaks into $.
assert.deepEqual(rankSkills(skills('alpha', 'beta'), 'zzz'), [], 'non-matches are dropped')

// 5. Matching is case-insensitive on both sides.
assert.deepEqual(rankSkills(skills('CoreReview'), 'corereview').map((s) => s.name), ['CoreReview'], 'query is lowercased')

// 6. Empty query keeps uses-first ordering, then host order.
assert.deepEqual(
  rankSkills(skills('a', 'b', 'c'), '', { c: { count: 1, lastUsedAt: 10 } }).map((s) => s.name),
  ['c', 'a', 'b'],
  'an empty query lifts the most recent skill',
)

// 7. Recency outranks frequency inside one tier.
assert.deepEqual(
  rankSkills(skills('a', 'b'), '', { a: { count: 10, lastUsedAt: 1 }, b: { count: 1, lastUsedAt: 5 } }).map((s) => s.name),
  ['b', 'a'],
  'recency outranks frequency',
)

// 8. A missing or malformed usage record is not fatal.
assert.deepEqual(rankSkills(skills('a', 'b'), '', undefined).map((s) => s.name), ['a', 'b'], 'undefined usage keeps host order')
assert.deepEqual(rankSkills(skills('a'), '', { a: null }).map((s) => s.name), ['a'], 'a null usage record is tolerated')
assert.deepEqual(rankSkills([{ name: 'a', description: 42 }], 'a').map((s) => s.name), ['a'], 'a non-string description is ignored')

// 9. detectDollar keeps the skill-name grammar and the word boundary.
const plain = { tier: 'plain' }
assert.equal(detectDollar('$rev', 4, plain).query, 'rev', 'a leading $ opens a query')
assert.equal(detectDollar('see $rev', 8, plain).start, 4, 'a $ after whitespace opens a query')
assert.equal(detectDollar('x$rev', 5, plain), null, 'a mid-word $ stays prose')
assert.equal(detectDollar('$VAR', 4, plain), null, 'an uppercase token stays prose')
assert.equal(detectDollar('$rev', 4, { tier: 'claimed' }), null, 'a non-plain guard suppresses the menu')

// 10. Usage storage is defensive: a corrupt store reads as empty, and the
// table is capped so it cannot grow without bound.
const fakeStorage = () => {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
  }
}
const store = fakeStorage()
assert.deepEqual(loadUsage(store), {}, 'an empty store loads as an empty table')
store.setItem('dsh-skill-dollar/usage', '{not json')
assert.deepEqual(loadUsage(store), {}, 'a corrupt store loads as an empty table')

const once = recordUsage({}, 'a', 100)
assert.deepEqual(once, { a: { count: 1, lastUsedAt: 100 } }, 'the first pick records one use')
const twice = recordUsage(once, 'a', 200)
assert.deepEqual(twice.a, { count: 2, lastUsedAt: 200 }, 'a later pick bumps the count and the timestamp')

let big = {}
for (let i = 0; i <= USAGE_LIMIT; i += 1) big = recordUsage(big, 'skill-' + i, i)
assert.equal(Object.keys(big).length, USAGE_LIMIT, 'the usage table is capped at USAGE_LIMIT')
assert.equal(big['skill-0'], undefined, 'the oldest entry is evicted first')
assert.ok(big['skill-' + USAGE_LIMIT] !== undefined, 'the newest entry survives')

console.log('skill-rank: all assertions passed')
