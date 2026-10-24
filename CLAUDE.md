# Working on HockeyStatsAPI with Claude Code

Read and follow [README.md](README.md) first. The shared agent workflow and
Product Owner rules live in HockeyStatsWebApp's
[docs/agent-development.md](https://github.com/chrisgawbill/HockeyStatsWebApp/blob/main/docs/agent-development.md);
they apply here too.

## Skills

Use [Ponytail](.claude/skills/ponytail/SKILL.md) for implementation: understand the
flow, reuse existing services, mappers and helpers, and make the smallest complete
fix. It is also available as `/ponytail full`. Its upstream MIT license is bundled
alongside it.

A "ponytail sweep" means running Ponytail over the branch's diff and trimming what
it finds before hand-off. The Product Owner rules (readability pass, commits and
branches) take precedence where they differ from Ponytail.

## Verification

Run `pnpm test`. List anything failed or skipped.
