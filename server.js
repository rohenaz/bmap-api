// Planarium
const { planarium } = require('neonplanaria')
const bitquery = require('bitquery')
planarium.start({
  name: 'BMAP',
  port: 3000,
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