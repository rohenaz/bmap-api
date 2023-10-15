import QuickChart from 'quickchart-js'
function collectionQuery(collection: string) {
  return Buffer.from((defaultQuery.q.find['MAP.type'] = collection)).toString(
    'base64'
  )
}
function getGridItemsHtml(
  collection: string,
  count: number,
  chart: QuickChart
) {
  return `
<a href='/query/${encodeURIComponent(collection)}/${collectionQuery(
    collection
  )}'>
  <div class='border border-zinc-700 p-4 text-center dark:bg-zinc-800 dark:text-white'>
    <div class='text-lg font-semibold dark:text-white flex justify-between'>
      ${collection}
      <div class='text-sm dark:text-zinc-400'>${count.toLocaleString()} Txs</div>
    </div>
    <img src='${chart.getUrl()}' alt='Chart for ${collection}' class='mt-2 mb-2' />
  </div>
</a>`
}

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

const bitcoinSchemaTypes = [
  'like',
  'post',
  'message',
  'friend',
  'follow',
  'unfriend',
  'unfollow',
  'unlike',
  'ord',
]

export { bitcoinSchemaTypes, defaultQuery, getGridItemsHtml }
