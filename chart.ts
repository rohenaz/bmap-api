import { ChartConfiguration } from 'chart.js'
import QuickChart from 'quickchart-js'
import { getDbo } from './db.js'

type TimeSeriesData = {
  _id: number // Block height
  count: number
}[]

// Interpolate between two values
function lerp(a: number, b: number, t: number): number {
  return (1 - t) * a + t * b
}

// Generate gradient colors between startColor and endColor over 'steps' steps
function generateGradientColors(
  startColor: string,
  endColor: string,
  steps: number
): string[] {
  const start = startColor.match(/\d+/g)!.map(Number)
  const end = endColor.match(/\d+/g)!.map(Number)
  const gradientColors: string[] = []

  for (let step = 0; step < steps; step++) {
    const t = step / (steps - 1)
    const r = Math.round(lerp(start[0], end[0], t))
    const g = Math.round(lerp(start[1], end[1], t))
    const b = Math.round(lerp(start[2], end[2], t))
    const a = lerp(start[3] / 255, end[3] / 255, t).toFixed(2)
    gradientColors.push(`rgba(${r}, ${g}, ${b}, ${a})`)
  }

  return gradientColors
}

const generateChart = (
  timeSeriesData: TimeSeriesData,
  globalChart: boolean
): QuickChart => {
  const timeSeriesLength = timeSeriesData.length

  const gradientColors = generateGradientColors(
    'rgba(26, 13, 171, 0.5)',
    'rgba(0, 204, 255, 0.5)',
    timeSeriesLength
  )

  console.log({ gradientColors })
  const chartConfig = {
    type: 'line',

    data: {
      labels: timeSeriesData.map((d) => d._id),
      datasets: [
        {
          data: timeSeriesData.map((d) => d.count),
          backgroundColor: gradientColors, // '#498fff',
          fill: true,
          borderColor: 'rgb(213, 99, 255, 0.9)',
          borderWidth: 3,
          pointBackgroundColor: 'rgba(255, 99, 132, 0.8)',
          pointRadius: 5,
          lineTension: 0.2,
        },
      ],
    },
  } as ChartConfiguration

  if (globalChart) {
    chartConfig.options = {
      legend: {
        display: false,
      },
      scales: {
        x: {
          title: {
            display: true,
            text: 'Block Height',
            color: '#333333',
          },
          grid: {
            color: '#111111',
          },
          ticks: {
            color: '#ffffff', // Ticks text color
          },
        },
        y: {
          title: {
            display: true,
            text: 'Count',
            color: '#333333',
          },
          grid: {
            color: '#111111',
          },
          ticks: {
            color: '#ffffff', // Ticks text color
          },
        },
      },
    } as ChartConfiguration['options']
  } else {
    chartConfig.options = {
      scales: {
        display: false,
        scaleLabel: {
          display: false,
        },
        xAxes: [
          {
            display: false,
          },
        ],
        yAxes: [
          {
            display: false,
          },
        ],
        x: {
          display: false,
        },
        y: {
          display: false,
        },
      },
      legend: {
        display: false,
      },
    } as ChartConfiguration['options']
  }
  const qc = new QuickChart()
  qc.setConfig(chartConfig)
  qc.setWidth(1280).setHeight(300)

  return qc
}

const generateTotalsChart = async (
  collectionName: string,
  startBlock: number,
  endBlock: number,
  blockRange: number = 10 // Default grouping range of 10 blocks
) => {
  // Generate a chart for the specific collection based on timePeriod
  // Fetch time series data for this block range
  const timeSeriesData = await getTimeSeriesData(
    collectionName,
    startBlock,
    endBlock,
    blockRange
  )

  return generateChart(timeSeriesData, false) // Replace with your chart generation function
}

const generateCollectionChart = async (
  collectionName: string,
  startBlock: number,
  endBlock: number,
  range: number
) => {
  const dbo = await getDbo()
  const allCollections = await dbo.listCollections().toArray()
  const allDataPromises = allCollections.map((c) =>
    getTimeSeriesData(c.name, startBlock, endBlock, range)
  )
  const allTimeSeriesData = await Promise.all(allDataPromises)

  // Sum up counts for each block height across all collections
  const globalData: Record<number, number> = {}
  allTimeSeriesData.forEach((collectionData) => {
    collectionData.forEach(({ _id, count }) => {
      globalData[_id] = (globalData[_id] || 0) + count
    })
  })

  const aggregatedData = Object.keys(globalData).map((blockHeight) => ({
    _id: Number(blockHeight),
    count: globalData[blockHeight],
  }))

  return generateChart(aggregatedData, true)
}

async function getTimeSeriesData(
  collectionName: string,
  startBlock: number,
  endBlock: number,
  blockRange: number = 10 // Default grouping range of 10 blocks
): Promise<any> {
  const dbo = await getDbo()
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
        // Calculate the block group identifier
        blockGroup: {
          $subtract: ['$blk.i', { $mod: ['$blk.i', blockRange] }],
        },
      },
    },
    {
      $group: {
        _id: '$blockGroup', // Group by block group identifier
        count: { $sum: 1 },
      },
    },
    {
      $sort: { _id: 1 },
    },
  ]
  return dbo.collection(collectionName).aggregate(pipeline).toArray()
}

export {
  generateChart,
  generateCollectionChart,
  generateTotalsChart,
  getTimeSeriesData,
}
