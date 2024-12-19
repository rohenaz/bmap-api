import type { B, BmapTx } from 'bmapjs';

interface AIPWithAlgorithmSigningComponent {
  algorithm_signing_component?: string;
  address?: string;
}

interface BWithData {
  Data?: {
    utf8?: string;
  };
  content?: string;
}

export const normalize = (tx: BmapTx): BmapTx => {
  if (tx.AIP) {
    const aip = tx.AIP.map((a: AIPWithAlgorithmSigningComponent) => {
      if (!a.address && a.algorithm_signing_component) {
        a.address = a.algorithm_signing_component;
      }
      return a;
    });
    tx.AIP = aip;
  }

  if (tx.B) {
    for (let i = 0; i < tx.B?.length; i++) {
      const b = tx.B[i] as BWithData;
      if (!b.content && b.Data?.utf8) {
        b.content = b.Data.utf8;
      }
      tx.B[i] = b as B;
    }
  }

  return tx;
};
