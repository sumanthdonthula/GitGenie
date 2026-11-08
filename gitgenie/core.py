"""Read-only Git analysis. No pull, checkout, merge, rebase, or index writes."""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


class GitError(RuntimeError):
    pass


@dataclass(frozen=True)
class Commit:
    sha: str
    author: str
    subject: str
    date: str


@dataclass(frozen=True)
class Span:
    """Changed lines in the shared ancestor; zero-length spans are insertions."""

    start: int
    count: int

    def overlaps(self, other: Span) -> bool:
        if self.count == 0 and other.count == 0:
            return self.start == other.start
        if self.count == 0:
            return other.start - 1 <= self.start <= other.start + other.count - 1
        if other.count == 0:
            return self.start - 1 <= other.start <= self.start + self.count - 1
        return max(self.start, other.start) <= min(
            self.start + self.count - 1, other.start + other.count - 1
        )


@dataclass
class FileChange:
    path: str
    spans: list[Span] = field(default_factory=list)
    structural: bool = False


@dataclass(frozen=True)
class Overlap:
    path: str
    kind: str
    authors: tuple[str, ...]
    commits: tuple[Commit, ...]


@dataclass(frozen=True)
class Snapshot:
    root: str
    branch: str
    base: str | None
    latest: Commit | None
    incoming: tuple[Commit, ...]
    ahead: int
    behind: int
    dirty_files: int
    untracked_files: int
    changed_files: int
    overlaps: tuple[Overlap, ...]
    message: str
    diff: str

    @property
    def alert_key(self) -> tuple:
        # Committing or switching branches should produce a fresh result.
        return (
            self.root, self.branch, self.base,
            self.latest.sha if self.latest else None,
            tuple(c.sha for c in self.incoming),
            tuple((o.path, o.kind, o.authors) for o in self.overlaps),
        )


