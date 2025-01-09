import type { Transaction } from '@gorillapool/js-junglebus';
import bmapjs from 'bmapjs';
import { parse } from 'bpu-ts';
import { saveTx } from './actions.js';

const { allProtocols, TransformTx } = bmapjs;

export const processTransaction = async (data: Partial<Transaction>) => {
  try {
    console.log('Starting transaction processing...');
    console.log('Raw transaction:', data.transaction);

    if (!data.transaction) {
      console.error('No transaction data provided');
      return null;
    }

    console.log('Parsing transaction with bpu-ts...');
    const bob = await parse({
      tx: { r: data.transaction },
      split: [{ token: { op: 106 }, include: 'l' }, { token: { s: '|' } }],
    });

    if (!bob) {
      console.error('Failed to parse transaction with bpu-ts');
      return null;
    }

    console.log('Parsed BOB:', JSON.stringify(bob, null, 2));

    console.log('Transforming transaction with bmapjs...');
    const tx = await TransformTx(
      bob,
      allProtocols.map((p) => p.name)
    );

    if (!tx) {
      console.error('Failed to transform transaction with bmapjs');
      return null;
    }

    console.log('Transformed transaction:', JSON.stringify(tx, null, 2));

    console.log('Saving transaction...');
    await saveTx(tx);

    console.log('Transaction processing completed successfully');
    return tx;
  } catch (error) {
    console.error('Error in processTransaction:', error);
    throw error;
  }
};
