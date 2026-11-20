# The setup a PR is judged against

- One user, phone-first. Ultimate is evaluated as a daily driver replacing another coding agent.
- Several projects run as systemd units (`ultimate@<path>.service`) on one Linux box, reached from the phone over a
  Tailscale tailnet. No Cloudflare, no multi-user access.
- Models: claude-code (Opus for @ultimate, Sonnet for coordinators and workers) on a Claude Max subscription; Ollama
  Cloud for reviewers, scouts and watchers; a ChatGPT free login only for voice transcription. Never openai-codex, no
  Google or other paid API keys.
- Heavy use of: branches and coordinators, the lander (checks, then push to the fork), voice, the Docs viewer, the
  Plans and project-bar (project-rail) personal extensions, keep-warm with pre-cold compaction, dreams and memory.
- Cost-conscious: fewer model calls, cheaper reviews and less prompt-cache churn are worth a lot.
- The fork carries local changes and merges upstream (HazAT/ultimate) often. Standing rule: avoid local edits to files
  upstream churns. A PR that is likely to merge upstream anyway is better waited for than cherry-picked.
- Local features already carried: pause, smart-merge updates, messages routing and quiet replies, ChatGPT voice login,
  a bubblewrap sandbox, Docs, project-rail.
- Personal features live in `~/.ultimate/extensions`, not in the clone.
- Not used: Shopify or company setups, Windows or macOS specifics, Google models, MCP-heavy workflows, several users.
