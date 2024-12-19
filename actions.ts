import type { BmapTx } from 'bmapjs';
import type { BobTx } from 'bob-ts';
import chalk from 'chalk';
import type { Db } from 'mongodb';
import { getBAPIdByAddress } from './bap.js';
import { normalize } from './bmap.js';

interface TransformedTx extends BmapTx {
  tx: {
    h: string;
  };
  AIP?: {
    algorithm_signing_component?: string;
    address?: string;
  }[];
}

export const saveTx = async (tx: BobTx) => {
  let t: TransformedTx;
  let dbo: Db;
  // Transform
  try {
    t = normalize(tx as unknown as BmapTx) as TransformedTx;
    dbo = await getDbo();
  } catch (e) {
    console.error('Error transforming tx', e);
    return;
  }

  // get BAP IDs for given social op
  if (t.AIP) {
    let bapId: string | null = null;
    // multiple AIP outputs
    if (Array.isArray(t.AIP)) {
      for (const aip of t.AIP) {
        if (aip.address) {
          bapId = await getBAPIdByAddress(aip.address);
          if (bapId) break;
        }
      }
    }
    // single AIP output
    else if (t.AIP.address) {
      bapId = await getBAPIdByAddress(t.AIP.address);
    }

    if (bapId) {
      t.bapId = bapId;
    }
  }

  // save to db
  try {
    const collection = t.blk ? 'c' : 'u';
    const col = dbo.collection(collection);
    await col.insertOne(t);
    console.log(collection === 'u' ? chalk.magenta('unconfirmed') : '', chalk.green(t.tx.h));
  } catch (e) {
    console.log('not inserted', e);
    console.log(collection === 'u' ? chalk.magenta('unconfirmed') : '', chalk.green(t.tx.h));
  }
};

export const saveBobTx = async (tx: BobTx) => {
  // save AIP signers
  if (tx.AIP) {
    let bapId: string | null = null;
    // multiple AIP outputs
    for (const aip of tx.AIP) {
      if (aip.algorithm_signing_component) {
        bapId = await getBAPIdByAddress(aip.algorithm_signing_component);
        if (bapId) break;
      }
    }
  }
  return saveTx(tx);
};
