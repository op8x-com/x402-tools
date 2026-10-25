# Solutions

Short notes on problems that took real effort to solve, so the next person does not solve them twice.

Search here before non-trivial work. Add a note after fixing anything that was surprising, took more than one attempt, or could recur.

## Format

One file per problem: `YYYY-MM-DD-short-slug.md`, starting with this frontmatter:

```markdown
---
title: Workers need nodejs_compat for @x402/hono
date: 2026-10-25
area: sdk            # cli | sdk | site | ci | release | tooling
tags: [cloudflare-workers, buffer]
symptom: "ReferenceError: Buffer is not defined at runtime"
---

## Problem
What failed, and how it showed up.

## Cause
The root cause, not the first guess.

## Fix
What changed, with file paths or commands.

## Prevention
The test, lint rule, hook or contributor guideline that stops it from happening again. "None yet" is allowed, but say why.
```

Keep notes short and factual. If a note keeps getting referenced, promote its prevention to a test or a rule in `CONTRIBUTING.md`.
