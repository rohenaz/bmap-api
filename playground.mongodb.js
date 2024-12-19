/* global use, db */
// MongoDB Playground
use('bmap');

// Show indexes for our main collections
print('\n=== Bitcoin Schema Collection Indexes ===');
const collections = [
  'follow',
  'unfollow',
  'unlike',
  'like',
  'message',
  'repost',
  'friend',
  'post',
  'ord',
];

// Get collection stats and indexes
for (const collection of collections) {
  const coll = db.getCollection(collection);
  if (coll) {
    try {
      const stats = coll.stats();
      const indexes = coll.getIndexes();

      print(`\n=== ${collection} ===`);
      print('Indexes:');
      printjson(indexes);

      print('\nStats:');
      print(`Documents: ${stats.count}`);
      print(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      print(`Average document size: ${(stats.avgObjSize / 1024).toFixed(2)} KB`);

      if (stats.indexSizes) {
        print('\nIndex Sizes:');
        for (const [indexName, size] of Object.entries(stats.indexSizes)) {
          print(`${indexName}: ${(size / 1024 / 1024).toFixed(2)} MB`);
        }
      }

      // Analyze a sample query using block height index
      print('\nQuery Analysis (block height index):');
      const explain = coll
        .find({
          'blk.i': { $gt: 875000 },
        })
        .explain('executionStats');

      if (explain.executionStats) {
        print(`Execution time: ${explain.executionStats.executionTimeMillis}ms`);
        print(`Documents examined: ${explain.executionStats.totalDocsExamined}`);
        print(`Documents returned: ${explain.executionStats.nReturned}`);
        if (explain.executionStats.executionStages.stage === 'COLLSCAN') {
          print('WARNING: Collection scan detected - consider adding an index');
        }
      }
    } catch (e) {
      print(`Error analyzing ${collection}: ${e.message}`);
    }
  }
}
