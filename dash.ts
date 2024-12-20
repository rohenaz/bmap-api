import type QuickChart from 'quickchart-js';
function collectionQuery(collection: string) {
  const q = defaultQuery;
  q.q.find['MAP.type'] = collection;
  return Buffer.from(JSON.stringify(q)).toString('base64');
}
function getGridItemsHtml(collection: string, count: number, chart: QuickChart) {
  return `<a href='/query/${encodeURIComponent(collection)}/${collectionQuery(collection)}'>
  <div class='border border-zinc-800 p-4 text-center dark:bg-zinc-900 dark:text-white'>
    <div class='text-lg font-semibold dark:text-white flex justify-between'>
      ${collection}
      <div class='text-sm dark:text-zinc-400'>${count.toLocaleString()} Txs</div>
    </div>
    <img src='${chart.getUrl()}' alt='Chart for ${collection}' class='mt-2 mb-2' />
  </div>
</a>`;
}

const defaultQuery = {
  v: 3,
  q: {
    find: {
      // 'blk.t': { $gt: Math.floor(new Date().getTime() / 1000 - 86400) },
    },
    limit: 10,
    project: { out: 0, in: 0 },
  },
};

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
  'context',
  'subcontext',
  'geohash',
  'repost',
];

export { bitcoinSchemaTypes, defaultQuery, getGridItemsHtml };
