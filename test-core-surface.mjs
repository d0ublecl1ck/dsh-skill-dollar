import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORIGINAL_TEXT_REF_RE, PATCHED_TEXT_REF_RE } from './bundle-patch.mjs'
import { inspectCoreSurface, resolveInstalledClient } from './check-core-surface.mjs'

// Fixtures mirror the shipped 0.1.7-rc.2 bundles. If DSH reformats one of
// these anchors the plugin's two patches no longer apply, and this check must
// fail loudly instead of letting the $ decoration go silently dead.
const CONVERSATION_ORIGINAL = [
  ORIGINAL_TEXT_REF_RE,
  'const SLASH_TOKEN_END_RE = /^(?:\\s|$)/',
].join('\n')

const CONVERSATION_DRIFTED = [
  'const TEXT_REF_RE = /(^|\\s)([/@#])([\\w-]+)/g',
  'const SLASH_TOKEN_END_RE = /^(?:\\s|$)/',
].join('\n')

const INPUT_TRIGGER = [
  'function activeAtToken(line, cursorCol) {',
  'const detectTrigger = (draft, caret, guard) => {',
  '\t\t\t\t\ttrigger: "@",',
  '\t\t\tif (ch !== "/") continue;',
  '\t\ttrack(draft, caret, guard, draftRev) {',
].join('\n')

// 1. The current shipped shape is recognised and both patches are still needed.
const current = inspectCoreSurface({ conversationSource: CONVERSATION_ORIGINAL, inputTriggerSource: INPUT_TRIGGER })
assert.equal(current.status, 'ok', 'the shipped shape is not drift')
assert.equal(current.decoration, 'original', 'the decoration patch is still needed')
assert.equal(current.detection, 'track-patchable', 'the track patch is still needed')

// 2. An already-$-aware conversation scan means the decoration patch is obsolete.
const upstream = inspectCoreSurface({ conversationSource: PATCHED_TEXT_REF_RE, inputTriggerSource: INPUT_TRIGGER })
assert.equal(upstream.status, 'ok', 'an upstream $ scan is not drift')
assert.equal(upstream.decoration, 'patched', 'a $ scan is reported as patched')
assert.ok(upstream.findings.some((f) => f.id === 'decoration-obsolete'), 'obsolete decoration patch is called out')

// 3. A reformatted / widened scan is drift, and the offending line is reported.
const widened = inspectCoreSurface({ conversationSource: CONVERSATION_DRIFTED, inputTriggerSource: INPUT_TRIGGER })
assert.equal(widened.status, 'drift', 'a reformatted scan is drift')
assert.equal(widened.decoration, 'drift', 'drift is reported for the scan')
assert.ok(widened.findings.some((f) => f.level === 'drift' && f.message.includes('[/@#]')), 'drift names the new scan line')

// 4. A moved or renamed scan is drift, never silence.
const missingScan = inspectCoreSurface({ conversationSource: 'const unrelated = 1', inputTriggerSource: INPUT_TRIGGER })
assert.equal(missingScan.status, 'drift', 'a missing scan is drift')

// 5. The detector anchors are required, one by one.
for (const [label, source] of [
  ['track method', INPUT_TRIGGER.replace('track(draft, caret, guard, draftRev) {', 'run(draft, caret, guard, draftRev) {')],
  ['detectTrigger', INPUT_TRIGGER.replace('detectTrigger', 'pickTrigger')],
  ['at trigger', INPUT_TRIGGER.replace('trigger: "@",', 'trigger: "!",')],
]) {
  const report = inspectCoreSurface({ conversationSource: CONVERSATION_ORIGINAL, inputTriggerSource: source })
  assert.equal(report.detection, 'drift', 'missing detector anchor is drift: ' + label)
  assert.equal(report.status, 'drift', 'missing detector anchor fails the check: ' + label)
}

// 6. An absent package is 'absent', not drift: the check cannot judge what is not installed.
const absent = inspectCoreSurface({ inputTriggerSource: INPUT_TRIGGER })
assert.equal(absent.decoration, 'absent', 'an uninstalled conversation package is absent')
assert.equal(absent.status, 'ok', 'an uninstalled package is not drift')

// 7. Every installed bundle on this machine must pass the live check.
const CANDIDATES = [
  ...process.argv.slice(2),
  join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai'),
  join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai'),
  '/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai',
]
let checked = 0
for (const root of CANDIDATES) {
  const conversation = resolveInstalledClient(root, 'dsh-client-ui-conversation')
  const inputTrigger = resolveInstalledClient(root, 'dsh-client-ui-input-trigger')
  if (conversation === undefined && inputTrigger === undefined) continue
  const report = inspectCoreSurface({
    conversationSource: conversation === undefined ? undefined : readFileSync(conversation, 'utf8'),
    inputTriggerSource: inputTrigger === undefined ? undefined : readFileSync(inputTrigger, 'utf8'),
  })
  assert.equal(report.status, 'ok', 'installed DSH core surface drifted: ' + root + ' -> ' + JSON.stringify(report.findings))
  checked += 1
}

// 8. Scoped and bare package names must resolve identically: the CLI passes
// '@deepseek-ai/<pkg>' while the live loop above passes '<pkg>', and a caller
// that disagrees with another is exactly how the first version silently
// checked nothing.
const scopedRoot = mkdtempSync(join(tmpdir(), 'dsh-surface-scoped-'))
const scopedFile = join(scopedRoot, '@deepseek-ai', 'dsh-skill', 'lib', 'client.js')
mkdirSync(join(scopedRoot, '@deepseek-ai', 'dsh-skill', 'lib'), { recursive: true })
writeFileSync(scopedFile, '// fixture')

const profileRoot = mkdtempSync(join(tmpdir(), 'dsh-surface-profile-'))
const profileFile = join(profileRoot, 'node_modules', '@deepseek-ai', 'dsh-skill', 'lib', 'client.js')
mkdirSync(join(profileRoot, 'node_modules', '@deepseek-ai', 'dsh-skill', 'lib'), { recursive: true })
writeFileSync(profileFile, '// fixture')
try {
  assert.equal(resolveInstalledClient(scopedRoot, 'dsh-skill'), scopedFile, 'a bare name resolves under the scope directory')
  assert.equal(resolveInstalledClient(scopedRoot, '@deepseek-ai/dsh-skill'), scopedFile, 'a scoped name resolves under the scope directory')
  assert.equal(resolveInstalledClient(profileRoot, '@deepseek-ai/dsh-skill'), profileFile, 'a scoped name resolves under a profile node_modules')
  // Every default root on this machine already IS the '@deepseek-ai' directory,
  // which is the form the first version got wrong.
  assert.equal(resolveInstalledClient(join(scopedRoot, '@deepseek-ai'), '@deepseek-ai/dsh-skill'), scopedFile, 'a scoped name resolves under the @deepseek-ai directory itself')
  assert.equal(resolveInstalledClient(join(scopedRoot, '@deepseek-ai'), 'dsh-skill'), scopedFile, 'a bare name resolves under the @deepseek-ai directory itself')
  assert.equal(resolveInstalledClient(scopedRoot, 'missing-skill'), undefined, 'an absent package resolves to undefined')
  assert.equal(resolveInstalledClient('', 'dsh-skill'), undefined, 'an empty root resolves to undefined')
} finally {
  rmSync(scopedRoot, { recursive: true, force: true })
  rmSync(profileRoot, { recursive: true, force: true })
}

console.log('core-surface: all assertions passed; installed roots checked: ' + checked)
