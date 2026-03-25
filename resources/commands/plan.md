Activate plan mode and produce an implementation plan before coding.

Immediately call `EnterPlanMode` for this request.

Then:
- Inspect the relevant codebase areas in read-only mode first.
- Produce a concrete implementation plan in Plan Mode.
- Call `SavePlan` with a clear step-by-step plan.
- Call `ExitPlanMode` when the plan is ready for review.
- Do not implement code unless the user explicitly asks to proceed.
