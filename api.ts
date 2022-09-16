import chalk from 'chalk'
import cors from 'cors'
import express from 'express'
import mongo from 'mongodb'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { defaultQuery } from './queries.js'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express()

process.on('message', async (m, socket: any) => {
  console.log('message received!', m, socket)
  if (m === 'socket') {
    console.log('m is socket')
    switch (socket.type) {
      case 'block':
        console.log('current block is now', socket.block)
    }
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

  
  app.get(/^\/s\/(.+)$/, function(req, res) {
    let b64 = req.params[0]
    // const 
    // res.writeHead(200, {
    //   "Content-Type": "text/event-stream",
    //   "Cache-Control": "no-cache",
    //   "X-Accel-Buffering": "no",
    //   "Connection": "keep-alive",
    // })
    // res.write("data: " + JSON.stringify({ type: "open", data: [] }) + "\n\n")
    // res.end()
    let json = Buffer.from(b64, "base64").toString()
    res.status(200).send(json)
    // const db = await getDbo()

    // let json = Buffer.from(req.params.b64, "base64").toString()
    // console.log("json = ", json)
    // let query = JSON.parse(json)

    // const pipeline = [
    //   {
    //       '$match': {
    //           'operationType': 'insert',
    //       },
    //   }
    // ];
  
    // Object.keys(query).forEach((k) => pipeline[0]['$match'][`fullDocument.${k}`] = query[k])
    // // [{ fullDocument: query }]

    // const changeStream = db.collection('c').watch(pipeline);

    // changeStream.on('change', (next) => {
      
    //   res.write("data: " + JSON.stringify({ type: "push", data: [next.fullDocument] }) + "\n\n")

    //   console.log(next);
    // });

    // req.on('close', () => {
    //   changeStream.close()
    // })
  })
  
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
            .aggregate(req.q.aggregate)
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
