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
  fromTimestamp: number
): Promise<Record<string, number>[]> {
  const dbo = await getDbo()
  const collections = await dbo.listCollections().toArray()

  const countPromises = collections.map(async (c) => {
    let count = 0

    if (fromTimestamp) {
      const query = { timestamp: { $gt: fromTimestamp } }
      count = await dbo.collection(c.name).countDocuments(query)
    } else {
      count = await dbo.collection(c.name).estimatedDocumentCount()
    }
    return [c.name, count]
  })

  const countsArray = await Promise.all(countPromises)
  return Object.fromEntries(countsArray) as Record<string, number>[]
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
