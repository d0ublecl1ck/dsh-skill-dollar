/**
 * Shared transform for the composer's plain-text reference scan.
 *
 * @deepseek-ai/dsh-client-ui-conversation decorates a draft token blue when its
 * trigger char and name are both in the input-trigger lexicon. The lexicon is
 * keyed by arbitrary trigger strings, so the `$` skill source already
 * publishes its names there; the only closed set is the scan's own token regex,
 * which is hard-coded to `/` and `@`. These two literal
 * substitutions teach that regex about `$`, giving a `$name`
 * gesture the same blue text-ref decoration as `/name`.
 *
 * The transform is shared by the two halves of the fix:
 *
 *   - the host half (index.js) patches the bytes ClientModuleRegistry serves,
 *     so it works inside DSH Desktop, whose app.asar is integrity-sealed and
 *     cannot be edited on disk;
 *   - patch-core.mjs keeps the legacy on-disk path for hosts that predate the
 *     clientModules service.
 */

/** Package that owns the composer's plain-text reference scan. */
export const CONVERSATION_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'

/** Token matcher as shipped: a trigger char at line start or after whitespace. */
export const ORIGINAL_TEXT_REF_RE = 'const TEXT_REF_RE = /(^|\\s)([/@])([\\w-]+)/g;'

/** Token matcher with `$` added to the trigger class. */
export const PATCHED_TEXT_REF_RE = 'const TEXT_REF_RE = /(^|\\s)([/@$])([\\w-]+)/g;'

/** The `/`-only end-boundary rule as shipped. */
export const ORIGINAL_SLASH_END = 'if (trigger === "/" && !SLASH_TOKEN_END_RE.test(draft.slice(m.index + m[0].length))) continue;'

/** The same end-boundary rule applied to `$` as well. */
export const PATCHED_SLASH_END = 'if ((trigger === "/" || trigger === "$") && !SLASH_TOKEN_END_RE.test(draft.slice(m.index + m[0].length))) continue;'

/**
 * Cache-busting version for the served patch. Bump it whenever the patched
 * bytes change so browsers fetching an immutable `/plugins` URL see the
 * new content instead of a stale cached combo. The host half salts the module
 * revision with this value.
 */
export const TEXT_REF_PATCH_VERSION = 1

/** Milliseconds added to the module's mtime-derived revision to force a refetch. */
export const TEXT_REF_PATCH_SALT_MS = TEXT_REF_PATCH_VERSION * 1000

/**
 * Whether source already carries the `$` variant of the scan.
 * @param source - candidate bundle text.
 * @returns whether both substitutions are present.
 */
export function isPatchedConversationBundle(source) {
  return typeof source === 'string' &&
    source.includes(PATCHED_TEXT_REF_RE) &&
    source.includes(PATCHED_SLASH_END)
}

/**
 * Teach one conversation bundle about `$`.
 *
 * Idempotent and conservative: a source that already carries the patch, or that
 * does not carry the exact shipped patterns, is returned byte-for-byte. The
 * replacement callbacks keep the `$` in the replacement literal inert.
 * @param source - complete bundle text.
 * @returns the patched text, or the original text when the patterns are absent.
 */
export function patchConversationBundle(source) {
  if (typeof source !== 'string' || isPatchedConversationBundle(source)) return source
  if (!source.includes(ORIGINAL_TEXT_REF_RE) || !source.includes(ORIGINAL_SLASH_END)) return source
  return source
    .replace(ORIGINAL_TEXT_REF_RE, () => PATCHED_TEXT_REF_RE)
    .replace(ORIGINAL_SLASH_END, () => PATCHED_SLASH_END)
}

/**
 * Whether a resolved client bundle path is the conversation package's entry.
 * @param clientPath - absolute path handed to the registry's baseline capture.
 * @returns whether this is the bundle whose revision must be salted.
 */
export function isConversationBundlePath(clientPath) {
  return typeof clientPath === 'string' &&
    clientPath.includes(CONVERSATION_PACKAGE) &&
    clientPath.endsWith('client.js')
}
