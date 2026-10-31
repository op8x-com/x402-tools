---
title: Server values printed side by side must not look alike
date: 2026-10-31
area: cli
tags: [security, output, unicode]
symptom: "payto-rotates printed two different payTo values that looked identical, or a note that claimed the wrong reason"
---

## Problem
`payto-rotates` prints the `payTo` addresses of two challenges next to each other. The red-team review before merge made a hostile server print two different values that looked the same: a Hangul filler (U+3164) or a Cyrillic letter in the middle, the literal text `\u{3164}` against the real character, or the literal text `(empty)` against a value that was empty after cleaning. A note that tried to name the reason ("invisible characters", "after character 100") was wrong in several of these cases.

## Cause
`cleanText` removes control, format and separator characters, but not printable look-alikes. Once the output gives a sequence such as `\u{…}` or `(empty)` a meaning, a server can send that sequence as plain text, unless the escape character itself is escaped too.

## Fix
`packages/cli/src/payto.ts`: every printed `payTo` character outside U+0020..U+007E, and the backslash, is written as `\u{XXXX}`; escapes are applied after shortening and never split. Values that still look the same after printing in full get one neutral note, `(these look the same here but differ)`, which names no reason and so cannot be wrong.

## Prevention
`packages/cli/test/payto.test.ts` (cases "16 …") covers the look-alikes, the forged escape, the forged `(empty)` and cut values. When a new rule prints two server values for comparison: escape non-ASCII and the escape character, test a forged marker, and keep notes neutral. Asset and network names in `<where>` are not escaped (same as the spend findings); see the design's "Look-alike asset or network names" risk.
