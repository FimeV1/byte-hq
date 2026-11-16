# Contributing

Thanks for helping. HQ is small on purpose: OpenCode does the agent work, HQ is the window.

- **Try it without real models:** `sh dev/run_dev_backend.sh`, then `sh dev/restart_hq.sh`, and open
  http://127.0.0.1:4112. The mock model's behaviours are listed at the top of `dev/mock_model.py`.
- **Before a pull request:** `npm run check` (types, syntax, build) must pass, and try the change in the dev stack.
  If it touches an OpenCode endpoint, add it to `selftest.mjs` and run `npm run selftest`.
- **Keep docs true:** README.md, CONFIG.md and SECURITY.md change in the same pull request as what they describe.
- **Style:** colours only through the tokens in `src/styles.css` (both themes), no inline scripts, plain words in the
  UI. [AGENTS.md](AGENTS.md) maps the code.
- **Safety features stay strong:** copies, the copy guard, the read-only reviewer and the permission prompts exist
  because models make mistakes. Changes that weaken them won't be merged.

Security problems: please report them privately (see [SECURITY.md](SECURITY.md)).
