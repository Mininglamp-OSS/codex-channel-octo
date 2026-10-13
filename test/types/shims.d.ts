// Minimal typing for the js-yaml devDependency (no bundled .d.ts).
declare module 'js-yaml' {
  const yaml: { load(text: string): unknown; dump(value: unknown): string };
  export default yaml;
}
