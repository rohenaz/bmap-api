const { planaria } = require('neonplanaria')
const MongoClient = require('mongodb')
const path = require('path')
const bmap = require('bmapjs')
var db
var kv
// Filter non BMAP txs. 
// Returns bmap versions of each tx
// Also supports compact mode for socket responses
var bmapTransform = function (items) {
  let newItems = []
  console.log('transform', items.length, 'items')
  items.forEach((item) => {
    let bmapItem = bmap.TransformTx(item)
    if (bmapItem && (bmapItem.hasOwnProperty('B') || bmapItem.hasOwnProperty('MAP'))) {
      console.log('Storing BMAP', bmapItem.B['content-type'])
      delete bmapItem.in
      delete bmapItem.out
      newItems.push(bmapItem)
    }
  })
  return newItems
}

const connect = function(cb) {
  MongoClient.connect('mongodb://localhost:27017', {useNewUrlParser: true}, function(err, client) {
    if (err) {
      console.log('DB Error. retrying...')
      setTimeout(function() {
        connect(cb)
      }, 1000)
    } else {
      db = client.db("planaria")
      cb()
    }
  })
}
planaria.start({
  filter: {
    "from": 570000,
    "q": {
      "find": { "out.s1": { "$in": ["19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut", "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5"] } }
    }
  },
  onmempool: async function(e) {
    let bmaps = bmapTransform([e.tx])
    await db.collection("u").insertMany(bmaps)
  },
  onblock: async function(e) {
    let bmaps = bmapTransform(e.tx)
    await db.collection("c").insertMany(bmaps)
  },
  onstart: function(e) {
    return new Promise(async function(resolve, reject) {
      if (!e.tape.self.start) {
        await planaria.exec("docker", ["pull", "mongo:4.0.4"])
        await planaria.exec("docker", ["run", "-d", "-p", "27017-27019:27017-27019", "-v", process.cwd() + "/db:/data/db", "mongo:4.0.4"])
      }
      connect(function() {
        if (e.tape.self.start) {
          db.collection("c").deleteMany({
            "blk.i": { "$gt": e.tape.self.end }
          }).then(resolve)
        } else {
          resolve()
        }
      })
    })
  },
})