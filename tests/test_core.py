"""Integration checks against disposable, real Git repositories."""

import tempfile
import unittest
from pathlib import Path

from gitgenie.core import Git, GitError, Span, inspect
from gitgenie.demo import create_demo


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="genie-test-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git = Git(self.repo)
        self.git.run("init", "-b", "main")
        self.git.run("config", "user.name", "You")
        self.git.run("config", "user.email", "you@example.test")
        self.write("code.txt", "".join(f"line {i}\n" for i in range(1, 13)))
        self.commit("Initial commit")
        self.git.run("checkout", "-b", "feature")

    def write(self, path, text):
        (self.repo / path).write_text(text, encoding="utf-8")

    def edit(self, line, value, path="code.txt"):
        lines = (self.repo / path).read_text(encoding="utf-8").splitlines(keepends=True)
        lines[line - 1] = value + "\n"
        self.write(path, "".join(lines))

    def commit(self, message, author="You"):
        self.git.run("add", "--all")
        self.git.run("-c", f"user.name={author}", "commit", "-m", message)

    def main_edit(self, line=2, value="Changed by dev-2"):
        self.git.run("checkout", "main")
        self.edit(line, value)
        self.commit("Update on main", "dev-2")
        self.git.run("checkout", "feature")

    def test_clean_repository_and_latest_commit(self):
        state = inspect(self.repo)
        self.assertEqual((state.branch, state.base), ("feature", "main"))
        self.assertEqual((state.ahead, state.behind), (0, 0))
        self.assertEqual(state.latest.subject, "Initial commit")
        self.assertEqual(state.overlaps, ())

    def test_same_lines_author_and_no_mutations(self):
        self.edit(2, "Changed by you")
        self.commit("Feature update")
        self.main_edit()
        before = self.git.run("status", "--porcelain=v1", "-z")
        head = self.git.run("rev-parse", "HEAD")
        index = (self.repo / ".git" / "index").read_bytes()
        state = inspect(self.repo)
        self.assertEqual((state.ahead, state.behind), (1, 1))
        self.assertEqual(state.overlaps[0].kind, "same lines")
        self.assertEqual(state.overlaps[0].authors, ("dev-2",))
        self.assertEqual(self.git.run("status", "--porcelain=v1", "-z"), before)
        self.assertEqual(self.git.run("rev-parse", "HEAD"), head)
        self.assertEqual((self.repo / ".git" / "index").read_bytes(), index)

    def test_unstaged_edit(self):
        self.main_edit()
        self.edit(2, "Uncommitted edit")
        state = inspect(self.repo)
        self.assertEqual(state.dirty_files, 1)
        self.assertEqual(state.overlaps[0].kind, "same lines")

    def test_staged_edit_even_when_worktree_restores_head(self):
        self.main_edit()
        self.edit(2, "Staged edit")
        self.git.run("add", "code.txt")
        self.edit(2, "line 2")
        state = inspect(self.repo)
        self.assertEqual(state.dirty_files, 1)
        self.assertEqual(state.overlaps[0].kind, "same lines")

    def test_different_lines_have_lower_risk(self):
        self.main_edit()
        self.edit(11, "Independent local edit")
        state = inspect(self.repo)
        self.assertEqual(state.overlaps[0].kind, "same file")
        self.assertNotIn("possible rebase", state.message)

    def test_identical_edits_not_reported(self):
        self.main_edit()
        self.edit(2, "Changed by dev-2")
        self.commit("Same change independently")
        self.assertEqual(inspect(self.repo).overlaps, ())

    def test_distinct_files_not_reported(self):
        self.main_edit()
        self.write("other.txt", "An unrelated file\n")
        self.commit("Add another file")
        state = inspect(self.repo)
        self.assertEqual(state.overlaps, ())
        self.assertEqual(state.behind, 1)

    def test_untracked_collision_with_incoming_addition(self):
        self.git.run("checkout", "main")
        self.write("new.txt", "main version\n")
        self.commit("Add new file", "dev-2")
        self.git.run("checkout", "feature")
        self.write("new.txt", "local untracked version\n")
        state = inspect(self.repo)
        self.assertEqual(state.untracked_files, 1)
        self.assertEqual(state.overlaps[0].path, "new.txt")
        self.assertIn("added", state.overlaps[0].kind)

    def test_delete_modify_overlap(self):
        self.main_edit()
        (self.repo / "code.txt").unlink()
        state = inspect(self.repo)
        self.assertIn("removed", state.overlaps[0].kind)

    def test_weird_filenames_and_literal_attribution(self):
        path = "spaces [one] café.txt"
        self.write(path, "before\n")
        self.commit("Add unusual filename")
        self.git.run("checkout", "main")
        self.git.run("merge", "--ff-only", "feature")
        self.write(path, "from main\n")
        self.commit("Edit unusual filename", "dev-2")
        self.git.run("checkout", "feature")
        self.write(path, "from feature\n")
        state = inspect(self.repo)
        self.assertEqual(state.overlaps[0].path, path)
        self.assertEqual(state.overlaps[0].authors, ("dev-2",))

    def test_binary_changes(self):
        (self.repo / "image.bin").write_bytes(b"\x00initial")
        self.commit("Add binary")
        self.git.run("checkout", "main")
        self.git.run("merge", "--ff-only", "feature")
        (self.repo / "image.bin").write_bytes(b"\x00main")
        self.commit("Update binary", "dev-2")
        self.git.run("checkout", "feature")
        (self.repo / "image.bin").write_bytes(b"\x00feature")
        self.assertIn("changed type", inspect(self.repo).overlaps[0].kind)

    def test_detached_head_is_supported(self):
        self.git.run("checkout", "--detach")
        state = inspect(self.repo)
        self.assertTrue(state.branch.startswith("detached @"))

    def test_missing_main_is_actionable(self):
        self.git.run("branch", "-D", "main")
        state = inspect(self.repo)
        self.assertIsNone(state.base)
        self.assertIn("Choose a comparison branch", state.message)

    def test_custom_comparison_branch(self):
        self.git.run("branch", "trunk", "main")
        self.assertEqual(inspect(self.repo, "trunk").base, "trunk")
        with self.assertRaises(GitError):
            inspect(self.repo, "does-not-exist")

    def test_main_itself_has_no_incoming_overlap(self):
        self.git.run("checkout", "main")
        self.edit(2, "working edit")
        state = inspect(self.repo)
        self.assertEqual(state.overlaps, ())
        self.assertEqual(state.dirty_files, 1)

    def test_demo_is_real_and_local(self):
        repo = create_demo(Path(self.temp.name))
        state = inspect(repo)
        self.assertEqual((state.branch, state.ahead, state.behind), ("feature/free-shipping", 1, 1))
        self.assertEqual(state.overlaps[0].authors, ("dev-2",))
        self.assertEqual(Git(repo).run("remote"), "")


