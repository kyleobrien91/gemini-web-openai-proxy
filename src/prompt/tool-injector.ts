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
1. Do not wrap the <tool_call> tags inside markdown code blocks (e.g. do not use \`\`\`xml or \`\`\`json).
2. Output plain text explanations before or after the tool call if needed.
3. All arguments must strictly match the parameter JSON schema.
`;
}
