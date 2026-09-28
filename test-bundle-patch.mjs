import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installClientBundlePatch } from './index.js'
import {
  ORIGINAL_TEXT_REF_RE,
  PATCHED_TEXT_REF_RE,
  PATCHED_SLASH_END,
  isConversationBundlePath,
  isPatchedConversationBundle,
  patchConversationBundle,
} from './bundle-patch.mjs'

const SNIPPET = [
  ORIGINAL_TEXT_REF_RE,
  'if (trigger === "/" && !SLASH_TOKEN_END_RE.test(draft.slice(m.index + m[0].length))) continue;',
].join('\n')

// 1. The textual transform adds $ to both the token regex and its end rule.
const patched = patchConversationBundle(SNIPPET)
assert.ok(patched.includes(PATCHED_TEXT_REF_RE), 'token regex gains $')
assert.ok(patched.includes(PATCHED_SLASH_END), 'end-boundary rule gains $')
assert.ok(isPatchedConversationBundle(patched), 'patched source is detected')
assert.equal(patchConversationBundle(patched), patched, 'transform is idempotent')
assert.equal(patchConversationBundle('const unrelated = 1'), 'const unrelated = 1', 'unrelated source is untouched')
assert.equal(patchConversationBundle(undefined), undefined, 'non-string input is returned as-is')

// 2. Only the conversation package's entry bundle is revision-salted.
assert.ok(isConversationBundlePath('/x/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'))
assert.ok(!isConversationBundlePath('/x/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js'))

// 3. Every installed bundle that is present must transform cleanly.
const CANDIDATES = [
  ...process.argv.slice(2),
  join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
  join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
  '/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
]
let checked = 0
for (const candidate of CANDIDATES) {
  if (!existsSync(candidate)) continue
  const source = readFileSync(candidate, 'utf8')
  assert.ok(source.includes(ORIGINAL_TEXT_REF_RE), 'shipped bundle carries the original scan: ' + candidate)
  const output = patchConversationBundle(source)
  assert.ok(output.includes(PATCHED_TEXT_REF_RE), 'patched bundle carries the $ scan: ' + candidate)
  assert.ok(output.includes(PATCHED_SLASH_END), 'patched bundle carries the $ end rule: ' + candidate)
  assert.ok(output.length > source.length, 'patch only adds bytes: ' + candidate)
  assert.equal(patchConversationBundle(output), output, 'patched bundle is idempotent: ' + candidate)
  checked += 1
}

// 4. The registry hook patches served bytes, salts the revision, and skips.
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const registry = {
  table: new Map([['@deepseek-ai/dsh-client-ui-conversation', {}]]),
  rebuiltId: undefined,
  rebuilt(id) {
    this.rebuiltId = id
  },
  captureArtifactBaseline(clientPath) {
    return { path: clientPath, mtimeMs: 1000, ctimeMs: 1000, size: 10 }
  },
  async bundleResource(method, url) {
    if (url.includes('.map')) {
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: encoder.encode('{"version":3}') }
    }
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: encoder.encode(SNIPPET) }
  },
}
const fakeCtx = {
  inject(dependencies, callback) {
    callback({ clientModules: registry })
  },
}
installClientBundlePatch(fakeCtx)
assert.equal(registry.rebuiltId, '@deepseek-ai/dsh-client-ui-conversation', 'the conversation row is recomposed')

const served = await registry.bundleResource('GET', '/plugins/??conversation&rev=1')
assert.ok(decoder.decode(served.body).includes(PATCHED_TEXT_REF_RE), 'served bytes are patched')
const again = await registry.bundleResource('GET', '/plugins/??conversation&rev=1')
assert.ok(decoder.decode(again.body).includes(PATCHED_TEXT_REF_RE), 'cached served bytes are patched')

const head = await registry.bundleResource('HEAD', '/plugins/??conversation&rev=1')
assert.ok(decoder.decode(head.body).includes(ORIGINAL_TEXT_REF_RE), 'HEAD bodies are not rewritten')

const map = await registry.bundleResource('GET', '/plugins/??conversation/client.js.map&rev=1')
assert.ok(decoder.decode(map.body).includes('"version":3'), 'JSON source map is untouched')

