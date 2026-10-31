# op8x CLI: safe copyable commands

*   **Author:** op8x
*   **Status:** Approved, 2026-10-31
*   **Date:** 2026-10-31

Extends `./2026-10-31-cli-challenge-hints-design.md` (the "Not checked by op8x check" block), `../specs/2026-10-24-cli-check-design.md` (the header line and the "Reproduce:" lines) and `../specs/2026-10-27-cli-mcp-endpoint-design.md` (the `mcp-endpoint` fix command).

--------------------------------------------------------------------------------

## Overview

`op8x check <url>` prints shell commands that the reader can copy and run to repeat a check. Four places print a command that contains the checked URL: the header line, the `Reproduce:` lines, the commands in the "Not checked by op8x check" block, and the command in the fix text of the `mcp-endpoint` finding. This design makes sure that pasting any of these command lines into bash, zsh or PowerShell runs exactly the command shown and nothing else, that no user name or password from the URL is printed, and that the `curl -i` lines work in Windows PowerShell 5.1 and for URLs with brackets.

The Technical Plan has five parts: two new input rules, a stricter `quote()`, a quoted header line, a `curl` program name chosen per platform, and the README. There is no quoting scheme per shell.

## The Problem

Shells treat some characters as instructions. The CLI quotes URLs for POSIX shells (`'...'`, with `'` written as `'\''`). That quoting is correct for bash and zsh, but the same lines are often pasted elsewhere. Sellers also let AI agents run the CLI and execute the printed lines without a person reading them first, so a note in the documentation alone does not protect them.

Reproduced on Windows 11 with a local server on 127.0.0.1, with Node 24 and curl 8.18:

1. **PowerShell runs code from the URL when the URL contains `'`.** PowerShell writes `'` inside single quotes as `''`, not as `'\''`. A URL such as `http://host/a'$(...)'b` ends the quoted string early, and PowerShell evaluates `$(...)`. This happened in every printed command line that contains the URL (the `Reproduce:` lines, the "Not checked" block, and by the same quoting the `mcp-endpoint` fix command). Without `'` in the URL, PowerShell keeps the text as it is.
2. **The header line is not quoted.** `op8x check <url>` looks like a command. Pasted into bash, a URL such as `http://host/a;id` runs `id`.
3. **The password is printed.** For `http://alice:s3cr3t@host/`, Node's `fetch` refuses to send the request, so the check cannot work. The password still appears in the header line, the error text, the `curl` lines and the JSON field `url`. The messages "Not a valid URL" and "Only http and https URLs are supported" repeat it too. Without a scheme (`alice:s3cr3t@host/paid`), the parser reads `alice:` as the scheme, so the user name and password fields are empty while the text still contains the password.
4. **`curl` fails in Windows PowerShell 5.1.** There `curl` is a built-in alias for `Invoke-WebRequest`, which does not accept curl's options. Every `curl -i` line fails. `curl.exe` (shipped with Windows 10 and 11) works.
5. **`curl` reads brackets and braces in the URL as patterns.** A normal URL such as `?filter[status]=1` makes curl stop with exit code 3; `[1-1000000]` would send a million requests. curl's option `-g` (`--globoff`) turns this off.
6. **cmd.exe cannot be made safe with the same lines.** In cmd.exe, `'` is not a quote character, `&` starts a second command and `%NAME%` is replaced with an environment variable. `&` is normal in query strings (`?a=1&b=2`), so the CLI cannot refuse it. The same applies when PowerShell runs a `.cmd` file, for example `npx.cmd` or the `op8x.cmd` that npm installs on Windows.

A crafted URL needs a reader who checks a URL written by someone else, for example one taken from a public listing. A seller checking their own endpoint is not at risk from items 1 and 2. Items 3, 4 and 5 affect normal use.

## Goals

*   Pasting any command line the CLI prints (header line, `Reproduce:` lines, "Not checked" commands, the `mcp-endpoint` fix command; in text or as a JSON string value) into bash or zsh runs only the command shown. The same holds in PowerShell when the program named first runs as a PowerShell script (`.ps1`) or a program (`.exe`), not as a `.cmd` file.
*   No user name or password from the URL appears in any output, including error messages.
*   The `curl -i` lines in `Reproduce:` work in Windows PowerShell 5.1 and with URLs that contain `[`, `]`, `{` or `}`.
*   The README states which shells the printed commands are for, that cmd.exe and `.cmd` files are not supported, that the CDP validate line needs bash, zsh or PowerShell 7.3 or later, and that on Windows `npx` and `op8x` should run from PowerShell with scripts allowed or from Git Bash.

