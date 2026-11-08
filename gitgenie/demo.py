"""A repeatable local example. Never touches a user's existing repository."""

from pathlib import Path
import subprocess

from .core import Git


def create_demo(parent: Path) -> Path:
    repo = parent / "genie-playground"
    if repo.exists():
        return repo
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    git = Git(repo)
    git.run("config", "user.name", "You")
    git.run("config", "user.email", "you@example.test")
    (repo / "checkout.py").write_text('def shipping_total(subtotal):\n    return subtotal + 5\n', encoding="utf-8")
    (repo / "README.md").write_text("# Genie playground\nLocal demo repository.\n", encoding="utf-8")
    git.run("add", ".")
    git.run("commit", "-m", "Add checkout calculation")
    git.run("checkout", "-b", "feature/free-shipping")
    (repo / "checkout.py").write_text('def shipping_total(subtotal):\n    return subtotal if subtotal > 50 else subtotal + 5\n', encoding="utf-8")
    git.run("add", ".")
    git.run("commit", "-m", "Add free shipping over $50")
    git.run("checkout", "main")
    (repo / "checkout.py").write_text('def shipping_total(subtotal):\n    return subtotal + 8\n', encoding="utf-8")
    git.run("-c", "user.name=dev-2", "-c", "user.email=dev2@example.test", "commit", "-am", "Update standard shipping fee")
    git.run("checkout", "feature/free-shipping")
    (repo / "README.md").write_text("# Genie playground\nLocal demo repository.\nWorking on shipping rules.\n", encoding="utf-8")
    return repo
