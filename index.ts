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
import { getCollectionCounts, getCurrentBlockHeight, getDbo } from './db.js'

import dotenv from 'dotenv'
import QuickChart from 'quickchart-js'

import {
  generateChart,
  generateCollectionChart,
  generateTotalsChart,
  getTimeSeriesData,
} from './chart.js'
import { bitcoinSchemaTypes, defaultQuery, getGridItemsHtml } from './dash.js'
dotenv.config()

const { allProtocols, TransformTx } = bmapjs

// cache for express responses
type CacheValue =
  | { type: 'blockHeight'; value: number }
  | { type: 'chart'; value: QuickChart }

const cache = new Map<string, CacheValue>()
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(bodyParser.json())

const timeframeToBlocks = (period: string) => {
  // Example mapping from time period to number of blocks
  switch (period) {
    case '24h':
      return 144 // Approximate number of blocks in 24 hours
    case 'week':
      return 1008 // Approximate number of blocks in 7 days
    case 'month':
      return 4320 // Approximate number of blocks in a month
    case 'year':
      return 52560 // Approximate number of blocks in a year
    case 'all':
      return 0 // All blocks
    default:
      return 0
  }
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
    '/s/:collectionName/:base64Query',
    asyncHandler(async function (req, res) {
      let collectionName = req.params.collectionName
      let b64 = req.params.base64Query

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
        .collection(collectionName)
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
    '/q/:collectionName/:base64Query',
    asyncHandler(async function (req, res) {
      let collectionName = req.params.collectionName
      let b64 = req.params.base64Query
      console.log(chalk.magenta('BMAP API'), chalk.cyan('query', b64))

      const dbo = await getDbo()

      let code
      if (b64 && collectionName) {
        code = Buffer.from(b64, 'base64').toString()
      } else {
        code = Buffer.from(JSON.stringify(defaultQuery)).toString()
      }
      let j = JSON.parse(code)
      if (j.q.aggregate) {
        try {
          const c = await dbo
            .collection(collectionName)
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
          .collection(collectionName)
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

  app.get(
    '/collections',
    asyncHandler(async (req, res) => {
      // return a list of collection names and the count of records for each from the bmap database
      try {
        const timestamp = Math.floor(Date.now() / 1000) - 86400 // For example, 24 hours ago
        const counts = await getCollectionCounts(timestamp)
        console.log(counts)
        res.send(counts) // Output: { "collectionName": count, ... }
      } catch (error) {
        console.error('An error occurred:', error)
        res.status(500).send()
      }
    })
  )

  app.get(
    '/htmx-collections',
    asyncHandler(async (req, res) => {
      try {
        const timestamp = Math.floor(Date.now() / 1000) - 86400
        const counts = await getCollectionCounts(timestamp)
        const timeframe = (req.query.timeframe as string) || '24h'

        let gridItemsHtml = ''
        let gridItemsHtml2 = ''

        const currentBlockHeight = await getCurrentBlockHeight()
        const blocks = timeframeToBlocks(timeframe)
        const startBlock = currentBlockHeight - blocks
        const endBlock = currentBlockHeight

        const bitcoinSchemaCollections = Object.keys(counts).filter((c) =>
          bitcoinSchemaTypes.includes(c)
        )
        const otherCollections = Object.keys(counts).filter(
          (c) => !bitcoinSchemaTypes.includes(c)
        )

        for (const collection of bitcoinSchemaCollections) {
          const count = counts[collection]
          const timeSeriesData = await getTimeSeriesData(
            collection,
            startBlock,
            endBlock
          )
          const chart = generateChart(timeSeriesData, false)

          gridItemsHtml += getGridItemsHtml(collection, count, chart)
        }

        for (const collection of otherCollections) {
          const count = counts[collection]
          const timeSeriesData = await getTimeSeriesData(
            collection,
            startBlock,
            endBlock
          )
          const chart = generateChart(timeSeriesData, false)
          // TODO: Investigate how 0 count collections are being created
          if (collection !== '_state' && count > 0) {
            gridItemsHtml2 += getGridItemsHtml(collection, count, chart)
          }
        }

        res.send(`<h3 class="mb-4">Bitcoin Schema Types</h3>
  <div class="grid grid-cols-4 gap-8 mb-8">
    ${gridItemsHtml}
  </div>
  <h3 class="mb-4">Other Types</h3>
  <div class="grid grid-cols-4 gap-8">
    ${gridItemsHtml2}
  </div>`)
      } catch (error) {
        console.error('An error occurred:', error)
        res.status(500).send()
      }
    })
  )

  app.get(
    '/htmx-chart/:name?',
    asyncHandler(async (req, res) => {
      const timeframe = req.query.timeframe || '24h'
      const collectionName = req.params.name

      // Fetch and store current block height with type
      let currentBlockHeight = cache.get('currentBlockHeight')?.value as
        | number
        | undefined
      // TODO: bust cache when new blocks come in in another process
      if (!currentBlockHeight) {
        console.log('Fetching current block height withouth cache')
        currentBlockHeight = await getCurrentBlockHeight()
        cache.set('currentBlockHeight', {
          type: 'blockHeight',
          value: currentBlockHeight,
        })
      }

      // Translate selected time period to block range
      const blocks = timeframeToBlocks(timeframe as string)

      const startBlock = currentBlockHeight - blocks
      const endBlock = currentBlockHeight

      let range = 1
      switch (timeframe) {
        case '24h':
          // will have 144 bars
          range = 1
          break
        case 'week':
          range = 7
          break
        case 'month':
          range = 30
          break
        case 'year':
          range = 365
          break
      }

      // Fetch and store chart with type
      const chartKey = `${collectionName}-${startBlock}-${endBlock}-${range}`
      let chart = cache.get(chartKey)?.value as QuickChart | undefined
      if (!chart) {
        console.log('Fetching chart without cache', { collectionName })
        chart = collectionName
          ? await generateTotalsChart(
              collectionName,
              startBlock,
              endBlock,
              range
            )
          : await generateCollectionChart(
              collectionName,
              startBlock,
              endBlock,
              range
            )
        cache.set(chartKey, { type: 'chart', value: chart })
      }

      // if (collectionName) {
      //   chart = await generateTotalsChart(
      //     collectionName,
      //     startBlock,
      //     endBlock,
      //     range
      //   )
      // } else {
      //   chart = await generateCollectionChart(
      //     collectionName,
      //     startBlock,
      //     endBlock,
      //     range
      //   )
      // }
      res.set('Cache-Control', 'public, max-age=3600')

      res.send(
        `<img src='${chart.getUrl()}' alt='Transaction${
          collectionName ? 's for ' + collectionName : 'totals'
        }' class='mt-2 mb-2' />`
      )
    })
  )

  app.get('/query/:collectionName', function (req, res) {
    let collectionName = req.params.collectionName
    let q = Object.assign({}, defaultQuery)
    q.q.find['MAP.type'] = collectionName
    let code = JSON.stringify(q, null, 2)
    res.render('explorer', {
      name: 'BMAP',
      code: code,
    })
  })

  app.get(
    '/query/:collectionName/:base64Query',
    asyncHandler(async function (req, res) {
      let collectionName = req.params.collectionName
      let b64 = req.params.base64Query
      let code = Buffer.from(b64, 'base64').toString()
      res.render('explorer', {
        name: 'BMAP',
        code: code,
      })
    })
  )

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

          // const item = await db.collection('post').findOne({ 'tx.h': txid })
          // console.log({ item })
          // if (item && (item.ORD || item.B)) {
          //   var img = Buffer.from(
          //     item.ORD[vout]?.data || item.B[vout]?.content,
          //     'base64'
          //   )
          //   res.writeHead(200, {
          //     'Content-Type':
          //       item.ORD[vout].contentType || item.B[vout]['content-type'],
          //     'Content-Length': img.length,
          //   })
          //   res.status(200).end(img)
          //   return
          // } else {
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
          //}
        } else if (format === 'dataUrl') {
          // const db = await getDbo()

          // let txid = tx
          // let vout = 0
          // if (tx.includes('_')) {
          //   const parts = tx.split('_')
          //   txid = parts[0]
          //   vout = parseInt(parts[1])
          // }

          // const item = await db.collection('post').findOne({ 'tx.h': txid })
          // console.log({ item })
          // let tc: string
          // let td: string
          // if (item && (item?.ORD || item?.B)) {
          //   if (item.ORD) {
          //     tc = item.ORD[vout]?.contentType
          //     td = item.ORD[vout]?.data
          //   } else if (item.B) {
          //     tc = item.B[vout]['content-type']
          //     td = item.B[vout]?.content
          //   }
          // } else {
          // const bob = await bobFromTxid(txid)
          // console.log('got the bob', Object.keys(bob))
          // // Transform from BOB to BMAP
          // const decoded = await TransformTx(
          //   bob,
          //   allProtocols.map((p) => p.name)
          // )
          // if (decoded) {
          //   console.log('decoded', !!decoded.ORD, !!decoded.B)
          //   if (decoded.ORD && decoded.ORD[vout]) {
          //     tc = decoded.ORD[vout]?.contentType
          //     td = decoded.ORD[vout]?.data
          //   } else if (decoded.B && decoded.B[vout]) {
          //     tc = decoded.B[vout]['content-type']
          //     td = decoded.B[vout]?.content
          //   }
          // }

          // if (tc && td) {
          //   res.status(200).send(`data:${tc};base64,${td}`)
          // } else {
          //   res.status(404).send()
          // }

          return
          //}
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

// TODO: Old functions should use new services to accomplish this
const bobFromPlanariaByTxid = async (txid: string) => {
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
