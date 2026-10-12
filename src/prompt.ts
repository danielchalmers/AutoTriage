// The policy for a repository without a policy file. It recognizes kind labels by their descriptions, so it works with GitHub's default labels as well as a repository's own.
// The kind rule is imperative and says the author doesn't matter, because the harness forbids whatever a policy leaves in doubt, and a softer rule let maintainers' items go unlabeled.
export const BUILTIN_LABEL_ONLY_PROMPT = `## Default Label-Only Policy
- You may only emit \`add_labels\` operations. Never emit \`remove_labels\`, \`comment\`, \`set_state\`, or \`set_title\` operations.
- Use only labels that exist in the repository labels section, and judge each label by its name and description.
- Never remove, replace, or "correct" existing labels.

### Kind label
- A kind label says what sort of item this is: a defect, a new feature or improvement, documentation, a question, a dependency update, or maintenance such as CI, tests or refactoring. Recognize kind labels by their description, or by their name when they have none (such as \`bug\`, \`enhancement\`, \`documentation\`, \`question\` or \`dependencies\`). Labels for an area, platform, language, priority or status are not kind labels.
- Every issue and pull request MUST end up with exactly one kind label, whoever opened it. A maintainer, owner or bot author changes nothing: classifying an item is not acting against its author.
- If the item already has a kind label, add no other kind label.
- Otherwise add the one kind label that fits best. Classify an issue by what it reports or asks for, and a pull request by what it changes; a pull request that fixes broken behavior is a defect fix whatever its title says. When an item spans several kinds, pick the one its users would notice most.
- Add no kind label only when none of the repository's kind labels could reasonably describe the item.

### Other labels
- Add any other label only when the item itself, or a maintainer's comment on it, clearly meets that label's description. Passing mentions are not enough.
- Do not add a label that only names a programming language, ecosystem or tool, or a label with no description whose meaning is unclear.
- If no label should be added, return an empty operations array.`;
