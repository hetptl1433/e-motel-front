const router = require('express').Router();
const auth = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const upload = require('../middleware/upload');
const { listRooms, updateStatus, checkoutRoom, createRoom, getRoomsByDate } = require('../controllers/roomController');
const { uploadReport } = require('../controllers/reportController');
const { importToHousekeeping, importHousekeepingArray, listHousekeeping } = require('../controllers/housekeeperController');
const readers = ['housekeeping', 'frontdesk', 'admin'];

router.use(auth);
router.get('/', authorize(readers), listRooms);
router.get('/status/:date', authorize(readers), getRoomsByDate);
router.post('/upload-report', authorize(['frontdesk', 'admin']), upload.single('report'), uploadReport);

// Keep existing dashboard URLs functional while sharing one safe, date-scoped importer.
router.post('/import-to-housekeeping', authorize(['admin', 'frontdesk']), importToHousekeeping);
router.post('/importhousekeeping', authorize(['admin', 'frontdesk']), importHousekeepingArray);
router.get('/housekeeper', authorize(readers), listHousekeeping);
router.post('/', authorize(['admin']), createRoom);
router.post('/:id/checkout', authorize(['frontdesk', 'admin']), checkoutRoom);
router.put('/:id', authorize(readers), updateStatus);
module.exports = router;
