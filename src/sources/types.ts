export interface SourceAdapter {
  key: string;
  start: () => Promise<void>;
}
