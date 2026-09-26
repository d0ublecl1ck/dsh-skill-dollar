# dsh-skill-dollar

Invoke DeepSeek Harness skills with a `$` gesture instead of `/`.

DSH already uses `/name` for both host commands and user-invocable skills. This
bundle keeps `/` for commands and adds a parallel `$name` gesture for skills,
with the same composer menu, fuzzy ranking, keyboard pick, and deterministic
host-side injection that the `/` skill path uses.

## What it does

- **Client half (`client.js`)** registers a candidate source under the trigger
  char `$` over the session skill catalog (`skills/list`). Typing `$` in the
  composer opens the normal trigger menu (title "Skills" / "技能") filtered by
  an ordered-subsequence query. Picking a row inserts the literal text
  `$skill-name `.
- **Host half (`index.js`)** listens on `agent/pre-step`, recognises the
  whitespace-bounded `$name` token in direct user messages, resolves it through
  the `skills` service, and appends the canonical `<skill_content>` block —
  byte-identical to what `dsh-tool-skill` does for `/name`.

Because the bridge is plain draft text, a menu pick and a hand-typed `$name`
are the same gesture, exactly like the built-in slash pipeline.

## How the client half plugs into the core

The input-trigger package hard-codes `'/' | '@'` in its `detectTrigger`, but
the rest of the pipeline (source registry, menu reducer, keyboard arbitration,
span CAS insertion) is keyed by an opaque trigger string. The client half:

1. declares `@deepseek-ai/dsh-client-ui-input-trigger` in `dsh.client.inject`;
2. `require`s that module from its factory and patches
   `InputTriggerController.prototype.track`;
3. on a live `$query` token, synthesises a hit with `trigger: '$'` and drives
   the controller's own `reduce`/`fetchCandidates`/`refreshHeaders` against the
   `'$'` roster, so MenuView rendering and keyboard arbitration are reused
   without forking the core package.

When no `$token` is live the original `track` runs untouched, so `/` and `@`
behaviour is unchanged. If the core module shape ever changes, the patch
degrades to a console error and the host half still makes a hand-typed `$name`
work.

## Install into a profile

The plugin directory is this repository root.

```sh
dsh plugin --profile web add /absolute/path/to/dsh-skill-dollar
dsh --profile web --dump-config
```

`dsh plugin` forwards to pnpm inside the profile and rebuilds
`dsh.profile.bundles`. Then restart the web app so the new client module joins
the boot graph: the host composes the client module manifest at startup, so a
running `dsh web` must be restarted to serve `client.js`.

## Install into DSH Desktop

DSH Desktop runs its own harness home — `~/Library/Application Support/dsh-desktop/harness`
on macOS — and snapshots every installed plugin into a content-addressed
"generation" under `profiles/.generations/live/`. Two consequences matter:

- a `link:` install in `~/.dsh/profiles/web` does **not** reach Desktop; and
- a running Desktop keeps the generation it booted from, so a plugin edit is
  only picked up after the profile is refreshed and Desktop restarts.

After editing this repo, reinstall/update `dsh-skill-dollar` in Desktop's
profile (its plugin market or settings surface) so a new generation is built,
then restart DSH Desktop. The version is bumped with each behavior change so
the update is visible. Nothing else needs a manual step: the decoration is
applied at boot by the plugin's host half (see below), never by editing a file
inside the app bundle.

## Verify

Host composition and activation:

```sh
node <create-dsh-plugin-skill>/scripts/verify-dsh-plugin.mjs --plugin-dir .
```

The ladder covers G1 manifest, G2 shape, G3 install, G4 compose, G5 activate.
The client half is browser-side and cannot be proven by G5; verify it by
opening the web app, typing `$` in the composer, and confirming the skill menu
appears and a pick loads the skill.

## Blue text-ref decoration (`$` parity with `/`)

The composer's blue "this is a reference" treatment is produced by a plain-text
scan in `@deepseek-ai/dsh-client-ui-conversation`. Its token regex is
hard-coded to `/` and `@`, and the trigger set is closed there — the
input-trigger lexicon is already keyed by arbitrary trigger strings, and this
plugin already publishes its skill names under `$`, but the scan never looks
for `$`. No plugin API registers another text-ref trigger, so exact parity
needs two literal substitutions in that bundle:

- `TEXT_REF_RE` becomes `/(^|\s)([/@$])([\w-]+)/g`;
- the `/`-only end-boundary rule (a token must end at whitespace or the draft
  end) is applied to `$` as well.

### Served at runtime (works in DSH Desktop)

Editing the file on disk is not an option inside DSH Desktop: the bundle lives
in `app.asar`/`app.asar.unpacked`, whose unpacked files carry SHA-256
integrity hashes (`ElectronAsarIntegrity` in `Info.plist`), so a modified
byte fails Electron's integrity check and invalidates the code signature.

Instead the host half (`index.js`) rewrites the bundle **while it is served**.
`@deepseek-ai/dsh-client-modules` snapshots every client bundle in memory at
boot and hands responses back through
`ClientModuleRegistry.bundleResource`; the plugin wraps that method,
substitutes `$` into the scan, and returns the patched bytes. Degradation
stays graceful:

- the wrapper only touches `text/javascript` bodies that contain the shipped
  scan, so source maps and unrelated bundles pass through untouched;
- if there is no `clientModules` service (older DSH), the plugin logs a hint
  and the `$` menu and host injection still work;
- the substitution is idempotent, so replaying it changes nothing.

Immutable `/plugins` URLs are cached by the browser for a year, so different
bytes under the same URL would never be fetched. The plugin also salts the
conversation row's revision (`captureArtifactBaseline`) and calls
`rebuilt()`, which recomposes the boot graph with a fresh URL and forces the
fetch. Bump `TEXT_REF_PATCH_VERSION` in `bundle-patch.mjs` when the patched
bytes change.

A host that derives revisions from bundle *content* instead of file metadata
does not see that salt (DSH 0.1.5 and earlier, including the current
`npx dsh web`). On such a host the plugin logs a hint and you run the legacy
patch once; the host's content-derived revision then changes and busts the
cache by itself.

### Legacy fallback

`patch-core.mjs` still applies the same two substitutions to a bundle on disk
for hosts whose bundle revisions come from content (DSH 0.1.5 and earlier),
which cannot be cache-busted in memory:

```sh
node patch-core.mjs            # resolve the bundle from the dsh install
node patch-core.mjs --check    # exit non-zero when the patch is missing
node patch-core.mjs --file <client.js>
```

Re-run it after a DSH upgrade only if you are on such a host; on DSH 0.1.7+ the
served-at-runtime patch leaves nothing to re-apply.

## Design notes

- The trigger char is deliberately fixed at `$`. The host and client halves must
  agree on it, and a host-only config knob would silently break the picked text,
  so there is no such knob.
- The host half adds no bare package imports (only the `node:crypto` builtin
  and its own relative `./bundle-patch.mjs`) so a `link:`-installed profile can
  resolve it; the two small framework helpers it needs (`renderSkillContent`,
  `createUserMessage`) are inlined byte-for-byte from `@deepseek-ai/dsh-skill`
  and `@deepseek-ai/dsh-llm`.
- The decoration never writes to the DSH install. Both the served bytes and the
  salted revision are applied in memory, so DSH Desktop's integrity-sealed
  `app.asar` and code signature stay valid.
- `$VARS` and shell-style tokens do not open the menu: a live query must match
  `^[a-z0-9-]*$`, the skill-name grammar.
