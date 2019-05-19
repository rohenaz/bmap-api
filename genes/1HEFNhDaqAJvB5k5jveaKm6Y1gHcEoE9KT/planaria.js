/***************************************
*
* API Reference: https://docs.planaria.network/#/api?id=anatomy-of-a-planaria
*
***************************************/
module.exports = {
  planaria: '0.0.1',
  from: 570000,
  name: 'BMAP',
  version: '0.0.1',
  description: 'A planaria for BMAP based protocols.',
  address: '1HEFNhDaqAJvB5k5jveaKm6Y1gHcEoE9KT',
  index: {},
  onmempool: async function(m) {
    // Triggered for every mempool tx event
    // https://docs.planaria.network/#/api?id=onmempool
  },
  onblock: async function(m) {
    // Triggered for every new block event
    // https://docs.planaria.network/#/api?id=onblock
  },
  onrestart: async function(m) {
    // Clean up for when the nede restarts
    // https://docs.planaria.network/#/api?id=onrestart
  }
}
