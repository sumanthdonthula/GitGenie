# Claude reviews after pushes

Git Genie can ask a signed-in Claude Code CLI for advisory Git, commit-message,
documentation and follow-up suggestions. Core overlap monitoring works without it.

## Enable

1. Install a recent Claude Code CLI supporting `--safe-mode`. Run `claude auth
   login` once on the developer's system and confirm `claude auth status` succeeds.
2. Install Git Genie 0.4.0, open a trusted repository, and click **Enable Claude
   reviews**, or run **Git Genie: Enable Claude Reviews**.
3. Keep the repository selected in Genie and push as usual from VS Code or a
   terminal. Suggestions appear after the next check (normally within 10 seconds,
   plus reference-download and Claude response time).
4. Click **View suggestions** to open the report. **Review with Claude** manually
   reviews the latest committed HEAD, useful before a push or to retry a failure.

This uses the CLI's existing authentication, model and applicable plan/API billing.
Git Genie never reads or copies login tokens and does not require a separate API
key. The extension invokes Claude's noninteractive API mode, rather than making
direct HTTP calls with subscription credentials.

## Documentation and context

Each review reads `docs/git/` recursively, root `CONTRIBUTING` (`.md`, `.txt`,
`.rst` or no extension), `.github/CONTRIBUTING.md`, and `.gitmessage`/`.gitmessage.txt`
from the **reviewed commit**. Folder documents can be Markdown, text, reStructuredText
or AsciiDoc. Configure `gitgenie.claude.docFolders` for additional repo-relative
folders. Uncommitted edits, symlinks, submodules, and untracked documents are excluded.

For subsequent pushes to a tracked branch, commit messages and the combined diff
since the common ancestor of the previous pushed tip are included. Force pushes
use that common ancestor rather than assuming the old tip is an ancestor. If the
old tip is unavailable or unrelated, the review falls back to the last commit.
First pushes and manual reviews include only the latest commit; they do not claim
to review the entire new branch. A push of merge history can include commits from
other authors; attribution comes from the provided commit IDs.

Optional `gitgenie.claude.referenceUrls` fetches up to four user-selected HTTPS
text/HTML reference documents. For example, add `https://git-scm.com/docs/git-commit`
for Git's commit reference. URLs must return a document directly; redirects are
not followed. Downloads time out after 10 seconds, are limited to 512 KB each,
and successful results are cached in memory for 24 hours. Unavailable sources are
listed in report limitations; local policy review can still proceed. Repository
policies take priority over external guidance. Conventional Commits is not required
unless your repository explicitly adopts it. The feature does not crawl the web
or follow links found in repository documents.

Context is bounded: at most 20 commit messages (12,000 characters), a 24,000-character
patch, and 16 local documents (12,000 characters each, 32,000 total). Local documents
larger than 256 KB are skipped. Each external document contributes at most 12,000
characters. Truncation and exclusions are disclosed in the context/report.

## Push detection and behavior

Git Genie polls the **selected repository's remote-tracking reflogs** for Git's
`update by push` entries. This supports pushes made from VS Code and terminals,
without installing hooks or wrapping `git push`. Fetch entries never trigger
reviews. A baseline is established when enabling, selecting a repository, changing
Claude settings or restarting the extension; historical pushes are not replayed.
Each detected ref update is queued, even if another review is running. Only one
Claude process runs per active review queue. The panel retains the latest report;
open reports remain in editor tabs.

Detection requires Git remote-tracking reflogs and a remote refspec that maps the
pushed branch. It does not detect no-op pushes, tag-only pushes, deletions, pushes
to unmapped remotes/URLs, or pushes while the repository is not being watched.
Only the latest 100 reflog entries per ref are examined per check. Updating several
branch refs in one push produces one review per ref. Detection happens after the
push succeeds; suggestions never block a push. Already shared commits should
normally get follow-up fixes rather than a history rewrite for message formatting.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `gitgenie.claude.enabled` | `false` | Opt in to sending context through Claude |
| `gitgenie.claude.onPush` | `true` | Automatic review of detected pushes |
| `gitgenie.claude.command` | `claude` | Native executable or npm `cli.js` path |
| `gitgenie.claude.docFolders` | `["docs/git"]` | Committed guideline folders |
| `gitgenie.claude.referenceUrls` | `[]` | Optional external HTTPS documents |
| `gitgenie.claude.timeoutSeconds` | `90` | CLI timeout, between 10 and 300 seconds |

Enablement, executable, reference URLs and timeout are machine settings; a
repository's `.vscode/settings.json` cannot silently enable sending content or
choose an executable/reference endpoint. Use User/Remote settings for these.
The native installer is preferred. Windows npm installations are discovered via
their `node_modules/@anthropic-ai/claude-code/cli.js` entrypoint on PATH; an explicit
path to that file also works. Shell commands, arguments, `.cmd`, `.bat` and `.ps1`
wrappers are not accepted.

## Advisory access

Selected committed code, commit messages and guidelines leave the machine through
the developer's configured Claude service when reviews are enabled. Use this only
for repositories your account is permitted to send. Requests for external reference
documents also go to their configured hosts.

The CLI runs in an empty temporary working directory with `--safe-mode`, no built-in
or MCP tools, no session persistence, and a dedicated review prompt. No repository
hooks, local Claude customizations or repository MCP servers are loaded. Managed
Claude policy still applies. Git Genie never auto-applies suggestions, rewrites
messages, commits, rebases or pushes because of a review. Reports are opened as
plain text so model output cannot create clickable commands or execute HTML.

Changing repositories/settings or unloading the extension cancels active reviews
and discards queued work and stale results. Failures remain visible in the panel;
use **Review with Claude** to retry after checking CLI installation, authentication
or account limits. The extension does not automatically retry failed paid requests.

See the official [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
and [programmatic usage guide](https://code.claude.com/docs/en/headless).
