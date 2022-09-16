import mongo from 'mongodb'

const MongoClient = mongo.MongoClient
let client = null
let db = null

const getDbo = async () => {
  if (db) {
    return db
  } else {
    try {
      client = await MongoClient.connect(process.env.MONGO_URL, {
        poolSize: 10,
        useUnifiedTopology: true,
        useNewUrlParser: true,
      })
      db = client.db('bmap')
      return db
    } catch (e) {
      throw e
    }
  }
}

const closeDb = async () => {
  if (client !== null) {
    await client.close()
    client = null
  }
}

export { closeDb, getDbo }

// db.c.createIndex({
//   "MAP.app": 1,
//   "MAP.type": 1,
// })

// db.c.createIndex({
//   "MAP.app": 1,
//   "MAP.type": 1,
//   "blk.t": -1,
// })

// db.c.createIndex({
//   "MAP.app": 1,
//   "MAP.type": 1,
//   "blk.i": -1,
// })
