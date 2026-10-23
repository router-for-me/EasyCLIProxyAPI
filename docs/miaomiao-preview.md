# Miaomiao Preview

Download: https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/miaomiao-preview

Only non-draft, open PRs authored by `Roomen` and targeting `miaomiao`
are automatically merged. The `Build portable releases` PR workflow must
complete successfully for the current PR head, including all six platform
builds. The merge uses the exact tested head SHA and obeys GitHub branch
protection and conflict checks. Other authors and target branches are ignored.
Draft-to-ready and PR edits trigger another PR build so eligibility is checked
again. Fork builds may require GitHub's normal workflow approval first.

After merging, the workflow explicitly builds the merged commit, because
merges made with GITHUB_TOKEN do not trigger a separate push workflow.
Direct pushes to `miaomiao` also build previews. To retry a preview manually,
run `Miaomiao preview` with the `miaomiao` branch selected.

All six builds must pass before publication. Publication is skipped if the
source commit is no longer the current branch head. The fixed prerelease
`miaomiao-preview`, titled `Miaomiao Preview`, is updated with versioned
Windows, Linux and macOS packages for amd64 and aarch64. macOS previews
use the existing signing and notarization configuration. New packages are
uploaded before old assets are removed. This release never becomes Latest.
After automatic merging and successful publication, a PR comment links to
the rolling download page. Later builds replace its packages.

Both `main` (the default branch, which receives workflow_run events) and
`miaomiao` must retain these workflow changes. Resetting either branch to
another branch without these files can disable the automation again.
No repository-wide GitHub auto-merge toggle or personal access token is needed.

Validation: `bun test tests/miaomiaoPreview.test.ts`.
