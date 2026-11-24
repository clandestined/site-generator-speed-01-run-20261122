[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/clandestined/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/clandestined/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122

A faster drop-in for makefun-site 1.0.0: `solve.js` answers every case exactly
as makefun-site does, but faster. A single dependency-free ES module that
re-implements the whole build (front matter, Markdown subset, template
dialect, slugs, collections, tags, layouts, report) with:

- templates compiled once per case into plain JavaScript functions (loop
  scopes and loop state reused across iterations instead of re-allocated),
- a single-pass Markdown renderer that scans for the next special character
  instead of walking the text one character at a time and escaping every
  character through a regex,
- cached slug and long-date results (tag names, titles and headings repeat
  heavily across a site),
- fast paths for the common cases (ASCII-only slugs, plain-text runs with
  nothing to escape, line ends already `\n`).

`main.ts` is the house driver, unchanged. `run(input)` in `solve.js` returns
the output tree for one case's input, byte for byte identical to
makefun-site 1.0.0's.

## License

MIT — see [LICENSE](LICENSE).
