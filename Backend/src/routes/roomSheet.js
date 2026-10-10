const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getRoomSheets, getGeneratedRoomSheet, getRoomSheetDownload } = require('../controllers/roomSheetController');

router.use(auth, authorize(['frontdesk', 'admin', 'housekeeping']));

router.get('/room-sheets', getRoomSheets);
router.get('/room-sheets/:date/download', getRoomSheetDownload);
router.get('/room-sheets/:date/generated', getGeneratedRoomSheet);
// Canonical routes when mounted at /api/roomSheet, preserving legacy /api paths.
router.get('/', getRoomSheets);
router.get('/:date/download', getRoomSheetDownload);
router.get('/:date/generated', getGeneratedRoomSheet);

module.exports = router;
