const router = require('express').Router();
const { createContactFromLead } = require('../controllers/bitrix.controller');

// Поддержим и GET и POST (в БП “Исходящий вебхук” часто делает GET)
router.get('/leads/:leadId/create-contact-by-phone', createContactFromLead);
router.post('/leads/:leadId/create-contact-by-phone', createContactFromLead);

module.exports = router;
