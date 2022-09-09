import BetterQueue from 'better-queue'
import chalk from 'chalk'
import EventSource from 'eventsource'
import storage from 'node-persist'
import { saveTx } from './actions.js'
import { sock } from './queries.js'

const storageOptions = {
  dir: 'persist',
  stringify: JSON.stringify,
  parse: JSON.parse,
  encoding: 'utf8',
  logging: false, // can also be custom logging function
  expiredInterval: 2 * 60 * 1000, // every 2 minutes the process will clean-up the expired cache
  // in some cases, you (or some other service) might add non-valid storage files to your
  // storage dir, i.e. Google Drive, make this true if you'd like to ignore these files and not throw an error
  forgiveParseErrors: false,
} as storage.InitOptions

let socket
let interval = null
let latestTxMatch

const lastEventId = async () => {
  return await storage.getItem('lastEventId')
}

const close = async function () {
  if (socket) {
    socket.close()
  }
  if (interval) {
    clearInterval(interval)
    interval = null
  }

  socket = null
  latestTxMatch = null
  try {
    var leid = await storage.getItem('lastEventId')
    await storage.removeItem('lastEventId')
  } catch (e) {
    console.error('Failed to update event id', e)
  }
  return leid
}

const connect = async function (leid) {
  const b64 = Buffer.from(JSON.stringify(sock)).toString('base64')
  var queue = new BetterQueue(async (item, cb) => {
    try {
      console.log('SAVING', item.tx.h)
      await saveTx(item)
    } catch (e) {
      console.error('Failed to save tx from bitsocket update. Record may already exist.', e)
    }
    cb()
  }, {})

  var url = 'https://bob.bitsocket.network/s/'

  async function reopenSocket() {
    socket.close()
    openSocket(await storage.getItem('lastEventId'))
  }

  function openSocket(leid) {
    if (leid) {
      socket = new EventSource(url + b64, {
        headers: { 'Last-Event-Id': leid },
      })
    } else {
      socket = new EventSource(url + b64)
    }
    socket.onmessage = async (e) => {
      if (e.lastEventId) {
        try {
          await storage.setItem('lastEventId', e.lastEventId)
        } catch (e) {
          console.error('Failed to save last event ID to persistent storage', e)
        }
      }

      let d = JSON.parse(e.data)
      if (d.type != 'open') {
        d.data.forEach(async (tx) => {
          if (tx.tx.h !== (await storage.getItem('lastSeenTx'))) {
            queue.push(tx)
            storage.setItem('lastSeenTx', tx.tx.h)
          } else {
            console.log(
              "We've already seen this Tx",
              tx.tx.h,
              await storage.getItem('lastSeenTx')
            )
          }
        })
      } else {
        console.log(chalk.green('bitsocket opened'), 'to', chalk.cyan(url))
      }
    }
  }

  openSocket(leid)

  interval = setInterval(async () => {
    await reopenSocket()
  }, 900000)
}

process.on('message', async (m: any) => {
  if (m.connect) {
    try {
      await storage.init(storageOptions)
      connect(await storage.getItem('lastEventId'))
    } catch (e) {
      console.error('Failed to intialize persistent storage.', e)
    }
  }
})

export { connect, close, lastEventId }

