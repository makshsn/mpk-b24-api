const express = require('express');

const { spaEvent } = require("../controllers/spa1048.controller");
const { spaDeleteWebhook } = require("../controllers/spa1048DeleteWebhook.controller");
const { taskCompletionEvent } = require("../controllers/taskCompletionEvent.controller");
const { taskUpdateWebhook } = require("../controllers/spa1048TaskUpdateWebhook.controller");
const { taskCloseWebhook } = require("../controllers/taskCloseWebhook.controller");

const b24oauthRoutes = require('./b24oauth.routes');
const router = express.Router();

// _inspect routes (must be BEFORE debug middleware)
const inspectRoutes = require('./inspect.routes');
router.use(inspectRoutes);

// Bitrix OAuth (server-side local app) callbacks & events
router.use('/oauth', b24oauthRoutes);

// DEBUG middleware: не стопает обработчики
router.use((req, res, next) => {
  if (req.query?.debug === '1') {
    console.log('[DEBUG]', req.method, req.originalUrl, JSON.stringify(req.body));
    if (req.query?.echo === '1') {
      return res.json({
        ok: true,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
        query: req.query,
        body: req.body,
      });
    }
  }
  next();
});

// Bitrix outbound events
router.post('/spa-event', spaEvent);
router.get('/spa-event', spaEvent);

// Bitrix outbound: SPA deleted (onCrmDynamicItemDelete)
router.post('/spa-delete', spaDeleteWebhook);
router.get('/spa-delete', spaDeleteWebhook);
// удобный ручной тест: /b24/spa-delete/134?debug=1
router.post('/spa-delete/:itemId', spaDeleteWebhook);
router.get('/spa-delete/:itemId', spaDeleteWebhook);

router.post('/task-event', taskCompletionEvent);
router.get('/task-event', taskCompletionEvent);

router.post('/task-update', taskUpdateWebhook);
router.get('/task-update', taskUpdateWebhook); // удобно для ручного теста

// Robot webhook: close task without touching SPA stage
router.post('/task-close', taskCloseWebhook);
router.get('/task-close', taskCloseWebhook);
router.post('/task-close/:taskId', taskCloseWebhook);
router.get('/task-close/:taskId', taskCloseWebhook);

module.exports = router;
