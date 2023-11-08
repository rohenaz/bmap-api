import { Transaction } from '@gorillapool/js-junglebus'
import bmapjs from 'bmapjs'
import { BmapTx } from 'bmapjs/types/common.js'
import bodyParser from 'body-parser'
import { parse } from 'bpu-ts'
import chalk from 'chalk'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import asyncHandler from 'express-async-handler'
import { ChangeStreamDocument } from 'mongodb'
import { dirname } from 'path'
import QuickChart from 'quickchart-js'
import { fileURLToPath } from 'url'
import { BapIdentity, getBAPIdByAddress, resolveSigners } from './bap.js'
import {
  CacheCount,
  client,
  deleteFromCache,
  getBlockHeightFromCache,
  readFromRedis,
  saveToRedis,
} from './cache.js'
import {
  TimeSeriesData,
  generateChart,
  generateCollectionChart,
  generateTotalsChart,
  getBlocksRange,
  getTimeSeriesData,
} from './chart.js'
import { bitcoinSchemaTypes, defaultQuery, getGridItemsHtml } from './dash.js'
import { getCollectionCounts, getDbo, getState } from './db.js'
import './p2p.js'
import { processTransaction } from './process.js'
import { Timeframe } from './types.js'

dotenv.config()

const { allProtocols, TransformTx } = bmapjs

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(bodyParser.json())

