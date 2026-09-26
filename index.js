import { randomUUID } from 'node:crypto'
import {
  CONVERSATION_PACKAGE,
  ORIGINAL_TEXT_REF_RE,
  TEXT_REF_PATCH_SALT_MS,
  isConversationBundlePath,
  patchConversationBundle,
} from './bundle-patch.mjs'

/**
 * Host half of dsh-skill-dollar.
 *
 * The client half (client.js) registers a `$`-trigger candidate source and
 * teaches the input-trigger controller to open it. This half makes the
 * `$skill-name` gesture actually load the skill: it mirrors the `/skill-name`
 * gesture handled by @deepseek-ai/dsh-tool-skill and injects the canonical
 * `<skill_content>` block at the end of the step's injections.
 *
 * The bridge between the halves is plain draft text: a pick inserts
 * `$skill-name `, the default composer sink sends it verbatim, and this
 * listener recognises the whitespace-bounded token. That keeps hand-typed
 * gestures and menu picks identical, exactly like the built-in slash gesture.
 */

export const name = 'skill-dollar'

/** Hard dependency: the skill registry resolving `$name` into a loaded skill. */
export const inject = ['skills']

/**
 * Whitespace-bounded `$name` token (the public skill-name grammar) anywhere in
 * a direct user message. The shape mirrors dsh-tool-skill's `/name` gesture so
 * both paths agree byte for byte on what a gesture is.
 */
const SKILL_GESTURE = /(^|\s)\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * Install the host-side half of the `$` plain-text reference decoration.
 *
 * The conversation client bundle is served from ClientModuleRegistry, which
 * snapshots every bundle in memory at boot. Wrapping `bundleResource` lets
 * this plugin rewrite the served bytes on the way out — no file on disk changes,
 * so DSH Desktop's integrity-sealed app.asar and the code signature stay
 * intact.
 *
 * The browser caches immutable `/plugins` URLs for a year, so serving
 * different bytes under the same URL is not enough. Wrapping
 * `captureArtifactBaseline` salts the conversation row's revision, and one
 * `rebuilt()` call recomposes the graph with a fresh URL that forces the
 * fetch. Bump TEXT_REF_PATCH_VERSION in bundle-patch.mjs to change it again.
 * @param ctx - host plugin context.
 */
export function installClientBundlePatch(ctx) {
  ctx.inject(['clientModules'], (clientCtx) => {
    const registry = clientCtx?.clientModules ?? ctx.clientModules
    if (registry === null || registry === undefined || typeof registry !== 'object') return
    if (registry[REGISTRY_PATCH_FLAG] === true) return

    const bundleResource = registry.bundleResource
    if (typeof bundleResource !== 'function') {
      console.error('[skill-dollar] clientModules.bundleResource is unavailable; run `node patch-core.mjs` to decorate `$name` tokens')
      return
    }

    const captureArtifactBaseline = registry.captureArtifactBaseline
    if (typeof captureArtifactBaseline === 'function') {
      registry.captureArtifactBaseline = function (clientPath) {
        const baseline = captureArtifactBaseline.call(this, clientPath)
        if (
          baseline !== null &&
          typeof baseline === 'object' &&
          isConversationBundlePath(clientPath) &&
          Number.isFinite(baseline.mtimeMs)
        ) {
          baseline.mtimeMs += TEXT_REF_PATCH_SALT_MS
        }
        return baseline
      }
      if (typeof registry.rebuilt === 'function') {
        const conversationId = conversationEntryId(registry)
        const beforeRev = entryRevision(registry, conversationId)
        try {
          registry.rebuilt(conversationId)
        } catch (error) {
          console.error('[skill-dollar] could not refresh the composer bundle revision', error)
        }
        const afterRev = entryRevision(registry, conversationId)
        if (beforeRev !== undefined && beforeRev === afterRev && isUnpatchedBundle(registry, conversationId)) {
          console.error('[skill-dollar] this host derives bundle revisions from content, so the in-memory decoration cannot bust the browser cache; run `node patch-core.mjs` once, then restart')
        }
      }
    }

    registry.bundleResource = function (method, url) {
      const response = bundleResource.call(this, method, url)
      if (response !== null && typeof response === 'object' && typeof response.then === 'function') {
        return response.then((resolved) => patchBundleResponse(method, url, resolved))
      }
      return patchBundleResponse(method, url, response)
    }
    Object.defineProperty(registry, REGISTRY_PATCH_FLAG, { value: true })
  })
}

