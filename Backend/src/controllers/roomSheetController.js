const Report = require('../models/RoomReport');
const { parseReportDate, dateRange, sendError } = require('../utils/roomData');
const { reportsDirectory, buildRoomSheetPDF } = require('../utils/roomSheetPDF');
const { createLocalReportStorage, createMongoReportStorage } = require('../utils/reportStorage');

function createRoomSheetHandlers({ ReportModel = Report, storageDirectory = reportsDirectory, vercel = process.env.VERCEL === '1', sourceStorage = vercel ? createMongoReportStorage() : createLocalReportStorage({ directory: storageDirectory }) } = {}) {
  const getRoomSheets = async (req, res) => {
    try {
      const date = req.query.date;
      parseReportDate(date);
      const resources = [];
      const original = await sourceStorage.getOriginal(date);
      if (original) resources.push({
        public_id: `room_sheet_${date}_original`, display_name: `Original Super 8 report - ${date}`,
        secure_url: `/room-sheets/${date}/download`, format: 'pdf', source: sourceStorage.kind,
        bytes: original.bytes, created_at: new Date(original.createdAt).toISOString()
      });
      const count = await ReportModel.countDocuments({ reportDate: dateRange(date) });
      if (count) resources.push({
        public_id: `room_sheet_${date}_current`, display_name: `Current room statuses - ${date}`,
        secure_url: `/room-sheets/${date}/generated`, format: 'pdf', source: 'local'
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json(resources);
    } catch (error) { return sendError(res, error, 'Unable to load room sheets'); }
  };
  const getGeneratedRoomSheet = async (req, res) => {
    try {
      const date = req.params.date;
      parseReportDate(date);
      const reports = await ReportModel.find({ reportDate: dateRange(date) }).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).lean();
      // Older imports may predate idempotent upserts. Show one current row per room.
      const unique = new Map();
      for (const report of reports) if (!unique.has(report.room)) unique.set(report.room, report);
      const rooms = [...unique.values()];
      if (!rooms.length) return res.status(404).json({ success: false, message: 'No room report is available for this date' });
      const pdf = buildRoomSheetPDF(rooms, date);
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="room_sheet_${date}_current.pdf"`, 'Cache-Control': 'private, no-store' });
      return res.send(pdf);
    } catch (error) { return sendError(res, error, 'Unable to generate room sheet'); }
  };
  const getRoomSheetDownload = async (req, res) => {
    try {
      const date = req.params.date;
      parseReportDate(date);
      const original = await sourceStorage.getOriginal(date, { includeBuffer: true });
      if (!original) return getGeneratedRoomSheet(req, res);
      res.set('Cache-Control', 'private, no-store');
      if (original.buffer) {
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="room_sheet_${date}_original.pdf"`, 'Content-Length': String(original.buffer.length) });
        return res.send(original.buffer);
      }
      return res.download(original.filename, `room_sheet_${date}_original.pdf`, error => {
        if (error && !res.headersSent) sendError(res, error, 'Unable to download room sheet');
      });
    } catch (error) { return sendError(res, error, 'Unable to download room sheet'); }
  };
  return { getRoomSheets, getGeneratedRoomSheet, getRoomSheetDownload };
}

module.exports = { ...createRoomSheetHandlers(), createRoomSheetHandlers };