## Non-Goals

*   Commands for cmd.exe, and any partial protection for cmd.exe (such as refusing `%`).
*   A `--shell` option or a separate quoting scheme for PowerShell.
*   Rewriting the CDP validate line for PowerShell (for example with `Invoke-RestMethod`).
*   Leaving out `npx` lines on Windows when the URL contains `&` or `%`.
*   Shells other than bash, zsh and PowerShell (for example fish or tcsh).
*   Filtering text that the checked server controls (for example the `Location` header in redirect findings). That text is not a command; it is a separate fix.
*   Hiding secrets in the query string (`?key=...`). The URL is printed as given; see Risks.

## Decisions

Decided on 2026-10-31:

*   URLs that contain `'` or `"` are refused at input, not checked without commands (see Alternatives A and C).
*   cmd.exe is not supported. The `npx.cmd` case is documented, not handled in code (see Alternative D and Risks).
*   On Windows the `Reproduce:` lines use `curl.exe`; the JSON stays the same on every platform (see Alternative F).

## Open Questions

*   None.

## Critical User Journeys (CUJs)

### CUJ 1: An agent checks a URL from a public listing

*   **Given**: An agent on Windows runs `op8x check` on a URL it found in a listing. The URL contains `'`.
*   **When**: The agent runs the check.
*   **Then**: The CLI exits with code 2 and prints that URLs containing `'` or `"` are not supported. It sends no request and prints no command.

### CUJ 2: A seller passes a URL with a password

*   **Given**: A seller runs `op8x check https://alice:s3cr3t@api.example.com/paid`, or the same without `https://`.
*   **When**: The CLI reads the URL.
*   **Then**: The CLI exits with code 2. Neither `alice` nor `s3cr3t` appears in standard output or standard error. This also holds when the scheme is not http or https, or when the URL does not parse.

### CUJ 3: A seller on Windows repeats a check in PowerShell

*   **Given**: A seller on Windows runs `op8x check` in PowerShell 5.1 or in Git Bash, on a normal URL.
*   **When**: The seller copies a line from `Reproduce:` into PowerShell 5.1.
*   **Then**: The line starts with `curl.exe -g -i` and sends the request shown.

### CUJ 4: A seller on macOS or Linux

*   **Given**: A seller runs `op8x check` on macOS or Linux, on a URL with `?filter[status]=1`.
*   **When**: The seller copies any printed command line into bash or zsh.
*   **Then**: The `Reproduce:` lines start with `curl -g -i`, send the request shown and run nothing else. The JSON output is the same on every platform.

## Technical Plan (Architecture)

```text
argv ──► cli.ts run()
          1. parse URL          fails  ─► exit 2 "Not a valid URL."              (input not echoed)
          2. user name/password present ─► exit 2 "...user name or password..."   (URL not echoed)
          3. href contains ' or "       ─► exit 2 "...contain ' or \" ..."        (URL not echoed)
          4. scheme not http/https      ─► exit 2 "Only http and https URLs are supported." (URL not echoed)
          5. probes, rules, buildReport (unchanged)
          6. renderText(report, color, curl)   or   renderJson(report)

bin.ts ──► Io { color, curl: curlFor(process.platform) }   // "curl.exe" on win32, else "curl"
```

### 1. Input checks (`cli.ts`)

