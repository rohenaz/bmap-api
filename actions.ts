import type { BmapTx } from 'bmapjs';
import chalk from 'chalk';
import { getBAPIdByAddress } from './bap';
import type { BapIdentity } from './bap';
import { normalize } from './bmap';
import { getDbo } from './db';
import type { BobTx, TransformedTx } from './types';

export const saveTx = async (tx: BmapTx) => {
  const dbo = await getDbo();
  try {
    const t = tx as TransformedTx;

    // Get BAP ID if available
    let bapId: BapIdentity | undefined;

    if (t.AIP && Array.isArray(t.AIP) && t.AIP.length > 0) {
      const aip = t.AIP[0];
      if (aip.algorithm_signing_component) {
        bapId = await getBAPIdByAddress(aip.algorithm_signing_component);
      } else if (aip.address) {
        bapId = await getBAPIdByAddress(aip.address);
      }
    }

    if (bapId) {
      t.bapId = bapId;
    }

    // Save to the appropriate collection based on confirmation status
    const collectionName = t.blk ? 'c' : 'u';
    const collection = dbo.collection(collectionName);

    await collection.updateOne({ 'tx.h': t.tx.h }, { $set: normalize(t) }, { upsert: true });

    console.log(collectionName === 'u' ? chalk.magenta('unconfirmed') : '', chalk.green(t.tx.h));
  } catch (err) {
    console.error('Error saving tx:', err);
  }
};

export const saveBobTx = async (tx: BobTx) => {
  // save AIP signers
  if (tx.AIP) {
    let bapId: BapIdentity | undefined;
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
