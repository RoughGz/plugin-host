// Minimal plugin: a single plain plugin.js, no .sky zip, no plugin.json.
// The bridge loads it as-is and derives the addon name from the filename.
// Paste this file's raw URL (https://raw.githubusercontent.com/...) into the
// dashboard to get its /plugin/<b64url>/manifest.json addon URL.
globalThis.getHome = (cb) => {
  cb({
    success: true,
    data: {
      Hello: [
        new MultimediaItem({
          title: "Hello World",
          url: "https://example.com/movie",
          type: "movie",
        }),
      ],
    },
  });
};
