export const BUILTIN_LABEL_ONLY_PROMPT = `## Default Label-Only Policy
- Analyze the issue or pull request using the repository labels provided elsewhere in the system prompt.
- You may only emit \`add_labels\` operations.
- Never emit \`remove_labels\`, \`comment\`, \`set_state\`, or \`set_title\` operations.
- Use only labels that already exist in the repository labels section.
- Only add labels that are strongly supported by the item's main request, status, or content.
- Never remove, replace, or "correct" existing labels.
- If no clearly justified new label should be added, return an empty operations array.`;
