import { BmapTx } from 'bmapjs/types/common'
import { AIP } from 'bmapjs/types/protocols/aip'
import { B } from 'bmapjs/types/protocols/b'

export const normalize = (tx: BmapTx) => {
  // The go implementation has some weird data structures we want to match the js version
  if (tx.AIP) {
    // multiple AIP outputs

    for (let i = 0; i < tx.AIP.length; i++) {
      let a = tx.AIP[i] as any

      if (!a.address) {
        a.address = a.algorithm_signing_component
      }
      tx.AIP[i] = a as AIP
    }

    for (let i = 0; i < tx.B.length; i++) {
      let b = tx.B[i] as any
      if (!b.content) {
        b.content = b.Data?.utf8
      }
      tx.B[i] = b as B
    }
  }
  return tx
}