const start = async function () {
  console.log(chalk.magenta('BMAP API'), chalk.cyan('initializing machine...'))
  await client.connect()
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
    '/s/:collectionName?/:base64Query',
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

      console.log(
        chalk.blue('New change stream subscription on', collectionName)
      )
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

      const target =
        collectionName === '$all' ? db : db.collection(collectionName)

      const changeStream = target.watch(pipeline, {
        fullDocument: 'updateLookup',
      })

      changeStream.on('change', (next: ChangeStreamDocument<BmapTx>) => {
        console.log('CHANGE DETECTED', next.operationType)
        // only updated contain fullDocument
        if (
          // next.operationType === 'update' ||
          next.operationType === 'insert'
        ) {
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

      changeStream.on('error', (e) => {
        console.log(chalk.blue('Changestream error - closing SSE'), e)
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
      console.log(
        chalk.magenta('BMAP API'),
        chalk.cyan('query', collectionName)
      )

      const dbo = await getDbo()

      let code: string
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

          // find signers and load signer profiles from cache
          let signers = await resolveSigners(c as BmapTx[])
          console.log({ signers })
          res.send({ [collectionName]: c, signers })
          return
        } catch (e) {
          console.log(e)
          res.status(500).send(e)
          return
        }
      }

      try {
        const c = await dbo
          .collection(collectionName)
          .find(j.q.find)
          .sort(j.q.sort || { _id: -1 })
          .limit(j.q.hasOwnProperty('limit') ? j.q.limit : 10)
          .project(j.q.project || { in: 0, out: 0 })
          .toArray()
        let signers = await resolveSigners(c as BmapTx[])
        console.log({ signers })
        res.send({ [collectionName]: c, signers })
        return
      } catch (e) {
        console.log(e)
        res.status(500).send(e)
        return
      }
    })
  )

  app.get('/identity/:address', async (req, res) => {
    // check the cache for the identity profile, otherwise get it from the api
    const address = req.params.address
    const key = `signer-${address}`
    console.log('Reading from redis', key)
    const { value, error } = (await readFromRedis(key)) as {
      value: BapIdentity | undefined
      error: number | undefined
    }
    let identity = value as BapIdentity | undefined
    if (error === 404) {
      console.error('No identity found in cache for this address', error)

      try {
        identity = await getBAPIdByAddress(address)
        if (identity) {
          await saveToRedis(key, {
            type: 'signer',
            value: identity,
          })
          console.log('Resolved identity from indexer', identity)
          res.status(200).send(identity)
        } else {
          console.error('No identity exists for this address')
          res.status(404).send()
          return
        }
      } catch (e) {
        console.error('No identity exists for this address', e)
        res.status(404).send({ error: e })
        return
      }
      res.status(404).send()
      return
    }
    if (error) {
      console.error('Failed to get identity from redis', error)
      res.status(error).send()
      return
    }

    // example response
    //   {
    //     "status": "OK",
    //     "result": {
    //         "rootAddress": "13ZNtS7f3Yb5QiYsJgNpXq7S994hcPLaKv",
    //         "currentAddress": "1HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY",
    //         "addresses": [
    //             {
    //                 "address": "1HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY",
    //                 "txId": "f39575e7ac17f8590f42aa2d9f17b743d816985e85632303281fe7c84c3186b3"
    //             }
    //         ],
    //         "identity": "{\"@context\":\"https://schema.org\",\"@type\":\"Person\",\"alternateName\":\"WildSatchmo\",\"logo\":\"bitfs://a53276421d2063a330ebbf003ab5b8d453d81781c6c8440e2df83368862082c5.out.1.1\",\"image\":\"\",\"homeLocation\":{\"@type\":\"Place\",\"name\":\"Bitcoin\"},\"url\":\"https://tonicpow.com\",\"paymail\":\"satchmo@moneybutton.com\"}",
    //         "identityTxId": "e7becb2968a6afe0f690cbe345fba94b8e4a7da6a014a5d52b080a7d6913c281",
    //         "idKey": "Go8vCHAa4S6AhXKTABGpANiz35J",
    //         "block": 594320,
    //         "timestamp": 1699391776,
    //         "valid": false
    //     }
    // }

    if (!identity) {
      res.status(404).send()
    } else {
      console.log('Got identity from redis', identity)

      res.status(200).send(identity)
      return
    }
  })

  // get all identities
  app.get('/identities', async (req, res) => {
    const idCacheKey = 'signer-*'

    const keys = await client.keys(idCacheKey)
    console.log('keys', keys)
    try {
      const identities = await Promise.all(
        keys.map(async (k) => {
          const { value, error } = (await readFromRedis(k)) as {
            value: BapIdentity | undefined
            error: number | undefined
          }
          if (error) {
            console.error('Failed to get identity from redis', error)
            return null
          }
          return value
        })
      )

      res.status(200).send(identities)
    } catch (e) {
      console.error('Failed to get identities', e)
      res.status(500).send()
    }
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
    '/htmx-state',
    asyncHandler(async (req, res) => {
      const state = await getState()
      const crawlHeight = state.height

      // geet latest block from whatstonchain api
      const url = 'https://api.whatsonchain.com/v1/bsv/main/chain/info'
      const resp = await fetch(url)
      const json = await resp.json()
      const latestHeight = json.blocks

      // If this is a new block, bust the cache
      const currentBlockHeight = await getBlockHeightFromCache()
      if (latestHeight > currentBlockHeight) {
        await deleteFromCache('currentBlockHeight')
      }

      // calculate pct complete based on starting crawl height, current crawl height, and the latest blockheight of the BSV blockchain
      const startHeight = 574287
      const pctComplete = `${Math.floor(
        ((crawlHeight - startHeight) * 100) / (latestHeight - startHeight)
      )}%`

      // htmx + tailwind progress bar component
      const progress = `<div class="relative pt-1">
  <div class="overflow-hidden h-2 mb-4 text-xs flex rounded bg-pink-200">
    <div style="width:${pctComplete}" class="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-pink-500"></div>
  </div>
</div>`

      // <div class="flex flex-col">
      // <div class="text-gray-500">Sync Progress</div>
      // ${progress}
      // </div>

      res.send(`<div class="flex flex-col">
  <div class="text-gray-500">Sync Progress (${pctComplete})</div>
  <div class="text-lg font-semibold">${crawlHeight} / ${latestHeight}</div>
</div>`)
    })
  )

  app.get(
    '/htmx-collections',
    asyncHandler(async (req, res) => {
      console.time('Total Execution Time') // Start timer for total execution

      console.time('getCollectionCounts')
      try {
        const timestamp = Math.floor(Date.now() / 1000) - 86400
        // Cache counts
        const countsKey = `counts-${timestamp}`
        let { value } = await readFromRedis(countsKey)
        let counts = [] as Record<string, number>[]
        if (!value) {
          counts = await getCollectionCounts(timestamp)

          await saveToRedis(countsKey, {
            type: 'count',
            value: counts,
          } as CacheCount)
        }
        console.timeEnd('getCollectionCounts') // End timer for getCollectionCounts
        console.time('getBlockHeightFromCache')

        const timeframe = (req.query.timeframe as string) || Timeframe.Day

        let gridItemsHtml = ''
        let gridItemsHtml2 = ''

        const currentBlockHeight = await getBlockHeightFromCache()
        const [startBlock, endBlock] = getBlocksRange(
          currentBlockHeight,
          timeframe
        )
        console.timeEnd('getBlockHeightFromCache') // End timer for getBlockHeightFromCache
        console.time('Loop over bitcoinSchemaCollections')

        const bitcoinSchemaCollections = Object.keys(counts).filter((c) =>
          bitcoinSchemaTypes.includes(c)
        )

        const otherCollections = Object.keys(counts).filter(
          (c) => !bitcoinSchemaTypes.includes(c)
        )

        for (const collection of bitcoinSchemaCollections) {
          const count = counts[collection]
          const timeSeriesKey = `${collection}-${startBlock}-${endBlock}`

          // Cache time series data
          let { value } = await readFromRedis(timeSeriesKey)
          let timeSeriesData = value as TimeSeriesData | undefined
          if (!timeSeriesData) {
            timeSeriesData = await getTimeSeriesData(
              collection,
              startBlock,
              endBlock
            )
            // cache.set(timeSeriesKey, {
            //   type: 'timeSeriesData',
            //   value: timeSeriesData,
            // })
            await saveToRedis(timeSeriesKey, {
              type: 'timeSeriesData',
              value: timeSeriesData,
            })
          }

          const chart = generateChart(timeSeriesData, false)

          gridItemsHtml += getGridItemsHtml(collection, count, chart)
        }
        console.timeEnd('Loop over bitcoinSchemaCollections') // End timer for loop over bitcoinSchemaCollections
        console.time('Loop over otherCollections')
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
        console.timeEnd('Loop over otherCollections') // End timer for loop over otherCollections
        console.timeEnd('Total Execution Time') // End timer for total execution

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
      const timeframe = (req.query.timeframe as string) || Timeframe.Day
      const collectionName = req.params.name

      // Fetch and store current block height with type
      let currentBlockHeight = await getBlockHeightFromCache()
      // TODO: bust cache when new blocks come in in another process

      // Translate selected time period to block range
      const [startBlock, endBlock] = getBlocksRange(
        currentBlockHeight,
        timeframe
      )

      let range = 1
      switch (timeframe) {
        case Timeframe.Day:
          // will have 144 bars
          range = 1
          break
        case Timeframe.Week:
          range = 7
          break
        case Timeframe.Month:
          range = 30
          break
        case Timeframe.Year:
          range = 365
          break
      }

      // Fetch and store chart with type
      const chartKey = `${collectionName}-${startBlock}-${endBlock}-${range}`
      let { value } = await readFromRedis(chartKey)
      let chart = value as QuickChart | undefined
      //let chart = cache.get(chartKey)?.value as QuickChart | undefined
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
        // cache.set(chartKey, { type: 'chart', value: chart })
        await saveToRedis(chartKey, { type: 'chart', value: chart })
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
        }' class='mt-2 mb-2' width="1280" height="300" />`
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

  app.post(
    '/ingest',
    asyncHandler(async (req, res) => {
      // ingest a raw tx
      console.log('ingest', req.body.rawTx)

      if (req.body.rawTx) {
        try {
          const tx = await processTransaction({
            transaction: req.body.rawTx,
          } as Partial<Transaction>)

          tx ? res.status(201).send(tx) : res.status(403).send()
        } catch (e) {
          console.log(e)
          res.status(500).send()
        }

        return
      } else {
        res.status(400).send()
        return
      }
    })
  )

  app.get(
    '/tx/:tx/:format?',
    asyncHandler(async (req, res) => {
      const tx = req.params.tx
      const format = req.params.format

      if (!tx) {
        res.status(400).send({ error: 'Missing txid' })
        return
      }

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
