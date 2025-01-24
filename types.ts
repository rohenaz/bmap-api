import type { BmapTx } from 'bmapjs';
import type { BapIdentity } from './bap';

export interface TransformedTx extends BmapTx {
  tx: {
    h: string;
  };
  blk?: {
    i: number;
    t: number;
  };
  bapId?: BapIdentity;
  AIP?: {
    algorithm_signing_component?: string;
    address?: string;
  }[];
}

export enum Timeframe {
  Day = '24h',
  Week = 'week',
  Month = 'month',
  Year = 'year',
  All = 'all',
}
