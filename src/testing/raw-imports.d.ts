// Vite（Vitest）の `?raw` インポート。記録した実応答をそのまま文字列で読む。
declare module "*?raw" {
  const content: string;
  export default content;
}
