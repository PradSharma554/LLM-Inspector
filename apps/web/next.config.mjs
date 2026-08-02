/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@llm-inspector/protocol"],
  experimental: {
    // Next 16 cannot drive TypeScript 7's compiler API directly; this makes it
    // shell out to the `tsc` CLI instead. The workspace is on TS 7 for the
    // backend packages, so downgrading just for the web app would be worse.
    useTypeScriptCli: true,
  },
};
