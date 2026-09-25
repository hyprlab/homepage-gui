#!/usr/bin/env python3
"""Check the documentation's shape and every link in it.

Run it after touching any .md. It is fast, has no dependencies, and a release
does not go out while it fails (docs/RELEASING.md).

  1. Every relative link and #anchor in the repository resolves.
  2. Every docs/*.md is listed in docs/README.md, so nothing becomes a file
     nobody will find.
  3. docs/ holds Markdown only; artwork belongs in assets/.
  4. The README stays a front door: at most README_MAX_LINES lines.
  5. CHANGELOG.md keeps an "## Unreleased" section, its version headings are
     valid SemVer, newest first, and none repeats.
  6. The newest CHANGELOG version equals APP_VERSION in app.py.

Markdown that git ignores or excludes (CLAUDE.md is local only) is skipped.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
README_MAX_LINES = 200
SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)|!\[[^\]]*\]\(([^)\s]+)\)|(?:src|href)=\"([^\"]+)\"")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*$", re.M)
FENCE = re.compile(r"^```.*?^```", re.M | re.S)
SKIP_DIRS = {".git", ".venv", "venv", "node_modules", ".claude", ".pytest_cache", "data", "temp"}
# The first releases were numbered 1.0.0 to 1.1.2, then the line restarted at
# 0.1.3. Their sections stay where they fall in time, so the newest-first check
# skips them. Releases continue from 1.2.0, above every number already used.
RENUMBERED = {"1.0.0", "1.1.0", "1.1.1", "1.1.2"}

problems: list[str] = []


def fail(message: str) -> None:
    problems.append(message)


def markdown_files() -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "*.md"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.split()
        files = [ROOT / name for name in out]
    except (OSError, subprocess.CalledProcessError):
        files = list(ROOT.rglob("*.md"))    # not a git repository yet
    return sorted(p for p in files
                  if p.exists() and p.name != "CLAUDE.md"
                  and not SKIP_DIRS & set(p.relative_to(ROOT).parts))


def slugify(heading: str) -> str:
    """GitHub's anchor rule: lower case, punctuation dropped, spaces to dashes."""
    text = re.sub(r"<[^>]+>|`", "", heading).strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


_anchor_cache: dict[Path, set[str]] = {}


def anchors(path: Path) -> set[str]:
    if path not in _anchor_cache:
        text = FENCE.sub("", path.read_text(encoding="utf-8"))
        seen: dict[str, int] = {}
        found = set()
        for heading in HEADING.findall(text):
            slug = slugify(heading)
            n = seen.get(slug, 0)
            found.add(slug if n == 0 else f"{slug}-{n}")
            seen[slug] = n + 1
        found |= set(re.findall(r'<a\s+(?:name|id)="([^"]+)"', text))
        _anchor_cache[path] = found
    return _anchor_cache[path]


def check_links(files: list[Path]) -> None:
    for path in files:
        rel = path.relative_to(ROOT)
        text = FENCE.sub("", path.read_text(encoding="utf-8"))
        for groups in LINK.findall(text):
            target = next(g for g in groups if g)
            if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                continue   # http:, https:, mailto: and friends
            head, _, fragment = target.partition("#")
            dest = path if not head else (path.parent / head).resolve()
            if not dest.exists():
                fail(f"{rel}: link to {head}, which does not exist")
                continue
            if fragment and dest.suffix == ".md" and fragment.lower() not in anchors(dest):
                fail(f"{rel}: #{fragment} is not a heading in {dest.relative_to(ROOT)}")


def check_docs_dir() -> None:
    docs = ROOT / "docs"
    if not docs.is_dir():
        return
    index = docs / "README.md"
    if not index.exists():
        fail("docs/README.md is missing; it is the index of docs/")
        return
    listed = index.read_text(encoding="utf-8")
    for path in sorted(docs.glob("*.md")):
        if path.name != "README.md" and f"({path.name})" not in listed:
            fail(f"docs/{path.name} is not linked from docs/README.md")
    for path in docs.rglob("*"):
        if path.is_file() and path.suffix != ".md":
            fail(f"{path.relative_to(ROOT)}: docs/ holds Markdown only; artwork goes in assets/")


def check_readme() -> None:
    readme = ROOT / "README.md"
    if not readme.exists():
        fail("README.md is missing")
        return
    n = len(readme.read_text(encoding="utf-8").splitlines())
    if n > README_MAX_LINES:
        fail(f"README.md is {n} lines; the limit is {README_MAX_LINES}. Move the detail into docs/")


def sort_key(version: str):
    m = SEMVER.match(version)
    core = tuple(int(m.group(i)) for i in (1, 2, 3))
    if m.group(4) is None:
        return core + (1,)          # a release outranks its prereleases
    ids = tuple((0, int(x), "") if x.isdigit() else (1, 0, x) for x in m.group(4).split("."))
    return core + (0,) + ids


def check_changelog() -> str | None:
    path = ROOT / "CHANGELOG.md"
    if not path.exists():
        fail("CHANGELOG.md is missing")
        return None
    text = path.read_text(encoding="utf-8")
    if not re.search(r"^## Unreleased\s*$", text, re.M):
        fail("CHANGELOG.md has no '## Unreleased' section")
    versions = []
    for heading in re.findall(r"^##\s+\[?([^\]\s]+)\]?", text, re.M):
        if heading == "Unreleased":
            continue
        if not SEMVER.match(heading):
            fail(f"CHANGELOG.md: '{heading}' is not a SemVer version")
        else:
            versions.append(heading)
    if len(set(versions)) != len(versions):
        fail("CHANGELOG.md has a version heading more than once")
    ordered = [v for v in versions if v not in RENUMBERED]
    if ordered != sorted(ordered, key=sort_key, reverse=True):
        fail("CHANGELOG.md versions are not newest first")
    return versions[0] if versions else None


def check_version(newest: str | None) -> None:
    m = re.search(r'^APP_VERSION\s*=\s*"([^"]+)"', (ROOT / "app.py").read_text(encoding="utf-8"), re.M)
    if not m:
        fail("app.py has no APP_VERSION")
    elif newest and m.group(1) != newest:
        fail(f"APP_VERSION is {m.group(1)} but CHANGELOG.md's newest section is {newest}")


def main() -> int:
    files = markdown_files()
    check_links(files)
    check_docs_dir()
    check_readme()
    check_version(check_changelog())
    if problems:
        for problem in problems:
            print(f"check-docs: {problem}", file=sys.stderr)
        print(f"check-docs: {len(problems)} problem(s)", file=sys.stderr)
        return 1
    print(f"check-docs: {len(files)} Markdown files, all good")
    return 0


if __name__ == "__main__":
    sys.exit(main())