*   **No input is echoed.** None of the four messages repeats the input or `url.href`. The input may hold a password that the parser does not recognize as one: without a scheme, `alice:s3cr3t@host/paid` parses with the scheme `alice:` and empty user name and password fields.
*   **Order.** The user name and password check runs right after the URL parses, then the quote check, then the scheme check. The order only decides which message appears; no message prints the URL.
*   **User name or password.** `url.username !== "" || url.password !== ""` ends the run with exit code 2 and the message `URLs with a user name or password are not supported. Remove them and run again.` No request is sent. Node's `fetch` refuses such URLs anyway, so no working check is lost.
*   **The characters `'` and `"`.** If `url.href` contains `'` or `"`, the run ends with exit code 2 and the message `URLs that contain ' or " are not supported: op8x check prints shell commands with this URL, and these characters cannot be quoted safely for both POSIX shells and PowerShell.` The check uses the whole `href`: WHATWG URL parsing keeps `'` in the host, the path and the fragment (for special schemes such as http and https it encodes `'` as `%27` in the query), and keeps `"` in the host (it encodes it everywhere else). A real host name never contains either. `"` matters because Windows PowerShell 5.1 passes it to programs unchanged, which merges or splits the following arguments. No request is sent.
*   **Why this is enough for PowerShell.** After these checks, every printed URL is free of `'` and `"`. Inside single quotes, POSIX shells and PowerShell both treat every other character literally, including `$`, `(`, `)`, `;`, `&`, `|`, `[`, `]`, `{` and `}`. PowerShell also ends a single-quoted string at the typographic quotes U+2018 to U+201B; WHATWG parsing percent-encodes every non-ASCII character in the path, query and fragment and turns a non-ASCII host into ASCII (punycode), so they cannot appear in `href`. The backtick may appear in the query, but inside single quotes PowerShell treats it literally. This holds while PowerShell runs the program directly (`.ps1` or `.exe`); a `.cmd` file hands the line to cmd.exe (see Risks).

### 2. `quote()` refuses `'` (`report.ts`)

*   `quote(s)` keeps its job (wrap `s` in single quotes) but throws an `Error` when `s` contains `'`, instead of writing it as `'\''`. Every caller passes either `url.href` (checked in step 1), a fixed header text, or `JSON.stringify` output built from `url.href`. A throw therefore means a programming mistake. It is not caught: the run ends with an uncaught error and a stack trace. Node then exits with code 1, which in this case means a bug in the CLI, not "errors found"; the stack trace makes the difference visible. Tests make sure it cannot happen for input that passed step 1.
*   The four places that print commands keep calling `quote()`: the header line (new, see part 3), the `Reproduce:` lines and the "Not checked" block in `report.ts`, and the `mcp-endpoint` fix text in `rules.ts`. The "Not checked" block needs no other change; the header line changes in part 3 and the `Reproduce:` lines in part 4.
*   The `mcp-endpoint` fix text puts the command last and keeps the prose free of shell characters: `Check a paid tool over MCP, with the name of a paid tool for YOUR_TOOL: npx x402-listing-check@latest '<url>' --mcp-tool YOUR_TOOL`. The former wording ended with `(replace YOUR_TOOL with the name of a paid tool).`; pasted whole into PowerShell, the parentheses ran `replace.exe`. Pasted whole, the new sentence only gives "command not found" in bash and PowerShell.

### 3. Header line quoted (`report.ts`)

*   `renderText` prints `op8x check ${quote(r.url)}` instead of `op8x check ${r.url}`. Pasted into a shell, the line is now one command with one argument.

### 4. `Reproduce:` lines: `-g` and `curl.exe` (`bin.ts`, `cli.ts`, `report.ts`)

*   The three `curl -i` templates become `${curl} -g -i`. `-g` makes curl read `[`, `]`, `{` and `}` in the URL as plain characters. The CDP validate line needs no `-g`: its URL is fixed.
*   `report.ts` exports `curlFor(platform: string): string`, which returns `curl.exe` for `win32` and `curl` otherwise. `Io` gets an optional field `curl` (the program name for the `Reproduce:` lines). `bin.ts` sets it to `curlFor(process.platform)`, the same way it already sets `color`. It does not look at `MSYSTEM` or other shell hints: an agent may run the CLI in Git Bash while a person pastes the line into PowerShell, and `curl.exe` works in both.
*   `run()` passes `io.curl ?? "curl"` to `renderText`. Only the text `Reproduce:` lines use it.
*   The JSON report does not change between platforms. The CDP validate line in `notChecked[].where` keeps `curl`: it is part of the JSON, and in Windows PowerShell 5.1 it would fail with `curl.exe` too, because PowerShell before 7.3 removes the double quotes from the JSON body when it calls a program. The README says so.

### 5. README (`packages/cli/README.md`)

