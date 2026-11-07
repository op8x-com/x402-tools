# op8x CLI: account commands

*   **Author:** op8x
*   **Status:** Implemented in `@op8x/cli` 0.1.0
*   **Date:** 2026-11-06

This document is the public contract of the account commands of `@op8x/cli`:
`init`, `login`, `logout`, `import-key`, `rotate`, `delete` and `report`. They
connect a seller's worker to op8x analytics so that the server key is created,
stored and replaced without anybody copying it by hand. `op8x check` is not
changed by this design.

--------------------------------------------------------------------------------

## Overview

The `@op8x/analytics` module in a seller's worker sends one metadata record per
request to op8x. op8x accepts records only with a server key (`OP8X_KEY`).
`op8x init` creates that key on the seller's computer, asks a human to allow
the sign-in in a browser, puts the key and the account's salt (`OP8X_SALT`)
into the worker with the project's own `wrangler` (or into a git-ignored file
for Node hosts), and proves the connection with one test request. Later
`op8x rotate` replaces the key in every worker the computer knows, and
`op8x delete` deletes the account and removes the key and the salt from those
workers.

The commands are written for two readers at once: a human in a terminal, and an
agent that runs the command and reads its output. Every run ends in one named
state from a fixed catalog, with an exit code and a sentence (`agent_hint`)
that tells the reader what to do next.

Goals:

*   The server key and the salt never appear in output, logs, argv or the
    browser. The human only opens a link and, for dangerous steps, reads a code
    from a mail.
*   Every run can be repeated after an interruption without losing a key.
*   The CLI trusts only the project folder it runs in, and runs no program that
    the project could have planted next to it.

Non-goals:

*   Own calculations. `op8x report` shows the numbers op8x sends and computes
    none itself.
*   A browser dashboard. Everything happens in the CLI.
*   Finding the `workers.dev` address or whether a worker was ever deployed:
    wrangler offers no machine-readable source for either, so the test request
    needs `--url` unless the configuration has a route with a fixed domain.

## Commands and options

Every account command takes `--json`. Options may stand before or after the
command word (`op8x --json init` works). Unknown options, missing values,
values that break a pattern and forbidden combinations are usage errors
(exit code 4).

| Command | Options | Rules |
| --- | --- | --- |
| `init` | `--env <name>` | `^[a-z0-9][a-z0-9-]{0,62}$`; not with `--env-file` |
| `init` | `--name <worker>` | same pattern; not with `--env-file`; replaces the top-level `name` of the wrangler configuration (required when it has none) |
| `init` | `--url <url>` | `https:`; `http:` only for `127.0.0.1`, `localhost` or `[::1]`; no user name or password |
| `init` | `--env-file <path>` | a file that git ignores; not with `--env` or `--name` |
| `login`, `logout` | none | |
| `import-key` | `<path>` | exactly one positional |
| `rotate` | `--now` | |
| `rotate` | `--force-stop` | only with `--now` |
| `rotate` | `--code-stdin` | only with `--now` |
| `delete` | `--code-stdin` | |
| `report` | `--days <n>` | `^\d{1,3}$`, 1 to 30 |
| `report` | `--week` (7 days), `--month` (30 days) | at most one of `--days`, `--week` and `--month`, each once |

What each command does:

*   **`init`** in a worker folder. On a computer without an op8x file: checks
    the project's wrangler and the Cloudflare login, signs the computer in
    (browser link), stores the op8x file, puts the server key and the salt into
    the worker, sends one test request. On a signed-in computer only the last
    two steps run. A second `init` for the same worker updates its entry; every
    worker of the account gets the same salt (see "Returning buyers").
*   **`login`** signs this computer in to an existing account. If the account
    is the one in the op8x file, the server key, the salt and the known workers
    stay; for another account the file starts empty.
*   **`logout`** revokes this computer's access at op8x, then deletes the op8x
    file. Workers keep their copy of the server key and the salt.
*   **`import-key <path>`** takes the server key and the salt from the op8x
    file of another computer, after `GET /tenant` with this computer's read
    token shows that the key is the account's current key. Neither is sent
    anywhere. A file without a salt keeps this computer's salt.
*   **`rotate`** creates a new server key and puts it into every known worker.
    The old key keeps working for 24 hours. The salt stays as it is.
*   **`rotate --now`** does the same and then stops the old key right away,
    after a quiet check and a code from a mail (see "Stopping the old key").
*   **`delete`** deletes the account (code from a mail), removes `OP8X_KEY` and
    `OP8X_SALT` from every known worker, then removes the op8x file.
*   **`report`** prints the numbers of the account for the last 7 days (or
    `--days <n>`, `--week`, `--month`), see "Report".

The help of an account command is printed on stderr together with a usage
error. `op8x <command> --help` is therefore a usage error too (exit code 4).

## Output

### Text and JSON Lines

Without `--json` the CLI prints text lines: `Step n of N: <name>` when a step
starts, `Step n of N: <name> ok (812 ms)` (or `failed`, `skipped`) when it
ends, notices, the link block, one line per worker in the result, and the
`agent_hint` as the last line. `N` is fixed before the first step.

