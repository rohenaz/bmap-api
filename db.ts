import chalk from 'chalk'
import mongo from 'mongodb'

const MongoClient = mongo.MongoClient
let client: mongo.MongoClient = null
let db: mongo.Db = null

type State = {
  _id: string
  height: number
}

const getDbo = async () => {
  if (db) {
    return db
  } else {
    try {
      console.log(chalk.bgYellow(`Connecting to ${process.env.BMAP_MONGO_URL}`))
      client = await MongoClient.connect(process.env.BMAP_MONGO_URL, {
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

async function getCollectionCounts(
  timestamp: number
): Promise<Record<string, number>> {
  const dbo = await getDbo()
  const collections = await dbo.listCollections().toArray()

  const countPromises = collections.map(async (c) => {
    const query = timestamp ? { timestamp: { $gt: timestamp } } : {}
    // const count = await dbo.collection(c.name).countDocuments(query)
    const count = await dbo.collection(c.name).estimatedDocumentCount()
    return [c.name, count]
  })

  const countsArray = await Promise.all(countPromises)
  const countsObject = Object.fromEntries(countsArray)

  return countsObject as Record<string, number>
}

async function getCurrentBlockHeight(): Promise<number> {
  const dbo = await getDbo()
  const state = await getState()
  return state ? state.height : 0
}

async function getState(): Promise<State | undefined> {
  const dbo = await getDbo()
  return await dbo.collection('_state').findOne<State>({})
}

export { closeDb, getCollectionCounts, getCurrentBlockHeight, getDbo, getState }

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
