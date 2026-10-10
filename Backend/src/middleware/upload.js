const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { LOCAL_REPORT_BYTES, VERCEL_REPORT_BYTES } = require('../utils/reportLimits');

const uploadsDir = path.join(__dirname, '../../uploads');

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.pdf', '.csv', '.json'].includes(ext)) {
    cb(null, true);
  } else {
    const error = new Error('Only PDF, CSV, and JSON reports are allowed');
    error.status = 400;
    cb(error, false);
  }
};

function createReportUpload({ vercel = process.env.VERCEL === '1' } = {}) {
  let storage;
  if (vercel) storage = multer.memoryStorage();
  else {
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    storage = multer.diskStorage({
      destination(req, file, cb) { cb(null, uploadsDir); },
      filename(req, file, cb) { cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`); }
    });
  }
  const upload = multer({ storage, fileFilter, limits: { fileSize: vercel ? VERCEL_REPORT_BYTES : LOCAL_REPORT_BYTES, files: 1, fields: 5, parts: 6 } });

// Keep existing upload.single('report') callers, but return JSON errors that
// the upload form can show instead of Express's HTML error page.
  const multerSingle = upload.single.bind(upload);
  upload.single = field => {
    const middleware = multerSingle(field);
    return (req, res, next) => middleware(req, res, error => {
      if (!error) return next();
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        success: false,
        message: error.code === 'LIMIT_FILE_SIZE' ? `Report files must be ${vercel ? 4 : 10} MB or smaller` : error.code === 'LIMIT_UNEXPECTED_FILE' ? 'Upload one report file using the report field' : error.message
      });
    });
  };
  return upload;
}

module.exports = createReportUpload();
module.exports.createReportUpload = createReportUpload;
