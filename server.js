// Planarium
const { planarium } = require('neonplanaria')
const bitquery = require('bitquery')
const cors = require('cors')
const winston = require('winston')

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'planarium' },
  transports: [
    // - Write to all logs with level `info` and below to `combined.log` 
    // - Write all logs error (and below) to `error.log`.
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
})

planarium.start({
  name: 'BMAP',
  port: 80,
  custom: function(e) {
    e.app.use(cors())
    e.app.get('/ping', function(req, res) {
      logger.log({
        level: 'info',
        message: 'Referrer: ' + req.get('Referrer')
      })
      res.write("Pong")
      res.end()
    })
  },
  onstart: async function() {
    if (process.env.NODE_ENV !== 'production') {
      logger.add(new winston.transports.Console({
        format: winston.format.simple()
      }))
    }
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