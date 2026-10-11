/**
 * Infrastructure domains: cloud APIs, CDNs, load balancers and DNS. Their hostnames are
 * endpoints apps and pages talk to, not sites anyone browses, so Jev can only guess from a
 * machine-generated name (e.g. go-updater-1830831421.us-west-2.elb.amazonaws.com). Many sit
 * on the Public Suffix List, which would otherwise make every hostname a separate paid
 * classification. Lookups under these domains skip Jev and are allowed; user lists and the
 * ad/adult filters still apply first.
 *
 * Keep this to pure infrastructure. Hosts that serve user-made websites (github.io,
 * blogspot.com, vercel.app, azurewebsites.net, …) are deliberately not listed.
 */
export const INFRA_DOMAINS: readonly string[] = [
  // Amazon Web Services
  "amazonaws.com",
  "cloudfront.net",
  "awsglobalaccelerator.com",
  // Microsoft Azure / Microsoft CDN
  "cloudapp.azure.com",
  "cloudapp.net",
  "azureedge.net",
  "azurefd.net",
  "trafficmanager.net",
  "windows.net",
  "msedge.net",
  // Google
  "googleapis.com",
  "1e100.net",
  "gvt1.com",
  "gvt2.com",
  // Akamai
  "akamai.net",
  "akamaiedge.net",
  "akamaihd.net",
  "akamaized.net",
  "akadns.net",
  "akamaitechnologies.com",
  "edgekey.net",
  "edgesuite.net",
  // Other CDNs
  "fastly.net",
  "fastlylb.net",
  "cdn.cloudflare.net",
  "edgecastcdn.net",
  "llnwd.net",
  // Apple
  "apple-dns.net",
  "aaplimg.com",
  "apple-cloudkit.com",
  "icloud-content.com",
  "cdn-apple.com",
  // DNS
  "root-servers.net",
];
