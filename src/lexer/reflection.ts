export function generateReflectionPrompt(errorReason: string): string {
    return `[SYSTEM CORRECTION]:
Your previous response violated the mandatory tool calling format.
Reason: ${errorReason}

You MUST immediately re-output your response strictly using:
<tool_call>
{"name": "exact_tool_name", "arguments": { ... }}
</tool_call>
Do not add commentary, output only the valid tool call.`;
}
