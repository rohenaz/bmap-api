// Let's examine identity data in the database
// Switch to the database
use('bmap');

// First, let's look at a sample identity record
db.identity.findOne();

// Count total identities
db.identity.countDocuments();

// Look for a specific BAP ID
const bapId = 'Go8vCHAa4S6AhXKTABGpANiz35J';
db.identity.find({
  $or: [
    { "AIP.address": bapId },
    { "MAP.sender": bapId }
  ]
}).pretty();

// Check if we have any identity transactions for this BAP ID
db.identity.find({
  $or: [
    { "AIP.address": bapId },
    { "MAP.sender": bapId }
  ]
}).sort({ "blk.i": -1 }).limit(1).pretty();

// Look at the most recent identity records
db.identity.find().sort({ "blk.i": -1 }).limit(5).pretty();

// Check if we have any identity records with specific MAP fields
db.identity.find({
  "MAP.app": "identity",
  "MAP.type": "identity"
}).sort({ "blk.i": -1 }).limit(5).pretty();

// Check if we have any BAP protocol records
db.identity.find({
  "BAP": { $exists: true }
}).sort({ "blk.i": -1 }).limit(5).pretty();

// Look for any records with name or avatar fields
db.identity.find({
  $or: [
    { "MAP.name": { $exists: true } },
    { "MAP.avatar": { $exists: true } }
  ]
}).sort({ "blk.i": -1 }).limit(5).pretty();

// Check indexes on the identity collection
db.identity.getIndexes();

// Analyze query performance
db.identity.find({
  $or: [
    { "AIP.address": bapId },
    { "MAP.sender": bapId }
  ]
}).explain("executionStats"); 