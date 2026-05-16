# pi-openai-tweaks

A simple Pi extension that gives you:

- clear OpenAI/Codex usage in your status line (`/usage`)
- one-command Fast mode control (`/fast`)

## Install

From npm:

```bash
pi install npm:@m4riok/pi-openai-tweaks
```

## What this extension provides

### 1) Usage status

Shows 5h and 7d usage with reset countdowns in the footer/status line.

You can control:

- format (`default` or `compact`)
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
/usage weekly on
/usage weekly off
/usage percent remaining
/usage percent used
/usage update turn
/usage update poll
```

### 2) Fast mode

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