const salted = registry.captureArtifactBaseline('/x/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
assert.equal(salted.mtimeMs, 2000, 'the conversation entry revision is salted')
const unsalted = registry.captureArtifactBaseline('/x/@deepseek-ai/dsh-client-ui-conversation/lib/other.js')
assert.equal(unsalted.mtimeMs, 1000, 'other files keep their revision')

// 5. A synchronous host registry (DSH 0.1.5) keeps its synchronous contract.
const syncRegistry = {
  table: new Map([['@deepseek-ai/dsh-client-ui-conversation', { entry: { rev: 'r' }, bundle: encoder.encode(SNIPPET) }]]),
  rebuilt(id) {
    this.table.get(id).entry = { rev: 'r-salted' }
  },
  captureArtifactBaseline(clientPath) {
    return { path: clientPath, mtimeMs: 1000, ctimeMs: 1000, size: 10 }
  },
  bundleResource(method, url) {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: encoder.encode(SNIPPET) }
  },
}
installClientBundlePatch({
  inject(dependencies, callback) {
    callback({ clientModules: syncRegistry })
  },
})
const syncServed = syncRegistry.bundleResource('GET', '/plugins/??conversation&rev=1')
assert.equal(typeof syncServed.then, 'undefined', 'a synchronous registry stays synchronous')
assert.ok(decoder.decode(syncServed.body).includes(PATCHED_TEXT_REF_RE), 'synchronous served bytes are patched')

// 6. A second install is a no-op, not a double wrap.
const patchedResource = registry.bundleResource
installClientBundlePatch(fakeCtx)
assert.equal(registry.bundleResource, patchedResource, 'the registry is wrapped once')

// 7. A reformatted scan is never silent: the served bundle is left untouched
// and the drift is reported once, because a dead $ decoration that logs
// nothing is exactly the failure this plugin must not have.
const DRIFTED_SNIPPET = [
  'const TEXT_REF_RE = /(^|\\s)([/@#])([\\w-]+)/g;',
  'if (trigger === "/" && !SLASH_TOKEN_END_RE.test(draft.slice(m.index + m[0].length))) continue;',
].join('\n')
const UNRELATED_JS = 'const value = 1; export { value }'
const driftRegistry = {
  table: new Map([['@deepseek-ai/dsh-client-ui-conversation', { entry: { rev: 'r' } }]]),
  rebuilt() {},
  captureArtifactBaseline(clientPath) {
    return { path: clientPath, mtimeMs: 1000, ctimeMs: 1000, size: 10 }
  },
  bundleResource(method, url) {
    const source = url.includes('drifted') ? DRIFTED_SNIPPET : UNRELATED_JS
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: encoder.encode(source) }
  },
}
installClientBundlePatch({ inject(dependencies, callback) { callback({ clientModules: driftRegistry }) } })

const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
try {
  const drifted = await driftRegistry.bundleResource('GET', '/plugins/??drifted&rev=1')
  assert.equal(decoder.decode(drifted.body), DRIFTED_SNIPPET, 'a drifted bundle is served untouched')
  await driftRegistry.bundleResource('GET', '/plugins/??drifted&rev=1')
  await driftRegistry.bundleResource('GET', '/plugins/??unrelated&rev=1')
} finally {
  console.warn = originalWarn
}
assert.equal(warnings.length, 1, 'drift is reported once per URL, not once per request: ' + JSON.stringify(warnings))
assert.ok(warnings[0].includes('drift'), 'the warning names the condition: ' + warnings[0])
assert.ok(warnings[0].includes('[/@#]'), 'the warning quotes the scan it could not patch: ' + warnings[0])
assert.ok(!warnings.some((warning) => warning.includes('unrelated')), 'unrelated bundles never warn')

// 6. Decoration semantics: the patched trigger class matches $name with the
// same boundaries the shipped /name rule uses.
const TOKEN = /(^|\s)([/@$])([\w-]+)/g
const END = /^(?:\s|$)/
const LEXICON = new Map([['$', ['brainstorm']], ['/', ['goal']]])
function scan(draft) {
  const ranges = []
  TOKEN.lastIndex = 0
  let match
  while ((match = TOKEN.exec(draft)) !== null) {
    const trigger = match[2]
    const name = match[3] ?? ''
    if ((trigger === '/' || trigger === '$') && !END.test(draft.slice(match.index + match[0].length))) continue
    if (LEXICON.get(trigger)?.includes(name)) {
      const start = match.index + (match[1]?.length ?? 0)
      ranges.push({ start, end: start + 1 + name.length, trigger })
    }
  }
  return ranges
}
assert.deepEqual(scan('$brainstorm '), [{ start: 0, end: 11, trigger: '$' }], '$name at draft start decorates')
assert.deepEqual(scan('see $brainstorm now'), [{ start: 4, end: 15, trigger: '$' }], '$name after whitespace decorates')
assert.deepEqual(scan('$brainstorm/path'), [], 'a path token is prose, not a reference')
assert.deepEqual(scan('a$brainstorm'), [], 'a mid-word $ is prose')
assert.deepEqual(scan('$goal '), [], 'a $ name absent from the lexicon stays plain')

console.log('bundle-patch: all assertions passed; installed bundles checked: ' + checked)
