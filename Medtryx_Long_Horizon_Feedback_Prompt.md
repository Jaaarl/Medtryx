# Medtryx long-horizon feedback implementation prompt

Use this after reviewing an AI-built version of Medtryx. Open a Codex coding session in this project folder, copy the prompt below, and replace the numbered-list placeholder with your feedback. You can include screenshots, reproduction steps, and expected behavior beside any item. Keep the item numbers stable so progress can be tracked across sessions.

```text
Continue work on the existing Medtryx repository. Implement all of my numbered feedback as a long-horizon follow-up to Medtryx_Long_Horizon_Implementation_Prompt.md. Work through the feedback in manageable, complete bundles and continue until every item is verified or a genuine external decision blocks it. Do not stop after writing a plan or after fixing only the first few items.

Read first:
1. My numbered feedback below, including any screenshots or reproduction steps.
2. Medtryx_Simplified_Web_Product_and_Technical_Specification.md and Medtryx_Web_Tech_Stack_and_Roadmap.md.
3. Medtryx_Long_Horizon_Implementation_Prompt.md and IMPLEMENTATION_STATUS.md.
4. The current code, tests, Git history, working tree, and any repository instructions.

My feedback is the requested change to the current implementation. Where an item explicitly changes product behavior, treat that request as newer than the existing documents; update the affected documents once the change is implemented. Preserve the simplified MVP scope for everything the feedback does not change. If two feedback items conflict, or an item leaves a material tax/accounting, legal/compliance, deployment, or additional product-scope decision open, identify the exact decision and ask me. Continue independent items while waiting.

Numbered feedback:
1. [Paste feedback item 1 here. State what you observed and what you want instead.]
2. [Paste feedback item 2 here.]
3. [Add as many numbered items as needed.]

How to work:
1. Inspect the actual application and reproduce each reported issue where practical. Do not assume the earlier AI's description or IMPLEMENTATION_STATUS.md is proof that the behavior works. Preserve existing user changes and data. Do not initialize Git again or rerun the original baseline steps.
2. Create or update FEEDBACK_IMPLEMENTATION_STATUS.md. Preserve my numbered feedback verbatim there, including references to attached screenshots, so another session can recover the full request. Give every item a stable ID matching my list, the affected area, acceptance check, dependencies, and one of: pending, in progress, verified, blocked, or superseded. Record the reason and decision for any blocked or superseded item. If this session already has a feedback status file, resume from it instead of starting over.
3. Group related items into small reviewable bundles, ordered by dependencies and risk. Fix root causes where several items share one. Include database migration, API validation/authorization, UI, documentation, and meaningful tests wherever the change requires them. Do not silently omit, merge away, or mark an item complete merely because a related item passed.
4. For each bundle, verify the specific acceptance checks for every included item, then run the relevant existing checks: formatting, lint, typecheck, focused tests, build, and browser tests when a browser workflow changed. Add regression coverage for consequential bugs, permissions, money/stock calculations, persistence, and concurrency. Use synthetic data in isolated development/test environments. Check for regressions in connected workflows.
5. Update FEEDBACK_IMPLEMENTATION_STATUS.md and any affected specifications or user documentation. Review the diff and make a clear Git commit for each completed bundle, including its code, migration, tests, and documentation. Do not commit secrets, customer data, databases, backups, build output, or node_modules. Record the commit hash and verification evidence against each feedback item.
6. Continue to the next bundle without waiting for approval after each commit. At meaningful milestones, give me a short update with item IDs completed, behavior changed, checks and results, commit hash, and what remains. If the work spans sessions, leave FEEDBACK_IMPLEMENTATION_STATUS.md accurate enough to resume without repeating completed work.
7. Keep the original release gates visible. In particular, do not claim physical-site checks, professional policy approval, or live readiness based on local synthetic tests. Do not deploy to the live pharmacy or use real customer data without my explicit authorization.

At the end, give me a table covering every feedback ID with its final status and evidence, plus the completed bundle commits, checks run, remaining blockers, and any decisions needed from me. If an item cannot be completed, explain exactly what is missing and what independent work was completed.
```

## Resume in another session

```text
Continue the Medtryx numbered-feedback work from FEEDBACK_IMPLEMENTATION_STATUS.md. Read my original numbered feedback recorded there, the simplified specification, roadmap, original long-horizon prompt, IMPLEMENTATION_STATUS.md, Git history, and current working tree. Complete and verify the next pending feedback bundle, update the status file, commit the completed bundle, and continue through all remaining items. Keep the original live-release gates in force. Report item IDs, checks, commits, and genuine blockers.
```
