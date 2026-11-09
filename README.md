# Git Genie

<img src="vscode-extension/media/icon.png" alt="Git Genie and its golden lamp" width="112" align="right">

**Catch overlapping changes early. Pull and rebase with one click.**

Git Genie is an animated Git companion inside VS Code. A golden lamp lives in your Activity Bar; rub it and a genie appears through smoke with your branch status, latest commit, and a heads-up when a teammate changes the same files or lines.

Core Git monitoring needs no AI service, Genie account, or Python installation. Optional Claude reviews use your existing signed-in Claude Code CLI to suggest Git and commit improvements after pushes.

## What is this?

Git Genie watches the repository you are working in and compares your branch with a selected base, usually `origin/main`. It shows:

- Your current branch, latest commit, author, and ahead/behind counts.
- Incoming commits on the comparison branch.
- Who changed overlapping files, with separate signals for same-line edits, same-file edits, and file collisions.
- Staged and unstaged edits, including untracked paths that collide with incoming files.

Click the lamp for the animation, or let a new overlap summon your genie automatically. Repeated checks of the same result do not keep interrupting you.

## Why is this useful to me?

You should not need to repeatedly pull main just to discover whether a teammate touched the code you are editing. Genie fetches remote updates on startup and every **30 seconds**, then checks your branch every **10 seconds** and shortly after saves. Fetching updates your view of the remote without changing your local branch or working files.

For example, you add free shipping while dev-2 changes the shipping fee. Genie points out that both changes touch the same calculation before you try to integrate them. When you are ready, click **Pull & Rebase** instead of manually pulling the base branch and rebasing your feature branch.

It helps you stay aware, choose when to sync, and understand which files need attention while keeping Git decisions in your hands.

## Add Git Genie to VS Code

You need **VS Code 1.85+** and **Git 2.38+**. Existing Git authentication must work for remote fetches. This is a VSIX installation; the extension is not published on the Marketplace yet.

1. Download [`git-genie-0.4.0.vsix`](artifacts/git-genie-0.4.0.vsix). On GitHub, use the file's **Download raw file** control.
2. Open VS Code and press **Ctrl+Shift+P** (or **Cmd+Shift+P** on macOS).
3. Run **Extensions: Install from VSIX…** and select the downloaded file.
4. If VS Code asks, run **Developer: Reload Window**.
5. Open a Git project, trust that workspace if appropriate, and click the **lamp** in the Activity Bar.

From a local checkout, you can also double-click `Install-Extension.cmd` on Windows or run:

```powershell
code --install-extension ./artifacts/git-genie-0.4.0.vsix
```

The companion opens on its first activation. You can summon it any time with **Git Genie: Rub the Lamp** from the Command Palette or **Genie** in the status bar. To put it on the right, right-click **Your Genie** and move the view to the **Secondary Side Bar**.

## Your everyday workflow

1. Open your repository and keep coding on your branch.
2. Genie fetches and checks in the background. Its panel shows new incoming changes and possible overlaps.
3. Use **Compare branch** to select another local or remote tracking branch, or **Choose repo** to switch repositories.
4. Review **Details** when you want the relevant commits and assessment.
5. Commit or stash unfinished work, then click **Pull & Rebase** when ready to sync.

You do not need to pull or rebase repeatedly just to keep the alerts current. Background monitoring never starts a rebase. Rebasing happens only when you click the button or run the corresponding command.

## How Pull & Rebase works

The button displays its target, such as **onto origin/main**. Clicking it:

1. Checks that your workspace is trusted, open files are saved, a branch is checked out, and no other Git operation is in progress.
2. Requires a clean working tree, including staged, unstaged, and untracked files. Commit or stash them yourself; Genie does not auto-stash.
3. Fetches the remote version of your selected comparison branch. A local `main` normally maps to `origin/main`; a configured upstream or **Git Genie: Remote** setting can select another remote.
4. Confirms you have not switched branches or changed HEAD during the fetch.
5. Saves the original commit under a local `refs/gitgenie/backups/…` reference, then rebases your current branch onto the fetched commit while preserving merge topology.

You do not need to check out or update local main first. For example, with `feature/free-shipping` checked out and `main` selected, Genie fetches `origin/main` and rebases **feature/free-shipping** onto it. It leaves local main alone.

