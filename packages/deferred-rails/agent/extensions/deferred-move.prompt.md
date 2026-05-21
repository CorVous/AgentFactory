`deferred_move({src, dst})` stages a verbatim file relocation.

- Bit-identical content moved from `src` to `dst`.
- Refuses to overwrite — `dst` must not exist on disk at queue time.
- Parent directories of `dst` are auto-created at apply time. Do NOT
  queue a placeholder `deferred_write` to "force" a directory to exist.
