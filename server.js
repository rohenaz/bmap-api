// Planarium
const { planarium } = require('neonplanaria')
const bitquery = require('bitquery')
const cors = require('cors')

planarium.start({
  name: 'BMAP',
  port: 80,
  custom: function(e) {
    e.app.use(cors())
  },
  onstart: async function() {
    let db = await bitquery.init({ url: 'mongodb://localhost:27017', address: 'planaria' })
    return { db: db }
  },
  onquery: function(e) {
    let code = Buffer.from(e.query, 'base64').toString()
    let req = JSON.parse(code)
    if (req.q && req.q.find) {
      e.core.db.read('planaria', req).then(function(result) {
        e.res.json(result)
      })
    } else {
      e.res.json([])
    }
  }
})