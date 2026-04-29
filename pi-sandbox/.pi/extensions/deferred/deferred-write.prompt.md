`deferred_write({path, content})` stages a new file for creation.

- `path` is relative to the sandbox root (no `..`, no absolute paths).
- `content` must be the COMPLETE finished file — every line, verbatim. Do
  not abbreviate. Do not use placeholders like `...`, `// rest unchanged`,
  `<existing imports>`, or `TODO: fill in`. The string you pass IS the
  file. If the finished file has 200 lines, your `content` must contain
  all 200 lines.
- One `deferred_write` call per file you want to create.
- Per-batch limits: ≤ 50 files, ≤ 2 MB each.
