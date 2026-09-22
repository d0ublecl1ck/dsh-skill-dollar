import { randomUUID } from 'node:crypto'

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
 * Append the loaded skill body for every `$name` gesture in the claimed user
 * messages. Runs as a pre-step middleware after the downstream decision, so it
 * cannot alter tool policy or reordering performed by other plugins.
 * @param ctx - plugin context carrying the `skills` service.
 */
export function apply(ctx) {
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
