import mongoose from 'mongoose';

export function pagination(query = {}) {
  const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (query.cursor && (typeof query.cursor !== 'string' || !mongoose.isValidObjectId(query.cursor)))) return null;
  return { limit, filter: query.cursor ? { _id: { $lt: new mongoose.Types.ObjectId(query.cursor) } } : {} };
}
export function pageResults(records, limit, total) {
  const more = records.length > limit;
  const data = records.slice(0, limit);
  return { data, pagination: { limit, total, nextCursor: more ? String(data.at(-1)._id) : null } };
}