With `--json` the CLI prints JSON Lines on stdout: one JSON object per line.
Every line carries `"schema": "op8x.cli/1"`, `command` and `final`.
Intermediate lines have `"final": false` and exactly one `event`:

| `event` | Fields | When |
| --- | --- | --- |
| `step` | `n`, `of`, `name`, `status` (`start`, `ok`, `failed`, `skipped`), `elapsed_ms` (not on `start`) | start and end of every step |
| `link` | `state: "waiting_for_human"`, `agent_hint`, `link`, `words`, `expires_at` | once, after the sign-in started |
| `notice` | `id`, `text`; `host` for `test_host` | see the notice table |

The last line has `"final": true`, `state`, `exit_code`, `agent_hint` (absent
for `usage_error`), `steps` (the finished steps with `n`, `name`, `status`,
`elapsed_ms`) and the fields of its state. Example of a first `init`:

```
{"schema":"op8x.cli/1","command":"init","final":false,"event":"step","n":1,"of":4,"name":"cloudflare","status":"start"}
{"schema":"op8x.cli/1","command":"init","final":false,"event":"step","n":1,"of":4,"name":"cloudflare","status":"ok","elapsed_ms":812}
{"schema":"op8x.cli/1","command":"init","final":false,"event":"step","n":2,"of":4,"name":"browser","status":"start"}
{"schema":"op8x.cli/1","command":"init","final":false,"event":"link","state":"waiting_for_human","agent_hint":"Ask your human to open the link and click Allow. Their screen shows amber tiger 42.","link":"https://analytics.op8x.com/link/<32 characters>","words":"amber tiger 42","expires_at":"2026-11-06T14:10:00Z"}
...
{"schema":"op8x.cli/1","command":"init","final":true,"state":"connected","exit_code":0,"agent_hint":"op8x is connected to account t-k7m2p4q3xa (a***@acme.example). Tell your human which address this account belongs to; if it is not theirs, run op8x logout.","steps":[...],"account":"t-k7m2p4q3xa","contact_hint":"a***@acme.example","workers":[{"name":"api","env":null,"env_file":null,"status":"verified"}]}
```

Agents act on `state` and `exit_code`, pass `link` and `words` to the human,
and may show `agent_hint`. Times are ISO 8601 in UTC in JSON and
`YYYY-MM-DD HH:MM UTC` in text.

### Notices

| `id` | `text` | When |
| --- | --- | --- |
| `code_already_sent` | A code was already sent in the last 10 minutes. Check your mail for it. | a repeated request for a mail code within 10 minutes; no new mail is sent |
| `contact_unknown` | This computer does not know the contact address of this account. | the sign-in answer was lost and the CLI recovered the account without it |
| `secret_put_deploys` | wrangler secret put deploys the worker right away. | before the first `wrangler secret put` or `secret bulk` of a run |
| `test_host` | Sending one test request to {host}. | before every test request |
| `logout_removes_key` | This computer holds the server key. It is deleted with the op8x file; your workers keep their copy. | `logout` on a computer that holds the server key |
| `logout_removes_salt` | This computer holds the account's salt. It is deleted with the op8x file; your workers keep their copy. A later op8x init here makes a new salt unless op8x import-key brings it back, and returning-buyer counts restart after a new salt. | `logout` on a computer that holds the salt |

### Step names

| Command | Steps |
| --- | --- |
| `init`, first time | `cloudflare`, `browser`, `key`, `test` |
| `init`, signed in | `key`, `test` |
| `init --env-file` | `browser` (only without an op8x file), `key`, `test` (`skipped` without `--url`) |
| `login` | `browser` |
| `logout` | `sign_out` |
| `import-key` | `check_key` |
| `rotate` | `new_key`, `key`, `test` |
| `rotate --now` | `new_key`, `key`, `test`, `wait`, `code`, `stop`; if the old key is still open from an earlier `rotate`, `test`, `wait`, `code`, `stop` (with `key` first for workers that do not hold the current key); if a rotation is open and this computer's key is not the current one, `code`, `new_key`, `key`, `test`, `wait`, `code`, `stop`. With `--force-stop` the `test` and `wait` steps drop out. A run with `--code-stdin` starts at the waiting step. |
| `delete` | `code`, `delete_account`, `remove_secrets`, `remove_file` |
| `report` | none |

### Fields of the final line

*   `workers[{name, env, env_file, status}]`, status `verified`, `unverified`,
    `no_url` or `failed`: in `connected`, `key_rotated`, `old_key_stopped`,
    `partial`, `url_required`, `deleted_partial`.
*   `account`, `contact_hint`: in `connected`. `contact_hint` is the masked
    address from op8x (`a***@acme.example`) or null.
*   `last_seen` (null = never seen): in `old_key_still_used`.
*   `retry_after_s`, `retry_at`: in `rate_limited` and `rotation_pending`.
*   `receipt {action_id, tenant, ended_at}`: in `deleted` and
    `deleted_partial` (`tenant` and `ended_at` are null when a later run
    finishes an interrupted delete).
*   `attempts_left`: in `code_invalid`.
*   `path` (where the op8x file is): in `server_key_missing`, and with
    `receipt` in `permissions_failed` after the account was deleted.
*   `status`, `code` (`code` null without a problem document): in
    `unexpected_response`.

