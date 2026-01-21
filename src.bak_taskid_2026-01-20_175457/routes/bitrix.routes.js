const router = require('express').Router();

const { createContactFromLead } = require('../controllers/bitrix.controller');
const { setCurrentOrderNo, moveCurrentToClosed } = require('../controllers/orderSimple.controller');
const { pauseSync } = require('../controllers/pauseSync.controller');
const { pauseSyncOne } = require('../controllers/pauseSyncOne.controller');
const { taskUpdate } = require('../controllers/taskEvents.controller');

const localOnly = require('../middlewares/localOnly');

// Контакт из лида по телефону
router.get('/leads/:leadId/create-contact-by-phone', createContactFromLead);
router.post('/leads/:leadId/create-contact-by-phone', createContactFromLead);

// В "Текущие заказы" ставим номер 1С или fallback-title
router.get('/leads/:leadId/set-current-order-no', setCurrentOrderNo);
router.post('/leads/:leadId/set-current-order-no', setCurrentOrderNo);

// Переносим из "Текущих" в "Закрытые" + чистим "Текущие"
router.get('/leads/:leadId/move-current-to-closed', moveCurrentToClosed);
router.post('/leads/:leadId/move-current-to-closed', moveCurrentToClosed);

// Синхронизация "Пауза" (пакетно) — только localhost
router.get('/leads/pause-sync', localOnly, pauseSync);
router.post('/leads/pause-sync', localOnly, pauseSync);

// Синхронизация "Пауза" (один лид) — только localhost
router.get('/leads/:leadId/pause-sync', localOnly, pauseSyncOne);
router.post('/leads/:leadId/pause-sync', localOnly, pauseSyncOne);

router.post('/events/task-update', taskUpdate);
router.get('/events/task-update', taskUpdate); // на всякий случай

module.exports = router;
