from __future__ import annotations

import argparse
import json
import tempfile
from dataclasses import asdict
from pathlib import Path

from .core import GitError, inspect


def main():
    parser = argparse.ArgumentParser(description="Git Genie — a floating, local-first Git companion")
    parser.add_argument("--repo", help="Repository to watch; otherwise select it in the app")
    parser.add_argument("--base", help="Comparison branch (defaults to local main, then master)")
    parser.add_argument("--remote", help="Opt in to fetch this remote on launch and every 5 minutes")
    parser.add_argument("--demo", action="store_true", help="Launch a fresh local example with overlapping edits")
    parser.add_argument("--check", action="store_true", help="Print the current analysis as JSON and exit")
    args = parser.parse_args()
    if args.demo and args.repo:
        parser.error("Choose --demo or --repo, not both.")
    if args.check and not (args.repo or args.demo):
        parser.error("--check requires --repo or --demo")
    if args.demo and args.remote:
        parser.error("The demo is local; omit --remote")
    # Demo lifetime matches the process, including subprocesses and UI teardown.
    with tempfile.TemporaryDirectory(prefix="gitgenie-") if args.demo else _NoDemo() as demo_dir:
        repo = args.repo
        if args.demo:
            from .demo import create_demo
            repo = str(create_demo(Path(demo_dir)))
        if args.check:
            try:
                print(json.dumps(asdict(inspect(repo, args.base)), indent=2, ensure_ascii=False))
            except GitError as exc:
                parser.exit(1, f"Git Genie: {exc}\n")
            return
        import tkinter as tk
        from .app import GenieApp
        from .windows import enable_dpi_awareness
        enable_dpi_awareness()
        root = tk.Tk()
        GenieApp(root, repo, args.base, args.remote, demo=args.demo)
        root.mainloop()


class _NoDemo:
    def __enter__(self):
        return None

    def __exit__(self, *args):
        pass


if __name__ == "__main__":
    main()
