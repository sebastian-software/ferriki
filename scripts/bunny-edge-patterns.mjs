// Bunny uses Lua patterns, not regular expressions. Expand exact lengths;
// Lua supports neither alternation nor {n} repeat counts.
const origin = "pattern:^https?://[^/]+/";
const id = "[a-z0-9%-]+/";
const short = "[a-zA-Z0-9]".repeat(8);
const full = "%x".repeat(64);
const storage = [
  `${origin}${id}${short}$`,
  `${origin}themes/${id}${short}$`,
  `${origin}${id}${full}$`,
  `${origin}themes/${id}${full}$`,
];
console.log(
  JSON.stringify(
    {
      storageOriginMatchAny: storage,
      allowedAssetPaths: [`${origin}[^/?]+/assets/shiki/[^?]+.*$`, ...storage],
      successfulResponseCacheControl: "public, max-age=31536000, immutable",
    },
    null,
    2,
  ),
);