*   The exit-code line gains the new reasons for exit code 2.
*   A section `## Copyable commands` right after the exit-code line, with this text:

    > The lines under "Reproduce:" and "Not checked by op8x check" are for bash, zsh and PowerShell. Other shells such as fish or tcsh are not tested. On Windows, "Reproduce:" uses `curl.exe`, because `curl` in Windows PowerShell 5.1 is a different command. cmd.exe is not supported, and neither are `.cmd` files such as `npx.cmd` or `op8x.cmd`, because they run through cmd.exe: there `&` in a URL starts a second command. On Windows, run `npx` and `op8x` from PowerShell with scripts allowed (`npx.ps1`) or from Git Bash. The CDP validation line needs bash, zsh or PowerShell 7.3 or later; Windows PowerShell 5.1 removes the double quotes from its JSON body. `op8x check` refuses URLs with a user name, a password, `'` or `"` (exit code 2) and never prints them.

### Compatibility

*   Exit code 2 already means "usage error or the URL was unreachable". New reasons join it; no new exit code.
*   The JSON schema does not change. Fields keep their names and types.
*   URLs with `'` in the host, path or fragment, or with `"` in the host, were checked before and are now refused with exit code 2. URLs with a user name or password failed at `fetch` before and now stop earlier, with a clear message.
*   The scheme message no longer names the URL.

## Risks & Mitigations

*   **cmd.exe stays unsafe.** A line pasted into cmd.exe, or run through a `.cmd` file from PowerShell, splits at `&` and expands `%NAME%`, also for normal URLs. This includes the quoted header line, which `op8x.cmd` would pass to cmd.exe. Agent frameworks that run commands with Node's `child_process.exec` use cmd.exe on Windows by default, so such an agent remains open to a crafted URL with `&`. Mitigation: the README states that cmd.exe and `.cmd` files are not supported and names the shells that are. Not mitigated in code (Alternative D).
*   **Text the server controls.** Findings print some server values, for example the `Location` header of a redirect. They are not commands, but an agent may still read them. Out of scope here; a separate fix.
*   **`quote()` throws.** If a future caller passes text with `'`, the run ends with a stack trace and exit code 1. This is intended: it shows a programming mistake instead of printing an unsafe line.
*   **Secrets in the query string.** A URL such as `?key=...` is printed as given, in text and JSON. Sellers should not pass secrets in the URL; the CLI does not detect them.
*   **Git Bash rewrites `\` in the fragment.** Pasted into interactive Git Bash, `#a\b` reaches the program as `#a/b` (MSYS path conversion). curl never sends the fragment, so the request is the same. The shell test switches the conversion off and notes this at that case.
*   **Not tested here.** zsh and PowerShell 7.3 or later are not installed on the machine used for this design. The zsh statement rests on its POSIX single-quote rules; the PowerShell 7.3 statement follows its documented argument passing.

## Alternatives Considered

### Alternative A: Check the URL, but print no commands when it contains `'`

*   **Pros**: A seller whose URL really contains `'` still gets the check.
*   **Cons**: Text and JSON need a defined replacement (a note line, a new JSON field such as `commandsOmitted`) so that an agent can tell that commands are missing. Four places print commands, and each needs the same switch. `where` in `notChecked` mixes commands and prose today, so an agent cannot tell a dropped command from prose without the new field.
*   **Reason for Rejection**: More code and a JSON change for URLs that are very rare in practice. Refusing at input covers every place at once.

### Alternative B: Quote separately for PowerShell on Windows

*   **Pros**: Lines would also work with `'` in the URL; PowerShell users would get lines written for their shell.
*   **Cons**: The CLI cannot know which shell the reader pastes into. An agent may run it in Git Bash while a person pastes into PowerShell, and the reverse. Windows PowerShell 5.1 and PowerShell 7.3 or later pass arguments to programs differently, so a line with a JSON body cannot be right for both. It doubles the quoting code and its tests.
*   **Reason for Rejection**: Guessing the shell is wrong in common setups; refusing `'` and `"` makes the POSIX quoting safe in PowerShell without guessing.

### Alternative C: Write `'` as `%27` in the printed URL

