// import '@constl/orbit-db-types'
// import { createOrbitDB } from '@orbitdb/core'
// import chalk from 'chalk'
// import IPFS from 'ipfs-core'

// const ipfs = await IPFS.create()
// const orbitdb = await createOrbitDB({
//   ipfs,
//   directory: './orbitdb',
// })
// const db = await orbitdb.keystore('transactions')

// const init = async () => {
//   // Create / Open a key-value database to store transactions

//   // Example usage
//   await addTransaction('sampleTxid', 'abc123')
//   const transaction = await getTransaction('sampleTxid')
//   // use chalk to make p2p logs have a black bg and magenta text
//   chalk.bgBlack.magenta('Transaction: ', transaction) // Output: abc123

//   // Clean up
//   await db.close()
//   await orbitdb.stop()
// }

// // Function to add a new transaction
// async function addTransaction(txid: string, transactionData: string) {
//   await db.put(txid, transactionData)
// }

// // Function to query a transaction by txid
// async function getTransaction(txid: string) {
//   return db.get(txid)
// }

// export { init }
