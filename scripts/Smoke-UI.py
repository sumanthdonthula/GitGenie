"""Exercise a real Tk panel and its background scan, then close it."""

import sys
import tempfile
import time
import tkinter as tk
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gitgenie.app import GenieApp
from gitgenie.demo import create_demo


with tempfile.TemporaryDirectory(prefix="genie-ui-") as folder:
    repo = create_demo(Path(folder))
    root = tk.Tk()
    app = GenieApp(root, str(repo), None, None, demo=True)
    try:
        deadline = time.monotonic() + 15
        while app.snapshot is None and time.monotonic() < deadline:
            root.update()
            time.sleep(0.03)
        assert app.snapshot is not None, app.overlap_label.cget("text")
        assert "dev-2" in app.overlap_label.cget("text")
        assert "possible rebase conflict" in app.overlap_label.cget("text")
        assert "free shipping" in app.commit_subject.cget("text")
        app.show_details()
        root.update()
        assert app.details_window.winfo_exists()
        with patch("gitgenie.app.messagebox.showinfo"):
            app.copy_rebase()
        assert root.clipboard_get() == "git rebase -- 'main'"
        app.snooze()
        root.update()
        assert app.collapsed
        app.snooze_until = time.monotonic() - 1
        app.tick()
        root.update()
        assert not app.collapsed
        assert app.remote is None
        print("UI smoke passed: async scan, author alert, latest commit, details, copy, snooze/resume.")
    finally:
        root.destroy()