*   **Pros**: No URL is refused; the line stays one safe argument in every supported shell.
*   **Cons**: A server may treat `%27` and `'` in the path as different paths, so the printed command can request a different resource than the one the CLI checked.
*   **Reason for Rejection**: "Reproduce" must send exactly the request the CLI sent. A line that may reach another resource does not reproduce the check.

### Alternative D: Also protect cmd.exe (refuse `&` and `%`, or leave out `npx` lines on Windows)

*   **Pros**: Closes the cmd.exe path, including `.cmd` files called from PowerShell and agents that run commands through cmd.exe.
*   **Cons**: `&` is normal in query strings; refusing it blocks ordinary URLs. Refusing only `%NAME%` protects half the problem and suggests a safety that is not there. Leaving out `npx` lines on Windows needs the same replacement output as Alternative A and removes the lines for many normal URLs.
*   **Reason for Rejection**: The cost falls on every normal URL with a query, while the attack needs a crafted URL. cmd.exe is declared unsupported, and the remaining risk is stated under Risks.

### Alternative E: Strip the user name and password instead of refusing the URL

*   **Pros**: The check would run against the same host without credentials.
*   **Cons**: The seller asked for a URL with credentials; checking a different request without saying so is misleading. The answer would usually be 401, not 402.
*   **Reason for Rejection**: Node's `fetch` cannot send such URLs, so no check is lost by refusing. A clear message is more useful than a silent change.

### Alternative F: Detect the shell, or use `curl.exe` in the JSON too

*   **Pros**: Lines could match the reader's shell; JSON consumers on Windows would get `curl.exe` as well.
*   **Cons**: The shell that runs the CLI is often not the shell that runs the printed line (agent in Git Bash, person in PowerShell). A JSON report that differs by platform is harder to compare and to test, and the JSON validate line fails in Windows PowerShell 5.1 with either name.
*   **Reason for Rejection**: Choosing by platform is enough for the `Reproduce:` lines, and the JSON stays the same everywhere.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Privacy**: This change closes a command-injection path in printed output for bash, zsh and PowerShell, a curl globbing path, and a password leak. Remaining risks are listed under Risks & Mitigations. Risk level medium (network input reaches printed commands); after the build, an adversarial review of the code is required before merge.
*   **Performance**: None. A few string checks per run.
*   **Rollout & Rollback**: `@op8x/cli` is not published on npm yet, so no released behavior changes. Rollback is a revert of one PR.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Order of work

Each step ends with `npm run typecheck && npm test` green in `packages/cli`.

1.  Input checks in `cli.ts` with their tests in `cli.test.ts` (file 1 without `Io.curl` and without the third `renderText` argument; file 5 without the `curl.exe` case). `renderText` is called as today.
2.  `quote()` throws, header line quoted, `-g` in the `Reproduce:` templates, `withoutUserinfo` removed, together with the test changes that depend on them (file 3 without `curlFor` and without the `curl` parameter; files 6 and 7 without the `curlFor` and `curl.exe` cases). One commit, because the stricter `quote()` breaks the old tests until they change.
3.  `curlFor`, `Io.curl`, the `curl` parameter of `renderText`, `bin.ts` and their tests (the remaining parts of files 1, 2, 3, 5 and 6).
4.  The shell test (file 8).
5.  Documentation (files 9 to 14).

### Target Files to Create/Modify

#### 1. `packages/cli/src/cli.ts` (Modify)

*   **Type / Scope**: TypeScript CLI entry.
*   **Proposed Changes**:
    *   `Io` gets `curl?: string` (program name for the `Reproduce:` lines; default `"curl"`).
    *   URL handling in `run()`, in this order, each ending with `return 2` and sending no request:
        1. `new URL(positionals[1])` fails: `io.err("Not a valid URL.\n")`.
        2. `url.username !== "" || url.password !== ""`: `io.err("URLs with a user name or password are not supported. Remove them and run again.\n")`.
        3. `url.href` contains `'` or `"`: `io.err("URLs that contain ' or \" are not supported: op8x check prints shell commands with this URL, and these characters cannot be quoted safely for both POSIX shells and PowerShell.\n")`.
        4. Scheme not `http:` or `https:`: `io.err("Only http and https URLs are supported.\n")`.
    *   `renderText(report, io.color, io.curl ?? "curl")` (step 3 of the order of work).