/**
 * One row's current revision, when the registry exposes its table.
 * @param registry - ClientModuleRegistry instance.
 * @param id - graph row id.
 * @returns the revision, or undefined.
 */
function entryRevision(registry, id) {
  const table = registry.table
  if (table === undefined || table === null || typeof table.get !== 'function') return undefined
  const record = table.get(id)
  return record === undefined || record === null ? undefined : record.entry?.rev
}

/**
 * Whether the row's on-disk bundle still carries the unpatched scan.
 * @param registry - ClientModuleRegistry instance.
 * @param id - graph row id.
 * @returns whether a disk patch is still required on this host.
 */
function isUnpatchedBundle(registry, id) {
  const table = registry.table
  if (table === undefined || table === null || typeof table.get !== 'function') return false
  const record = table.get(id)
  if (record === undefined || record === null || record.bundle === undefined || record.bundle === null) return false
  const source = decodeBundle(record.bundle)
  return source !== undefined && source.includes(ORIGINAL_TEXT_REF_RE)
}

/**
 * The graph row id of the conversation package. Client module ids are package
 * names, but reading the registry's own table keeps this correct if that ever
 * changes; the bare package name is the fallback.
 * @param registry - ClientModuleRegistry instance.
 * @returns the row id to recompose.
 */
function conversationEntryId(registry) {
  const table = registry.table
  if (table !== undefined && table !== null && typeof table.keys === 'function') {
    for (const id of table.keys()) {
      if (typeof id === 'string' && id.includes(CONVERSATION_PACKAGE)) return id
    }
  }
  return CONVERSATION_PACKAGE
}

/**
 * Rewrite one served client-module response.
 * @param method - HTTP verb; HEAD carries no body.
 * @param url - immutable plugin URL, used as the patch cache key.
 * @param response - `bundleResource` result.
 * @returns the response, with patched JavaScript bytes when the scan is present.
 */
function patchBundleResponse(method, url, response) {
  if (method === 'HEAD' || response === null || response === undefined) return response
  const body = response.body
  if (body === undefined || body === null) return response
  const headers = response.headers
  const contentType = headers === undefined || headers === null ? undefined : headers['content-type']
  if (typeof contentType === 'string' && contentType !== '' && !contentType.startsWith('text/javascript')) {
    return response
  }
  const cacheKey = typeof url === 'string' ? url : undefined
  if (cacheKey !== undefined) {
    const cached = patchedBodies.get(cacheKey)
    if (cached !== undefined) return { ...response, body: cached }
  }
  const source = decodeBundle(body)
  if (source === undefined || !source.includes(ORIGINAL_TEXT_REF_RE)) return response
  const patched = patchConversationBundle(source)
  if (patched === source) return response
  const bytes = bundleEncoder.encode(patched)
  if (cacheKey !== undefined) {
    if (patchedBodies.size >= PATCHED_BODY_LIMIT) {
      const oldest = patchedBodies.keys().next().value
      if (oldest !== undefined) patchedBodies.delete(oldest)
    }
    patchedBodies.set(cacheKey, bytes)
  }
  return { ...response, body: bytes }
}

/**
 * Decode a served bundle body.
 * @param body - bytes or text from a client-module response.
 * @returns the decoded text, or undefined when the body cannot be decoded.
 */
function decodeBundle(body) {
  if (typeof body === 'string') return body
  try {
    return bundleDecoder.decode(body)
  } catch {
    return undefined
  }
}

