import * as mongo from 'mongodb'

const MongoClient = mongo.MongoClient
let client

const getDbo = async () => {
  try {
    client = await MongoClient.connect(process.env.MONGO_URL, {
      useUnifiedTopology: true,
      useNewUrlParser: true,
    })
    return client.db('bmap')
  } catch (e) {
    throw e
  }
}

const closeDb = async () => {
  if (client) {
    client.close()
  }
}

export { closeDb, getDbo }
