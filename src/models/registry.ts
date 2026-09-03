export interface ModelDefinition {
  id: string;
  name: string;
  webDomTestId?: string;
  aliasFor?: string;
}

export const modelRegistry: Record<string, ModelDefinition> = {
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    webDomTestId: 'bard-mode-option-56fdd199312815e2'
  },
  'gemini-3.1-pro': {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    webDomTestId: 'bard-mode-option-e6fa609c3fa255c0'
  },
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    webDomTestId: 'bard-mode-option-cf41b0e0dd7d53e5'
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    aliasFor: 'gemini-3.1-pro'
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    aliasFor: 'gemini-3.7-flash'
  }
};

export function getModel(modelId: string): ModelDefinition | undefined {
    return modelRegistry[modelId];
}

export function resolveTargetModelId(modelId: string): string | undefined {
    const model = getModel(modelId);
    if (!model) return undefined;
    return model.aliasFor ? model.aliasFor : model.id;
}
