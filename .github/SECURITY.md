# Security policy

## Reporting a vulnerability

Report it privately, either way works:

- on GitHub: [Report a vulnerability](https://github.com/op8x-com/x402-tools/security/advisories/new) in the Security tab, or
- by email to security@op8x.com with the subject `Security: <short summary>`.

Do not open a public issue or pull request for a vulnerability.

Include:

- the package and version (or commit),
- steps or a minimal input that shows the problem,
- what an attacker could do with it.

Do not send real secrets, private keys or other people's data; a redacted or synthetic example is enough.

You get a first answer within 5 working days. Once a fix is released, the issue is described publicly in the changelog or a GitHub security advisory, and you are credited if you want to be.

## Supported versions

Only the latest version of each package receives security fixes:

| Package | Supported |
| --- | --- |
| `@op8x/cli` | latest release |
| `@op8x/analytics` | latest release (pre-release, not on npm yet) |
| `apps/demo-api` | not supported; demo only |

## Scope

In scope: code in this repository, including its CI and release workflows. Out of scope: third-party x402 servers, facilitators and the x402 libraries this code depends on; report those to their maintainers.