class EmptyRepoTests(unittest.TestCase):
    def test_first_commit_required(self):
        with tempfile.TemporaryDirectory() as folder:
            git = Git(folder)
            git.run("init", "-b", "main")
            (Path(folder) / "new.txt").write_text("new")
            git.run("add", ".")
            state = inspect(folder)
            self.assertIsNone(state.latest)
            self.assertEqual(state.dirty_files, 1)
            self.assertIn("first commit", state.message)

    def test_non_repo_reports_error(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(GitError):
                inspect(folder)


class FetchTests(unittest.TestCase):
    def test_opt_in_fetch_updates_only_remote_tracking_refs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            remote = root / "remote.git"
            source = create_demo(root)
            Git(root).run("init", "--bare", str(remote))
            Git(source).run("remote", "add", "origin", str(remote))
            Git(source).run("push", "origin", "main")
            before = Git(source).run("rev-parse", "HEAD")
            Git(source).fetch("origin")
            self.assertTrue(Git(source).exists("origin/main"))
            self.assertEqual(Git(source).run("rev-parse", "HEAD"), before)
            self.assertEqual(inspect(source, "origin/main").overlaps[0].authors, ("dev-2",))


class SpanTests(unittest.TestCase):
    def test_boundaries(self):
        self.assertTrue(Span(2, 1).overlaps(Span(2, 1)))
        self.assertFalse(Span(2, 1).overlaps(Span(3, 1)))
        self.assertTrue(Span(2, 0).overlaps(Span(2, 0)))
        self.assertTrue(Span(2, 0).overlaps(Span(3, 1)))
        self.assertFalse(Span(2, 0).overlaps(Span(5, 1)))


if __name__ == "__main__":
    unittest.main()
