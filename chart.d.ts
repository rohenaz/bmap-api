declare module 'quickchart-js' {
  class QuickChart {
    setConfig(config: any): void
    getUrl(): string
    setWidth(width: number): void
    setHeight(height: number): void
    setBackgroundColor(color: string): void
  }
  export = QuickChart
}
