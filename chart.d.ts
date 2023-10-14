declare module 'quickchart-js' {
  class QuickChart {
    setConfig(config: any): void
    getUrl(): string
    setWidth(width: number): QuickChart
    setHeight(height: number): QuickChart
    setBackgroundColor(color: string): QuickChart
  }
  export = QuickChart
}
