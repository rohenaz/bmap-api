import type { ChartConfiguration } from 'chart.js'
import QuickChart from 'quickchart-js'
const getGradientFillHelper = QuickChart.getGradientFillHelper

import { getDbo } from './db.js'
import { Timeframe } from './types.js'

export type TimeSeriesData = {
  _id: number // Block height
  count: number
}[]

export type ChartData = {
  config: ChartConfiguration;
  width: number;
  height: number;
}

export const defaultConfig: ChartConfiguration = {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      data: [],
      fill: true,
      borderColor: 'rgb(213, 99, 255, 0.5)',
      borderWidth: 3,
    }]
  },
  // For Chart.js v2 types:
  options: {
    legend: { display: false },
    scales: {
      xAxes: [{ display: false }],
      yAxes: [{ display: false }]
    }
  }
}

export const generateChart = (
  timeSeriesData: TimeSeriesData,
  globalChart: boolean
): { chart: QuickChart, chartData: ChartData } => {
  const width = 1280 / (globalChart ? 1 : 4);
  const height = 300 / (globalChart ? 1 : 4);

  let chartConfig: ChartConfiguration;

  if (!timeSeriesData || timeSeriesData.length === 0) {
    chartConfig = defaultConfig;
  } else {
    chartConfig = {
      type: 'line',
      data: {
        labels: timeSeriesData.map((d) => d._id),
        datasets: [
          {
            data: timeSeriesData.map((d) => d.count),
            fill: true,
            borderColor: 'rgb(213, 99, 255, 0.5)',
            borderWidth: 3,
            pointBackgroundColor: 'rgba(255, 99, 255, 0.5)',
            pointRadius: 3,
            lineTension: 0.4,
            backgroundColor: getGradientFillHelper('vertical', [
              'rgba(255, 99, 255, 1)',
              'rgba(255, 99, 255, 0)',
            ]),
          },
        ],
      },
      options: globalChart
        ? {
            legend: {
              display: false,
            },
            scales: {
              // Chart.js v2 style scales
              xAxes: [
                {
                  scaleLabel: {
                    display: true,
                    labelString: 'Block Height'
                  },
                  gridLines: {
                    color: '#111111',
                  },
                  ticks: {
                    fontColor: '#ffffff',
                  },
                }
              ],
              yAxes: [
                {
                  scaleLabel: {
                    display: true,
                    labelString: 'Count'
                  },
                  gridLines: {
                    color: '#111111',
                  },
                  ticks: {
                    fontColor: '#ffffff',
                  },
                }
              ],
            },
          }
        : {
            scales: {
              display: false,
              xAxes: [{ display: false }],
              yAxes: [{ display: false }],
            },
            legend: {
              display: false,
            },
          },
    }
  }

  const qc = new QuickChart();
  qc.setConfig(chartConfig);
  qc.setBackgroundColor('transparent');
  qc.setWidth(width);
  qc.setHeight(height);

  const chartData: ChartData = {
    config: chartConfig,
    width,
    height
  }

  return { chart: qc, chartData };
}

export const generateTotalsChart = async (
  collectionName: string,
  startBlock: number,
  endBlock: number,
  blockRange = 10
): Promise<{ chart: QuickChart, chartData: ChartData }> => {
  const timeSeriesData = await getTimeSeriesData(
    collectionName,
    startBlock,
    endBlock,
    blockRange
  );
  return generateChart(timeSeriesData, false);
}

export const generateCollectionChart = async (
  collectionName: string,
  startBlock: number,
  endBlock: number,
  range: number
): Promise<{ chart: QuickChart, chartData: ChartData }> => {
  const dbo = await getDbo();
  const allCollections = await dbo.listCollections().toArray();
  const allDataPromises = allCollections.map((c) =>
    getTimeSeriesData(c.name, startBlock, endBlock, range)
  );
  const allTimeSeriesData = await Promise.all(allDataPromises);

  const globalData: Record<number, number> = {};
  for (const collectionData of allTimeSeriesData) {
    for (const { _id, count } of collectionData) {
      globalData[_id] = (globalData[_id] || 0) + count;
    }
  }

  const aggregatedData = Object.keys(globalData).map((blockHeight) => ({
    _id: Number(blockHeight),
    count: globalData[blockHeight],
  }));

  return generateChart(aggregatedData, true);
}

export async function getTimeSeriesData(
  collectionName: string,
  startBlock: number,
  endBlock: number,
  blockRange = 10
): Promise<TimeSeriesData> {
  const dbo = await getDbo()

  try {
    const count = await dbo.collection(collectionName).countDocuments({
      'blk.i': { $gte: startBlock, $lte: endBlock }
    });

    if (count === 0) {
      return [];
    }

    const pipeline = [
      {
        $match: {
          'blk.i': {
            $gte: startBlock,
            $lte: endBlock,
          },
        },
      },
      {
        $project: {
          blockGroup: {
            $subtract: ['$blk.i', { $mod: ['$blk.i', blockRange] }],
          },
        },
      },
      {
        $group: {
          _id: '$blockGroup',
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
      { $limit: 1000 }
    ]

    const result = await dbo
      .collection(collectionName)
      .aggregate(pipeline, {
        allowDiskUse: true,
        maxTimeMS: 5000
      })
      .toArray();

    return result as TimeSeriesData;
  } catch (error) {
    console.error(`Error getting time series data for ${collectionName}:`, error);
    return [];
  }
}

const timeframeToBlocks = (period: string) => {
  switch (period) {
    case Timeframe.Day:
      return 144
    case Timeframe.Week:
      return 1008
    case Timeframe.Month:
      return 4320
    case Timeframe.Year:
      return 52560
    case Timeframe.All:
      return 0
    default:
      return 0
  }
}

export function getBlocksRange(
  currentBlockHeight: number,
  timeframe: string
): [number, number] {
  const blocks = timeframeToBlocks(timeframe)
  const startBlock = currentBlockHeight - blocks
  const endBlock = currentBlockHeight
  return [startBlock, endBlock]
}
