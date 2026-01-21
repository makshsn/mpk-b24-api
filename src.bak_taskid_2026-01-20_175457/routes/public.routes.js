const express = require('express');

const { spaEvent } = require("../controllers/spa1048.controller");
const { taskEvent } = require("../controllers/spa1048TaskEvent.controller");
const { taskUpdateWebhook } = require("../controllers/spa1048TaskUpdateWebhook.controller");

const router = express.Router();

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

router.post('/task-event', taskEvent);
router.get('/task-event', taskEvent);

router.post('/task-update', taskUpdateWebhook);
router.get('/task-update', taskUpdateWebhook); // удобно для ручного теста


module.exports = router;
