# Ralph QA Checklist — Round 1 merged into `claude/review-repo-issues-VPuZJ`

Final integration smoke: ✅ passed (24 files / 533 tests, vitest)

> Issue below is still open. After you merge the round's PR, run the close-out agent (`close.md`) to close it with the commit reference.

## Human QA

- [ ] Run `npm run mesh -- pi-sandbox/meshes/authority-mesh.yaml` under tmux: focused peer's pi TUI renders with full color, cursor follows typing, no per-keystroke flicker, and the mesh-rail (above the input editor) is the only mesh-status surface — no chrome strip on the right and nothing written to stderr beyond launcher diagnostics — issue #92, commit 92c32e5
- [ ] Kill one peer process during the same tmux run (`kill <pid>`); within ~1s the rail's state icon for that peer transitions to crashed without any user input — issue #92, commit 92c32e5
