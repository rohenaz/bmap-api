import bodyParser from 'body-parser'
import chalk from 'chalk'
import cors from 'cors'
import express from 'express'
import asyncHandler from 'express-async-handler'
import mongo from 'mongodb'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { processTransaction } from './crawler.js'
import { getDbo } from './db.js'
import { ConnectionStatus } from './index.js'
import { defaultQuery } from './queries.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let connectionStatus: ConnectionStatus = ConnectionStatus.Disconnected
// let socket: net.Socket

const app = express()
app.use(bodyParser.json())

process.on('message', (data: any) => {
  console.log('message received by child!', data)
  switch (data.type) {
    case 'block':
      console.log('current block is now', data.block)
      break
    case 'socket':
      // socket = data.socket
      console.log({ socket: data.socket })
      break
    case 'status':
      console.log('Connection status changed', data.status)
      connectionStatus = data.status
      break
  }
})

const start = async function () {
  console.log(chalk.magenta('BMAP API'), chalk.cyan('initializing machine...'))

  app.set('port', process.env.PORT || 3055)
  app.set('host', process.env.HOST || 'localhost')
  app.set('view engine', 'ejs')
  app.set('views', __dirname + '/../views')
  app.use(cors())

  app.use(express.static(__dirname + '/../public'))

  app.get(
    /^\/s\/(.+)$/,
    asyncHandler(async function (req, res) {
      let b64 = req.params[0]

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      })
      res.write('data: ' + JSON.stringify({ type: 'open', data: [] }) + '\n\n')

      let json = Buffer.from(b64, 'base64').toString()

      const db = await getDbo()

      console.log(chalk.blue('New change stream subscription'))
      let query = JSON.parse(json)

      const pipeline = [
        {
          $match: {
            operationType: 'insert',
          },
        },
      ]

      Object.keys(query.q.find || {}).forEach(
        (k) => (pipeline[0]['$match'][`fullDocument.${k}`] = query.q.find[k])
      )

      const changeStream = db.collection('c').watch(pipeline)

      changeStream.on('change', (next) => {
        console.log(
          chalk.blue('New change event - pushing to SSE'),
          next.fullDocument.tx?.h
        )
        res.write(
          'data: ' +
            JSON.stringify({ type: 'push', data: [next.fullDocument] }) +
            '\n\n'
        )
      })

      req.on('close', () => {
        changeStream.close()
      })

      let lastStatus = connectionStatus
      // while (true) {
      if (lastStatus !== connectionStatus) {
        lastStatus = connectionStatus
        console.log(
          chalk.blue('New connection status event - pushing to SSE'),
          connectionStatus
        )
        res.write(
          'data: ' +
            JSON.stringify({ type: 'status', data: connectionStatus }) +
            '\n\n'
        )
      }
      // }
    })
  )

  app.get(/^\/q\/(.+)$/, function (req, res) {
    let b64 = req.params[0]
    console.log(chalk.magenta('BMAP API'), chalk.cyan('query', b64))

    mongo.MongoClient.connect(
      process.env.MONGO_URL,
      {
        useUnifiedTopology: true,
        useNewUrlParser: true,
      },
      async function (err, db) {
        if (err) throw err

        var dbo = db.db('bmap')

        let code = Buffer.from(b64, 'base64').toString()
        let req = JSON.parse(code)
        if (req.q.aggregate) {
          dbo
            .collection('c')
            .aggregate(req.q.aggregate, {
              allowDiskUse: true,
              cursor: { batchSize: 1000 },
            })
            .sort(req.q.sort || { _id: -1 })
            .limit(req.q.limit ? req.q.limit : 10)
            .toArray(function (err, c) {
              if (err) {
                res.status(500).send(err)
                return
              }
              res.send({ c })
            })
          return
        }

        dbo
          .collection('c')
          .find(req.q.find)
          .sort(req.q.sort || { _id: -1 })
          .limit(req.q.hasOwnProperty('limit') ? req.q.limit : 10)
          .project(req.q.project || { in: 0, out: 0 })
          .toArray(function (err, c) {
            if (err) {
              res.status(500).send(err)
              return
            }
            res.send({ c })
          })
      }
    )
  })

  app.get('/ping', async (req, res) => {
    if (req.get('Referrer')) {
      console.log({
        level: 'info',
        message: 'Referrer: ' + req.get('Referrer'),
      })
    }

    res.write(JSON.stringify({ Pong: req.get('Referrer') }))
    res.end()
  })

  app.get('/query', function (req, res) {
    let code = JSON.stringify(defaultQuery, null, 2)
    res.render('explorer', {
      name: 'BMAP',
      code: code,
    })
  })

  app.get(/^\/query\/(.+)$/, function (req, res) {
    let b64 = req.params[0]
    let code = Buffer.from(b64, 'base64').toString()
    res.render('explorer', {
      name: 'BMAP',
      code: code,
    })
  })

  app.post(
    '/ingest',
    asyncHandler(async function (req, res) {
      // ingest a raw tx
      console.log('ingest', req.body.rawTx)
      if (req.body.rawTx) {
        // process.send({ rawTx: req.body.rawTx, type: 'tx' })
        await processTransaction(req.body.rawTx)

        return res.status(201).send()
      } else {
        return res.status(400).send()
      }
    })
  )

  app.get('/', function (req, res) {
    res.sendFile(__dirname + '/../public/index.html')
  })

  if (app.get('port')) {
    app.listen(app.get('port'), app.get('host'), () => {
      console.log(
        chalk.magenta('BMAP API'),
        chalk.green(`listening on ${app.get('host')}:${app.get('port')}!`)
      )
    })
  } else {
    app.listen(app.get('port'), () => {
      console.log(
        chalk.magenta('BMAP API'),
        chalk.green(`listening on port ${app.get('port')}!`)
      )
    })
  }
}

start()
