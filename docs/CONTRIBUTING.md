# Contributing

The conventions anyone editing this repository follows, human or AI. Bug
reports, ideas and pull requests are all welcome, and a clear bug report is
often as useful as a patch.

## Setting up

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
git config core.hooksPath tools/git-hooks     # once per clone or worktree
```

Running the app from source is in
[DOCUMENTATION.md](DOCUMENTATION.md#running-from-source).

The hooks enforce the commit rules below and run the documentation check.
Without `core.hooksPath` they silently do nothing, so set it in every clone
and every worktree.

To try a change the way it will run in production, rebuild the container:
`tools/redeploy.sh`.

## Commits

**The history is the maintainer's.** Commits carry no AI tool attribution: no
`Co-Authored-By:` line for Claude or any other assistant, no "Generated with"
footer, no session line, in a commit, a tag message, a pull request body or a
release body. The [AI notice](../README.md#ai-notice) declares how the project
is built, once, for the whole repository. One stray trailer puts the tool on
GitHub's Contributors panel, and removing it again means rewriting history
(Homepage GUI's was rewritten for exactly this on 2026-09-25).

A `Co-Authored-By:` trailer is still how a **person** is credited, with the
GitHub noreply address that resolves to their profile (see
[Credit](#credit)).

Subjects follow [Conventional Commits](https://www.conventionalcommits.org):
`type(area): summary`, lower case after the colon, imperative, no full stop,
72 characters at most and ideally nearer 50.

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `build`, `ci`, `test`,
  `style`, `chore`, `revert`. A `!` after the type (`feat(setup)!:`) marks a
  breaking change. The type is not decoration: `tools/next-version.sh` reads
  it to decide the next version ([RELEASING.md](RELEASING.md)).
- The area is where the change lives: `editor`, `sidebar`, `icons`,
  `uploads`, `backups`, `yaml`, `setup`, `discovery`, `auth`, `settings`,
  `ui`, `docker`, `release`. Leave it out only when there is no single place.
- An issue number goes at the end: `fix(editor): keep the scroll position (#12)`.
- Releases: `chore(release): 1.2.0`.

The body is optional and short: why the change exists, never what the diff
already says. Past 100 words the detail belongs in `docs/` or `CHANGELOG.md`,
or the commit wants splitting. **Each body paragraph is one line, not
wrapped:** GitHub keeps every line break in a body, so text wrapped at 72
breaks a second time on a phone. Write it with `git commit -F -` and a heredoc.

No em dashes in commit messages: a colon, a comma or a full stop replaces
them.

`tools/git-hooks/commit-msg` refuses the attribution lines, em dashes, a
subject without a type, and an overlong subject or body. `pre-push` refuses to
publish any commit or tag carrying attribution. CI runs the same check on every
commit in a pull request.

## CLAUDE.md and .claude/

Both are local only: listed in `.git/info/exclude`, not `.gitignore`, so the
repository never names the tool. Never `git add -f` them. A new worktree does
not get them: symlink `CLAUDE.md` into it before working there.

## Prose style

Documentation, the changelog, release notes, UI text and issue replies:

- Factual, plain language. Say what the app does, not what it enables you to
  do. No marketing, no superlatives, no "finally", no emoji.
- No em dashes in the README or `docs/`: a colon, a comma or a full stop.
- American spelling in anything the app shows: color, behavior, canceled.
- Changelog lines describe the change from the user's side. How it was built
  belongs in the commit.
- Comments in code explain *why*, not *what*.

## Documentation

The README is the front door and has a 200-line ceiling. Before writing a word
of documentation, decide where it goes: the table in
[docs/README.md](README.md) says. After touching any `.md`, run:

```sh
python3 tools/check-docs.py
```

It checks every relative link and anchor, that every `docs/*.md` is indexed,
that `docs/` holds Markdown only, the README's length, and the changelog's
shape and version.

Every user-visible change adds a line under `## Unreleased` in `CHANGELOG.md`.
Every release, patches included, gets a section. The About dialog renders the
changelog, so a skipped section is a gap users see.

## Code

- Match what is there: Flask routes in `app.py`, the `{"error": "..."}` shape
  for JSON failures, and the wrapped `fetch` in `static/js/app.js` for every
  call, which adds the CSRF header and handles an expired session.
- `services.yaml` is only ever written through `yaml_store`, which validates,
  backs up and writes atomically. Never write it any other way.
- Unknown keys in `services.yaml` survive a round trip. A change that drops or
  rewrites something the user wrote by hand is a bug, however tidy.
- Anything the user typed is rendered with Jinja's escaping or `textContent`,
  never `|safe` or `innerHTML`.
- A change an existing install can't take without help (a renamed environment
  variable, a moved `DATA_DIR` file, a changed port) is a MAJOR release.
- User-facing failures say what happened and what to do, in a sentence.
- Rebuild and run the app (`tools/redeploy.sh`) before saying something works.

## Credit

Outside pull requests land as commits on `main` made by the maintainer,
crediting the author with a trailer that uses their GitHub noreply address:

```
Co-Authored-By: Jane Doe <12345678+janedoe@users.noreply.github.com>
```

Get the id with `gh api users/<login> --jq .id`. An address taken from their
own commit may not be linked to their account, and then they never appear as a
contributor; that can't be fixed after a tagged release without rewriting
history.

Add them to `data/CONTRIBUTORS` (their name and `@login`) and describe the
work in [CREDITS.md](CREDITS.md). Close the pull request with a comment saying
what was taken, what changed and what was left out.

In release notes an `@` is for people whose code, art or translation is in the
release. Reporters and requesters are named without the `@`: an @ notifies
someone and reads as authorship. `tools/release-notes.sh` strips the @ from any
handle not in `data/CONTRIBUTORS`.

## Issue replies

Every reply to an issue or pull request written by an agent begins with
`*Agentic reply:*` in italics, then a blank line, then the reply.

- A reply saying something is done is one or two sentences: what changed from
  the user's side, and which version carries it. How it was built is in the
  commit and the changelog.
- No thanks, no pleasantries, no em dashes. Plain, brief, human.
- Anything the user has to do (send a log, try something, check a setting) is
  a numbered list, one request per item.
- Name the version and how to update. Reply once the image is pushed, not
  before, then close the issue.

```
*Agentic reply:*

Fixed in 1.2.1: the editor now keeps your place when you save.

Update with `docker compose pull && docker compose up -d`.
```

Only a reply that asks for something or explains a decline runs longer.
