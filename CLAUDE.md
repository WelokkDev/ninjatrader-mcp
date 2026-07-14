# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

This is an **open-core** repo: the public substrate lives here, and each
user's own trading logic lives in a gitignored `src/private/` module composed
on top of it.

## The boundary rules (always apply)

- **Public code never imports from `src/private/`.** The dependency is
  one-way: private imports public. If public code needs private logic, invert
  it — generic seam in public, implementation in private.
- **Never `git add -f` anything under `src/private/`**, and never include it
  in a pull request to the public repo. It is typically a nested git repo with
  its own private remote — version it there.
- Public commands stay private-free: `npm run build`, `npm run typecheck`, and
  the public tests. The private counterparts are `npm run build:private` and
  `npm run typecheck:private`. (`npm test` runs `src/private/tests/` too when
  the module is present.)

## Adding or building private tools

Follow [BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md): scaffold with
`npm run init-private`, build with `npm run build:private`, point the MCP
client at `build/private/index.js`, and run exactly one server process (it
owns the NT8 bridge and the candle cache).
