import type { B, BmapTx } from 'bmapjs';
import type { AIP } from 'bmapjs';

interface AIPWithAlgorithmSigningComponent extends AIP {
  algorithm_signing_component?: string;
}

interface BWithData extends B {
  Data?: {
    utf8?: string;
  };
}

export const normalize = (tx: BmapTx): BmapTx => {
  // The go implementation has some weird data structures we want to match the js version
  if (tx.AIP) {
    // multiple AIP outputs
    for (let i = 0; i < tx.AIP?.length; i++) {
      const a = tx.AIP[i] as AIPWithAlgorithmSigningComponent;

      if (!a.address) {
        a.address = a.algorithm_signing_component;
        a.algorithm_signing_component = undefined;
      }
      tx.AIP[i] = a as AIP;
    }

    for (let i = 0; i < tx.B?.length; i++) {
      const b = tx.B[i] as BWithData;
      if (!b.content) {
        b.content = b.Data?.utf8;
        // TODO: delete the Data field
      }
      tx.B[i] = b as B;
    }
  }
  return tx;
};
