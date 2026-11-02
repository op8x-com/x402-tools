# op8x CLI: hint on rejected preflights

*   **Author:** op8x
*   **Status:** Approved, 2026-11-02
*   **Date:** 2026-11-02

Extends `../specs/2026-10-25-cli-cors-payment-flow-design.md`, which specifies
the CORS rules including `cors-preflight` (row "Preflight returned a non-2xx
status"). Server text in findings follows
`./2026-11-01-cli-server-text-design.md`.

--------------------------------------------------------------------------------

## Overview

When the preflight `OPTIONS` gets a non-2xx answer, `op8x check` reports
`Preflight rejected (<status>)` and advises answering with 204. For 400, 401
and 403 that advice often points to the wrong layer: a CORS middleware may have
refused the method, headers or Origin, or authentication or a firewall may not
exempt `OPTIONS`. This design makes the finding for these statuses state what
the answer shows (which allowed methods and headers it lists, and what is
missing from them) and then name the likely causes, ordered by that evidence.
It does not claim a single cause, because the answer does not prove one.

## Background

*   **Fetch method check.** In
    [CORS-preflight fetch](https://fetch.spec.whatwg.org/#cors-preflight-fetch)
    the browser fails the method check only if the method is not in
    `Access-Control-Allow-Methods`, is not a CORS-safelisted method (`GET`,
    `HEAD`, `POST`), and credentials are included or the list has no `*`. The
    CLI only probes `GET` and `POST`, so a rule "method missing from
    `Access-Control-Allow-Methods`" on a 2xx preflight would never be right to
    fire.
*   **Starlette / FastAPI `CORSMiddleware`**
    ([`cors.py` at `0f08970`](https://github.com/encode/starlette/blob/0f08970e5cce0aec4fc1cea7447c262d741795eb/starlette/middleware/cors.py#L102-L143))
    checks the preflight itself. It collects failures for `origin`, `method`,
    `headers` and `private-network` and answers `400` with the body
    `Disallowed CORS <failures>`. The method compare is exact, so a configured
    `"post"` refuses `POST`. The default `allow_methods` is `("GET",)`
    ([L20](https://github.com/encode/starlette/blob/0f08970e5cce0aec4fc1cea7447c262d741795eb/starlette/middleware/cors.py#L20));
    `*` expands to all methods, so a literal `*` is never sent. The `400` still
    carries `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`
    (with `allow_headers=["*"]` it mirrors the requested headers, so nothing
    shows as missing).
*   **Spring `DefaultCorsProcessor`**
    ([`DefaultCorsProcessor.java` at `d5d671b`](https://github.com/spring-projects/spring-framework/blob/d5d671b4742fb521b3a4c3f15bf3425b1cf7635b/spring-web/src/main/java/org/springframework/web/cors/DefaultCorsProcessor.java#L127-L164))
    checks the Origin first, then method and headers, and answers `403` with
    the body `Invalid CORS request`. It sets the allow lists only after every
    check passed, so a refusal never carries them.
*   **401 and 403 are also how authentication and firewalls answer.** The CLI
    already reads them that way on the probes (`statusHint` in `rules.ts`).
*   **Lists do not prove who refused.** A reverse proxy or gateway can attach
    the same CORS headers to every answer, including an authentication 403.

## The Problem

The current fix for every non-2xx preflight, "Answer the preflight OPTIONS with
204 and the CORS headers", suggests adding a handler. A seller whose CORS
middleware refused the preflight already has one; what is missing is `POST` or
`PAYMENT-SIGNATURE` in the middleware configuration, the Origin, or an
exemption for `OPTIONS` in the authentication layer. The finding gives no hint
which, although a Starlette answer shows it in its headers.

## Goals

*   For a preflight answered with `400`, `401` or `403`, the `cors-preflight`
    finding states which method or headers the answer's allow lists leave out,
    for each list that is present.
*   It then names the likely causes, the CORS configuration first when a list
    leaves something out, authentication or a firewall first otherwise.
*   The fix follows the same order.
*   Finding id, level (`warn`), title and all other statuses stay unchanged.

## Non-Goals

*   No finding about `Access-Control-Allow-Methods` on a 2xx preflight (see
    "Fetch method check" in Background).
*   No reading of the preflight body (see Alternative C).
*   No new hint for `404` or `405` (see Future Improvements).
*   No `PUT`, `PATCH` or `DELETE` probing.

## Open Questions and Decisions

Decided on 2026-11-02:

*   An absent list means "unknown", not "everything missing".
*   `*` in either list counts as allowed regardless of
    `Access-Control-Allow-Credentials`. No studied middleware sends a literal
    `*` on a refusal; this is a defensive default for static configurations.
    `starNote` is not used.
*   The method compare is exact, as Starlette's.
*   `401` is included alongside `400` and `403`.
*   The finding never prints the Origin value, so `rules.ts` needs no import
    from `probe.ts`.

No open questions.

## Critical User Journeys and Acceptance Cases

The CLI sends a `POST` preflight with `payment-signature,content-type` after a
CORS-ready 402.

1.  **Starlette refuses method and header (case A).** Answer `400` with
    `Access-Control-Allow-Methods: GET` and
    `Access-Control-Allow-Headers: Accept, Accept-Language, Content-Language, Content-Type`.
    The finding names method `POST` and header `PAYMENT-SIGNATURE` as left
    out, the CORS configuration first, authentication or a firewall second.
2.  **Only one list present (case A).** Answer `400` with
    `Access-Control-Allow-Methods: GET` and no `Access-Control-Allow-Headers`:
    only method `POST` is named; the headers are not called missing. The
    reverse (only `Access-Control-Allow-Headers: content-type`) names only
    header `PAYMENT-SIGNATURE`.
3.  **Exact method compare.** `Access-Control-Allow-Methods: post` names
    `POST` as left out.
4.  **Wildcard.** `Access-Control-Allow-Methods: *`, with and without
    `Access-Control-Allow-Credentials: true`: no method named.
5.  **Lists complete (case B).** Both lists allow `POST` and both headers:
    authentication or a firewall first, the Origin second.
6.  **No lists (case C).** `401` or `403` without lists, as from Spring or an
    authentication layer: both cause families named; fix exempts `OPTIONS` and
    asks to check the CORS configuration.
7.  **Other statuses unchanged.** `404`, `500` and an undefined status give
    exactly the current detail and fix.
8.  **2xx regression guard.** `204` with a complete
    `Access-Control-Allow-Origin` and `Access-Control-Allow-Headers` and
    `Access-Control-Allow-Methods: GET`: no finding mentions
    `Access-Control-Allow-Methods`.
9.  **Hostile values.** A `400` whose two lists contain control characters and
    quotes passes the server-text quoting check.

## Technical Plan (Architecture)

In `corsRules`, the branch for a non-2xx status (after the `402` branch) calls a
helper when `pre.status === 400 || pre.status === 401 || pre.status === 403`.
The helper reads two headers of the preflight answer.

*   **Method:** only if `access-control-allow-methods` is present (new; the CLI
    does not read this header today). Split on `,`, trim, compare to
    `pre.requestMethod` exactly. `*` counts as allowed.
*   **Headers:** only if `access-control-allow-headers` is present. The
    requested names from `pre.requestHeaders`, mapped through `DISPLAY` as for
    `cors-allow-headers` (`PAYMENT-SIGNATURE`, `Content-Type`, `X-PAYMENT`),
    checked with `missingNames(allow, required, false)`.
*   Header values are shown with `shown()`, which escapes server text
    (`printEscaped`).

Sentences appended to the existing detail
`<asked> returned <status>; browsers need a 2xx.`, in this order:

1.  Per present list with something left out:
    `Access-Control-Allow-Methods is <shown>; method <METHOD> is not in it.`
    and `Access-Control-Allow-Headers is <shown>; headers <names> are not in it.`
    (`<names>` joined with `, `).
2.  The cause sentence and fix for the case:

| Case | Cause sentence | Fix |
|---|---|---|
| A. A present list leaves something out | `A CORS middleware that does not allow them refuses such preflights (Starlette answers 400 this way); authentication or a firewall that does not exempt OPTIONS is the other common cause.` | `Allow <items> in the CORS configuration; if the preflight is still refused, exempt OPTIONS from authentication and firewalls.` |
| B. At least one list present, nothing left out | `The CORS lists in the answer allow this method and these headers, so the likely cause is authentication or a firewall that does not exempt OPTIONS, or a CORS check on the Origin.` | `Exempt OPTIONS from authentication and firewalls, and check that the CORS configuration allows this Origin, method <METHOD> and headers <all names>.` |
| C. No list present | `Likely causes: authentication or a firewall that does not exempt OPTIONS, or a CORS middleware that refused the Origin, method or headers without sending its lists (Spring answers 403 this way).` | same as B |

`<items>` is `method <METHOD>`, `headers <names>`, or both joined with ` and `.
`<all names>` is every requested header name in the same spelling, joined with
`, `. In case B with one list absent, the cause sentence covers only the
present list:
`The CORS list in the answer allows this method, so the likely cause is authentication or a firewall that does not exempt OPTIONS, or a CORS check on the Origin.`
(only `Access-Control-Allow-Methods` present), or the same with
`allows these headers` (only `Access-Control-Allow-Headers` present). All
appended sentences are joined to the existing detail and to each other with one
space.

Example (Starlette with `allow_origins=["https://op8x.com"]`, other options
default, paid `POST`, v2):

```text
warn  OPTIONS  Preflight rejected (400)
      OPTIONS for POST with payment-signature,content-type returned 400;
      browsers need a 2xx. Access-Control-Allow-Methods is "GET"; method POST
      is not in it. Access-Control-Allow-Headers is "Accept, Accept-Language,
      Content-Language, Content-Type"; headers PAYMENT-SIGNATURE are not in it.
      A CORS middleware that does not allow them refuses such preflights
      (Starlette answers 400 this way); authentication or a firewall that does
      not exempt OPTIONS is the other common cause. The browser refuses the
      paid retry with a network error. Affects browser clients only.
      fix: Allow method POST and headers PAYMENT-SIGNATURE in the CORS
      configuration; if the preflight is still refused, exempt OPTIONS from
      authentication and firewalls.
```

Line breaks in the example are the document's; the CLI wraps as it does today.

## Compatibility

*   Only `detail` and `fix` of `cors-preflight` change, and only for 400, 401
    and 403.
*   Id, level, title, method (`OPTIONS`), exit code and JSON shape stay the
    same.
*   Consumers that match the old `fix` string for these statuses see new text.
*   The rules table in `../specs/2026-10-25-cli-cors-payment-flow-design.md`
    gets a pointer to this design.

## Non-Functional Requirements

*   **Security:** the CLI starts parsing one more server header,
    `Access-Control-Allow-Methods` (split and compare only). Its value and the
    `Access-Control-Allow-Headers` value appear in output only through
    `shown()`; acceptance case 9 covers both. Parsing network input is high
    risk under the project rules, so the code gets an adversarial review in
    addition to the normal one.
*   **Performance:** no new request; work is linear in the header length.
*   **Rollout:** ships with the next CLI release, no flag. Reverting is a
    text-only change.

## Risks & Mitigations

*   **Wrong cause.** A 400/401/403 can come from authentication, a firewall, a
    gateway or an Origin refusal. Mitigation: the finding names facts, then
    always at least two causes, ordered by the evidence; it never claims one.
*   **Static CORS headers on non-CORS refusals.** A proxy that adds the same
    lists to every answer makes an authentication 403 look like case A, and
    the method sentence may name `POST`, which browsers do not need there.
    Mitigation: case A names authentication or a firewall as the second cause
    and its fix falls back to it. Accepted residual limit.
*   **New server input in the output.** See Security.
*   **Changed text.** See Compatibility.

## Alternatives Considered

### Alternative A: Separate finding id `cors-preflight-refused`

*   **Pros:** consumers could filter these refusals.
*   **Cons:** same failure (browser refuses the paid retry), two ids for one
    cause; more surface for the finding cap and `--json` consumers.
*   **Reason for Rejection:** title and status already tell the cases apart.

### Alternative B: Hint on every 4xx

*   **Pros:** one branch.
*   **Cons:** 404 and 405 mean no `OPTIONS` route; the advice differs.
*   **Reason for Rejection:** would give wrong advice for those statuses.

### Alternative C: Read the first bytes of the body for `Disallowed CORS` / `Invalid CORS request`

*   **Pros:** identifies Starlette and Spring directly, including Spring's
    list-less 403.
*   **Cons:** `preflight()` must keep the body; server text in findings brings
    in the server-text rules.
*   **Reason for Rejection:** the lists cover the Starlette case and case C
    covers Spring. See Future Improvements.

### Alternative D: Use `Access-Control-Allow-Origin` on the refusal as Origin evidence

*   **Pros:** Starlette omits it when the Origin was refused.
*   **Cons:** the CLI does not compare that value with the Origin it sent
    (known limit in the CORS payment-flow design), and a Spring or
    authentication 403 lacks it for unrelated reasons.
*   **Reason for Rejection:** too weak to rank the Origin above other causes.

### Alternative E: Rule "method missing from Allow-Methods" on every preflight

*   **Pros:** catches misconfigured lists early.
*   **Cons:** contradicts the Fetch Standard for `GET` and `POST`; warns on
    working servers.
*   **Reason for Rejection:** see "Fetch method check" in Background.

## Future Improvements

*   A hint for `404` and `405` (no `OPTIONS` route), if it shows up in practice.
*   Reading the body prefix (Alternative C), if Spring refusals show up in
    practice.
