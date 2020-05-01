const express = require('express')
const app = express()
const mongo = require('mongodb')
const { defaultQuery } = require('./queries')
const chalk = require('chalk')

process.on('message', async (m, socket) => {
  console.log('message received!', m, socket)
  if (m === 'socket') {
    console.log('m is socket')
    switch(socket.type) {
      case 'block':
        console.log('current block is now', socket.block)
    }
  }
})

const start = async function() {
  console.log(chalk.magenta("PLANARIUM"), chalk.cyan("initializing machine..."))

  app.set('view engine', 'ejs');
  app.set('views', __dirname + '/views')
  app.use(express.static(__dirname + '/public'))
  const port = 3000
  const host = 'localhost'
  app.get(/^\/q\/(.+)$/, function(req, res) {
    let b64= req.params[0]
    console.log(chalk.magenta('PLANARIUM'), chalk.cyan('query', b64))
        
    mongo.MongoClient.connect(process.env.MONGO_URL, {
      useUnifiedTopology: true,
      useNewUrlParser: true,
      }, async function(err, db) {
      if (err) throw err

      var dbo = db.db('bmap')

      let code = Buffer
      .from(b64, 'base64')
      .toString()
      let req = JSON.parse(code)
      dbo.collection('c').find(req.q.find).sort(req.q.sort || {_id:-1}).limit(req.q.limit || 10).project(req.q.project || { in: 0, out: 0 }).toArray(function(err, c) {
        if (err) throw err
        dbo.collection('u').find(req.q.find).sort(req.q.sort || {_id:-1}).limit(req.q.limit || 10).project(req.q.project || { in: 0, out: 0 }).toArray(function(err, u) {
          db.close()
          res.send({c: c, u: u})
        })
      })
    })
  })

  app.get("/query", function(req, res) {
    let code = JSON.stringify(defaultQuery, null, 2)
    res.render('explorer', {
      name: 'BMAP',
      code: code,
    })
  })

  app.get(/^\/query\/(.+)$/, function(req, res) {
    let b64= req.params[0]
    let code = Buffer.from(b64, 'base64').toString()
    res.render('explorer', {
      name: 'BMAP', code: code,
    })
  })

  app.get('/', function(req, res) {
    res.sendFile(__dirname + "/public/index.html")
  })

  if (host) {
    app.listen(port, host, () => {
      console.log(chalk.magenta("PLANARIUM"), chalk.green(`listening on ${host}:${port}!`))
    })
  } else {
    app.listen(port, () => {
      console.log(chalk.magenta("PLANARIUM"), chalk.green(`listening on port ${port}!`))
    })
  }
}

start()