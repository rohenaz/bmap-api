/* global db */

// Collections needing block height indexes
const collectionsNeedingBlockIndex = ['follow', 'unfollow', 'unlike', 'like', 'friend'];

// Collections needing timestamp and app indexes
const collectionsNeedingTimeAppIndexes = ['follow', 'unfollow', 'unlike', 'like', 'repost', 'friend', 'ord'];

// Create block height indexes
print('Creating block height indexes...');
collectionsNeedingBlockIndex.forEach(collection => {
  try {
    db[collection].createIndex({ 'blk.i': -1 }, { 
      background: true,
      name: 'blk.i_-1'
    });
    print(`✓ Created block height index for ${collection}`);
  } catch (e) {
    print(`✗ Error creating block height index for ${collection}: ${e.message}`);
  }
});

// Create timestamp and app+timestamp indexes
print('\nCreating timestamp and app indexes...');
collectionsNeedingTimeAppIndexes.forEach(collection => {
  try {
    // Simple timestamp index
    db[collection].createIndex({ timestamp: -1 }, {
      background: true,
      name: 'timestamp_-1'
    });
    print(`✓ Created timestamp index for ${collection}`);

    // Compound app+timestamp index
    db[collection].createIndex({ 
      'MAP.app': 1,
      timestamp: -1 
    }, {
      background: true,
      name: 'MAP.app_1_timestamp_-1'
    });
    print(`✓ Created app+timestamp index for ${collection}`);
  } catch (e) {
    print(`✗ Error creating indexes for ${collection}: ${e.message}`);
  }
});

print('\nIndex creation complete. Run db.collection.getIndexes() to verify.'); 