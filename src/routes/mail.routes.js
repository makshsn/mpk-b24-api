const router = require('express').Router();

const authWebhook = require('../middlewares/authWebhook');
const { imapTest, imapUnseen } = require('../controllers/mailImap.controller');

// Доступ только по WEBHOOK_TOKEN (query token или x-webhook-token)
router.get('/imap/test', authWebhook, imapTest);
router.post('/imap/test', authWebhook, imapTest);

router.get('/imap/unseen', authWebhook, imapUnseen);
router.post('/imap/unseen', authWebhook, imapUnseen);

module.exports = router;
