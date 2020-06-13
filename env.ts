import * as chalk from 'chalk'
import * as prompt from 'prompt-async'

const ensureEnvVars = () => {
  return new Promise(async (resolve, reject) => {
    if (!process.env.PLANARIA_TOKEN) {
      prompt.start()
      try {
        console.log(chalk.red('Enter Planaria Token:'))
        const { PLANARIA_TOKEN } = await prompt.get(['PLANARIA_TOKEN'])
        process.env.PLANARIA_TOKEN = PLANARIA_TOKEN
      } catch (e) {
        reject('failed to get token')
        return
      }
    }

    if (!process.env.MONGO_URL) {
      prompt.start()
      try {
        chalk.red(
          'Enter MongoDB connection URL: (mongodb://127.0.0.1:27017/bmap)'
        )

        const { MONGO_URL } = await prompt.get(['MONGO_URL'])

        process.env.MONGO_URL = MONGO_URL.length
          ? MONGO_URL
          : `mongodb://127.0.0.1:27017/bmap`
      } catch (e) {
        reject('failed to get mongo url')
        return
      }
    }

    resolve()
  })
}

export { ensureEnvVars }
