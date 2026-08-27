# Dynamic Effort and Escalation Ladders for Roles

`idea` · 2026-08-26

## Problem

Roles currently use static effort or a single role-wide effort ladder that cannot adapt per candidate model. When a revision loop occurs, models cannot easily scale reasoning effort progressively based on their own supported effort spectrum.

## Idea

Support per-candidate effort escalation ladders in role definitions, such as `- claude-opus-5:high,max` or `- gemini-3.7-flash:medium,high`. Runs start at the initial rung to save time and tokens, then automatically climb to higher effort rungs if a gate returns a REVISE verdict.

## Open questions

- Should the syntax support inline ladders like `- model:rung0,rung1`, or a structured map per candidate under the role?
- How should effort ladders behave when falling back to an alternate candidate model mid-loop?
