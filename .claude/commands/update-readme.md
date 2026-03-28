Review the recent code changes and update `README.md` to reflect them.

## Steps

1. Run `git diff HEAD~1 --stat` and `git log --oneline -5` to understand what changed recently.
2. Read the current `README.md`.
3. Check if any of these sections need updates:
   - **Key Features** list — add new features, update descriptions of changed features
   - **Architecture / File Structure** — update if files were added, removed, or reorganized
   - **API Endpoints** table — add new endpoints, remove deleted ones
   - **Lightning Storm Scene** — update if scene behavior changed
   - **Govee Razer Protocol** — update if new devices were tested
   - **Known Limitations** — add or resolve items
4. Make only the edits needed — don't rewrite sections that haven't changed.
5. If nothing in README needs updating, say so and skip.
6. Do NOT commit or push — just make the edits. The user will review and commit separately.