`partial` means at least one worker is `failed` or `unverified`. `no_url` does
not make a plain `rotate` partial, but holds up `rotate --now` with
`url_required` unless `--force-stop` is given.

## Exit codes and streams

| Exit code | Meaning |
| --- | --- |
| 0 | success |
| 1 | an expected state; the `agent_hint` says what to do |
| 2 | network or server problem, or an internal error |
| 4 | usage error, or an input the CLI refuses before it sends anything |

`op8x check` keeps its own exit codes (0 no errors, 1 errors found, 2 usage
error or unreachable URL). An unknown first word (`op8x frobnicate`) is a usage
error with exit code 4.

Account commands write everything to stdout, including errors. An agent then
reads one stream in order and never has to merge stdout and stderr to learn
which step failed. The only exception is `usage_error`: the help of the
command goes to stderr, because it is text for a human; with `--json` the final
line `{"schema":"op8x.cli/1","command":…,"final":true,"state":"usage_error","exit_code":4}`
is also written to stdout (`command` is null for an unknown first word). The
rejected input is never repeated, since it may be a pasted secret.

## State catalog

`{…}` are values filled in per run. Some states have a second sentence for a
special case, listed after the first.

| State | When | Exit | `agent_hint` |
| --- | --- | --- | --- |
| `connected` | `init` finished and op8x saw the test event; `login` finished | 0 | op8x is connected to account {account} ({contact_hint}). Tell your human which address this account belongs to; if it is not theirs, run op8x logout. Without a known address: op8x is connected to account {account}. This computer does not know the account's address; ask your human to check that it is theirs, and if not, run op8x logout. |
| `key_rotated` | `rotate` finished | 0 | The new server key is in {n} workers; the old key works until {time}. Without an old key: The new server key is in {n} workers. With no known worker: No worker is known on this computer. Run op8x init in every worker folder within 24 hours. (without an old key the same sentence without "within 24 hours") |
| `old_key_stopped` | `rotate --now` stopped the old key | 0 | The old server key is stopped. The new key is in {n} workers. |
| `deleted` | account deleted, keys and file removed | 0 | The account is deleted. Receipt: {action_id}. |
| `logged_out` | access revoked, file deleted | 0 | This computer is signed out. With a local server key it adds: The server key on this computer is removed too. |
| `imported` | `import-key` took the key | 0 | The server key is on this computer now. Run op8x init in a worker folder. |
| `waiting_for_human` | the `link` line, not a final state | — | Ask your human to open the link and click Allow. Their screen shows {words}. |
| `cloudflare_login_needed` | `wrangler whoami --json` does not report `loggedIn: true` | 1 | Ask your human to run npx wrangler login, then run op8x init again. |
| `wrangler_missing` | no usable `node_modules/wrangler` in the project folder | 1 | Run npm i -D wrangler in this project, then run op8x init again. |
| `wrangler_too_old` | wrangler older than 4.152.0, or Node.js older than 22 | 1 | This needs wrangler 4.152.0 or newer and Node.js 22 or newer. Update them, then run the command again. |
| `env_required` | several `[env.*]` sections and no `--env` | 1 | This worker has several environments. Run op8x init --env <name>. |
| `url_required` | `init`: no test address (no `--url`, no route with a fixed domain, or a route address that may not be tested); the key is stored. `rotate --now`: known workers without a test address | 1 | Pass --url https://… with a path the op8x module handles. For `rotate --now`: These workers have no test address: {names}. Run op8x init --url https://… in their folders, or run op8x rotate --now --force-stop. |
| `deployed_unverified` | no test event within 60 seconds | 1 | The key is stored, but no test event arrived. Check that the module is mounted on that path and has the endpoint option; that it is @op8x/analytics 0.0.2 or later (older versions do not send the test event); or pass --url. |
| `denied` | the human denied the sign-in | 1 | The request was denied. Run op8x init again when your human is ready. |
| `expired` | the sign-in link expired | 1 | The link expired. Run op8x init again when your human is ready. |
| `no_account` | `login` for an address without an account | 1 | There is no op8x account for this address. Run op8x init to create one. |
| `terms_draft` | accounts are not open yet | 1 | op8x accounts are not open yet. |
| `granted_lost` | the sign-in finished, the answer was lost and could not be recovered | 1 | The sign-in finished but this computer missed the answer. Run op8x login. |
| `server_key_missing` | this computer has no server key | 1 | This computer has no server key. Run op8x import-key <path to the op8x file of your other computer>, or run op8x rotate and then op8x init in every worker folder within 24 hours. After a rotate on a new computer, returning-buyer counts restart. While a rotation runs, the part after the comma reads: or run op8x rotate --now. |
| `key_mismatch` | the local key is not the account's current key | 1 | The key on this computer is not the account's current key. Run op8x rotate. |
| `key_previous` | `import-key`: the file holds the old key | 1 | This key is the old one. Run op8x rotate. |
| `partial` | a worker did not get the key, or sent no test event | 1 | The new key is not in every worker: {names}. Fix them and run the command again; nothing was stopped. |
| `old_key_still_used` | the quiet check failed | 1 | A worker this computer does not know still uses the old key (last seen {time}). Run op8x init in its folder, then run op8x rotate --now again. If the key leaked, run op8x rotate --now --force-stop. With no known worker: No worker is known on this computer. Run op8x init in every worker folder, then run op8x rotate --now again. If the key leaked, run op8x rotate --now --force-stop. |
| `rotation_pending` | a rotation is still open | 1 | A rotation is still running until {time}. Run op8x rotate --now to finish it early. |
| `nothing_to_stop` | there is no old key | 1 | The old key is already stopped. |
| `step_up_needed` | a step needs a mail code and there is no terminal | 1 | Ask your human for the code from the mail, then run the same command with --code-stdin and pass the code on stdin. |
| `code_invalid` | wrong code | 1 | The code is not right. {attempts_left} tries left. Ask your human for the newest code. |
| `code_expired` | the code or the waiting step expired | 1 | The code expired. Run the command again for a new code. |
| `code_exhausted` | too many wrong codes | 1 | Too many wrong codes. Run the command again for a new code. |
| `rate_limited` | too many requests | 1 | Too many requests. Try again after {retry_at}. |
| `key_conflict` | a new key collided twice | 1 | Run the command again. |
| `deleted_partial` | account deleted, but `OP8X_KEY` or `OP8X_SALT` could not be removed everywhere | 1 | The account is deleted. Remove OP8X_KEY and OP8X_SALT by hand from: {names}. |
| `not_logged_in` | no op8x file, or only the rest of an interrupted delete | 1 | This computer is not signed in. Run op8x init or op8x login. |
| `key_auth` | op8x refused this computer's read token | 1 | This computer's access is no longer valid. Run op8x login. |
| `import_failed` | the file is missing, not an op8x file, or holds no server key; also an unreadable own op8x file | 1 | The file could not be read as an op8x file. |
| `config_unreadable` | the wrangler configuration could not be read | 1 | The wrangler configuration could not be read. |
| `permissions_failed` | a file could not be protected, written or removed | 1 | The op8x file could not be protected; nothing was written. After the account was deleted: The account is deleted (receipt {action_id}), but the op8x file could not be updated. Delete it by hand: {path}. |
| `network_error` | network, timeout, redirect, any 5xx except `503 busy`; waiting longer than 90 seconds | 2 | Check the connection and run the command again. |
| `busy` | `503 busy` for longer than 2 minutes (retried every 10 seconds; `report` waits as long as `Retry-After` says) | 2 | The service is busy; try again in a minute. |
| `unexpected_response` | any other status or code, a body that is not JSON or has the wrong shape, a `retry_after_s` over one day (86400), a link that is not on the fixed host | 2 | op8x got an answer it does not expect (status {status}, code {code}). Update op8x and run the command again; if it stays, please report it. |
| `schema_unsupported` | `report`: the answer is a JSON object whose `schema` is not `op8x.metrics/1` | 2 | The report has a format this version of op8x cannot read. Update @op8x/cli (npx @op8x/cli@latest report) and run the command again. |
| `internal_error` | the output guard found a secret in a line, or a programming error | 2 | op8x stopped because of an internal error. Please report this. |
| `usage_error` | unknown word or wrong option | 4 | (none; the help goes to stderr) |
| `invalid_input` | the code is not 8 letters or digits | 4 | The code must be 8 letters or digits. Ask your human for the code from the mail and pass it again. |
| `code_missing` | op8x says the code was not sent | 4 | Internal error: the code was not sent. Please report this. |
| `no_pending_step` | `--code-stdin` without a waiting step, or for another command | 4 | There is no step waiting for a code. Run the command without --code-stdin. For another command: The waiting step belongs to op8x {command}. Run that same command with --code-stdin, or run this one without --code-stdin. |
| `env_file_not_ignored` | `--env-file` is not ignored by git, is tracked, is outside a repository, or is `.dev.vars` | 4 | Use a file that git ignores (and not .dev.vars). |
| `collector_url_not_allowed` | `OP8X_COLLECTOR_URL` points elsewhere than loopback | 4 | OP8X_COLLECTOR_URL may only point to 127.0.0.1, localhost or [::1]. |
| `collector_mismatch` | the op8x file was made for another service address | 4 | The op8x file on this computer was made for a different service address. Unset OP8X_COLLECTOR_URL, or set it to the address the file was made for. |

