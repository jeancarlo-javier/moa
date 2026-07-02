# Publishing

Where moa lives and how it reaches users.

## Where it's published

| Surface   | Location |
|-----------|----------|
| Source    | GitHub — [jeancarlo-javier/moa](https://github.com/jeancarlo-javier/moa) (public, MIT) |
| Directory | skills.sh — [jeancarlo-javier/moa/moa](https://www.skills.sh/jeancarlo-javier/moa/moa) |

The GitHub repo is the single source of truth. skills.sh hosts nothing — it
clones the repo on install and lists it in its directory.

## How users install

```bash
npx skills add jeancarlo-javier/moa
```

Works with any [skills.sh](https://skills.sh)-supported agent (Claude Code,
Cursor, Codex, Gemini, …). The CLI clones this repo, finds the skill by its
`SKILL.md`, and copies it into the agent's skills folder.

## How it's resolved

- The skill is `moa-core/SKILL.md` (+ `references/`, `templates/`, `schema/`).
- skills.sh discovers it by searching the repo for `SKILL.md` — the folder name
  (`moa-core`) is irrelevant.
- The public name comes from the `name:` field in the frontmatter (`moa`), which
  is why the directory path is `<owner>/<repo>/moa`.

## How the directory listing works

skills.sh is **install-driven** — not crawl- or submission-based:

- No submit form. A repo appears once installs are registered through the CLI.
- Ranking is by install count.
- Downloads are the only lever — there is nothing to "wait for."

## Releasing an update

1. Edit the skill under `moa-core/` (keep it token-lean — see [AGENTS.md](../AGENTS.md)).
2. Bump `version:` in `moa-core/SKILL.md`.
3. Commit and push to `main`.
4. (Optional) Tag the release: `git tag vX.Y.Z && git push --tags`.

Users pick up the new version on their next `npx skills add` / `skills update`.
