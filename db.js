const MongoClient = require('mongodb').MongoClient
let client
exports.getDbo = async () => {
  try {
    client = await MongoClient.connect(process.env.MINERVA_MONGO_URL, {
      useUnifiedTopology: true,
      useNewUrlParser: true,
    })
    return client.db('bmap')
  } catch (e) {
    throw e
  }
}

exports.closeDb = async () => {
  if (client) {
    client.close()
  }
}
