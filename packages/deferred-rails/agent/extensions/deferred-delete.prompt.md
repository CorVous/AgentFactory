`deferred_delete({path})` stages a file deletion.

- Files only — rejects directories and missing paths at queue time, so
  you get immediate feedback if you target the wrong thing.
