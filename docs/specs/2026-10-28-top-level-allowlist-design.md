# Boundary check: top-level allow list

Status: proposed, 2026-10-28. Extends the boundary check in `scripts/boundary-check.mjs`.

## Purpose

The check keeps the repository layout intentional. Every file whose first path segment (a folder or a file in the repository root) is not on a fixed list is reported, so a new top-level entry is always a deliberate, reviewed change.

## Change

- `ALLOWED_TOP_LEVEL` in `scripts/boundary-check.mjs` lists the permitted entries. Directories carry a trailing slash: `.github/`, `apps/`, `docs/`, `packages/`, `scripts/`. Root files do not: `.gitattributes`, `.gitignore`, `README.md`, `CONTRIBUTING.md`. A path below a file entry, or a root file named like a directory entry, is a finding.
- `checkTopLevel(paths, allowed)` returns one finding `{ path, line: 0, entry, kind: "top-level" }` per file outside the list. The comparison is case-sensitive, because git on Linux and in CI compares names that way.
- The message names the path and the entry and says to add the entry to `ALLOWED_TOP_LEVEL` if it belongs in the repository. Path and entry are printed JSON-quoted with control characters escaped, so file names cannot inject terminal or CI log commands. It contains nothing secret, so it is identical with and without `--redact`. Entries git lists but that cannot be read (for example a dangling symlink) are still checked.
- The check runs on the same file list as the existing rules (`--staged`: added, copied, modified and renamed staged files; `--all`: tracked plus untracked files that are not ignored). It runs before the rules are loaded and needs none.
- If the rules cannot be loaded, the top-level findings are still printed, followed by the existing configuration error, and the exit code stays 2. Otherwise all findings are reported together: exit 1 on any finding, 0 when clean.

## Non-goals

- No configuration file for the list: a change to it should show up in review of the script.
- No per-file exceptions.
- No separate CI step for pull requests from forks.

## Tests

`scripts/boundary-check.test.mjs` covers allowed entries, unlisted folders and root files, case sensitivity, a custom list, the exact list contents, and the message.
