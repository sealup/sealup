# Contributing to sealup

Thanks for helping. sealup is a small tool kept by one maintainer, so a short, focused change with its tests is the easiest to take. Bugs and ideas go in [issues](https://github.com/sealup/sealup/issues/new/choose); security flaws go to [private reporting](SECURITY.md), never in an issue.

## Build and test

You need Node.js 24 or later, and Docker for the end-to-end tests (Linux only).

```sh
npm ci                # installs exact versions; only esbuild may run an install script
npm run setup         # turns on the pre-commit hook, which runs the gates
npm run check         # type check, Biome, import rules, knip, unit and integration tests
npm run build         # the CLI bundle (dist/cli.mjs) and the action bundle (dist/action.mjs)
npm run test:e2e      # deploys to real servers in containers
```

`npm run check` must be green before a commit. A few rules it holds you to:

- Tests drive sealup from the outside (a CLI run, a transport through its contract) and use `example.com` and the canary secrets of `src/testkit`. Never a real host or a real secret.
- A test, golden file or timing is never weakened to make a change pass.
- `dist/action.mjs` is committed: rebuild it when the code it bundles changes, and CI checks it is byte for byte what a fresh build makes.
- No new runtime dependency: the package ships one bundled file, and each library in it is reviewed.

## Commits

Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/): `fix: …`, `feat: …`, `docs: …`, `test: …`, `ci: …`, `chore: …`, with `!` after the type for a breaking change. The next version is made from them, and so is the start of each release's changelog.

## Before a large pull request

Open an issue first for anything bigger than a bug fix: a new flag, a config key, a protocol, a change to the output. Say what you are trying to do; the maintainer answers whether it fits before you spend the time. sealup stays small on purpose: it syncs a build to a server, and your workflow builds.

## What happens to your pull request

This repo holds the released code, one commit per release. Day-to-day work happens in a private repo, and each release is exported here. So your pull request is reviewed and tested here, but it isn't merged here: it is ported to the private repo and comes back with the next release.

The maintainer ports it like this:

1. Review the pull request here until its CI is green and it is approved.
2. In the private repo, on a new branch, apply its commits with their author kept:
   `curl -fsSL https://github.com/sealup/sealup/pull/<number>.patch | git am`
   (if the trees have drifted, `git am -3`, then fix the conflicts).
3. Run every gate there, open a pull request in the private repo, and merge it.
4. Comment here with a link to the ported change, and close this pull request once the release that holds it is out, with a link to that release.

Your commits keep your name in the private history, and the release's changelog lists your change.
