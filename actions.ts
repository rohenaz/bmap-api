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
    console.log('Starting saveTx for transaction:', tx.tx?.h);
    const t = tx as TransformedTx;

    // Get BAP ID if available
    let bapId: BapIdentity | undefined;
    console.log('Checking for AIP data...');

    if (t.AIP && Array.isArray(t.AIP) && t.AIP.length > 0) {
      const aip = t.AIP[0];
      console.log('Found AIP data:', aip);
      if (aip.algorithm_signing_component) {
        console.log(
          'Getting BAP ID for algorithm_signing_component:',
          aip.algorithm_signing_component
        );
        bapId = await getBAPIdByAddress(aip.algorithm_signing_component);
      } else if (aip.address) {
        console.log('Getting BAP ID for address:', aip.address);
        bapId = await getBAPIdByAddress(aip.address);
      }
    }

    if (bapId) {
      console.log('Found BAP ID:', bapId.idKey);
      t.bapId = bapId;
    }

    // Save to the appropriate collection based on confirmation status
    const collectionName = t.blk ? 'c' : 'u';
    const collection = dbo.collection(collectionName);
    console.log('Saving to collection:', collectionName);

    const normalizedTx = normalize(t);
    console.log('Normalized transaction:', JSON.stringify(normalizedTx, null, 2));

    await collection.updateOne({ 'tx.h': t.tx.h }, { $set: normalizedTx }, { upsert: true });

    console.log(collectionName === 'u' ? chalk.magenta('unconfirmed') : '', chalk.green(t.tx.h));
    return normalizedTx;
  } catch (err) {
    console.error('Error saving tx:', err);
    throw err;
  }
};

export const saveBobTx = async (tx: BobTx) => {
  // save AIP signers
  if (tx.AIP) {
    let bapId: BapIdentity | undefined;
    // multiple AIP outputs
    for (const aip of tx.AIP) {
      console.log({ aip });
      if (aip.address || aip.signing_address) {
        bapId = await getBAPIdByAddress(aip.address || aip.signing_address);
        if (bapId) break;
      }
    }
  }
  return saveTx(tx);
};
