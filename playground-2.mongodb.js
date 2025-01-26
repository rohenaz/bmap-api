/* global use, db */
// MongoDB Playground
// Use Ctrl+Space inside a snippet or a string literal to trigger completions.

// The current database to use.
use('bmap');

// Search for documents in the current collection.
db.getCollection('message')
  .find(
    {
      'tx.h': '471995821a1d4485a07e04868205469c22e93cba289ae5092d214f6a111a9c59',
    },
    {
      /*
      * Projection
      * _id: 0, // exclude _id
      * fieldA: 1 // include field
      */
    }
  )
  .sort({
    /*
    * fieldA: 1 // ascending
    * fieldB: -1 // descending
    */
  });