Every value from a server (account, contact hint, words, link, host, names)
loses control and format characters before it is printed, in text and in JSON.
In text the link and the words are printed in quotes with look-alike characters
escaped, so the human compares exactly what their screen shows.

## Keys

| Key | Prefix | Lives in | Sent to op8x |
| --- | --- | --- | --- |
| server key | `op8x_w_` | the op8x file and the worker (`OP8X_KEY`) | only as its SHA-256 hash |
| salt | `op8x_s_` | the op8x file and the worker (`OP8X_SALT`) | never |
| read token | `op8x_r_` | the op8x file | as `Authorization: Bearer` on account requests |
| device secret | `op8x_d_` | memory, during one sign-in | as `Authorization: Bearer` when the CLI collects the sign-in answer |

Each key is the prefix plus 43 base64url characters from 32 random bytes. The
hash is SHA-256 over the whole string, prefix included, in lowercase hex; the
fingerprint is its first 8 characters. The salt has the same form; its 43
characters must also be the canonical encoding of the 32 bytes (re-encoding them
gives the same characters), the rule the analytics module checks. The server
key and the salt reach the worker only on wrangler's stdin, or as the lines
`OP8X_KEY=…` and `OP8X_SALT=…` in the `--env-file`.

## Returning buyers

The analytics module replaces each payer address with a pseudonym: an
HMAC-SHA-256 keyed with the account's salt. The same payer gives the same
pseudonym in every worker of the account, so repeat purchases can be counted
without op8x seeing an address. The CLI only makes and stores the salt; it
never computes a pseudonym.

