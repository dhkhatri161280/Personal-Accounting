// Ambient declaration so tsc can resolve the cloudflare:workers module.
// At runtime this is provided by the Cloudflare Workers runtime.
// Code that needs specific binding types should cast: env as unknown as AppBindings
declare module "cloudflare:workers" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: any;
  export { env };
}
