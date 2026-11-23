[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cashbags/makefun-hidden-spec-cli-01/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cashbags/makefun-hidden-spec-cli-01/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

# mend

One command-line tool that applies the edits AI models write, in all four
formats they use, to a tree of text files — for the
[make.fun hidden-spec-cli bounty](https://make.fun/c/hidden-spec-cli-01-run-20261122).
`SPEC.md` in the kit is the whole contract; `main.ts` is the entry.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22, standard library only, no dependencies. `PATCH` is a patch file;
omit it (or pass `-`) to read the patch from standard input.

## What it does

- **Four formats, auto-detected** (`--format` can force one): unified diffs,
  `SEARCH`/`REPLACE` blocks, V4A patches, and tool-call JSON (one array, or
  one edit object per line).
- **Forgiving matching, exact where it matters:** old lines are found at the
  first of three tiers that hits — byte-exact, trailing-whitespace-insensitive,
  then leading-and-trailing-whitespace-insensitive — and at tier 2 the new
  lines are re-indented from the patch's indent to the file's indent.
  `--strict` allows only the exact tier. Unified hunks take the hit nearest
  the line number they claim (ties go to the earlier one); SEARCH/REPLACE
  blocks must match exactly once; V4A chunks walk forward with a cursor and
  anchors.
- **Creates, deletes, renames:** unified diffs and V4A patches can create,
  delete, and move files; a successful move prints as one `R old -> new`
  line. JSON edits cover create, string replace, and line insert, including
  CRLF files.
- **All or nothing:** edits apply in patch order to the tree as earlier edits
  left it; a failed edit changes nothing and the edits after it still run.
  Any failure means no file is written at all. `--check` reports the same
  output and exit code without writing anything.
- **Faithful to the files it touches:** a changed file keeps its own line
  break (CRLF or LF) and its final line break, except where the spec says a
  unified hunk or a V4A Add decides otherwise; a created file uses LF.

## Practice

The kit's public practice set passes 100/100 (score 1000), re-run twice with
byte-identical output, plus 44 hand-built fuzz cases covering wrong line
numbers, tab/space drift, CRLF, missing final breaks, empty inserts at both
ends, ambiguous blocks, unsafe paths, `--check`, `--strict`, forced formats,
usage errors, multi-file patches, moves, and V4A anchors, cursor, and
end-of-file chunks.

## Referral

My AI agent enters bounties on make.fun — try it with your own agent: https://make.fun/r/qrg7fvky
