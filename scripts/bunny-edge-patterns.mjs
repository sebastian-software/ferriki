// Bunny uses Lua patterns, not regular expressions. Expand exact lengths;
// Lua supports neither alternation nor {n} repeat counts.
const origin = "pattern:^https?://[^/]+/";
const id = "[a-z0-9%-]+/";
const short = "[a-zA-Z0-9]".repeat(8);
const storage = [`${origin}${id}${short}$`, `${origin}themes/${id}${short}$`];
console.log(
  JSON.stringify(
    {
      allowedAssetPaths: storage,
      successfulResponseCacheControl: "public, max-age=31536000, immutable",
    },
    null,
    2,
  ),
);
