const { planaria } = require('neonplanaria')
const MongoClient = require('mongodb')
const path = require('path')
const bmap = require('bmapjs')
const winston = require('winston')
let db

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'planaria' },
  transports: [
    //
    // - Write to all logs with level `info` and below to `combined.log` 
    // - Write all logs error (and below) to `error.log`.
    //
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log', options: { flags: 'w' } })
  ]
})

// Filter non BMAP txs. 
// Returns bmap versions of each tx
const bmapTransform = async function (items) {
  let newItems = []

  await items.forEach(async (item) => {
    try {
      let bmapItem = await bmap.TransformTx(item)
      if (!bmapItem) {
        logger.log({level: 'error', message: 'failed to transform this ' + bmapItem })
        return []
      }

      // protocol whitelist
      let list = ['AIP', 'B', 'BITCOM', 'BITPIC', 'BITKEY', 'HAIP', 'MAP', 'METANET', 'RON', 'SYMRE', '$']

      let hasSupportedProtocol = Object.keys(bmapItem).some((k) => { return list.indexOf(k) !== -1 })
      if (bmapItem && hasSupportedProtocol) {
        logger.log({ level: 'info', message: 'Storing BMAP ' + bmapItem.tx.h })
        newItems.push(bmapItem)
      }
    } catch (e) {
      logger.log({
        level: 'error',
        message: 'tx: ' + item.tx.h + ' e: ' + e
      })    
    }
  })
  return newItems
}

const connect = function(cb) {
  MongoClient.connect('mongodb://localhost:27017', {useNewUrlParser: true}, function(err, client) {
    if (err) {
      logger.log({ level: 'info', message: 'db retrying...' })
      setTimeout(function() {
        connect(cb)
      }, 1000)
    } else {
      db = client.db('bmap')
      cb()
    }
  })
}
planaria.start({
  filter:  {
    "from": 585000,
    "host": {
      "bitbus": "https://bob.bitbus.network"
    },
    "q": {
      "find": { 
        "out.tape.cell.s": { 
          "$in": ["1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5", "13SrNDkVzY5bHBRKNu5iXTQ7K7VqTh5tJC", "18pAqbYqhzErT6Zk3a5dwxHtB9icv8jH2p", "1GvFYzwtFix3qSAZhESQVTz9DeudHZNoh1", "$"] 
        }
      },
      "project": { "out": 1, "tx": 1, "blk": 1, "in": 1}
    }
  },
  onmempool: async function(e) {
    try {
      let bmaps = await bmapTransform([e.tx])
      if (bmaps.length > 0) {
        await db.collection("u").insertMany(bmaps)
      } else {
        logger.log({ level: 'info', message: 'no bmaps ####### ' + bmaps })
      }
    } catch (e) {
      logger.log({ level: 'error', message: 'onmempool: error transforming ' + e })
    }
  },
  onblock: async function(e) {
    return new Promise(async (resolve, reject) => {

      let bmaps
      try {
        bmaps = await bmapTransform(e.tx)
      } catch (e) {
        logger.log({ level: 'error', message: 'onblock: error transforming ' + e })
      }
      if (bmaps.length > 0) {
        let ids = bmaps.map((t) => {
          return t.tx.h
        })
        console.log('delete c')
        await db.collection("c").deleteMany({
          "tx.h": {
            "$in": ids
          }
        })

        console.log("inserting", bmaps.length)
        try {
          await db.collection("c").insertMany(bmaps)
        } catch (err) {
          logger.log({ level: 'info', message: 'error saving on block: ' + err + ' items: ' + bmaps.length })      
        }
    
        // if (e.mem.length) {
        //   let bmapsMem = bmapTransform(e.mem)
        //   await db.collection("u").insertMany(bmapsMem)
        // }
        // console.log("inserted u", bmapsMem)

      } else {
        logger.log({ level: 'info', message: 'no bmaps ####### ' + bmaps })
      }

      console.log("block End", e.height)
      db.collection("u").deleteMany({}).then(() => {
        resolve()
      })
    })
  },
  onstart: function(e) {
    if (process.env.NODE_ENV !== 'production') {
      logger.add(new winston.transports.Console({
        format: winston.format.simple()
      }))
    }
    return new Promise(async function(resolve, reject) {
      if (!e.tape.self.start) {
        logger.log({ level: 'info', message: 'Starting mongodb via docker. Platform ' + process.platform})
        await planaria.exec("docker", ["pull", "mongo:4.0.4"])

        try {
          await planaria.exec("docker", ["run", "-d", "-p", "27017-27019:27017-27019", "-v", process.cwd() + "/db:/data/db", "mongo:4.0.4"])
        } catch (e) {
          logger.log({ level: 'error', message: 'Failed to start docker container for mongodb: ' + e})
        }        
      }
      connect(async () => {
        console.log("creating index")
        await db.collection("c").createIndex({"tx.h": 1}, { unique: true})
        await db.collection("c").createIndex({"blk.i": 1})
        await db.collection("c").createIndex({"MAP.app": 1})
        await db.collection("c").createIndex({"BITPIC": 1})
        await db.collection("u").createIndex({"tx.h": 1}, { unique: true})
        await db.collection("u").createIndex({"MAP.app": 1})
        await db.collection("u").createIndex({"BITPIC": 1})
        logger.log({ level: 'info', message: 'Connected' })
        if (e.tape.self.start) {
          await db.collection("c").deleteMany({
            "blk.i": { "$gt": e.tape.self.end }
          })
          resolve()
        } else {
          resolve()
        }
      })
    })
  },
})