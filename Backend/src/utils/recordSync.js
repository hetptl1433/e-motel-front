const { recordChanged } = require('./roomData');

const revisionFields = ['room', 'roomNumber', 'reportDate', 'housekeepingStatus', 'occupancyStatus', 'guestStatus', 'checkIn', 'checkOut', 'checkedOutAt', 'stayoverServicedAt', 'orderStatus', 'notes', 'assignedAttendant'];

function sameValue(first, second) {
  if (first == null && second == null) return true;
  if (first instanceof Date || second instanceof Date) return new Date(first).getTime() === new Date(second).getTime();
  return first === second;
}

function sameRevision(first, second) {
  return Boolean(first && second) && sameValue(first.updatedAt, second.updatedAt)
    && revisionFields.every(field => sameValue(first[field], second[field]));
}

// Read the destination before checking the source. A newer mutation that lands
// during synchronization then invalidates either the source check or target CAS.
// Never repeat a stale patch blindly against the latest destination record.
async function synchronizeRecord({ SourceModel, TargetModel, source, filter, changesFor, initial, canApply = () => true, attempts = 3 }) {
  const data = [];
  const completed = new Set();
  let changed = false;
  const verifySource = async () => {
    if (!sameRevision(source, await SourceModel.findById(source._id))) throw recordChanged();
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const targets = await TargetModel.find(filter);
    await verifySource();
    if (!targets.length) {
      if (!initial) return { data, changed };
      // Insert only: an existing record that appears meanwhile must retain its
      // staff progress. The following iteration treats it as a normal CAS target.
      try {
        // A deterministic insert ID gives simultaneous repairs the existing
        // Mongo _id uniqueness guarantee, without changing legacy record IDs.
        const result = await TargetModel.updateOne({ ...filter, _id: source._id }, { $setOnInsert: {
          ...initial, createdAt: new Date(), updatedAt: source.updatedAt || new Date()
        } }, { upsert: true, runValidators: true, timestamps: false });
        changed ||= Boolean(result.upsertedCount);
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
      continue;
    }
    let conflicted = false;
    for (const target of targets) {
      if (completed.has(String(target._id))) continue;
      const proposed = changesFor(target);
      const changes = Object.fromEntries(Object.entries(proposed).filter(([field, value]) => !sameValue(target[field], value)));
      if (!Object.keys(changes).length) {
        completed.add(String(target._id));
        data.push(target);
        continue;
      }
      const sourceTime = new Date(source.updatedAt).getTime();
      const targetTime = new Date(target.updatedAt).getTime();
      if (targetTime > sourceTime || !canApply(target, changes)) throw recordChanged();
      await verifySource();
      const updated = await TargetModel.findOneAndUpdate(
        { _id: target._id, updatedAt: target.updatedAt ?? null },
        { $set: changes }, { new: true, runValidators: true }
      );
      if (!updated) { conflicted = true; continue; }
      changed = true;
      completed.add(String(target._id));
      data.push(updated);
    }
    await verifySource();
    if (!conflicted) return { data, changed };
  }
  throw recordChanged();
}

module.exports = { sameValue, sameRevision, synchronizeRecord };