/** Own-property marker so a reload cycle never double-wraps the registry. */
const REGISTRY_PATCH_FLAG = '__skillDollarBundlePatch'

const bundleDecoder = new TextDecoder()
const bundleEncoder = new TextEncoder()

/** Patched bodies keyed by immutable plugin URL, so a combo is decoded once. */
const patchedBodies = new Map()
const PATCHED_BODY_LIMIT = 32

/**
 * Append the loaded skill body for every `$name` gesture in the claimed user
 * messages. Runs as a pre-step middleware after the downstream decision, so it
 * cannot alter tool policy or reordering performed by other plugins.
 * @param ctx - plugin context carrying the `skills` service.
 */
export function apply(ctx) {
  installClientBundlePatch(ctx)
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const names = invokedSkillNames(messages)
    if (names.length === 0) return decision
    signal.throwIfAborted()
    const lookup = {
      cwd: agent.session.header.cwd,
      signal,
      scope: agent,
    }
    const injections = []
    for (const skillName of names) {
      const skill = await ctx.skills.get(skillName, lookup)
      signal.throwIfAborted()
      if (skill === undefined || !isUserInvocable(skill)) continue
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source: { kind: 'skill-invocation', name: skillName, form: 'instructions' },
      }))
    }
    if (injections.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...injections] }
  })
}

/**
 * `$name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Only direct user input is scanned, so a skill body or tool
 * result can never forge a gesture.
 * @param messages - the step's claimed message batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages) {
  const names = []
  for (const message of messages) {
    if (message.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const skillName = match[2]
        if (skillName !== undefined && !names.includes(skillName)) names.push(skillName)
      }
    }
  }
  return names
}

/**
 * Whether a human-facing command may load this skill. Mirrors
 * `isUserInvocable` from @deepseek-ai/dsh-skill (kept inline so the bundle
 * stays free of bare imports that a link-installed profile cannot resolve).
 * @param skill - resolved skill metadata.
 * @returns whether the policy permits user invocation.
 */
function isUserInvocable(skill) {
  return skill?.invocation?.userInvocable === true
}

/**
 * Render one loaded skill for the model. Output is byte-identical to
 * @deepseek-ai/dsh-skill's `renderSkillContent`, the shape the `skill` tool
 * result also uses, so the model sees one canonical block on both paths.
 * @param skill - resolved skill definition.
 * @returns the complete model-facing `<skill_content>` block.
 */
function renderSkillContent(skill) {
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...renderResourceHint(skill),
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/**
 * Resource-location paragraph for one skill's provider base.
 * @param skill - resolved skill definition.
 * @returns the resource hint lines.
 */
function renderResourceHint(skill) {
  const base = skill.resourceBase
  if (base === undefined) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      'Load referenced resources only as needed.',
    ]
  }
  if (base.kind === 'directory') {
    return [
      `Base directory for this skill: ${escapeText(base.path)}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    ]
  }
  if (base.kind === 'url') {
    return [
      `Base URL for this skill: ${escapeText(base.url)}`,
      'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
    ]
  }
  return [
    `Resources for this skill: ${escapeText(base.description ?? '')}`,
    'Load referenced resources only as needed.',
  ]
}

/**
 * Escape a value embedded in a double-quoted XML attribute.
 * @param value - raw attribute value.
 * @returns the escaped value.
 */
function escapeAttr(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * Escape model-facing prose embedded inside skill markup.
 * @param value - raw prose.
 * @returns the escaped prose.
 */
function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Create one identified, deep-frozen user message. Mirrors
 * @deepseek-ai/dsh-llm's `createUserMessage` without the bare import.
 * @param input - complete content and source for a new user message.
 * @returns an immutable user message with a fresh identity.
 */
function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * Recursively freeze a plain value so downstream consumers see an immutable
 * message, matching the framework's message construction contract.
 * @param value - value to freeze.
 * @returns the same value, frozen.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
