#!/usr/bin/env node
/**
 * check-core-surface.mjs — preflight self-check for the `$` patches.
 *
 * dsh-skill-dollar only needs DSH core in two hard-coded places, because the
 * official `inputTriggers.registerSource` pipeline owns everything else:
 *
 *   1. ui-input-trigger detects only `/` and `@` ("TriggerChar = '/' | '@'"),
 *      so the $ menu hooks the controller's `track` method to synthesise a `$`
 *      hit (client.js).
 *   2. ui-conversation decorates a plain-text token only when the scan's own
 *      regex matches, and that regex is hard-coded to `/` and `@`, so the host
 *      half rewrites the served bytes (bundle-patch.mjs).
 *
 * Both are literal anchors. When DSH reformats or replaces one of them the
 * feature dies silently, which is exactly the failure this script turns into a
 * loud, non-zero-exit report. Run it after every DSH upgrade, and before
 * shipping a change to either patch.
 *
 * Usage:
 *   node check-core-surface.mjs                 # auto-locate installed DSH homes
 *   node check-core-surface.mjs --root <dir>    # add one node_modules/@deepseek-ai root
 *   node check-core-surface.mjs --json          # machine-readable report
 *   node check-core-surface.mjs --help
 *
 * Exit codes: 0 = every checked surface is intact, 1 = drift found,
 * 2 = nothing to check (no installed DSH found).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONVERSATION_PACKAGE, detectBundleState } from './bundle-patch.mjs'

/** Package that owns trigger detection. */
export const INPUT_TRIGGER_PACKAGE = '@deepseek-ai/dsh-client-ui-input-trigger'

