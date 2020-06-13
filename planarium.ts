import * as express from 'express'
const app = express()
import * as mongo from 'mongodb'
import { defaultQuery } from './queries'
import * as chalk from 'chalk'
import * as cors from 'cors'

process.on('message', async (m, socket) => {
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
  console.log(chalk.magenta('PLANARIUM'), chalk.cyan('initializing machine...'))

  app.set('port', process.env.PORT || 3000)
  app.set('host', process.env.HOST || 'localhost')
  app.set('view engine', 'ejs')
  app.set('views', __dirname + '/../views')
  app.use(cors())
  app.use(express.static(__dirname + '/../public'))
  app.get(/^\/q\/(.+)$/, function (req, res) {
    let b64 = req.params[0]
    console.log(chalk.magenta('PLANARIUM'), chalk.cyan('query', b64))

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
              if (err) throw err
              dbo
                .collection('u')
                .aggregate(req.q.aggregate)
                .sort(req.q.sort || { _id: -1 })
                .limit(req.q.limit ? req.q.limit : 10)
                .toArray(function (err, u) {
                  db.close()
                  res.send({ c: c, u: u })
                })
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
            if (err) throw err
            dbo
              .collection('u')
              .find(req.q.find)
              .sort(req.q.sort || { _id: -1 })
              .limit(req.q.hasOwnProperty('limit') ? req.q.limit : 10)
              .project(req.q.project || { in: 0, out: 0 })
              .toArray(function (err, u) {
                db.close()
                res.send({ c: c, u: u })
              })
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
        chalk.magenta('PLANARIUM'),
        chalk.green(`listening on ${app.get('host')}:${app.get('port')}!`)
      )
    })
  } else {
    app.listen(app.get('port'), () => {
      console.log(
        chalk.magenta('PLANARIUM'),
        chalk.green(`listening on port ${app.get('port')}!`)
      )
    })
  }
}

start()
