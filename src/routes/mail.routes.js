const router = require('express').Router();

// Без токена/авторизации (по вашей установке). Ограничьте доступ на уровне Nginx.

const {
  imapTest,
  imapUnseen,
  imapIngest,
  getSavedEmail,
} = require('../controllers/mailImap.controller');

const { createFromEmail } = require('../controllers/mailSpa1048.controller');
const { run: autoRunOnce } = require('../controllers/mailSpa1048Auto.controller');

// IMAP
router.get('/imap/test', imapTest);
router.post('/imap/test', imapTest);

router.get('/imap/unseen', imapUnseen);
router.post('/imap/unseen', imapUnseen);

router.get('/imap/ingest', imapIngest);
router.post('/imap/ingest', imapIngest);

router.get('/imap/email/:id', getSavedEmail);

// Создать SPA1048 из сохранённого письма (emailId)
router.get('/spa1048/from-email/:emailId', createFromEmail);
router.post('/spa1048/from-email/:emailId', createFromEmail);

// Авто-конвертация: непрочитанные -> allowlist -> SPA1048
router.get('/spa1048/auto/run-once', autoRunOnce);
router.post('/spa1048/auto/run-once', autoRunOnce);

module.exports = router;