class Git:
    def __init__(self, repo: str | Path):
        self.repo = Path(repo).expanduser().resolve()

    def run(self, *args: str, timeout: int = 25, ok: tuple[int, ...] = (0,)) -> str:
        env = dict(os.environ)
        env.update(GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never", GIT_OPTIONAL_LOCKS="0")
        # Explicit cwd is authoritative even if launched inside another Git process.
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
            env.pop(name, None)
        try:
            result = subprocess.run(
                ["git", "-c", "core.quotepath=false", "-c", "color.ui=false", *args],
                cwd=self.repo, env=env, capture_output=True, encoding="utf-8",
                errors="replace", timeout=timeout,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except FileNotFoundError as exc:
            raise GitError("Git was not found. Install Git and restart Genie.") from exc
        except subprocess.TimeoutExpired as exc:
            raise GitError(f"Git took too long ({timeout}s). Will retry on the next check.") from exc
        except OSError as exc:
            raise GitError(f"Cannot open repository: {exc}") from exc
        if result.returncode not in ok:
            raise GitError(result.stderr.strip() or "Git could not complete the check.")
        return result.stdout

    def exists(self, ref: str) -> bool:
        return bool(self.run("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", ok=(0, 1)))

    def commits(self, *revisions: str, path: str | None = None, limit: int = 12) -> tuple[Commit, ...]:
        args = ["--literal-pathspecs", "log", f"-n{limit}", "--format=%H%x00%an%x00%s%x00%aI", *revisions, "--"]
        if path is not None:
            args.append(path)
        rows = self.run(*args).splitlines()
        return tuple(Commit(*parts) for row in rows if len(parts := row.split("\0")) == 4)

    def fetch(self, remote: str) -> None:
        if remote not in self.run("remote").splitlines():
            raise GitError(f"Remote {remote!r} is not configured.")
        # Only update remote tracking refs, even with a custom configured refspec.
        self.run("fetch", "--no-tags", "--no-recurse-submodules", "--", remote,
                 f"+refs/heads/*:refs/remotes/{remote}/*", timeout=75)


def parse_patch(patch: str, path: str) -> FileChange:
    change = FileChange(path)
    for line in patch.splitlines():
        match = re.match(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@", line)
        if match:
            change.spans.append(Span(int(match[1]), int(match[2]) if match[2] is not None else 1))
        if line.startswith(("deleted file mode", "new file mode", "old mode", "new mode", "Binary files", "GIT binary patch")):
            change.structural = True
    return change


def changes(git: Git, ancestor: str, target: str | None, *, cached: bool = False) -> dict[str, FileChange]:
    revisions = [ancestor] + ([target] if target else [])
    options = ["--cached"] if cached else []
    # NUL-delimited filenames support spaces, quotes, tabs, and non-ASCII paths.
    paths = git.run("diff", *options, "--name-only", "-z", "--no-renames", *revisions, "--").split("\0")
    result = {}
    for path in filter(None, paths):
        patch = git.run("--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
                        "--no-renames", "--unified=0", *options, *revisions, "--", path)
        result[path] = parse_patch(patch, path)
    return result


def inspect(repo: str | Path, base_ref: str | None = None) -> Snapshot:
    git = Git(repo)
    root = git.run("rev-parse", "--show-toplevel").strip()
    git = Git(root)
    branch = git.run("symbolic-ref", "--quiet", "--short", "HEAD", ok=(0, 1)).strip()
    has_head = git.exists("HEAD")
    if not branch:
        branch = f"detached @ {git.run('rev-parse', '--short', 'HEAD').strip()}" if has_head else "unborn branch"
    latest = git.commits("HEAD", limit=1)[0] if has_head else None
    dirty_paths = git.run("diff", "HEAD", "--name-only", "-z", "--", ok=(0,)).split("\0") if has_head else []
    staged_paths: set[str] = set()
    if has_head:
        staged_paths = set(filter(None, git.run("diff", "--cached", "HEAD", "--name-only", "-z", "--").split("\0")))
        dirty_paths = sorted(set(filter(None, dirty_paths)) | staged_paths)
    untracked = list(filter(None, git.run("ls-files", "--others", "--exclude-standard", "-z").split("\0")))
    if not has_head:
        staged = list(filter(None, git.run("diff", "--cached", "--name-only", "-z").split("\0")))
        return Snapshot(root, branch, None, None, (), 0, 0, len(staged), len(untracked), 0, (),
                        "Make your first commit to start comparing branches.", "")
    base = base_ref
    if base:
        if base.startswith("-") or not git.exists(base):
            raise GitError(f"Comparison branch {base!r} was not found. Choose an existing branch.")
    else:
        # Local-first: never silently use a remote tracking branch.
        base = next((ref for ref in ("main", "master") if git.exists(f"refs/heads/{ref}")), None)
    if base is None:
        return Snapshot(root, branch, None, latest, (), 0, 0, len(list(filter(None, dirty_paths))),
                        len(untracked), 0, (), "No local main or master branch. Choose a comparison branch.", "")
    ancestor = git.run("merge-base", "HEAD", base, ok=(0, 1)).strip()
    if not ancestor:
        raise GitError(f"{branch} and {base} have no shared history.")
    ahead, behind = map(int, git.run("rev-list", "--left-right", "--count", f"HEAD...{base}", "--").split())
    incoming = git.commits(f"HEAD..{base}") if behind else ()
    ours = changes(git, ancestor, None)  # includes branch commits + staged + unstaged edits
    if staged_paths:
        index_changes = changes(git, ancestor, None, cached=True)
        for path in staged_paths & index_changes.keys():
            indexed = index_changes[path]
            if path in ours:
                ours[path].spans.extend(indexed.spans)
                ours[path].structural |= indexed.structural
            else:
                ours[path] = indexed
    theirs = changes(git, ancestor, base)
    # Untracked files are not in git diff, but may collide with an incoming addition.
    for path in untracked:
        ours[path] = FileChange(path, structural=True)
    overlaps = []
    for path in sorted(ours.keys() & theirs.keys()):
        ours_file, theirs_file = ours[path], theirs[path]
        # Identical final contents are already resolved, even if changed on both sides.
        if path not in untracked:
            working_diff = git.run("--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
                                   "--no-renames", base, "--", path)
            staged_diff = git.run("--literal-pathspecs", "diff", "--cached", "--no-ext-diff", "--no-textconv",
                                  "--no-renames", base, "--", path) if path in staged_paths else ""
            if not working_diff and not staged_diff:
                continue
        line_overlap = any(a.overlaps(b) for a in ours_file.spans for b in theirs_file.spans)
        kind = "same lines" if line_overlap else "same file"
        if ours_file.structural or theirs_file.structural:
            kind = "file added, removed, or changed type"
        commits = git.commits(f"{ancestor}..{base}", path=path, limit=8)
        authors = tuple(dict.fromkeys(c.author for c in commits))
        overlaps.append(Overlap(path, kind, authors, commits))
    high_risk = any(o.kind != "same file" for o in overlaps)
    if high_risk:
        message = "Overlapping edits detected. Review before a possible rebase."
    elif overlaps:
        message = "Both branches touch the same files. Review before syncing."
    elif behind:
        message = f"{base} has {behind} newer commit{'s' if behind != 1 else ''}. Consider a rebase when ready."
    else:
        message = f"Up to date with {base}. Watching for changes."
    # Bounded output is shown in a read-only details window.
    diff = git.run("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--stat", ancestor, "--")
    return Snapshot(root, branch, base, latest, incoming, ahead, behind,
                    len(list(filter(None, dirty_paths))), len(untracked), len(ours), tuple(overlaps), message, diff)