#### 2. `packages/cli/src/bin.ts` (Modify)

*   **Type / Scope**: Executable entry.
*   **Proposed Changes**: Import `curlFor` from `./report.ts` and pass `curl: curlFor(process.platform)` in the `Io` object, next to `color`. No check of `MSYSTEM` or other environment variables.

#### 3. `packages/cli/src/report.ts` (Modify)

*   **Type / Scope**: Report building and text rendering.
*   **Proposed Changes**:
    *   `quote(s)`: if `s` contains `'`, throw `new Error("quote: text contains ' (URLs with ' are refused in cli.ts)")`; otherwise return `'${s}'`. The `'\''` replacement goes away. Comment: the CLI refuses URLs with `'` and `"`, so single quotes are safe in POSIX shells and PowerShell alike.
    *   New export `curlFor(platform: string): string`: `platform === "win32" ? "curl.exe" : "curl"`.
    *   Remove `withoutUserinfo`; `buildNotChecked` uses its URL parameter (now named `url`) directly (the CLI refuses URLs with a user name or password before `buildReport`).
    *   `renderText(r: Report, color: boolean, curl = "curl")`: header line becomes `` `op8x check ${quote(r.url)}` ``; the three `curl -i` templates in `Reproduce:` become `${curl} -g -i`. The CDP validate line in `buildNotChecked` keeps `curl -X POST` (it is shared with JSON).

#### 4. `packages/cli/src/rules.ts` (Modify)

*   **Type / Scope**: Rules.
*   **Proposed Changes**: The `mcp-endpoint` fix text becomes `` `Check a paid tool over MCP, with the name of a paid tool for YOUR_TOOL: npx x402-listing-check@latest ${quote(url)} --mcp-tool YOUR_TOOL` `` (Technical Plan, part 2). It keeps calling `quote(url)` and is covered by the input check and by `quote()` throwing.

#### 5. `packages/cli/test/cli.test.ts` (Modify)

*   **Type / Scope**: CLI tests against the local test server (`startServer()` from `test/server.ts`, URLs built from `server.url`).
*   **Proposed Changes**: New tests. URLs are written as JavaScript strings. "No request" is checked with a spy passed as `io.fetchImpl` (`(async () => { calls++; throw new Error("no request expected"); }) as typeof fetch`) that expects `calls === 0`.
    *   With the server's host and port replacing the host in `http://alice:s3cr3t@<host>/v2-good`: returns 2; neither `alice` nor `s3cr3t` appears in stdout or stderr; `calls === 0`.
    *   `"ftp://alice:s3cr3t@host/"`: returns 2 with the user name message; neither `alice` nor `s3cr3t` in stdout or stderr.
    *   `"alice:s3cr3t@api.example.com/paid"` (no scheme): returns 2 with the scheme message; neither `alice` nor `s3cr3t` in stdout or stderr.
    *   `"http://alice:s3cr3t@"` (does not parse): returns 2 with "Not a valid URL."; neither `alice` nor `s3cr3t` in stdout or stderr.
    *   `` `${server.url}/a'b` ``, `` `${server.url}/x#a'b` ``, `"http://a'b/"` and `'http://a"b/'`: return 2 with the quote message; `calls === 0`; stdout is empty and stderr does not contain the URL.
    *   `` `${server.url}/v2-good?q='x` `` is checked normally: same exit code as `/v2-good`; every output line that contains `server.url` contains `/v2-good?q=%27x`, its `'` characters pair up into `'…'` segments, and one segment contains the URL with `?q=%27x`.
    *   `` `${server.url}/v2-good?filter[status]=1` ``: every non-empty line between `Reproduce:` and `Summary:` (after `trim()`) starts with `curl -g -i`.
    *   With `io.curl = "curl.exe"`, on `/v2-good`: every non-empty line between `Reproduce:` and `Summary:` (after `trim()`) starts with `curl.exe -g -i`; the validate line starts with `curl -X POST`. With `--json`, the parsed output with and without `io.curl` is equal after removing `checkedAt` and every `requests[].ms`.

