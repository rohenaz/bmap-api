// Planarium
const { planarium } = require('neonplanaria')
const bitquery = require('bitquery')
const cors = require('cors')
const winston = require('winston')
const bsv = require('bsv')
const mingo = require('mingo')

const id = 'bmap'

// Set up local filesystem logs
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

// all events
const defaultb64 = 'ewogICJ2IjogMywKICAicSI6IHsKICAgICJmaW5kIjoge30sCiAgICAibGltaXQiOiAxMAogIH0KfQ=='
let connections = { pool: {} }

planarium.start({
  name: 'BMAP',
  port: 80,
  custom: function(e) {
    e.app.use(cors())
    e.app.use(function (req, res, next) {
      res.sseSetup = function() {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
          "Connection": "keep-alive",
        })
        let data = { type: "open", data: [] }
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }
      next()
    })
    e.app.get("/s/:b64(*)", function(req, res) {
      try {

        // bitcoin address as fingerprint
        const privateKey = new bsv.PrivateKey()
        const fingerprint = privateKey.toAddress().toString()

        let b64 = req.params.b64 ? req.params.b64 : defaultb64
        res.sseSetup(b64)
        let json = Buffer.from(b64, "base64").toString()
        let query = JSON.parse(json)

        res.$fingerprint = fingerprint
        connections.pool[fingerprint] = { res: res, query: query }
        console.log("## Opening connection from: " + fingerprint)
        console.log("## Pool size is now", Object.keys(connections.pool).length)
        console.log(JSON.stringify(req.headers, null, 2))

        req.on("close", function() {
          console.log("## Closing connection from: " + res.$fingerprint)
          console.log(JSON.stringify(req.headers, null, 2))
          delete connections.pool[res.$fingerprint]
          console.log(".. Pool size is now", Object.keys(connections.pool).length)
        })

        process.on('message', async (m, socket) => {
          if (m === 'socket') {
            if (socket) {
              // Check that the client socket exists.
              // It is possible for the socket to be closed between the time it is
              // sent and the time it is received in the child process.
              // socket.end(`Request handled with ${process.argv[2]} priority`)
              console.log('socket')
            }
          } else {
            // Lookup the query in the db
            // TODO - filter the results without connecting to mongo
            if (req.params.b64) {
              // console.log("\n\nFILTER PROVIDED. FILTER FOR QUERY:", query, '\n\n')

              try {
                if (query.q && query.q.find) {
                  let cursor = mingo.find([m], query.q.find)
                  let items = cursor.all()
                  if (items.length) {
                    let t = {
                      type: 't',
                      data: items[0]
                    }
                    res.write(`data: ${JSON.stringify(t)}\n\n`)
                  }
                } else {
                  console.log('\n\nSOCKET: NO MATCH\n\n')
                }
              } catch (e) {
                console.log('failed', e)
              }
              return
            }

            // No db lookup, just send it
            let data = { type: 't', data: m }
            res.write(`data: ${JSON.stringify(data)}\n\n`)
          }
        })
      } catch (e) {
        console.log(e)
      }
    })
    e.app.get('/ping', async (req, res) => {
      if (req.get('Referrer')) {
        logger.log({
          level: 'info',
          message: 'Referrer: ' + req.get('Referrer')
        })
      }

      res.write(JSON.stringify({Pong: req.get('Referrer')}))
      res.end()
    })

  },
  onstart: async function() {
    if (process.env.NODE_ENV !== 'production') {
      logger.add(new winston.transports.Console({
        format: winston.format.simple()
      }))
    }
    let db = await bitquery.init({ url: 'mongodb://localhost:27017', address: id })
    return { db: db }
  },
  onquery: function(e) {
    let code = Buffer.from(e.query, 'base64').toString()
    let req = JSON.parse(code)
    if (req.q && req.q.find) {
      e.core.db.read(id, req).then(function(result) {
        e.res.json(result)
      })
    } else {
      e.res.json([])
    }
  }
})