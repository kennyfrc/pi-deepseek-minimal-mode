# pi-deepseek-minimal-mode

Strict-by-default DeepSeek Harness composition for Pi.

For a matching DeepSeek model, the final provider hook replaces Pi's
model-facing composition. The default `strict` profile sets this exact prompt:
`You are a helpful software engineer assistant.` It sends the frozen Harness
`bash` and `str_replace_editor` definitions in that order. It sends no
reminders. Request fields such as `store`, token limits, streaming options,
and reasoning settings remain unchanged.

The opt-in `augmented` profile uses the same persona. It sends Pi's complete
live core definitions. Configured extra tool definitions follow them. This
profile can also send durable AGENTS and skill context through the `agents-md`
reminder. The durable dump carries the context files, the available-skills
catalog, and the complete schemas of the configured extra tools.

There is no tool discovery channel. The extension does not register or teach a
`tool_search` tool. Augmented tools are visible in the provider request before
the model chooses a tool.

## Install

```bash
pi install npm:@kennyfrc/pi-deepseek-minimal-mode
```

The package owns `str_replace_editor` for matched sessions. Keep other editor
extensions disabled for the same models.

## Configuration

The user-level config file is:

```text
~/.pi/agent/pi-deepseek-minimal-mode.json
```

All fields are optional. A missing or invalid `profile` resolves to `strict`.

### Strict default

```json
{
  "mode": "auto",
  "profile": "strict"
}
```

`strict` ignores `whitelist`. Its active set and provider tool list are always
`bash` followed by `str_replace_editor`.

### Augmented with direct extra tools

```json
{
  "mode": "auto",
  "profile": "augmented",
  "whitelist": ["ask_user", "todo", "memo"]
}
```

Config order controls the whitelist. Augmented mode activates each listed tool
that Pi registered. It sends the complete live provider definition after the
core pair. Deduplication drops repeated names and core names. The extension
omits an unregistered name. It stops the request if another extension removes
a registered tool's provider definition before the final hook.

The `*` sentinel expands to every registered tool except the core pair, the
read/edit/write trio that pi-str-replace-editor owns, and the GPT-only
`apply_patch` that pi-apply-patch registers unconditionally. This gives a
DeepSeek session the same tool surface a normal session gets, with the
file-tool swaps applied. The sentinel mixes with explicit names; duplicates
drop. The expanded tools get inlined schemas and are dumped into the durable
preamble after the skills catalog.

### Model matching

```json
{
  "mode": "auto",
  "profile": "strict",
  "deepseekPatterns": ["deepseek", "deepseek-v4-flash"]
}
```

The regular expressions ignore case. They check the model id, provider, and
display name.

### Mode

- `"auto"` activates only for matching models. This is the default.
- `"on"` activates for every model.
- `"off"` disables the extension.

## Profile behavior

| Surface | `strict` | `augmented` |
| --- | --- | --- |
| Persona | exact Harness persona | exact Harness persona |
| Core schemas | frozen Harness schemas | complete live Pi schemas |
| Extra schemas | none | configured registered tools, inline |
| Durable context | none | `agents-md`, skills, and extra tool schemas |
| Discovery | none | none |
| Request parameters | unchanged | unchanged |

The final `before_provider_request` projection enforces the selected profile.
It also handles resumed sessions. Strict deletes every prior
`<system_reminder>` block. Augmented keeps only inner `agents-md` sections.

## Migration

Existing installs without `profile` now use `strict`. To keep AGENTS and skill
context, set `profile` to `augmented`. Add every required extra tool name to
`whitelist`.

This release removes the former discovery tool and its durable nudge. The
final provider projection strips an old persisted nudge during resume. Durable
delivery tracks reminder ids, so a nudge-only branch can still add the missing
`agents-md` entry in augmented mode.

## Development

```bash
npm run test:minimal-mode
npm run check:minimal-mode
```

The regression suite checks exact strict composition bytes. It checks direct
augmented schema identity and order. Other tests cover reminder policy,
lifecycle re-gating, and discovery removal.
