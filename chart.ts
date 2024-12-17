import type { ChartConfiguration } from 'chart.js'
import { Chart, registerables } from 'chart.js'
import { createCanvas } from '@napi-rs/canvas'
import type { SKRSContext2D } from '@napi-rs/canvas'

import { getDbo } from './db.js'
import { Timeframe } from './types.js'

// Register Chart.js components
Chart.register(...registerables)

// Create a compatibility layer for the canvas context
const createCompatibleContext = (ctx: SKRSContext2D) => {
  return new Proxy(ctx, {
    get: (target, prop) => {
      if (prop === 'drawFocusIfNeeded') {
        return () => {}; // Noop implementation
      }
      return target[prop as keyof SKRSContext2D];
    },
  }) as unknown as CanvasRenderingContext2D;
}

export type TimeSeriesData = {
  _id: number // Block height
  count: number
}[]

export type ChartData = {
  config: ChartConfiguration;
  width: number;
  height: number;
}

const generateChart = (
  timeSeriesData: TimeSeriesData,
  globalChart: boolean
): { chartBuffer: Buffer; chartConfig: ChartConfiguration } => {
  console.log('Generating chart with data:', { timeSeriesData, globalChart });
  
  const dpi = 2
  const width = 1280 / (globalChart ? 1 : 4)
  const height = 300 / (globalChart ? 1 : 4)

  const labels = timeSeriesData.map((d) => d._id)
  const dataValues = timeSeriesData.map((d) => d.count)
  console.log('Chart data points:', { labels, dataValues });

  const minBlock = Math.min(...labels)
  const maxBlock = Math.max(...labels)

  const chartConfig: ChartConfiguration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Count',
          data: dataValues,
          fill: true,
          borderColor: 'rgba(213, 99, 255, 0.5)',
          borderWidth: 3,
          pointBackgroundColor: 'rgba(255, 99, 255, 0.5)',
          pointRadius: 3,
          tension: 0.4,
          backgroundColor: 'rgba(255, 99, 255, 0.5)'
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: dpi,
      plugins: {
        legend: {
          display: false,
        },
      },
      scales: globalChart
        ? {
            x: {
              type: 'linear',
              min: minBlock,
              max: maxBlock,
              title: { display: true, text: 'Block Height', color: '#fff' },
              grid: { color: '#333' },
              ticks: { 
                color: '#fff',
                callback: (value) => value.toString(),
                maxTicksLimit: 10,
                autoSkip: true
              },
            },
            y: {
              type: 'linear',
              title: { display: true, text: 'Count', color: '#fff' },
              grid: { color: '#333' },
              ticks: { 
                color: '#fff',
                callback: (value) => value.toString()
              },
            },
          }
        : {
            x: { 
              type: 'linear',
              min: minBlock,
              max: maxBlock,
              display: true,
              ticks: {
                display: false
              },
              grid: {
                display: false
              }
            },
            y: { 
              type: 'linear',
              display: true,
              ticks: {
                display: false
              },
              grid: {
                display: false
              }
            },
          },
    },
  }
  console.log('Chart config:', JSON.stringify(chartConfig, null, 2));

  // Create canvas and render chart
  const canvas = createCanvas(width * dpi, height * dpi)
  const ctx = canvas.getContext('2d')
  
  // Scale context for high DPI
  ctx.scale(dpi, dpi)
  
  // Set background color
  ctx.fillStyle = 'transparent'
  ctx.fillRect(0, 0, width, height)
  
  // Create chart with compatible context
  const compatibleCtx = createCompatibleContext(ctx)
  new Chart(compatibleCtx, chartConfig)
  
  // Get buffer
  const chartBuffer = canvas.toBuffer('image/png')
  
  return { chartBuffer, chartConfig }
}

export type ChartResult = {
  chartBuffer: Buffer;
  chartData: ChartData;
}

const generateTotalsChart = async (
  collectionName: string,
  startBlock: number,
  endBlock: number,
  blockRange = 10
): Promise<ChartResult> => {
  console.log('Generating totals chart:', { collectionName, startBlock, endBlock, blockRange });
  
  const timeSeriesData = await getTimeSeriesData(
    collectionName,
    startBlock,
    endBlock,
    blockRange
  )
  console.log('Time series data:', timeSeriesData);
  
  const { chartBuffer, chartConfig } = generateChart(timeSeriesData, false)
  const chartData = {
    config: chartConfig,
    width: 1280 / 4,
    height: 300 / 4
  };
  console.log('Generated chart data:', chartData);
  
  return { chartBuffer, chartData }
}

const generateCollectionChart = async (
  collectionName: string | undefined,
  startBlock: number,
  endBlock: number,
  range: number
): Promise<ChartResult> => {
  console.log('Generating collection chart:', { collectionName, startBlock, endBlock, range });
  
  const dbo = await getDbo()
  const allCollections = await dbo.listCollections().toArray()
  const allDataPromises = allCollections.map((c) =>
    getTimeSeriesData(c.name, startBlock, endBlock, range)
  )
  const allTimeSeriesData = await Promise.all(allDataPromises)
  console.log('All time series data:', allTimeSeriesData);

  const globalData: Record<number, number> = {}
  for (const collectionData of allTimeSeriesData) {
    for (const { _id, count } of collectionData) {
      globalData[_id] = (globalData[_id] || 0) + count
    }
  }

  const aggregatedData = Object.keys(globalData).map((blockHeight) => ({
    _id: Number(blockHeight),
    count: globalData[blockHeight],
  }))
  console.log('Aggregated data:', aggregatedData);

  const { chartBuffer, chartConfig } = generateChart(aggregatedData, true)
  const chartData = {
    config: chartConfig,
    width: 1280,
    height: 300
  };
  console.log('Final chart data:', JSON.stringify(chartData, null, 2));
  
  return { chartBuffer, chartData }
}

async function getTimeSeriesData(
  collectionName: string,
  startBlock: number,
  endBlock: number,
  blockRange = 10
): Promise<TimeSeriesData> {
  const dbo = await getDbo()
  
  try {
    // First check if collection exists and has any documents
    const count = await dbo.collection(collectionName).countDocuments({
      'blk.i': { $gte: startBlock, $lte: endBlock }
    });

    if (count === 0) {
      console.log(`No data found for ${collectionName} between blocks ${startBlock}-${endBlock}`);
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
    ]

    const result = await dbo.collection(collectionName).aggregate(pipeline).toArray()
    console.log(`Found ${result.length} data points for ${collectionName}`);
    return result as TimeSeriesData;
  } catch (error) {
    console.error(`Error getting time series data for ${collectionName}:`, error);
    return [];
  }
}

function timeframeToBlocks(period: string) {
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

function getBlocksRange(
  currentBlockHeight: number,
  timeframe: string
): [number, number] {
  const blocks = timeframeToBlocks(timeframe)
  const startBlock = currentBlockHeight - blocks
  const endBlock = currentBlockHeight
  return [startBlock, endBlock]
}

export {
  generateChart,
  generateCollectionChart,
  generateTotalsChart,
  getBlocksRange,
  getTimeSeriesData,
}