/** Compiled shape of the controller method the client half wraps. */
const TRACK_ANCHOR = /track\(draft, caret, guard, draftRev\)\s*\{/

/** Compiled name of the pure detector the controller calls. */
const DETECT_ANCHOR = 'detectTrigger'

/** Compiled literal of the `@` branch; the `/` branch is found by scan. */
const AT_ANCHOR = 'trigger: "@"'

/**
 * Inspect the two client bundles this plugin depends on.
 * @param input - raw bundle sources; `undefined` means the package is not installed.
 * @returns a report: overall status, one state per surface, and findings.
 */
export function inspectCoreSurface(input) {
  const { conversationSource, inputTriggerSource } = input ?? {}
  const findings = []

  let decoration
  if (conversationSource === undefined) {
    decoration = 'absent'
    findings.push({ id: 'decoration-absent', level: 'note', message: CONVERSATION_PACKAGE + ' is not installed here; the decoration patch cannot be judged' })
  } else {
    const state = detectBundleState(conversationSource)
    decoration = state.state
    if (state.state === 'original') {
      findings.push({ id: 'decoration-required', level: 'ok', message: 'the shipped scan still knows only / and @; the $ decoration anchor is intact and the patch is required' })
    } else if (state.state === 'patched') {
      findings.push({ id: 'decoration-obsolete', level: 'note', message: 'this bundle already scans $; drop the decoration patch and TEXT_REF_PATCH_VERSION salt' })
    } else {
      findings.push({
        id: 'decoration-drift',
        level: 'drift',
        message: state.line === undefined
          ? 'the plain-text reference scan is gone: TEXT_REF_RE no longer appears in the conversation bundle'
          : 'the plain-text reference scan changed shape; found: ' + state.line,
      })
    }
  }

  let detection
  if (inputTriggerSource === undefined) {
    detection = 'absent'
    findings.push({ id: 'detection-absent', level: 'note', message: INPUT_TRIGGER_PACKAGE + ' is not installed here; the track patch cannot be judged' })
  } else {
    const missing = []
    if (!TRACK_ANCHOR.test(inputTriggerSource)) missing.push('track(draft, caret, guard, draftRev) {')
    if (!inputTriggerSource.includes(DETECT_ANCHOR)) missing.push(DETECT_ANCHOR)
    if (!inputTriggerSource.includes(AT_ANCHOR)) missing.push(AT_ANCHOR)
    if (missing.length === 0) {
      detection = 'track-patchable'
      findings.push({ id: 'detection-required', level: 'ok', message: 'the detector still emits only / and @; the $ track anchors are intact and the patch is required' })
    } else {
      detection = 'drift'
      findings.push({ id: 'detection-drift', level: 'drift', message: 'the trigger controller no longer exposes the anchor(s) the $ patch hooks: ' + missing.join(', ') })
    }
  }

  return {
    status: findings.some((finding) => finding.level === 'drift') ? 'drift' : 'ok',
    decoration,
    detection,
    findings,
  }
}

/**
 * Resolve one package's client bundle under a root. Accepts both the bare name
 * and the scoped name, so no two callers can disagree about which packages
 * were actually inspected.
 * @param root - a `.../node_modules/@deepseek-ai` directory or a profile directory.
 * @param packageName - `dsh-skill` or `@deepseek-ai/dsh-skill`.
 * @returns the bundle path, or undefined when this root does not carry it.
 */
export function resolveInstalledClient(root, packageName) {
  if (typeof root !== 'string' || root === '') return undefined
  if (typeof packageName !== 'string' || packageName === '') return undefined
  const scoped = packageName.startsWith('@') ? packageName : '@deepseek-ai/' + packageName
  const bare = scoped.slice(scoped.indexOf('/') + 1)
  // Three real layouts: a node_modules root that contains '@deepseek-ai', the
  // '@deepseek-ai' directory itself (every default root on macOS), and a
  // profile directory that owns node_modules.
  const candidates = [
    join(root, scoped, 'lib', 'client.js'),
    join(root, bare, 'lib', 'client.js'),
    join(root, 'node_modules', scoped, 'lib', 'client.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Default DSH homes to inspect, in report order.
 * @returns candidate roots.
 */
function defaultRoots() {
  return [
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai'),
    join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai'),
    '/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai',
  ]
}

/**
 * Parse CLI arguments.
 * @param argv - arguments after the script name.
 * @returns parsed options.
 */
function parseArgs(argv) {
  const out = { roots: [], json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') out.roots.push(argv[++index])
    else if (arg === '--json') out.json = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return out
}

/**
 * Read one root's two bundles and inspect them.
 * @param root - node_modules/@deepseek-ai root.
 * @returns a per-root report.
 */
function checkRoot(root) {
  const conversation = resolveInstalledClient(root, CONVERSATION_PACKAGE)
  const inputTrigger = resolveInstalledClient(root, INPUT_TRIGGER_PACKAGE)
  if (conversation === undefined && inputTrigger === undefined) return undefined
  return {
    root,
    conversation,
    inputTrigger,
    report: inspectCoreSurface({
      conversationSource: conversation === undefined ? undefined : readFileSync(conversation, 'utf8'),
      inputTriggerSource: inputTrigger === undefined ? undefined : readFileSync(inputTrigger, 'utf8'),
    }),
  }
}

/**
 * CLI entry point.
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('usage: node check-core-surface.mjs [--root <dir>]... [--json]')
    return 0
  }
  const roots = [...args.roots, ...defaultRoots()]
  const checked = []
  for (const root of roots) {
    const result = checkRoot(root)
    if (result !== undefined) checked.push(result)
  }
  if (checked.length === 0) {
    console.error('check-core-surface: no installed DSH found; pass --root <node_modules/@deepseek-ai>')
    return 2
  }
  const drifted = checked.filter((entry) => entry.report.status === 'drift')
  if (args.json) {
    console.log(JSON.stringify({ status: drifted.length === 0 ? 'ok' : 'drift', checked }, null, 2))
    return drifted.length === 0 ? 0 : 1
  }
  for (const entry of checked) {
    console.log(entry.report.status === 'ok' ? 'ok   ' + entry.root : 'DRIFT ' + entry.root)
    for (const finding of entry.report.findings) {
      const marker = finding.level === 'drift' ? '  !! ' : finding.level === 'note' ? '  .. ' : '  ok '
      console.log(marker + finding.id + ': ' + finding.message)
    }
  }
  console.log('')
  console.log('decoration=' + (checked[0]?.report.decoration ?? 'absent') + ' detection=' + (checked[0]?.report.detection ?? 'absent') + ' roots=' + checked.length)
  return drifted.length === 0 ? 0 : 1
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error('check-core-surface: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(2)
  }
}
