import chalk from 'chalk'
import mongo from 'mongodb'

const MongoClient = mongo.MongoClient
let client: mongo.MongoClient = null
let db: mongo.Db = null

const getDbo = async () => {
  if (db) {
    return db
  } else {
    try {
      console.log(chalk.bgYellow(`Connecting to ${process.env.MONGO_URL}`))
      //client = await MongoClient.connect(process.env.MONGO_URL, {
      client = await MongoClient.connect(`mongodb://127.0.0.1:27017/bmap`, {
        minPoolSize: 1,
        maxPoolSize: 10,
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
    try {
      await client.close()
    } catch (e) {
      console.error('Failed to close DB')
      return
    }
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
