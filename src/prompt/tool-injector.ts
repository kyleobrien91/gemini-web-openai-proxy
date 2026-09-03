import { Tool } from '../types/openai.js';

export function injectToolSchemas(tools?: Tool[]): string {
  if (!tools || tools.length === 0) {
    return '';
  }

  const toolDefinitions = tools.map(t => t.function);

  return `
[AVAILABLE TOOLS]
The following tools are available for you to execute tasks:
${JSON.stringify(toolDefinitions, null, 2)}

[TOOL CALL INSTRUCTIONS]
If you decide to invoke one or more tools, you MUST output the tool call strictly wrapped inside <tool_call> and </tool_call> tags with valid JSON matching the schema:

<tool_call>
{"name": "tool_name_here", "arguments": {"param_key": "param_value"}}
</tool_call>

Rules:
1. Tool names must exactly match supplied tools.
2. Arguments must be valid JSON and strictly conform to the supplied schema.
3. Multiple tool calls are allowed where appropriate.
4. Tool calls must not be wrapped in Markdown fences (e.g., no \`\`\`json or \`\`\`xml).
5. Normal text may be emitted when no tool is required, or as explanation before/after tool calls. TEXT MUST NOT APPEAR INSIDE OR BETWEEN THE <tool_call> AND </tool_call> TAGS (other than the JSON).
`;
}
