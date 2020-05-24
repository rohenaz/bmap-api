const { sock } = require('./queries')
const Queue = require('better-queue')
const EventSource = require('eventsource')
const chalk = require('chalk')
const { saveTx } = require('./actions')
const { getDbo } = require('./db')
const storage = require('node-persist')
const storageOptions = {
  dir: 'persist',
  stringify: JSON.stringify,
  parse: JSON.parse,
  encoding: 'utf8',
  logging: false, // can also be custom logging function
  ttl: false, // ttl* [NEW], can be true for 24h default or a number in MILLISECONDS or a valid Javascript Date object
  expiredInterval: 2 * 60 * 1000, // every 2 minutes the process will clean-up the expired cache
  // in some cases, you (or some other service) might add non-valid storage files to your
  // storage dir, i.e. Google Drive, make this true if you'd like to ignore these files and not throw an error
  forgiveParseErrors: false,
}

let socket

exports.lastEventId = async () => {
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
  var queue = new Queue(async (item, cb) => {
    try {
      console.log('SAVING', item.tx.h)
      let dbo = await getDbo()
      await saveTx(item, d.type === 'block' ? 'c' : 'u', dbo)
    } catch (e) {
      console.error('Failed to save tx. Record may already exists.', e)
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
      if (e.lastEventId && e.lastEventId !== 'undefined') {
        try {
          await storage.setItem('lastEventId', e.lastEventId)
        } catch (e) {
          console.error('Failed to save last event ID to persistent storage', e)
        }
      }

      d = JSON.parse(e.data)
      if (d.type != 'open') {
        d.data.forEach(async (tx) => {
          if (tx.tx.h !== (await storage.getItem('lastSeenTx'))) {
            queue.push(tx)
            storage.setItem('lastSeenTx', tx.tx.h)
          } else {
            console.log('why would this even happen?', tx.tx.h)
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

process.on('message', async (m) => {
  console.log('message received!', m)
  if (m.connect) {
    try {
      await storage.init(storageOptions)
      let lastId = await storage.getItem('lastEventId')
      connect(lastId || null)
    } catch (e) {
      console.error('Failed to intialize persistent storage.', e)
    }
  }
})

exports.connect = connect
exports.close = close
