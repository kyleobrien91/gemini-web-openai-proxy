import { Router } from 'express';

const router = Router();

const MODELS = [
  {
    id: "gemini-3.7-flash",
    object: "model",
    created: 1740000000,
    owned_by: "google-web",
    permission: [],
    root: "gemini-3.7-flash",
    parent: null,
    metadata: {
      web_label: "3.7 Flash (All-around help)",
      web_dom_testid: "bard-mode-option-56fdd199312815e2"
    }
  },
  {
    id: "gemini-3.7-flash-thinking",
    object: "model",
    created: 1740000000,
    owned_by: "google-web",
    permission: [],
    root: "gemini-3.7-flash-thinking",
    parent: null,
    metadata: {
      web_label: "3.7 Flash + Extended thinking (Complex problem solving)",
      thinking: true
    }
  },
  {
    id: "gemini-3.5-flash-lite",
    object: "model",
    created: 1740000000,
    owned_by: "google-web",
    permission: [],
    root: "gemini-3.5-flash-lite",
    parent: null,
    metadata: {
      web_label: "3.5 Flash-Lite (Fastest answers)",
      web_dom_testid: "bard-mode-option-8c46e95b1a07cecc"
    }
  },
  {
    id: "gemini-3.1-pro",
    object: "model",
    created: 1740000000,
    owned_by: "google-web",
    permission: [],
    root: "gemini-3.1-pro",
    parent: null,
    metadata: {
      web_label: "3.1 Pro (Advanced reasoning)",
      web_dom_testid: "bard-mode-option-e6fa609c3fa255c0"
    }
  },
  {
    id: "gemini-2.5-pro",
    object: "model",
    created: 1740000000,
    owned_by: "google-web",
    permission: [],
    root: "gemini-2.5-pro",
    parent: null,
    metadata: {
      alias_for: "gemini-3.1-pro"
    }
  },
  {
    id: "gemini-2.5-flash",
    object: "model",
    created: 1740000000,
    owned_by: "google-web",
    permission: [],
    root: "gemini-2.5-flash",
    parent: null,
    metadata: {
      alias_for: "gemini-3.7-flash"
    }
  }
];

router.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: MODELS
  });
});

export default router;
