// A queued action belongs to the room state the staff member reviewed. Known
// versions must still match; legacy records fall back to the action's fields.
export function roomActionMatches(original, current, signature) {
  if (!current || current._id !== original._id) return false;
  const originalTime = Date.parse(original.updatedAt);
  if (Number.isFinite(originalTime) && Date.parse(current.updatedAt) !== originalTime) return false;
  return signature(original) === signature(current);
}

// Keep bulk actions responsive without sending an entire board to the API at
// once. Preserve input order so each result can be reported for its room.
export async function settleRoomActions(rooms, action) {
  const results = new Array(rooms.length);
  let next = 0;
  const worker = async () => {
    while (next < rooms.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await action(rooms[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, rooms.length) }, worker));
  return results;
}
