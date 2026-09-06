export interface ModelDefinition {
  id: string;
  name: string;
  webDomTestId?: string;
  keywords?: string[];
  extendedThinking?: boolean;
  aliasFor?: string;
}

export const modelRegistry: Record<string, ModelDefinition> = {
  // Primary frontend models
  'gemini-flash': {
    id: 'gemini-flash',
    name: 'Flash',
    webDomTestId: 'bard-mode-option-56fdd199312815e2',
    keywords: ['flash'],
    extendedThinking: false
  },
  'gemini-flash-extended': {
    id: 'gemini-flash-extended',
    name: 'Flash Extended',
    webDomTestId: 'bard-mode-option-56fdd199312815e2',
    keywords: ['flash'],
    extendedThinking: true
  },
  'gemini-pro': {
    id: 'gemini-pro',
    name: 'Pro',
    webDomTestId: 'bard-mode-option-e6fa609c3fa255c0',
    keywords: ['pro', 'advanced'],
    extendedThinking: false
  },
  'gemini-pro-extended': {
    id: 'gemini-pro-extended',
    name: 'Pro Extended',
    webDomTestId: 'bard-mode-option-e6fa609c3fa255c0',
    keywords: ['pro', 'advanced'],
    extendedThinking: true
  },
  'gemini-flash-lite': {
    id: 'gemini-flash-lite',
    name: '3.5 Flash-Lite',
    webDomTestId: 'bard-mode-option-8c46e95b1a07cecc',
    keywords: ['flash lite', 'flash-lite', 'lite', '3.5 flash-lite'],
    extendedThinking: false
  },
  'default': {
    id: 'default',
    name: 'Default (Current UI Selection)',
  },

  // Shorthand aliases
  'flash': {
    id: 'flash',
    name: 'Flash',
    aliasFor: 'gemini-flash'
  },
  'flash-extended': {
    id: 'flash-extended',
    name: 'Flash Extended',
    aliasFor: 'gemini-flash-extended'
  },
  'pro': {
    id: 'pro',
    name: 'Pro',
    aliasFor: 'gemini-pro'
  },
  'pro-extended': {
    id: 'pro-extended',
    name: 'Pro Extended',
    aliasFor: 'gemini-pro-extended'
  },
  'flash-lite': {
    id: 'flash-lite',
    name: 'Flash Lite',
    aliasFor: 'gemini-flash-lite'
  },
  'gemini-thinking': {
    id: 'gemini-thinking',
    name: 'Gemini Thinking',
    aliasFor: 'gemini-flash-extended'
  },

  // Versioned aliases for backwards compatibility
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    aliasFor: 'gemini-flash'
  },
  'gemini-3.8-flash-extended': {
    id: 'gemini-3.8-flash-extended',
    name: 'Gemini 3.8 Flash Extended',
    aliasFor: 'gemini-flash-extended'
  },
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    aliasFor: 'gemini-flash'
  },
  'gemini-3.1-pro': {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    aliasFor: 'gemini-pro'
  },
  'gemini-3.1-pro-extended': {
    id: 'gemini-3.1-pro-extended',
    name: 'Gemini 3.1 Pro Extended',
    aliasFor: 'gemini-pro-extended'
  },
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    aliasFor: 'gemini-flash-lite'
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    aliasFor: 'gemini-pro'
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    aliasFor: 'gemini-flash'
  }
};

export function getModel(modelId: string): ModelDefinition | undefined {
    if (!modelId) return undefined;
    if (modelRegistry[modelId]) return modelRegistry[modelId];
    // If a provider prefix is included (e.g., 'gemini-web-ai-proxy/gemini-flash-extended'), strip it
    if (modelId.includes('/')) {
        const stripped = modelId.split('/').pop()!;
        if (modelRegistry[stripped]) return modelRegistry[stripped];
    }
    return undefined;
}

export function resolveTargetModelId(modelId: string): string | undefined {
    const model = getModel(modelId);
    if (!model) return undefined;
    return model.aliasFor ? model.aliasFor : model.id;
}

export function resolveTargetModel(modelId: string): ModelDefinition | undefined {
    const targetId = resolveTargetModelId(modelId);
    if (!targetId) return undefined;
    return getModel(targetId);
}


