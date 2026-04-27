# Model tiers

This repo assumes a three-tier agent architecture. The concrete model IDs live
in [`../models.env`](../models.env) and are loaded as environment variables.
When wiring a new agent, match the tier to the job:

| Variable | Role | When to use |
| --- | --- | --- |
| `RABBIT_SAGE_MODEL` | Rabbit Sage — Planner / Orchestrator | Whole-picture strategy and subtask decomposition. Runs rarely; needs frontier reasoning and long-context coherence. |
| `LEAD_HARE_MODEL` | Lead Hare — Task Overseer | Reviews worker output, assigns follow-ups, keeps the plan on track. Runs often; solid reasoning but not frontier. |
| `TASK_RABBIT_MODEL` | Task Rabbit — Worker | Bulk task execution. Runs constantly; optimize for cost-per-token at acceptable quality. |

Source the file before launching pi so the tier vars are in scope:

```sh
set -a; source models.env; set +a
npm run pi -- --model "$TASK_RABBIT_MODEL"    # or $LEAD_HARE_MODEL / $RABBIT_SAGE_MODEL
```

In an agent recipe, set `model:` to the tier variable name (the runner
resolves it) or a literal provider/model ID:

```yaml
model: TASK_RABBIT_MODEL          # resolved from models.env
# model: deepseek/deepseek-v3.2   # literal ID also works
```

`models.env` is committed because the IDs are not secrets. Put API keys in a
gitignored `.env` instead.