#### 6. `packages/cli/test/report.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    *   Import `quote` and `curlFor` from `../src/report.ts`.
    *   New test block "quote": `assert.throws(() => quote("a'b"), /text contains '/)`; `quote("https://a.example/x") === "'https://a.example/x'"`.
    *   In the `mcp-endpoint` test, replace the `it's` case with `assert.throws(() => buildReport("https://api.example.com/it's", ...), /text contains '/)`.
    *   Change the test "URL with quotes is shell-quoted in the validation payload" to the URL `https://api.example.com/a?b=1`: the payload is `'{"resource":"https://api.example.com/a?b=1","method":"GET"}'` and the `npx` line ends with `'https://api.example.com/a?b=1'`. (A URL with `"` or `'` cannot reach `buildReport` from the CLI.)
    *   Remove the test "user name and password are left out of the copyable commands" (covered by `cli.test.ts`).
    *   New: the first line of `renderText(...)` is `op8x check 'https://api.example.com/x'`.
    *   New: `renderText(report, false, "curl.exe")` prints `curl.exe -g -i` at the start of every `Reproduce:` line (after `trim()`) and `curl -X POST` at the start of the validate line.
    *   New: `curlFor("win32") === "curl.exe"`, `curlFor("linux") === "curl"`, `curlFor("darwin") === "curl"`.
    *   Update the existing assertions on `curl -i -X ...` to `curl -g -i -X ...`.

#### 7. `packages/cli/test/rules.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    *   Rename the test "MCP: url is single-quoted like Reproduce, with a quote escaped" to "MCP: url is single-quoted like Reproduce; a quote is refused", keep the plain case and replace the `it's` case with `assert.throws(..., /text contains '/)` for a URL containing `'`.
    *   Update the expected `mcp-endpoint` fix text to the new wording (file 4).
    *   New test "MCP: the fix prose has no shell metacharacters": the fix contains none of `( ) ; & | $` and the backtick, and the prose before `npx ` contains none of `< > ' "`.

#### 8. `packages/cli/test/shell.test.ts` (Create)

*   **Type / Scope**: Test that runs printed lines in real shells.
*   **Proposed Changes**:
    *   A small argument printer (`test/argv.mjs` written to a temporary directory by the test, or a fixture file) prints `JSON.stringify(process.argv.slice(2))`.
    *   URLs accepted by the CLI but hostile to shells, as JavaScript strings, each normalized with `new URL(s).href`: on the base `http://127.0.0.1:9` the paths `/plain`, `/a;id`, `/a$(echo x)`, `/a&b|c`, `/a[1-2]{x,y}` and the query `` ?q=`x$y ``; hosts with shell characters `http://a;id/x`, `http://$(id)/x`, `` http://a`id/x ``, `http://{a,b}/x`, `http://a&b/x` (`|` is not allowed in a host); raw braces in the query `/x?b={x,y}`; fragments `/x#a$(id);b` and `/x#a\b`; a backslash in the query `/x?p=C:\foo`.
    *   Each URL runs in two variants: a 402 report (GET and POST via `pr(...)` from `test/fixtures.ts`, plus a preflight probe for the OPTIONS line) and an `mcp-endpoint` report (405 and 406 with a JSON-RPC error, via `runRules`).
    *   Take every command line (header, `Reproduce:`, "Not checked", fix command), with structural checks so the test cannot pass on an empty set: the header starts with `op8x check '`, one `Reproduce:` line per probe including the OPTIONS line, at least one validate and one `npx` line in the 402 variant, the `mcp-endpoint` finding and its command present and no validate line in the mcp variant. Replace the first word (`op8x`, `curl`, `npx`) with `node '<argv printer>'` and run it:
        *   bash: on `win32` only `%ProgramFiles%\Git\bin\bash.exe` (never the WSL `bash`), elsewhere `bash` from the PATH; the line goes in on standard input (`bash -s`), as when pasted, because Git Bash loses doubled backslashes in a `-c` argument passed through the Windows command line; `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL=*` are set.
        *   PowerShell: when `process.platform === "win32"`, `powershell -NoProfile -Command` with all lines of one URL in one process, one JSON line of output per command line, leaving out the CDP validate line (not supported in Windows PowerShell 5.1).
    *   The expected arguments come from a small tokenizer in the test (split at spaces outside `'…'`, quotes removed), not from any shell. Each run must print exactly those arguments, with the URL as one argument (inside the JSON argument for the validate line), exit with status 0 and leave stderr empty. A shell that is not available is skipped with `t.skip` and `return`.

