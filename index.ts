import bmapjs from 'bmapjs'
import { BmapTx } from 'bmapjs/types/common.js'
import bodyParser from 'body-parser'
import { parse } from 'bpu-ts'
import chalk from 'chalk'
import cors from 'cors'
import express from 'express'
import asyncHandler from 'express-async-handler'
import { ChangeStreamDocument } from 'mongodb'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { getDbo } from './db.js'

import dotenv from 'dotenv'
dotenv.config()

const { allProtocols, TransformTx } = bmapjs

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(bodyParser.json())

const defaultQuery = {
  v: 3,
  q: {
    find: {
      'blk.t': { $gt: Math.floor(new Date().getTime() / 1000 - 86400) },
    },
    limit: 10,
    project: { out: 0, in: 0 },
  },
}

const start = async function () {
  console.log(chalk.magenta('BMAP API'), chalk.cyan('initializing machine...'))

  app.set('port', process.env.PORT || 3055)
  app.set('host', process.env.HOST || '127.0.0.1')
  app.set('view engine', 'ejs')
  app.set('views', __dirname + '/../views')
  app.use(
    cors({
      origin: '*',
    })
  )

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

      const changeStream = db
        .collection('post')
        .watch(pipeline, { fullDocument: 'updateLookup' })

      changeStream.on('change', (next: ChangeStreamDocument<BmapTx>) => {
        // only updated contain fullDocument
        if (next.operationType === 'update') {
          console.log(
            chalk.blue('New change event - pushing to SSE'),
            next.fullDocument.tx?.h
          )
          res.write(
            'data: ' +
              JSON.stringify({ type: 'push', data: [next.fullDocument] }) +
              '\n\n'
          )
        }
      })

      changeStream.on('error', () => {
        changeStream.close()
      })

      req.on('close', () => {
        changeStream.close()
      })
    })
  )

  app.get(
    /^\/q\/(.+)$/,
    asyncHandler(async function (req, res) {
      let b64 = req.params[0]
      console.log(chalk.magenta('BMAP API'), chalk.cyan('query', b64))

      const dbo = await getDbo()

      let code = Buffer.from(b64, 'base64').toString()
      let j = JSON.parse(code)
      if (j.q.aggregate) {
        try {
          const c = await dbo
            .collection('post')
            .aggregate(j.q.aggregate, {
              allowDiskUse: true,
              cursor: { batchSize: 1000 },
            })
            .sort(j.q.sort || { _id: -1 })
            .limit(j.q.limit ? j.q.limit : 10)
            .toArray()

          res.send({ c })
        } catch (e) {
          res.status(500).send(e)
          return
        }

        return
      }

      try {
        const c = await dbo
          .collection('post')
          .find(j.q.find)
          .sort(j.q.sort || { _id: -1 })
          .limit(j.q.hasOwnProperty('limit') ? j.q.limit : 10)
          .project(j.q.project || { in: 0, out: 0 })
          .toArray()

        res.send({ c })
        return
      } catch (e) {
        if (e) {
          res.status(500).send(e)
          return
        }
      }
    })
  )

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

  app.post('/ingest', function (req, res) {
    // ingest a raw tx
    console.log('ingest', req.body.rawTx)

    if (req.body.rawTx) {
      // TODO
      // processTransaction({
      //   transaction: req.body.rawTx,
      // } as Partial<Transaction>)
      //   .then((tx) => {
      //     res.status(201).send(tx)
      //   })
      //   .catch((e) => res.status(500).send(e))

      return
    } else {
      return res.status(400).send()
    }
  })

  app.get(
    '/tx/:tx/:format?',
    asyncHandler(async (req, res) => {
      const tx = req.params.tx
      const format = req.params.format

      console.log({ tx, format })
      // fetch the tx
      try {
        if (format === 'raw') {
          const rawTx = await rawTxFromTxid(tx)
          res.status(200).send(rawTx)
          return
        } else if (format === 'json') {
          const json = await jsonFromTxid(tx)
          res.status(200).send(json)
          return
        } else if (format === 'file') {
          const db = await getDbo()

          let txid = tx
          let vout = 0
          if (tx.includes('_')) {
            const parts = tx.split('_')
            txid = parts[0]
            vout = parseInt(parts[1])
          }

          const item = await db.collection('post').findOne({ 'tx.h': txid })
          console.log({ item })
          if (item && (item.ORD || item.B)) {
            var img = Buffer.from(
              item.ORD[vout]?.data || item.B[vout]?.content,
              'base64'
            )
            res.writeHead(200, {
              'Content-Type':
                item.ORD[vout].contentType || item.B[vout]['content-type'],
              'Content-Length': img.length,
            })
            res.status(200).end(img)
            return
          } else {
            const bob = await bobFromTxid(txid)
            // Transform from BOB to BMAP
            const decoded = await TransformTx(
              bob,
              allProtocols.map((p) => p.name)
            )

            var dataBuf: Buffer
            var contentType: string
            if (decoded.ORD && decoded.ORD[vout]) {
              dataBuf = Buffer.from(decoded.ORD[vout]?.data, 'base64')
              contentType = decoded.ORD[vout].contentType
            } else if (decoded.B && decoded.B[vout]) {
              dataBuf = Buffer.from(decoded.B[vout]?.content, 'base64')
              contentType = decoded.B[vout]['content-type']
            }

            if (dataBuf) {
              res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': dataBuf.length,
              })
              res.status(200).end(dataBuf)
            } else {
              res.status(500).send()
            }

            return
          }
        } else if (format === 'dataUrl') {
          const db = await getDbo()

          let txid = tx
          let vout = 0
          if (tx.includes('_')) {
            const parts = tx.split('_')
            txid = parts[0]
            vout = parseInt(parts[1])
          }

          const item = await db.collection('post').findOne({ 'tx.h': txid })
          console.log({ item })
          let tc: string
          let td: string
          if (item && (item?.ORD || item?.B)) {
            if (item.ORD) {
              tc = item.ORD[vout]?.contentType
              td = item.ORD[vout]?.data
            } else if (item.B) {
              tc = item.B[vout]['content-type']
              td = item.B[vout]?.content
            }
          } else {
            const bob = await bobFromTxid(txid)
            console.log('got the bob', Object.keys(bob))
            // Transform from BOB to BMAP
            const decoded = await TransformTx(
              bob,
              allProtocols.map((p) => p.name)
            )
            if (decoded) {
              console.log('decoded', !!decoded.ORD, !!decoded.B)
              if (decoded.ORD && decoded.ORD[vout]) {
                tc = decoded.ORD[vout]?.contentType
                td = decoded.ORD[vout]?.data
              } else if (decoded.B && decoded.B[vout]) {
                tc = decoded.B[vout]['content-type']
                td = decoded.B[vout]?.content
              }
            }

            if (tc && td) {
              res.status(200).send(`data:${tc};base64,${td}`)
            } else {
              res.status(404).send()
            }

            return
          }
          // not a recognized format, parse as key
        }
        const bob = await bobFromTxid(tx)
        console.log('bob', bob.out[0])
        // Transform from BOB to BMAP
        console.log('loading protocols', allProtocols)
        const decoded = await TransformTx(
          bob,
          allProtocols.map((p) => p.name)
        )
        console.log('bmap', decoded)
        // Response (segment and formatting optional)

        switch (format) {
          case 'bob':
            res.status(200).json(bob)
            return
          case 'bmap':
            res.status(200).json(decoded)
            return
          default:
            if (format && decoded[format]) {
              res.status(200).json(decoded[format])
              return
            }
        }
        res
          .status(200)
          .send(
            format && format.length
              ? `Key ${format} not found in tx`
              : `<pre>${JSON.stringify(decoded, undefined, 2)}</pre>`
          )
      } catch (e) {
        res.status(400).send('Failed to process tx ' + e)
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

const bobFromRawTx = async (rawtx: string) => {
  return await parse({
    tx: { r: rawtx },
    split: [
      {
        token: { op: 106 },
        include: 'l',
      },
      {
        token: { s: '|' },
      },
    ],
  })
}
const bobFromPlanariaByTxid = async (txid: string) => {
  // // The query we constructed from step 2.
  const query = {
    v: 3,
    q: {
      find: {
        'tx.h': txid,
      },
      sort: {
        'blk.i': -1,
        i: -1,
      },
      limit: 1,
    },
  }
  // Turn the query into base64 encoded string.
  const b64 = Buffer.from(JSON.stringify(query)).toString('base64')
  const url = `https://bob.planaria.network/q/1GgmC7Cg782YtQ6R9QkM58voyWeQJmJJzG/${b64}`
  // Attach planaria API KEY as header
  const header = {
    headers: { key: '14yHvrKQEosfAbkoXcEwY6wSvxNKteFbzU' },
  }
  const res = await fetch(url, header)
  const j = await res.json()
  return j.c.concat(j.u)[0]
}
const jsonFromTxid = async (txid: string) => {
  // get rawtx for txid
  const url = 'https://api.whatsonchain.com/v1/bsv/main/tx/' + txid
  console.log('hitting', url)
  // let res = await fetch(url, header)
  const res = await fetch(url)
  return await res.json()
}
const bobFromTxid = async (txid: string) => {
  const rawtx = await rawTxFromTxid(txid)
  // Transform using BPU
  try {
    return await bobFromRawTx(rawtx)
  } catch (e) {
    console.log(
      'Failed to ger rawtx from whatsonchain for.',
      txid,
      'Failing back to BOB planaria.',
      e
    )
    return await bobFromPlanariaByTxid(txid)
  }
}
const rawTxFromTxid = async (txid: string) => {
  // get rawtx for txid
  const url = 'https://api.whatsonchain.com/v1/bsv/main/tx/' + txid + '/hex'
  console.log('hitting', url)
  // let res = await fetch(url, header)
  const res = await fetch(url)
  return await res.text()
}

start()
