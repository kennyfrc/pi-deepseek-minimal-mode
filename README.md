# pi-deepseek-minimal-mode

This reproduces DeepSeek Harness' Minimal Mode, which consists of only two
tools: `bash` and `str_replace_editor`, and uses the `You are a helpful
software engineer assistant.` system prompt.

There are two modes:

- `strict`: This is the exact same RL environment. It sends the frozen
  Harness persona and the two tools, in that order, with no reminders.
- `augmented`: Meant for regular use. This appends your AGENTS.md, skills,
  and non-bash and non-str_replace_editor tools to the first user prompt.

## Install

```bash
pi install npm:@kennyfrc/pi-deepseek-minimal-mode
```

Config lives in `~/.pi/agent/pi-deepseek-minimal-mode.json`. Omit it for the
default `strict` mode. Set `profile` to `augmented` and list extra tool names
in `whitelist` (use `"*"` for every non-core tool).

```json
{
  "mode": "auto",
  "profile": "augmented",
  "whitelist": ["*"]
}
```

## License

MIT.
