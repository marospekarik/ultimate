Pause the whole Ultimate host and continue it with Play. This is a soft pause: running work (a bash call, a model response) finishes on its own, nothing new starts after it, and messages you send meanwhile queue until Play. Nothing is killed and no stream is aborted.

## How it works

- **Pause** (`pause`, user-only) holds Pi Durable's task scheduler (`harness.hold()`, from the patch in `patches/@earendil-works__pi-durable@1.3.0.patch`). A running task invocation finishes its current phase and parks as `pending`; no task is reserved until Play. Abort handlers still run, so Stop works while paused. `harness.inspect()` reports `scheduling: 'paused'`.
- The pause is stored in the root's `pause.state` document (`{ paused, since, runs, limit, held }`) and survives a restart: the `onOpen` callback holds the scheduler again before the server resumes scheduling.
- **Play** (`play`, user-only) leaves one note on each conversation that was mid-turn when paused and still has its run: a `pause.note` write ("Paused for 2h 14m; the run continued after Play."), placed at the run's next step. Its request ID is the pause's start, so a retried Play leaves no second note. Idle conversations get none. Then the scheduler is released.
- `state` returns `{ paused, since, limit, held, running }`: the foreground tasks still running, each with its conversation, what it runs (`model response` or the tool's name) and when it started. Background waiters (subagent reporters, automation schedulers, Messages deliveries) never count.

## An extension's hold

`PauseApi` (`api.ts`) gives other extensions `hold({ source, reason, until? })`: the extension that holds the host, by name (its own, e.g. `guard`), and one short line saying why. It records the same pause document a manual Pause does, so the status line reads `⏸ Paused · guard` and its popover the reason, and Play (the status line's, ⌘K's, or the popover's) continues as usual. The Play note on each held run names it too: "Paused for 12m (guard: the day's spend passed $5.00); the run continued after Play."

- A hold on a host that is already paused joins that pause: it changes neither its start nor the explanation already shown (the first rate limit or hold explains it), so holding again after each spend check adds nothing. Only a new pause after a Play starts a new start.
- Like a pause it is soft: running tasks finish, nothing new starts, and messages queue until Play.
- **`until`** (ms) is when what the hold waits for ends by itself, such as a usage window's reset. The pause then plays by itself 2 minutes after it (so the first request lands in the new window even when clocks differ), with the same timer, `pause.autoplay` divider and "played by itself" run notes as a rate limit's. The status line reads `⏸ Paused · plans · until 14:07`, and its popover "plays by itself at 14:07 (in 1h 3m), or press Play". It plays only once every cause has an end, at the latest of them (a later `until` joining a timed hold moves its end): a Pause the user pressed, a hold without `until`, or a rate limit without **Play by itself** joining it waits for Play. While only such holds keep the host paused, `heldSince()` returns the pause's start, so a timer that keeps something warm for the resume may run (keep-warm's cache ping); it is undefined otherwise.
- A hold without `until` never plays by itself, like a pause the user pressed; `pause`, `play` and `autoPlay` stay the user's alone, so no agent unpauses into a rate limit or out of a spend cap.

## Rate limits

A model answer that is a rate limit Pi retries (HTTP 429, "rate limit", "too many requests": `lib/rate-limit.ts`) pauses the host by itself, the first time, whichever provider sent it. Quota, usage-limit and billing errors are on Pi's no-retry list: they end the run at once, so they fail as usual instead, with nothing for Play to continue. A weekly usage limit (Ollama Cloud's "weekly usage limit") never pauses either: it resets days later, so the run fails after Pi's quick retries and the watchdog tells its owner to switch the agent to another provider's model. Retrying sooner only hits the limit again, so it stays paused until the user says so:

