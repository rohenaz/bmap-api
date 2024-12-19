// Switch to the database
use('bmap');

// Look at a sample document to understand the structure
db.like.findOne();

// Look at any document with MAP field
db.like.findOne({ MAP: { $exists: true } });

// Look at the structure of MAP field
db.like.aggregate([
  { $match: { MAP: { $exists: true } } },
  { $project: { _id: 0, MAP: 1 } },
  { $limit: 5 },
]);

// Look for any likes with any structure
db.like
  .find({
    $or: [{ 'MAP.type': 'like' }, { 'MAP.0.type': 'like' }],
  })
  .limit(5)
  .pretty();

// Check if MAP is sometimes an array
db.like.findOne({
  'MAP.0': { $exists: true },
});

// Look for likes with tx field in different positions
db.like
  .find({
    $or: [{ 'MAP.tx': { $exists: true } }, { 'MAP.0.tx': { $exists: true } }],
  })
  .limit(5)
  .pretty();

// Count documents with different MAP structures
db.like.aggregate([
  {
    $facet: {
      mapObject: [{ $match: { 'MAP.type': 'like' } }, { $count: 'count' }],
      mapArray: [{ $match: { 'MAP.0.type': 'like' } }, { $count: 'count' }],
    },
  },
]);
