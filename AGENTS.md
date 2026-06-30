# AGENTS.md

## Working Standard

- Answer in the user's language.
- Be autonomous by default: inspect, decide, implement, and validate without unnecessary confirmation loops.
- Ask a question only when ambiguity blocks a safe decision, a product choice is unclear, or the change is risky enough that the user should explicitly choose.
- Do not hallucinate. Verify uncertain claims in code, scripts, docs, or runtime output.
- Preserve unrelated user changes. Do not revert work you did not make.
- Keep answers concrete and practical: what changed, why, how it was validated, and what risk remains.

## Context And Documentation

- Use `README.md` and relevant docs when the task needs product context, setup instructions, architecture, operational constraints, or acceptance criteria.
- Trust the code and runtime behavior for current implementation details. If docs and code disagree, call out the drift explicitly.
- Update docs only when a change affects durable knowledge: setup, architecture, behavior contracts, user flows, operations, or important decisions.
- Do not create documentation churn for trivial refactors, obvious code movement, or self-evident implementation details.

## Simplicity And Modularity

- Optimize for a small codebase maintained by a small team.
- Prefer the simplest correct solution over extra layers, folders, patterns, or abstractions.
- Prefer local clarity over clever reuse. Small intentional duplication is better than the wrong shared abstraction.
- Add a helper, wrapper, service, or new module only when it removes real complexity in the current task.
- Keep responsibilities explicit, names clear, and control flow easy to trace.
- Keep edits scoped to the behavior being changed.

## Test-Driven Development

- TDD is the default for any non-trivial change in behavior, business logic, contracts, validation, persistence, integrations, routing, state transitions, concurrency, or cross-layer mechanics.
- Start from behavior, not implementation. Write the smallest failing test that captures the expected result before changing production code when the repository has a proportional test layer.
- Keep the loop strict: `Red -> Green -> Refactor`.
- Make the smallest correct production change that turns the failing case green.
- Refactor only while tests stay green and behavior stays unchanged.
- Do not batch unrelated behavior changes into one green step.
- Tests should encode behavior, contracts, boundaries, and invariants, not incidental implementation details.
- Use the test infrastructure that already exists in the repository. Do not introduce a heavier test layer unless the task clearly justifies it.
- If no suitable automated test exists and adding one is disproportionate, say that explicitly and use the fastest reliable validation path instead.

## Implementation Discipline

- Inspect the owning layer and source of truth before editing.
- Fix the decision at the layer that owns it. Avoid leaf-level fallback branches or duplicated decision logic that only masks an upstream problem.
- If a shared contract, schema, persistence rule, integration boundary, or public behavior changes, inspect and validate both sides of that boundary.
- Be skeptical of one-file fixes for non-trivial behavior changes. If only one file changes, be able to justify why adjacent layers do not need alignment.
- Do not add delivery automation, CI, deployment machinery, or operational process unless the user explicitly asks for it.

## Validation And Completion

- Run the smallest meaningful validation that covers the changed surface.
- Treat non-zero exits, runtime errors, and failing assertions as failures.
- Green tests do not override a broken primary behavior signal.
- If only secondary checks were possible, report the work as partially validated.
- When finishing, summarize the change, validation performed, docs impact, and any remaining risk or follow-up.
