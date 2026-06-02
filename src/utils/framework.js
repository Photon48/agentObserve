// Canonical adapter framework codes returned by the server (server/adapters/*).
// Keep in sync with the FRAMEWORK exports there.
export const FRAMEWORK_LABELS = {
  'claude-code-cli': 'Claude Code CLI',
  'anthropic-sdk': 'Anthropic SDK',
  'langchain': 'LangChain / LangGraph',
};

// Display order for tabs when multiple frameworks are present. Acts as the
// tiebreaker when picking the default selection (equal session counts).
export const FRAMEWORK_ORDER = ['claude-code-cli', 'anthropic-sdk', 'langchain'];

export function frameworkLabel(code) {
  return FRAMEWORK_LABELS[code] || code || 'unknown';
}
