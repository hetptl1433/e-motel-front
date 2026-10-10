const fs = require('fs/promises');
const path = require('path');
const Report = require('../models/RoomReport');
const { parseReportDate, dateRange, invalid, emitMutation, sendError } = require('../utils/roomData');
const { parseCSV, parseJSON, prepareRooms } = require('../utils/reportImport');
const { parseRoomPDF } = require('../utils/pdfRoomParser');
const { reportsDirectory } = require('../utils/roomSheetPDF');
const { syncReportMetadata } = require('../utils/housekeepingSync');
const { createLocalReportStorage, createMongoReportStorage } = require('../utils/reportStorage');
const { createLocalImportLocks, createMongoImportLocks } = require('../utils/reportImportLock');
const { LOCAL_REPORT_BYTES, VERCEL_REPORT_BYTES, reportSizeError } = require('../utils/reportLimits');

const importsInProgress = new Set();

// Dependencies are injectable so the whole workflow can be verified offline.
function createUploadReport({ ReportModel = Report, extractPDF = parseRoomPDF, storageDirectory = reportsDirectory, syncMetadata = syncReportMetadata, vercel = process.env.VERCEL === '1', sourceStorage = vercel ? createMongoReportStorage() : createLocalReportStorage({ directory: storageDirectory }), importLocks = vercel ? createMongoImportLocks() : createLocalImportLocks(importsInProgress) } = {}) {
  return async (req, res) => {
    let reportDate, lock, stagedOriginal, sendResponse;
    try {
      reportDate = req.body?.reportDate;
      parseReportDate(reportDate);
      if (!req.file) throw invalid('Select a Super 8 room report PDF, CSV, or JSON file');
      lock = await importLocks.acquire(reportDate);
      const extension = path.extname(req.file.originalname || '').toLowerCase();
      if (!['.pdf', '.csv', '.json'].includes(extension)) throw invalid('Only PDF, CSV, and JSON reports are supported');
      const buffer = Buffer.isBuffer(req.file.buffer) ? req.file.buffer : await fs.readFile(req.file.path);
      if (buffer.length > (vercel ? VERCEL_REPORT_BYTES : LOCAL_REPORT_BYTES)) throw reportSizeError(vercel);
      if (!buffer.length) throw invalid('The uploaded report is empty');
      let rawRooms;
      if (extension === '.pdf') {
        rawRooms = await extractPDF(buffer);
        const sourceDate = rawRooms.sourceReportDate || rawRooms[0]?.sourceReportDate;
        if (sourceDate !== reportDate) throw invalid(`This PDF is dated ${sourceDate || 'an unknown date'}. Select ${sourceDate || 'the report date printed in the PDF'} as the report date`);
      }
      else {
        const text = buffer.toString('utf8');
        if (text.includes('\0')) throw invalid('CSV/JSON reports must contain UTF-8 text');
        rawRooms = extension === '.csv' ? parseCSV(text) : parseJSON(text);
      }
      const rooms = prepareRooms(rawRooms, reportDate, { requireType: extension === '.pdf', strictDates: extension === '.pdf' });
      // Validate every room before the first write. A bad row cannot leave a
      // successful-looking, incomplete date in the room dashboard.
      await Promise.all(rooms.map(room => new ReportModel(room).validate()));
      const scope = { reportDate: dateRange(reportDate), room: { $in: rooms.map(room => room.room) } };
      const priorRows = await ReportModel.find(scope).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).lean();
      const currentByRoom = new Map();
      for (const prior of priorRows) if (!currentByRoom.has(prior.room)) currentByRoom.set(prior.room, prior);
      if (extension === '.pdf') {
        stagedOriginal = await sourceStorage.stageOriginal(reportDate, buffer);
      }
      await lock.assertOwned();
      await ReportModel.bulkWrite(rooms.flatMap(room => {
        const { housekeepingStatus, assignedAttendant, notes, occupancyStatus, guestStatus, ...metadata } = room;
        const existing = currentByRoom.get(room.room);
        // An old morning report must not put a guest back in a room after the
        // desk has checked them out during this shift. Test the marker at write
        // time because checkout can happen after the snapshot above was read.
        const filter = { room: room.room, reportDate: dateRange(reportDate), ...(existing ? { _id: existing._id } : {}) };
        const occupancy = { occupancyStatus, ...(guestStatus !== undefined && { guestStatus }) };
        return [{ updateOne: {
          filter,
          update: { $set: metadata, $setOnInsert: { housekeepingStatus, assignedAttendant, notes, ...occupancy } },
          upsert: !existing
        } }, { updateOne: {
          filter: { ...filter, checkedOutAt: null }, update: { $set: occupancy }, upsert: false
        } }];
      }), { ordered: true });
      if (stagedOriginal) {
        await lock.assertOwned();
        await stagedOriginal.commit();
      }
      const savedRows = await ReportModel.find(scope).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).lean();
      const latestByRoom = new Map();
      for (const saved of savedRows) if (!latestByRoom.has(saved.room)) latestByRoom.set(saved.room, saved);
      const savedRooms = [...latestByRoom.values()].sort((a, b) => a.room.localeCompare(b.room, undefined, { numeric: true }));
      const warnings = [];
      let housekeepingCreatedCount = 0, housekeepingUpdatedCount = 0;
      await lock.assertOwned();
      try {
        const sync = await syncMetadata(savedRooms, reportDate, { ensureRecords: true });
        housekeepingCreatedCount = sync.upsertedCount || 0;
        housekeepingUpdatedCount = sync.modifiedCount || 0;
        if (housekeepingCreatedCount || housekeepingUpdatedCount) emitMutation(req, 'housekeepingBulkUpdated', { action: 'reportUpload', date: reportDate, created: housekeepingCreatedCount, modified: housekeepingUpdatedCount });
      } catch (error) {
        console.error('Report saved, but housekeeping metadata could not be refreshed:', error.message);
        warnings.push('The report was saved, but the housekeeping board could not be updated. Re-upload this report to retry');
      }
      emitMutation(req, 'roomDataUpdated', { date: reportDate, count: rooms.length });
      const responseBody = {
        success: true,
        message: `${rooms.length} rooms imported successfully for ${reportDate}. Existing cleaning work, notes, and assignments were preserved.${warnings.length ? ` ${warnings.join('. ')}.` : ''}`,
        count: rooms.length,
        date: reportDate,
        data: savedRooms,
        housekeepingCreatedCount,
        housekeepingUpdatedCount,
        warnings,
        pdfUrl: `/api/room-sheets/${reportDate}/${extension === '.pdf' ? 'download' : 'generated'}`
      };
      sendResponse = () => res.json(responseBody);
    } catch (error) {
      sendResponse = () => sendError(res, error, 'Failed to import report. Please try again');
    } finally {
      if (lock) await lock.release().catch(error => console.error('Could not release report import lock:', error.code || error.name));
      if (stagedOriginal) await stagedOriginal.cleanup().catch(error => console.error('Could not remove temporary original report:', error.code || error.name));
      if (req.file?.path) await fs.unlink(req.file.path).catch(error => {
        if (error.code !== 'ENOENT') console.error('Could not remove temporary report file:', error.code);
      });
    }
    // Finishing a hosted HTTP response can end the invocation. Release the
    // shared date lease and clean up staged files before sending either result.
    return sendResponse();
  };
}

exports.uploadReport = createUploadReport();
exports.createUploadReport = createUploadReport;