*   `init` makes the salt once per account (32 random bytes, `op8x_s_` plus 43
    base64url characters), stores it in the op8x file before it puts anything,
    and gives every worker the same salt. `rotate` never changes it.
*   A second computer gets the salt with `import-key`, together with the
    server key.
*   A new salt starts new pseudonyms, so returning-buyer counts restart: after
    a `logout` followed by a fresh `init`, or after a rotate on a new computer
    that never imported the salt.

## The op8x file

Location: `$XDG_CONFIG_HOME/op8x/account.json` when `XDG_CONFIG_HOME` is an
absolute path, else `~/.config/op8x/account.json`; on Windows
`%APPDATA%\op8x\account.json`.

Protection: on POSIX the folder is set to `0700` and the file to `0600`. On
Windows the file gets an access list with exactly one entry, full control for
the current user's SID, without inherited entries; the CLI reads the list back
and refuses to write if it holds anything else. The file is written to a
temporary file in the same folder and renamed. If protection fails, nothing is
written (`permissions_failed`). The `--env-file` is written the same way
(without changing its folder).

Schema `op8x.account/1`, with every secret value replaced here:

```json
{
  "schema": "op8x.account/1",
  "collector": "https://analytics.op8x.com",
  "account": "t-k7m2p4q3xa",
  "contact_hint": "a***@acme.example",
  "read_token": "<read token>",
  "write_key": "<server key> or null",
  "write_key_next": "<next server key> or null",
  "salt": "<salt> or null",
  "pending_step_up": null,
  "deleted": null,
  "workers": [
    { "dir": "/work/api", "name": "api", "env": null, "env_file": null, "url": "https://api.example/paid", "deployed_at": "2026-11-06T14:05:00Z", "verified_at": "2026-11-06T14:05:20Z", "key_fingerprint": "1a2b3c4d" },
    { "dir": "/work/node-api", "name": null, "env": null, "env_file": "/work/node-api/.env.op8x", "url": null, "deployed_at": "2026-11-06T14:07:00Z", "verified_at": null, "key_fingerprint": "1a2b3c4d" }
  ]
}
```

*   `collector` is the service address the file was made for. If it differs
    from the current one, every command ends with `collector_mismatch` and
    sends nothing, so the read token never goes to a host that only the file
    names. (`init` and `login` replace the rest file of an interrupted delete
    without this check.)
*   `write_key_next` holds a new server key before op8x has accepted it. A run
    that finds it first asks op8x whether it became current; if so, it becomes
    `write_key`. Otherwise only `rotate` repeats the exact same request, because
    it then puts the key into every known worker; so an interrupted rotation
    never loses a key. `init` drops it without sending anything, so an `init`
    after a lost rotation never makes a key current that the known workers do
    not hold. `import-key` drops it too once the imported key is the current
    one, and settles a waiting `replace_current` step.
*   `salt` is the account's salt, or null until `init` makes one. Files of
    older versions have no `salt` field; it reads as null. An invalid salt
    makes the file invalid.
*   `pending_step_up` is `{purpose, command, case, phase, force_stop, t_check,
    expires_at}` while a step waits for a mail code, else null.
*   A worker is identified by `dir`, `name` and `env`, or by `env_file` alone.
    `url` is the test address or null. `verified_at` is the time op8x saw the
    test event.
*   After `deleted_partial` the file keeps only the workers that still hold the
    key or the salt: every account field (the salt too) is null and `deleted`
    is `{"action_id": "…"}`.
    `init` and `login` treat this file as no file, `delete` finishes the
    removal, every other command ends with `not_logged_in`.

## What the CLI sends to op8x

All requests go to `https://analytics.op8x.com` with
`User-Agent: op8x-cli/<version> (+https://op8x.com)`, a 10-second timeout,
redirects refused (a redirect is `network_error`, so `Authorization` never
follows one) and the body read up to a fixed limit. `OP8X_COLLECTOR_URL` may
replace the address only with `http://127.0.0.1:<port>`, `http://localhost:<port>`
or `http://[::1]:<port>`, for tests against a local collector. Requests are sent
one after another; `503 busy` is retried every 10 seconds for up to 2 minutes
(on `GET /api/v1/tenant/report` after the seconds of its `Retry-After` header).

