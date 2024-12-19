declare module 'quickchart-js' {
  class QuickChart {
    setConfig(config: Record<string, unknown>): void;
    getUrl(): string;
    setWidth(width: number): QuickChart;
    setHeight(height: number): QuickChart;
    setBackgroundColor(color: string): QuickChart;
  }
  export = QuickChart;
}
