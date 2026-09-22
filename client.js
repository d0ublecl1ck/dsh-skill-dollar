window.__ModuleLoader__.load({
  id: 'dsh-skill-dollar',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // The character this bundle owns. The host half recognises the same char.
    var TRIGGER = '$'
    // Source (menu group) name; 'skill' reuses the input-trigger slash.menu group title.
    var SOURCE_NAME = 'skill'
    var WHITESPACE = /\s/u
    var WORD_CHAR = /[\p{L}\p{N}_]/u
    // A live query must stay inside the skill-name grammar so $VARS/$1 never open the menu.
    var SKILL_QUERY = /^[a-z0-9-]*$/

    // Detect a live $query token under the caret.
    // @returns the token start/query/position, or null.
    function detectDollar(draft, caret, guard) {
      if (guard === undefined || guard === null || guard.tier !== 'plain') return null
      var index = caret
      while (index > 0 && !WHITESPACE.test(draft.charAt(index - 1))) index -= 1
      if (index >= caret) return null
      if (draft.charAt(index) !== TRIGGER) return null
      if (index > 0 && WORD_CHAR.test(draft.charAt(index - 1))) return null
      var query = draft.slice(index + 1, caret)
      if (!SKILL_QUERY.test(query)) return null
      return {
        start: index,
        query: query,
        position: draft.search(/\S/) === index ? 'leading' : 'inline',
      }
    }

    // Install the controller patch once.
    //
    // The built-in detector hard-codes '/' and '@'. The trigger registry,
    // menu reducer, and keyboard arbitration, however, are all keyed by an
    // opaque trigger string, so registering a '$' source and teaching
    // track() to synthesise a '$' hit reuses the whole slash pipeline
    // (MenuView rendering, arrow/Enter/Tab arbitration, span CAS insertion)
    // without forking the core package.
    //
    // Deferred to apply(): when the 'inputTriggers' service is available the
    // input-trigger module and its own dependencies are already materialized,
    // so this require() cannot race the module graph.
    function installTrackPatch() {
      try {
        var InputTriggerController = require('@deepseek-ai/dsh-client-ui-input-trigger').InputTriggerController
        if (InputTriggerController === undefined) return
        var prototype = InputTriggerController.prototype
        if (prototype.__skillDollarPatched === true) return
        var originalTrack = prototype.track
        prototype.track = function (draft, caret, guard, draftRev) {
          var dollar = null
          try {
            dollar = detectDollar(draft, caret, guard)
          } catch (error) {
            dollar = null
          }
          if (dollar === null) return originalTrack.call(this, draft, caret, guard, draftRev)

          var roster = this.deps.roster.sources(TRIGGER)
          if (roster.length === 0) return originalTrack.call(this, draft, caret, guard, draftRev)

          var hit = {
            trigger: TRIGGER,
            query: dollar.query,
            quoted: false,
            position: dollar.position,
            span: { start: dollar.start, end: caret, draftRev: draftRev },
          }
          var previous = this.menu.getSnapshot()
          var alreadyOurs = previous.open && previous.hit !== null && previous.hit.trigger === TRIGGER
          this.clearLauncher()
          this.drilled = false
          this.hit = hit
          if (!alreadyOurs) {
            this.menu.set({
              open: previous.open,
              hit: previous.hit,
              generation: previous.generation,
              groups: [{ source: SOURCE_NAME, status: 'pending', items: [] }],
              highlight: null,
            })
          }
          this.reduce({ type: 'hit', hit: hit })
          this.refreshHeaders(hit, roster)
          this.fetchCandidates(hit, roster)
        }
        Object.defineProperty(prototype, '__skillDollarPatched', { value: true })
      } catch (error) {
        console.error('[skill-dollar] input-trigger module unavailable; the $ menu is disabled', error)
      }
    }

    // Candidate ranking: case-insensitive ordered subsequence, prefix hits
    // first, ties keep host order (the slash menu rankByName contract).
    function isSubsequence(needle, haystack) {
      var at = 0
      for (var i = 0; i < haystack.length && at < needle.length; i += 1) {
        if (haystack.charAt(i) === needle.charAt(at)) at += 1
      }
      return at === needle.length
    }

    function rankSkills(skills, query) {
      var needle = (query === undefined || query === null ? '' : String(query)).toLowerCase()
      var ranked = []
      for (var i = 0; i < skills.length; i += 1) {
        var skill = skills[i]
        var name = String(skill.name).toLowerCase()
        var score
        if (needle === '') score = 0
        else if (name.startsWith(needle)) score = 0
        else if (isSubsequence(needle, name)) score = 1
        else continue
        ranked.push({ skill: skill, score: score, index: i })
      }
      ranked.sort(function (a, b) { return a.score - b.score || a.index - b.index })
      return ranked.map(function (entry) { return entry.skill })
    }

    // Client plugin body: register the '$' candidate source over the skill catalog.
    function apply(ctx) {
      installTrackPatch()
      var skillsRemote = ctx.remote.skills
      var inputTriggers = ctx.inputTriggers
      var catalogs = new Map()
      var lexiconListeners = new Map()

      function notifyLexicon(sessionId) {
        var listeners = lexiconListeners.get(sessionId)
        if (listeners === undefined) return
        for (var listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.error('[skill-dollar] lexicon listener failed', error)
          }
        }
      }

      function fetchCatalog(sessionId) {
        var existing = catalogs.get(sessionId)
        if (existing !== undefined) return existing.promise
        var promise = (async function () {
          var result = await skillsRemote.list({ sessionId: sessionId })
          if (!result.ok) throw new Error('skills/list failed: ' + result.error.code + ': ' + result.error.message)
          return result.value.skills
        })()
        var entry = { promise: promise }
        catalogs.set(sessionId, entry)
        promise.then(function (list) {
          entry.settled = list
          notifyLexicon(sessionId)
        }, function () {
          if (catalogs.get(sessionId) === entry) catalogs.delete(sessionId)
        })
        return promise
      }

      function invalidate(sessionId) {
        var entry = catalogs.get(sessionId)
        if (entry === undefined) return
        catalogs.delete(sessionId)
        notifyLexicon(sessionId)
      }

      function clearAll() {
        for (var key of Array.from(catalogs.keys())) invalidate(key)
      }

      var source = {
        trigger: TRIGGER,
        name: SOURCE_NAME,
        order: 0,
        async candidates(session, request) {
          var list = await fetchCatalog(session.sessionId)
          if (request.signal.aborted) return []
          return rankSkills(list, request.query).map(function (skill) {
            var candidate = { name: skill.name }
            if (typeof skill.description === 'string') candidate.description = skill.description
            return candidate
          })
        },
        warm(session) {
          fetchCatalog(session.sessionId).catch(function () {})
        },
        lexicon(session) {
          var entry = catalogs.get(session.sessionId)
          if (entry === undefined || entry.settled === undefined) return undefined
          return entry.settled.map(function (skill) { return skill.name })
        },
        subscribeLexicon(session, listener) {
          var sessionId = session.sessionId
          var listeners = lexiconListeners.get(sessionId)
          if (listeners === undefined) {
            listeners = new Set()
            lexiconListeners.set(sessionId, listeners)
          }
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
            if (listeners.size === 0) lexiconListeners.delete(sessionId)
          }
        },
        onPick(pick) {
          return { text: TRIGGER + pick.candidate.name + ' ' }
        },
      }

      if (ctx.remote !== undefined && typeof ctx.remote.$on === 'function') {
        ctx.remote.$on('agent-preset/selected', invalidate)
      }
      ctx.on('connection/reset', clearAll)
      ctx.effect(function () {
        var unregister = inputTriggers.registerSource(source)
        return function () {
          unregister()
          clearAll()
        }
      }, 'skill-dollar: dollar source')
    }

    exports.apply = apply
    exports.inject = ['inputTriggers', 'remote', 'remote.skills']
    return module.exports
  },
})
