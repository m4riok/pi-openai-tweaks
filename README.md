# pi-openai-tweaks

A simple Pi extension that gives you:

- clear OpenAI/Codex usage in your status line (`/usage`)
- one-command Fast mode control (`/fast`)
- optional preventive compaction for long agent loops (`/autocompact`)

## Install

From npm:

```bash
pi install npm:@m4riok/pi-openai-tweaks
```

## What this extension provides

### 1) Usage status

Shows 7d usage with reset countdowns in the footer/status line. The 5h window is hidden by default.

You can control:

- format (`default` or `compact`)
- show/hide 5h usage
- show/hide weekly usage
- percentage mode (`remaining` or `used`)
- refresh mode (`turn` updates or background polling)

Use:

```text
/usage
```

This opens a settings-style menu where changes are saved automatically.

Quick commands also work:

```text
/usage refresh
/usage format default
/usage format compact
/usage 5h on
/usage 5h off
/usage weekly on
/usage weekly off
/usage percent remaining
/usage percent used
/usage update turn
/usage update poll
```

### 2) Continuous-loop auto-compaction

Use `/autocompact` to configure preventive context compaction during long-running agent loops.

Defaults:

- disabled
- trigger at 90% of Pi's active-model context-window limit

The trigger can be set from 50% through 99% in 1% steps. Percentages use Pi's `contextWindow` metadata for the active model, so the token threshold updates automatically after a model switch. When enabled, the extension checks usage after each model-response/tool batch. At the threshold it interrupts the active loop, compacts context, and starts a continuation turn when unfinished tool-driven work remains.

Settings persist under `piOpenaiTweaks.autoCompact` in `~/.pi/agent/settings.json`.

```text
/autocompact
/autocompact on
/autocompact off
/autocompact status
/autocompact threshold
/autocompact threshold 90
```

### 3) Fast mode

Use `/fast` to control OpenAI Codex Fast mode.

When active and eligible, requests include:

- `service_tier: "priority"`

Supported commands:

```text
/fast
/fast on
/fast off
/fast auto
/fast status
```

Notes:

- Fast mode is blocked on unsupported model/provider/auth combinations.
- Session starts in `auto` mode, which follows `openai-fast.json` defaults if present.

Fast config file locations:

- Global: `~/.pi/agent/extensions/openai-fast.json`
- Project: `.pi/openai-fast.json` (overrides global)

Config contents:

```json
{
  "enabled": false
}
```

- `enabled`: default Fast-mode state used when `/fast auto` is active.
