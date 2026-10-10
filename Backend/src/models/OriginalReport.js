const mongoose = require('mongoose');
const { VERCEL_REPORT_BYTES } = require('../utils/reportLimits');

const originalReportSchema = new mongoose.Schema({
  // The date is also the document ID: its built-in unique index protects
  // concurrent cold starts before any secondary index has finished building.
  _id: { type: String, required: true },
  reportDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, unique: true },
  data: { type: Buffer, required: true, validate: value => value.length > 0 && value.length <= VERCEL_REPORT_BYTES },
  bytes: { type: Number, required: true, min: 1, max: VERCEL_REPORT_BYTES },
  contentType: { type: String, default: 'application/pdf', enum: ['application/pdf'] }
}, { timestamps: true, collection: 'originalreports' });

module.exports = mongoose.model('OriginalReport', originalReportSchema);