- The extension watches commits for assistant error entries. On the first rate-limited one it holds the scheduler at once, inside that commit's publication, before Pi's own retry backoff (2 s) can fire, then records the pause with `limit` (`{ provider, model, error, at, conversationId }`), also into a pause the user started. If that commit fails, it releases the hold again rather than hold work with nothing showing Play.
- Pi has already scheduled that generation's retry, so the run is not failed: it sleeps in its `retry` phase, held. Every other run parks at its next step; requests already in flight that get their own 429 park the same way and add no second pause.
- @ultimate gets one `pause.limit` card: the provider, the upstream message, where it first hit, and Play while this pause holds. It is a write of only kind and data, which Pi appends at once even while @ultimate's own run is held, and it starts no run; reopening a paused host writes it if a crash lost it. The models learn of the limit from the Play note on each held run: "Paused for 12m (claude-code rate limited claude-opus-5-5); the run continued after Play."
- When the limit hit a subagent whose parent is mid-turn, the parent gets one `pause.held` entry naming the child ("#468 hit anthropic’s rate limit · Ultimate paused until Play"): only kind and data, so it shows at once while the parent is held and wakes nobody. Its request ID is the child's run, so a Play that pauses again into the same limit adds none.
- By default it never resumes by itself; neither the claude-code nor the anthropic 429 carries a reset time. **Play by itself** (user-only `autoPlay {minutes}`, 1–1440, `null` off; the checkbox in the popover, off by default) checks every that many minutes whether the limit still holds, and presses Play once it does not:
  - A check is one short question to the limited provider and model ("Reply with OK.", 16 tokens at most, no prompt cache), sent from a timer outside the scheduler, so the held runs keep every retry they had. A refused check costs no tokens (the 429 answers report zero usage); on claude-code it starts the `claude` CLI once.
  - Refused (or any other error): the host stays paused and the pause document counts it (`checks: { count, at }`); the next check is that many minutes after it. Nothing is written to any transcript.
  - Answered: Play, with a `pause.autoplay` divider in @ultimate's transcript (how long after the limit, at which check) and run notes that say "played by itself".
  - Still refused six hours after the limit: it stops checking (`gaveUp`) and stays paused, and @ultimate gets one `pause.gave-up` card (kind and data only, no run) with Play. Only the user's Play continues it then.
  - The timer is re-armed from the pause document on open. A pause the user pressed, also one a limit joins later, sets `manual` and is never checked: it always waits for them, and so does the user's own Play, which plays at once without a check.
- Play continues each held run where it stopped, through Pi's retry, on the model its agent has by then, so switching an agent's model while paused takes effect on Play. Every held run resumes at once, each rebuilding its prompt cache after a long limit. A Play while the limit still holds spends one of Pi's retries (3 per generation) and pauses again with a new start.
- When the limit outlasts those retries, that run fails and the host does not pause again: Pi commits that answer with its generation ended, not sleeping in a retry, so holding would continue nothing and only delay the failure's report. The watchdog treats the failure as not temporary: it reports once to the parent (or @ultimate), with a hint to resume the conversation once the limit resets, and never re-prompts into the limit.

## Timers outside the scheduler

Automation fires are scheduler tasks, so the hold stops them. Timers that start work outside the scheduler `want` `PauseApi` (`api.ts`) and skip while `paused()`:

- the updater's background fetch (`update`);
- cloud backups (`cloud`): **Back up now** refuses with "Ultimate is paused; press Play first".

## UI

- Status line: a quiet `⏸ Pause`; while work still runs `⏳ Pausing… 3 tasks running` (amber), its popover listing each task with its conversation, what it runs and its age; then `⏸ Paused · safe` with `▶ Play` next to it. A rate limit shows `⏸ Rate limited · claude-code`, with `· next check 10:27` while Play by itself checks, its popover the provider, model, upstream message, the next check and the last refused one; an extension's hold shows `⏸ Paused · guard`, its popover headed `Held by guard` with the reason. A pause that plays by itself adds its time: `· until 14:07` (the source is hidden on a phone, the time is not).
- Under the composer while paused: `Paused — your message runs on Play`.
- ⌘K: **Pause** and **Play**.
- The Play note shows as one amber divider in the transcript.
