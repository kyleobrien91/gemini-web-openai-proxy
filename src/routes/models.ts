import { Router } from 'express';
import { modelRegistry } from '../models/registry.js';

const router = Router();

router.get('/v1/models', (req, res) => {
  const modelsList = Object.values(modelRegistry).map(model => {
      const data: any = {
        id: model.id,
        object: "model",
        created: 1740000000,
        owned_by: "google-web",
        permission: [],
        root: model.id,
        parent: null,
        metadata: {}
      };

      if (model.aliasFor) {
          data.metadata.alias_for = model.aliasFor;
      } else {
          data.metadata.web_label = model.name;
          data.metadata.web_dom_testid = model.webDomTestId;
      }
      return data;
  });

  res.json({
    object: 'list',
    data: modelsList
  });
});

export default router;
