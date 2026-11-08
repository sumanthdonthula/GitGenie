"""The floating desktop panel. All Git work runs outside the UI thread."""

from __future__ import annotations

import queue
import threading
import time
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog

from .core import Git, Snapshot, inspect
from .windows import foreground_is_editor_or_genie, work_area

BG = "#11131b"
CARD = "#1c202c"
TEXT = "#eff1fa"
MUTED = "#a2adc4"
PURPLE = "#b8a0ff"
GREEN = "#8cddb0"
AMBER = "#ffce83"
RED = "#ff9fa8"
SCAN_SECONDS = 10
FETCH_SECONDS = 300


class GenieApp:
    def __init__(self, root: tk.Tk, repo: str | None, base: str | None, remote: str | None, demo: bool = False):
        self.root, self.repo, self.base, self.remote = root, repo, base, remote
        self.demo = demo
        self.snapshot: Snapshot | None = None
        self.results: queue.Queue = queue.Queue()
        self.busy = False
        self.last_scan = 0.0
        self.last_fetch: float | None = None
        self.last_fetch_label = "not yet"
        self.generation = 0
        self.alert_key = None
        self.snooze_until = 0.0
        self.collapsed = False
        self.details_window: tk.Toplevel | None = None
        self.topmost: bool | None = None
        self.drag_origin: tuple[int, int, int, int] | None = None
        root.title("Git Genie · v0")
        root.configure(bg=BG)
        root.resizable(False, False)
        root.protocol("WM_DELETE_WINDOW", root.destroy)
        root.bind("<Escape>", lambda _event: self.toggle_compact())
        self._build()
        root.update_idletasks()
        left, top, right, bottom = work_area(root)
        width, height = root.winfo_reqwidth(), root.winfo_reqheight()
        root.geometry(f"+{max(left, right - width - 24)}+{max(top, bottom - height - 32)}")
        root.after(200, self.tick)

    def label(self, parent, text="", color=TEXT, size=10, bold=False, **kwargs):
        return tk.Label(parent, text=text, fg=color, bg=parent["bg"],
                        font=("Segoe UI", size, "bold" if bold else "normal"), **kwargs)

    def button(self, parent, text, command, primary=False):
        return tk.Button(parent, text=text, command=command, bg=PURPLE if primary else CARD,
                         fg=BG if primary else TEXT, activebackground="#cabbff" if primary else "#303747",
                         activeforeground=BG if primary else TEXT, relief="flat", borderwidth=0,
                         font=("Segoe UI", 9, "bold"), padx=12, pady=7, cursor="hand2",
                         highlightthickness=0, takefocus=True)

    def _build(self):
        shell = tk.Frame(self.root, bg=BG, padx=18, pady=14, width=430)
        shell.pack(fill="both", expand=True)
        header = tk.Frame(shell, bg=BG)
        header.pack(fill="x")
        self.logo = self.label(header, "✦  Git Genie", color=PURPLE, size=16, bold=True)
        self.logo.pack(side="left")
        self.logo.configure(cursor="fleur")
        self.logo.bind("<ButtonPress-1>", self.drag_start)
        self.logo.bind("<B1-Motion>", self.drag_move)
        self.button(header, "−", self.toggle_compact).pack(side="right")
        self.label(header, "v0 · LOCAL" if not self.remote else "v0 · REMOTE", color=MUTED, size=8).pack(side="right", padx=8)

        self.body = tk.Frame(shell, bg=BG)
        self.body.pack(fill="x")
        self.repo_label = self.label(self.body, "A little awareness. Fewer surprises.", color=MUTED, anchor="w", wraplength=380)
        self.repo_label.pack(fill="x", pady=(12, 8))
        self.branch_label = self.label(self.body, "Choose a repository to begin", size=12, bold=True, anchor="w", wraplength=380)
        self.branch_label.pack(fill="x")
        self.counts = self.label(self.body, "Local branches · no account needed", color=MUTED, anchor="w", wraplength=380, justify="left")
        self.counts.pack(fill="x", pady=(4, 12))

        commit_card = tk.Frame(self.body, bg=CARD, padx=12, pady=10)
        commit_card.pack(fill="x")
        self.label(commit_card, "LATEST COMMIT ON YOUR BRANCH", color=MUTED, size=8, bold=True).pack(anchor="w")
        self.commit_subject = self.label(commit_card, "Your last commit will appear here.", bold=True, wraplength=354, justify="left", anchor="w")
        self.commit_subject.pack(fill="x", pady=(5, 3))
        self.commit_meta = self.label(commit_card, "—", color=MUTED, size=9, wraplength=354, anchor="w")
        self.commit_meta.pack(fill="x")

        self.alert = self.label(self.body, "Ready when you are.", color=GREEN, size=11, bold=True,
                                wraplength=376, justify="left", anchor="w")
        self.alert.pack(fill="x", pady=(16, 6))
        self.overlap_label = self.label(self.body, "Choose a repo, or try the included local demo.", color=MUTED,
                                       wraplength=376, justify="left", anchor="w")
        self.overlap_label.pack(fill="x")
        self.incoming_label = self.label(self.body, "", color=MUTED, size=9, wraplength=376, justify="left", anchor="w")
        self.incoming_label.pack(fill="x", pady=(8, 0))

        actions = tk.Frame(self.body, bg=BG)
        actions.pack(fill="x", pady=(16, 0))
        self.check_button = self.button(actions, "Check now", self.check_now, primary=True)
        self.check_button.pack(side="left")
        self.button(actions, "Details", self.show_details).pack(side="left", padx=6)
        self.button(actions, "Snooze 15m", self.snooze).pack(side="right")
        choices = tk.Frame(self.body, bg=BG)
        choices.pack(fill="x", pady=(8, 0))
        self.button(choices, "Choose repo", self.choose_repo).pack(side="left")
        self.button(choices, "Compare branch", self.choose_base).pack(side="left", padx=6)

        self.footer = self.label(shell, "Local mode · checks every 10s · remote fetch off", color=MUTED, size=8, anchor="w", wraplength=380)
        self.footer.pack(fill="x", pady=(12, 0))
        # Keep a stable card width regardless of content length.
        spacer = tk.Frame(shell, bg=BG, width=390, height=1)
        spacer.pack()

    def drag_start(self, event):
        self.drag_origin = event.x_root, event.y_root, self.root.winfo_x(), self.root.winfo_y()

    def drag_move(self, event):
        if self.drag_origin:
            x, y, start_x, start_y = self.drag_origin
            self.root.geometry(f"+{max(0, start_x + event.x_root - x)}+{max(0, start_y + event.y_root - y)}")

    def toggle_compact(self):
        self.collapsed = not self.collapsed
        if self.collapsed:
            self.body.pack_forget()
        else:
            self.body.pack(fill="x", before=self.footer)

    def choose_repo(self):
        folder = filedialog.askdirectory(title="Choose a Git repository", parent=self.root)
        if folder:
            self.repo, self.base, self.demo = folder, None, False
            self.snapshot, self.alert_key, self.last_fetch = None, None, None
            self.generation += 1
            self.last_scan = 0
            self.repo_label.config(text=Path(folder).name)
            self.alert.config(text="Checking repository…", fg=MUTED)

    def choose_base(self):
        value = simpledialog.askstring("Compare against", "Local branch to compare with (for example main):",
                                       initialvalue=self.base or "main", parent=self.root)
        if value and value.strip():
            self.base = value.strip()
            self.generation += 1
            self.last_scan = 0

    def snooze(self):
        self.snooze_until = time.monotonic() + 15 * 60
        if not self.collapsed:
            self.toggle_compact()

    def check_now(self):
        if not self.repo:
            self.choose_repo()
        self.last_scan = 0

    def tick(self):
        now = time.monotonic()
        while not self.results.empty():
            generation, snapshot, error, fetch_error, fetched_at = self.results.get_nowait()
            self.busy = False
            self.check_button.config(state="normal", text="Check now")
            if generation != self.generation:
                continue
            if fetched_at is not None:
                self.last_fetch = fetched_at
                self.last_fetch_label = datetime.now().strftime("%H:%M") if not fetch_error else "failed; retry in 5m"
            if error:
                self.branch_label.config(text="Comparison unavailable")
                self.counts.config(text="Waiting for a successful check")
                self.commit_subject.config(text="—")
                self.commit_meta.config(text="")
                self.alert.config(text="Genie needs a quick check", fg=RED)
                self.overlap_label.config(text=error[:400])
                self.incoming_label.config(text="")
                self.snapshot = None
            else:
                self.render(snapshot)
            if fetch_error:
                self.incoming_label.config(text=f"Fetch failed; showing local data. {fetch_error[:180]}", fg=AMBER)
        if self.repo and not self.busy and now - self.last_scan >= SCAN_SECONDS:
            self.start_scan()
        try:
            on_top = foreground_is_editor_or_genie()
            if self.topmost != on_top:
                self.root.attributes("-topmost", on_top)
                self.topmost = on_top
        except OSError:
            pass
        if now < self.snooze_until:
            self.footer.config(text="Alerts snoozed · checks continue · expands when 15m ends")
        elif self.remote:
            remaining = max(0, int(FETCH_SECONDS - (now - (self.last_fetch or now))))
            self.footer.config(text=f"Scan 10s · {self.remote} fetch in {remaining // 60}:{remaining % 60:02d} · last {self.last_fetch_label}")
        else:
            self.footer.config(text="Local mode · checks every 10s · remote fetch off")
        if self.snooze_until and now >= self.snooze_until:
            self.snooze_until = 0
            if self.collapsed:
                self.toggle_compact()
        self.root.after(250, self.tick)

    def start_scan(self):
        self.busy, self.last_scan = True, time.monotonic()
        self.check_button.config(state="disabled", text="Checking…")
        generation, repo, base, remote = self.generation, self.repo, self.base, self.remote
        should_fetch = remote and (self.last_fetch is None or time.monotonic() - self.last_fetch >= FETCH_SECONDS)

        def work():
            error = fetch_error = None
            fetched_at = None
            snapshot = None
            if should_fetch:
                try:
                    Git(repo).fetch(remote)
                except Exception as exc:
                    fetch_error = str(exc)
                fetched_at = time.monotonic()
            try:
                snapshot = inspect(repo, base)
            except Exception as exc:
                error = str(exc)
            self.results.put((generation, snapshot, error, fetch_error, fetched_at))

        threading.Thread(target=work, daemon=True, name="gitgenie-check").start()

    def render(self, snapshot: Snapshot):
        self.snapshot = snapshot
        self.repo_label.config(text=f"{'DEMO · ' if self.demo else ''}{Path(snapshot.root).name}")
        self.branch_label.config(text=f"⑂  {snapshot.branch}")
        self.counts.config(text=f"vs {snapshot.base or '—'}  ·  {snapshot.ahead} ahead / {snapshot.behind} behind  ·  {snapshot.dirty_files} edited / {snapshot.untracked_files} new")
        if snapshot.latest:
            self.commit_subject.config(text=snapshot.latest.subject)
            self.commit_meta.config(text=f"{snapshot.latest.sha[:7]}  ·  {snapshot.latest.author}  ·  {snapshot.latest.date[:10]}")
        else:
            self.commit_subject.config(text="No commits yet")
            self.commit_meta.config(text="Create a commit to begin.")
        high_risk = any(o.kind != "same file" for o in snapshot.overlaps)
        self.alert.config(text=snapshot.message, fg=AMBER if snapshot.overlaps or snapshot.behind else GREEN)
        if snapshot.overlaps:
            lines = []
            for overlap in snapshot.overlaps[:3]:
                who = ", ".join(overlap.authors) or "Another contributor"
                lines.append(f"{who} changed {overlap.path}\n{overlap.kind.capitalize()} · {'possible rebase conflict' if overlap.kind != 'same file' else 'review suggested'}")
            if len(snapshot.overlaps) > 3:
                lines.append(f"+ {len(snapshot.overlaps) - 3} more in Details")
            self.overlap_label.config(text="\n\n".join(lines), fg=TEXT)
        else:
            self.overlap_label.config(text=f"{snapshot.changed_files} changed file(s) on your side. No overlapping edits found." if snapshot.base else "Select a comparison branch to continue.", fg=MUTED)
        if snapshot.incoming:
            latest = snapshot.incoming[0]
            self.incoming_label.config(text=f"LATEST ON {snapshot.base}\n{latest.sha[:7]} · {latest.author}: {latest.subject}", fg=MUTED)
        else:
            self.incoming_label.config(text="")
        if snapshot.alert_key != self.alert_key and (snapshot.overlaps or snapshot.behind):
            if time.monotonic() >= self.snooze_until:
                if self.collapsed:
                    self.toggle_compact()
                # Raise only while the editor or Genie is active; never take keyboard focus.
                if foreground_is_editor_or_genie():
                    self.root.lift()
                if high_risk and self.alert_key is not None:
                    self.root.bell()
        self.alert_key = snapshot.alert_key

    def show_details(self):
        snapshot = self.snapshot
        if snapshot is None:
            messagebox.showinfo("Git Genie", "Choose a repository and wait for the first check.", parent=self.root)
            return
        if self.details_window and self.details_window.winfo_exists():
            self.details_window.destroy()
        window = self.details_window = tk.Toplevel(self.root)
        window.title("Git Genie · comparison details")
        window.geometry("760x620")
        window.configure(bg=BG)
        window.transient(self.root)
        toolbar = tk.Frame(window, bg=BG, padx=16, pady=10)
        toolbar.pack(fill="x")
        self.label(toolbar, "Comparison snapshot", color=PURPLE, size=14, bold=True).pack(side="left")
        self.button(toolbar, "Copy rebase command", self.copy_rebase).pack(side="right")
        container = tk.Frame(window, bg=BG)
        container.pack(fill="both", expand=True, padx=16, pady=(0, 16))
        scrollbar = tk.Scrollbar(container)
        scrollbar.pack(side="right", fill="y")
        text = tk.Text(container, bg=CARD, fg=TEXT, insertbackground=TEXT, relief="flat", wrap="word",
                       font=("Consolas", 10), padx=14, pady=14, yscrollcommand=scrollbar.set)
        text.pack(fill="both", expand=True)
        scrollbar.config(command=text.yview)
        sections = [f"REPOSITORY\n{snapshot.root}\n\n{snapshot.branch} → {snapshot.base or 'none'}",
                    f"{snapshot.ahead} ahead · {snapshot.behind} behind\n{snapshot.dirty_files} edited · {snapshot.untracked_files} untracked",
                    f"ASSESSMENT\n{snapshot.message}\n\nThese are line/file overlap signals, not a simulated merge.\nDifferent-line edits may still conflict semantically.\nUntracked files are checked for path collisions. Renames are\ntreated as a deletion and an addition."]
        if snapshot.latest:
            c = snapshot.latest
            sections.append(f"LATEST COMMIT ON YOUR BRANCH\n{c.sha}\n{c.author} · {c.date}\n{c.subject}")
        if snapshot.incoming:
            sections.append("COMMITS ON COMPARISON BRANCH (latest 12)\n" + "\n".join(f"{c.sha[:7]} · {c.author} · {c.subject}" for c in snapshot.incoming))
        for overlap in snapshot.overlaps:
            sections.append(f"{overlap.path}\nSignal: {overlap.kind}\nAuthors: {', '.join(overlap.authors)}\n" + "\n".join(f"  {c.sha[:7]} {c.author}: {c.subject}" for c in overlap.commits))
        sections.append("YOUR CHANGES SINCE THE SHARED ANCESTOR\n" + (snapshot.diff or "No tracked working-tree changes."))
        sections.append("NEXT STEP\nReview the changes and commit or stash your edits before\nrebasing. The copy button only copies a command; run it\nyourself after review. No commands are executed by this view.")
        text.insert("1.0", "\n\n────────────────────────────────────────\n\n".join(sections))
        text.config(state="disabled")

    def copy_rebase(self):
        if self.snapshot and self.snapshot.base:
            self.root.clipboard_clear()
            # PowerShell single quoting also handles metacharacters in valid refs.
            quoted = "'" + self.snapshot.base.replace("'", "''") + "'"
            self.root.clipboard_append(f"git rebase -- {quoted}")
            messagebox.showinfo("Copied", "Rebase command copied. Review your changes and commit or stash before running it.", parent=self.details_window)
