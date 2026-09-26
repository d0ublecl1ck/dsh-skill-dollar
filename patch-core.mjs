#!/usr/bin/env node
/**
 * patch-core.mjs — teach the DSH composer's plain-text reference scan to
 * recognise `$name` tokens, so a `$`-invoked skill gets the same blue
 * text-ref decoration as a `/`-invoked one.
 *
 * The scan lives in @deepseek-ai/dsh-client-ui-conversation and is hard-coded
 * to `/` and `@`; that regex is the only place the trigger set is closed.
 * The input-trigger lexicon is already keyed by an arbitrary trigger string,
 * and dsh-skill-dollar already publishes its skill names under `$`, so two
 * literal substitutions are enough to make the existing pipeline decorate
 * `$name` exactly like `/name`.
 *
 * LEGACY FALLBACK. The plugin now teaches the served bundle about `$` at
 * runtime from its host half (index.js), so a host with a `clientModules`
 * service needs no file edit — including DSH Desktop, whose app.asar is
 * integrity-sealed. This script remains for hosts that predate that service,
 * and for debugging: re-run it after a DSH upgrade, since a new cache
 * directory ships the unpatched file.
 *
 * Usage:
 *   node patch-core.mjs                 # locate the bundle from the dsh install
 *   node patch-core.mjs --file <path>   # patch one explicit bundle
 *   node patch-core.mjs --check         # exit non-zero when the patch is missing
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isPatchedConversationBundle, patchConversationBundle } from './bundle-patch.mjs'


/**
 * Parse CLI arguments.
 * @param argv - process arguments after the script name.
 * @returns parsed options.
 */
function parseArgs(argv) {
  const out = { check: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--file') out.file = argv[++index]
    else if (arg === '--check') out.check = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return out
}

/**
 * Locate the installed conversation client bundle from the dsh launcher.
 * @returns absolute path to the bundle.
 */
function locateBundle() {
  const bin = process.env.DSH_BIN || 'dsh'
  let resolved
  try {
    resolved = execFileSync('which', [bin], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('cannot find "' + bin + '" on PATH; pass --file <client.js>')
  }
  let dir = dirname(realpathSync(resolved))
  while (true) {
    const candidates = [
      join(dir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
      join(dir, '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('cannot locate @deepseek-ai/dsh-client-ui-conversation; pass --file <client.js>')
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('usage: node patch-core.mjs [--file <client.js>] [--check]')
  process.exit(0)
}

const file = args.file !== undefined ? args.file : locateBundle()
const source = readFileSync(file, 'utf8')
const alreadyPatched = isPatchedConversationBundle(source)

if (alreadyPatched) {
  console.log('already patched: ' + file)
  process.exit(0)
}
if (args.check) {
  console.error('MISSING patch: ' + file)
  process.exit(1)
}
const next = patchConversationBundle(source)
if (next === source) {
  console.error('cannot patch: expected patterns not found in ' + file)
  process.exit(1)
}
writeFileSync(file, next)
console.log('patched: ' + file)
