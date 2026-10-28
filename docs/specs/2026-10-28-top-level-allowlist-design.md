# Boundary check: top-level allow list

Status: implemented, 2026-10-28. Extends the boundary check in `scripts/boundary-check.mjs`.

## Problem

The boundary check scans content and paths against rules. Rules can only catch what they anticipate. A new folder or file at the top level of the repository can bring in material nobody planned for, and no content rule would notice. Each new top-level entry should therefore be a deliberate, reviewed decision rather than a side effect of another change.

## Goals and non-goals

Goals:

- Every new top-level entry is reported until someone adds it to an allow list on purpose.
- The layout check needs no secrets and no rules, so it works wherever the script runs.
- Its output is safe to print in public CI logs.

Non-goals:

- No configuration file for the list (see Alternatives considered).
- No per-file exceptions.
- No change to how the existing term and path rules match or report.

## Design

### Allow list

`ALLOWED_TOP_LEVEL` in `scripts/boundary-check.mjs` lists the permitted entries. Directories carry a trailing slash: `.github/`, `apps/`, `docs/`, `packages/`, `scripts/`. Root files do not: `.gitattributes`, `.gitignore`, `README.md`, `CONTRIBUTING.md`. A path below a file entry, or a root file named like a directory entry, is not allowed. `CONTRIBUTING.md` tells contributors to add new top-level entries to this list.

### Check

`checkTopLevel(paths, allowed = ALLOWED_TOP_LEVEL)` returns one finding `{ path, line: 0, entry, kind: "top-level" }` per path outside the list, in input order. The comparison is case-sensitive: git records the exact case of every path and reports it the same way on every platform.

### Output

The message names the path and the entry and says to add the entry to `ALLOWED_TOP_LEVEL` if it belongs in the repository. Path and entry are printed JSON-quoted, and control characters as well as Unicode line and paragraph separators are escaped, so a file name cannot inject terminal sequences or CI log commands. The message contains nothing secret, so it is identical with and without `--redact`. The closing summary line covers both kinds of findings: rephrase or move content, or add an allowed top-level entry deliberately.

### Run order and exit codes

List names from git with `-z` → check the top level → load the rules → read the readable files → scan → report, top-level findings first.

- `--staged` lists added, copied, modified and renamed staged files and reads every one of them from the index.
- `--all` lists tracked files plus untracked files that are not ignored. The layout check and the existing `path:` rules see every listed name. The content scan only reads names that exist on disk, so an entry git lists but that cannot be read (for example a dangling symlink, or a tracked file deleted from the working tree) is still checked for its layout and its path, but not for content.
- Exit 0 when clean, 1 on any finding.
- If the rules cannot be loaded or a file cannot be read, the top-level findings are still printed, followed by the configuration error, and the exit code is 2.
- If git cannot list the files, the check exits 2 without findings.

## Alternatives considered

- **Deny-list path rules** (the existing `path:` rules): they catch only names known in advance; an unforeseen new entry passes.
- **List in a configuration file:** a change would sit in a side file and is easy to overlook; inside the script it is reviewed together with the check.
- **Branch protection or code-owner review only:** depends on a reviewer noticing the new entry and gives no feedback before the commit.
- **Local hook only:** does not run in CI.
- **One finding per top-level entry instead of per file:** per-file findings keep the reporting identical to the existing rules; the extra output for large folders is listed as a limit below.

## Risks and limits

- **Log and terminal injection:** mitigated by quoting and escaping in the top-level message. The existing term and path messages still print the raw path; aligning them is follow-up work, because this change keeps their behaviour unchanged.
- **Pull requests from forks:** the CI step that runs the script needs the rules secret and is skipped for forks, so the layout check runs there only after merge, on `main`. Accepted while external contributions are rare; maintainers review new top-level entries by hand. A rules-free CI step can be added when needed.
- **History operations:** merges, cherry-picks and rebases do not run the pre-commit hook. CI on `main` still runs the full check.
- **Local friction:** in `--all` mode, any untracked root file that is not ignored (editor folders, scratch notes) is reported. This is intended: add the entry or ignore the file.
- **Noise:** an unlisted folder with many files produces one line per file.
- **Upkeep:** adding an entry means editing `ALLOWED_TOP_LEVEL` and the test that pins the list.

## Tests

`scripts/boundary-check.test.mjs` covers:

- the exact list contents
- files under allowed entries produce no finding; unlisted folders and root files produce one finding each
- case sensitivity and a custom allow list
- a path below an allowed file entry, and a root file named like an allowed directory
- unreadable names: the layout check and path rules see every name, only the content scan skips them
- the message: path, entry and allow list named, identical with and without redact, a single line without raw control characters
- `main` end to end: exit 1 for a top-level finding, exit 2 with top-level findings printed before a configuration error, exit 0 when clean

The end-to-end tests use a helper that creates a temporary git repository, clears `CI` so the output is not redacted, keeps its rules file inside `.git/` so git does not list it, and runs `--all --rules`.
