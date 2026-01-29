'use strict';

const router = require('express').Router();

const { install, event, status, eventsList, eventTest } = require('../controllers/b24oauth.controller');
const { installPage } = require('../controllers/b24oauth.installPage.controller');

// Install callback from Bitrix24 (server-side local app)
router.post('/install', install);
router.get('/install', install);

// Installation finish page (must be opened inside Bitrix24 during install)
router.get('/install-page', installPage);
router.post('/install-page', installPage); // чтобы не ловить "Cannot POST", если дергают POST

// Event receiver
router.post('/event', event);
router.get('/event', event);

// Debug: list registered handlers from portal
router.get('/events', eventsList);

// Debug: force-test event delivery (event.test)
router.post('/event-test', eventTest);
router.get('/event-test', eventTest);

router.get('/status', status);

module.exports = router;