#### 9. `packages/cli/README.md` (Modify)

*   **Type / Scope**: Public package documentation.
*   **Proposed Changes**:
    *   Exit-code line: exit code 2 also covers URLs with a user name, a password, `'` or `"`.
    *   New section `## Copyable commands` right after the exit-code line, with the text from the Technical Plan, part 5.
    *   Example output: header line becomes `op8x check 'https://api.example.com/weather'`; the `Reproduce:` lines become `curl -g -i -X ...`.

#### 10. `docs/specs/2026-10-24-cli-check-design.md` (Modify)

*   **Type / Scope**: Approved design, updated for accuracy.
*   **Proposed Changes**:
    *   List of later additions: add `` - `../designs/2026-10-31-cli-copyable-commands-design.md`: URLs with a user name, a password, `'` or `"` refused; quoted header line; `curl -g` and `curl.exe` in "Reproduce:" ``.
    *   Section "Command line", usage errors: add URLs with a user name, a password, `'` or `"`.
    *   Section "Output": the human report starts with the command `op8x check '<url>'`; the reproduce command is `curl -g -i` (`curl.exe -g -i` on Windows).
    *   Exit-code line in "Output": exit 2 also covers the refused URLs.

#### 11. `docs/designs/2026-10-31-cli-challenge-hints-design.md` (Modify)

*   **Type / Scope**: Approved design, updated for accuracy.
*   **Proposed Changes**: In the paragraph after the "Not checked" table, replace "The commands leave out the user name and password of the checked URL (the rest of the URL stays), and the Bazaar entry is left out" with "The CLI refuses URLs with a user name or password before any request (see `./2026-10-31-cli-copyable-commands-design.md`). The Bazaar entry is left out".

#### 12. `docs/specs/2026-10-27-cli-mcp-endpoint-design.md` (Modify)

*   **Type / Scope**: Approved design, updated for accuracy.
*   **Proposed Changes**: Replace the test bullet "A URL containing `'` is quoted as in `Reproduce`." with "URLs containing `'` are refused at input (see `../designs/2026-10-31-cli-copyable-commands-design.md`)." The `fix:` bullet takes the new fix text from file 4. The sentence "The URL is single-quoted as in the `Reproduce` lines." stays (single quotes are still used).

#### 13. `docs/specs/2026-10-25-cli-cors-payment-flow-design.md` (Modify)

*   **Type / Scope**: Approved design, updated for accuracy.
*   **Proposed Changes**: In the text-report bullet, "a `curl -i` line per request" becomes "a `curl -g -i` line per request (`curl.exe -g -i` on Windows; see `../designs/2026-10-31-cli-copyable-commands-design.md`)".

#### 14. `docs/designs/2026-10-31-cli-copyable-commands-design.md` (Create)

*   **Type / Scope**: This design.
*   **Proposed Changes**: Added to the repository with the change; status set to "Approved" after review.

### Verification Plan

*   **Typecheck**: `npm run typecheck` in `packages/cli`.
*   **Unit and shell tests**: `npm test` in `packages/cli`; all existing tests plus the new ones pass. On Windows the shell test runs in Git Bash and Windows PowerShell 5.1; in CI (Linux) it runs in bash.
*   **Build**: `npm run build` in `packages/cli`.
*   **Manual check on Windows** (no request to any host other than 127.0.0.1): start the test server with `node --input-type=module -e "import('./test/server.ts').then(async (m) => console.log((await m.startServer()).url))"` in `packages/cli`, run `node dist/bin.js check <server url>/v2-good` and paste each `Reproduce:` line into Windows PowerShell 5.1; each must print an HTTP response from the server. Run `node dist/bin.js check "<server url>/a'b"` and `node dist/bin.js check "http://alice:s3cr3t@127.0.0.1/"` and confirm exit code 2 (`$LASTEXITCODE`) and that neither the URL nor `s3cr3t` is printed.
*   **Not verified**: zsh and PowerShell 7.3 or later (not installed); see Risks.
*   **Review**: code review by someone other than the builder, then an adversarial review of the code (risk medium).
