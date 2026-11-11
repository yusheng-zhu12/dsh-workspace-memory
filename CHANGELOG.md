# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-11

### Changed

- **Package renamed to `@yusheng-zhu12/dsh-workspace-memory`.** The unscoped name
  `dsh-workspace-memory` is already published on npm by another author, so the
  plugin could never be installed by that name without ambiguity. `package.json`
  and `cordis.patch.yml` now carry the scoped name; the loader row id stays
  `workspace-memory`, the repository keeps its name, and the release tarball is
  now `yusheng-zhu12-dsh-workspace-memory-<version>.tgz`.
- Installing, disabling, or removing the bundle now uses the scoped name, e.g.
  `plugin_manager remove_bundle({ target: "@yusheng-zhu12/dsh-workspace-memory" })`.
  An install of the old name should be removed before installing this one.

## [0.1.7] - 2026-11-11

First public release.

### Added

- Workspace-scoped memory file at `.dsh-memory/MEMORY.md`, anchored to the
  registered workspace root so a session in a subdirectory shares one file.
- A short memory index injected into each session's runtime context through a
  per-agent `systemPrompt.context` (order 62): titles, one-line summaries and
  the file path, bounded by `injectBudget`, with content escaped so a note can
  never close the host's `<system-reminder>` frame.
- Five tools: `memory_save`, `memory_read`, `memory_list`, `memory_forget`,
  `memory_restore`.
- `mode` is required on every save (`replace` / `append`), so the model states
  its intent instead of defaulting to an overwrite.
- Replacing a topic this conversation has not read is refused; the read mark is
  tied to the file signature, so an external edit forces a re-read.
- One-generation backup (`.dsh-memory/MEMORY.md.bak`) written before every
  modification, plus `memory_restore` to roll back one step.
- Conservative secret redaction before writing (`sk-*`, `AKIA*`, `LTAI*`,
  `gh*_*`, JWT, `Bearer`, `key=value` pairs, PEM private keys).
- Atomic writes (temporary file + rename) and a per-path in-process lock.
- Path safety: relative `memoryFile` only, no `..`, no symlinked file or
  directory escaping the workspace root.
- 110 tests (`node --test`): 109 pass, 1 skipped on Windows (file symlink needs
  extra privileges; the directory-junction escape test runs).

## [0.1.7] - 2026-11-11

### Fixed (v0.1.6 re-audit)

- **At the hard ceiling, `raise` no longer suggests an impossible value.** With
  10,000 topics (or a 64 MiB / 4 MiB cap already reached) the message used to
  say "raise it above 10000 (for example 10001)", which the range check then
  rejected. It now names the maximum and points at shrinking the memory or
  `set`; otherwise the suggestion is clamped to the ceiling.
- **A file past the read limit is refused, not guessed.** `raise`/`set` derived
  their floor from a truncated prefix, so the required minimum could be too low.
  They now stop with "the memory file is larger than the read limit, so its
  usage cannot be counted".
- **A no-op `raise` at the stored usage explains itself.** When the cap already
  equals what is stored, the answer says it leaves no room and that the value
  must go above the stored usage, instead of a bare "nothing changed".

## [0.1.6] - 2026-11-11

### Fixed (v0.1.5 re-audit)

- **`raise` now leaves room.** A cap that merely equals what is stored was
  accepted, so "raise it to at least N" produced no usable space and the "full"
  prompt came back on the next save. `raise` requires a value **above** the
  stored usage (at least one more) and says so; `set` may still freeze the usage
  exactly.
- **`memory_limits show` counts the whole file** when it is already over its cap
  (it read only the first `maxFileBytes` and reported 3 topics for a 6-topic
  file). A genuinely truncated read now says "at least N topics" and marks the
  candidate list as partial.
- Docs: the README and the tool description state that both actions are held to
  the stored usage, and that `raise` must exceed it.

## [0.1.5] - 2026-11-11

### Fixed (v0.1.4 re-audit)

- **A change that cannot be persisted is refused before the user is asked.** The
  config editor and the plugin row are checked up front, so a profile without
  them no longer prompts for an answer it cannot act on.
- **A cancelled question is reported as a cancellation**, not as "the user
  cannot be asked from this context". A genuinely failed question now surfaces
  the underlying reason instead of being folded into the same message.
- **`raise` is held to the stored usage, not just the configured cap.** Raising
  `maxTopics` above the cap but below the number of stored notes (or
  `maxFileBytes` below the current file size) is refused with the value needed,
  so "raise the limit" no longer succeeds while the file stays over its cap.
  The usage is counted from the whole file, not from the first `maxFileBytes`.
- **Raising to the value a limit already has** returns "nothing changed" without
  prompting.
- Docs: test count, the "five model-facing tools" comment, and the tarball file
  list in PUBLISHING.md.

## [0.1.4] - 2026-11-11

### Added

- **`memory_limits action: "set"`** applies any value after the user confirms,
  so a limit raised earlier can be lowered again from the conversation instead
  of by editing the profile patch. It refuses a value below what is already
  stored (topics, file bytes, the largest note) — a lower cap would leave those
  notes readable but impossible to update — and it shares `raise`'s
  confirmation prompt and persistence path.