If Git reports conflicts, the rebase pauses. Resolve the files in VS Code's Source Control view, stage the resolutions, and click **Continue Rebase**. Or click **Abort Rebase** to restore the pre-rebase branch. Rebase details and the backup reference appear in **Output → Git Genie**. These controls also detect a rebase paused outside Genie.

Rebasing can change local commit IDs. Genie does not push, force-push, auto-resolve conflicts, or discard your edits. [Git's rebase documentation](https://git-scm.com/docs/git-rebase) explains the underlying operation.

## Claude suggestions after pushes

Enable **Claude reviews** in the companion or run **Git Genie: Enable Claude Reviews**. With a recent, signed-in Claude CLI, Genie reads committed `docs/git/` and contribution guidelines, then reviews detected pushes for Git practices, commit messages, and useful follow-up changes. Reports cite their sources; suggestions are advisory. You can also run **Git Genie: Review with Claude** manually.

This is opt-in: committed diffs, messages and guidelines are sent through your Claude account and use its plan/API billing. Optional HTTPS reference documents are configured in User settings. Push detection watches the selected repository's remote-tracking reflogs while VS Code is open; no-op and tag-only pushes are excluded. See [setup, settings and limits](docs/CLAUDE-REVIEWS.md).

## Controls and preferences

| Control | What it does |
| --- | --- |
| Lamp / Rub the Lamp | Bounce the lamp and summon the genie through smoke |
| Check changes | Recheck the repository immediately |
| Pull & Rebase | Fetch the displayed remote base and rebase your current branch |
| Continue / Abort Rebase | Finish a resolved rebase or restore its starting state |
| Details | Open the assessment and relevant commits in an editor tab |
| Snooze | Pause automatic reveals for 15 minutes; checks continue |
| See the genie in action | Show clearly labeled sample data without changing a repository |

| Setting | Default | Purpose |
| --- | --- | --- |
| `gitgenie.baseBranch` | Automatic | Prefer the configured remote's main/master, then local main/master |
| `gitgenie.remote` | `origin` | Remote used for background fetching and branches without a remote upstream |
| `gitgenie.autoFetch` | `true` | Fetch on startup and every 30 seconds; disable for offline use |
| `gitgenie.autoReveal` | `true` | Reveal the genie when a new overlap appears |
| `gitgenie.animations` | `true` | Animate the lamp, smoke, and genie; system reduced-motion preferences also apply |

With no remote configured, Genie still compares local branches. Pull & Rebase stays unavailable until a remote target can be determined. In Restricted Mode, the lamp and sample demo work; Git monitoring and history-changing actions wait for Workspace Trust.

## What should I know?

- An overlap is a deterministic signal, not a guarantee that Git will conflict. Different lines can still conflict semantically.
- Genie compares with one selected base, not every teammate's branch. Authors come from commits visible in that base.
- Unsaved editor buffers are excluded from monitoring and block Pull & Rebase until saved.
- Renames are treated as deletion plus addition. Identical final changes are not flagged as overlaps.
- The panel includes the latest 12 incoming commits and up to 8 attributed commits per overlapping file.
- Analysis commands have 20-second timeouts, fetches 90 seconds, and rebase actions 120 seconds. Large repositories or slow fetches can delay checks; scans and sync actions do not run concurrently.
- Failed fetches keep cached results available. Authentication, signing, or repository hooks may require attention through your existing Git setup.

## Build and test

To build from source, install Node.js 22.14+ and run:

```powershell
git clone https://github.com/sumanthdonthula/GitGenie.git
cd GitGenie/vscode-extension
npm ci
npm test
npm run package
```

The package is written to `artifacts/git-genie-0.4.0.vsix` in the repository root. Runtime code uses only VS Code and Node built-ins; npm dependencies are development tools. Open the root project and launch **Git Genie Extension** from Run and Debug for an Extension Development Host.

Additional checks are available with `npm run test:webview` and `npm run test:host`. The UI harnesses currently use locally installed Chrome and VS Code on Windows. Git integration tests use disposable repositories and local bare remotes, including successful sync, dirty-tree rejection, conflict continuation/abort, and failed fetches.

To run the local two-developer simulation, use `node scripts/Run-Real-Git-Simulation.js` from the root with the extension installed. It creates a new sample project and dev-2 worktree under `simulations/`, then tests automatic overlap detection. Results go to `artifacts/real-git-simulation-results.md` and `.json`. No real remote is needed for this simulation.

The original standalone Python prototype remains available; see [desktop prototype instructions](docs/DESKTOP.md).
