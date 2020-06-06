import { config } from './config'

// OP_RETURN Protocol prefixes
const prefixes = {
  bitcom: '$',
  bitkey: '13SrNDkVzY5bHBRKNu5iXTQ7K7VqTh5tJC',
  bitpic: '18pAqbYqhzErT6Zk3a5dwxHtB9icv8jH2p',
  map: '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5',
  ron: '1GvFYzwtFix3qSAZhESQVTz9DeudHZNoh1',
}

// BitQuery
const query = {
  v: 3,
  q: {
    find: {
      $and: [
        {
          'out.tape.cell.s': {
            $in: [
              prefixes.map,
              prefixes.bitkey,
              prefixes.bitpic,
              prefixes.ron,
              prefixes.bitcom,
            ],
          },
        },
        { 'blk.i': { $gt: config.from } },
      ],
    },
    sort: { 'blk.i': 1 },
    project: { out: 1, tx: 1, blk: 1, in: 1 },
  },
}

const sock = {
  v: 3,
  q: {
    find: {
      'out.tape.cell.s': {
        $in: [
          prefixes.map,
          prefixes.bitkey,
          prefixes.bitpic,
          prefixes.ron,
          prefixes.bitcom,
        ],
      },
    },
  },
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

export { query, prefixes, defaultQuery, sock }