## [0.1.3] - 2026-11-11

### Fixed (v0.1.2 re-audit)

- **A `<!--` in a heading or body could hide topics.** The comment masker treated
  any `<!--` anywhere on a line as opening a comment, so `## topic <!-- note -->`
  vanished from the index, and an unterminated `<!--` hid every heading after it.
  Only a comment that starts its own line and is actually closed now masks
  anything; an inline marker is ordinary text. Saved notes whose title contains
  `<!--` stay listable.
- **`memory_limits raise` could lower a limit** while reporting "Raised …",
  which turned the workspace read-only. Every provided value must now be at
  least the current one; lowering is refused with an explanation.
- **Raising no longer trusts a model-filled `confirm`.** The tool asks the user
  through the host's question service (`Raise` / `Cancel`) and applies the change
  only on an affirmative answer; when no answerer exists it fails closed instead
  of writing profile configuration.
- **`memory_limits show` no longer tells the model to ask the user** at low
  usage; the reminder appears only from 80% of a cap.
- **Titles longer than 500 characters could not be read or deleted**; lookups no
  longer truncate.
- **The secret-in-title refusal echoed the redacted title**, leaking the surviving
  prefix into the tool result; it now names the matched rule only.
- Docs: response field names (`bodyChars` / `discardedChars`), tool counts and
  test counts brought in line with the code.

## [0.1.2] - 2026-11-11

### Fixed

- **The plugin could come up empty at boot.** Tools were registered from a
  single `ctx.get('tools')` read taken during activation, and the per-agent
  listeners were installed inside `ctx.inject(['systemPrompt'])`; when the row
  activated before those services were mounted, no tools and no index appeared
  until the bundle was toggled. Tool registration now runs inside
  `ctx.inject(['tools'])`, and the agent listeners are installed at apply time,
  with a re-scan of live agents once the prompt service mounts.

## [0.1.1] - 2026-11-11

### Added

- **`memory_limits`**: reports the current limits and how full the file is
  (`action: "show"`), or raises a limit (`action: "raise"`). Raising requires
  `confirm: true` and is meant to run only after the user agreed; it writes the
  new value through the profile's config editor, so it survives a restart.
- **A limit refusal asks the user what to do.** Reaching `maxTopics`, or a write
  that would grow the file past `maxFileBytes`, returns the three largest and
  the three oldest notes (title, size, update date) and tells the model to ask
  the user whether to merge, delete, or raise the limit. Nothing is written, and
  the model is told not to merge, delete, or raise a limit on its own.

### Changed

- The configurable ceilings sit above the defaults (10,000 topics, 4 MiB per
  note, 64 MiB per file) so a workspace can be expanded later without a code
  change, and the hard read limit now scales with `maxFileBytes` (never below
  8 MiB) instead of being a fixed ceiling. The defaults are unchanged:
  100 topics, 16 KiB per note, 256 KiB per file.

### Fixed (v0.1.0 audit)

- **Read gate was process-wide.** A read in any session unlocked `replace` for
  every session in the process. Marks are now keyed by conversation, so another
  window or subagent reading a note does not unlock it for you.
- **Any write invalidated every read mark.** Marks are now the content digest of
  one note: writing topic A leaves B's mark valid, while a hand edit of B still
  requires a re-read. A note that was just written counts as read for its
  author, so an immediate follow-up `replace` is no longer refused.
- **Redaction skipped titles and tags.** A secret in `tags` is now redacted
  before the 32-character truncation, and a secret in `topic` is refused with an
  actionable error instead of being written into every request's context.
- **An oversized file deadlocked every write**, including the `memory_forget`
  the error suggested. Reads are now allowed up to an 8 MiB hard limit and a
  write that shrinks the file is accepted, so the file can be repaired from
  inside the plugin.
- **Dates were UTC**, showing the previous day for UTC+8 users; they are now
  formatted in local time.
- **The replace warning counted bytes but said "characters"**; it now counts
  characters, which also makes the 200-character threshold behave as documented
  for CJK notes.
- **`memoryFile` validation disagreed with the resolver**: `.`, `C:foo`, `a/.`
  and `a//b` were accepted at activation and failed on every call (or silently
  became a different file). They now fail activation, and `enabled: false`
  bypasses the rest of validation so a bad row can still be switched off.
- **Long hand-written headings could not be read or deleted** because the
  120-character write limit also applied to lookups; lookups are now unbounded
  by that limit.
- **`##` inside HTML comments or fenced code blocks was parsed as a topic** and
  could be moved out of the comment by the next save; the parser now skips
  those regions.
- `tools: false` no longer leaves the index pointing at unregistered tools, the
  plugin no longer requires the `tools` service to load, and `memory_restore`
  documents that it cannot be undone.

[0.1.0]: https://github.com/yusheng-zhu12/dsh-workspace-memory/releases/tag/v0.1.0
