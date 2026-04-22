# Packaging

Pi packages bundle one or more extensions, skills, prompt templates, and themes into something installable from npm or git. This is how you ship to other users.

Install end-user view:

```bash
pi install npm:@foo/pi-tools          # from npm
pi install git:github.com/user/repo   # from git
pi install npm:@foo/pi-tools@1.2.3    # pinned version
pi update                             # update all installed packages
pi list                               # list installed packages
pi -e git:github.com/user/repo        # test without installing
```

## Package structure

```
my-pi-package/
├── package.json
├── README.md
├── agent/
│   ├── extensions/
│   │   └── my-extension.ts
│   ├── skills/
│   │   └── my-skill/
│   │       └── SKILL.md
│   ├── prompts/
│   │   └── my-template.md
│   └── themes/
│       └── my-theme.json
└── tsconfig.json
```

The `agent/` subdirectory mirrors `~/.pi/agent/` — on install, pi links each subdirectory into the user's config. This is why placement in your source tree matters.

## `package.json`

Pi looks for the `pi-package` keyword in npm for discovery. The `pi` field declares package metadata:

```json
{
  "name": "@yourname/pi-my-package",
  "version": "0.1.0",
  "description": "What this package does in one line",
  "keywords": ["pi-package"],
  "license": "MIT",
  "pi": {
    "name": "my-package",
    "extensions": ["agent/extensions/my-extension.ts"],
    "skills": ["agent/skills/my-skill"],
    "prompts": ["agent/prompts/my-template.md"],
    "themes": ["agent/themes/my-theme.json"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "^X.Y.Z"
  }
}
```

**Verify the exact `pi` field shape against the installed pi version** — this is evolving. `cat $(npm root -g)/@mariozechner/pi-coding-agent/package.json` to see real-world examples in `examples/` or the docs directory.

## Dependencies

- Use `peerDependencies` for `@mariozechner/pi-coding-agent` so your package doesn't force a specific pi version.
- Runtime deps go in `dependencies`. Pi installs them via npm/pnpm — don't bundle them.
- Dev-only deps (typescript, types) go in `devDependencies`.

## TypeScript setup

Pi compiles extensions on the fly via `tsx`. You don't ship compiled JS — you ship TypeScript. Minimal `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## Versioning

SemVer, but with a sharper lens:

- **Major**: breaking changes to tool names, parameters, or command names that users depend on.
- **Minor**: new tools, commands, events. Backward-compatible behavior changes.
- **Patch**: bug fixes, perf, internal refactors.

Users often pin: `pi install npm:@foo/pi-tools@1.2.3`. Respect the contract.

## README — what it needs

Users will decide whether to install based on the README. Cover:

1. **What it does** — one sentence, plus a short scenario.
2. **Install command** — copy-pasteable.
3. **Tools / commands exposed** — name, description, example prompts.
4. **Required env vars / setup** — API keys, external services.
5. **Security surface** — what the extension can do to the user's machine.
6. **Example session** — abbreviated TUI transcript showing the tool in action.

## Sharing

- **npm** — `npm publish`. Add `pi-package` to `keywords` so it surfaces in pi's package discovery.
- **git** — just push. Users install via `pi install git:github.com/you/repo`.
- **Discord** — the pi community keeps a channel of announcements.

## Security note for publishers

Pi packages run with full system access. Extensions execute arbitrary code, skills can instruct the model to run anything. Be explicit in your README about what your extension does, and avoid hiding side effects behind innocuous-sounding names.

## Top failure modes

1. **Peer dep mismatch.** You depend on a pi API that doesn't exist in the user's version. Test against both your declared `peerDependencies` range's min and max.
2. **Hardcoded paths.** `~/.pi/agent/` is the convention but users can override. Use the API (`ctx.*`) to discover paths rather than hardcoding.
3. **Leaky globals.** Module-level state persists between loads during development but not across users. Don't assume fresh module load == fresh runtime.
4. **Dependencies that don't play in `tsx`.** Some npm packages expect a bundler. Test your package loads under pi's actual runtime before publishing.