| Request | Body |
| --- | --- |
| `POST /api/v1/device/start` | `mode` (`init` or `login`), `client {name: "@op8x/cli", version}`, the SHA-256 hashes of the device secret, the read token and (for `init`) the server key; `test_token` only when `OP8X_TEST_TOKEN` is set |
| `POST /api/v1/device/token` | `{}`, with the device secret; repeated at the interval op8x asks for, at most 20 minutes |
| `GET /api/v1/tenant` | none; returns key fingerprints and times, never keys |
| `POST /api/v1/tenant/rotate` | `kind: "write"`, the hash of the new server key; for replacing a key this computer no longer holds, also `replace_current: true` and the mail code |
| `POST /api/v1/tenant/step-up` | `purpose` (`rotate_now`, `replace_current` or `delete`); op8x mails a code |
| `POST /api/v1/tenant/revoke-previous` | the mail code |
| `POST /api/v1/tenant/delete` | the mail code |
| `POST /api/v1/tenant/sign-out` | `{}` |
| `POST /api/v1/tenant/test-nonce` | `{}`; returns a nonce |
| `GET /api/v1/tenant/test-nonce/<nonce>` | none; returns whether and when op8x saw the test event |
| `GET /api/v1/tenant/report?days=<n>` | none; returns the `op8x.metrics/1` document |

Never sent: the server key itself, the contents of the op8x file, wrangler's
output, the seller's configuration, request or response bodies of the seller's
traffic, and anything about the seller's buyers. The test request goes to the
seller's own worker, not to op8x (see "Test request").

## Sign-in

`device/start` returns a link, a few words and an expiry. The CLI prints the
`link` line and opens the browser only if the link is exactly
`https://analytics.op8x.com/link/` followed by 32 characters from
`[A-Za-z0-9_-]`; any other link is `unexpected_response`. The human opens the
link, checks that the words match, and clicks Allow. The CLI collects the
answer with the device secret. If the answer is lost on the network, the CLI
tries `GET /tenant` with the new read token once; if that works, the run goes
on with notice `contact_unknown`, else it ends with `granted_lost`.

## Mail codes

`rotate --now` and `delete` need a code that op8x mails to the account's
address. A code is never taken from argv.

*   With a terminal the CLI asks for the code without echo.
*   Without a terminal the CLI requests the code, stores the waiting step in
    `pending_step_up` and ends with `step_up_needed`. The human reads the code
    from the mail; the agent runs the same command with `--code-stdin` and
    writes the code to stdin. That run continues the stored step, and may start
    only the next step of the same flow.
*   Before anything is sent, the code is trimmed, spaces and hyphens are
    removed, it is upper-cased, `I` and `L` become `1` and `O` becomes `0`; the
    result must be 8 characters of `0-9A-Z` without `I`, `L`, `O` and `U`, else
    `invalid_input`.
*   A waiting step is cleared when the run of its command ends with one of
    these states: `old_key_stopped`, `key_rotated`, `deleted`,
    `deleted_partial`, `code_exhausted`, `code_expired`, `nothing_to_stop`,
    `old_key_still_used` and `partial`. Every other final state keeps it, for
    example `code_invalid`, `invalid_input`, `no_pending_step`,
    `network_error`, `busy`, `unexpected_response` and `key_mismatch`. One
    exception: when `rotate --now` ends with `old_key_still_used` because no
    known worker can be tested, before any code was sent, the step stays.
*   A run without `--code-stdin` starts over for its own command: it drops a
    waiting step of that command (`rotate` or `delete`) and requests a new
    code if it needs one. A waiting step of the other command stays until this
    run stores its own waiting step, which replaces it (only one step waits at
    a time).

## Rotating the key

`rotate` stores the new key in `write_key_next`, sends its hash to op8x, then
makes it `write_key` and puts it into every known worker (wrangler worker:
`secret put`; env file: the `OP8X_KEY` line; the salt and the `OP8X_SALT`
line stay as they are). Each worker with a test address
gets a test request. The old key keeps working for 24 hours. A second run after
`partial` sends no new rotation and only fixes the workers that are not done.

### Stopping the old key

`rotate --now` stops the old key only when no known worker and no unknown one
still uses it:

1.  Every known worker gets the new key and a test request. `T_check` is the
    latest time op8x saw one of these test events. Known workers without a test
    address end the run with `url_required`, and a computer that knows no
    worker ends it with `old_key_still_used`, both before anything changes.
2.  The CLI asks op8x for its time every 10 seconds until it is at least 60
    seconds after `T_check` (at most 90 seconds, else `network_error`).
3.  The old key must not have been seen after `T_check`; else
    `old_key_still_used` with `last_seen`.
4.  The CLI requests a mail code (`rotate_now`).
5.  After the code, the CLI checks again that the old key was not seen after
    `T_check` and that the local key is the current one, and only then sends
    `revoke-previous` with the code. If the check fails, the code is not sent.

op8x records when the old key was last seen at most once per minute, so a use
shortly before `T_check` can shorten the window. `--force-stop` skips steps 1 to
3 and the second check in step 5, for a key that leaked; the code is still
needed. A worker that did not get the new key (`partial`) prevents every stop,
also with `--force-stop`.

If a rotation is open and this computer's key is not the current one (another
computer rotated), the flow first asks for a code to replace the current key
(`replace_current`), then continues as above with a second code. Without a
terminal this takes three runs: the first ends with `step_up_needed`, the
second takes the first code with `--code-stdin` and ends with `step_up_needed`
for the second code, the third takes the second code.

