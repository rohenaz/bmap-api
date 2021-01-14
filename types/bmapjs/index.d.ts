// Type definitions for bmapjs 0.3.0
// Project: https://github.com/rohenaz/bmapjs
// Definitions by: Luke Rohenaz <https://github.com/rohenaz>

declare module 'bmapjs' {
  export type MAP = {
    app: string
    url?: string
    context: string
    subcontext?: string
    type: string
    tx?: string
    videoID?: string
    provider?: string
    tags?: string[]
    start?: string
    duration?: string
    [prop: string]: string | string[]
  }

  export type SigProto = [
    { s: string },
    { h: string },
    { h: string },
    { h: string },
    { s: string }
  ]

  export type BmapTx = {
    timestamp: number
    tx: {
      h: string
    }
    B: {
      content: string
    }
    MAP: MAP | MAP[]
    blk?: {
      t: number
      i: number
    }
    out: [
      {
        e: {
          a: string
          v: number
        }
      }
    ]
    _id: string
    '15igChEkUWgx4dsEcSuPitcLNZmNDfUvgA': SigProto | any
  }
  class BMAP {
    transformTx(tx: Object): Promise<BmapTx>
  }

  export namespace bmap {
    function TransformTx(tx: Object): Promise<BmapTx>
  }

  export default BMAP
}
