const mongoose = require('mongoose');

const reportImportLockSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  reportDate: { type: String, required: true, unique: true },
  ownerToken: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { collection: 'reportimportlocks' });

// Expiry is checked during acquisition; TTL only removes abandoned rows later.
reportImportLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('ReportImportLock', reportImportLockSchema);