## Deleting the account

`delete` asks for a code, sends `POST delete` with it, writes the rest file
right away (no account fields, all workers), runs `secret delete` for
`OP8X_KEY`, then for `OP8X_SALT`, per wrangler worker and removes the
`OP8X_KEY` and `OP8X_SALT` lines from each env file, saving the rest file
after each worker, then deletes the op8x file. If a removal fails, the account
is still deleted, the rest file keeps the failed workers and the run ends with
`deleted_partial`; the next `delete` only retries those workers and sends
nothing to op8x. On that retry a failed `secret delete` is followed by a
read-only `secret list`: if `OP8X_KEY` is no longer there, the worker counts as
done. A failed `secret delete` of `OP8X_SALT` is always followed by that check,
because workers set up by older versions have no salt. If the op8x file cannot
be removed or updated after the account is gone,
the run ends with the `permissions_failed` variant that names the receipt and
the file to delete by hand.

## Trust in the project folder

The CLI runs in the seller's project. Everything in that folder may have been
written by somebody else, so the CLI trusts only what it needs from it, and
never runs a program by name from it.

### wrangler

*   Only `<project folder>/node_modules/wrangler/bin/wrangler.js` is used. Its
    real path and the real path of `node_modules/wrangler/package.json` must be
    inside the project folder, and the package must be named `wrangler`.
    Parent folders are not searched, so a wrangler hoisted to the root of a
    monorepo gives `wrangler_missing`.
*   wrangler must be 4.152.0 or newer (it removes a secret without asking when
    there is no terminal) and Node.js 22 or newer.
*   wrangler is started as `node <wrangler.js> …` with the CLI's own Node.js,
    without a shell and without `npx`, with stdin as a pipe and a timeout of
    120 seconds.
*   The environment of wrangler is an allowlist: `PATH`, `SystemRoot`, `HOME`,
    `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`,
    `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `HTTPS_PROXY`,
    `HTTP_PROXY`, `NO_PROXY` (also lowercase), `NODE_EXTRA_CA_CERTS`, `TEMP`,
    `TMP`. Logging variables such as `WRANGLER_LOG`, `WRANGLER_LOG_PATH` and
    `DEBUG` are left out. On Windows names are compared without case.
*   The CLI always adds `WRANGLER_LOG_SANITIZE=true` and
    `WRANGLER_WRITE_LOGS=false` to that environment. wrangler reads the
    project's dotenv files itself, but a value already in its environment wins,
    so a dotenv file can neither turn off log sanitizing nor turn on the log
    file, either of which could record the key and the salt sent with `secret put` or `secret bulk`.
    `CLOUDFLARE_API_BASE_URL` is not pinned: wrangler's default depends on the
    configuration's `compliance_region`, so a fixed value would be wrong for
    some workers.
*   wrangler's output is never shown. The CLI reads only exit codes, from
    `whoami --json` only the field `loggedIn`, and from `secret list` only the
    secret names; account names and mail addresses are never read.

| Action | argv after `wrangler.js` | stdin |
| --- | --- | --- |
| check the login | `whoami --json` | empty |
| put the key and the salt (`init`; one new version of the worker) | `secret bulk` plus the target | `{"OP8X_KEY":"…","OP8X_SALT":"…"}` as JSON, without a newline |
| put the key (`rotate`) | `secret put OP8X_KEY` plus the target | the key, without a newline |
| remove the key, then the salt | `secret delete OP8X_KEY`, then `secret delete OP8X_SALT`, plus the target | empty |
| check for the key or the salt (after a failed `secret delete` of the salt, or of the key when a later `delete` finishes an interrupted one) | `secret list` plus the target, then `--format json` | empty |

The target is `--name <name>` without an environment; `--name <base> --env <X>`
when the worker name is `<base>-<X>`; `--env <X>` alone when the name comes
from `env.X.name`. When the worker folder has a configuration file, `--config
<absolute path of that file>` is added, so wrangler cannot pick up a
configuration from a parent folder.

### wrangler configuration

The CLI reads `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` in the
worker folder (in that order), up to 256 KB and 16 levels deep, and only the
keys `name`, `workers_dev`, `route`, `routes` and the same keys under `env.X`.
TOML is read as a subset; a line it cannot read that would hold one of these
keys makes the file unreadable (`config_unreadable`). The worker name is
`--name` or the top-level `name`; under `--env X` it is `env.X.name`, else
`<name>-<X>`. Several environments without `--env` give `env_required`; an
unknown `--env` is a usage error. The test address is `--url`, else the first
route with a fixed domain (`route` before `routes`; a custom domain gives
`https://<host>/`).

### Other programs

*   Windows: `icacls.exe`, `whoami.exe` and `rundll32.exe` (to open the
    browser) run from `<SystemRoot>\System32` by absolute path, because Windows
    looks for a program name in the current folder first. Without a valid
    `SystemRoot`, files are not written and the browser is not opened (the link
    is in the output).
*   macOS: `/usr/bin/open`. Linux: `xdg-open`, found only in absolute `PATH`
    entries.
