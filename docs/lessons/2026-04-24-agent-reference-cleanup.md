# Agent Reference Cleanup

## Problem

Agent-facing docs referenced paths that were not present in this checkout, including old Codex-style rules and skill paths, a root-level cookbook path, and a missing frontend AGENTS file.

## Decision

Point Codex-facing instructions at the existing `.claude/rules/`, `.agents/skills/verify/SKILL.md`, and `web/docs/cookbook/` paths. Add `web/AGENTS.md` to mirror the existing frontend guidance in `web/CLAUDE.md`.

## Key Files

- `AGENTS.md`
- `CLAUDE.md`
- `.agents/skills/label/SKILL.md`
- `web/AGENTS.md`

## Watch Out

The graphify wiki index is optional in this checkout. Agent instructions should use `graphify-out/GRAPH_REPORT.md` when `graphify-out/wiki/index.md` is absent.
