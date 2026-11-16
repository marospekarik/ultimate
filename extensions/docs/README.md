A read-only Docs app for any repository: every git-tracked Markdown file rendered with Ultimate's own Markdown renderer, plus the project's reports, with comments you send to @ultimate or a branch.

## What it does

- **Surface `Docs`** (title bar, or ⌘K → Open Docs): the files on the left, grouped by folder (Reports first, then root docs, then alphabetically), with a filter; the doc in the middle, its YAML frontmatter as a card above the body; the agent docked on the right. On a phone the file list is a drawer behind the list button in the header, and below desktop width the agent dock is left out (reach the agent from the title bar). Tables and code highlight as in messages.
- **Links.** `?doc=<path>` opens a doc. A Markdown link to a repo `.md` file opens it in Docs. Inside a doc, relative links resolve against the doc's folder. In a chat message, write the link with a leading slash, e.g. `[name](/docs/name.md)` — a plain relative link like `[name](docs/name.md)` is blocked by Streamdown's hardening and renders as "[blocked]". File paths in backticks are inline code and stay as they are.
- **Comments.** Select text and click **Comment** (on touch, **Comment on selection** at the foot of the screen), or **Comment on doc** for the doc as a whole. Pending comments are kept per doc in durable UI state until sent. **Send (N)** posts one `docs.comments` input to the conversation the **to** picker names (default @ultimate). It steers a busy recipient like a typed message. The recipient sees a card on the user's side; the model reads each comment with its heading and quote, and is told to read the doc (for a report, at its absolute path).

## Reports

Long one-off output (a setup manual, an investigation, a runbook for one machine) goes to the project's reports folder instead of a chat message or the repo, and the chat gets a short summary with a link.

- **Folder:** `~/.ultimate/reports/<name>-<hash>/`, named exactly like the project's state home `~/.ultimate/projects/<name>-<hash>/` (the folder Ultimate keeps the project's `state.sqlite` in). Two projects with the same folder name never share one. It is outside every repo, so never in git.
- **Writing:** an agent writes a report with the normal `write` tool, directly in that folder (no subfolders): `YYYY-MM-DD-<slug>.md`, the date it was written and a short lowercase slug, e.g. `2026-11-16-hub-ct.md`.
- **Linking:** in chat, `[Hub CT manual](/.reports/2026-11-16-hub-ct.md)`. The `/.reports/` prefix starts with a dot, and the repo list never shows a path with a dot segment, so a report link can never mean a repo file. After Keep, the same link still opens the report from `archive/`.
- **Docs:** a **Reports** section at the top of the file list, newest first, each with the days it has left; kept reports below under **Reports · kept**. With none yet, the section names the folder. Reports render and take comments like repo docs.
- **Retention:** a report is deleted 30 days after it was last written. **Keep** (in the doc's bar) moves it to `archive/` in the same folder, which is never deleted.
- **Sweep:** each project's host sweeps its own folder when it opens and every 24 hours after. One host serves one project home, so no two hosts sweep the same folder; a project whose host is not running is swept when it next opens.

## Actions

- `list` → every tracked `*.md` path, sorted.
- `reports` → `{ folder, reports }`: the folder (`~/.ultimate/reports/<name>-<hash>/`) and its reports, `{ path, size, modified, archived, expires? }`, newest first, then `archive/`'s.
- `read { path }` → `{ status: 'ok', path, frontmatter, body, size, modified }`, or `missing` (not tracked, gone, or a report that does not exist) / `tooLarge` (over 1 MB). The surface shows `Not found: <path>` for a missing doc; it never falls back to another doc. `path` is one of `list`'s, or a report's `.reports/<name>.md` / `.reports/archive/<name>.md`.
- `send { conversation, path, comments, note? }`, **user only**: at most 50 comments, each up to 4,000 characters with a quote up to 1,000.
- `keep { path }`, **user only**: moves a report into `archive/` and returns its new path.
- `sweep` → `{ deleted }`: deletes the reports last written over 30 days ago, as the daily sweep does.

## What it never shows or does

- **Repo docs: only `git ls-files '*.md'` from the project root.** Untracked and ignored files (`.env.local`) never appear. No path with a segment starting with `.` appears either (`.env*`, `.claude/`, `.ultimate/`). If the project is not a git repo, the list is empty.
- **`read` of a repo doc accepts only a path that `list` returned.** It then checks that the real path is the same regular file inside the project root, so a tracked symlink is refused.
- **It writes no repo file.** Audit: `rg -n "writeFile|rm\(|unlink|rename" extensions/docs --glob '!test'` finds only the report writes below, in `keep` and `sweep`.
- **Reports are the one exception, and only inside the reports folder.** It reads only regular `.md` files directly in the folder or in its `archive/`; it refuses symlinks, folders, names starting with `.`, and any path whose real path is not that file inside the folder. Its only writes are `keep` (user only: creates `archive/` if needed and `rename`s the report into it, never over an existing file) and the sweep (`unlink` of a top-level report over 30 days old; never `archive/`, never anything but `.md`).
