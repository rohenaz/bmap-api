"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const crawler_1 = require("./crawler");
const env_1 = require("./env");
const chalk = require("chalk");
const child_process_1 = require("child_process");
const net = require("net");
const redline = require("readline");
const state_1 = require("./state");
/* Bitsocket runs in a child process */
const bitsocket = child_process_1.fork('./build/bitsocket');
/* Planarium (API Server Process) */
const planarium = child_process_1.fork('./build/planarium');
// Open up the server and send RPC socket to child. Use pauseOnConnect to prevent
// the sockets from being read before they are sent to the child process.
const server = net.createServer({ pauseOnConnect: true });
server.on('connection', (socket) => {
    planarium.send('socket', socket);
});
server.listen(1336);
const start = () => __awaiter(void 0, void 0, void 0, function* () {
    yield env_1.ensureEnvVars();
    try {
        // Should really start with latest blk from ANY collection, not only video like this
        let currentBlock = yield state_1.getCurrentBlock();
        console.log(chalk.cyan('crawling from', currentBlock));
        crawler_1.crawler(() => {
            bitsocket.send({ connect: true });
        });
    }
    catch (e) {
        console.error(e);
    }
});
// Handle interrupt
if (process.platform === 'win32') {
    let rl = redline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    rl.on('SIGINT', function () {
        // ToDo - TS hates this
        // process.emit('SIGINT')
    });
}
process.on('SIGINT', function () {
    return __awaiter(this, void 0, void 0, function* () {
        // graceful shutdown
        server.close();
        process.exit();
    });
});
console.log(chalk.yellow(`
:::::::::  ::::    ::::      :::     :::::::::  
  :+:    :+: +:+:+: :+:+:+   :+: :+:   :+:    :+: 
  +:+    +:+ +:+ +:+:+ +:+  +:+   +:+  +:+    +:+ 
  +#++:++#+  +#+  +:+  +#+ +#++:++#++: +#++:++#+  
  +#+    +#+ +#+       +#+ +#+     +#+ +#+        
  #+#    #+# #+#       #+# #+#     #+# #+#        
  #########  ###       ### ###     ### ###
`));
setTimeout(start, 1000);
// let synced = false
// // Open up the server and send sockets to child. Use pauseOnConnect to prevent
// // the sockets from being read before they are sent to the child process.
// const server = require('net').createServer({ pauseOnConnect: true })
// server.on('connection', (socket) => {
//   planarium.send('socket', socket)
// })
// server.listen(1337)
// // const bitsocketProcessServer = require('net').createServer({
// //   pauseOnConnect: true,
// // })
// // bitsocketProcessServer.on('connection', (socket) => {
// //   bitsocket.send('socket', socket)
// // })
// // bitsocketProcessServer.listen(1338)
// let current_block = 0
// const start = async () => {
//   // Make sure we have a data directory
//   if (!fs.existsSync('./data')) {
//     fs.mkdirSync('./data')
//   }
//   if (!process.env.PLANARIA_TOKEN) {
//     prompt.start()
//     try {
//       console.log(chalk.red('Enter Planaria Token:'))
//       const { PLANARIA_TOKEN } = await prompt.get(['PLANARIA_TOKEN'])
//       process.env.PLANARIA_TOKEN = PLANARIA_TOKEN
//     } catch (e) {
//       console.log('failed to get token')
//     }
//   }
//   if (!process.env.MONGO_URL) {
//     prompt.start()
//     try {
//       console.log(chalk.red('Enter MongoDB URL:'))
//       const { MONGO_URL } = await prompt.get(['MONGO_URL'])
//       process.env.MONGO_URL = MONGO_URL
//     } catch (e) {
//       console.log('failed to get mongo url')
//     }
//   }
//   try {
//     let dbo = await getDbo()
//     // Create collections
//     dbo.createCollection('c', function (err, res) {
//       if (err) throw err
//     })
//     dbo.createCollection('u', function (err, res) {
//       if (err) throw err
//     })
//     dbo
//       .collection('c')
//       .find()
//       .sort({ 'blk.i': -1 })
//       .limit(1)
//       .toArray(async function (err, result) {
//         if (err) throw err
//         if (result && result.length > 0) {
//           // onle clear unconfirmed when block is higher than last item from socket too latest_block
//           current_block = result[0].blk.i
//         } else {
//           console.log('No existing records. Crawling from the beginning.')
//         }
//         console.log(chalk.cyan('crawling from', current_block))
//         crawler(dbo)
//       })
//   } catch (e) {
//     console.error(e)
//   }
// }
// const saveFiles = (bitfs) => {
//   for (let file of bitfs) {
//     q.push(file)
//   }
// }
// const crawl = (query, height, dbo) => {
//   return new Promise(async (resolve, reject) => {
//     // Create a timestamped query by applying the "$gt" (greater than) operator with the height
//     query.q.find['blk.i'] = { $gt: height }
//     let res = await fetch('https://bob.bitbus.network/block', {
//       method: 'post',
//       headers: {
//         'Content-type': 'application/json; charset=utf-8',
//         token: config.token,
//       },
//       body: JSON.stringify(query),
//     })
//     // The promise is resolved when the stream ends.
//     res.body
//       .on('end', () => {
//         resolve()
//       })
//       // Split NDJSON into an array stream
//       .pipe(es.split())
//       // Apply the logic for each line
//       .pipe(
//         es.mapSync(async (t) => {
//           if (t) {
//             let j
//             try {
//               j = JSON.parse(t)
//             } catch (e) {
//               // Invalid response
//               console.error('Invalid response', e, t)
//               return null
//             }
//             if (!j) {
//               console.log('oh no', j)
//               return
//             }
//             // New block
//             if (j.blk && j.blk.i > current_block) {
//               current_block = j.blk.i
//               console.log(
//                 chalk.blue(
//                   '######################################################################'
//                 )
//               )
//               console.log(
//                 chalk.blue('####  '),
//                 chalk.magenta('NEW BLOCK '),
//                 chalk.green(current_block)
//               )
//               console.log(
//                 chalk.blue(
//                   '######################################################################'
//                 )
//               )
//               if (synced) {
//                 await clearUnconfirmed(dbo)
//               }
//               // planarium.send('socket', {type: 'block', block: current_block})
//             }
//             // Extract BitFS URIs
//             // Iterate through all outputs and find chunks whose names start with "f"
//             let bitfs = []
//             if (j.out) {
//               j.out.forEach((out) => {
//                 for (let tape of out.tape) {
//                   let cell = tape.cell
//                   for (let pushdata of cell) {
//                     if (pushdata.hasOwnProperty('f')) {
//                       bitfs.push(pushdata.f)
//                     }
//                   }
//                 }
//               })
//             }
//             // Crawl BitFS
//             saveFiles(bitfs)
//             try {
//               let tx = await saveTx(j, 'c', dbo)
//               return tx
//             } catch (e) {
//               return null
//             }
//           }
//         })
//       )
//   })
// }
// const crawler = (dbo) => {
//   crawl(query, current_block, dbo).then(() => {
//     if (!synced) {
//       console.log(chalk.green('SYNC COMPLETE'))
//       synced = true
//       bitsocket.send({ connect: true })
//     }
//     setTimeout(() => {
//       crawler(dbo)
//     }, 10000)
//   })
// }
// // Handle interrupt
// if (process.platform === 'win32') {
//   let rl = require('readline').createInterface({
//     input: process.stdin,
//     output: process.stdout,
//   })
//   rl.on('SIGINT', function () {
//     process.emit('SIGINT')
//   })
// }
// process.on('SIGINT', function () {
//   // graceful shutdown
//   server.close()
//   closeDb()
//   process.exit()
// })
// console.log(
//   chalk.yellow(`
// :::::::::  ::::    ::::      :::     :::::::::
//   :+:    :+: +:+:+: :+:+:+   :+: :+:   :+:    :+:
//   +:+    +:+ +:+ +:+:+ +:+  +:+   +:+  +:+    +:+
//   +#++:++#+  +#+  +:+  +#+ +#++:++#++: +#++:++#+
//   +#+    +#+ +#+       +#+ +#+     +#+ +#+
//   #+#    #+# #+#       #+# #+#     #+# #+#
//   #########  ###       ### ###     ### ###
// `)
// )
// setTimeout(start, 1000)
//# sourceMappingURL=index.js.map