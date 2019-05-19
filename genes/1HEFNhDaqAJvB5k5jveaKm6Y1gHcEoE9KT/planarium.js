var bcode = require('bcode')
module.exports = {
  planarium: '0.0.1',
  query: {
    web: {
      v: 3,
      q: { find: {}, limit: 10 }
    },
    api: {
      timeout: 50000,
      sort: {
        "blk.i": -1
      },
      concurrency: { aggregate: 7 },
    },
    log: true
  },
  socket: {
    web: {
      v: 3,
      q: { find: {} }
    },
    api: {},
    topics: ["c", "u"]
  },
  transform: {
    request: bcode.encode,
    response: bcode.decode
  },
  url: "mongodb://localhost:27020",
  port: 3000,
}
