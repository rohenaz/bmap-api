import * as mongo from 'mongodb'

const MongoClient = mongo.MongoClient
let client = null

const getDbo = async () => {
  if (client) {
    return client.db('bmap')
  } else {
    try {
      client = await MongoClient.connect(process.env.MONGO_URL, {
        poolSize: 10,
        useUnifiedTopology: true,
        useNewUrlParser: true,
      })
      return client.db('bmap')
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

