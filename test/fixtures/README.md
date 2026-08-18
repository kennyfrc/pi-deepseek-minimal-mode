# DeepSeek Harness composition fixture

`deepseek-harness-rc5-composition.json` records the model-facing minimal
composition observed from DeepSeek Harness `0.1.0-rc.5` at revision
`47f943859bef60e4160492346772ded9b24f765a`.

The file is minified so tests can compare `JSON.stringify()` output with the
fixture bytes. Refresh it only after the Harness keyless minimal-preset
snapshot passes at a named revision. Review the resulting byte diff before
updating the extension constants.
