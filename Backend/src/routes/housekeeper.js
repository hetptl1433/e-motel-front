const router = require('express').Router();
const auth = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const {
  listHousekeeping, updateStatus, createHousekeeping, getHousekeepingByDate,
  getHousekeepingByRoom, importToHousekeeping, importHousekeepingArray,
  bulkUpdateStatus, deleteHousekeeping, getHousekeepingSummary
} = require('../controllers/housekeeperController');
const readers = ['housekeeping', 'frontdesk', 'admin'];
const editors = ['housekeeping', 'admin'];
const importers = ['admin', 'frontdesk'];

router.get('/ping', (req, res) => res.json({ success: true, message: 'Housekeeper API is working!' }));
router.use(auth);
router.get('/', authorize(readers), listHousekeeping);
router.get('/status/:date', authorize(readers), getHousekeepingByDate);
router.get('/date/:date', authorize(readers), getHousekeepingByDate);
router.get('/summary', authorize(readers), getHousekeepingSummary);
router.get('/room/:roomNumber', authorize(readers), getHousekeepingByRoom);
router.get('/all', authorize(readers), listHousekeeping);
router.get('/test-socket', authorize(readers), (req, res) => {
  res.json({ success: true, socket: req.app.get('socketState') || { enabled: Boolean(req.app.get('io')) } });
});
router.post('/import-from-rooms', authorize(importers), importToHousekeeping);
router.post('/import-array', authorize(importers), importHousekeepingArray);
router.post('/import', authorize(importers), importToHousekeeping);
router.post('/', authorize(importers), createHousekeeping);
// Literal endpoints must precede the record-ID route.
router.put('/bulk-update', authorize(editors), bulkUpdateStatus);
router.put('/:id', authorize(editors), updateStatus);
router.delete('/:id', authorize(['admin']), deleteHousekeeping);
module.exports = router;
