# Git and commit guidance for Git Genie

Use these guidelines when contributing to this repository. Claude suggestions
should cite the relevant guidance and distinguish required behavior from advice.

- Keep commits focused on a coherent change. Write a concise, imperative subject
  describing what the change does. Use the body to explain motivation or a tradeoff
  when the diff alone is insufficient. A `feat:`, `fix:` or `docs:` prefix is useful
  but Conventional Commits is not mandatory here.
- Add or update meaningful tests for changed Git operations, subprocess handling,
  external-service integration and user-visible state. Keep tests independent of
  real credentials and paid services. Small reversible documentation and visual
  changes do not need tests that merely repeat the implementation.
- Update user documentation when commands, installation, settings or workflow
  behavior changes. Describe material limits accurately.
- Do not commit credentials, tokens, `.env` secrets or personal repository data.
  Keep remote actions explicit and preserve user work.
- Once commits have been pushed, prefer follow-up commits. Do not amend, rebase
  or force-push shared history merely to satisfy commit-message style advice.

References for optional background reading:

- [Git commit reference](https://git-scm.com/docs/git-commit)
- [Contributing patches to Git](https://git-scm.com/docs/SubmittingPatches)
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)

Links here are references for humans; the advisor only downloads URLs explicitly
configured in the developer's `gitgenie.claude.referenceUrls` setting.
