import * as BetterQueue from 'better-queue'
import * as chalk from 'chalk'
import * as fs from 'fs'
import fetch from 'node-fetch'

// ToDo - Using a queue so if the file download fails for some reason we can add it back to the queue?
const q = new BetterQueue(
  function (file) {
    // TODO if data dir doesnt exist this will error out on mac

    let path = 'data/' + file + '.bitfs'

    // See if the file exists already before fetching it
    try {
      fs.access(path, fs.constants.F_OK, async (err) => {
        if (err) {
          // Fetch from BitFS and store to local file
          console.log(chalk.cyan('saving https://bitfs.network/' + file))
          let res = await fetch('https://x.bitfs.network/' + file)
          res.body.pipe(fs.createWriteStream(path))
          return
        }
        // file exists
        console.log(chalk.cyan('file already exists'))
      })
    } catch (err) {
      console.log('error checking or writing file', err)
    }
  },
  { afterProcessDelay: 10 }
)

const saveFiles = (bitfs) => {
  for (let file of bitfs) {
    q.push(file)
  }
}

export { saveFiles }
