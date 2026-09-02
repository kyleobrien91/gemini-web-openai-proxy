import JSON5 from 'json5';

export function stripMarkdown(text: string): string {
  // Strip markdown code blocks surrounding tool calls
  const mdRegex = /^```(?:json|xml)?\s*([\s\S]*?)```\s*$/i;
  const match = text.trim().match(mdRegex);
  if (match) {
    return match[1].trim();
  }
  return text.trim();
}

export function fuzzyTagRepair(text: string): string {
  let repaired = text;

  // Convert standard code blocks mapped to file writes
  const fileBlockRegex = /```(?:python|javascript|typescript|js|ts|py|sh|bash)?\s*file=["']?([^"']+)["']?\s*([\s\S]*?)```/i;
  const fileMatch = repaired.match(fileBlockRegex);
  if (fileMatch) {
    const [, path, content] = fileMatch;
    repaired = `<tool_call>\n{"name": "write_to_file", "arguments": ${JSON.stringify({ path, content: content.trim() })} }\n</tool_call>`;
    return repaired;
  }

  // Repair fuzzy tags to <tool_call>
  repaired = repaired.replace(/<tool-call>/g, '<tool_call>')
                     .replace(/<\/tool-call>/g, '</tool_call>')
                     .replace(/<tool>/g, '<tool_call>')
                     .replace(/<\/tool>/g, '</tool_call>')
                     .replace(/<function_call>/g, '<tool_call>')
                     .replace(/<\/function_call>/g, '</tool_call>');

  // Repair tags with attributes
  repaired = repaired.replace(/<tool_call[^>]*>/g, '<tool_call>');

  // Check if there is an unclosed tag at the end
  if (repaired.includes('<tool_call>') && !repaired.includes('</tool_call>')) {
      repaired += '\n</tool_call>';
  }

  return repaired;
}

export function tryParseJSON(jsonStr: string): any {
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    try {
      return JSON5.parse(jsonStr);
    } catch (e2) {
      return null;
    }
  }
}