*   The browser opener is started detached, without stdin, stdout or stderr.
    The CLI waits only until it has started (at most 5 seconds), never for it
    to exit, so an opener that waits for the browser does not hold up the
    sign-in.
*   `git` (for `--env-file`): found only in absolute `PATH` entries, run with
    `-c core.fsmonitor=false` and a small environment allowlist. The file must
    be ignored (`git check-ignore`) and not tracked (`git ls-files`). Files
    named `.dev.vars` or `.dev.vars.*` are refused without asking git, because
    `wrangler dev` reads them.
*   Child processes get only the environment they need; the read token, the
    server key and `OP8X_TEST_TOKEN` are never in a child's environment or
    argv.

### Output guard

Before a line is written, the CLI checks that it holds none of the read token,
the server key (current or next), the salt, the device secret, a mail code of
the run or `OP8X_TEST_TOKEN`. A line that does is replaced by the final line
`internal_error` (exit code 2), the original is written nowhere, and the run
stops before its next side effect.

`report` checks the document before it prints anything: the body as received
and every string of the decoded document (object keys included), so a secret
past the 100 characters the view prints, or one that is only visible after
JSON decoding (such as a read token with an escaped underscore), ends with `internal_error` as well. Known
limit: a secret split across two strings of the document is not found by this
check; only the line guard sees what is printed.

## Report

`op8x report` sends `GET /api/v1/tenant/report?days=<n>` with the read token
of the op8x file (never the server key) and shows the answer. Without an op8x
file it ends with `not_logged_in` and sends nothing.

*   **Period.** The last 7 UTC days including today; `--days <n>` (1 to 30),
    `--week` (7) or `--month` (30) pick another. More than one of the three, a
    repeated one or another value is a usage error (exit code 4).
*   **Busy.** `503 busy` is retried after the seconds of the `Retry-After`
    header (whole seconds, at least 1, at most 60; without a valid header after
    10 seconds), for up to 2 minutes in all, then `busy`.
*   **`--json`.** On success stdout holds exactly one line: the collector's
    `op8x.metrics/1` document unchanged, or an equivalent one-line JSON with
    unsafe characters escaped, followed by a newline. The document is printed
    as received if it is one line without any control character (category Cc,
    tabs and line breaks included), format character (Cf) or line or paragraph
    separator (Zl, Zp); otherwise the CLI prints the parsed document
    serialized again on one line, with each such character written as a JSON
    `\uXXXX` escape (outside the Basic Multilingual Plane as a surrogate pair).
    A document that cannot be serialized again (nested too deeply) ends with
    `internal_error`. The CLI checks only its `schema`; another schema is
    `schema_unsupported`. Fields and values the CLI does not know pass through.
    Every other end is one `op8x.cli/1` final line, as for the other
    commands. The output guard applies to the document too.
*   **Text.** A view with one block per part of the document (liveness, the
    routes from price offer to delivery, wallets, revenue as reported, data
    basis), then every finding with its full text and its link
    `https://docs.op8x.com/findings/<hint_id>/`, and the link to the
    definitions, `https://docs.op8x.com/metrics/`, with the
    `definitions_version` of the document. The exit code is 0.
*   **Text from events.** Routes, error texts and asset addresses (`data` in
    the document) are text that buyers and servers control. The view prints
    them only in double quotes, with every character outside printable ASCII
    (control characters, ANSI sequences, bidirectional and invisible
    characters), the quote characters and the backslash as `\u{XXXX}`, cut after 100
    printed characters with `…`. Any other value that does not have the form
    the format gives it (a day, a time, an id, a decimal amount) is printed the
    same way. A value that is not a string where the view expects a string or
    a count is never converted to text or serialized; only its type is
    printed, for example `(object)`. Hint texts are printed in full with
    control and format characters escaped. A fault while the view is built
    ends the run with `internal_error` (exit code 2).
*   **Newer documents.** A status, reason, network kind or code the CLI does
    not know is shown raw and escaped (for example `status "new_value"`, with
    a reason `status "new_value" (reason "why")`), a finding with an unknown
    id is shown with its text, and unknown fields are left out of the view;
    nothing of this is an error.

## Test request

The test request proves that the worker holds the account's current key and
that the module reports to op8x.

*   The CLI first checks the address, then asks op8x for a nonce
    (`POST test-nonce`), prints notice `test_host`, and sends one `GET` to the
    address with the single extra header `op8x-test: <nonce>`. No key, no
    token and no body are sent. Redirects are not followed, the timeout is 10
    seconds, and the answer is read up to a limit and discarded.
*   The module in the worker reports the request with the nonce. The CLI asks
    op8x every 3 seconds, for up to 60 seconds, whether it saw it; else the run
    ends with `deployed_unverified`.
*   Addresses given with `--url` (and the addresses `rotate` stored for its
    workers) may be any `https:` host, or `http:` on `127.0.0.1`, `localhost`
    or `[::1]`. An address taken from a route must be `https:`, and every
    address its host resolves to must be public (no private, loopback,
    link-local, carrier-grade NAT, multicast or reserved ranges); else no nonce
    is used and the run ends with `url_required`.
*   The address must reach a path that `@op8x/analytics` handles, with the
    `endpoint` option set. Versions before 0.0.2 do not send the test event.
